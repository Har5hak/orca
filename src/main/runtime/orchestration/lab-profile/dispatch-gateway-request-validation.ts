import type {
  LabGatewayBinding,
  LabGatewayOperation,
  LabGatewayRefusalReason
} from './dispatch-gateway-policy-contract'

export function isAllowedLabGatewayOperation(operation: string): operation is LabGatewayOperation {
  switch (operation) {
    case 'worker.status':
    case 'worker.check':
    case 'worker.heartbeat':
    case 'worker.ask':
    case 'worker.reply.consume':
    case 'worker.done':
      return true
    default:
      return false
  }
}

export function deniedLabGatewayOperationReason(operation: string): LabGatewayRefusalReason {
  const normalized = operation.toLowerCase()
  if (normalized === 'orchestration.send' || normalized === 'message.send') {
    return 'arbitrary_send_forbidden'
  }
  if (
    normalized === 'orchestration.run' ||
    normalized.includes('runcreate') ||
    normalized.includes('taskcreate') ||
    normalized === 'orchestration.dispatch' ||
    normalized.includes('dispatchcreate')
  ) {
    return 'lifecycle_creation_forbidden'
  }
  if (/(start|stop|abandon|retry|retain|release)/u.test(normalized)) {
    return 'lifecycle_mutation_forbidden'
  }
  if (normalized.includes('terminal')) {
    return 'raw_terminal_forbidden'
  }
  return 'unknown_operation'
}

export function toLabGatewayParams(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return {}
  }
  if (!isRecord(value)) {
    return undefined
  }
  return value
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectedIdentity(field: string, binding: LabGatewayBinding): string | undefined {
  switch (field) {
    case 'run':
    case 'runId':
      return binding.runId
    case 'task':
    case 'taskId':
      return binding.taskId
    case 'dispatch':
    case 'dispatchId':
      return binding.dispatchId
    case 'terminal':
    case 'terminalId':
    case 'terminalHandle':
    case 'from':
      return binding.terminalHandle
    case 'terminalPaneKey':
    case 'senderPaneKey':
      return binding.terminalPaneKey
    case 'to':
      return `run:${binding.runId}`
    default:
      return undefined
  }
}

export function findCallerIdentityRefusal(
  params: Readonly<Record<string, unknown>>,
  binding: LabGatewayBinding
): Readonly<{ reason: LabGatewayRefusalReason; field: string }> | undefined {
  for (const [field, value] of Object.entries(params)) {
    const expected = expectedIdentity(field, binding)
    if (expected === undefined) {
      continue
    }
    return {
      reason: value === expected ? 'caller_identity_forbidden' : 'cross_dispatch_identity',
      field
    }
  }
  return undefined
}
