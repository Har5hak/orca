import { createHash } from 'node:crypto'
import {
  buildRootTaskDeliveryContract,
  isTaskDeliveryReceipt,
  isValidTaskDeliveryKeyLength,
  TASK_DELIVERY_KEY_LENGTH_GUIDANCE,
  TASK_DELIVERY_KEY_NUL_GUIDANCE,
  type TaskDeliveryReceipt
} from '../../../../../shared/orchestration-task-delivery-key'
import { ensureMutationReceiptCapacity } from '../../mutation-receipt-capacity'
import { OrchestrationError } from '../../orchestration-error'
import type { TaskRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'
import { selectColumns, TASK_COLUMNS } from '../row-column-lists'

export type TaskDeliveryResult = { task: TaskRow; delivery: TaskDeliveryReceipt }

type TaskDeliveryMutationIdentity = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}

type TaskDeliveryRow = TaskRow & {
  delivery_key: string
  contract_sha256: string
}

const TASK_DELIVERY_ROW_SQL = `
  SELECT delivery.delivery_key, delivery.contract_sha256, ${selectColumns(TASK_COLUMNS, 'task')}
  FROM task_delivery_keys delivery
  JOIN tasks task ON task.id = delivery.task_id
  WHERE delivery.delivery_key = ?
`

/**
 * Atomically creates one root Task or adopts the Task already bound to the global delivery key.
 * The contract contains execution semantics only: exact spec bytes and sorted unique dependencies.
 * Run ownership, presentation labels, creator provenance, and lifecycle state are deliberately not hashed.
 */
export function createOrAdoptRootTask(
  this: OrchestrationDb,
  input: {
    deliveryKey: string
    spec: string
    taskTitle?: string
    displayName?: string
    deps?: string[]
    parentId?: string
    createdByTerminalHandle?: string
    createdByPaneKey?: string
    createdByProcessIncarnation?: string
    createdByRunGeneration?: number
    runId: string
    mutationReceipt?: TaskDeliveryMutationIdentity
  }
): TaskDeliveryResult {
  validateDeliveryKey(input.deliveryKey)
  if (input.parentId) {
    throw new OrchestrationError(
      'invalid_argument',
      '--delivery-key is only valid for a root Task and cannot be combined with --parent.',
      { effectsApplied: false }
    )
  }

  const { contract, serialized } = buildRootTaskDeliveryContract(input)
  const contractSha256 = createHash('sha256').update(serialized, 'utf8').digest('hex')

  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resumedDelivery = input.mutationReceipt
      ? prepareTaskDeliveryMutation.call(this, input.mutationReceipt)
      : undefined
    if (
      resumedDelivery &&
      (resumedDelivery.delivery_key !== input.deliveryKey ||
        resumedDelivery.contract_sha256 !== contractSha256)
    ) {
      throw staleTaskDeliveryMutation(input.mutationReceipt?.requestId)
    }
    try {
      this.requireRun(input.runId)
    } catch (error) {
      if (resumedDelivery) {
        throw staleTaskDeliveryMutation(input.mutationReceipt?.requestId)
      }
      throw error
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT aliases exactly TASK_COLUMNS plus the two registry columns represented by TaskDeliveryRow.
    const existing = this.db.prepare(TASK_DELIVERY_ROW_SQL).get(input.deliveryKey) as
      | TaskDeliveryRow
      | undefined
    if (existing) {
      if (existing.contract_sha256 !== contractSha256) {
        throw new OrchestrationError(
          'delivery_key_conflict',
          `Delivery key is already bound to Task ${existing.id} with a different contract.`,
          {
            effectsApplied: false,
            taskId: existing.id,
            runId: existing.run_id,
            existingContractSha256: existing.contract_sha256,
            requestedContractSha256: contractSha256
          }
        )
      }
      const delivery = buildReceipt(input.deliveryKey, existing, 'adopted')
      checkpointTaskDeliveryMutation.call(this, input.mutationReceipt, delivery)
      this.db.exec('COMMIT')
      return {
        task: taskFromDeliveryRow(existing),
        delivery
      }
    }

    const task = this.createTask({
      spec: input.spec,
      taskTitle: input.taskTitle,
      displayName: input.displayName,
      deps: contract.dependencies,
      createdByTerminalHandle: input.createdByTerminalHandle,
      createdByPaneKey: input.createdByPaneKey,
      createdByProcessIncarnation: input.createdByProcessIncarnation,
      createdByRunGeneration: input.createdByRunGeneration,
      runId: input.runId
    })
    this.db
      .prepare(
        `INSERT INTO task_delivery_keys (delivery_key, contract_sha256, task_id)
         VALUES (?, ?, ?)`
      )
      .run(input.deliveryKey, contractSha256, task.id)
    const delivery: TaskDeliveryReceipt = {
      delivery_key: input.deliveryKey,
      contract_sha256: contractSha256,
      task_id: task.id,
      run_id: task.run_id,
      disposition: 'created'
    }
    checkpointTaskDeliveryMutation.call(this, input.mutationReceipt, delivery)
    this.db.exec('COMMIT')
    return { task, delivery }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

function prepareTaskDeliveryMutation(
  this: OrchestrationDb,
  identity: TaskDeliveryMutationIdentity
): TaskDeliveryReceipt | undefined {
  const existing = this.getMutationReceipt(identity.callerFingerprint, identity.requestId)
  if (!existing) {
    ensureMutationReceiptCapacity(this.db)
    this.db
      .prepare(
        `INSERT INTO mutation_receipts (
           caller_fingerprint, request_id, method, payload_hash, state
         ) VALUES (?, ?, ?, ?, 'pending')`
      )
      .run(identity.callerFingerprint, identity.requestId, identity.method, identity.payloadHash)
    return undefined
  }
  if (existing.method !== identity.method || existing.payload_hash !== identity.payloadHash) {
    throw new OrchestrationError(
      'request_mismatch',
      `Mutation request ${identity.requestId} was already used with different input.`
    )
  }
  const delivery = readTaskDeliveryMutationCheckpoint(existing.receipt)
  if (
    existing.state !== 'pending' ||
    !delivery ||
    !isCurrentTaskDeliveryBinding.call(this, delivery)
  ) {
    throw staleTaskDeliveryMutation(identity.requestId)
  }
  return delivery
}

function checkpointTaskDeliveryMutation(
  this: OrchestrationDb,
  identity: TaskDeliveryMutationIdentity | undefined,
  delivery: TaskDeliveryReceipt
): void {
  if (!identity) {
    return
  }
  this.checkpointPendingMutationReceipt({
    ...identity,
    receipt: JSON.stringify({ taskDelivery: delivery })
  })
}

function staleTaskDeliveryMutation(requestId: string | undefined): OrchestrationError {
  return new OrchestrationError(
    'operation_unknown',
    requestId
      ? `Mutation ${requestId} has no live matching Task delivery binding and will not be resumed.`
      : 'The mutation has no live matching Task delivery binding and will not be resumed.',
    requestId ? { requestId } : undefined
  )
}

function validateDeliveryKey(deliveryKey: string): void {
  if (deliveryKey.includes('\0')) {
    throw new OrchestrationError('invalid_argument', TASK_DELIVERY_KEY_NUL_GUIDANCE, {
      effectsApplied: false
    })
  }
  if (!isValidTaskDeliveryKeyLength(deliveryKey)) {
    throw new OrchestrationError('invalid_argument', TASK_DELIVERY_KEY_LENGTH_GUIDANCE, {
      effectsApplied: false
    })
  }
}

export function isCurrentTaskDeliveryReceipt(this: OrchestrationDb, value: unknown): boolean {
  const result = objectRecord(value)
  const task = objectRecord(result?.task)
  const delivery = result?.delivery
  if (
    !task ||
    typeof task.id !== 'string' ||
    typeof task.run_id !== 'string' ||
    !isTaskDeliveryReceipt(delivery) ||
    delivery.task_id !== task.id ||
    delivery.run_id !== task.run_id
  ) {
    return false
  }
  return isCurrentTaskDeliveryBinding.call(this, delivery)
}

export function isCurrentTaskDeliveryMutationCheckpoint(
  this: OrchestrationDb,
  value: string | null
): boolean {
  const delivery = readTaskDeliveryMutationCheckpoint(value)
  return Boolean(delivery && isCurrentTaskDeliveryBinding.call(this, delivery))
}

function readTaskDeliveryMutationCheckpoint(value: string | null): TaskDeliveryReceipt | undefined {
  if (!value) {
    return undefined
  }
  try {
    const checkpoint = objectRecord(JSON.parse(value))?.taskDelivery
    return isTaskDeliveryReceipt(checkpoint) ? checkpoint : undefined
  } catch {
    return undefined
  }
}

function isCurrentTaskDeliveryBinding(
  this: OrchestrationDb,
  delivery: TaskDeliveryReceipt
): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT aliases exactly the four string fields declared by the asserted row shape.
  const current = this.db
    .prepare(
      `SELECT delivery.delivery_key, delivery.contract_sha256,
              task.id AS task_id, task.run_id
       FROM task_delivery_keys delivery
       JOIN tasks task ON task.id = delivery.task_id
       WHERE delivery.delivery_key = ?`
    )
    .get(delivery.delivery_key) as
    | {
        delivery_key: string
        contract_sha256: string
        task_id: string
        run_id: string
      }
    | undefined
  return Boolean(
    current &&
    current.delivery_key === delivery.delivery_key &&
    current.contract_sha256 === delivery.contract_sha256 &&
    current.task_id === delivery.task_id &&
    current.run_id === delivery.run_id
  )
}

function buildReceipt(
  deliveryKey: string,
  row: TaskDeliveryRow,
  disposition: TaskDeliveryReceipt['disposition']
): TaskDeliveryReceipt {
  return {
    delivery_key: deliveryKey,
    contract_sha256: row.contract_sha256,
    task_id: row.id,
    run_id: row.run_id,
    disposition
  }
}

function taskFromDeliveryRow(row: TaskDeliveryRow): TaskRow {
  const { delivery_key: _deliveryKey, contract_sha256: _contractSha256, ...task } = row
  return task
}

export type TaskDeliveryKeyMethods = {
  createOrAdoptRootTask: typeof createOrAdoptRootTask
  isCurrentTaskDeliveryReceipt: typeof isCurrentTaskDeliveryReceipt
  isCurrentTaskDeliveryMutationCheckpoint: typeof isCurrentTaskDeliveryMutationCheckpoint
}

export function attachTaskDeliveryKey(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createOrAdoptRootTask,
    isCurrentTaskDeliveryReceipt,
    isCurrentTaskDeliveryMutationCheckpoint
  })
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guards above establish a non-array object whose fields remain unknown.
  return value as Record<string, unknown>
}
