import {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID
} from '../../../../orchestration/lab-profile/codex-lab-launch-contract'

export {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID
} from '../../../../orchestration/lab-profile/codex-lab-launch-contract'

export type LabExecutionProfileAdapter = Readonly<{
  profile: typeof LAB_READONLY_SUPERVISED_PROFILE_ID
  adapter: typeof CODEX_WORKSPACE_CHATGPT_ADAPTER_ID
  agent: 'codex'
  maxConcurrency: 1
}>

const CODEX_WORKSPACE_ADAPTER: LabExecutionProfileAdapter = Object.freeze({
  profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
  adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  agent: 'codex',
  maxConcurrency: 1
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
