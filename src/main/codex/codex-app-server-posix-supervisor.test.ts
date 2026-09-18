import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { CodexAppServerLaunch } from './codex-app-server-connection'
import {
  createProviderSpawnSpec,
  POSIX_PROVIDER_SUPERVISOR_SCRIPT,
  supervisedPosixLaunch
} from './codex-app-server-posix-supervisor'

const launch: CodexAppServerLaunch = {
  command: '/opt/codex',
  args: ['app-server', '--flag'],
  cwd: '/work/repo',
  env: { CODEX_HOME: '/tmp/codex' }
}

type IntegrityLaunch = CodexAppServerLaunch &
  Readonly<{
    executableIntegrity: Readonly<{ canonicalPath: string; sha256: string }>
  }>

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents)
  chmodSync(path, 0o700)
}

function runSupervisor(launch: CodexAppServerLaunch): ReturnType<typeof spawnSync> {
  const spec = createProviderSpawnSpec(
    launch,
    { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    'darwin'
  )
  return spawnSync(spec.program, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    input: '',
    encoding: 'utf8',
    timeout: 5_000
  })
}

describe('structured provider supervision', () => {
  it('wraps POSIX launches in a detached supervisor and preserves the launch spec', () => {
    const childEnv = { PATH: '/bin', CODEX_HOME: '/tmp/codex' }
    const spec = supervisedPosixLaunch(launch, childEnv)

    expect(spec.command).toBe(process.execPath)
    expect(spec.args).toEqual(['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT])
    expect(spec.env.PATH).toBe('/bin')
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).toEqual(
      expect.objectContaining({
        command: '/opt/codex',
        args: ['app-server', '--flag'],
        cwd: '/work/repo'
      })
    )
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).not.toHaveProperty('env')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain(
      'delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC'
    )
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('delete childEnv.ELECTRON_RUN_AS_NODE')
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('process.ppid !== originalParent')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain(
      "process.stdin.once('close', scheduleOwnerShutdown)"
    )
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('detached: true')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain("process.kill(-child.pid, 'SIGKILL')")
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('providerGroupExists()')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('finishWithProviderOutcome(code, signal)')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).not.toContain('process.ppid === 1')
  })

  it('uses direct provider spawning on Windows because the job owns the tree', () => {
    expect(createProviderSpawnSpec(launch, { PATH: '/bin' }, 'win32')).toEqual({
      program: '/opt/codex',
      args: ['app-server', '--flag'],
      env: { PATH: '/bin' },
      cwd: '/work/repo',
      detached: false
    })
  })

  it.runIf(process.platform !== 'win32')(
    'refuses a provider changed after its launch integrity was sealed',
    () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-integrity-')))
      const executable = join(directory, 'codex-fixture')
      const marker = join(directory, 'provider-ran')
      const sealedContents = '#!/bin/sh\nexit 0\n'
      const changedContents = '#!/bin/sh\nprintf changed > "$1"\n'
      try {
        writeExecutable(executable, sealedContents)
        const guardedLaunch: IntegrityLaunch = {
          command: executable,
          args: [marker],
          cwd: directory,
          executableIntegrity: {
            canonicalPath: executable,
            sha256: sha256(sealedContents)
          }
        }

        // Simulates replacement after the earlier TASK-757 preflight observation.
        writeExecutable(executable, changedContents)
        const result = runSupervisor(guardedLaunch)

        expect(result.status).toBe(126)
        expect(existsSync(marker)).toBe(false)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'launches an unchanged provider whose bytes match the sealed integrity',
    () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-integrity-')))
      const executable = join(directory, 'codex-fixture')
      const marker = join(directory, 'provider-ran')
      const contents = '#!/bin/sh\nprintf verified > "$1"\n'
      try {
        writeExecutable(executable, contents)
        const guardedLaunch: IntegrityLaunch = {
          command: executable,
          args: [marker],
          cwd: directory,
          executableIntegrity: {
            canonicalPath: executable,
            sha256: sha256(contents)
          }
        }

        const result = runSupervisor(guardedLaunch)

        expect(result.status).toBe(0)
        expect(readFileSync(marker, 'utf8')).toBe('verified')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform !== 'win32')(
    'preserves ordinary launches that carry no executable integrity requirement',
    () => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-codex-integrity-')))
      const executable = join(directory, 'ordinary-provider')
      const marker = join(directory, 'provider-ran')
      try {
        writeExecutable(executable, '#!/bin/sh\nprintf ordinary > "$1"\n')

        const result = runSupervisor({
          command: executable,
          args: [marker],
          cwd: directory
        })

        expect(result.status).toBe(0)
        expect(readFileSync(marker, 'utf8')).toBe('ordinary')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('fails closed instead of bypassing integrity on a direct-spawn platform', () => {
    const guardedLaunch: IntegrityLaunch = {
      ...launch,
      executableIntegrity: {
        canonicalPath: launch.command,
        sha256: 'a'.repeat(64)
      }
    }

    expect(() => createProviderSpawnSpec(guardedLaunch, { PATH: '/bin' }, 'win32')).toThrow(
      /executable integrity/i
    )
  })
})
