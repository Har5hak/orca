import { createHash } from 'node:crypto'
import type { CodexLabTrustedFileObservation } from './codex-lab-command-confinement-live-contract'
import type { CodexLabProbeIdentityCandidate } from './codex-lab-command-confinement-contract'

export const CODEX_LAB_LIVE_PROBE_EXECUTABLE = '/usr/bin/ruby' as const

// The probe is literal Ruby passed to the host's canonical system runtime. Dynamic
// values remain argv entries, never source, and the host re-attests the runtime
// immediately before spawning the exact sealed Codex sandbox ProcessSpec.
export const CODEX_LAB_LIVE_PROBE_SOURCE = String.raw`require 'digest'
require 'json'
require 'socket'

REQUIRED = %w[
  schema-version run-nonce probe-path worktree-identity worktree-path
  worktree-read-target worktree-read-sha256 worktree-write-target write-payload
  dispatch-root config-path config-sha256 codex-home codex-home-write-target
  fake-home fake-home-write-target private-tmp-write-target
  outside-root-write-target tcp-connect-host tcp-connect-port
  tcp-connect-challenge tcp-bind-host tcp-bind-port unix-connect-path
  unix-connect-challenge unix-connect-denied-path unix-connect-denied-challenge
  unix-bind-path
].freeze

def fail_probe(message)
  raise RuntimeError, message
end

def parse_args
  fail_probe('probe arguments must be key/value pairs') unless ARGV.length.even?
  values = {}
  ARGV.each_slice(2) do |key_arg, value|
    fail_probe('probe argument key is invalid') unless key_arg.start_with?('--')
    key = key_arg.delete_prefix('--')
    fail_probe('probe argument is unknown') unless REQUIRED.include?(key) && !values.key?(key)
    values[key] = value
  end
  fail_probe('probe argument set is not exact') unless values.keys.sort == REQUIRED.sort
  values.each_value { |value| fail_probe('probe argument is empty') if value.empty? }
  values
end

def sha(value)
  Digest::SHA256.hexdigest(value)
end

def identity(stat)
  fail_probe('path has no stable inode') if stat.ino.zero?
  { 'device' => stat.dev.to_s, 'inode' => stat.ino.to_s }
end

def same_identity?(left, right)
  left['device'] == right['device'] && left['inode'] == right['inode']
end

def inspect_file(target)
  named_before = File.lstat(target)
  fail_probe('expected regular file') unless named_before.file? && !named_before.symlink?
  fail_probe('file path is not canonical') unless File.realpath(target) == target
  descriptor = File.open(target, File::RDONLY | File::NOFOLLOW)
  begin
    before = descriptor.stat
    contents = descriptor.read
    after = descriptor.stat
    named_after = File.lstat(target)
    expected = identity(named_before)
    [before, after, named_after].each do |observed|
      fail_probe('file identity changed during read') unless
        observed.file? && same_identity?(identity(observed), expected)
    end
    changed = before.size != after.size ||
      before.mtime != after.mtime || before.mtime.nsec != after.mtime.nsec ||
      before.ctime != after.ctime || before.ctime.nsec != after.ctime.nsec
    fail_probe('file contents changed during read') if changed
    { 'identity' => expected, 'sha256' => sha(contents) }
  ensure
    descriptor.close
  end
end

def directory_identity(target)
  observed = File.lstat(target)
  fail_probe('expected canonical directory') unless
    observed.directory? && !observed.symlink? && File.realpath(target) == target
  identity(observed)
end

def require_denied_write(target, payload)
  descriptor = nil
  begin
    descriptor = File.open(
      target,
      File::WRONLY | File::CREAT | File::EXCL | File::NOFOLLOW,
      0o600
    )
    descriptor.write(payload)
  rescue Errno::EPERM
    fail_probe('denied write left a target behind') if File.exist?(target)
    return
  ensure
    descriptor&.close
  end
  File.unlink(target) if File.exist?(target)
  fail_probe("forbidden write unexpectedly succeeded: #{target}")
end

def require_denied_tcp_connect(host, port)
  socket = nil
  begin
    socket = TCPSocket.new(host, port)
  rescue Errno::EPERM
    return
  ensure
    socket&.close
  end
  fail_probe('TCP connect unexpectedly succeeded')
rescue SystemCallError => error
  fail_probe("TCP connect denial returned #{error.class}")
end

def require_denied_tcp_bind(host, port)
  server = nil
  begin
    server = TCPServer.new(host, port)
  rescue Errno::EPERM
    return
  ensure
    server&.close
  end
  fail_probe('TCP bind unexpectedly succeeded')
rescue SystemCallError => error
  fail_probe("TCP bind denial returned #{error.class}")
end

def exchange_unix_challenge(path, challenge)
  socket = UNIXSocket.new(path)
  begin
    socket.write(challenge)
    socket.close_write
    fail_probe('Unix challenge response mismatched') unless socket.read == challenge
  ensure
    socket.close
  end
end

def require_denied_unix_connect(path)
  socket = nil
  begin
    socket = UNIXSocket.new(path)
  rescue Errno::EPERM
    return
  ensure
    socket&.close
  end
  fail_probe('alternate Unix connect unexpectedly succeeded')
rescue SystemCallError => error
  fail_probe("alternate Unix connect denial returned #{error.class}")
end

def require_denied_unix_bind(path)
  server = nil
  begin
    server = UNIXServer.new(path)
  rescue Errno::EPERM
    return
  ensure
    server&.close
  end
  File.unlink(path) if File.exist?(path)
  fail_probe('Unix bind unexpectedly succeeded')
rescue SystemCallError => error
  fail_probe("Unix bind denial returned #{error.class}")
end

def denied_write(root, target)
  {
    'root' => root,
    'target' => target,
    'syscall' => 'open(O_CREAT|O_EXCL|O_WRONLY)',
    'result' => 'denied-by-sandbox',
    'errno' => 'EPERM'
  }
end

begin
  values = parse_args
  fail_probe('unsupported probe schema') unless values['schema-version'] == '1'
  probe = inspect_file(values['probe-path'])
  config = inspect_file(values['config-path'])
  fail_probe('config digest mismatched') unless config['sha256'] == values['config-sha256']
  readable = inspect_file(values['worktree-read-target'])
  fail_probe('worktree read digest mismatched') unless
    readable['sha256'] == values['worktree-read-sha256']

  [
    values['worktree-write-target'],
    values['codex-home-write-target'],
    values['fake-home-write-target'],
    values['private-tmp-write-target'],
    values['outside-root-write-target']
  ].each { |target| require_denied_write(target, values['write-payload']) }

  tcp_port = Integer(values['tcp-connect-port'], 10)
  fail_probe('TCP port is invalid') unless tcp_port.between?(1, 65_535)
  require_denied_tcp_connect(values['tcp-connect-host'], tcp_port)
  require_denied_tcp_bind(values['tcp-bind-host'], Integer(values['tcp-bind-port'], 10))
  exchange_unix_challenge(values['unix-connect-path'], values['unix-connect-challenge'])
  require_denied_unix_connect(values['unix-connect-denied-path'])
  require_denied_unix_bind(values['unix-bind-path'])

  report = {
    'schemaVersion' => 1,
    'probe' => {
      'path' => values['probe-path'],
      'sha256' => probe['sha256'],
      'device' => probe['identity']['device'],
      'inode' => probe['identity']['inode'],
      'identityTrust' => 'candidate-only'
    },
    'layout' => {
      'dispatchId' => File.basename(values['dispatch-root']),
      'dispatchRoot' => values['dispatch-root'],
      'dispatchRootIdentity' => directory_identity(values['dispatch-root']),
      'codexHomeIdentity' => directory_identity(values['codex-home']),
      'fakeHomeIdentity' => directory_identity(values['fake-home']),
      'configIdentity' => config['identity'],
      'configSha256' => values['config-sha256']
    },
    'worktree' => {
      'identity' => values['worktree-identity'],
      'path' => values['worktree-path'],
      'read' => {
        'target' => values['worktree-read-target'],
        'sha256' => values['worktree-read-sha256'],
        'syscall' => 'open(O_RDONLY)',
        'result' => 'succeeded'
      },
      'write' => denied_write(values['worktree-path'], values['worktree-write-target'])
    },
    'writes' => {
      'codexHome' => denied_write(values['codex-home'], values['codex-home-write-target']),
      'fakeHome' => denied_write(values['fake-home'], values['fake-home-write-target']),
      'privateTmp' => denied_write('/private/tmp', values['private-tmp-write-target']),
      'outsideRoot' => denied_write(
        File.dirname(values['outside-root-write-target']),
        values['outside-root-write-target']
      )
    },
    'network' => {
      'tcpConnect' => {
        'host' => '127.0.0.1',
        'port' => tcp_port,
        'challengeSha256' => sha(values['tcp-connect-challenge']),
        'syscall' => 'connect(AF_INET,SOCK_STREAM)',
        'result' => 'denied-by-sandbox',
        'errno' => 'EPERM'
      },
      'tcpBind' => {
        'host' => '127.0.0.1',
        'port' => 0,
        'syscall' => 'bind(AF_INET,SOCK_STREAM)',
        'result' => 'denied-by-sandbox',
        'errno' => 'EPERM'
      },
      'unixConnect' => {
        'path' => values['unix-connect-path'],
        'challengeSha256' => sha(values['unix-connect-challenge']),
        'syscall' => 'connect(AF_UNIX,SOCK_STREAM)',
        'result' => 'succeeded'
      },
      'unixConnectDenied' => {
        'path' => values['unix-connect-denied-path'],
        'challengeSha256' => sha(values['unix-connect-denied-challenge']),
        'syscall' => 'connect(AF_UNIX,SOCK_STREAM)',
        'result' => 'denied-by-sandbox',
        'errno' => 'EPERM'
      },
      'unixBind' => {
        'path' => values['unix-bind-path'],
        'syscall' => 'bind(AF_UNIX,SOCK_STREAM)',
        'result' => 'denied-by-sandbox',
        'errno' => 'EPERM'
      }
    }
  }
  STDOUT.write(JSON.generate(report) + "\n")
  STDOUT.flush
  loop { sleep 60 }
rescue StandardError => error
  STDERR.write("confinement probe failed: #{error.message}\n")
  exit 1
end
`

export const CODEX_LAB_LIVE_PROBE_SOURCE_SHA256 = createHash('sha256')
  .update(CODEX_LAB_LIVE_PROBE_SOURCE)
  .digest('hex')

export function buildCodexLabLiveProbeCandidate(
  observed: CodexLabTrustedFileObservation
): CodexLabProbeIdentityCandidate {
  if (
    observed.path !== CODEX_LAB_LIVE_PROBE_EXECUTABLE ||
    observed.observedRealPath !== CODEX_LAB_LIVE_PROBE_EXECUTABLE ||
    !observed.executable
  ) {
    throw new Error('trusted confinement probe executable is not the canonical system Ruby')
  }
  return Object.freeze({
    path: observed.path,
    argvPrefix: Object.freeze(['--disable-gems', '-e', CODEX_LAB_LIVE_PROBE_SOURCE, '--']),
    observedRealPath: observed.observedRealPath,
    kind: 'regular-file' as const,
    executable: true as const,
    expectedSha256Candidate: observed.sha256,
    observedSha256: observed.sha256,
    device: observed.identity.device,
    inode: observed.identity.inode
  })
}
