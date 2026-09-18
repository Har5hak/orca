import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProcessSpec } from '../../../../shared/child-process/run-process'
import {
  CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
  CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS
} from './codex-lab-command-confinement-contract'
import { executeNativeCodexLabExactSpec } from './codex-lab-command-confinement-live-native-executor'

describe('native Codex laboratory exact executor', () => {
  it.runIf(process.platform === 'darwin')(
    'captures one report and verifies termination of the detached process tree',
    async () => {
      const source = [
        "const { spawn } = require('node:child_process')",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' })",
        "process.stdout.write(JSON.stringify({ proof: 'complete' }) + '\\n')",
        'setInterval(() => {}, 60000)'
      ].join(';')
      const spec: ProcessSpec = {
        program: process.execPath,
        args: ['-e', source],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS,
        maxOutputBytes: CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
        terminationBarrier: true
      }

      await expect(executeNativeCodexLabExactSpec(spec)).resolves.toEqual({
        process: {
          code: 0,
          signal: null,
          stdout: '{"proof":"complete"}',
          stderr: '',
          timedOut: false,
          outputTruncated: false
        },
        processTreeTermination: 'verified'
      })
    }
  )

  it('refuses a spec without the exact termination barrier', async () => {
    await expect(
      executeNativeCodexLabExactSpec({
        program: process.execPath,
        timeoutMs: CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS,
        maxOutputBytes: CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES
      })
    ).rejects.toThrow('unexpected bounds')
  })

  it.runIf(process.platform === 'darwin')(
    'terminates the surviving process group when the root exits before reporting',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-confinement-premature-exit-'))
      const marker = join(root, 'descendant-survived')
      const descendant = [
        "const fs = require('node:fs')",
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'survived'), 300)`,
        'setTimeout(() => process.exit(0), 800)'
      ].join(';')
      const parent = [
        "const { spawn } = require('node:child_process')",
        `spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
        'process.exit(7)'
      ].join(';')
      try {
        await expect(
          executeNativeCodexLabExactSpec({
            program: process.execPath,
            args: ['-e', parent],
            cwd: process.cwd(),
            env: process.env,
            timeoutMs: CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS,
            maxOutputBytes: CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
            terminationBarrier: true
          })
        ).rejects.toThrow('before its report')
        await new Promise<void>((resolve) => setTimeout(resolve, 450))
        expect(existsSync(marker)).toBe(false)
      } finally {
        await new Promise<void>((resolve) => setTimeout(resolve, 500))
        if (existsSync(marker)) {
          expect(readFileSync(marker, 'utf8')).toBe('survived')
          unlinkSync(marker)
        }
        rmdirSync(root)
      }
    }
  )
})
