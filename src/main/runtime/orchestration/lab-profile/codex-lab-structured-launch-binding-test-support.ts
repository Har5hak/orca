import {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  type CodexLabLaunchFacts
} from './codex-lab-launch-contract'
import { buildSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import { verifyLabWorktreeObservation } from './lab-worktree-observation'

export const TEST_LAB_DISPATCH_ID = 'dispatch-757-structured'
export const TEST_LAB_WORKTREE_IDENTITY = 'wt2:local:disposable-structured'
export const TEST_LAB_WORKTREE_PATH = '/private/tmp/orca-lab/disposable-structured'

export function testCodexLabStructuredLaunchBinding() {
  const facts: CodexLabLaunchFacts = {
    platform: 'darwin',
    profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
    adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
    dispatch: {
      id: TEST_LAB_DISPATCH_ID,
      runtimeRoot: '/private/tmp/orca-lab/runtime',
      codexHomeState: 'absent',
      fakeHomeState: 'absent'
    },
    worktree: {
      identity: TEST_LAB_WORKTREE_IDENTITY,
      expectedPath: TEST_LAB_WORKTREE_PATH,
      observedPath: TEST_LAB_WORKTREE_PATH,
      observedRealPath: TEST_LAB_WORKTREE_PATH,
      kind: 'directory',
      disposable: true
    },
    gateway: {
      socketPath: '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-structured/gateway.sock',
      credential: `lgw1_${'g'.repeat(43)}`
    },
    binary: {
      path: '/Applications/ChatGPT.app/Contents/Resources/codex',
      observedRealPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      kind: 'regular-file',
      executable: true,
      pinnedSha256: 'a'.repeat(64),
      observedSha256: 'a'.repeat(64)
    },
    authentication: {
      keyringAvailable: true,
      keyringBackend: 'macos-keychain',
      loginMethod: 'chatgpt',
      expectedWorkspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
      observedWorkspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42',
      subscription: { status: 'active', scope: 'workspace', unambiguous: true },
      authJson: { state: 'absent' }
    },
    ambientEnv: {}
  }
  const plan = buildSealedCodexLabLaunchPlan(facts)
  const worktree = verifyLabWorktreeObservation({
    admission: Object.freeze({
      profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
      adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
      agent: 'codex',
      maxConcurrency: 1,
      worktreeIdentity: TEST_LAB_WORKTREE_IDENTITY,
      worktreeInstanceId: 'disposable-structured',
      expectedWorktreePath: TEST_LAB_WORKTREE_PATH
    }),
    evidence: {
      lookup: {
        state: 'found',
        selector: `identity:${TEST_LAB_WORKTREE_IDENTITY}`,
        identity: TEST_LAB_WORKTREE_IDENTITY,
        executionHostId: 'local',
        kind: 'git-worktree',
        path: TEST_LAB_WORKTREE_PATH,
        preExisting: true,
        disposable: true
      },
      realpath: {
        state: 'directory',
        requestedPath: TEST_LAB_WORKTREE_PATH,
        canonicalPath: TEST_LAB_WORKTREE_PATH
      },
      git: {
        state: 'observed',
        repositoryRoot: { pinned: TEST_LAB_WORKTREE_PATH, observed: TEST_LAB_WORKTREE_PATH },
        commonDirectory: {
          pinned: '/private/tmp/orca-lab/repository.git',
          observed: '/private/tmp/orca-lab/repository.git'
        },
        headCommit: { pinned: '1'.repeat(40), observed: '1'.repeat(40) },
        treeHash: { pinned: '2'.repeat(40), observed: '2'.repeat(40) },
        statusPorcelainV2: ''
      }
    }
  })
  return Object.freeze({ dispatchId: TEST_LAB_DISPATCH_ID, plan, worktree })
}
