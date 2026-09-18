import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cleanupReleasedCodexLabRuntime = vi.hoisted(() => vi.fn())

vi.mock('../../../../orchestration/lab-profile/codex-lab-runtime-cleanup-authority', () => ({
  cleanupReleasedCodexLabRuntime
}))

import { reconcileRequestedWorkerTerminalReleases } from '../../../../orchestration/worker-terminal-release-reconciliation'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('worker release Codex laboratory cleanup', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  beforeEach(() => cleanupReleasedCodexLabRuntime.mockReset())
  afterEach(() => h.cleanup())

  it('surfaces cleanup_pending after a live terminal release settles', async () => {
    cleanupReleasedCodexLabRuntime.mockResolvedValue('cleanup_pending')
    h.setup()
    const { dispatchId } = await h.startSettledWorker()

    const receipt = requireReleaseReceipt(
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })
    )

    expect(receipt.state).toBe('release_pending')
    expect(receipt.recovery).toContain('fresh request ID')
    expect(receipt.recovery).not.toContain('same --retry-request')
    expect(cleanupReleasedCodexLabRuntime).toHaveBeenCalledWith({
      db: h.db,
      dispatchId,
      resource: expect.objectContaining({
        ownership_state: 'released',
        release_state: 'released'
      })
    })
  })

  it('redrives cleanup for an already released terminal with a fresh request ID', async () => {
    cleanupReleasedCodexLabRuntime
      .mockResolvedValueOnce('released')
      .mockResolvedValueOnce('cleanup_pending')
    h.setup()
    const { dispatchId } = await h.startSettledWorker()

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })
    const retry = requireReleaseReceipt(
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })
    )

    expect(retry.state).toBe('release_pending')
    expect(retry.recovery).toContain('fresh request ID')
    expect(retry.recovery).toContain('Reusing the prior request ID')
    expect(cleanupReleasedCodexLabRuntime).toHaveBeenCalledTimes(2)
  })

  it('surfaces cleanup_pending when dead-worker settlement releases the terminal', async () => {
    cleanupReleasedCodexLabRuntime.mockResolvedValue('cleanup_pending')
    h.setup()
    const { dispatchId } = await h.startWorker()
    h.db.abandonWorkerDispatch(dispatchId)
    h.inspectProcessLiveness.mockResolvedValue('exited')

    const receipt = requireReleaseReceipt(
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })
    )

    expect(receipt.state).toBe('release_pending')
    expect(receipt.recovery).toContain('fresh request ID')
    expect(cleanupReleasedCodexLabRuntime).toHaveBeenCalledWith({
      db: h.db,
      dispatchId,
      resource: expect.objectContaining({ release_state: 'released' })
    })
  })

  it('surfaces cleanup_pending after recovery proves the released process exited', async () => {
    cleanupReleasedCodexLabRuntime.mockResolvedValue('cleanup_pending')
    h.setup()
    const { dispatchId } = await h.startSettledWorker()

    vi.spyOn(h.db, 'settleWorkerTerminalRelease').mockImplementationOnce(() => {
      throw new Error('SQLite interrupted after terminal close')
    })
    await expect(h.call('orchestration.workerRelease', { dispatch: dispatchId })).rejects.toThrow(
      'SQLite interrupted after terminal close'
    )

    vi.mocked(h.runtime.showTerminal).mockRejectedValue(new Error('terminal_handle_stale'))
    vi.mocked(h.runtime.getOrchestrationDispatchAuthority).mockReturnValue(null)
    vi.mocked(h.runtime.getTerminalPaneKey).mockReturnValue(null)
    vi.mocked(h.runtime.getTerminalProcessIncarnation).mockReturnValue(null)
    h.inspectProcessLiveness.mockResolvedValue('exited')

    await expect(reconcileRequestedWorkerTerminalReleases(h.runtime)).resolves.toMatchObject({
      attempted: 1,
      released: 0,
      pending: 1
    })
    expect(cleanupReleasedCodexLabRuntime).toHaveBeenCalledTimes(1)
    expect(cleanupReleasedCodexLabRuntime).toHaveBeenCalledWith({
      db: h.db,
      dispatchId,
      resource: expect.objectContaining({
        ownership_state: 'released',
        release_state: 'released'
      })
    })
  })
})

function requireReleaseReceipt(value: unknown): Readonly<{ state: string; recovery?: string }> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected worker release to return an object receipt.')
  }
  const state = Reflect.get(value, 'state')
  const recovery = Reflect.get(value, 'recovery')
  if (typeof state !== 'string' || (recovery !== undefined && typeof recovery !== 'string')) {
    throw new Error('Expected worker release receipt to carry string state and recovery fields.')
  }
  return recovery === undefined ? { state } : { state, recovery }
}
