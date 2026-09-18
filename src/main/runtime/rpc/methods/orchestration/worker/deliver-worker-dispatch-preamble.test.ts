import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalPromptDelivery } from '../../../../../../shared/runtime-terminal-contracts'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { LAB_DYNAMIC_TOOL_USAGE_CONTRACT } from '../../../../orchestration/lab-profile/lab-dispatch-preamble'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'

const { getCodexLabStructuredLaunchBinding, sendStructuredWorkerPreamble } = vi.hoisted(() => ({
  getCodexLabStructuredLaunchBinding: vi.fn(
    (_sessionId: string): Readonly<{ dispatchId: string }> | undefined => undefined
  ),
  sendStructuredWorkerPreamble: vi.fn(
    async (_args: {
      host: unknown
      sessionId: string
      dispatchId: string
      preamble: string
    }): Promise<void> => {}
  )
}))

vi.mock(
  '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry',
  () => ({
    getCodexLabStructuredLaunchBinding
  })
)

vi.mock('../../orchestration-structured-worker-session', () => ({
  sendStructuredWorkerPreamble
}))

import { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'

type DispatchPreambleArgs = Parameters<typeof deliverWorkerDispatchPreamble>[0]
type LabDispatchPreambleArgs = Extract<DispatchPreambleArgs, { delivery: 'lab-structured-only' }>
type OrdinaryDispatchPreambleArgs = Extract<DispatchPreambleArgs, { delivery: 'ordinary' }>

function structuredSessionFixture(
  sessionId: string,
  host: unknown = { marker: 'host' }
): LabDispatchPreambleArgs['structuredSession'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this boundary test passes the host opaquely to a mocked sender and exercises only the sessionId snapshot.
  return { host, identity: { sessionId } } as LabDispatchPreambleArgs['structuredSession']
}

function ordinaryRuntime() {
  const runtime = new OrcaRuntimeService()
  const getNestedWorkerMaxDepth = vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(3)
  const getTerminalOrchestrationCliCommand = vi
    .spyOn(runtime, 'getTerminalOrchestrationCliCommand')
    .mockReturnValue('orca')
  const sendTerminalAgentPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt')
  return {
    runtime,
    getNestedWorkerMaxDepth,
    getTerminalOrchestrationCliCommand,
    sendTerminalAgentPrompt
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adversarial tests deliberately pass malformed JavaScript caller objects that cannot satisfy the compile-time discriminated union.
const deliverUnchecked = deliverWorkerDispatchPreamble as (
  args: object
) => ReturnType<typeof deliverWorkerDispatchPreamble>

const structuredSession = structuredSessionFixture('session-lab-757')

beforeEach(() => {
  getCodexLabStructuredLaunchBinding.mockReset()
  getCodexLabStructuredLaunchBinding.mockImplementation((sessionId) =>
    sessionId === 'session-lab-757' ? Object.freeze({ dispatchId: 'dispatch-lab-757' }) : undefined
  )
  sendStructuredWorkerPreamble.mockClear()
})

describe('worker dispatch preamble delivery', () => {
  it('delivers the restricted laboratory preamble only through the structured session', async () => {
    await deliverWorkerDispatchPreamble({
      delivery: 'lab-structured-only',
      structuredSession,
      dispatchId: 'dispatch-lab-757',
      taskSpec: 'Inspect the fixture and report the deterministic test result.'
    })

    expect(sendStructuredWorkerPreamble).toHaveBeenCalledOnce()
    const invocation = sendStructuredWorkerPreamble.mock.calls[0]?.[0]
    expect(invocation).toMatchObject({
      sessionId: 'session-lab-757',
      dispatchId: 'dispatch-lab-757'
    })
    const preamble = invocation?.preamble ?? ''
    const namedTools = [...new Set(preamble.match(/\borca_worker_[a-z_]+\b/gu) ?? [])]
    expect(namedTools).toEqual([...LAB_DYNAMIC_TOOL_USAGE_CONTRACT.tools])
    expect(preamble).not.toMatch(/dcap_|lgw1_|term_|ORCA_/u)
    expect(preamble).not.toMatch(/orca\s+orchestration|escalation|sub[ -]?dispatch/iu)
  })

  it('refuses a laboratory terminal fallback before any ordinary runtime call', async () => {
    const sendTerminalAgentPrompt = vi.fn()
    const staleCaller = {
      delivery: 'lab-structured-only',
      structuredSession: null,
      dispatchId: 'dispatch-lab-757',
      taskSpec: 'Inspect the fixture.',
      runtime: { sendTerminalAgentPrompt }
    }

    await expect(deliverUnchecked(staleCaller)).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_PREAMBLE_DELIVERY_REFUSED',
      reason: 'structured_session_required'
    })
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('refuses generic lifecycle authority on the laboratory branch', async () => {
    const staleCaller = {
      delivery: 'lab-structured-only',
      structuredSession,
      dispatchId: 'dispatch-lab-757',
      taskSpec: 'Inspect the fixture.',
      dispatchCapability: 'dcap_forbidden'
    }

    await expect(deliverUnchecked(staleCaller)).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_PREAMBLE_DELIVERY_REFUSED',
      reason: 'forbidden_authority_input'
    })
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
  })

  it('refuses non-enumerable or symbol authority fields on the laboratory branch', async () => {
    const hiddenAuthority = {
      delivery: 'lab-structured-only',
      structuredSession,
      dispatchId: 'dispatch-lab-757',
      taskSpec: 'Inspect the fixture.'
    }
    Object.defineProperty(hiddenAuthority, 'dispatchCapability', {
      value: 'dcap_forbidden',
      enumerable: false
    })
    const symbolAuthority = {
      delivery: 'lab-structured-only',
      structuredSession,
      dispatchId: 'dispatch-lab-757',
      taskSpec: 'Inspect the fixture.',
      [Symbol('authority')]: 'forbidden'
    }

    await expect(deliverUnchecked(hiddenAuthority)).rejects.toMatchObject({
      reason: 'forbidden_authority_input'
    })
    await expect(deliverUnchecked(symbolAuthority)).rejects.toMatchObject({
      reason: 'forbidden_authority_input'
    })
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
  })

  it('refuses laboratory delivery through an unbound structured session', async () => {
    const unboundSession = structuredSessionFixture('session-ordinary-757')

    await expect(
      deliverWorkerDispatchPreamble({
        delivery: 'lab-structured-only',
        structuredSession: unboundSession,
        dispatchId: 'dispatch-lab-757',
        taskSpec: 'Inspect the fixture.'
      })
    ).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_PREAMBLE_DELIVERY_REFUSED',
      reason: 'lab_binding_missing'
    })
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
  })

  it('refuses laboratory delivery across a Dispatch binding', async () => {
    await expect(
      deliverWorkerDispatchPreamble({
        delivery: 'lab-structured-only',
        structuredSession,
        dispatchId: 'dispatch-foreign-757',
        taskSpec: 'Inspect the fixture.'
      })
    ).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_PREAMBLE_DELIVERY_REFUSED',
      reason: 'lab_binding_dispatch_mismatch'
    })
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
  })

  it('refuses the ordinary authority preamble for a laboratory-bound session', async () => {
    const {
      runtime,
      getNestedWorkerMaxDepth,
      getTerminalOrchestrationCliCommand,
      sendTerminalAgentPrompt
    } = ordinaryRuntime()

    await expect(
      deliverWorkerDispatchPreamble({
        delivery: 'ordinary',
        runtime,
        structuredSession,
        terminalHandle: 'term_worker',
        dispatchId: 'dispatch-lab-757',
        dispatchDepth: 1,
        taskId: 'task-lab-757',
        taskSpec: 'Inspect the fixture.',
        coordinatorHandle: 'term_coordinator',
        dispatchCapability: 'dcap_forbidden',
        devMode: false,
        requestId: 'request-lab-757'
      })
    ).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_PREAMBLE_DELIVERY_REFUSED',
      reason: 'lab_binding_delivery_mismatch'
    })
    expect(getNestedWorkerMaxDepth).not.toHaveBeenCalled()
    expect(getTerminalOrchestrationCliCommand).not.toHaveBeenCalled()
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
  })

  it('refuses an unknown delivery mode instead of inferring an ordinary worker', async () => {
    const sendTerminalAgentPrompt = vi.fn()
    const staleCaller = {
      delivery: 'codex',
      runtime: { sendTerminalAgentPrompt },
      structuredSession,
      dispatchId: 'dispatch-lab-757',
      taskSpec: 'Inspect the fixture.'
    }

    await expect(deliverUnchecked(staleCaller)).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_PREAMBLE_DELIVERY_REFUSED',
      reason: 'delivery_mode_invalid'
    })
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('refuses a truthy structured session without a stable session identity', async () => {
    const { runtime, getNestedWorkerMaxDepth, sendTerminalAgentPrompt } = ordinaryRuntime()

    await expect(
      deliverUnchecked({
        delivery: 'ordinary',
        runtime,
        structuredSession: { host: {}, identity: { sessionId: '' } },
        terminalHandle: 'term_worker',
        dispatchId: 'dispatch-ordinary',
        dispatchDepth: 1,
        taskId: 'task-ordinary',
        taskSpec: 'Run the ordinary task.',
        coordinatorHandle: 'term_coordinator',
        dispatchCapability: 'dcap_test_secret',
        devMode: false,
        requestId: 'request-ordinary'
      })
    ).rejects.toMatchObject({ reason: 'structured_session_invalid' })
    expect(getNestedWorkerMaxDepth).not.toHaveBeenCalled()
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
  })

  it('snapshots an ordinary structured session before checking its binding', async () => {
    const unboundHost = { marker: 'unbound-host' }
    const unboundSession = structuredSessionFixture('session-ordinary-757', unboundHost)
    let sessionReads = 0
    const { runtime } = ordinaryRuntime()
    const switchingCaller: OrdinaryDispatchPreambleArgs = {
      delivery: 'ordinary',
      runtime,
      get structuredSession() {
        sessionReads += 1
        return sessionReads === 1 ? unboundSession : structuredSession
      },
      terminalHandle: 'term_worker',
      dispatchId: 'dispatch-ordinary',
      dispatchDepth: 1,
      taskId: 'task-ordinary',
      taskSpec: 'Run the ordinary task.',
      coordinatorHandle: 'term_coordinator',
      dispatchCapability: 'dcap_test_secret',
      devMode: false,
      requestId: 'request-ordinary'
    }

    await deliverWorkerDispatchPreamble(switchingCaller)

    expect(sessionReads).toBe(1)
    expect(sendStructuredWorkerPreamble).toHaveBeenCalledWith(
      expect.objectContaining({ host: unboundHost, sessionId: 'session-ordinary-757' })
    )
  })

  it('keeps ordinary preamble bytes and terminal delivery unchanged', async () => {
    const { runtime, sendTerminalAgentPrompt } = ordinaryRuntime()
    const promptReceipt: RuntimeTerminalPromptDelivery = {
      requestId: 'request-ordinary',
      stages: ['input_accepted'],
      provider: 'codex',
      observation: 'supported',
      processIncarnation: 'process-ordinary',
      generation: 1,
      baselineWorkingSequence: 0
    }
    sendTerminalAgentPrompt.mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1,
      prompt: promptReceipt
    })
    const expected = buildDispatchPreamble({
      canDispatchSubWorkers: true,
      taskId: 'task-ordinary',
      dispatchId: 'dispatch-ordinary',
      taskSpec: 'Run the ordinary task.',
      coordinatorHandle: 'term_coordinator',
      workerHandle: 'term_worker',
      dispatchCapability: 'dcap_test_secret',
      devMode: false,
      cliCommand: 'orca'
    })

    const prompt = await deliverWorkerDispatchPreamble({
      delivery: 'ordinary',
      runtime,
      structuredSession: null,
      terminalHandle: 'term_worker',
      dispatchId: 'dispatch-ordinary',
      dispatchDepth: 1,
      taskId: 'task-ordinary',
      taskSpec: 'Run the ordinary task.',
      coordinatorHandle: 'term_coordinator',
      dispatchCapability: 'dcap_test_secret',
      devMode: false,
      requestId: 'request-ordinary'
    })

    expect(sendTerminalAgentPrompt).toHaveBeenCalledWith('term_worker', expected, {
      acceptQueued: true,
      observationTimeoutMs: 0,
      requestId: 'request-ordinary'
    })
    expect(prompt).toEqual(promptReceipt)
  })

  it('keeps full ordinary delivery for an unbound structured session', async () => {
    const ordinaryHost = { marker: 'ordinary-host' }
    const ordinarySession = structuredSessionFixture('session-ordinary-757', ordinaryHost)
    const { runtime, sendTerminalAgentPrompt } = ordinaryRuntime()
    const expected = buildDispatchPreamble({
      canDispatchSubWorkers: true,
      taskId: 'task-ordinary',
      dispatchId: 'dispatch-ordinary',
      taskSpec: 'Run the ordinary task.',
      coordinatorHandle: 'term_coordinator',
      workerHandle: 'term_worker',
      dispatchCapability: 'dcap_test_secret',
      devMode: false,
      cliCommand: 'orca'
    })

    await deliverWorkerDispatchPreamble({
      delivery: 'ordinary',
      runtime,
      structuredSession: ordinarySession,
      terminalHandle: 'term_worker',
      dispatchId: 'dispatch-ordinary',
      dispatchDepth: 1,
      taskId: 'task-ordinary',
      taskSpec: 'Run the ordinary task.',
      coordinatorHandle: 'term_coordinator',
      dispatchCapability: 'dcap_test_secret',
      devMode: false,
      requestId: 'request-ordinary'
    })

    expect(sendStructuredWorkerPreamble).toHaveBeenCalledWith({
      host: ordinaryHost,
      sessionId: 'session-ordinary-757',
      dispatchId: 'dispatch-ordinary',
      preamble: expected
    })
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})
