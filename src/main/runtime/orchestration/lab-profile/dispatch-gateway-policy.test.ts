import { describe, expect, it } from 'vitest'
import {
  LAB_GATEWAY_ALLOWED_OPERATIONS,
  LAB_GATEWAY_UNWIRED_BOUNDARIES,
  admitLabGatewayRequest,
  mintLabGatewayPolicy,
  revokeLabGatewayPolicy,
  type LabGatewayBinding,
  type LabGatewayPolicy
} from './dispatch-gateway-policy'

const BINDING: LabGatewayBinding = {
  runId: 'run_757',
  taskId: 'task_757',
  dispatchId: 'dispatch_757',
  terminalHandle: 'term_757',
  terminalPaneKey: 'pane_757'
}

const ENTROPY = Uint8Array.from({ length: 32 }, (_value, index) => index + 1)

function grant(): ReturnType<typeof mintLabGatewayPolicy> {
  return mintLabGatewayPolicy(BINDING, () => ENTROPY)
}

function accept(policy: LabGatewayPolicy, credential: string, operation: string, params?: unknown) {
  const result = admitLabGatewayRequest(policy, { credential, operation, params })
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
  return result
}

function refuse(policy: LabGatewayPolicy, credential: string, operation: string, params?: unknown) {
  const result = admitLabGatewayRequest(policy, { credential, operation, params })
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error(`Expected ${operation} to be refused`)
  }
  return result
}

describe('TASK-757 per-Dispatch laboratory gateway policy', () => {
  it('mints a 256-bit bearer once while storing only its digest', () => {
    const minted = grant()

    expect(minted.credential).toMatch(/^lgw1_[A-Za-z0-9_-]{43}$/)
    expect(minted.policy.credentialSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(minted.policy)).not.toContain(minted.credential)
    expect(JSON.stringify(minted.receipt)).not.toContain(minted.credential)
    expect(minted.receipt).toMatchObject({
      schemaVersion: 1,
      binding: BINDING,
      allowedOperations: LAB_GATEWAY_ALLOWED_OPERATIONS,
      state: 'active',
      workerDoneAccepted: false,
      unwiredBoundaries: LAB_GATEWAY_UNWIRED_BOUNDARIES
    })
    expect(minted.receipt.policyDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(minted.receipt)).not.toMatch(/authToken|runtimeToken|sharedToken/)
  })

  it('refuses entropy shorter than 256 bits', () => {
    expect(() => mintLabGatewayPolicy(BINDING, () => new Uint8Array(31))).toThrow(
      'at least 32 bytes'
    )
  })

  it('translates status and non-consuming check with bound identities', () => {
    const minted = grant()

    expect(accept(minted.policy, minted.credential, 'worker.status').rpc).toEqual({
      method: 'orchestration.workerShow',
      params: { dispatch: BINDING.dispatchId }
    })
    expect(
      accept(minted.policy, minted.credential, 'worker.check', {
        wait: true,
        timeoutMs: 1_500
      }).rpc
    ).toEqual({
      method: 'orchestration.check',
      params: {
        terminal: BINDING.terminalHandle,
        terminalPaneKey: BINDING.terminalPaneKey,
        run: BINDING.runId,
        peek: true,
        unread: false,
        types: 'status,dispatch',
        wait: true,
        timeoutMs: 1_500
      }
    })
  })

  it('translates heartbeat without accepting a caller-selected sender or lifecycle ID', () => {
    const minted = grant()
    const accepted = accept(minted.policy, minted.credential, 'worker.heartbeat', {
      subject: 'still working',
      body: 'focused proof running'
    })

    expect(accepted.rpc).toEqual({
      method: 'orchestration.send',
      params: {
        from: BINDING.terminalHandle,
        senderPaneKey: BINDING.terminalPaneKey,
        to: `run:${BINDING.runId}`,
        run: BINDING.runId,
        type: 'heartbeat',
        subject: 'still working',
        body: 'focused proof running',
        payload: JSON.stringify({
          runId: BINDING.runId,
          taskId: BINDING.taskId,
          dispatchId: BINDING.dispatchId
        })
      }
    })
  })

  it('translates only blocking ask and bound reply consumption', () => {
    const minted = grant()

    expect(
      accept(minted.policy, minted.credential, 'worker.ask', {
        question: 'Proceed?',
        options: ['yes', 'no'],
        timeoutMs: 30_000
      }).rpc
    ).toEqual({
      method: 'orchestration.ask',
      params: {
        from: BINDING.terminalHandle,
        to: `run:${BINDING.runId}`,
        run: BINDING.runId,
        question: 'Proceed?',
        options: 'yes,no',
        timeoutMs: 30_000
      }
    })
    expect(
      accept(minted.policy, minted.credential, 'worker.reply.consume', {
        questionId: 'msg_question_757',
        timeoutMs: 5_000
      }).rpc
    ).toEqual({
      method: 'orchestration.ask',
      params: {
        from: BINDING.terminalHandle,
        to: `run:${BINDING.runId}`,
        run: BINDING.runId,
        resume: 'msg_question_757',
        timeoutMs: 5_000
      }
    })
  })

  it('accepts exactly one terminal worker_done and injects every lifecycle identity', () => {
    const minted = grant()
    const first = accept(minted.policy, minted.credential, 'worker.done', {
      outcome: 'succeeded',
      subject: 'done',
      body: 'proof complete'
    })

    expect(first.rpc).toEqual({
      method: 'orchestration.send',
      params: {
        from: BINDING.terminalHandle,
        senderPaneKey: BINDING.terminalPaneKey,
        to: `run:${BINDING.runId}`,
        run: BINDING.runId,
        type: 'worker_done',
        subject: 'done',
        body: 'proof complete',
        payload: JSON.stringify({
          runId: BINDING.runId,
          taskId: BINDING.taskId,
          dispatchId: BINDING.dispatchId,
          outcome: 'succeeded'
        }),
        waitForLifecycleSettlement: true
      }
    })
    expect(first.nextPolicy).toMatchObject({ workerDoneAccepted: true, terminal: true })
    expect(
      refuse(first.nextPolicy, minted.credential, 'worker.done', {
        outcome: 'succeeded',
        subject: 'again'
      }).refusal.reason
    ).toBe('worker_done_already_accepted')
    expect(refuse(first.nextPolicy, minted.credential, 'worker.status').refusal.reason).toBe(
      'policy_terminal'
    )
  })

  it.each([
    ['runId', 'run_foreign'],
    ['taskId', 'task_foreign'],
    ['dispatchId', 'dispatch_foreign'],
    ['terminalHandle', 'term_foreign'],
    ['terminalPaneKey', 'pane_foreign'],
    ['to', 'run:run_foreign']
  ])('denies cross-Dispatch caller identity %s', (field, value) => {
    const minted = grant()
    const denied = refuse(minted.policy, minted.credential, 'worker.heartbeat', {
      subject: 'heartbeat',
      [field]: value
    })

    expect(denied.refusal).toMatchObject({
      reason: 'cross_dispatch_identity',
      field
    })
  })

  it.each([
    ['runId', BINDING.runId],
    ['taskId', BINDING.taskId],
    ['dispatchId', BINDING.dispatchId],
    ['terminalHandle', BINDING.terminalHandle],
    ['terminalPaneKey', BINDING.terminalPaneKey],
    ['from', BINDING.terminalHandle],
    ['to', `run:${BINDING.runId}`]
  ])('denies even matching caller identity %s because the host injects it', (field, value) => {
    const minted = grant()
    const denied = refuse(minted.policy, minted.credential, 'worker.heartbeat', {
      subject: 'heartbeat',
      [field]: value
    })

    expect(denied.refusal).toMatchObject({
      reason: 'caller_identity_forbidden',
      field
    })
  })

  it.each([
    ['orchestration.send', 'arbitrary_send_forbidden'],
    ['orchestration.run', 'lifecycle_creation_forbidden'],
    ['orchestration.taskCreate', 'lifecycle_creation_forbidden'],
    ['orchestration.dispatch', 'lifecycle_creation_forbidden'],
    ['orchestration.workerStart', 'lifecycle_mutation_forbidden'],
    ['orchestration.workerStop', 'lifecycle_mutation_forbidden'],
    ['orchestration.workerAbandon', 'lifecycle_mutation_forbidden'],
    ['orchestration.workerRetry', 'lifecycle_mutation_forbidden'],
    ['orchestration.workerRetain', 'lifecycle_mutation_forbidden'],
    ['orchestration.workerRelease', 'lifecycle_mutation_forbidden'],
    ['terminal.write', 'raw_terminal_forbidden'],
    ['terminal.kill', 'raw_terminal_forbidden'],
    ['orchestration.futureUnknown', 'unknown_operation']
  ])('fails closed for denied operation %s', (operation, reason) => {
    const minted = grant()

    expect(refuse(minted.policy, minted.credential, operation).refusal.reason).toBe(reason)
  })

  it('rejects wrong credentials without revealing whether the requested operation exists', () => {
    const minted = grant()
    const other = mintLabGatewayPolicy(BINDING, () => new Uint8Array(32).fill(9))

    expect(
      refuse(minted.policy, other.credential, 'orchestration.futureUnknown').refusal.reason
    ).toBe('credential_invalid')
  })

  it('rejects every operation after explicit revocation', () => {
    const minted = grant()
    const revoked = revokeLabGatewayPolicy(minted.policy)

    expect(refuse(revoked, minted.credential, 'worker.status').refusal.reason).toBe(
      'credential_revoked'
    )
    expect(revoked.revoked).toBe(true)
  })

  it.each([
    ['worker.status', { extra: true }],
    ['worker.check', { wait: 'yes' }],
    ['worker.heartbeat', { subject: '' }],
    ['worker.ask', { question: '', timeoutMs: 1 }],
    ['worker.reply.consume', { questionId: '' }],
    ['worker.done', { outcome: 'maybe', subject: 'done' }]
  ])('rejects malformed parameters for %s', (operation, params) => {
    const minted = grant()

    expect(refuse(minted.policy, minted.credential, operation, params).refusal.reason).toBe(
      'invalid_parameters'
    )
  })
})
