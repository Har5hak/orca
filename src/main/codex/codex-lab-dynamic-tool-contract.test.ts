import { describe, expect, it } from 'vitest'
import { LAB_GATEWAY_ALLOWED_OPERATIONS } from '../runtime/orchestration/lab-profile/dispatch-gateway-policy-contract'
import {
  CODEX_LAB_DYNAMIC_TOOL_BINDINGS,
  CODEX_LAB_DYNAMIC_TOOL_SPECS,
  mapCodexLabDynamicToolCall
} from './codex-lab-dynamic-tool-contract'

const EXPECTED_SPECS = [
  {
    type: 'function',
    name: 'orca_worker_status',
    description: 'Read the status of this bound Orca Dispatch.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'orca_worker_check',
    description: 'Check for coordinator follow-ups without consuming unrelated messages.',
    inputSchema: {
      type: 'object',
      properties: {
        wait: { type: 'boolean' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600_000 }
      },
      required: [],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'orca_worker_heartbeat',
    description: 'Report bounded progress to the coordinator.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', maxLength: 4_000 }
      },
      required: ['subject'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'orca_worker_ask',
    description: 'Ask the coordinator one blocking question.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 2_000 },
        options: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 200 },
          minItems: 1,
          maxItems: 10
        },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600_000 }
      },
      required: ['question'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'orca_worker_reply_consume',
    description: 'Resume one previously asked coordinator question.',
    inputSchema: {
      type: 'object',
      properties: {
        questionId: { type: 'string', minLength: 1, maxLength: 256 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 600_000 }
      },
      required: ['questionId'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: 'orca_worker_done',
    description: 'Report this bound Orca Dispatch complete exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['succeeded', 'failed'] },
        subject: { type: 'string', minLength: 1, maxLength: 200 },
        body: { type: 'string', maxLength: 8_000 }
      },
      required: ['outcome', 'subject'],
      additionalProperties: false
    }
  }
]

function accept(namespace: unknown, tool: unknown, args: unknown) {
  const result = mapCodexLabDynamicToolCall(namespace, tool, args)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(`Expected ${String(tool)} to be accepted: ${result.reason}`)
  }
  return result
}

function refuse(namespace: unknown, tool: unknown, args: unknown) {
  const result = mapCodexLabDynamicToolCall(namespace, tool, args)
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error(`Expected ${String(tool)} to be refused`)
  }
  return result
}

describe('TASK-757 Codex laboratory dynamic-tool contract', () => {
  it('publishes exactly six closed function schemas mapped one-to-one to gateway operations', () => {
    expect(CODEX_LAB_DYNAMIC_TOOL_SPECS).toEqual(EXPECTED_SPECS)
    expect(CODEX_LAB_DYNAMIC_TOOL_BINDINGS).toEqual([
      { name: 'orca_worker_status', operation: 'worker.status' },
      { name: 'orca_worker_check', operation: 'worker.check' },
      { name: 'orca_worker_heartbeat', operation: 'worker.heartbeat' },
      { name: 'orca_worker_ask', operation: 'worker.ask' },
      { name: 'orca_worker_reply_consume', operation: 'worker.reply.consume' },
      { name: 'orca_worker_done', operation: 'worker.done' }
    ])
    expect(CODEX_LAB_DYNAMIC_TOOL_BINDINGS.map(({ operation }) => operation)).toEqual(
      LAB_GATEWAY_ALLOWED_OPERATIONS
    )
    for (const spec of CODEX_LAB_DYNAMIC_TOOL_SPECS) {
      expect(spec.type).toBe('function')
      expect(spec.inputSchema.additionalProperties).toBe(false)
      expect(JSON.stringify(spec.inputSchema)).not.toMatch(
        /runId|taskId|dispatchId|terminal|credential|socket|rawRpc|jsonRpc/iu
      )
    }
  })

  it('maps every valid call to its one bound gateway operation and sanitized parameters', () => {
    expect(accept(null, 'orca_worker_status', {})).toMatchObject({
      operation: 'worker.status',
      params: {}
    })
    expect(accept(null, 'orca_worker_check', { wait: true, timeoutMs: 1_500 })).toMatchObject({
      operation: 'worker.check',
      params: { wait: true, timeoutMs: 1_500 }
    })
    expect(
      accept(null, 'orca_worker_heartbeat', { subject: 'alive', body: 'focused test' })
    ).toMatchObject({
      operation: 'worker.heartbeat',
      params: { subject: 'alive', body: 'focused test' }
    })
    expect(
      accept(null, 'orca_worker_ask', {
        question: 'Proceed?',
        options: ['yes', 'no'],
        timeoutMs: 30_000
      })
    ).toMatchObject({
      operation: 'worker.ask',
      params: { question: 'Proceed?', options: ['yes', 'no'], timeoutMs: 30_000 }
    })
    expect(
      accept(null, 'orca_worker_reply_consume', {
        questionId: 'question_757',
        timeoutMs: 30_000
      })
    ).toMatchObject({
      operation: 'worker.reply.consume',
      params: { questionId: 'question_757', timeoutMs: 30_000 }
    })
    expect(
      accept(null, 'orca_worker_done', {
        outcome: 'succeeded',
        subject: 'complete',
        body: 'all checks passed'
      })
    ).toMatchObject({
      operation: 'worker.done',
      params: { outcome: 'succeeded', subject: 'complete', body: 'all checks passed' }
    })
  })

  it.each([undefined, '', 'orca', 'functions', 'worker'])('refuses namespace %s', (namespace) => {
    expect(refuse(namespace, 'orca_worker_status', {})).toMatchObject({
      reason: 'unknown_namespace',
      field: 'namespace'
    })
  })

  it.each(['worker.status', 'orca_worker_start', 'orca_worker_status_extra', 'shell_command', ''])(
    'refuses unknown tool %s',
    (tool) => {
      expect(refuse(null, tool, {})).toMatchObject({ reason: 'unknown_tool', field: 'tool' })
    }
  )

  it.each([
    ['orca_worker_status', null],
    ['orca_worker_status', []],
    ['orca_worker_status', { extra: true }],
    ['orca_worker_check', { wait: 'yes' }],
    ['orca_worker_check', { timeoutMs: 0 }],
    ['orca_worker_check', { timeoutMs: 600_001 }],
    ['orca_worker_heartbeat', { subject: '   ' }],
    ['orca_worker_ask', { question: 'Proceed?', options: [] }],
    ['orca_worker_reply_consume', { questionId: '' }],
    ['orca_worker_done', { outcome: 'maybe', subject: 'done' }]
  ])('refuses malformed %s arguments', (tool, args) => {
    expect(refuse(null, tool, args)).toMatchObject({
      reason: 'invalid_arguments',
      field: 'arguments'
    })
  })

  it.each([
    ['runId', 'run_foreign'],
    ['task', 'task_foreign'],
    ['dispatchId', 'dispatch_foreign'],
    ['terminalHandle', 'term_foreign'],
    ['credential', 'lgw1_secret'],
    ['socketPath', '/tmp/private.sock'],
    ['rawRpc', { method: 'orchestration.run' }],
    ['method', 'orchestration.send'],
    ['params', { to: 'run:foreign' }]
  ])('refuses caller-selected control field %s', (field, value) => {
    expect(
      refuse(null, 'orca_worker_heartbeat', { subject: 'alive', [field]: value })
    ).toMatchObject({
      reason: 'forbidden_argument',
      field: `arguments.${field}`
    })
  })

  it('finds forbidden identity fields nested inside malformed containers', () => {
    expect(
      refuse(null, 'orca_worker_status', { metadata: { dispatch: 'dispatch_foreign' } })
    ).toMatchObject({
      reason: 'forbidden_argument',
      field: 'arguments.metadata.dispatch'
    })
  })
})
