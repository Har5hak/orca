import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const structuredSession = {
  host: { marker: 'host' },
  identity: { sessionId: 'session-lab-757' }
} as never

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
    } as unknown as Parameters<typeof deliverWorkerDispatchPreamble>[0]

    await expect(deliverWorkerDispatchPreamble(staleCaller)).rejects.toMatchObject({
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
    } as unknown as Parameters<typeof deliverWorkerDispatchPreamble>[0]

    await expect(deliverWorkerDispatchPreamble(staleCaller)).rejects.toMatchObject({
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

    await expect(
      deliverWorkerDispatchPreamble(
        hiddenAuthority as unknown as Parameters<typeof deliverWorkerDispatchPreamble>[0]
      )
    ).rejects.toMatchObject({ reason: 'forbidden_authority_input' })
    await expect(
      deliverWorkerDispatchPreamble(
        symbolAuthority as unknown as Parameters<typeof deliverWorkerDispatchPreamble>[0]
      )
    ).rejects.toMatchObject({ reason: 'forbidden_authority_input' })
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
  })

  it('refuses laboratory delivery through an unbound structured session', async () => {
    const unboundSession = {
      host: { marker: 'host' },
      identity: { sessionId: 'session-ordinary-757' }
    } as never

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
    const getNestedWorkerMaxDepth = vi.fn(() => 3)
    const getTerminalOrchestrationCliCommand = vi.fn(() => 'orca orchestration')
    const sendTerminalAgentPrompt = vi.fn()

    await expect(
      deliverWorkerDispatchPreamble({
        delivery: 'ordinary',
        runtime: {
          getNestedWorkerMaxDepth,
          getTerminalOrchestrationCliCommand,
          sendTerminalAgentPrompt
        } as never,
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
    } as unknown as Parameters<typeof deliverWorkerDispatchPreamble>[0]

    await expect(deliverWorkerDispatchPreamble(staleCaller)).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_PREAMBLE_DELIVERY_REFUSED',
      reason: 'delivery_mode_invalid'
    })
    expect(sendStructuredWorkerPreamble).not.toHaveBeenCalled()
    expect(sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('refuses a truthy structured session without a stable session identity', async () => {
    const getNestedWorkerMaxDepth = vi.fn(() => 3)
    const sendTerminalAgentPrompt = vi.fn()

    await expect(
      deliverWorkerDispatchPreamble({
        delivery: 'ordinary',
        runtime: {
          getNestedWorkerMaxDepth,
          getTerminalOrchestrationCliCommand: vi.fn(() => 'orca orchestration'),
          sendTerminalAgentPrompt
        } as never,
        structuredSession: { host: {}, identity: { sessionId: '' } } as never,
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
    const unboundSession = {
      host: unboundHost,
      identity: { sessionId: 'session-ordinary-757' }
    }
    let sessionReads = 0
    const switchingCaller = {
      delivery: 'ordinary',
      runtime: {
        getNestedWorkerMaxDepth: () => 3,
        getTerminalOrchestrationCliCommand: () => 'orca orchestration',
        sendTerminalAgentPrompt: vi.fn()
      },
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
    } as unknown as Parameters<typeof deliverWorkerDispatchPreamble>[0]

    await deliverWorkerDispatchPreamble(switchingCaller)

    expect(sessionReads).toBe(1)
    expect(sendStructuredWorkerPreamble).toHaveBeenCalledWith(
      expect.objectContaining({ host: unboundHost, sessionId: 'session-ordinary-757' })
    )
  })

  it('keeps ordinary preamble bytes and terminal delivery unchanged', async () => {
    const sendTerminalAgentPrompt = vi.fn(async () => ({ prompt: { state: 'accepted' } }))
    const runtime = {
      getNestedWorkerMaxDepth: () => 3,
      getTerminalOrchestrationCliCommand: () => 'orca orchestration',
      sendTerminalAgentPrompt
    } as never
    const expected = buildDispatchPreamble({
      canDispatchSubWorkers: true,
      taskId: 'task-ordinary',
      dispatchId: 'dispatch-ordinary',
      taskSpec: 'Run the ordinary task.',
      coordinatorHandle: 'term_coordinator',
      workerHandle: 'term_worker',
      dispatchCapability: 'dcap_test_secret',
      devMode: false,
      cliCommand: 'orca orchestration' as never
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
    expect(prompt).toEqual({ state: 'accepted' })
  })

  it('keeps full ordinary delivery for an unbound structured session', async () => {
    const ordinaryHost = { marker: 'ordinary-host' }
    const ordinarySession = {
      host: ordinaryHost,
      identity: { sessionId: 'session-ordinary-757' }
    } as never
    const sendTerminalAgentPrompt = vi.fn()
    const runtime = {
      getNestedWorkerMaxDepth: () => 3,
      getTerminalOrchestrationCliCommand: () => 'orca orchestration',
      sendTerminalAgentPrompt
    } as never
    const expected = buildDispatchPreamble({
      canDispatchSubWorkers: true,
      taskId: 'task-ordinary',
      dispatchId: 'dispatch-ordinary',
      taskSpec: 'Run the ordinary task.',
      coordinatorHandle: 'term_coordinator',
      workerHandle: 'term_worker',
      dispatchCapability: 'dcap_test_secret',
      devMode: false,
      cliCommand: 'orca orchestration' as never
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
