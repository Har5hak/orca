import {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY
} from '../../../../orchestration/lab-profile/codex-lab-launch-contract'

export {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY
} from '../../../../orchestration/lab-profile/codex-lab-launch-contract'

export type LabExecutionProfileAdapter = Readonly<{
  profile: typeof LAB_READONLY_SUPERVISED_PROFILE_ID
  adapter: typeof CODEX_WORKSPACE_CHATGPT_ADAPTER_ID
  agent: 'codex'
  maxConcurrency: typeof LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY
}>

const CODEX_WORKSPACE_ADAPTER: LabExecutionProfileAdapter = Object.freeze({
  profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
  adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  agent: 'codex',
  maxConcurrency: LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY
})

const LAB_EXECUTION_PROFILE_ADAPTERS: readonly LabExecutionProfileAdapter[] = Object.freeze([
  CODEX_WORKSPACE_ADAPTER
])

export function listLabExecutionProfileAdapters(): readonly LabExecutionProfileAdapter[] {
  return LAB_EXECUTION_PROFILE_ADAPTERS
}

export function resolveLabExecutionProfileAdapter(
  profile: string,
  adapter: string
): LabExecutionProfileAdapter | undefined {
  return LAB_EXECUTION_PROFILE_ADAPTERS.find(
    (entry) => entry.profile === profile && entry.adapter === adapter
  )
}
