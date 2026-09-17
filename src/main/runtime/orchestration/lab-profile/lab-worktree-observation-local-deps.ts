import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, resolve } from 'node:path'
import { gitExecFileAsync } from '../../../git/runner'
import type {
  LabWorktreeGitSnapshot,
  LabWorktreeObservationCollectorDeps
} from './lab-worktree-observation-collector'

const LOCAL_GIT_SNAPSHOT_TIMEOUT_MS = 5_000

export function createLocalLabWorktreeObservationCollectorDeps(
  resolveExactIdentity: LabWorktreeObservationCollectorDeps['resolveExactIdentity']
): LabWorktreeObservationCollectorDeps {
  return Object.freeze({
    resolveExactIdentity,
    realpathPath: realpath,
    statPath: async (path) => {
      try {
        return (await stat(path)).isDirectory() ? 'directory' : 'other'
      } catch {
        return 'missing'
      }
    },
    takeGitSnapshot: takeLocalGitSnapshot
  })
}

async function takeLocalGitSnapshot(path: string): Promise<LabWorktreeGitSnapshot> {
  const repositoryRoot = absoluteGitPath(
    path,
    await readLocalGitScalar(path, ['rev-parse', '--show-toplevel'])
  )
  const commonDirectory = absoluteGitPath(
    path,
    await readLocalGitScalar(path, ['rev-parse', '--git-common-dir'])
  )
  const gitDirectory = absoluteGitPath(
    path,
    await readLocalGitScalar(path, ['rev-parse', '--git-dir'])
  )
  const headCommit = await readLocalGitScalar(path, ['rev-parse', '--verify', 'HEAD'])
  const treeHash = await readLocalGitScalar(path, ['rev-parse', '--verify', 'HEAD^{tree}'])
  const { stdout: statusPorcelainV2 } = await gitExecFileAsync(
    ['status', '--porcelain=v2', '--untracked-files=all'],
    { cwd: path, timeout: LOCAL_GIT_SNAPSHOT_TIMEOUT_MS }
  )
  return Object.freeze({
    repositoryRoot,
    commonDirectory,
    gitDirectory,
    headCommit,
    treeHash,
    statusPorcelainV2
  })
}

async function readLocalGitScalar(path: string, args: string[]): Promise<string> {
  const { stdout } = await gitExecFileAsync(args, {
    cwd: path,
    timeout: LOCAL_GIT_SNAPSHOT_TIMEOUT_MS
  })
  const withoutLf = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
  const value = withoutLf.endsWith('\r') ? withoutLf.slice(0, -1) : withoutLf
  if (!value || value.includes('\n') || value.includes('\r')) {
    throw new Error('git_scalar_invalid')
  }
  return value
}

function absoluteGitPath(cwd: string, value: string): string {
  return normalize(isAbsolute(value) ? value : resolve(cwd, value))
}
