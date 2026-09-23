import type { CliErrorContext } from './cli-error'

export function retryRoutingContext(
  flags: ReadonlyMap<string, string | boolean>,
  env: NodeJS.ProcessEnv = process.env
): Pick<CliErrorContext, 'remoteEnvironmentSelector' | 'remoteRoutingRequired'> {
  const environment = flags.get('environment')
  const host = flags.get('host')
  const hostEnvironment =
    typeof host === 'string' && host.startsWith('runtime:') ? host.slice('runtime:'.length) : null
  const ambientEnvironment = env.ORCA_ENVIRONMENT?.trim()
  const remoteEnvironmentSelector =
    (typeof environment === 'string' ? environment : null) ||
    hostEnvironment ||
    ambientEnvironment ||
    undefined
  const pairingSelected =
    typeof flags.get('pairing-code') === 'string' ||
    Boolean(env.ORCA_PAIRING_CODE || env.ORCA_REMOTE_PAIRING)
  const remoteRoutingRequired = Boolean(remoteEnvironmentSelector || pairingSelected)
  return {
    ...(remoteEnvironmentSelector ? { remoteEnvironmentSelector } : {}),
    ...(remoteRoutingRequired ? { remoteRoutingRequired: true } : {})
  }
}
