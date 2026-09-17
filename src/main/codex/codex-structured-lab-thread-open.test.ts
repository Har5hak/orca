import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { CODEX_LAB_DYNAMIC_TOOL_SPECS } from './codex-lab-dynamic-tool-contract'
import { CODEX_LAB_READONLY_PERMISSION_PROFILE_ID } from './codex-structured-permission-policy'
import { openCodexThread } from './codex-structured-thread-open'

describe('structured Codex laboratory thread open', () => {
  it('starts a fresh thread with the named read-only profile and no legacy sandbox field', async () => {
    const response = {
      thread: { id: 'thread-lab-fresh' }
    }
    const request = vi.fn<CodexAppServerConnection['request']>(async () => response)
    const connection: Pick<CodexAppServerConnection, 'request'> = { request }
    const cwd = '/private/tmp/orca-lab/disposable-structured'

    const opened = await openCodexThread(
      connection,
      {
        cwd,
        resumeThreadId: null,
        permissionPolicy: {
          approvalPolicy: 'never',
          permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
          runtimeWorkspaceRoots: [cwd]
        },
        workerAccessMode: 'lab-gateway'
      },
      2_000
    )

    expect(request).toHaveBeenCalledWith(
      'thread/start',
      {
        cwd,
        approvalPolicy: 'never',
        permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
        runtimeWorkspaceRoots: [cwd],
        ephemeral: true,
        dynamicTools: CODEX_LAB_DYNAMIC_TOOL_SPECS
      },
      { timeoutMs: 2_000 }
    )
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('sandbox')
    expect(opened.labAttestation?.threadStartParams).toBe(request.mock.calls[0]?.[1])
    expect(opened.labAttestation?.openedThread).toBe(response)
  })

  it('refuses a laboratory resume before sending any app-server request', async () => {
    const request = vi.fn<CodexAppServerConnection['request']>()

    await expect(
      openCodexThread(
        { request },
        {
          cwd: '/private/tmp/orca-lab/disposable-structured',
          resumeThreadId: 'thread-existing',
          workerAccessMode: 'lab-gateway'
        },
        2_000
      )
    ).rejects.toThrow('Codex laboratory profiles are disposable and cannot resume provider threads')
    expect(request).not.toHaveBeenCalled()
  })
})
