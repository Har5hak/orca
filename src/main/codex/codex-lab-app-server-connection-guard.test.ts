import { describe, expect, it, vi } from 'vitest'
import {
  testCodexLabDynamicToolHost,
  testCodexLabDynamicToolHostAttestation
} from '../runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import {
  CODEX_LAB_ALLOWED_APP_SERVER_REQUEST_METHODS,
  guardCodexAppServerConnectionForWorkerAccess
} from './codex-lab-app-server-connection-guard'
import { CodexLabAppServerMethodRefusedError } from './codex-lab-app-server-attestation-contract'
import {
  testCodexLabAccount,
  testCodexLabEffectiveConfig,
  testCodexLabOpenedThread,
  testCodexLabPermissionProfiles
} from './codex-lab-session-attestation-test-support'
import { adapterFor, fakeCodex, identityFor } from './codex-structured-session-adapter-fixture'
import { CODEX_LAB_READONLY_PERMISSION_PROFILE_ID } from './codex-structured-permission-policy'

function connection(): CodexAppServerConnection & {
  request: ReturnType<typeof vi.fn<CodexAppServerConnection['request']>>
  notify: ReturnType<typeof vi.fn<CodexAppServerConnection['notify']>>
  respond: ReturnType<typeof vi.fn<CodexAppServerConnection['respond']>>
  respondWithError: ReturnType<typeof vi.fn<CodexAppServerConnection['respondWithError']>>
} {
  return {
    pid: 757,
    closed: false,
    request: vi.fn(async (method) => ({ method })),
    notify: vi.fn(),
    respond: vi.fn(),
    respondWithError: vi.fn(),
    close: vi.fn(async () => true)
  }
}

describe('Codex laboratory app-server connection guard', () => {
  it('admits only the request methods required by the current laboratory lifecycle', async () => {
    const upstream = connection()
    const guarded = guardCodexAppServerConnectionForWorkerAccess(upstream, 'lab-gateway')

    expect(CODEX_LAB_ALLOWED_APP_SERVER_REQUEST_METHODS).toEqual([
      'account/read',
      'config/read',
      'configRequirements/read',
      'permissionProfile/list',
      'thread/start',
      'turn/start',
      'turn/interrupt'
    ])
    for (const method of CODEX_LAB_ALLOWED_APP_SERVER_REQUEST_METHODS) {
      await expect(guarded.request(method, { proof: method }, { timeoutMs: 757 })).resolves.toEqual(
        {
          method
        }
      )
    }
    expect(upstream.request).toHaveBeenCalledTimes(
      CODEX_LAB_ALLOWED_APP_SERVER_REQUEST_METHODS.length
    )
    for (const [index, method] of CODEX_LAB_ALLOWED_APP_SERVER_REQUEST_METHODS.entries()) {
      expect(upstream.request).toHaveBeenNthCalledWith(
        index + 1,
        method,
        { proof: method },
        { timeoutMs: 757 }
      )
    }
  })

  it.each([
    'thread/shellCommand',
    'process/spawn',
    'process/writeStdin',
    'config/value/write',
    'config/batchWrite',
    'account/login/start',
    'account/logout',
    'hooks/list',
    'thread/compact/start',
    'thread/revert',
    'thread/rollback',
    'thread/archive',
    'thread/read',
    'model/list',
    'web/search',
    'future/unknown'
  ])('refuses %s before the upstream request can run', async (method) => {
    const upstream = connection()
    const guarded = guardCodexAppServerConnectionForWorkerAccess(upstream, 'lab-gateway')

    await expect(guarded.request(method, { unsafe: true })).rejects.toEqual(
      new CodexLabAppServerMethodRefusedError(method)
    )
    expect(upstream.request).not.toHaveBeenCalled()
  })

  it('refuses post-handshake notifications without writing upstream', () => {
    const upstream = connection()
    const guarded = guardCodexAppServerConnectionForWorkerAccess(upstream, 'lab-gateway')

    expect(() => guarded.notify('future/notification', { unsafe: true })).toThrow(
      new CodexLabAppServerMethodRefusedError('future/notification')
    )
    expect(upstream.notify).not.toHaveBeenCalled()
  })

  it('preserves provider-request responses, lifecycle state, and flow control', async () => {
    const upstream = connection()
    upstream.pauseReading = vi.fn()
    upstream.resumeReading = vi.fn()
    const guarded = guardCodexAppServerConnectionForWorkerAccess(upstream, 'lab-gateway')

    guarded.respond(1, { accepted: true })
    guarded.respondWithError(2, -32_603, 'refused')
    guarded.pauseReading?.()
    guarded.resumeReading?.()

    expect(guarded.pid).toBe(757)
    expect(guarded.closed).toBe(false)
    expect(upstream.respond).toHaveBeenCalledWith(1, { accepted: true })
    expect(upstream.respondWithError).toHaveBeenCalledWith(2, -32_603, 'refused')
    expect(upstream.pauseReading).toHaveBeenCalledOnce()
    expect(upstream.resumeReading).toHaveBeenCalledOnce()
    await expect(guarded.close()).resolves.toBe(true)
    expect(upstream.close).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'orca-cli' as const])(
    'leaves ordinary worker access %s on the original connection',
    (workerAccessMode) => {
      const upstream = connection()

      expect(guardCodexAppServerConnectionForWorkerAccess(upstream, workerAccessMode)).toBe(
        upstream
      )
    }
  )

  it('guards the connection published by a real lab acquisition', async () => {
    const expected = Object.freeze({
      cwd: '/private/tmp/orca-lab/worktrees/guard',
      codexHome: '/private/tmp/orca-lab/runtime/dispatches/guard/codex-home',
      fakeHome: '/private/tmp/orca-lab/runtime/dispatches/guard/fake-home',
      workspaceId: '00000000-0000-4000-8000-000000000757',
      permissionProfileId: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID
    })
    const codex = fakeCodex({
      'thread/start': () => testCodexLabOpenedThread(expected, false, 'thread-abc'),
      'account/read': () => testCodexLabAccount(expected),
      'config/read': () => ({
        config: testCodexLabEffectiveConfig(expected),
        origins: {},
        layers: []
      }),
      'configRequirements/read': () => ({ requirements: null }),
      'permissionProfile/list': () => testCodexLabPermissionProfiles(expected)
    })
    const adapter = adapterFor(codex, {
      cwd: expected.cwd,
      codexHome: expected.codexHome,
      env: { CODEX_HOME: expected.codexHome, HOME: expected.fakeHome },
      environmentMode: 'exact',
      workerAccessMode: 'lab-gateway',
      labDynamicToolHost: testCodexLabDynamicToolHost(),
      labDynamicToolHostAttestationExpected: testCodexLabDynamicToolHostAttestation(),
      labAppServerAttestationExpected: expected,
      permissionPolicy: {
        approvalPolicy: 'never',
        permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
        runtimeWorkspaceRoots: [expected.cwd]
      }
    })
    await adapter.acquire({
      identity: identityFor('session-lab-guard'),
      fence: 7,
      spawnToken: 'spawn-lab-guard'
    })

    await expect(
      adapter.compact({ sessionId: 'session-lab-guard', fence: 7, turnId: 'turn-lab-guard' })
    ).rejects.toEqual(new CodexLabAppServerMethodRefusedError('thread/compact/start'))
    expect(codex.connections[0].calls.map(({ method }) => method)).toEqual([
      'thread/start',
      'account/read',
      'config/read',
      'configRequirements/read',
      'permissionProfile/list'
    ])
    await expect(adapter.closeSession('session-lab-guard')).resolves.toBe(true)
  })
})
