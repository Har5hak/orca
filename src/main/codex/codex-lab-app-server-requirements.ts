import { ENABLED_CODEX_LAB_CONFINEMENT_FEATURES } from '../runtime/orchestration/lab-profile/codex-lab-launch-policy'
import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation-contract'
import {
  exactRecord,
  invalid,
  isAbsent,
  record,
  sameStrings,
  type ValidationFailure
} from './codex-lab-app-server-value'

const REQUIREMENT_KEYS = new Set([
  'modelProvider',
  'modelProviders',
  'allowedLoginMethods',
  'cliAuthCredentialsStore',
  'chatgptBaseUrl',
  'additionalDeveloperInstructions',
  'allowedApprovalPolicies',
  'allowedApprovalsReviewers',
  'allowedSandboxModes',
  'allowedWindowsSandboxImplementations',
  'allowedPermissionProfiles',
  'defaultPermissions',
  'allowedWebSearchModes',
  'allowManagedHooksOnly',
  'allowBrowserAndComputerUse',
  'allowAppshots',
  'allowRemoteControl',
  'computerUse',
  'browserUse',
  'inAppBrowser',
  'featureRequirements',
  'hooks',
  'enforceResidency',
  'network',
  'application',
  'autoReview',
  'models',
  'sqliteHome',
  'logDir',
  'modelCatalogJson',
  'checkForUpdateOnStartup',
  'allowLoginShell',
  'feedback',
  'windowsSandboxPrivateDesktop'
])

const UNVERIFIED_REQUIREMENTS = [
  'modelProviders',
  'chatgptBaseUrl',
  'additionalDeveloperInstructions',
  'allowedApprovalsReviewers',
  'allowedWindowsSandboxImplementations',
  'computerUse',
  'browserUse',
  'inAppBrowser',
  'hooks',
  'enforceResidency',
  'network',
  'application',
  'autoReview',
  'models',
  'sqliteHome',
  'logDir',
  'modelCatalogJson',
  'feedback',
  'windowsSandboxPrivateDesktop'
] as const

export function readCodexLabRequirements(
  value: unknown
): Record<string, unknown> | null | undefined {
  const response = exactRecord(value, ['requirements'])
  if (!response) {
    return undefined
  }
  if (response.requirements === null) {
    return null
  }
  return record(response.requirements) ?? undefined
}

export function validateCodexLabRequirements(
  requirements: Record<string, unknown> | null,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  if (requirements === null) {
    return null
  }
  const unknown = Object.keys(requirements).find((key) => !REQUIREMENT_KEYS.has(key))
  if (unknown) {
    return invalid(`requirements.${unknown}`)
  }
  for (const field of UNVERIFIED_REQUIREMENTS) {
    if (!isAbsent(requirements[field])) {
      return invalid(`requirements.${field}`)
    }
  }
  const scalarFailure = validateRequirementScalars(requirements, expected)
  if (scalarFailure) {
    return scalarFailure
  }
  const profileFailure = validateAllowedProfiles(
    requirements.allowedPermissionProfiles,
    expected.permissionProfileId
  )
  if (profileFailure) {
    return profileFailure
  }
  return validateFeatureRequirements(requirements.featureRequirements)
}

function validateRequirementScalars(
  requirements: Record<string, unknown>,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  if (!isAbsent(requirements.modelProvider) && requirements.modelProvider !== 'openai') {
    return invalid('requirements.modelProvider')
  }
  if (!optionalExactStrings(requirements.allowedLoginMethods, ['chatgpt'])) {
    return invalid('requirements.allowedLoginMethods')
  }
  if (
    !isAbsent(requirements.cliAuthCredentialsStore) &&
    requirements.cliAuthCredentialsStore !== 'ephemeral'
  ) {
    return invalid('requirements.cliAuthCredentialsStore')
  }
  if (!optionalExactStrings(requirements.allowedApprovalPolicies, ['never'])) {
    return invalid('requirements.allowedApprovalPolicies')
  }
  if (!optionalExactStrings(requirements.allowedSandboxModes, ['read-only'])) {
    return invalid('requirements.allowedSandboxModes')
  }
  if (
    !isAbsent(requirements.defaultPermissions) &&
    requirements.defaultPermissions !== expected.permissionProfileId
  ) {
    return invalid('requirements.defaultPermissions')
  }
  if (!optionalExactStrings(requirements.allowedWebSearchModes, ['disabled'])) {
    return invalid('requirements.allowedWebSearchModes')
  }
  if (
    !isAbsent(requirements.allowManagedHooksOnly) &&
    requirements.allowManagedHooksOnly !== true
  ) {
    return invalid('requirements.allowManagedHooksOnly')
  }
  for (const field of ['allowBrowserAndComputerUse', 'allowAppshots', 'allowRemoteControl']) {
    if (!isAbsent(requirements[field]) && requirements[field] !== false) {
      return invalid(`requirements.${field}`)
    }
  }
  if (
    !isAbsent(requirements.checkForUpdateOnStartup) &&
    requirements.checkForUpdateOnStartup !== false
  ) {
    return invalid('requirements.checkForUpdateOnStartup')
  }
  if (!isAbsent(requirements.allowLoginShell) && requirements.allowLoginShell !== false) {
    return invalid('requirements.allowLoginShell')
  }
  return null
}

function validateAllowedProfiles(value: unknown, profileId: string): ValidationFailure | null {
  if (isAbsent(value)) {
    return null
  }
  const profiles = exactRecord(value, [profileId])
  if (!profiles || profiles[profileId] !== true) {
    return invalid('requirements.allowedPermissionProfiles')
  }
  return null
}

function validateFeatureRequirements(value: unknown): ValidationFailure | null {
  if (isAbsent(value)) {
    return null
  }
  const features = record(value)
  if (!features) {
    return invalid('requirements.featureRequirements')
  }
  const safeEnabled = new Set<string>(ENABLED_CODEX_LAB_CONFINEMENT_FEATURES)
  for (const [feature, enabled] of Object.entries(features)) {
    if (typeof enabled !== 'boolean' || (enabled && !safeEnabled.has(feature))) {
      return invalid(`requirements.featureRequirements.${feature}`)
    }
  }
  return null
}

function optionalExactStrings(value: unknown, expected: readonly string[]): boolean {
  return isAbsent(value) || sameStrings(value, expected)
}
