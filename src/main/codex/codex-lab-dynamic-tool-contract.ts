import type { LabGatewayOperation } from '../runtime/orchestration/lab-profile/dispatch-gateway-policy-contract'

const TIMEOUT_SCHEMA = { type: 'integer', minimum: 1, maximum: 600_000 }

function boundedTextSchema(maxLength: number, required = false) {
  return { type: 'string', ...(required ? { minLength: 1 } : {}), maxLength }
}

function closedObjectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = []
) {
  return { type: 'object', properties, required, additionalProperties: false }
}

function freezeRecursively<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value
  }
  Object.freeze(value)
  for (const key of Reflect.ownKeys(value)) {
    freezeRecursively(Reflect.get(value, key))
  }
  return value
}

const TOOL_CONTRACTS = freezeRecursively([
  {
    name: 'orca_worker_status',
    operation: 'worker.status',
    description: 'Read the status of this bound Orca Dispatch.',
    inputSchema: closedObjectSchema({})
  },
  {
    name: 'orca_worker_check',
    operation: 'worker.check',
    description: 'Check for coordinator follow-ups without consuming unrelated messages.',
    inputSchema: closedObjectSchema({ wait: { type: 'boolean' }, timeoutMs: TIMEOUT_SCHEMA })
  },
  {
    name: 'orca_worker_heartbeat',
    operation: 'worker.heartbeat',
    description: 'Report bounded progress to the coordinator.',
    inputSchema: closedObjectSchema(
      { subject: boundedTextSchema(200, true), body: boundedTextSchema(4_000) },
      ['subject']
    )
  },
  {
    name: 'orca_worker_ask',
    operation: 'worker.ask',
    description: 'Ask the coordinator one blocking question.',
    inputSchema: closedObjectSchema(
      {
        question: boundedTextSchema(2_000, true),
        options: {
          type: 'array',
          items: boundedTextSchema(200, true),
          minItems: 1,
          maxItems: 10
        },
        timeoutMs: TIMEOUT_SCHEMA
      },
      ['question']
    )
  },
  {
    name: 'orca_worker_reply_consume',
    operation: 'worker.reply.consume',
    description: 'Resume one previously asked coordinator question.',
    inputSchema: closedObjectSchema(
      { questionId: boundedTextSchema(256, true), timeoutMs: TIMEOUT_SCHEMA },
      ['questionId']
    )
  },
  {
    name: 'orca_worker_done',
    operation: 'worker.done',
    description: 'Report this bound Orca Dispatch complete exactly once.',
    inputSchema: closedObjectSchema(
      {
        outcome: { type: 'string', enum: ['succeeded', 'failed'] },
        subject: boundedTextSchema(200, true),
        body: boundedTextSchema(8_000)
      },
      ['outcome', 'subject']
    )
  }
] as const)

export const CODEX_LAB_DYNAMIC_TOOL_BINDINGS = freezeRecursively(
  TOOL_CONTRACTS.map(({ name, operation }) => ({ name, operation }))
)

export const CODEX_LAB_DYNAMIC_TOOL_SPECS = freezeRecursively(
  TOOL_CONTRACTS.map(({ name, description, inputSchema }) => ({
    type: 'function' as const,
    name,
    description,
    inputSchema
  }))
)

export type CodexLabDynamicToolMapping =
  | Readonly<{
      ok: true
      operation: LabGatewayOperation
      params: Readonly<Record<string, unknown>>
    }>
  | Readonly<{
      ok: false
      reason: 'unknown_namespace' | 'unknown_tool' | 'invalid_arguments' | 'forbidden_argument'
      field: string
    }>

const FORBIDDEN_ARGUMENT_KEYS = new Set(
  [
    'identity identityid run runid task taskid dispatch dispatchid workerid',
    'sessionid threadid turnid callid terminal terminalid terminalhandle terminalpanekey',
    'senderpanekey from to credential credentials gatewaycredential token authtoken',
    'runtimetoken sharedtoken bearer authorization auth secret dcap dispatchcapability',
    'orchestrationcapability socket socketpath gatewaysocket unixsocket unixsocketpath',
    'endpoint endpointpath rpc rawrpc jsonrpc rpcmethod rpcparams method params operation'
  ].flatMap((group) => group.split(' '))
)

function findForbiddenArgument(
  value: unknown,
  path: string,
  visited: WeakSet<object>
): string | undefined {
  if (typeof value !== 'object' || value === null || visited.has(value)) {
    return undefined
  }
  visited.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      continue
    }
    const field = `${path}.${key}`
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
    if (FORBIDDEN_ARGUMENT_KEYS.has(normalized)) {
      return field
    }
    const nested = findForbiddenArgument(Reflect.get(value, key), field, visited)
    if (nested) {
      return nested
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key))
}

function boundedNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function optionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength)
}

function optionalTimeout(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 600_000)
  )
}

function normalizeCheck(
  args: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> | undefined {
  if (!hasOnlyKeys(args, ['wait', 'timeoutMs'])) {
    return undefined
  }
  const wait = args.wait
  const timeoutMs = args.timeoutMs
  if ((wait !== undefined && typeof wait !== 'boolean') || !optionalTimeout(timeoutMs)) {
    return undefined
  }
  return {
    ...(wait === undefined ? {} : { wait }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  }
}

function normalizeHeartbeat(
  args: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> | undefined {
  if (!hasOnlyKeys(args, ['subject', 'body'])) {
    return undefined
  }
  const subject = args.subject
  const body = args.body
  if (!boundedNonEmptyString(subject, 200) || !optionalBoundedString(body, 4_000)) {
    return undefined
  }
  return { subject, ...(body === undefined ? {} : { body }) }
}

function normalizeAsk(
  args: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> | undefined {
  if (!hasOnlyKeys(args, ['question', 'options', 'timeoutMs'])) {
    return undefined
  }
  const question = args.question
  const options = args.options
  const timeoutMs = args.timeoutMs
  if (!boundedNonEmptyString(question, 2_000) || !optionalTimeout(timeoutMs)) {
    return undefined
  }
  if (
    options !== undefined &&
    (!Array.isArray(options) ||
      options.length < 1 ||
      options.length > 10 ||
      !options.every((option) => boundedNonEmptyString(option, 200)))
  ) {
    return undefined
  }
  return {
    question,
    ...(options === undefined ? {} : { options: [...options] }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  }
}

function normalizeReplyConsume(
  args: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> | undefined {
  if (!hasOnlyKeys(args, ['questionId', 'timeoutMs'])) {
    return undefined
  }
  const questionId = args.questionId
  const timeoutMs = args.timeoutMs
  if (!boundedNonEmptyString(questionId, 256) || !optionalTimeout(timeoutMs)) {
    return undefined
  }
  return { questionId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

function normalizeDone(
  args: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> | undefined {
  if (!hasOnlyKeys(args, ['outcome', 'subject', 'body'])) {
    return undefined
  }
  const outcome = args.outcome
  const subject = args.subject
  const body = args.body
  if (
    (outcome !== 'succeeded' && outcome !== 'failed') ||
    !boundedNonEmptyString(subject, 200) ||
    !optionalBoundedString(body, 8_000)
  ) {
    return undefined
  }
  return { outcome, subject, ...(body === undefined ? {} : { body }) }
}

function normalizeArguments(
  tool: (typeof TOOL_CONTRACTS)[number]['name'],
  args: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> | undefined {
  switch (tool) {
    case 'orca_worker_status':
      return hasOnlyKeys(args, []) ? {} : undefined
    case 'orca_worker_check':
      return normalizeCheck(args)
    case 'orca_worker_heartbeat':
      return normalizeHeartbeat(args)
    case 'orca_worker_ask':
      return normalizeAsk(args)
    case 'orca_worker_reply_consume':
      return normalizeReplyConsume(args)
    case 'orca_worker_done':
      return normalizeDone(args)
  }
}

export function mapCodexLabDynamicToolCall(
  namespace: unknown,
  tool: unknown,
  args: unknown
): CodexLabDynamicToolMapping {
  if (namespace !== null) {
    return { ok: false, reason: 'unknown_namespace', field: 'namespace' }
  }
  if (typeof tool !== 'string') {
    return { ok: false, reason: 'unknown_tool', field: 'tool' }
  }
  const contract = TOOL_CONTRACTS.find((candidate) => candidate.name === tool)
  if (!contract) {
    return { ok: false, reason: 'unknown_tool', field: 'tool' }
  }
  if (!isRecord(args)) {
    return { ok: false, reason: 'invalid_arguments', field: 'arguments' }
  }
  const forbiddenField = findForbiddenArgument(args, 'arguments', new WeakSet())
  if (forbiddenField) {
    return { ok: false, reason: 'forbidden_argument', field: forbiddenField }
  }
  const params = normalizeArguments(contract.name, args)
  if (!params) {
    return { ok: false, reason: 'invalid_arguments', field: 'arguments' }
  }
  return { ok: true, operation: contract.operation, params }
}
