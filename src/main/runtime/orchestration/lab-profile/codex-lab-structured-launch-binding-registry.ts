/**
 * Public read-only view of the in-memory launch binding registry. Mutation is deliberately kept
 * behind the worker-session pre-attach boundary (plus its scoped test helper).
 */
export {
  CODEX_LAB_STRUCTURED_BINDING_REFUSAL_CODE,
  CodexLabStructuredBindingRefusal,
  getCodexLabStructuredLaunchBinding,
  type CodexLabStructuredLaunchBinding
} from './codex-lab-structured-launch-binding-registry-state'
