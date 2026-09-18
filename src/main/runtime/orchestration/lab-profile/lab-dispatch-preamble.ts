import {
  LAB_GATEWAY_ALLOWED_OPERATIONS,
  type LabGatewayOperation
} from './dispatch-gateway-policy-contract'

export const LAB_DYNAMIC_TOOL_USAGE_CONTRACT = Object.freeze({
  schema: 'orca.lab-dispatch-dynamic-tools.v1',
  transport: 'codex-app-server-host-executed',
  tools: Object.freeze([
    'orca_worker_status',
    'orca_worker_check',
    'orca_worker_heartbeat',
    'orca_worker_ask',
    'orca_worker_reply_consume',
    'orca_worker_done'
  ] as const)
})

export type LabDispatchPreambleParams = Readonly<{
  taskSpec: string
}>

type LabGatewayRecipe = Readonly<{
  tool: (typeof LAB_DYNAMIC_TOOL_USAGE_CONTRACT.tools)[number]
  params: Readonly<Record<string, unknown>>
  comment: readonly string[]
}>

const RESTRICTED_TASK_PATTERNS = [
  /\bdcap_[A-Za-z0-9_-]+\b/u,
  /\blgw1_[A-Za-z0-9_-]+\b/u,
  /\bterm_[A-Za-z0-9_-]+\b/u,
  /\bstructworker_[A-Za-z0-9_-]+\b/u,
  /\b(?:run|task|dispatch|ctx)_[A-Za-z0-9_-]+\b/u,
  /\b(?:orca|orca-dev|orca-ide)\s+orchestration\b/iu,
  /\bORCA_(?:TERMINAL_HANDLE|CLI_COMMAND|LAB_GATEWAY_(?:SOCKET|CREDENTIAL))\b/u,
  /\b(?:authToken|runtimeToken|sharedToken|dispatchCapability|orchestrationCapability)\b/u,
  /\bcomputer(?:[ _-]+)use\b/iu,
  /\bsub[ -]?dispatch\b/iu,
  /\bescalation\b/iu,
  /--operation\b/iu,
  /--worktree(?:=|\s+)(?:current|active)\b/iu,
  /\b(?:run-create|task-create|worker-(?:start|stop|abandon|retry|retain|release)|handoff)\b/iu,
  /\borca_worker_[a-z_]+\b/iu
] as const

const RECIPE_BY_OPERATION: Readonly<Record<LabGatewayOperation, LabGatewayRecipe>> = Object.freeze({
  'worker.status': {
    tool: 'orca_worker_status',
    params: {},
    comment: ['Read the status of this bound Dispatch.']
  },
  'worker.check': {
    tool: 'orca_worker_check',
    params: { wait: false },
    comment: ['Read coordinator follow-ups at each natural checkpoint and before completion.']
  },
  'worker.heartbeat': {
    tool: 'orca_worker_heartbeat',
    params: { subject: 'alive', body: '<short phase>' },
    comment: ['Report liveness every five minutes while actively working.']
  },
  'worker.ask': {
    tool: 'orca_worker_ask',
    params: {
      question: '<question>',
      options: ['<option-a>', '<option-b>'],
      timeoutMs: 600_000
    },
    comment: ['Ask the coordinator and wait for its reply.']
  },
  'worker.reply.consume': {
    tool: 'orca_worker_reply_consume',
    params: { questionId: '<question-id>', timeoutMs: 600_000 },
    comment: ['Resume the same question after a timeout or disconnect; never create a duplicate.']
  },
  'worker.done': {
    tool: 'orca_worker_done',
    params: {
      outcome: 'succeeded',
      subject: '<short status>',
      body: '<three-sentence summary>'
    },
    comment: [
      'Report completion exactly once.',
      'Use outcome "failed" when the requested work is not complete.'
    ]
  }
})

export function buildLabDispatchPreamble(params: LabDispatchPreambleParams): string {
  assertRestrictedTaskSpec(params.taskSpec)

  const tools = LAB_GATEWAY_ALLOWED_OPERATIONS.map((operation) =>
    renderRecipe(RECIPE_BY_OPERATION[operation])
  ).join('\n\n')

  return `You are a supervised Codex laboratory worker. Complete only the task below.

All Orca communication goes through the six native tools below. Orca executes them on the host;
the shell receives no gateway endpoint, credential or lifecycle identity. Replace angle-bracket
placeholders with real values. Do not add identity or authentication fields, do not call Orca
from the shell, and do not invoke tools that are not listed here.

=== LAB DISPATCH TOOLS ===

${tools}

After a successful orca_worker_done response, return to an idle prompt and take no further action for
this task. A failed or refused response is not completion; report the exact refusal through the
same allowed host tool when possible.

=== TASK ===
${params.taskSpec}`
}

function renderRecipe(recipe: LabGatewayRecipe): string {
  const comments = recipe.comment.map((line) => `  ${line}`).join('\n')
  return `- \`${recipe.tool}(${JSON.stringify(recipe.params)})\`\n${comments}`
}

function assertRestrictedTaskSpec(taskSpec: string): void {
  if (!taskSpec.trim() || taskSpec.includes('\u0000')) {
    throw new Error('Laboratory task specification must be non-empty text without NUL bytes')
  }
  if (RESTRICTED_TASK_PATTERNS.some((pattern) => pattern.test(taskSpec))) {
    throw new Error('Laboratory task specification contains a restricted control surface')
  }
}
