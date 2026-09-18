/**
 * Mutation-only facade. A source contract limits imports of this module to the structured worker
 * session boundary and the scoped test installer.
 */
export {
  registerCodexLabStructuredLaunchBinding,
  releaseCodexLabStructuredLaunchBinding
} from './codex-lab-structured-launch-binding-registry-state'
