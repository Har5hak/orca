import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'

export type WorkerTerminalResourceRelation = {
  resource: WorkerTerminalResourceRow
  relation: 'current_owner' | 'former_owner'
}

/** Shared by detail and inventory scans so malformed lineage cannot classify them differently. */
export const WORKER_TERMINAL_RESOURCE_RELATION_CTES = `
  prior_resource_relations AS MATERIALIZED (
    SELECT prior_owner.value AS dispatch_id,
           prior_resource.id AS resource_id,
           prior_resource.updated_at,
           1 AS relation_priority
      FROM worker_terminal_resources prior_resource
      JOIN json_each(
        CASE
          WHEN NOT json_valid(prior_resource.prior_owner_dispatch_ids) THEN '[]'
          WHEN json_type(prior_resource.prior_owner_dispatch_ids) <> 'array' THEN '[]'
          WHEN EXISTS (
            SELECT 1 FROM json_each(prior_resource.prior_owner_dispatch_ids) invalid_prior_owner
             WHERE invalid_prior_owner.type <> 'text'
          ) THEN '[]'
          ELSE prior_resource.prior_owner_dispatch_ids
        END
      ) prior_owner
      JOIN wanted_dispatches wanted ON wanted.dispatch_id = prior_owner.value
  ),
  resource_relation_candidates AS MATERIALIZED (
    SELECT wanted.dispatch_id,
           current_resource.id AS resource_id,
           current_resource.updated_at,
           0 AS relation_priority
      FROM wanted_dispatches wanted
      JOIN worker_terminal_resources current_resource
        ON current_resource.owner_dispatch_id = wanted.dispatch_id
    UNION ALL
    SELECT dispatch_id, resource_id, updated_at, relation_priority
      FROM prior_resource_relations
  ),
  ranked_resource_relations AS MATERIALIZED (
    SELECT dispatch_id, resource_id, relation_priority,
           ROW_NUMBER() OVER (
             PARTITION BY dispatch_id
             ORDER BY relation_priority ASC, updated_at DESC, resource_id DESC
           ) AS relation_rank
      FROM resource_relation_candidates
  )`

/** Resolves current custody first, then the newest resource that records prior custody. */
export function readWorkerTerminalResourceRelations(
  db: OrchestrationDb,
  dispatchIds: readonly string[]
): Map<string, WorkerTerminalResourceRelation> {
  if (dispatchIds.length === 0) {
    return new Map()
  }
  const soleDispatchId = dispatchIds.length === 1 ? dispatchIds[0] : undefined
  if (soleDispatchId !== undefined) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The query selects every WorkerTerminalResourceRow column from its defining table.
    const current = db.db
      .prepare('SELECT * FROM worker_terminal_resources WHERE owner_dispatch_id = ?')
      .get(soleDispatchId) as WorkerTerminalResourceRow | undefined
    if (current) {
      return new Map([[soleDispatchId, { resource: current, relation: 'current_owner' as const }]])
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The query selects every resource column plus its validated relation metadata.
  const rows = db.db
    .prepare(
      `WITH wanted_dispatches(dispatch_id) AS MATERIALIZED (
         SELECT value FROM json_each(?)
       ),
       ${WORKER_TERMINAL_RESOURCE_RELATION_CTES}
       SELECT relation.dispatch_id, relation.relation_priority, resource.*
         FROM ranked_resource_relations relation
         JOIN worker_terminal_resources resource ON resource.id = relation.resource_id
        WHERE relation.relation_rank = 1`
    )
    .all(JSON.stringify(dispatchIds)) as (WorkerTerminalResourceRow & {
    dispatch_id: string
    relation_priority: number
  })[]
  const relations = new Map<string, WorkerTerminalResourceRelation>()
  for (const row of rows) {
    const { dispatch_id: dispatchId, relation_priority: relationPriority, ...resource } = row
    relations.set(dispatchId, {
      resource,
      relation: relationPriority === 0 ? 'current_owner' : 'former_owner'
    })
  }
  return relations
}
