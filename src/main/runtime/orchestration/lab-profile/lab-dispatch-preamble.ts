import { isAbsolute, normalize } from 'node:path/posix'
import {
  LAB_GATEWAY_ALLOWED_OPERATIONS,
  type LabGatewayOperation
} from './dispatch-gateway-policy-contract'

export const LAB_GATEWAY_CLIENT_COMMAND_CONTRACT = Object.freeze({
  schema: 'orca.lab-dispatch-gateway-client.v1',
  transport: 'sealed-unix-socket-environment',
  action: 'call',
  operationFlag: '--operation',
  paramsFlag: '--params-json'
} as const)

export type LabDispatchPreambleParams = Readonly<{
  taskSpec: string
  // The launch host must attest this pinned binary before building the preamble.
  gatewayClientExecutable: string
}>

type LabGatewayRecipe = Readonly<{
  params: Readonly<Record<string, unknown>>
  comment: readonly string[]
}>

const SAFE_EXECUTABLE_PATTERN = /^\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+$/u

const RESTRICTED_TASK_PATTERNS = [
  /\bdcap_[A-Za-z0-9_-]+\b/u,
  /\blgw1_[A-Za-z0-9_-]+\b/u,
  /\bterm_[A-Za-z0-9_-]+\b/u,
  /\b(?:orca|orca-dev|orca-ide)\s+orchestration\b/iu,
  /\bORCA_(?:TERMINAL_HANDLE|CLI_COMMAND|LAB_GATEWAY_(?:SOCKET|CREDENTIAL))\b/u,
  /\b(?:authToken|runtimeToken|sharedToken|dispatchCapability|orchestrationCapability)\b/u,
  /\bcomputer(?:[ _-]+)use\b/iu,
  /\bsub[ -]?dispatch\b/iu,
  /\bescalation\b/iu,
  /--operation\b/iu,
  /--worktree(?:=|\s+)(?:current|active)\b/iu,
  /\b(?:run-create|task-create|worker-start|worker-stop|handoff)\b/iu
] as const

const RECIPE_BY_OPERATION: Readonly<Record<LabGatewayOperation, LabGatewayRecipe>> = Object.freeze({
  'worker.status': {
    params: {},
    comment: ['Read the status of this bound Dispatch.']
  },
  'worker.check': {
    params: { wait: false },
    comment: ['Read coordinator follow-ups at each natural checkpoint and before completion.']
  },
  'worker.heartbeat': {
    params: { subject: 'alive', body: '<short phase>' },
    comment: ['Report liveness every five minutes while actively working.']
  },
  'worker.ask': {
    params: {
      question: '<question>',
      options: ['<option-a>', '<option-b>'],
      timeoutMs: 600_000
    },
    comment: ['Ask the coordinator and wait for its reply.']
  },
  'worker.reply.consume': {
    params: { questionId: '<question-id>', timeoutMs: 600_000 },
    comment: ['Resume the same question after a timeout or disconnect; never create a duplicate.']
  },
  'worker.done': {
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
  assertGatewayClientExecutable(params.gatewayClientExecutable)
  assertRestrictedTaskSpec(params.taskSpec)

  const commands = LAB_GATEWAY_ALLOWED_OPERATIONS.map((operation) =>
    renderRecipe(params.gatewayClientExecutable, operation, RECIPE_BY_OPERATION[operation])
  ).join('\n\n')

  return `You are a supervised Codex laboratory worker. Complete only the task below.

All Orca communication goes through the sealed per-Dispatch gateway client. The client resolves
its locked Unix-socket channel from the launch environment and supplies the bound lifecycle
identity itself. Replace angle-bracket placeholders with real values. Do not add identity or
authentication fields, and do not invoke operations that are not listed here.

=== LAB GATEWAY COMMANDS ===

\`\`\`sh
${commands}
\`\`\`

After a successful worker.done response, return to an idle prompt and take no further action for
this task. A failed or refused response is not completion; report the exact refusal through the
same allowed gateway when possible.

=== TASK ===
${params.taskSpec}`
}

function renderRecipe(
  executable: string,
  operation: LabGatewayOperation,
  recipe: LabGatewayRecipe
): string {
  const comments = recipe.comment.map((line) => `  # ${line}`).join('\n')
  const contract = LAB_GATEWAY_CLIENT_COMMAND_CONTRACT
  return `${comments}
  ${executable} ${contract.action} ${contract.operationFlag} ${operation} ${contract.paramsFlag} '${JSON.stringify(recipe.params)}'`
}

function assertGatewayClientExecutable(executable: string): void {
  if (
    !SAFE_EXECUTABLE_PATTERN.test(executable) ||
    !isAbsolute(executable) ||
    normalize(executable) !== executable ||
    /\b(?:dcap|lgw1|term)_[A-Za-z0-9_-]+\b/u.test(executable)
  ) {
    throw new Error('Laboratory gateway client must be one normalized absolute executable token')
  }
}

function assertRestrictedTaskSpec(taskSpec: string): void {
  if (!taskSpec.trim() || taskSpec.includes('\u0000')) {
    throw new Error('Laboratory task specification must be non-empty text without NUL bytes')
  }
  if (RESTRICTED_TASK_PATTERNS.some((pattern) => pattern.test(taskSpec))) {
    throw new Error('Laboratory task specification contains a restricted control surface')
  }
}
