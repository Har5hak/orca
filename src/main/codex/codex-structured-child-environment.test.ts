import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { buildCodexStructuredChildEnvironment } from './codex-structured-child-environment'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../shared/structured-session-marker'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../runtime/structured-worker-identity'

describe('buildCodexStructuredChildEnvironment', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps shell exports while pinned launch values win', () => {
    expect(
      buildCodexStructuredChildEnvironment(
        {
          command: 'codex',
          args: ['app-server'],
          cwd: '/worktree',
          codexHome: '/pinned/home',
          resumeThreadId: null,
          env: { EXAMPLE_GATEWAY_TOKEN: 'shell-exported', CODEX_HOME: '/shell/home' }
        },
        'spawn-token',
        'session-not-a-worker'
      )
    ).toEqual({
      EXAMPLE_GATEWAY_TOKEN: 'shell-exported',
      CODEX_HOME: '/pinned/home',
      [CODEX_SPAWN_TOKEN_ENV]: 'spawn-token',
      [ORCA_STRUCTURED_SESSION_ENV]: '1'
    })
  })

  it('adds the orchestration handle only for a registered structured worker', () => {
    const launch = {
      command: 'codex',
      args: ['app-server'],
      cwd: '/worktree',
      codexHome: null,
      resumeThreadId: null,
      env: {}
    }
    const sessionId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    expect(buildCodexStructuredChildEnvironment(launch, 'spawn-token', sessionId)).toEqual({
      [CODEX_SPAWN_TOKEN_ENV]: 'spawn-token',
      // No identity yet, so the child carries only the refuse-rather-than-guess marker.
      [ORCA_STRUCTURED_SESSION_ENV]: '1'
    })

    const handle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle,
      sessionId,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(sessionId),
      processIncarnation: structuredWorkerProcessIncarnation(sessionId),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    try {
      const env = buildCodexStructuredChildEnvironment(launch, 'spawn-token', sessionId)
      expect(env.ORCA_TERMINAL_HANDLE).toBe(handle)
      expect(env.ORCA_CLI_COMMAND).toBe('orca')
      // A pane key here would leak into hook-emitted agent statuses, which assume a PTY leaf.
      expect(env.ORCA_PANE_KEY).toBeUndefined()
    } finally {
      structuredWorkerIdentities.forget(handle)
    }
  })

  it('does not inherit ambient secrets for an exact laboratory launch', () => {
    vi.stubEnv('OPENAI_API_KEY', 'forbidden')
    vi.stubEnv('HTTP_PROXY', 'forbidden')
    const sessionId = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    const handle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle,
      sessionId,
      agent: 'codex',
      paneKey: mintStructuredWorkerPaneKey(sessionId),
      processIncarnation: structuredWorkerProcessIncarnation(sessionId),
      worktreeId: 'lab-worktree',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    try {
      const env = buildCodexStructuredChildEnvironment(
        {
          command: '/opt/codex',
          args: ['app-server'],
          cwd: '/lab/worktree',
          codexHome: '/lab/codex-home',
          resumeThreadId: null,
          env: {
            CODEX_HOME: '/lab/codex-home',
            HOME: '/lab/fake-home',
            ORCA_LAB_GATEWAY_SOCKET: '/lab/dispatch/gateway.sock',
            ORCA_LAB_GATEWAY_CREDENTIAL: 'gateway-secret'
          },
          environmentMode: 'exact',
          workerAccessMode: 'lab-gateway'
        },
        'spawn-token',
        sessionId
      )

      expect(env).toEqual({
        CODEX_HOME: '/lab/codex-home',
        HOME: '/lab/fake-home',
        [CODEX_SPAWN_TOKEN_ENV]: 'spawn-token'
      })
      expect(JSON.stringify(env)).not.toContain('gateway-secret')
      expect(env.ORCA_LAB_GATEWAY_SOCKET).toBeUndefined()
      expect(env.ORCA_LAB_GATEWAY_CREDENTIAL).toBeUndefined()
      expect(env.ORCA_TERMINAL_HANDLE).toBeUndefined()
      expect(env.ORCA_CLI_COMMAND).toBeUndefined()
      expect(env[ORCA_STRUCTURED_SESSION_ENV]).toBeUndefined()
    } finally {
      structuredWorkerIdentities.forget(handle)
    }
  })
})
