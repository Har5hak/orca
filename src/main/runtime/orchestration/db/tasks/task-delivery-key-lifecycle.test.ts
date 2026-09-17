import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskCreateByDeliveryKeyParams } from '../../../../../shared/rpc-contract/orchestration-params'
import Database from '../../../../sqlite/sync-database'
import { SCHEMA_VERSION } from '../contract-constants'
import { OrchestrationDb } from '../orchestration-db'

describe('Task delivery-key validation and lifecycle', () => {
  const directories: string[] = []
  const databases = new Set<OrchestrationDb>()

  afterEach(() => {
    for (const db of databases) {
      db.close()
    }
    databases.clear()
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['one ASCII code point', 'k'],
    ['one astral Unicode code point', '🚀'],
    ['512 ASCII code points', 'k'.repeat(512)],
    ['512 astral Unicode code points', '🚀'.repeat(512)]
  ])('accepts %s through shared, direct DB, and raw schema validation', (_label, deliveryKey) => {
    expect(TaskCreateByDeliveryKeyParams.safeParse({ spec: 'work', deliveryKey }).success).toBe(
      true
    )
    const direct = createDb()
    expect(
      direct.db.createOrAdoptRootTask({
        deliveryKey,
        spec: 'direct validation work',
        runId: direct.runId
      }).delivery.disposition
    ).toBe('created')

    const raw = createDb()
    const rawTask = raw.db.createTask({ runId: raw.runId, spec: 'raw schema validation work' })
    expect(() => insertRawDeliveryKey(raw.db, rawTask.id, deliveryKey)).not.toThrow()
  })

  it.each([
    ['513 ASCII code points', 'k'.repeat(513)],
    ['513 astral Unicode code points', '🚀'.repeat(513)]
  ])(
    'rejects %s consistently through shared, direct DB, and raw schema validation',
    (_label, deliveryKey) => {
      const shared = TaskCreateByDeliveryKeyParams.safeParse({ spec: 'work', deliveryKey })
      expect(shared.success).toBe(false)
      if (!shared.success) {
        expect(shared.error.issues.map((issue) => issue.message).join('\n')).toContain(
          'Unicode code points'
        )
        expect(shared.error.issues.map((issue) => issue.message).join('\n')).not.toContain('NUL')
      }

      const direct = createDb()
      expect(() =>
        direct.db.createOrAdoptRootTask({ deliveryKey, spec: 'work', runId: direct.runId })
      ).toThrow(/Unicode code points/)
      expect(direct.db.listTasks()).toEqual([])

      const raw = createDb()
      const rawTask = raw.db.createTask({ runId: raw.runId, spec: 'raw rejected work' })
      expect(() => insertRawDeliveryKey(raw.db, rawTask.id, deliveryKey)).toThrow(
        /CHECK constraint failed/
      )
      expect(raw.db.db.prepare('SELECT * FROM task_delivery_keys').all()).toEqual([])
    }
  )

  it('reports NUL separately and rejects it through shared, direct DB, and raw schema validation', () => {
    const deliveryKey = 'backlog:TASK\0contract'
    const shared = TaskCreateByDeliveryKeyParams.safeParse({ spec: 'work', deliveryKey })
    expect(shared.success).toBe(false)
    if (!shared.success) {
      const messages = shared.error.issues.map((issue) => issue.message).join('\n')
      expect(messages).toContain('NUL')
      expect(messages).not.toContain('Unicode code points')
    }

    const direct = createDb()
    expect(() =>
      direct.db.createOrAdoptRootTask({ deliveryKey, spec: 'work', runId: direct.runId })
    ).toThrow(/NUL/)
    expect(direct.db.listTasks()).toEqual([])

    const raw = createDb()
    const rawTask = raw.db.createTask({ runId: raw.runId, spec: 'raw NUL work' })
    expect(() => insertRawDeliveryKey(raw.db, rawTask.id, deliveryKey)).toThrow(
      /CHECK constraint failed/
    )
    expect(raw.db.db.prepare('SELECT * FROM task_delivery_keys').all()).toEqual([])
  })

  it('releases a key when its Task is deleted', () => {
    const { db, runId } = createDb()
    const first = createDelivery(db, runId, 'backlog:TASK-DELETE:v1')

    db.db.prepare('DELETE FROM tasks WHERE id = ?').run(first.task.id)

    expect(db.db.prepare('SELECT * FROM task_delivery_keys').all()).toEqual([])
    const rebound = createDelivery(db, runId, 'backlog:TASK-DELETE:v1')
    expect(rebound.delivery.disposition).toBe('created')
    expect(rebound.task.id).not.toBe(first.task.id)
  })

  it('releases every key during resetTasks', () => {
    const { db, runId } = createDb()
    const first = createDelivery(db, runId, 'backlog:TASK-RESET-TASKS:v1')

    db.resetTasks()

    expect(db.db.prepare('SELECT * FROM task_delivery_keys').all()).toEqual([])
    const rebound = createDelivery(db, runId, 'backlog:TASK-RESET-TASKS:v1')
    expect(rebound.delivery.disposition).toBe('created')
    expect(rebound.task.id).not.toBe(first.task.id)
  })

  it('releases every key during resetAll', () => {
    const { db, runId } = createDb()
    const first = createDelivery(db, runId, 'backlog:TASK-RESET-ALL:v1')

    db.resetAll()

    expect(db.db.prepare('SELECT * FROM task_delivery_keys').all()).toEqual([])
    const replacementRunId = createRun(db, 'after-reset-all')
    const rebound = createDelivery(db, replacementRunId, 'backlog:TASK-RESET-ALL:v1')
    expect(rebound.delivery.disposition).toBe('created')
    expect(rebound.task.id).not.toBe(first.task.id)
  })

  it('upgrades a genuine v41-like fixture without losing its pre-existing Run or Task', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-version-skew-'))
    directories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const current = track(new OrchestrationDb(dbPath))
    const runId = createRun(current, 'version-skew')
    const task = current.createTask({ runId, spec: 'Task written before the v42 upgrade' })
    const runBefore = current.getRun(runId)
    const taskBefore = current.getTask(task.id)
    close(current)

    const oldWriter = new Database(dbPath)
    oldWriter.exec(
      'DROP TRIGGER IF EXISTS trg_tasks_delete_delivery_key; DROP TABLE IF EXISTS task_delivery_keys;'
    )
    oldWriter.pragma('user_version = 41')
    expect(
      oldWriter
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_delivery_keys'"
        )
        .get()
    ).toBeUndefined()
    expect(oldWriter.prepare('SELECT id FROM runs WHERE id = ?').get(runId)).toEqual({ id: runId })
    expect(oldWriter.prepare('SELECT id FROM tasks WHERE id = ?').get(task.id)).toEqual({
      id: task.id
    })
    oldWriter.close()

    const reopened = track(new OrchestrationDb(dbPath))
    expect(reopened.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(reopened.getRun(runId)).toEqual(runBefore)
    expect(reopened.getTask(task.id)).toEqual(taskBefore)
    expect(reopened.db.prepare('SELECT * FROM task_delivery_keys').all()).toEqual([])

    const delivered = createDelivery(reopened, runId, 'backlog:TASK-VERSION-SKEW:v1')
    expect(delivered.delivery.disposition).toBe('created')
    expect(reopened.getTask(task.id)).toEqual(taskBefore)
  })

  function createDb(): { db: OrchestrationDb; runId: string } {
    const directory = mkdtempSync(join(tmpdir(), 'orca-task-delivery-lifecycle-'))
    directories.push(directory)
    const db = track(new OrchestrationDb(join(directory, 'orchestration.db')))
    return { db, runId: createRun(db, `run-${directories.length}`) }
  }

  function track(db: OrchestrationDb): OrchestrationDb {
    databases.add(db)
    return db
  }

  function close(db: OrchestrationDb): void {
    db.close()
    databases.delete(db)
  }
})

function createRun(db: OrchestrationDb, name: string): string {
  return db.createRun({
    objective: `${name} delivery-key lifecycle`,
    coordinatorHandle: `term_${name}`,
    coordinatorPaneKey: `tab_${name}:11111111-1111-4111-8111-111111111111`
  }).id
}

function createDelivery(db: OrchestrationDb, runId: string, deliveryKey: string) {
  return db.createOrAdoptRootTask({ deliveryKey, spec: `deliver ${deliveryKey}`, runId })
}

function insertRawDeliveryKey(db: OrchestrationDb, taskId: string, deliveryKey: string): void {
  db.db
    .prepare(
      `INSERT INTO task_delivery_keys (delivery_key, contract_sha256, task_id)
       VALUES (?, ?, ?)`
    )
    .run(deliveryKey, 'a'.repeat(64), taskId)
}
