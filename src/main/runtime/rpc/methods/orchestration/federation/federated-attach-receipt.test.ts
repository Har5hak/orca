import { describe, expect, it } from 'vitest'
import { parseRemoteFederatedWorkerStartReceipt } from './federated-attach-receipt'

describe('remote federated worker start receipt', () => {
  it.each([
    { name: 'missing runtime epoch', receipt: {} },
    { name: 'non-string runtime epoch', receipt: { runtimeEpoch: 42 } },
    { name: 'missing worktree id', receipt: { runtimeEpoch: 'epoch_remote' } },
    {
      name: 'missing terminal handle',
      receipt: {
        runtimeEpoch: 'epoch_remote',
        worktreeId: 'worktree_remote',
        terminalHandle: undefined
      }
    }
  ])('rejects a ready receipt with $name', ({ receipt }) => {
    expect(() =>
      parseRemoteFederatedWorkerStartReceipt({
        dispatchId: 'ctx_remote',
        state: 'ready',
        terminalHandle: 'term_remote',
        ...receipt
      })
    ).toThrow('invalid ready receipt')
  })

  it('accepts a non-ready receipt without ready-only resources', () => {
    expect(
      parseRemoteFederatedWorkerStartReceipt({
        dispatchId: 'ctx_remote',
        state: 'outcome_unknown'
      })
    ).toMatchObject({ dispatchId: 'ctx_remote', state: 'outcome_unknown' })
  })

  it('preserves bounded diagnostic text and additive structured fields exactly', () => {
    const failedStage = 'remote\nattach\u001b[31m'
    const lastError = 'peer said\nretry\u202e'

    expect(
      parseRemoteFederatedWorkerStartReceipt({
        dispatchId: 'ctx_remote',
        state: 'failed',
        futureReceiptField: { version: 2 },
        setup: { state: 'failed', futureSetupField: true },
        failedStage,
        lastError
      })
    ).toEqual({
      dispatchId: 'ctx_remote',
      state: 'failed',
      futureReceiptField: { version: 2 },
      setup: { state: 'failed', futureSetupField: true },
      failedStage,
      lastError
    })
  })

  it.each([
    ['unknown state', { dispatchId: 'ctx_remote', state: 'future_state' }],
    [
      'oversized effects',
      { dispatchId: 'ctx_remote', state: 'failed', effects: Array.from({ length: 513 }) }
    ],
    [
      'oversized error',
      { dispatchId: 'ctx_remote', state: 'failed', lastError: 'x'.repeat(32_769) }
    ],
    ['malformed setup', { dispatchId: 'ctx_remote', state: 'failed', setup: { state: 1 } }]
  ])('rejects a structured receipt with %s', (_name, receipt) => {
    expect(() => parseRemoteFederatedWorkerStartReceipt(receipt)).toThrow(
      'invalid attachment receipt'
    )
  })
})
