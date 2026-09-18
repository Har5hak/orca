import type { RpcMessageContext } from './transport'

export const UNIX_SOCKET_TRANSPORT_LIMITS = Object.freeze({
  maxMessageBytes: 1024 * 1024,
  idleTimeoutMs: 30_000,
  maxConnections: 32,
  keepaliveIntervalMs: 10_000
})

export type UnixSocketTransportOptions = Readonly<{
  endpoint: string
  kind: 'unix' | 'named-pipe'
  // The legacy runtime transport replaces paths by name. Laboratory gateways
  // opt into the identity-attested lifecycle without changing ordinary callers.
  unixSocketLifecycle?: 'legacy' | 'lab-refuse-existing-retain'
  keepaliveIntervalMs?: number
}>

export type UnixSocketMessageHandler = (
  msg: string,
  reply: (response: string) => void,
  context?: RpcMessageContext
) => void
