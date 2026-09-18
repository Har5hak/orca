import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  probeCodexLabAppServerReadiness,
  type CodexLabAppServerAttestationExpected
} from './codex-lab-app-server-attestation'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import type { CodexLabExternalChatGptLoginReceipt } from './codex-lab-external-chatgpt-auth-contract'
import { CODEX_LAB_READONLY_PERMISSION_PROFILE_ID } from './codex-structured-permission-policy'
import type { CodexStructuredLaunch } from './codex-structured-session-state'
import type { CodexOpenedThread } from './codex-structured-thread-open'
import { isCodexLabDynamicToolHostBoundTo } from './codex-lab-dynamic-tool-host'

export function codexLabAttestationExpectedForLaunch(
  launch: CodexStructuredLaunch
): CodexLabAppServerAttestationExpected | null {
  if (launch.workerAccessMode !== 'lab-gateway') {
    return null
  }
  const dynamicHostExpected = launch.labDynamicToolHostAttestationExpected
  if (
    !launch.labDynamicToolHost ||
    !dynamicHostExpected ||
    !Object.isFrozen(dynamicHostExpected) ||
    !isCodexLabDynamicToolHostBoundTo(launch.labDynamicToolHost, dynamicHostExpected)
  ) {
    throw new Error('Codex laboratory gateway access requires a dynamic-tool host')
  }
  const expected = launch.labAppServerAttestationExpected
  const permissionPolicy = launch.permissionPolicy
  if (
    !expected ||
    launch.environmentMode !== 'exact' ||
    launch.cwd !== expected.cwd ||
    launch.codexHome !== expected.codexHome ||
    launch.resumeThreadId !== null ||
    (launch.resumePath !== undefined && launch.resumePath !== null) ||
    launch.env?.CODEX_HOME !== expected.codexHome ||
    launch.env.HOME !== expected.fakeHome ||
    !expected.workspaceId.trim() ||
    expected.permissionProfileId !== CODEX_LAB_READONLY_PERMISSION_PROFILE_ID ||
    !permissionPolicy ||
    !('permissions' in permissionPolicy) ||
    permissionPolicy.approvalPolicy !== 'never' ||
    permissionPolicy.permissions !== expected.permissionProfileId ||
    !isDeepStrictEqual(permissionPolicy.runtimeWorkspaceRoots, [expected.cwd])
  ) {
    throw new Error('Codex laboratory attestation expectations do not match the sealed launch.')
  }
  return expected
}

export async function attestCodexLabOpenedThread(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  expected: CodexLabAppServerAttestationExpected | null
  externalAuthReceipt: CodexLabExternalChatGptLoginReceipt | null
  opened: CodexOpenedThread
  observeAuthJson?: (authJsonPath: string) => 'absent' | 'present'
  timeoutMs?: number
}): Promise<void> {
  if (!input.expected) {
    return
  }
  if (!input.externalAuthReceipt) {
    throw new AgentSessionAcquisitionRefusal(
      'Codex laboratory app-server attestation refused: external auth receipt is missing.'
    )
  }
  if (!input.opened.labAttestation) {
    throw new AgentSessionAcquisitionRefusal(
      'Codex laboratory app-server attestation refused: fresh thread evidence is missing.'
    )
  }
  const result = await probeCodexLabAppServerReadiness({
    connection: input.connection,
    expected: input.expected,
    externalAuthReceipt: input.externalAuthReceipt,
    threadStartParams: input.opened.labAttestation.threadStartParams,
    openedThread: input.opened.labAttestation.openedThread,
    timeoutMs: input.timeoutMs
  })
  if (!result.ready) {
    throw new AgentSessionAcquisitionRefusal(
      `Codex laboratory app-server attestation refused: ${result.reason} (${result.field}).`
    )
  }
  assertCodexLabAuthJsonAbsent(
    input.expected.codexHome,
    input.observeAuthJson ?? observeNativeCodexLabAuthJson
  )
}

function assertCodexLabAuthJsonAbsent(
  codexHome: string,
  observe: (authJsonPath: string) => 'absent' | 'present'
): void {
  let observation: 'absent' | 'present'
  try {
    observation = observe(join(codexHome, 'auth.json'))
  } catch {
    throw new AgentSessionAcquisitionRefusal(
      'Codex laboratory app-server attestation refused: auth.json absence is not verified.'
    )
  }
  if (observation !== 'absent') {
    throw new AgentSessionAcquisitionRefusal(
      'Codex laboratory app-server attestation refused: auth.json absence is not verified.'
    )
  }
}

function observeNativeCodexLabAuthJson(authJsonPath: string): 'absent' | 'present' {
  try {
    lstatSync(authJsonPath)
    return 'present'
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return 'absent'
    }
    throw error
  }
}
