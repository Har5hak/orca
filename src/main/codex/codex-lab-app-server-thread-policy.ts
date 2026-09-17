import { isAbsolute, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation-contract'
import { CODEX_LAB_DYNAMIC_TOOL_SPECS } from './codex-lab-dynamic-tool-contract'
import {
  invalid,
  isAbsent,
  isRecord,
  record,
  sameStrings,
  type ValidationFailure
} from './codex-lab-app-server-value'

export function validateCodexLabThreadStartRequest(
  value: unknown,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  if (!isRecord(value)) {
    return invalid('threadStartParams')
  }
  if (value.cwd !== expected.cwd) {
    return invalid('threadStartParams.cwd')
  }
  if (value.permissions !== expected.permissionProfileId) {
    return invalid('threadStartParams.permissions')
  }
  if (value.approvalPolicy !== 'never') {
    return invalid('threadStartParams.approvalPolicy')
  }
  if (!isAbsent(value.sandbox)) {
    return invalid('threadStartParams.sandbox')
  }
  if (!isAbsent(value.config)) {
    return invalid('threadStartParams.config')
  }
  if (value.ephemeral !== true) {
    return invalid('threadStartParams.ephemeral')
  }
  if (!sameStrings(value.runtimeWorkspaceRoots, [expected.cwd])) {
    return invalid('threadStartParams.runtimeWorkspaceRoots')
  }
  return validateDynamicTools(value.dynamicTools)
}

export function validateCodexLabOpenedThread(
  value: unknown,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  if (!isRecord(value)) {
    return invalid('openedThread')
  }
  if (value.cwd !== expected.cwd) {
    return invalid('openedThread.cwd')
  }
  if (!sameStrings(value.runtimeWorkspaceRoots, [expected.cwd])) {
    return invalid('openedThread.runtimeWorkspaceRoots')
  }
  if (value.approvalPolicy !== 'never') {
    return invalid('openedThread.approvalPolicy')
  }
  if (value.approvalsReviewer !== 'user') {
    return invalid('openedThread.approvalsReviewer')
  }
  if (value.modelProvider !== 'openai') {
    return invalid('openedThread.modelProvider')
  }
  if (!sameStrings(value.disabledPluginIds, [])) {
    return invalid('openedThread.disabledPluginIds')
  }
  if (value.multiAgentMode !== 'explicitRequestOnly') {
    return invalid('openedThread.multiAgentMode')
  }
  const active = record(value.activePermissionProfile)
  if (active?.id !== expected.permissionProfileId || active.extends !== ':read-only') {
    return invalid('openedThread.activePermissionProfile')
  }
  const sandbox = record(value.sandbox)
  if (sandbox?.type !== 'readOnly' || sandbox.networkAccess !== false) {
    return invalid('openedThread.sandbox')
  }
  const thread = record(value.thread)
  if (thread?.ephemeral !== true) {
    return invalid('openedThread.thread.ephemeral')
  }
  if (!instructionSourcesStayInWorkspace(value.instructionSources, expected.cwd)) {
    return invalid('openedThread.instructionSources')
  }
  return null
}

function validateDynamicTools(value: unknown): ValidationFailure | null {
  if (!isDeepStrictEqual(value, CODEX_LAB_DYNAMIC_TOOL_SPECS)) {
    return invalid('threadStartParams.dynamicTools')
  }
  return null
}

function instructionSourcesStayInWorkspace(value: unknown, cwd: string): boolean {
  if (!Array.isArray(value)) {
    return false
  }
  return value.every((source) => {
    if (typeof source !== 'string' || !isAbsolute(source)) {
      return false
    }
    const path = relative(cwd, source)
    return path === '' || (!path.startsWith('..') && !isAbsolute(path))
  })
}
