import type {
  CodexLabCommandConfinementPreflightInput,
  CodexLabCommandConfinementRefusalReason
} from './codex-lab-command-confinement-contract'
import {
  confinementControls,
  confinementInput,
  confinementProbeCandidate,
  preparedConfinementLayout
} from './codex-lab-command-confinement.test-support'

export function accessorCases(): readonly {
  input: CodexLabCommandConfinementPreflightInput
  reason: CodexLabCommandConfinementRefusalReason
  reads: () => number
}[] {
  const makeGetter = () => {
    let reads = 0
    return {
      descriptor: {
        enumerable: true,
        get: () => {
          reads += 1
          throw new Error('SUPER_SECRET_VALUE')
        }
      },
      reads: () => reads
    }
  }
  const rootGetter = makeGetter()
  const root = Object.defineProperty({ ...confinementInput() }, 'controls', rootGetter.descriptor)
  const layoutGetter = makeGetter()
  const layout = Object.defineProperty(
    { ...preparedConfinementLayout() },
    'configSha256',
    layoutGetter.descriptor
  )
  const probeGetter = makeGetter()
  const probe = Object.defineProperty(
    { ...confinementProbeCandidate() },
    'observedSha256',
    probeGetter.descriptor
  )
  const controlGetter = makeGetter()
  const controls = Object.defineProperty(
    { ...confinementControls() },
    'network',
    controlGetter.descriptor
  )

  return [
    {
      input: root as CodexLabCommandConfinementPreflightInput,
      reason: 'input_invalid',
      reads: rootGetter.reads
    },
    {
      input: confinementInput({
        preparedLayout: layout as CodexLabCommandConfinementPreflightInput['preparedLayout']
      }),
      reason: 'layout_invalid',
      reads: layoutGetter.reads
    },
    {
      input: confinementInput({
        probeIdentityCandidate:
          probe as CodexLabCommandConfinementPreflightInput['probeIdentityCandidate']
      }),
      reason: 'probe_identity_candidate_invalid',
      reads: probeGetter.reads
    },
    {
      input: confinementInput({
        controls: controls as CodexLabCommandConfinementPreflightInput['controls']
      }),
      reason: 'control_evidence_invalid',
      reads: controlGetter.reads
    }
  ]
}
