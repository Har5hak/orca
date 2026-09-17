// How a durable session record becomes a Codex process launch.
//
// Every input is read back from the record the store already made durable, not
// from the call that triggered the acquire. A client that attaches twice must
// land in the same working directory under the same account home, and a resume
// must name the thread this session actually proved — never one a caller asks
// for, which is how a resume becomes a fork wearing a resume's name.

import { posix } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveCodexCommand } from '../codex-cli/command'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { CodexStructuredLaunch } from './codex-structured-session-adapter'
import type { CodexStructuredPermissionPolicy } from './codex-structured-permission-policy'
import { CODEX_LAB_READONLY_PERMISSION_PROFILE_ID } from './codex-structured-permission-policy'
import { resolvePinnedCodexRolloutProof } from './codex-tui-rollout-proof'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'
import {
  CodexLabStructuredBindingRefusal,
  getCodexLabStructuredLaunchBinding,
  type CodexLabStructuredLaunchBinding
} from '../runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import { CODEX_LAB_RUNTIME_ROOT } from '../runtime/orchestration/lab-profile/codex-lab-launch-contract'

export type CodexStructuredLaunchResolverDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  /** Absolute path of a workspace on this host. Rejects when the workspace no
   *  longer resolves, which is the case a stale mobile client hits. */
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Overridden in tests; production scans the boot-cached PATH and version-manager dirs. */
  resolveCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  /** Fresh shell/configured environment for this spawn; never written to the session record. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveRollout?: typeof resolvePinnedCodexRolloutProof
  /** Test seam for the host capability; production uses the native process table. */
  isWindowsProcessStartTimeAvailable?: () => boolean
  /** The user's Agent Permissions setting as thread policy, re-read per acquisition.
   *  States both postures outright — a resume inherits the last one for any field left absent. */
  resolvePermissionPolicy?: () => CodexStructuredPermissionPolicy
}

export function createCodexStructuredLaunchResolver(
  deps: CodexStructuredLaunchResolverDeps
): (input: { identity: AgentSessionJournalIdentity }) => Promise<CodexStructuredLaunch> {
  return async ({ identity }) => {
    const record = deps.store.getRecord(identity.sessionId)
    if (!record) {
      throw new Error(`no durable agent-session record for ${identity.sessionId}`)
    }
    const { location, accountHome } = record
    if (record.provider !== 'codex') {
      throw new Error(`session ${identity.sessionId} is a ${record.provider} session`)
    }
    // This adapter spawns a child on the machine the runtime itself runs on.
    // A session pinned elsewhere belongs to that host's runtime, and quietly
    // starting it here would put a second writer on the same thread.
    if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID || location.wslDistro !== null) {
      throw new Error(
        `codex structured sessions run on the local host, not ${location.executionHostId}`
      )
    }
    // Refuse before resolving launch data; a PID alone cannot prove Windows ownership.
    if (
      process.platform === 'win32' &&
      !(deps.isWindowsProcessStartTimeAvailable ?? isWindowsProcessStartTimeAvailable)()
    ) {
      throw new Error('codex structured sessions require Windows process creation-time proof')
    }
    if (accountHome.variable !== 'CODEX_HOME') {
      throw new Error(`codex sessions pin CODEX_HOME, not ${accountHome.variable}`)
    }
    const labBinding = getCodexLabStructuredLaunchBinding(identity.sessionId)
    if (labBinding) {
      return resolveCodexLabStructuredLaunch(
        identity.sessionId,
        record,
        labBinding,
        await deps.resolveWorkspacePath(location.workspaceId)
      )
    }
    if (isCodexLabRuntimePath(accountHome.path)) {
      throw new CodexLabStructuredBindingRefusal('binding_missing')
    }
    const environment = await deps.resolveEnvironment?.()
    const pathEnv = environment?.PATH ?? environment?.Path ?? null
    const homePath = environment?.HOME ?? environment?.USERPROFILE
    const command = (deps.resolveCommand ?? resolveCodexCommand)({
      pathEnv,
      ...(homePath ? { homePath } : {})
    })
    // `record.launchArgs` is deliberately not read: the configured CLI arguments are a terminal
    // concern, and the permission posture they used to smuggle in is derived per acquisition.
    const permissionPolicy = deps.resolvePermissionPolicy?.()
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    const resumeThreadId = head?.handle.provider === 'codex' ? head.handle.threadId : null
    return {
      command,
      args: ['app-server'],
      cwd: await deps.resolveWorkspacePath(location.workspaceId),
      codexHome: accountHome.path,
      ...(environment ? { env: { ...environment } as Record<string, string> } : {}),
      // An empty chain is a session that has never proved a thread, so it
      // starts one; anything else resumes the last link this session proved.
      resumeThreadId,
      ...(permissionPolicy ? { permissionPolicy } : {}),
      ...(resumeThreadId
        ? {
            resumePath: await (deps.resolveRollout ?? resolvePinnedCodexRolloutProof)(
              accountHome.path,
              resumeThreadId
            )
          }
        : {})
    }
  }
}

function isCodexLabRuntimePath(candidate: string): boolean {
  const relative = posix.relative(CODEX_LAB_RUNTIME_ROOT, candidate)
  return relative === '' || (!relative.startsWith('../') && !posix.isAbsolute(relative))
}

function resolveCodexLabStructuredLaunch(
  sessionId: string,
  record: AgentSessionRecord,
  binding: CodexLabStructuredLaunchBinding,
  workspacePath: string
): CodexStructuredLaunch {
  const { plan, worktree } = binding
  if (
    record.sessionId !== sessionId ||
    record.location.workspaceKind !== 'git-worktree' ||
    record.accountHome.variable !== 'CODEX_HOME' ||
    record.accountHome.path !== plan.runtimePaths.codexHome ||
    record.providerHandleChain.length !== 0 ||
    workspacePath !== plan.cwd ||
    workspacePath !== worktree.observation.realpath ||
    worktree.receipt.worktreePath !== workspacePath
  ) {
    throw new Error('Codex lab launch binding does not match the durable session record.')
  }
  return {
    command: plan.executable,
    args: [...plan.argv],
    cwd: workspacePath,
    codexHome: plan.runtimePaths.codexHome,
    resumeThreadId: null,
    env: { ...plan.environment.injected },
    environmentMode: 'exact',
    workerAccessMode: 'lab-gateway',
    permissionPolicy: {
      approvalPolicy: 'never',
      permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
      runtimeWorkspaceRoots: [workspacePath]
    }
  }
}
