import type { ProcessResult, ProcessSpec } from '../../../../shared/child-process/run-process'
import type {
  CodexLabCommandConfinementPreflightInput,
  CodexLabCommandConfinementRefusalReason
} from './codex-lab-command-confinement-contract'
import { runCodexLabCommandConfinementPreflight } from './codex-lab-command-confinement-preflight'
import {
  confinementInput,
  expectedConfinementProbeReport,
  successfulProbeResult
} from './codex-lab-command-confinement.test-support'

export const UNSUCCESSFUL_CONFINEMENT_PROCESS_RESULTS: readonly [
  Partial<ProcessResult>,
  CodexLabCommandConfinementRefusalReason
][] = [
  [{ timedOut: true }, 'process_timed_out'],
  [{ outputTruncated: true }, 'output_truncated'],
  [{ code: 7 }, 'process_failed'],
  [{ signal: 'SIGTERM' }, 'process_failed'],
  [{ stderr: 'unexpected diagnostic' }, 'process_failed']
]

export async function captureSuccessfulConfinementRun(
  input: CodexLabCommandConfinementPreflightInput = confinementInput()
): Promise<{
  spec: ProcessSpec
  result: Awaited<ReturnType<typeof runCodexLabCommandConfinementPreflight>>
}> {
  const specs: ProcessSpec[] = []
  const result = await runCodexLabCommandConfinementPreflight(input, async (spec) => {
    specs.push(spec)
    return successfulProbeResult(JSON.stringify(expectedConfinementProbeReport(input)))
  })
  const spec = specs[0]
  if (!spec) {
    throw new Error('executor was not invoked')
  }
  return { spec, result }
}
