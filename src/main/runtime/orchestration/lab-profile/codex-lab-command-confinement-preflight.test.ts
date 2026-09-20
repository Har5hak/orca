import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  resolveSpawn,
  type ProcessResult,
  type ProcessSpec
} from '../../../../shared/child-process/run-process'
import {
  CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
  CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS,
  CodexLabCommandConfinementRefusal,
  type CodexLabCommandConfinementControlEvidence,
  type CodexLabCommandConfinementRefusalReason,
  type CodexLabCommandConfinementPreflightInput,
  type CodexLabProbeIdentityCandidate
} from './codex-lab-command-confinement-contract'
import {
  CONFINEMENT_RUN_NONCE,
  CONFINEMENT_TCP_CONNECT_PORT,
  confinementControls,
  confinementInput,
  confinementProbeCandidate,
  expectedConfinementProbeReport,
  preparedConfinementLayout,
  successfulProbeResult
} from './codex-lab-command-confinement.test-support'
import { accessorCases } from './codex-lab-command-confinement-adversarial-input.test-support'
import { withHostCompatibilityInput } from './codex-lab-command-confinement-host.test-support'
import {
  buildCodexLabCommandConfinementTargets,
  runCodexLabCommandConfinementPreflight
} from './codex-lab-command-confinement-preflight'
import {
  captureSuccessfulConfinementRun,
  UNSUCCESSFUL_CONFINEMENT_PROCESS_RESULTS
} from './codex-lab-command-confinement-preflight.test-support'
import { SUPPORTED_CODEX_LAB_RELEASE } from './codex-lab-supported-binary'

async function expectRefusal(
  input: CodexLabCommandConfinementPreflightInput,
  execute: (spec: ProcessSpec) => Promise<ProcessResult>,
  reason: CodexLabCommandConfinementRefusal['reason']
): Promise<CodexLabCommandConfinementRefusal> {
  try {
    await runCodexLabCommandConfinementPreflight(input, execute)
  } catch (error) {
    expect(error).toBeInstanceOf(CodexLabCommandConfinementRefusal)
    if (error instanceof CodexLabCommandConfinementRefusal) {
      expect(error.reason).toBe(reason)
      return error
    }
    throw error
  }
  throw new Error('expected command confinement refusal')
}

describe('Codex laboratory command-confinement preflight', () => {
  it('runs the candidate probe through the exact no-shell sandbox command', async () => {
    const input = confinementInput()
    const { spec, result } = await captureSuccessfulConfinementRun(input)
    const basename = `.orca-command-confinement-dispatch-757-host-1-${CONFINEMENT_RUN_NONCE}`
    const targets = buildCodexLabCommandConfinementTargets(
      input.plan.dispatchId,
      CONFINEMENT_RUN_NONCE,
      input.plan.cwd,
      input.plan.runtimePaths,
      input.controls.writes.outsideRoot.parent.path
    )

    expect(spec).toEqual({
      program: input.plan.executable,
      args: [
        'sandbox',
        '--include-managed-config',
        '-P',
        'orca-lab-readonly-v1',
        '-C',
        input.plan.cwd,
        '--',
        input.probeIdentityCandidate.path,
        '--schema-version',
        '1',
        '--run-nonce',
        CONFINEMENT_RUN_NONCE,
        '--probe-path',
        input.probeIdentityCandidate.path,
        '--worktree-identity',
        input.plan.worktreeIdentity,
        '--worktree-path',
        input.plan.cwd,
        '--worktree-read-target',
        input.controls.worktreeRead.target,
        '--worktree-read-sha256',
        input.controls.worktreeRead.sha256,
        '--worktree-write-target',
        `${input.plan.cwd}/${basename}.write`,
        '--write-payload',
        CONFINEMENT_RUN_NONCE,
        '--dispatch-root',
        input.preparedLayout.dispatchRoot,
        '--config-path',
        input.preparedLayout.configPath,
        '--config-sha256',
        input.preparedLayout.configSha256,
        '--codex-home',
        input.plan.runtimePaths.codexHome,
        '--codex-home-write-target',
        `${input.plan.runtimePaths.codexHome}/${basename}.write`,
        '--fake-home',
        input.plan.runtimePaths.fakeHome,
        '--fake-home-write-target',
        `${input.plan.runtimePaths.fakeHome}/${basename}.write`,
        '--private-tmp-write-target',
        `/private/tmp/${basename}.write`,
        '--outside-root-write-target',
        input.controls.writes.outsideRoot.target,
        '--tcp-connect-host',
        '127.0.0.1',
        '--tcp-connect-port',
        String(CONFINEMENT_TCP_CONNECT_PORT),
        '--tcp-connect-challenge',
        input.controls.network.tcpConnect.challengeToken,
        '--tcp-bind-host',
        '127.0.0.1',
        '--tcp-bind-port',
        '0',
        '--unix-connect-path',
        input.plan.gatewaySocketPath,
        '--unix-connect-challenge',
        input.controls.network.unixConnect.challengeToken,
        '--unix-connect-denied-path',
        targets.unixConnectDenied,
        '--unix-connect-denied-challenge',
        input.controls.network.unixConnectDenied.challengeToken,
        '--unix-bind-path',
        targets.unixBind
      ],
      cwd: input.plan.cwd,
      env: {
        CODEX_HOME: input.plan.runtimePaths.codexHome,
        HOME: input.plan.runtimePaths.fakeHome
      },
      timeoutMs: CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS,
      maxOutputBytes: CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
      terminationBarrier: true
    })
    expect('shell' in spec).toBe(false)
    expect(resolveSpawn(spec, 'darwin').options.shell).toBe(false)
    expect(spec.args).not.toContain('--strict-config')
    expect(input.plan.argv).toEqual(['--strict-config', 'app-server'])
    expect(result).toEqual({
      state: 'candidate-unverified',
      readiness: 'blocked',
      controlTrust: 'caller-asserted-untrusted',
      controls: input.controls,
      probeReport: expectedConfinementProbeReport(input),
      remainingGates: [
        'strict-config-effective-policy-proof',
        'trusted-control-collector-and-live-listener-custody',
        'trusted-packaged-probe-hash',
        'probe-identity-re-attestation',
        'verified-process-tree-termination'
      ]
    })
  })

  it('passes only sealed homes and excludes provider, model, and credential material', async () => {
    const input = confinementInput()
    const { spec, result } = await captureSuccessfulConfinementRun(input)
    const serialized = JSON.stringify({ spec, result })

    expect(Object.keys(spec.env ?? {}).sort()).toEqual(['CODEX_HOME', 'HOME'])
    expect(serialized).not.toContain(input.plan.enforcedWorkspaceId)
    expect(serialized).not.toContain(input.plan.gatewayAccessSha256)
    expect(serialized).toContain(input.plan.receiptInputs.configSha256)
    expect(serialized).not.toContain('app-server')
    expect(serialized).not.toContain('--model')
    expect(serialized).not.toContain('providerSession')
    expect(result.readiness).toBe('blocked')
  })

  it.runIf(process.env.ORCA_RUN_CODEX_CONFINEMENT_EXACT_HOST_SPEC === '1')(
    'executes the exact generated ProcessSpec host-side without launching a provider',
    async () => {
      const binary = process.env.ORCA_CODEX_COMPATIBILITY_BINARY
      if (!binary) {
        throw new Error('ORCA_CODEX_COMPATIBILITY_BINARY is required for the host-only probe')
      }
      const binaryPath = realpathSync(binary)
      await withHostCompatibilityInput(binaryPath, async ({ input }) => {
        const { spec } = await captureSuccessfulConfinementRun(input)
        const args = spec.args
        if (!args) {
          throw new Error('confinement process args disappeared')
        }
        const timeout = spec.timeoutMs
        const maxBuffer = spec.maxOutputBytes
        if (typeof timeout !== 'number' || typeof maxBuffer !== 'number') {
          throw new Error('confinement process bounds disappeared')
        }
        const version = spawnSync(binaryPath, ['--version'], { encoding: 'utf8' })
        const execution = spawnSync(spec.program, args, {
          cwd: spec.cwd,
          env: spec.env,
          timeout,
          maxBuffer,
          encoding: 'utf8'
        })

        expect(version.status).toBe(0)
        expect(version.stdout.trim()).toBe(`codex-cli ${SUPPORTED_CODEX_LAB_RELEASE.version}`)
        expect(spec.program).toBe(binaryPath)
        expect(execution.error).toBeUndefined()
        expect(execution.signal).toBeNull()
        expect(execution.status).toBe(0)
        expect(execution.stderr).not.toContain('`--strict-config` is not supported')
      })
    }
  )

  it('refuses a mutable or otherwise unsealed launch plan before execution', async () => {
    const input = confinementInput()
    let called = false
    await expectRefusal(
      { ...input, plan: { ...input.plan } },
      async () => {
        called = true
        return successfulProbeResult('{}')
      },
      'plan_invalid'
    )
    expect(called).toBe(false)
  })

  it('rejects a frozen plan argv accessor without invoking it or the executor', async () => {
    const input = confinementInput()
    let getterReads = 0
    const plan = Object.freeze(
      Object.defineProperty({ ...input.plan }, 'argv', {
        enumerable: true,
        get: () => {
          getterReads += 1
          throw new Error('SUPER_SECRET_VALUE')
        }
      })
    )
    let called = false
    const refusal = await expectRefusal(
      { ...confinementInput(), plan },
      async () => {
        called = true
        return successfulProbeResult('{}')
      },
      'plan_invalid'
    )

    expect(getterReads).toBe(0)
    expect(called).toBe(false)
    expect(refusal.message).not.toContain('SUPER_SECRET_VALUE')
  })

  it('rejects a Proxy plan before invoking any proxy trap or the executor', async () => {
    const target = confinementInput().plan
    let trapCalls = 0
    const trapped = () => {
      trapCalls += 1
      throw new Error('SUPER_SECRET_VALUE')
    }
    const plan = new Proxy(target, {
      get: trapped,
      getOwnPropertyDescriptor: trapped,
      getPrototypeOf: trapped,
      isExtensible: trapped,
      ownKeys: trapped
    })
    let called = false
    const refusal = await expectRefusal(
      { ...confinementInput(), plan },
      async () => {
        called = true
        return successfulProbeResult('{}')
      },
      'plan_invalid'
    )

    expect(trapCalls).toBe(0)
    expect(called).toBe(false)
    expect(refusal.message).not.toContain('SUPER_SECRET_VALUE')
  })

  it.each(malformedPlanGraphCases())(
    'rejects malformed frozen plan graph: %s',
    async (_label, plan) => {
      let called = false
      await expectRefusal(
        { ...confinementInput(), plan },
        async () => {
          called = true
          return successfulProbeResult('{}')
        },
        'plan_invalid'
      )
      expect(called).toBe(false)
    }
  )

  it.each([
    ['path', 'relative/probe'],
    ['observedRealPath', '/Applications/Orca.app/Contents/Helpers/replaced-probe'],
    ['kind', 'symlink'],
    ['executable', false],
    ['expectedSha256Candidate', 'not-a-sha'],
    ['observedSha256', 'c'.repeat(64)],
    ['device', '0'],
    ['inode', 'not-an-inode']
  ])('refuses invalid candidate probe identity field %s', async (field, value) => {
    const probe: CodexLabProbeIdentityCandidate = Object.defineProperty(
      { ...confinementProbeCandidate() },
      field,
      { value, enumerable: true }
    )
    await expectRefusal(
      confinementInput({ probeIdentityCandidate: probe }),
      async () => successfulProbeResult('{}'),
      'probe_identity_candidate_invalid'
    )
  })

  it.each(['short', 'A'.repeat(32), '7'.repeat(31), '7'.repeat(33)])(
    'refuses invalid per-run nonce %s',
    async (runNonce) => {
      await expectRefusal(
        confinementInput({ runNonce }),
        async () => successfulProbeResult('{}'),
        'target_invalid'
      )
    }
  )

  it('refuses control targets replayed under a different valid run nonce', async () => {
    await expectControlRefusal(confinementControls(), '6'.repeat(32))
  })

  it.each([
    ['dispatchId', 'wrong-dispatch'],
    ['codexHome', '/private/tmp/wrong-codex-home'],
    ['configSha256', 'd'.repeat(64)]
  ])('refuses prepared-layout mismatch %s before execution', async (field, value) => {
    const prepared = Object.defineProperty({ ...preparedConfinementLayout() }, field, {
      value,
      enumerable: true
    })
    let called = false
    await expectRefusal(
      confinementInput({ preparedLayout: prepared }),
      async () => {
        called = true
        return successfulProbeResult('{}')
      },
      'layout_invalid'
    )
    expect(called).toBe(false)
  })

  it('refuses invalid prepared-layout identities before execution', async () => {
    const prepared = preparedConfinementLayout()
    await expectRefusal(
      confinementInput({
        preparedLayout: {
          ...prepared,
          codexHomeIdentity: { ...prepared.codexHomeIdentity, inode: '0' }
        }
      }),
      async () => successfulProbeResult('{}'),
      'layout_invalid'
    )
  })

  it.each([
    ['targetBefore', 'present'],
    ['exclusiveCreate', 'failed'],
    ['readBack', 'failed'],
    ['unlink', 'failed'],
    ['targetAfter', 'present'],
    ['payloadSha256', 'd'.repeat(64)],
    ['target', '/private/tmp/wrong-target']
  ])('refuses incomplete or wrong same-target write control %s', async (field, value) => {
    const controls = confinementControls()
    const worktree = Object.defineProperty({ ...controls.writes.worktree }, field, {
      value,
      enumerable: true
    })
    await expectControlRefusal({
      ...controls,
      writes: { ...controls.writes, worktree }
    })
  })

  it.each([
    ['observedRealPath', '/different/parent'],
    ['kind', 'file'],
    ['custody', 'caller-asserted'],
    ['identity', { device: '16777234', inode: '999' }]
  ])('refuses unverified write parent field %s', async (field, value) => {
    const controls = confinementControls()
    const parent = Object.defineProperty({ ...controls.writes.codexHome.parent }, field, {
      value,
      enumerable: true
    })
    await expectControlRefusal({
      ...controls,
      writes: {
        ...controls.writes,
        codexHome: { ...controls.writes.codexHome, parent }
      }
    })
  })

  it('refuses an outside-root sentinel under private tmp', async () => {
    const controls = confinementControls()
    await expectRefusal(
      confinementInput({
        controls: {
          ...controls,
          writes: { ...controls.writes, outsideRoot: controls.writes.privateTmp }
        }
      }),
      async () => successfulProbeResult('{}'),
      'target_invalid'
    )
  })

  it.each([
    ['observedRealPath', '/different/read-target'],
    ['kind', 'directory'],
    ['sha256', 'not-a-sha'],
    ['result', 'failed']
  ])('refuses invalid same-target read control %s', async (field, value) => {
    const controls = confinementControls()
    const worktreeRead = Object.defineProperty({ ...controls.worktreeRead }, field, {
      value,
      enumerable: true
    })
    await expectControlRefusal({ ...controls, worktreeRead })
  })

  it.each([
    ['listener', 'unconfirmed'],
    ['connect', 'failed'],
    ['challengeExchange', 'failed'],
    ['challengeSha256', 'd'.repeat(64)],
    ['port', 0]
  ])('refuses non-live TCP control field %s', async (field, value) => {
    const controls = confinementControls()
    const tcpConnect = Object.defineProperty({ ...controls.network.tcpConnect }, field, {
      value,
      enumerable: true
    })
    await expectControlRefusal({
      ...controls,
      network: { ...controls.network, tcpConnect }
    })
  })

  it('refuses a failed unsandboxed TCP bind control', async () => {
    const controls = confinementControls()
    await expectControlRefusal({
      ...controls,
      network: {
        ...controls.network,
        tcpBind: Object.defineProperty({ ...controls.network.tcpBind }, 'bind', {
          value: 'failed',
          enumerable: true
        })
      }
    })
  })

  it('refuses a failed unsandboxed Unix challenge exchange', async () => {
    const controls = confinementControls()
    await expectControlRefusal({
      ...controls,
      network: {
        ...controls.network,
        unixConnect: Object.defineProperty(
          { ...controls.network.unixConnect },
          'challengeExchange',
          { value: 'failed', enumerable: true }
        )
      }
    })
  })

  it('refuses an unconfirmed Unix listener', async () => {
    const controls = confinementControls()
    await expectControlRefusal({
      ...controls,
      network: {
        ...controls.network,
        unixConnect: Object.defineProperty({ ...controls.network.unixConnect }, 'listener', {
          value: 'unconfirmed',
          enumerable: true
        })
      }
    })
  })

  it('refuses a collided or failed unsandboxed Unix bind control', async () => {
    const controls = confinementControls()
    await expectControlRefusal({
      ...controls,
      network: {
        ...controls.network,
        unixBind: Object.defineProperty({ ...controls.network.unixBind }, 'targetBefore', {
          value: 'present',
          enumerable: true
        })
      }
    })
  })

  it.each(malformedPlainDataCases())(
    'refuses %s before execution without reflecting caller data',
    async (_label, input, reason) => {
      let called = false
      const refusal = await expectRefusal(
        input,
        async () => {
          called = true
          return successfulProbeResult('{}')
        },
        reason
      )

      expect(called).toBe(false)
      expect(JSON.stringify(refusal)).not.toContain('SUPER_SECRET_VALUE')
      expect(refusal.message).not.toContain('SUPER_SECRET_VALUE')
    }
  )

  it('never invokes input, layout, probe, or control accessors while refusing them', async () => {
    const cases = accessorCases()
    for (const { input, reason, reads } of cases) {
      const refusal = await expectRefusal(input, async () => successfulProbeResult('{}'), reason)
      expect(reads()).toBe(0)
      expect(refusal.message).not.toContain('SUPER_SECRET_VALUE')
    }
  })

  it('returns only a detached, frozen canonical reconstruction of accepted claims', async () => {
    const input = confinementInput()
    const report = expectedConfinementProbeReport(input)
    const before = JSON.parse(JSON.stringify(input.controls))
    const result = await runCodexLabCommandConfinementPreflight(input, async () => {
      Object.defineProperty(input.controls, 'SUPER_SECRET_VALUE', {
        value: 'must-not-escape',
        enumerable: true
      })
      Object.defineProperty(input.controls.worktreeRead, 'sha256', {
        value: 'd'.repeat(64),
        enumerable: true
      })
      return successfulProbeResult(JSON.stringify(report))
    })

    expect(result.controls).toEqual(before)
    expect(result.controls).not.toBe(input.controls)
    expect(result.controls.worktreeRead).not.toBe(input.controls.worktreeRead)
    expect(Object.isFrozen(result.controls)).toBe(true)
    expect(Object.isFrozen(result.controls.network.tcpConnect)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('SUPER_SECRET_VALUE')
    expect(result.readiness).toBe('blocked')
  })

  it('redacts executor failure details', async () => {
    const refusal = await expectRefusal(
      confinementInput(),
      async () => {
        throw new Error('executor leaked SUPER_SECRET_VALUE')
      },
      'execution_failed'
    )
    expect(refusal.message).not.toContain('SUPER_SECRET_VALUE')
  })

  it.each(UNSUCCESSFUL_CONFINEMENT_PROCESS_RESULTS)(
    'fails closed for an unsuccessful process result %#',
    async (override, reason) => {
      const input = confinementInput()
      await expectRefusal(
        input,
        async () => ({
          ...successfulProbeResult(JSON.stringify(expectedConfinementProbeReport(input))),
          ...override
        }),
        reason
      )
    }
  )

  it('rejects output beyond the local bound even when an executor omits its truncation flag', async () => {
    await expectRefusal(
      confinementInput(),
      async () =>
        successfulProbeResult('x'.repeat(CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES + 1)),
      'output_truncated'
    )
  })
})

async function expectControlRefusal(
  controls: CodexLabCommandConfinementControlEvidence,
  runNonce?: string
): Promise<void> {
  let called = false
  await expectRefusal(
    confinementInput({ controls, ...(runNonce ? { runNonce } : {}) }),
    async () => {
      called = true
      return successfulProbeResult('{}')
    },
    'control_evidence_invalid'
  )
  expect(called).toBe(false)
}

type MalformedPlanGraphCase = readonly [string, CodexLabCommandConfinementPreflightInput['plan']]

function malformedPlanGraphCases(): readonly MalformedPlanGraphCase[] {
  const base = confinementInput().plan
  const symbolicArgv = [...base.argv]
  Object.defineProperty(symbolicArgv, Symbol('SUPER_SECRET_VALUE'), {
    value: 'symbol',
    enumerable: true
  })
  const nonEnumerableReceipt = { ...base.receiptInputs }
  Object.defineProperty(nonEnumerableReceipt, 'configSha256', {
    value: base.receiptInputs.configSha256,
    enumerable: false
  })
  const inheritedRuntimePaths = Object.setPrototypeOf(
    { ...base.runtimePaths },
    { SUPER_SECRET_VALUE: 'inherited' }
  )
  const cyclicEnvironment = { ...base.environment }
  Object.defineProperty(cyclicEnvironment, 'injected', {
    value: cyclicEnvironment,
    enumerable: true
  })

  return [
    ['a symbolic argv property', Object.freeze({ ...base, argv: Object.freeze(symbolicArgv) })],
    [
      'a non-enumerable receipt property',
      Object.freeze({ ...base, receiptInputs: Object.freeze(nonEnumerableReceipt) })
    ],
    [
      'an extra nested secret-like property',
      Object.freeze({
        ...base,
        runtimePaths: Object.freeze({ ...base.runtimePaths, SUPER_SECRET_VALUE: 'extra' })
      })
    ],
    [
      'a cyclic environment',
      Object.freeze({
        ...base,
        environment: Object.freeze(cyclicEnvironment)
      })
    ],
    [
      'a Map receipt',
      Object.freeze(
        Object.defineProperty({ ...base }, 'receiptInputs', {
          value: Object.freeze(new Map([['schemaVersion', 1]])),
          enumerable: true
        })
      )
    ],
    [
      'a BigInt receipt value',
      Object.freeze({
        ...base,
        receiptInputs: Object.freeze(
          Object.defineProperty({ ...base.receiptInputs }, 'schemaVersion', {
            value: 1n,
            enumerable: true
          })
        )
      })
    ],
    [
      'a null runtime-path record',
      Object.freeze(
        Object.defineProperty({ ...base }, 'runtimePaths', {
          value: null,
          enumerable: true
        })
      )
    ],
    [
      'an inherited nested record',
      Object.freeze({
        ...base,
        runtimePaths: Object.freeze(inheritedRuntimePaths)
      })
    ]
  ]
}

type MalformedPlainDataCase = readonly [
  string,
  CodexLabCommandConfinementPreflightInput,
  CodexLabCommandConfinementRefusalReason
]

function malformedPlainDataCases(): readonly MalformedPlainDataCase[] {
  const inheritedLayout = Object.setPrototypeOf(
    { ...preparedConfinementLayout() },
    { SUPER_SECRET_VALUE: 'inherited' }
  )
  const symbolProbe = { ...confinementProbeCandidate() }
  Object.defineProperty(symbolProbe, Symbol('SUPER_SECRET_VALUE'), {
    value: 'symbol',
    enumerable: true
  })
  const nonEnumerableLayout = { ...preparedConfinementLayout() }
  Object.defineProperty(nonEnumerableLayout, 'configSha256', {
    value: nonEnumerableLayout.configSha256,
    enumerable: false
  })
  const extraControls = {
    ...confinementControls(),
    SUPER_SECRET_VALUE: 'extra'
  }
  const cyclicControls = { ...confinementControls() }
  Object.defineProperty(cyclicControls, 'writes', {
    value: cyclicControls,
    enumerable: true
  })
  const mapLayout = Object.defineProperty({ ...preparedConfinementLayout() }, 'codexHomeIdentity', {
    value: new Map([['inode', '103']]),
    enumerable: true
  })
  const bigintProbe = Object.defineProperty({ ...confinementProbeCandidate() }, 'inode', {
    value: 1n,
    enumerable: true
  })
  const controlsWithNull = confinementControls()
  const nullNetwork = Object.defineProperty({ ...controlsWithNull }, 'network', {
    value: null,
    enumerable: true
  })
  const controlsWithNullPrototype = confinementControls()
  const nullPrototypeRead = Object.setPrototypeOf(
    { ...controlsWithNullPrototype.worktreeRead },
    null
  )
  const inheritedParentControls = confinementControls()
  const inheritedParent = Object.setPrototypeOf(
    { ...inheritedParentControls.writes.codexHome.parent },
    { SUPER_SECRET_VALUE: 'nested-inherited' }
  )
  const proxyControls = new Proxy(confinementControls(), {})

  return [
    [
      'an inherited prepared layout',
      confinementInput({ preparedLayout: inheritedLayout }),
      'layout_invalid'
    ],
    [
      'a symbolic probe property',
      confinementInput({ probeIdentityCandidate: symbolProbe }),
      'probe_identity_candidate_invalid'
    ],
    [
      'a non-enumerable expected layout property',
      confinementInput({ preparedLayout: nonEnumerableLayout }),
      'layout_invalid'
    ],
    [
      'an extra secret-like control property',
      confinementInput({ controls: extraControls }),
      'control_evidence_invalid'
    ],
    [
      'cyclic control claims',
      confinementInput({ controls: cyclicControls }),
      'control_evidence_invalid'
    ],
    [
      'a Map nested in the prepared layout',
      confinementInput({ preparedLayout: mapLayout }),
      'layout_invalid'
    ],
    [
      'a BigInt nested in the probe candidate',
      confinementInput({ probeIdentityCandidate: bigintProbe }),
      'probe_identity_candidate_invalid'
    ],
    [
      'null nested control claims',
      confinementInput({ controls: nullNetwork }),
      'control_evidence_invalid'
    ],
    [
      'a null-prototype nested control record',
      confinementInput({
        controls: {
          ...controlsWithNullPrototype,
          worktreeRead: nullPrototypeRead
        }
      }),
      'control_evidence_invalid'
    ],
    [
      'an inherited nested control directory',
      confinementInput({
        controls: {
          ...inheritedParentControls,
          writes: {
            ...inheritedParentControls.writes,
            codexHome: {
              ...inheritedParentControls.writes.codexHome,
              parent: inheritedParent
            }
          }
        }
      }),
      'control_evidence_invalid'
    ],
    [
      'proxy-wrapped control claims',
      confinementInput({ controls: proxyControls }),
      'control_evidence_invalid'
    ]
  ]
}
