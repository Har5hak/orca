import { beforeEach, describe, expect, it, vi } from 'vitest'

const update = vi.fn()
const issueLabel = vi.fn(async () => ({ update }))
const getClients = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: vi.fn()
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: vi.fn().mockReturnValue(false)
}))

function entry() {
  return {
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: { issueLabel },
    apiKey: 'test-key'
  }
}

describe('Linear admin mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClients.mockReturnValue([entry()])
    update.mockResolvedValue({ success: true })
  })

  it('confirms an empty label description when Linear reads it back as null', async () => {
    const label = { id: 'label-1', name: 'Needs QA', color: '#fff', description: null }
    const readback = vi.fn().mockResolvedValue(label)
    const { updateLabelDescriptionForAgent } = await import('./linear-admin-mutations')

    await expect(
      updateLabelDescriptionForAgent('label-1', '', 'workspace-1', readback)
    ).resolves.toEqual(label)

    expect(update).toHaveBeenCalledWith({ description: '' })
    expect(readback).toHaveBeenCalledOnce()
  })
})
