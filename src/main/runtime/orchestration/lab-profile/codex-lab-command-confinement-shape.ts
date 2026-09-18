import { types } from 'node:util'
import {
  CodexLabCommandConfinementRefusal,
  type CodexLabCommandConfinementRefusalReason
} from './codex-lab-command-confinement-contract'

export type CodexLabExactShape =
  | 'string'
  | 'number'
  | 'object-reference'
  | Readonly<{ kind: 'literal'; value: string | number | boolean }>
  | Readonly<{
      kind: 'record'
      fields: Readonly<Record<string, CodexLabExactShape>>
      frozen?: true
    }>
  | Readonly<{ kind: 'array'; item: CodexLabExactShape; frozen?: true }>

const S = 'string' as const
const N = 'number' as const
const O = 'object-reference' as const
const literal = (value: string | number | boolean) => ({ kind: 'literal' as const, value })
const recordShape = (fields: Readonly<Record<string, CodexLabExactShape>>, frozen = false) => ({
  kind: 'record' as const,
  fields,
  ...(frozen ? { frozen: true as const } : {})
})
const arrayShape = (item: CodexLabExactShape, frozen = false) => ({
  kind: 'array' as const,
  item,
  ...(frozen ? { frozen: true as const } : {})
})
const fields = (shape: CodexLabExactShape, keys: string): Record<string, CodexLabExactShape> =>
  Object.fromEntries(keys.split(' ').map((key) => [key, shape]))
const strings = (keys: string): Record<string, CodexLabExactShape> => fields(S, keys)
const succeeded = (keys: string): Record<string, CodexLabExactShape> =>
  fields(literal('succeeded'), keys)
const record = (
  stringKeys: string,
  nested: Record<string, CodexLabExactShape> = {},
  frozen = false
) => recordShape({ ...strings(stringKeys), ...nested }, frozen)

const IDENTITY = recordShape(strings('device inode'))
const DIRECTORY = record('path observedRealPath', {
  kind: literal('directory'),
  ownedByCurrentUser: literal(true),
  identity: IDENTITY
})
const LIVE = {
  listener: literal('confirmed-live'),
  ...strings('challengeToken challengeSha256'),
  ...succeeded('connect challengeExchange')
}
const WRITE = record('target', {
  operation: literal('exclusive-create-write-read-unlink'),
  parent: DIRECTORY,
  targetBefore: literal('absent'),
  ...succeeded('exclusiveCreate readBack'),
  payloadSha256: S,
  ...succeeded('unlink'),
  targetAfter: literal('absent')
})
const RECEIPT = recordShape(
  {
    schemaVersion: N,
    ...strings(
      'dispatchId profile adapter platform worktreeIdentity worktreePath codexExecutablePath codexExecutableSha256 keyringBackend loginMethod subscriptionStatus gatewaySocketPathSha256 gatewayAccessSha256 configSha256 argvSha256'
    )
  },
  true
)

export const CODEX_LAB_CONFINEMENT_INPUT_SHAPE = recordShape({
  plan: O,
  preparedLayout: O,
  probeIdentityCandidate: O,
  runNonce: S,
  controls: O
})
export const CODEX_LAB_CONFINEMENT_PLAN_SHAPE = record(
  'dispatchId profile adapter worktreeIdentity executable codexExecutableSha256 cwd gatewaySocketPath gatewayAccessSha256 enforcedWorkspaceId configToml',
  {
    argv: arrayShape(S, true),
    environment: recordShape(
      {
        ambientAllowlist: arrayShape(S, true),
        inherited: recordShape({}, true),
        injected: recordShape(strings('CODEX_HOME HOME'), true)
      },
      true
    ),
    runtimePaths: recordShape(strings('codexHome fakeHome'), true),
    receiptInputs: RECEIPT,
    unverifiedBoundaries: arrayShape(S)
  },
  true
)
export const CODEX_LAB_CONFINEMENT_LAYOUT_SHAPE = record(
  'dispatchId dispatchRoot codexHome fakeHome configPath configSha256',
  {
    schemaVersion: N,
    ...fields(
      IDENTITY,
      'dispatchesRootIdentity dispatchRootIdentity codexHomeIdentity fakeHomeIdentity configIdentity'
    )
  }
)
export const CODEX_LAB_CONFINEMENT_PROBE_SHAPE = record(
  'path observedRealPath expectedSha256Candidate observedSha256 device inode',
  { kind: literal('regular-file'), executable: literal(true) }
)
export const CODEX_LAB_CONFINEMENT_CONTROLS_SHAPE = recordShape({
  phase: literal('completed-before-sandbox'),
  worktreeRead: record('target observedRealPath sha256', {
    operation: literal('open-read-hash'),
    kind: literal('regular-file'),
    identity: IDENTITY,
    result: literal('succeeded')
  }),
  writes: recordShape(fields(WRITE, 'worktree codexHome fakeHome privateTmp outsideRoot')),
  network: recordShape({
    tcpConnect: recordShape({ host: literal('127.0.0.1'), port: N, ...LIVE }),
    tcpBind: recordShape({
      host: literal('127.0.0.1'),
      port: literal(0),
      ...succeeded('bind listen close')
    }),
    unixConnect: recordShape({ path: S, ...LIVE }),
    unixBind: record('path', {
      operation: literal('bind-listen-close-unlink'),
      parent: DIRECTORY,
      targetBefore: literal('absent'),
      ...succeeded('bind listen close unlink'),
      targetAfter: literal('absent')
    })
  })
})

type SnapshotArgs = Readonly<{
  candidate: unknown
  shape: CodexLabExactShape
  reason: CodexLabCommandConfinementRefusalReason
  field: string
}>

export function snapshotExactCodexLabValue<T>(args: SnapshotArgs): T {
  try {
    return snapshotNode(args, new WeakSet<object>()) as T
  } catch (error) {
    if (error instanceof CodexLabCommandConfinementRefusal) {
      throw error
    }
    throw new CodexLabCommandConfinementRefusal(args.reason, args.field)
  }
}

function snapshotNode(args: SnapshotArgs, ancestors: WeakSet<object>): unknown {
  const { candidate, shape, reason, field } = args
  if (typeof shape === 'string') {
    const valid =
      (shape === 'string' && typeof candidate === 'string') ||
      (shape === 'number' && typeof candidate === 'number' && Number.isFinite(candidate)) ||
      (shape === 'object-reference' && candidate !== null && typeof candidate === 'object')
    if (!valid) {
      throw new CodexLabCommandConfinementRefusal(reason, field)
    }
    return candidate
  }
  if (shape.kind === 'literal') {
    if (candidate !== shape.value) {
      throw new CodexLabCommandConfinementRefusal(reason, field)
    }
    return candidate
  }
  const array = shape.kind === 'array'
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    types.isProxy(candidate) ||
    Array.isArray(candidate) !== array ||
    Object.getPrototypeOf(candidate) !== (array ? Array.prototype : Object.prototype) ||
    (shape.frozen && !Object.isFrozen(candidate)) ||
    ancestors.has(candidate)
  ) {
    throw new CodexLabCommandConfinementRefusal(reason, field)
  }

  ancestors.add(candidate)
  try {
    let entries: readonly (readonly [string, CodexLabExactShape])[]
    let expectedKeys: readonly (string | symbol)[]
    if (array) {
      const length = Object.getOwnPropertyDescriptor(candidate, 'length')
      if (
        !length ||
        length.enumerable ||
        !('value' in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0
      ) {
        throw new CodexLabCommandConfinementRefusal(reason, field)
      }
      const keys = Array.from({ length: length.value as number }, (_, index) => String(index))
      entries = keys.map((key) => [key, shape.item] as const)
      expectedKeys = [...keys, 'length']
    } else {
      entries = Object.entries(shape.fields)
      expectedKeys = entries.map(([key]) => key)
    }
    const ownKeys = Reflect.ownKeys(candidate)
    if (
      ownKeys.length !== expectedKeys.length ||
      expectedKeys.some((key) => !ownKeys.includes(key))
    ) {
      throw new CodexLabCommandConfinementRefusal(reason, field)
    }

    const output: unknown[] | Record<string, unknown> = array ? [] : {}
    for (const [key, childShape] of entries) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new CodexLabCommandConfinementRefusal(reason, `${field}.${key}`)
      }
      const value = snapshotNode(
        { candidate: descriptor.value, shape: childShape, reason, field: `${field}.${key}` },
        ancestors
      )
      if (Array.isArray(output)) {
        output.push(value)
      } else {
        output[key] = value
      }
    }
    return Object.freeze(output)
  } finally {
    ancestors.delete(candidate)
  }
}
