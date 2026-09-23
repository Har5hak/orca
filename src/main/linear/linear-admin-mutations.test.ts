import { beforeEach, describe, expect, it, vi } from 'vitest'

const update = vi.fn()
const issueLabel = vi.fn()
const getClients = vi.fn()

const concurrency = vi.hoisted(() => {
  const state = { held: 0 }
  return {
    state,
    acquire: vi.fn(async () => {
      state.held += 1
    }),
    release: vi.fn(() => {
      state.held -= 1
    })
  }
})

vi.mock('./linear-request-concurrency', () => ({
  acquire: concurrency.acquire,
  release: concurrency.release
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
    issueLabel.mockReset()
    concurrency.state.held = 0
    getClients.mockReturnValue([entry()])
    update.mockResolvedValue({ success: true })
  })

  it('clears an empty label description to null and confirms readback', async () => {
    const label = { id: 'label-1', name: 'Needs QA', color: '#fff', description: null }
    issueLabel.mockResolvedValueOnce({ update }).mockResolvedValueOnce(label)
    const { updateLabelDescriptionForAgent } = await import('./linear-admin-mutations')

    await expect(updateLabelDescriptionForAgent('label-1', '', 'workspace-1')).resolves.toEqual(
      label
    )

    expect(update).toHaveBeenCalledWith({ description: null })
    expect(issueLabel).toHaveBeenCalledTimes(2)
  })

  it('uses one bounded Linear write slot for mutation and authoritative readback', async () => {
    const label = { id: 'label-1', name: 'Needs QA', color: '#fff', description: 'Ready' }
    issueLabel.mockResolvedValueOnce({ update }).mockImplementationOnce(async () => {
      expect(concurrency.state.held).toBe(1)
      return label
    })
    const { updateLabelDescriptionForAgent } = await import('./linear-admin-mutations')

    await expect(
      updateLabelDescriptionForAgent('label-1', 'Ready', 'workspace-1')
    ).resolves.toEqual(label)

    expect(concurrency.acquire).toHaveBeenCalledOnce()
    expect(concurrency.release).toHaveBeenCalledOnce()
    expect(issueLabel).toHaveBeenCalledTimes(2)
    expect(concurrency.state.held).toBe(0)
  })
})
