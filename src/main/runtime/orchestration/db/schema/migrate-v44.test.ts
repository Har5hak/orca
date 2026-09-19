import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { expectedCodexLabDispatchRuntimeRoot } from '../lab-runtime-custody/lab-runtime-custody-validation'
import { migrateV44 } from './migrate-v44'

const DISPATCH_ID = 'ctx_111111111111'

describe('v44 Codex laboratory custody migration', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('makes a pre-v44 unreceipted launch cleanup-only even if the column already exists', () => {
    const d = (db = new OrchestrationDb(':memory:'))
    d.db
      .prepare(
        `INSERT INTO codex_lab_runtime_custody (
           dispatch_id, profile_id, state, runtime_root
         ) VALUES (?, 'lab-readonly-supervised-v1', 'ready', ?)`
      )
      .run(DISPATCH_ID, expectedCodexLabDispatchRuntimeRoot(DISPATCH_ID))

    migrateV44.call(d, 43)

    expect(d.getCodexLabRuntimeCustody(DISPATCH_ID)).toMatchObject({
      dispatchId: DISPATCH_ID,
      state: 'cleanup_pending',
      launchReceipt: null,
      revision: 1
    })
  })
})
