import { describe, expect, it } from 'vitest'
import {
  CODEX_LAB_LAUNCH_REFUSAL_CODE,
  assertSealedCodexLabLaunchPlan,
  buildSealedCodexLabLaunchPlan,
  type CodexLabLaunchFacts
} from './codex-sealed-launch-plan'
import { codexLabCapacityPolicy } from './codex-lab-usage-authorization'

const SHA256_A = 'a'.repeat(64)
const GATEWAY_CREDENTIAL = `lgw1_${'g'.repeat(43)}`

function facts(): CodexLabLaunchFacts {
  return {
    platform: 'darwin',
    profile: 'lab-readonly-supervised-v1',
    adapter: 'codex-workspace-chatgpt-v1',
    dispatch: {
      id: 'dispatch-757-canary-1',
      runtimeRoot: '/private/tmp/orca-lab/runtime',
      codexHomeState: 'absent',
      fakeHomeState: 'absent'
    },
    worktree: {
      identity: 'wt2:local:disposable-instance',
      expectedPath: '/private/tmp/orca-lab/disposable-worktree',
      observedPath: '/private/tmp/orca-lab/disposable-worktree',
      observedRealPath: '/private/tmp/orca-lab/disposable-worktree',
      kind: 'directory',
      disposable: true
    },
    gateway: {
      socketPath: '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-canary-1/gateway.sock',
      credential: GATEWAY_CREDENTIAL
    },
    binary: {
      path: '/Applications/ChatGPT.app/Contents/Resources/codex',
      observedRealPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      kind: 'regular-file',
      executable: true,
      pinnedSha256: SHA256_A,
      observedSha256: SHA256_A
    },
    authentication: {
      loginMethod: 'chatgpt',
      expectedWorkspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
      observedWorkspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
      subscription: {
        status: 'active',
        scope: 'workspace',
        unambiguous: true,
        planType: 'business'
      },
      capacityPolicy: codexLabCapacityPolicy({
        workspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
        planType: 'business',
        authorization: null
      }),
      authJson: { state: 'absent' }
    },
    ambientEnv: {}
  }
}

describe('sealed Codex laboratory launch plan', () => {
  it('builds a literal, isolated macOS launch without target Keychain observations', () => {
    const plan = buildSealedCodexLabLaunchPlan(facts())

    expect(plan.executable).toBe('/Applications/ChatGPT.app/Contents/Resources/codex')
    expect(plan.argv).toEqual(['--strict-config', 'app-server'])
    expect(plan.cwd).toBe('/private/tmp/orca-lab/disposable-worktree')
    expect(plan.environment).toEqual({
      ambientAllowlist: [],
      inherited: {},
      injected: {
        CODEX_HOME: '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-canary-1/codex-home',
        HOME: '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-canary-1/fake-home'
      }
    })
    expect(plan.configToml).toContain('approval_policy = "never"')
    expect(plan.configToml).toContain('allow_login_shell = false')
    expect(plan.configToml).toContain('default_permissions = "orca-lab-readonly-v1"')
    expect(plan.configToml).toContain(
      '[permissions.orca-lab-readonly-v1]\ndescription = "Orca attended disposable read-only laboratory worker"\nextends = ":read-only"'
    )
    expect(plan.configToml).not.toContain('[permissions.orca-lab-readonly-v1.filesystem')
    expect(plan.configToml).not.toContain('":workspace_roots"')
    expect(plan.configToml).not.toContain('"/private/tmp/orca-lab/disposable-worktree"')
    expect(plan.configToml).toContain('network_proxy = true')
    expect(plan.configToml).toContain(
      '[permissions.orca-lab-readonly-v1.network]\nenabled = true\nallow_local_binding = false\nallow_upstream_proxy = false\ndangerously_allow_all_unix_sockets = false'
    )
    expect(plan.configToml).toContain('include_only = []')
    expect(plan.configToml).not.toContain('ORCA_LAB_GATEWAY_')
    expect(plan.configToml).toContain(
      '[permissions.orca-lab-readonly-v1.network.domains]\n\n[permissions.orca-lab-readonly-v1.network.unix_sockets]\n"/private/tmp/orca-lab/runtime/dispatches/dispatch-757-canary-1/gateway.sock" = "allow"\n\n[mcp_servers]'
    )
    expect(plan.configToml).not.toContain('/opt/homebrew')
    expect(plan.configToml).not.toContain('sandbox_mode')
    expect(plan.configToml).not.toContain('[sandbox_workspace_write]')
    expect(plan.configToml).toContain('cli_auth_credentials_store = "ephemeral"')
    expect(plan.configToml).toContain('forced_login_method = "chatgpt"')
    expect(plan.configToml).toContain(
      'forced_chatgpt_workspace_id = "018f47a2-9d72-7cc1-b046-7a2868411f42"'
    )
    expect(plan.configToml).toContain('web_search = "disabled"')
    expect(plan.configToml).toContain('experimental_use_profile = false')
    expect(plan.configToml).toContain('persistence = "none"')
    expect(plan.configToml).toContain('[analytics]\nenabled = false')
    expect(plan.configToml).toContain('[feedback]\nenabled = false')
    expect(plan.configToml).toContain(
      '[otel]\nlog_user_prompt = false\nexporter = "none"\ntrace_exporter = "none"\nmetrics_exporter = "none"'
    )
    expect(plan.configToml).toContain('multi_agent = false')
    expect(plan.configToml).toContain('memories = false')
    expect(plan.configToml).toContain('shell_snapshot = false')
    expect(plan.configToml).toContain('code_mode = false')
    expect(plan.configToml).toContain('code_mode_host = true')
    expect(plan.configToml).toContain('goals = false')
    expect(plan.configToml).toContain('sleep_tool = false')
    expect(plan.configToml).toContain('plugins = false')
    expect(plan.configToml).toContain('secret_auth_storage = false')
    expect(plan.configToml).toContain('computer_use = false')
    expect(plan.configToml).toContain('image_generation = false')
    expect(plan.configToml).toContain('view_image = false')
    expect(plan.configToml).toContain('tool_suggest = false')
    expect(plan.configToml).toContain('auth_elicitation = false')
    expect(plan.configToml).toContain('tool_call_mcp_elicitation = false')
    expect(plan.configToml).toContain('[skills]\ninclude_instructions = false')
    expect(plan.configToml).toContain('[skills.bundled]\nenabled = false')
    expect(plan.configToml).toContain('[mcp_servers]')
    expect(plan.configToml).toContain('[hooks]')
    expect(plan.configToml).toContain('api_key_model_discovery = false')
    expect(plan.configToml.replace('api_key_model_discovery = false', '')).not.toMatch(
      /auth\.json|api[_-]?key|access[_-]?token|refresh[_-]?token/i
    )
    expect(JSON.stringify(plan.environment)).not.toMatch(
      /auth\.json|api[_-]?key|access[_-]?token|refresh[_-]?token|secret/i
    )
    expect(plan.unverifiedBoundaries).toEqual([
      'effective-config-enforcement',
      'filesystem-confinement',
      'network-confinement',
      'process-spawn',
      'provider-session'
    ])
    expect(() => assertSealedCodexLabLaunchPlan(plan)).not.toThrow()
  })

  it('returns secret-free, deterministic receipt inputs bound to observed facts', () => {
    const first = buildSealedCodexLabLaunchPlan(facts())
    const second = buildSealedCodexLabLaunchPlan(facts())

    expect(first).toEqual(second)
    expect(first.receiptInputs).toMatchObject({
      schemaVersion: 1,
      dispatchId: 'dispatch-757-canary-1',
      profile: 'lab-readonly-supervised-v1',
      adapter: 'codex-workspace-chatgpt-v1',
      platform: 'darwin',
      codexExecutableSha256: SHA256_A,
      loginMethod: 'chatgpt',
      subscriptionStatus: 'active-workspace'
    })
    expect(first.receiptInputs.gatewaySocketPathSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.receiptInputs.gatewayAccessSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.receiptInputs.configSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.receiptInputs.argvSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.receiptInputs).not.toHaveProperty('keyringBackend')
    expect(JSON.stringify(first.receiptInputs)).not.toContain(
      '018f47a2-9d72-7cc1-b046-7a2868411f42'
    )
    expect(JSON.stringify(first.receiptInputs)).not.toContain(GATEWAY_CREDENTIAL)
    expect(JSON.stringify(first.receiptInputs)).not.toMatch(/token|secret|credential/i)
    expect(JSON.stringify(first)).not.toContain(GATEWAY_CREDENTIAL)
  })

  it.each([
    ['OPENAI_API_KEY', 'sk-not-real'],
    ['ANTHROPIC_API_KEY', 'not-real'],
    ['OPENROUTER_API_KEY', 'not-real'],
    ['AWS_BEARER_TOKEN_BEDROCK', 'not-real'],
    ['HTTP_PROXY', 'http://proxy.invalid'],
    ['https_proxy', 'http://proxy.invalid']
  ])('rejects forbidden ambient provider or proxy env %s', (name, value) => {
    expect(() =>
      buildSealedCodexLabLaunchPlan({ ...facts(), ambientEnv: { [name]: value } })
    ).toThrowError(
      expect.objectContaining({
        code: CODEX_LAB_LAUNCH_REFUSAL_CODE,
        data: { reason: 'forbidden_ambient_env', field: name }
      })
    )
  })

  it('rejects ambient names even when they are not secret-bearing', () => {
    expect(() =>
      buildSealedCodexLabLaunchPlan({ ...facts(), ambientEnv: { LANG: 'en_GB.UTF-8' } })
    ).toThrowError(
      expect.objectContaining({
        code: CODEX_LAB_LAUNCH_REFUSAL_CODE,
        data: { reason: 'ambient_env_not_allowlisted', field: 'LANG' }
      })
    )
  })

  it.each([
    ['copied', { state: 'copied', sourcePath: '/Users/dev/.codex/auth.json' }],
    ['symlinked', { state: 'symlink', targetPath: '/Users/dev/.codex/auth.json' }],
    ['regular', { state: 'regular-file' }]
  ] as const)('rejects a %s auth.json', (_label, authJson) => {
    const input = facts()
    expect(() =>
      buildSealedCodexLabLaunchPlan({
        ...input,
        authentication: { ...input.authentication, authJson }
      })
    ).toThrowError(
      expect.objectContaining({
        code: CODEX_LAB_LAUNCH_REFUSAL_CODE,
        data: { reason: 'auth_json_forbidden', field: 'authentication.authJson' }
      })
    )
  })

  it.each([
    ['linux', { platform: 'linux' }],
    ['relative binary', { binary: { ...facts().binary, path: 'bin/codex' } }],
    ['unpinned binary', { binary: { ...facts().binary, observedSha256: 'b'.repeat(64) } }],
    ['invalid gateway credential', { gateway: { ...facts().gateway, credential: 'guessable' } }],
    ['API login', { authentication: { ...facts().authentication, loginMethod: 'api' } }],
    [
      'ambiguous subscription',
      {
        authentication: {
          ...facts().authentication,
          subscription: {
            status: 'active',
            scope: 'workspace',
            unambiguous: false,
            planType: 'business'
          }
        }
      }
    ],
    [
      'personal subscription',
      {
        authentication: {
          ...facts().authentication,
          subscription: {
            status: 'active',
            scope: 'personal',
            unambiguous: true,
            planType: 'business'
          }
        }
      }
    ]
  ])('fails closed for %s observations', (_label, override) => {
    expect(() => buildSealedCodexLabLaunchPlan({ ...facts(), ...override })).toThrowError(
      expect.objectContaining({ code: CODEX_LAB_LAUNCH_REFUSAL_CODE })
    )
  })

  it('rejects pre-existing per-Dispatch homes instead of reusing them', () => {
    const input = facts()
    expect(() =>
      buildSealedCodexLabLaunchPlan({
        ...input,
        dispatch: { ...input.dispatch, codexHomeState: 'present' }
      })
    ).toThrowError(
      expect.objectContaining({
        data: { reason: 'dispatch_home_not_fresh', field: 'dispatch.codexHomeState' }
      })
    )
  })

  it('rejects an alternate runtime root instead of creating an unguarded durable home', () => {
    const input = facts()
    expect(() =>
      buildSealedCodexLabLaunchPlan({
        ...input,
        dispatch: { ...input.dispatch, runtimeRoot: '/private/tmp/alternate-lab/runtime' }
      })
    ).toThrowError(
      expect.objectContaining({ data: { reason: 'dispatch_invalid', field: 'dispatch' } })
    )
  })

  it.each([
    ['approval policy', 'approval_policy = "never"', 'approval_policy = "on-request"'],
    ['permission inheritance', 'extends = ":read-only"', 'extends = ":workspace"'],
    ['network proxy bypass', 'network_proxy = true', 'network_proxy = false'],
    [
      'domain wildcard',
      '[permissions.orca-lab-readonly-v1.network.domains]\n\n',
      '[permissions.orca-lab-readonly-v1.network.domains]\n"*" = "allow"\n\n'
    ],
    [
      'Unix socket scope',
      'dangerously_allow_all_unix_sockets = false',
      'dangerously_allow_all_unix_sockets = true'
    ],
    ['multi-agent policy', 'multi_agent = false', 'multi_agent = true'],
    [
      'keyring credential persistence',
      'cli_auth_credentials_store = "ephemeral"',
      'cli_auth_credentials_store = "keyring"'
    ],
    [
      'file credential persistence',
      'cli_auth_credentials_store = "ephemeral"',
      'cli_auth_credentials_store = "file"'
    ],
    [
      'automatic credential persistence',
      'cli_auth_credentials_store = "ephemeral"',
      'cli_auth_credentials_store = "auto"'
    ]
  ])('detects a broadened %s mutation', (_label, from, to) => {
    const plan = buildSealedCodexLabLaunchPlan(facts())
    const mutated = { ...plan, configToml: plan.configToml.replace(from, to) }

    expect(() => assertSealedCodexLabLaunchPlan(mutated)).toThrowError(
      expect.objectContaining({
        code: CODEX_LAB_LAUNCH_REFUSAL_CODE,
        data: { reason: 'launch_plan_policy_broadened', field: 'configToml' }
      })
    )
  })

  it('detects injected environment and argv mutations', () => {
    const plan = buildSealedCodexLabLaunchPlan(facts())

    expect(() =>
      assertSealedCodexLabLaunchPlan({
        ...plan,
        environment: {
          ...plan.environment,
          injected: { ...plan.environment.injected, OPENAI_API_KEY: 'sk-not-real' }
        }
      })
    ).toThrowError(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'launch_plan_policy_broadened' })
      })
    )

    expect(() =>
      assertSealedCodexLabLaunchPlan({
        ...plan,
        environment: {
          ...plan.environment,
          injected: {
            ...plan.environment.injected,
            ORCA_LAB_GATEWAY_CREDENTIAL: `lgw1_${'h'.repeat(43)}`
          }
        }
      })
    ).toThrowError(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'launch_plan_policy_broadened' })
      })
    )

    expect(() =>
      assertSealedCodexLabLaunchPlan({
        ...plan,
        argv: plan.argv.filter((value) => value !== '--strict-config')
      })
    ).toThrowError(
      expect.objectContaining({
        data: expect.objectContaining({ reason: 'launch_plan_policy_broadened' })
      })
    )
  })

  it('rejects a legacy target-Keychain receipt field as a broadened launch plan', () => {
    const plan = buildSealedCodexLabLaunchPlan(facts())
    const legacyReceiptInputs = {
      ...plan.receiptInputs,
      keyringBackend: 'macos-keychain' as const
    }

    expect(() =>
      assertSealedCodexLabLaunchPlan({ ...plan, receiptInputs: legacyReceiptInputs })
    ).toThrowError(
      expect.objectContaining({
        code: CODEX_LAB_LAUNCH_REFUSAL_CODE,
        data: { reason: 'launch_plan_policy_broadened', field: 'receiptInputs' }
      })
    )
  })
})
