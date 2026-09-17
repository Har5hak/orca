import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_TASK_DELIVERY_KEY_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../../../shared/protocol-version'
import type { RpcRequest, RpcResponse } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { hashCanonical, replayStableCallerParams } from '../../../orchestration-mutation-receipt'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'

type Harness = {
  db: OrchestrationDb
  dispatcher: RpcDispatcher
  handle: string
  paneKey: string
  runId: string
  runtime: OrcaRuntimeService
}

type TaskDeliveryRpcResult = {
  task: { id: string; run_id: string }
  delivery: {
    delivery_key: string
    contract_sha256: string
    task_id: string
    run_id: string
    disposition: 'created' | 'adopted'
  }
  mutation: { requestId: string; replayed: boolean }
}

type DeliveryRaceResult = {
  task: { id: string; run_id: string }
  delivery: TaskDeliveryRpcResult['delivery']
}

type MutationIdentity = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}

describe('Task delivery-key create or adopt', () => {
  const directories: string[] = []
  const openDatabases = new Set<OrchestrationDb>()

  afterEach(() => {
    vi.restoreAllMocks()
    for (const db of openDatabases) {
      db.close()
    }
    openDatabases.clear()
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('advertises the additive delivery-key capability', () => {
    expect(RUNTIME_CAPABILITIES).toContain(ORCHESTRATION_TASK_DELIVERY_KEY_RUNTIME_CAPABILITY)
  })

  it('atomically adopts one root Task across Runs and survives a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-key-'))
    directories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const seed = new OrchestrationDb(dbPath)
    const firstRun = seed.createRun({
      objective: 'first delivery-key Run',
      coordinatorHandle: 'term_first',
      coordinatorPaneKey: 'tab_first:11111111-1111-4111-8111-111111111111'
    })
    const secondRun = seed.createRun({
      objective: 'second delivery-key Run',
      coordinatorHandle: 'term_second',
      coordinatorPaneKey: 'tab_second:22222222-2222-4222-8222-222222222222'
    })
    const firstRunBefore = seed.getRun(firstRun.id)
    const secondRunBefore = seed.getRun(secondRun.id)
    seed.close()
    const deliveryKey = 'backlog:hidden-layer:TASK-100:contract-v1'

    const [left, right] = await raceTaskDelivery(
      dbPath,
      [
        { runId: firstRun.id, handle: 'term_first' },
        { runId: secondRun.id, handle: 'term_second' }
      ],
      deliveryKey,
      'Ship the audited slice'
    )

    const successes = [left, right]
    expect(successes.map((result) => result.delivery.disposition).sort()).toEqual([
      'adopted',
      'created'
    ])
    const created = successes.find((result) => result.delivery.disposition === 'created')
    const adopted = successes.find((result) => result.delivery.disposition === 'adopted')
    expect(created).toBeDefined()
    expect(adopted).toBeDefined()
    if (!created || !adopted) {
      throw new Error('Expected one created and one adopted delivery receipt.')
    }
    expect(created.delivery).toMatchObject({
      delivery_key: deliveryKey,
      task_id: created.task.id,
      run_id: created.task.run_id,
      disposition: 'created'
    })
    expect(adopted).toMatchObject({
      task: { id: created.task.id, run_id: created.task.run_id },
      delivery: {
        delivery_key: deliveryKey,
        contract_sha256: created.delivery.contract_sha256,
        task_id: created.task.id,
        run_id: created.task.run_id,
        disposition: 'adopted'
      }
    })
    expect(created.delivery.contract_sha256).toMatch(/^[0-9a-f]{64}$/)

    const audit = new OrchestrationDb(dbPath)
    openDatabases.add(audit)
    const winningRunId = created.task.run_id
    const losingRunId = winningRunId === firstRun.id ? secondRun.id : firstRun.id
    expect(audit.listTasks()).toHaveLength(1)
    expect(audit.listTasks({ runId: winningRunId })).toHaveLength(1)
    expect(audit.listTasks({ runId: losingRunId })).toEqual([])
    expect(audit.db.prepare('SELECT delivery_key FROM task_delivery_keys').all()).toHaveLength(1)
    expect(audit.getRun(losingRunId)).toEqual(
      losingRunId === firstRun.id ? firstRunBefore : secondRunBefore
    )

    audit.close()
    openDatabases.delete(audit)
    const restarted = new OrchestrationDb(dbPath)
    openDatabases.add(restarted)
    const afterRestart = restarted.createOrAdoptRootTask({
      deliveryKey,
      spec: 'Ship the audited slice',
      runId: losingRunId,
      createdByTerminalHandle: losingRunId === firstRun.id ? 'term_first' : 'term_second'
    })
    expect(afterRestart).toMatchObject({
      task: { id: created.task.id, run_id: created.task.run_id },
      delivery: {
        task_id: created.task.id,
        run_id: created.task.run_id,
        disposition: 'adopted'
      }
    })
    expect(restarted.listTasks()).toHaveLength(1)
  })

  it('retries normally after a crash before the atomic Task effect begins', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-before-effect-'))
    directories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const harness = createHarness(dbPath, 'before-effect')
    const request = createRequest(
      harness,
      'mutation_delivery_before_effect',
      'backlog:hidden-layer:TASK-BEFORE-EFFECT:v1',
      'Create only after restart'
    )
    const identity = mutationIdentity(harness, request)
    vi.spyOn(harness.db, 'createOrAdoptRootTask').mockImplementationOnce(() => {
      throw new Error('simulated crash before the atomic transaction')
    })

    const interrupted = await harness.dispatcher.dispatch(request)
    expect(interrupted).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
    expect(
      harness.db.getMutationReceipt(identity.callerFingerprint, identity.requestId)
    ).toBeUndefined()
    vi.restoreAllMocks()

    closeHarness(harness)
    const restarted = createHarness(dbPath, 'before-effect', harness)
    const recovered = successResult(await restarted.dispatcher.dispatch(request))

    expect(recovered).toMatchObject({
      delivery: { disposition: 'created' },
      mutation: { requestId: 'mutation_delivery_before_effect', replayed: false }
    })
    expect(restarted.db.listTasks({ runId: harness.runId })).toHaveLength(1)
  })

  it('fails closed for a legacy pending mutation without an atomic binding checkpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-orphan-pending-'))
    directories.push(directory)
    const harness = createHarness(join(directory, 'orchestration.db'), 'orphan-pending')
    const request = createRequest(
      harness,
      'mutation_delivery_orphan_pending',
      'backlog:hidden-layer:TASK-ORPHAN-PENDING:v1',
      'Never resurrect an unproven effect'
    )
    seedOrphanPendingMutation(harness, request)

    const result = await harness.dispatcher.dispatch(request)

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'operation_unknown',
        data: { requestId: 'mutation_delivery_orphan_pending' }
      }
    })
    expect(harness.db.listTasks()).toEqual([])
    expect(harness.db.db.prepare('SELECT * FROM task_delivery_keys').all()).toEqual([])
  })

  it('adopts the exact atomic checkpoint after a crash following the Task effect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-after-effect-'))
    directories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const harness = createHarness(dbPath, 'after-effect')
    const request = createRequest(
      harness,
      'mutation_delivery_after_effect',
      'backlog:hidden-layer:TASK-AFTER-EFFECT:v1',
      'Recover the exact atomic delivery'
    )
    const seeded = createPendingDelivery(harness, request)
    const identity = mutationIdentity(harness, request)
    const pending = harness.db.getMutationReceipt(identity.callerFingerprint, identity.requestId)
    expect(pending).toMatchObject({ state: 'pending' })
    expect(harness.db.isCurrentTaskDeliveryMutationCheckpoint(pending?.receipt ?? null)).toBe(true)

    closeHarness(harness)
    const restarted = createHarness(dbPath, 'after-effect', harness)
    const recovered = successResult(await restarted.dispatcher.dispatch(request))

    expect(recovered).toMatchObject({
      task: { id: seeded.task.id, run_id: harness.runId },
      delivery: {
        delivery_key: seeded.delivery.delivery_key,
        contract_sha256: seeded.delivery.contract_sha256,
        task_id: seeded.task.id,
        run_id: harness.runId,
        disposition: 'adopted'
      },
      mutation: { requestId: 'mutation_delivery_after_effect', replayed: true }
    })
    expect(restarted.db.listTasks({ runId: harness.runId })).toHaveLength(1)
  })

  it.each(['resetTasks', 'resetAll', 'delete'] as const)(
    'does not recreate a pending Task delivery after %s removes its binding',
    async (removal) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-pending-removal-'))
      directories.push(directory)
      const dbPath = join(directory, 'orchestration.db')
      const harness = createHarness(dbPath, removal)
      const requestId = `mutation_pending_${removal}`
      const request = createRequest(
        harness,
        requestId,
        `backlog:hidden-layer:TASK-PENDING-${removal}:v1`,
        'Do not recreate this Task'
      )
      const original = createPendingDelivery(harness, request)
      if (removal === 'resetTasks') {
        harness.db.resetTasks()
      } else if (removal === 'resetAll') {
        harness.db.resetAll()
      } else {
        harness.db.db.prepare('DELETE FROM tasks WHERE id = ?').run(original.task.id)
      }
      closeHarness(harness)
      const restarted = createHarness(dbPath, removal, harness)

      const replay = await restarted.dispatcher.dispatch(request)

      expect(replay).toMatchObject({
        ok: false,
        error: { code: 'operation_unknown', data: { requestId } }
      })
      expect(JSON.stringify(replay)).not.toContain(original.task.id)
      expect(restarted.db.db.prepare('SELECT * FROM task_delivery_keys').all()).toEqual([])
      expect(restarted.db.listTasks()).toEqual([])
    }
  )

  it.each([
    ['same', 'Original execution contract'],
    ['different', 'Replacement execution contract']
  ] as const)(
    'rejects a stale pending checkpoint after a %s-contract rebind',
    async (contractKind, replacementSpec) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-pending-rebind-'))
      directories.push(directory)
      const dbPath = join(directory, 'orchestration.db')
      const harness = createHarness(dbPath, `rebind-${contractKind}`)
      const requestId = `mutation_pending_rebind_${contractKind}`
      const deliveryKey = `backlog:hidden-layer:TASK-PENDING-REBIND-${contractKind}:v1`
      const originalSpec = 'Original execution contract'
      const request = createRequest(harness, requestId, deliveryKey, originalSpec)
      const original = createPendingDelivery(harness, request)
      harness.db.db.prepare('DELETE FROM tasks WHERE id = ?').run(original.task.id)
      const rebound = harness.db.createOrAdoptRootTask({
        deliveryKey,
        spec: replacementSpec,
        runId: harness.runId,
        createdByTerminalHandle: harness.handle
      })
      closeHarness(harness)
      const restarted = createHarness(dbPath, `rebind-${contractKind}`, harness)

      const replay = await restarted.dispatcher.dispatch(request)

      expect(replay).toMatchObject({
        ok: false,
        error: { code: 'operation_unknown', data: { requestId } }
      })
      expect(JSON.stringify(replay)).not.toContain(original.task.id)
      expect(restarted.db.listTasks()).toEqual([expect.objectContaining({ id: rebound.task.id })])
      expect(restarted.db.db.prepare('SELECT task_id FROM task_delivery_keys').all()).toEqual([
        { task_id: rebound.task.id }
      ])
    }
  )

  it('normalizes dependency semantics but rejects a changed contract without mutation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-contract-'))
    directories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const harness = createHarness(dbPath, 'contract')
    const dependencyA = harness.db.createTask({ runId: harness.runId, spec: 'Dependency A' })
    const dependencyB = harness.db.createTask({ runId: harness.runId, spec: 'Dependency B' })
    const deliveryKey = 'backlog:hidden-layer:TASK-101:contract-v1'

    const created = successResult(
      await dispatchCreate(harness, 'mutation_contract_create', deliveryKey, 'Dependent work', {
        deps: JSON.stringify([dependencyB.id, dependencyA.id, dependencyB.id]),
        taskTitle: 'First label'
      })
    )
    const adopted = successResult(
      await dispatchCreate(harness, 'mutation_contract_adopt', deliveryKey, 'Dependent work', {
        deps: JSON.stringify([dependencyA.id, dependencyB.id]),
        taskTitle: 'Presentation-only replacement'
      })
    )

    expect(adopted.delivery).toMatchObject({
      disposition: 'adopted',
      task_id: created.task.id,
      contract_sha256: created.delivery.contract_sha256
    })
    expect(harness.db.getTask(created.task.id)?.deps).toBe(
      JSON.stringify([dependencyA.id, dependencyB.id].sort())
    )
    const beforeConflict = harness.db.listTasks({ runId: harness.runId })
    const dependencyConflict = await dispatchCreate(
      harness,
      'mutation_dependency_conflict',
      deliveryKey,
      'Dependent work',
      { deps: JSON.stringify([dependencyA.id]) }
    )
    const specConflict = await dispatchCreate(
      harness,
      'mutation_spec_conflict',
      deliveryKey,
      'Changed execution contract',
      { deps: JSON.stringify([dependencyA.id, dependencyB.id]) }
    )
    for (const conflict of [dependencyConflict, specConflict]) {
      expect(conflict).toMatchObject({
        ok: false,
        error: {
          code: 'delivery_key_conflict',
          data: { effectsApplied: false, taskId: created.task.id, runId: harness.runId }
        }
      })
    }
    expect(harness.db.listTasks({ runId: harness.runId })).toEqual(beforeConflict)
  })

  it('refuses parented delivery-key Tasks before creating anything', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-root-'))
    directories.push(directory)
    const harness = createHarness(join(directory, 'orchestration.db'), 'root')
    const parent = harness.db.createTask({ runId: harness.runId, spec: 'Parent' })

    const result = await dispatchCreate(
      harness,
      'mutation_parented_delivery',
      'backlog:hidden-layer:TASK-102:contract-v1',
      'Nested work',
      { parent: parent.id }
    )

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(harness.db.listTasks({ runId: harness.runId })).toEqual([parent])
  })

  it('fails closed when a completed mutation receipt names a Task removed before rebinding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-reset-replay-'))
    directories.push(directory)
    const harness = createHarness(join(directory, 'orchestration.db'), 'reset-replay')
    const deliveryKey = 'backlog:hidden-layer:TASK-RESET:contract-v1'
    const spec = 'Rebind only after an explicit reset'
    const requestId = 'mutation_before_task_reset'
    const original = successResult(await dispatchCreate(harness, requestId, deliveryKey, spec))

    harness.db.resetTasks()
    const rebound = successResult(
      await dispatchCreate(harness, 'mutation_after_task_reset', deliveryKey, spec)
    )
    expect(rebound.delivery.disposition).toBe('created')
    expect(rebound.task.id).not.toBe(original.task.id)

    const staleReplay = await dispatchCreate(harness, requestId, deliveryKey, spec)

    expect(staleReplay).toMatchObject({
      ok: false,
      error: { code: 'operation_unknown', data: { requestId } }
    })
    expect(JSON.stringify(staleReplay)).not.toContain(original.task.id)
    expect(harness.db.listTasks()).toEqual([expect.objectContaining({ id: rebound.task.id })])
    expect(harness.db.db.prepare('SELECT task_id FROM task_delivery_keys').all()).toEqual([
      { task_id: rebound.task.id }
    ])
  })

  function createHarness(dbPath: string, name: string, existing?: Harness): Harness {
    const db = new OrchestrationDb(dbPath)
    openDatabases.add(db)
    const handle = existing?.handle ?? `term_${name}`
    const leaf = Buffer.from(name).toString('hex').padEnd(8, '0').slice(0, 8)
    const paneKey = existing?.paneKey ?? `tab_${name}:${leaf}-0000-4000-8000-000000000000`
    const runId =
      existing?.runId ??
      db.createRun({
        objective: `${name} delivery-key Run`,
        coordinatorHandle: handle,
        coordinatorPaneKey: paneKey
      }).id
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((candidate) =>
      candidate === handle ? paneKey : null
    )
    return {
      db,
      dispatcher: new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }),
      handle,
      paneKey,
      runId,
      runtime
    }
  }

  function closeHarness(harness: Harness): void {
    harness.db.close()
    openDatabases.delete(harness.db)
  }
})

let compiledDeliveryRaceWorker: string | undefined

async function raceTaskDelivery(
  dbPath: string,
  contestants: readonly [{ runId: string; handle: string }, { runId: string; handle: string }],
  deliveryKey: string,
  spec: string
): Promise<[DeliveryRaceResult, DeliveryRaceResult]> {
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const workers: Worker[] = []
  try {
    for (const contestant of contestants) {
      const worker = new Worker(getDeliveryRaceWorkerSource(), {
        eval: true,
        workerData: { dbPath, gate, deliveryKey, spec, ...contestant }
      })
      workers.push(worker)
      // Open both independent connections before releasing either transaction.
      await waitForWorkerMessage(worker, 'ready')
    }
  } catch (error) {
    await Promise.allSettled(workers.map(async (worker) => await worker.terminate()))
    throw error
  }
  const results = workers.map((worker) => waitForWorkerMessage(worker, 'result'))
  Atomics.store(new Int32Array(gate), 0, 1)
  Atomics.notify(new Int32Array(gate), 0)
  const [left, right] = await Promise.all(results)
  return [readRaceResult(left), readRaceResult(right)]
}

function getDeliveryRaceWorkerSource(): string {
  if (compiledDeliveryRaceWorker) {
    return compiledDeliveryRaceWorker
  }
  const orchestrationDbPath = resolve('src/main/runtime/orchestration/db/orchestration-db.ts')
  const output = buildSync({
    stdin: {
      contents: `
        import { parentPort, workerData } from 'node:worker_threads'
        import { OrchestrationDb } from ${JSON.stringify(orchestrationDbPath)}

        const port = parentPort
        if (!port) throw new Error('Delivery race worker requires a parent port.')
        const gate = new Int32Array(workerData.gate)
        const db = new OrchestrationDb(workerData.dbPath)
        port.postMessage({ kind: 'ready' })
        Atomics.wait(gate, 0, 0)
        let message
        try {
          const result = db.createOrAdoptRootTask({
            deliveryKey: workerData.deliveryKey,
            spec: workerData.spec,
            runId: workerData.runId,
            createdByTerminalHandle: workerData.handle
          })
          message = { kind: 'result', result }
        } catch (error) {
          message = {
            kind: 'result',
            error: {
              code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
              message: error instanceof Error ? error.message : String(error)
            }
          }
        } finally {
          db.close()
        }
        port.postMessage(message)
      `,
      loader: 'ts',
      resolveDir: process.cwd()
    },
    bundle: true,
    define: { ORCA_FEATURE_WALL_ENABLED: 'true' },
    format: 'cjs',
    logLevel: 'silent',
    platform: 'node',
    target: 'node22',
    write: false
  }).outputFiles[0]?.text
  if (!output) {
    throw new Error('Failed to compile the Task delivery-key race worker.')
  }
  compiledDeliveryRaceWorker = output
  return output
}

function waitForWorkerMessage(worker: Worker, kind: 'ready' | 'result'): Promise<unknown> {
  return new Promise((resolveMessage, rejectMessage) => {
    const onMessage = (message: unknown): void => {
      const record = objectRecord(message)
      if (record?.kind !== kind) {
        return
      }
      cleanup()
      resolveMessage(message)
    }
    const onError = (error: Error): void => {
      cleanup()
      rejectMessage(error)
    }
    const onExit = (code: number): void => {
      cleanup()
      rejectMessage(new Error(`Task delivery-key race worker exited before ${kind} (${code}).`))
    }
    const cleanup = (): void => {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    worker.on('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
  })
}

function readRaceResult(message: unknown): DeliveryRaceResult {
  const record = objectRecord(message)
  if (record?.error) {
    throw new Error(`Task delivery-key race failed: ${JSON.stringify(record.error)}`)
  }
  const result = record?.result
  if (!result || typeof result !== 'object') {
    throw new Error('Task delivery-key race returned no result.')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the production result is asserted structurally by the test before its fields establish the race winner.
  return result as DeliveryRaceResult
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guards above establish a non-array object whose fields remain unknown.
  return value as Record<string, unknown>
}

async function dispatchCreate(
  harness: Harness,
  mutationId: string,
  deliveryKey: string,
  spec: string,
  extra: { deps?: string; parent?: string; taskTitle?: string } = {}
): Promise<RpcResponse> {
  return await harness.dispatcher.dispatch(
    createRequest(harness, mutationId, deliveryKey, spec, extra)
  )
}

function createRequest(
  harness: Harness,
  mutationId: string,
  deliveryKey: string,
  spec: string,
  extra: { deps?: string; parent?: string; taskTitle?: string } = {}
): RpcRequest {
  const request: RpcRequest = {
    id: `rpc_${mutationId}`,
    authToken: 'local-test-token',
    method: 'orchestration.taskCreateByDeliveryKey',
    params: {
      deliveryKey,
      spec,
      ...extra,
      run: harness.runId,
      callerTerminalHandle: harness.handle
    },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: mutationId
  }
  return request
}

function mutationIdentity(harness: Harness, request: RpcRequest): MutationIdentity {
  if (!request.orchestrationRequestId) {
    throw new Error('Recovery fixture requires a durable mutation ID.')
  }
  return {
    callerFingerprint: harness.db.getOrCreateLocalMutationCallerFingerprint(),
    requestId: request.orchestrationRequestId,
    method: request.method,
    payloadHash: hashCanonical({
      method: request.method,
      params: replayStableCallerParams(harness.runtime, request.params)
    })
  }
}

function seedOrphanPendingMutation(harness: Harness, request: RpcRequest): void {
  harness.db.beginMutationReceipt(mutationIdentity(harness, request))
}

function createPendingDelivery(
  harness: Harness,
  request: RpcRequest
): ReturnType<OrchestrationDb['createOrAdoptRootTask']> {
  const params = objectRecord(request.params)
  if (
    typeof params?.deliveryKey !== 'string' ||
    typeof params.spec !== 'string' ||
    typeof params.run !== 'string'
  ) {
    throw new Error('Pending delivery fixture requires valid Task delivery params.')
  }
  return harness.db.createOrAdoptRootTask({
    deliveryKey: params.deliveryKey,
    spec: params.spec,
    runId: params.run,
    createdByTerminalHandle: harness.handle,
    mutationReceipt: mutationIdentity(harness, request)
  })
}

function successResult(response: RpcResponse): TaskDeliveryRpcResult {
  expect(response.ok).toBe(true)
  if (response.ok === false) {
    throw new Error(response.error.message)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the assertions above and test-only structural checks validate this typed fixture boundary.
  return response.result as TaskDeliveryRpcResult
}
