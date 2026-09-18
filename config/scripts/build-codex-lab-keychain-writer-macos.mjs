#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const sourcePath = path.join(repoRoot, 'native', 'codex-lab-keychain-writer-macos', 'main.swift')
const defaultOutputPath = path.join(
  repoRoot,
  'native',
  'codex-lab-keychain-writer-macos',
  '.build',
  'release',
  'orca-codex-lab-keychain-writer'
)

if (process.platform !== 'darwin') {
  process.exit(0)
}

const args = process.argv.slice(2)
const outputPath = readArg('--output') ?? defaultOutputPath
const singleArch = args.includes('--single-arch')
const workDir = mkdtempSync(path.join(tmpdir(), 'orca-codex-lab-keychain-writer-'))

try {
  const triples = singleArch
    ? [process.arch === 'arm64' ? 'arm64-apple-macosx' : 'x86_64-apple-macosx']
    : ['arm64-apple-macosx', 'x86_64-apple-macosx']
  const builtBinaries = triples.map((triple) => {
    const output = path.join(workDir, `orca-codex-lab-keychain-writer-${triple}`)
    execFileSync(
      'swiftc',
      [
        '-O',
        sourcePath,
        '-target',
        triple.replace('-apple-macosx', '-apple-macosx11.0'),
        '-o',
        output
      ],
      { stdio: 'inherit' }
    )
    return output
  })
  mkdirSync(path.dirname(outputPath), { recursive: true })
  if (builtBinaries.length === 1) {
    execFileSync('cp', [builtBinaries[0], outputPath])
  } else {
    execFileSync('lipo', ['-create', ...builtBinaries, '-output', outputPath])
  }
  chmodSync(outputPath, 0o755)
  // Sign the standalone Mach-O itself. Release/dev app signing may replace this ad-hoc identity,
  // but the packaged input is never an unsigned helper.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', outputPath], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', outputPath], { stdio: 'inherit' })
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function readArg(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
