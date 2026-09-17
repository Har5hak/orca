import type {
  LabGatewayBinding,
  LabGatewayOperation,
  LabGatewayRpc
} from './dispatch-gateway-policy-contract'

export type LabGatewayTranslation =
  | Readonly<{ ok: true; rpc: LabGatewayRpc; terminal: boolean }>
  | Readonly<{ ok: false; field?: string }>

function hasOnlyKeys(params: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(params).every((key) => keys.includes(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function optionalTimeout(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
}

function translateRead(
  operation: 'worker.status' | 'worker.check',
  params: Readonly<Record<string, unknown>>,
  binding: LabGatewayBinding
): LabGatewayTranslation {
  if (operation === 'worker.status') {
    if (!hasOnlyKeys(params, [])) {
      return { ok: false }
    }
    return {
      ok: true,
      terminal: false,
      rpc: { method: 'orchestration.workerShow', params: { dispatch: binding.dispatchId } }
    }
  }
  if (
    !hasOnlyKeys(params, ['wait', 'timeoutMs']) ||
    (params.wait !== undefined && typeof params.wait !== 'boolean') ||
    !optionalTimeout(params.timeoutMs)
  ) {
    return { ok: false }
  }
  return {
    ok: true,
    terminal: false,
    rpc: {
      method: 'orchestration.check',
      params: {
        terminal: binding.terminalHandle,
        terminalPaneKey: binding.terminalPaneKey,
        run: binding.runId,
        peek: true,
        unread: false,
        types: 'status,dispatch',
        ...(params.wait === undefined ? {} : { wait: params.wait }),
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs })
      }
    }
  }
}

function lifecyclePayload(binding: LabGatewayBinding, outcome?: 'succeeded' | 'failed'): string {
  return JSON.stringify({
    runId: binding.runId,
    taskId: binding.taskId,
    dispatchId: binding.dispatchId,
    ...(outcome === undefined ? {} : { outcome })
  })
}

function translateHeartbeat(
  params: Readonly<Record<string, unknown>>,
  binding: LabGatewayBinding
): LabGatewayTranslation {
  if (
    !hasOnlyKeys(params, ['subject', 'body']) ||
    !nonEmptyString(params.subject) ||
    !optionalString(params.body)
  ) {
    return { ok: false }
  }
  return {
    ok: true,
    terminal: false,
    rpc: {
      method: 'orchestration.send',
      params: {
        from: binding.terminalHandle,
        senderPaneKey: binding.terminalPaneKey,
        to: `run:${binding.runId}`,
        run: binding.runId,
        type: 'heartbeat',
        subject: params.subject,
        ...(params.body === undefined ? {} : { body: params.body }),
        payload: lifecyclePayload(binding)
      }
    }
  }
}

function translateAsk(
  operation: 'worker.ask' | 'worker.reply.consume',
  params: Readonly<Record<string, unknown>>,
  binding: LabGatewayBinding
): LabGatewayTranslation {
  const timeoutMs = params.timeoutMs ?? 30_000
  if (!optionalTimeout(timeoutMs)) {
    return { ok: false, field: 'timeoutMs' }
  }
  const common = {
    from: binding.terminalHandle,
    to: `run:${binding.runId}`,
    run: binding.runId,
    timeoutMs
  }
  if (operation === 'worker.reply.consume') {
    if (!hasOnlyKeys(params, ['questionId', 'timeoutMs']) || !nonEmptyString(params.questionId)) {
      return { ok: false }
    }
    return {
      ok: true,
      terminal: false,
      rpc: { method: 'orchestration.ask', params: { ...common, resume: params.questionId } }
    }
  }
  if (
    !hasOnlyKeys(params, ['question', 'options', 'timeoutMs']) ||
    !nonEmptyString(params.question) ||
    (params.options !== undefined && !stringArray(params.options))
  ) {
    return { ok: false }
  }
  return {
    ok: true,
    terminal: false,
    rpc: {
      method: 'orchestration.ask',
      params: {
        ...common,
        question: params.question,
        ...(params.options === undefined ? {} : { options: params.options.join(',') })
      }
    }
  }
}

function translateDone(
  params: Readonly<Record<string, unknown>>,
  binding: LabGatewayBinding
): LabGatewayTranslation {
  if (
    !hasOnlyKeys(params, ['outcome', 'subject', 'body']) ||
    (params.outcome !== 'succeeded' && params.outcome !== 'failed') ||
    !nonEmptyString(params.subject) ||
    !optionalString(params.body)
  ) {
    return { ok: false }
  }
  return {
    ok: true,
    terminal: true,
    rpc: {
      method: 'orchestration.send',
      params: {
        from: binding.terminalHandle,
        senderPaneKey: binding.terminalPaneKey,
        to: `run:${binding.runId}`,
        run: binding.runId,
        type: 'worker_done',
        subject: params.subject,
        ...(params.body === undefined ? {} : { body: params.body }),
        payload: lifecyclePayload(binding, params.outcome),
        waitForLifecycleSettlement: true
      }
    }
  }
}

export function translateLabGatewayOperation(
  operation: LabGatewayOperation,
  params: Readonly<Record<string, unknown>>,
  binding: LabGatewayBinding
): LabGatewayTranslation {
  if (operation === 'worker.status' || operation === 'worker.check') {
    return translateRead(operation, params, binding)
  }
  if (operation === 'worker.heartbeat') {
    return translateHeartbeat(params, binding)
  }
  if (operation === 'worker.ask' || operation === 'worker.reply.consume') {
    return translateAsk(operation, params, binding)
  }
  return translateDone(params, binding)
}
