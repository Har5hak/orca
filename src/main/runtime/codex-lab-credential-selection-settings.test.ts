import { describe, expect, it } from 'vitest'
import { snapshotCodexLabCredentialSelectionSettings } from './codex-lab-credential-selection-settings'

describe('Codex laboratory credential selection settings', () => {
  it('returns an immutable host-private snapshot without deriving account paths', () => {
    const account = {
      id: 'account-1',
      email: 'owner@example.test',
      managedHomePath: '/trusted/orca/codex-accounts/account-1/home',
      managedHomeRuntime: 'host' as const,
      workspaceAccountId: 'workspace-1',
      createdAt: 1,
      updatedAt: 2,
      lastAuthenticatedAt: 3
    }
    const settings = {
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: 'legacy-selection',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'account-1',
        wsl: { Ubuntu: 'wsl-account' }
      }
    }

    const snapshot = snapshotCodexLabCredentialSelectionSettings(settings)
    account.managedHomePath = '/replaced/path'
    settings.activeCodexManagedAccountIdsByRuntime.host = 'account-2'

    expect(snapshot).toEqual({
      codexManagedAccounts: [
        expect.objectContaining({
          id: 'account-1',
          managedHomePath: '/trusted/orca/codex-accounts/account-1/home'
        })
      ],
      activeCodexManagedAccountId: 'legacy-selection',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'account-1',
        wsl: { Ubuntu: 'wsl-account' }
      }
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.codexManagedAccounts)).toBe(true)
    expect(Object.isFrozen(snapshot.codexManagedAccounts[0])).toBe(true)
    expect(Object.isFrozen(snapshot.activeCodexManagedAccountIdsByRuntime?.wsl)).toBe(true)
  })

  it.each([
    {},
    { codexManagedAccounts: [] },
    { codexManagedAccounts: [], activeCodexManagedAccountId: undefined },
    { activeCodexManagedAccountId: null }
  ])('fails closed when persisted selection fields are missing', (settings) => {
    expect(() => snapshotCodexLabCredentialSelectionSettings(settings)).toThrow(
      'Codex laboratory credential selection settings are unavailable.'
    )
  })
})
