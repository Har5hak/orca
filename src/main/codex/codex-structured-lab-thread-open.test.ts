import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CODEX_LAB_READONLY_PERMISSION_PROFILE_ID } from './codex-structured-permission-policy'
import { openCodexThread } from './codex-structured-thread-open'

describe('structured Codex laboratory thread open', () => {
  it('starts a fresh thread with the named read-only profile and no legacy sandbox field', async () => {
    const request = vi.fn<CodexAppServerConnection['request']>(async () => ({
      thread: { id: 'thread-lab-fresh' }
    }))
    const connection: Pick<CodexAppServerConnection, 'request'> = { request }
    const cwd = '/private/tmp/orca-lab/disposable-structured'

    await openCodexThread(
      connection,
      {
        cwd,
        resumeThreadId: null,
        permissionPolicy: {
          approvalPolicy: 'never',
          permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
          runtimeWorkspaceRoots: [cwd]
        }
      },
      2_000
    )

    expect(request).toHaveBeenCalledWith(
      'thread/start',
      {
        cwd,
        approvalPolicy: 'never',
        permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
        runtimeWorkspaceRoots: [cwd]
      },
      { timeoutMs: 2_000 }
    )
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('sandbox')
  })
})
