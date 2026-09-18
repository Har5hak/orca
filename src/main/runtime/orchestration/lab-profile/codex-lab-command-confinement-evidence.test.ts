import { describe, expect, it } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../../shared/child-process/run-process'
import {
  CodexLabCommandConfinementRefusal,
  type CodexLabCommandConfinementPreflightInput,
  type CodexLabProbeIdentityCandidate
} from './codex-lab-command-confinement-contract'
import {
  confinementInput,
  expectedConfinementProbeReport,
  successfulProbeResult
} from './codex-lab-command-confinement.test-support'
import { runCodexLabCommandConfinementPreflight } from './codex-lab-command-confinement-preflight'

async function expectProbeReportRefusal(
  stdout: string,
  reason: 'probe_report_malformed' | 'probe_report_mismatch',
  input: CodexLabCommandConfinementPreflightInput = confinementInput()
): Promise<void> {
  try {
    await runCodexLabCommandConfinementPreflight(input, async (_spec: ProcessSpec) =>
      successfulProbeResult(stdout)
    )
  } catch (error) {
    expect(error).toBeInstanceOf(CodexLabCommandConfinementRefusal)
    if (error instanceof CodexLabCommandConfinementRefusal) {
      expect(error.reason).toBe(reason)
      return
    }
    throw error
  }
  throw new Error('expected command confinement evidence refusal')
}

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

describe('Codex laboratory command-confinement evidence', () => {
  it('accepts one closed report only as a blocked, unverified candidate', async () => {
    const input = confinementInput()
    const probeReport = expectedConfinementProbeReport(input)

    await expect(
      runCodexLabCommandConfinementPreflight(input, async () =>
        successfulProbeResult(`${JSON.stringify(probeReport)}\n`)
      )
    ).resolves.toEqual({
      state: 'candidate-unverified',
      readiness: 'blocked',
      controlTrust: 'caller-asserted-untrusted',
      controls: input.controls,
      probeReport,
      remainingGates: [
        'strict-config-effective-policy-proof',
        'trusted-control-collector-and-live-listener-custody',
        'trusted-packaged-probe-hash',
        'probe-identity-re-attestation',
        'verified-process-tree-termination'
      ]
    })
  })

  it.each([
    '',
    '{',
    '{"schemaVersion":1,}',
    '{/* comment */"schemaVersion":1}',
    `${JSON.stringify(expectedConfinementProbeReport())}\nprobe diagnostic`,
    `${JSON.stringify(expectedConfinementProbeReport())} false`
  ])('rejects malformed or trailing probe output %#', async (stdout) => {
    await expectProbeReportRefusal(stdout, 'probe_report_malformed')
  })

  it.each([
    JSON.stringify(expectedConfinementProbeReport()).replace(
      '{"schemaVersion":1,',
      '{"schemaVersion":1,"schemaVersion":1,'
    ),
    JSON.stringify(expectedConfinementProbeReport()).replace(
      '"probe":{"path":',
      '"probe":{"path":"duplicate","path":'
    ),
    JSON.stringify(expectedConfinementProbeReport()).replace(
      '"network":{"tcpConnect":',
      '"network":{"tcpConnect":{"host":"127.0.0.1","host":"127.0.0.1"},"discarded":'
    )
  ])('rejects duplicate JSON object fields %#', async (stdout) => {
    await expectProbeReportRefusal(stdout, 'probe_report_malformed')
  })

  it('rejects missing and unknown fields at every object boundary', async () => {
    const report = expectedConfinementProbeReport()
    const { network: _missingNetwork, ...missingRoot } = report
    const { result: _missingResult, ...missingNested } = report.writes.codexHome
    const candidates = [
      { ...report, unexpected: true },
      missingRoot,
      {
        ...report,
        probe: { ...report.probe, unexpected: true }
      },
      {
        ...report,
        writes: {
          ...report.writes,
          codexHome: missingNested
        }
      },
      {
        ...report,
        network: {
          ...report.network,
          tcpConnect: { ...report.network.tcpConnect, unexpected: true }
        }
      }
    ]

    for (const candidate of candidates) {
      await expectProbeReportRefusal(JSON.stringify(candidate), 'probe_report_mismatch')
    }
  })

  it('rejects wrong schema, paths, identities, access results, and policy classifications', async () => {
    const report = expectedConfinementProbeReport()
    const candidates = [
      { ...report, schemaVersion: 2 },
      { ...report, probe: { ...report.probe, path: '/different/probe' } },
      { ...report, probe: { ...report.probe, sha256: 'd'.repeat(64) } },
      { ...report, probe: { ...report.probe, identityTrust: 'trusted' } },
      { ...report, layout: { ...report.layout, dispatchId: 'wrong' } },
      { ...report, worktree: { ...report.worktree, identity: 'wt2:local:wrong' } },
      {
        ...report,
        worktree: {
          ...report.worktree,
          read: { ...report.worktree.read, sha256: 'd'.repeat(64) }
        }
      },
      {
        ...report,
        writes: {
          ...report.writes,
          codexHome: { ...report.writes.codexHome, target: '/wrong/codex-home-target' }
        }
      },
      {
        ...report,
        writes: {
          ...report.writes,
          fakeHome: { ...report.writes.fakeHome, result: 'succeeded' }
        }
      },
      {
        ...report,
        writes: {
          ...report.writes,
          privateTmp: { ...report.writes.privateTmp, root: '/tmp' }
        }
      },
      {
        ...report,
        network: {
          ...report.network,
          tcpConnect: { ...report.network.tcpConnect, port: 1 }
        }
      },
      {
        ...report,
        network: {
          ...report.network,
          tcpBind: { ...report.network.tcpBind, result: 'succeeded' }
        }
      },
      {
        ...report,
        network: {
          ...report.network,
          unixConnect: { ...report.network.unixConnect, path: '/wrong/connect.sock' }
        }
      },
      {
        ...report,
        network: {
          ...report.network,
          unixBind: { ...report.network.unixBind, result: 'succeeded' }
        }
      }
    ]

    for (const candidate of candidates) {
      await expectProbeReportRefusal(JSON.stringify(candidate), 'probe_report_mismatch')
    }
  })

  it.each([
    ['ENOENT', 'writes', 'codexHome'],
    ['EEXIST', 'worktree', 'write'],
    ['ECONNREFUSED', 'network', 'tcpConnect'],
    ['EADDRINUSE', 'network', 'unixBind'],
    ['EACCES', 'network', 'tcpBind']
  ])('never accepts environmental failure %s as sandbox denial', async (errno, area, field) => {
    const report = expectedConfinementProbeReport()
    const candidate = JSON.parse(JSON.stringify(report))
    candidate[area][field].errno = errno
    await expectProbeReportRefusal(JSON.stringify(candidate), 'probe_report_mismatch')
  })

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
    ) as CodexLabCommandConfinementPreflightInput['plan']
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
      { ...confinementInput().probeIdentityCandidate },
      field,
      { value, enumerable: true }
    )
    await expectRefusal(
      confinementInput({ probeIdentityCandidate: probe }),
      async () => successfulProbeResult('{}'),
      'probe_identity_candidate_invalid'
    )
  })
})

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
  const inheritedRuntimePaths = Object.assign(
    Object.create({ SUPER_SECRET_VALUE: 'inherited' }) as object,
    base.runtimePaths
  )
  const cyclicEnvironment = {
    ambientAllowlist: base.environment.ambientAllowlist,
    inherited: base.environment.inherited,
    injected: undefined as unknown
  }
  cyclicEnvironment.injected = cyclicEnvironment

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
      }) as unknown as CodexLabCommandConfinementPreflightInput['plan']
    ],
    [
      'a Map receipt',
      Object.freeze({
        ...base,
        receiptInputs: Object.freeze(new Map([['schemaVersion', 1]]))
      }) as unknown as CodexLabCommandConfinementPreflightInput['plan']
    ],
    [
      'a BigInt receipt value',
      Object.freeze({
        ...base,
        receiptInputs: Object.freeze({ ...base.receiptInputs, schemaVersion: 1n })
      }) as unknown as CodexLabCommandConfinementPreflightInput['plan']
    ],
    [
      'a null runtime-path record',
      Object.freeze({
        ...base,
        runtimePaths: null
      }) as unknown as CodexLabCommandConfinementPreflightInput['plan']
    ],
    [
      'an inherited nested record',
      Object.freeze({
        ...base,
        runtimePaths: Object.freeze(inheritedRuntimePaths)
      }) as unknown as CodexLabCommandConfinementPreflightInput['plan']
    ]
  ]
}
