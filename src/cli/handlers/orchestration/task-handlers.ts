import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { readRetryRequestFlag } from '../../retry-request-flag'
import { RuntimeClientError } from '../../runtime-client'
import { orchestrationMutationRecoveryError } from '../../orchestration-mutation-recovery'
import { abbreviateOrchestrationTasks } from '../../../shared/orchestration-task-summary'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  isTaskDeliveryReceipt,
  type TaskDeliveryReceipt
} from '../../../shared/orchestration-task-delivery-key'
import { ORCHESTRATION_TASK_DELIVERY_KEY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'

const TASK_STATUS_VALUES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const

type TaskCreateResult = {
  task: { id: string; status: string }
}

type KeyedTaskCreateResult = {
  task: TaskCreateResult['task'] & { run_id: string }
  delivery: TaskDeliveryReceipt
}

export const ORCHESTRATION_TASK_HANDLERS: Record<string, CommandHandler> = {
  'orchestration task-create': async ({ flags, client, cwd, json }) => {
    const deliveryKey = flags.has('delivery-key')
      ? getRequiredStringFlag(flags, 'delivery-key')
      : undefined
    if (!deliveryKey) {
      const callerTerminalHandle = await resolveCoordinatorTerminalHandle(flags, cwd, client)
      const result = await callOrchestrationMutation<TaskCreateResult>(
        client,
        flags,
        'orchestration.taskCreate',
        taskCreateParams(flags, callerTerminalHandle)
      )
      printResult(result, json, (value) => `Created ${value.task.id} [${value.task.status}]`)
      return
    }

    const status = await client.call<RuntimeStatus>('status.get')
    if (!status.result.capabilities?.includes(ORCHESTRATION_TASK_DELIVERY_KEY_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The connected Orca runtime does not support atomic Task delivery keys. No Task was created; update or restart Orca and try again.'
      )
    }
    const callerTerminalHandle = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const requestId = readRetryRequestFlag(flags) ?? randomUUID()
    let result
    try {
      result = await client.call<KeyedTaskCreateResult>(
        'orchestration.taskCreateByDeliveryKey',
        { ...taskCreateParams(flags, callerTerminalHandle), deliveryKey },
        { orchestrationRequestId: requestId }
      )
    } catch (error) {
      throw orchestrationMutationRecoveryError(error)
    }
    if (!isConsistentKeyedTaskCreateResult(result.result, deliveryKey)) {
      throw orchestrationMutationRecoveryError(
        new RuntimeClientError(
          'invalid_runtime_response',
          'invalid_runtime_response: The Orca runtime returned a malformed atomic Task delivery receipt. Outcome: outcome_unknown.',
          { orchestrationRequestId: requestId }
        )
      )
    }
    printResult<KeyedTaskCreateResult>(result, json, (value) => {
      const verb = value.delivery.disposition === 'created' ? 'Created' : 'Adopted'
      const run =
        value.delivery.disposition === 'adopted' ? ` in existing Run ${value.delivery.run_id}` : ''
      return `${verb} ${value.delivery.task_id} [${value.task.status}]${run}`
    })
  },

  'orchestration task-list': async ({ flags, client, cwd, json }) => {
    const brief = flags.has('brief')
    const run = getOptionalStringFlag(flags, 'run')
    const callerTerminalHandle = run
      ? undefined
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<{
      tasks: {
        id: string
        spec: string
        task_title?: string | null
        display_name?: string | null
        status: string
        assignee_handle?: string | null
        dispatch_id?: string | null
        spec_truncated?: boolean
      }[]
      count: number
      runId?: string
      legacyReadOnly?: boolean
    }>('orchestration.taskList', {
      status: getOptionalStringFlag(flags, 'status'),
      ready: flags.has('ready') ? true : undefined,
      brief: brief ? true : undefined,
      run,
      callerTerminalHandle
    })
    // Why: only older runtimes (no spec_truncated) skip server-side abbreviation and need this client-side fallback.
    const needsClientAbbreviation =
      brief && result.result.tasks.some((task) => task.spec_truncated === undefined)
    const output = needsClientAbbreviation
      ? {
          ...result,
          result: { ...result.result, tasks: abbreviateOrchestrationTasks(result.result.tasks) }
        }
      : result
    printResult(output, json, (r) => {
      if (r.count === 0) {
        return r.legacyReadOnly ? 'No legacy tasks (read-only).' : 'No tasks.'
      }
      const tasks = r.tasks
        .map((task) => {
          const label = task.display_name ?? task.task_title ?? task.spec
          const head = `${task.id} [${task.status}] ${label.slice(0, 60)}`
          if (task.status === 'dispatched' && task.assignee_handle) {
            return `${head} -> ${task.assignee_handle} (${task.dispatch_id ?? '?'})`
          }
          return head
        })
        .join('\n')
      return r.legacyReadOnly ? `Legacy Run ${r.runId} (read-only)\n${tasks}` : tasks
    })
  },

  'orchestration task-update': async ({ flags, client, cwd, json }) => {
    const status = getRequiredStringFlag(flags, 'status')
    if (!TASK_STATUS_VALUES.includes(status as (typeof TASK_STATUS_VALUES)[number])) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid status '${status}', expected one of: ${TASK_STATUS_VALUES.join(', ')}`
      )
    }
    const result = await callOrchestrationMutation<{ task: { id: string; status: string } }>(
      client,
      flags,
      'orchestration.taskUpdate',
      {
        id: getRequiredStringFlag(flags, 'id'),
        status,
        result: getOptionalStringFlag(flags, 'result'),
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printResult(result, json, (r) => `Updated ${r.task.id} -> ${r.task.status}`)
  }
}

function taskCreateParams(flags: Map<string, string | boolean>, callerTerminalHandle: string) {
  return {
    spec: getRequiredStringFlag(flags, 'spec'),
    taskTitle: getOptionalStringFlag(flags, 'task-title'),
    displayName: getOptionalStringFlag(flags, 'display-name'),
    deps: getOptionalStringFlag(flags, 'deps'),
    parent: getOptionalStringFlag(flags, 'parent'),
    run: getOptionalStringFlag(flags, 'run'),
    callerTerminalHandle
  }
}

function isConsistentKeyedTaskCreateResult(
  value: unknown,
  requestedDeliveryKey: string
): value is KeyedTaskCreateResult {
  const result = objectRecord(value)
  const task = objectRecord(result?.task)
  const delivery = result?.delivery
  return Boolean(
    task &&
    typeof task.id === 'string' &&
    task.id.length > 0 &&
    typeof task.status === 'string' &&
    typeof task.run_id === 'string' &&
    task.run_id.length > 0 &&
    isTaskDeliveryReceipt(delivery) &&
    delivery.delivery_key === requestedDeliveryKey &&
    delivery.task_id === task.id &&
    delivery.run_id === task.run_id
  )
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guards above establish a non-array object whose fields remain unknown.
  return value as Record<string, unknown>
}
