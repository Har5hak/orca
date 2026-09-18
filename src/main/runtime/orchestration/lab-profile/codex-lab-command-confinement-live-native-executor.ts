import { createOutputSink } from '../../../../shared/child-process/bounded-output-sink'
import { spawnProcess, type ProcessSpec } from '../../../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../../../shared/child-process/process-tree-termination'
import {
  CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
  CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS
} from './codex-lab-command-confinement-contract'
import type { CodexLabExactExecutionResult } from './codex-lab-command-confinement-live-contract'

export async function executeNativeCodexLabExactSpec(
  spec: ProcessSpec
): Promise<CodexLabExactExecutionResult> {
  if (process.platform !== 'darwin') {
    throw new Error('live Codex laboratory confinement is currently supported only on macOS')
  }
  assertExactExecutionBounds(spec)
  const child = spawnProcess(spec)
  const stdout = createOutputSink(CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES)
  const stderr = createOutputSink(CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES)

  return new Promise((resolve, reject) => {
    let closed = false
    let terminationStarted = false
    let terminationComplete = false
    let terminationVerified = false
    let failure: Error | undefined
    let settled = false

    const finish = (): void => {
      if (settled || !closed || !terminationComplete) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (failure) {
        reject(failure)
        return
      }
      if (!terminationVerified) {
        reject(new Error('confinement process group termination was not verified'))
        return
      }
      const output = stdout.text().trim()
      if (!output || output.includes('\n') || stderr.text() !== '') {
        reject(new Error('confinement probe did not emit one clean JSON record'))
        return
      }
      try {
        JSON.parse(output)
      } catch {
        reject(new Error('confinement probe record is not valid JSON'))
        return
      }
      // The SIGKILL is host-initiated only after a complete report. Returning a
      // successful synthetic result lets the preflight validate that report;
      // the separate result field proves the whole detached process group died.
      resolve({
        process: {
          code: 0,
          signal: null,
          stdout: output,
          stderr: '',
          timedOut: false,
          outputTruncated: false
        },
        processTreeTermination: 'verified'
      })
    }

    const terminate = (reason?: Error): void => {
      if (reason) {
        failure ??= reason
      }
      if (terminationStarted) {
        return
      }
      terminationStarted = true
      void forceTerminateProcessTree(child)
        .then((verified) => {
          if (!verified) {
            failure ??= new Error('confinement process group termination was not verified')
          } else {
            terminationVerified = true
          }
          terminationComplete = true
          finish()
        })
        .catch((error: unknown) => {
          failure ??= error instanceof Error ? error : new Error('process termination failed')
          terminationComplete = true
          finish()
        })
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout.write(chunk)
      if (stdout.truncated()) {
        terminate(new Error('confinement probe stdout exceeded its bound'))
        return
      }
      if (stdout.text().includes('\n')) {
        terminate()
      }
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.write(chunk)
      if (stderr.truncated()) {
        terminate(new Error('confinement probe stderr exceeded its bound'))
      }
    })
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', (error) => terminate(error))
    }
    child.once('error', (error) => {
      failure ??= error
      if (!child.pid) {
        closed = true
      }
      terminate()
      finish()
    })
    child.once('close', (code, signal) => {
      closed = true
      if (!terminationStarted) {
        const diagnostic = stderr.text().trim().slice(0, 1_024)
        terminate(
          new Error(
            `confinement probe exited before its report was captured (code=${String(
              code
            )}, signal=${String(signal)})${diagnostic ? `: ${diagnostic}` : ''}`
          )
        )
      }
      finish()
    })
    child.stdin.end(spec.input)

    const timer = setTimeout(() => {
      terminate(new Error('confinement probe report timed out'))
    }, CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS)
    timer.unref?.()
  })
}

function assertExactExecutionBounds(spec: ProcessSpec): void {
  if (
    spec.terminationBarrier !== true ||
    spec.timeoutMs !== CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS ||
    spec.maxOutputBytes !== CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES
  ) {
    throw new Error('confinement executor received a ProcessSpec with unexpected bounds')
  }
}
