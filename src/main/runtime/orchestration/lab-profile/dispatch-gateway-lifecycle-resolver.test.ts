import { describe, expect, it } from 'vitest'
import type { DispatchContextRow, WorkerDispatchRow } from '../types'
import { createLabGatewayLifecycleResolver } from './dispatch-gateway-lifecycle-resolver'

const PROFILE_ID = 'lab-readonly-supervised-v1'
const RUNTIME_EPOCH = 'runtime_task_757'
const CAPABILITY_HASH = 'a'.repeat(64)

function dispatch(overrides: Partial<DispatchContextRow> = {}): DispatchContextRow {
  return {
    id: 'dispatch_757',
    run_id: 'run_757',
    task_id: 'task_757',
    contract_version: 1,
    launch_token_hash: null,
    assignee_handle: 'term_lab',
    assignee_pane_key: 'pane_lab',
    capability_hash: CAPABILITY_HASH,
    process_incarnation: 'process_lab',
    capability_revoked_at: null,
    retry_of_dispatch_id: null,
    creator_dispatch_id: null,
    creator_handle: 'term_coord',
    creator_pane_key: 'pane_coord',
    host_scope: null,
    status: 'pending',
    failure_count: 0,
    last_failure: null,
    termination_reason: null,
    depth: 1,
    consumer_generation: 0,
    dispatched_at: null,
    completed_at: null,
    created_at: '2026-09-17T00:00:00.000Z',
    last_heartbeat_at: null,
    ...overrides
  }
}

function worker(overrides: Partial<WorkerDispatchRow> = {}): WorkerDispatchRow {
  return {
    dispatch_id: 'dispatch_757',
    runtime_epoch: RUNTIME_EPOCH,
    state: 'starting',
    stage: 'authority_attached',
    worktree_id: 'worktree_757',
    agent_terminal_handle: 'term_lab',
    setup_state: 'not_applicable',
    effects: '[]',
    residual_resources: '[]',
    start_options: JSON.stringify({ profile: { id: PROFILE_ID } }),
    last_error: null,
    created_at: '2026-09-17T00:00:00.000Z',
    updated_at: '2026-09-17T00:00:00.000Z',
    ...overrides
  }
}

function harness(args: {
  dispatch?: DispatchContextRow
  worker?: WorkerDispatchRow
  runtimeEpoch?: string
  profileId?: string
}) {
  const dispatchRow = args.dispatch
  const workerRow = args.worker
  return createLabGatewayLifecycleResolver({
    db: {
      getDispatchContextById: () => dispatchRow,
      getWorkerDispatch: () => workerRow
    },
    runtimeEpoch: args.runtimeEpoch ?? RUNTIME_EPOCH,
    profileId: args.profileId ?? PROFILE_ID
  })
}

describe('laboratory gateway canonical lifecycle resolver', () => {
  it('returns the exact active Dispatch binding and stored capability hash', async () => {
    const resolve = harness({ dispatch: dispatch(), worker: worker() })

    await expect(resolve('dispatch_757')).resolves.toEqual({
      binding: {
        runId: 'run_757',
        taskId: 'task_757',
        dispatchId: 'dispatch_757',
        terminalHandle: 'term_lab',
        terminalPaneKey: 'pane_lab'
      },
      processIncarnation: 'process_lab',
      dispatchCapabilitySha256: CAPABILITY_HASH,
      authorityState: 'active'
    })
  })

  it.each([
    ['runtime epoch', worker({ runtime_epoch: 'runtime_old' })],
    ['worker Dispatch identity', worker({ dispatch_id: 'dispatch_other' })],
    ['worker terminal identity', worker({ agent_terminal_handle: 'term_other' })],
    ['profile', worker({ start_options: JSON.stringify({ profile: { id: 'broader' } }) })],
    ['malformed start options', worker({ start_options: '{' })],
    ['ambiguous worker state', worker({ state: 'start_unknown' })]
  ])('fails closed when the %s is not canonical', async (_label, workerRow) => {
    const resolve = harness({ dispatch: dispatch(), worker: workerRow })

    await expect(resolve('dispatch_757')).resolves.toMatchObject({ authorityState: 'invalid' })
  })

  it('reports revocation before any otherwise-active state', async () => {
    const resolve = harness({
      dispatch: dispatch({ capability_revoked_at: '2026-09-17T00:01:00.000Z' }),
      worker: worker()
    })

    await expect(resolve('dispatch_757')).resolves.toMatchObject({ authorityState: 'revoked' })
  })

  it.each([
    [dispatch({ status: 'completed' }), worker({ state: 'succeeded' })],
    [dispatch({ status: 'failed' }), worker({ state: 'failed' })],
    [dispatch({ status: 'dispatched' }), worker({ state: 'stopped' })]
  ])('reports settled lifecycle rows', async (dispatchRow, workerRow) => {
    const resolve = harness({ dispatch: dispatchRow, worker: workerRow })

    await expect(resolve('dispatch_757')).resolves.toMatchObject({ authorityState: 'settled' })
  })

  it.each([
    [undefined, worker()],
    [dispatch(), undefined],
    [dispatch({ capability_hash: null }), worker()],
    [dispatch({ assignee_pane_key: null }), worker()],
    [dispatch({ process_incarnation: '' }), worker()]
  ])('returns no authority for incomplete canonical rows', async (dispatchRow, workerRow) => {
    const resolve = harness({ dispatch: dispatchRow, worker: workerRow })

    await expect(resolve('dispatch_757')).resolves.toBeNull()
  })

  it('refuses an empty captured runtime or profile identity', () => {
    expect(() => harness({ runtimeEpoch: '', dispatch: dispatch(), worker: worker() })).toThrow(
      'lifecycle identity must be non-empty'
    )
    expect(() => harness({ profileId: '', dispatch: dispatch(), worker: worker() })).toThrow(
      'lifecycle identity must be non-empty'
    )
  })
})
