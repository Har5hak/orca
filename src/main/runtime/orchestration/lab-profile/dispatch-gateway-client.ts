import { createHash, randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { isAbsolute, normalize } from 'node:path'
import { LAB_GATEWAY_ALLOWED_OPERATIONS, type LabGatewayOperation } from './dispatch-gateway-policy'
import type { LabGatewayServerReceipt } from './dispatch-gateway-server'

const LAB_GATEWAY_CREDENTIAL_PATTERN = /^lgw1_[A-Za-z0-9_-]{43}$/u
const LAB_GATEWAY_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const MAX_LAB_GATEWAY_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_LAB_GATEWAY_TIMEOUT_MS = 30_000

export type LabGatewayClientResult =
  | Readonly<{
      ok: true
      result: unknown
      receipt: LabGatewayServerReceipt
    }>
  | Readonly<{
      ok: false
      reason: string
      field?: string
      receipt: LabGatewayServerReceipt
    }>

export type LabGatewayClientFailureReason =
  | 'aborted'
  | 'connection_failed'
  | 'outcome_unknown'
  | 'request_invalid'
  | 'response_invalid'
  | 'response_receipt_mismatch'
  | 'response_too_large'
  | 'timeout'

export class LabGatewayClientFailure extends Error {
  readonly code = 'ORCA_LAB_GATEWAY_CLIENT_FAILED'

  constructor(readonly reason: LabGatewayClientFailureReason) {
    super(`Laboratory gateway client failed: ${reason}`)
    this.name = 'LabGatewayClientFailure'
  }
}

export async function callLabDispatchGateway(args: {
  endpoint: string
  credential: string
  operation: LabGatewayOperation
  params?: unknown
  expectedReceipt: LabGatewayServerReceipt
  timeoutMs?: number
  signal?: AbortSignal
  requestId?: string
}): Promise<LabGatewayClientResult> {
  assertClientRequest(args)
  const requestId = args.requestId ?? randomUUID()
  if (!LAB_GATEWAY_REQUEST_ID_PATTERN.test(requestId)) {
    throw new LabGatewayClientFailure('request_invalid')
  }
  if (args.signal?.aborted) {
    throw new LabGatewayClientFailure('aborted')
  }

  return await new Promise<LabGatewayClientResult>((resolve, reject) => {
    const socket = createConnection(args.endpoint)
    let connected = false
    let settled = false
    let buffer = ''
    let receivedBytes = 0
    const timeoutMs = args.timeoutMs ?? DEFAULT_LAB_GATEWAY_TIMEOUT_MS

    const settleFailure = (reason: LabGatewayClientFailureReason): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup(socket, args.signal, abort)
      socket.destroy()
      reject(new LabGatewayClientFailure(reason))
    }
    const settleError = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup(socket, args.signal, abort)
      socket.destroy()
      reject(
        error instanceof LabGatewayClientFailure
          ? error
          : new LabGatewayClientFailure('response_invalid')
      )
    }
    const settleResult = (result: LabGatewayClientResult): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup(socket, args.signal, abort)
      socket.destroy()
      resolve(result)
    }
    const abort = (): void => settleFailure('aborted')

    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.setTimeout(timeoutMs, () => settleFailure('timeout'))
    socket.once('connect', () => {
      connected = true
      const request = {
        id: requestId,
        credential: args.credential,
        operation: args.operation,
        ...(args.params === undefined ? {} : { params: args.params })
      }
      socket.write(`${JSON.stringify(request)}\n`)
    })
    socket.once('error', () => settleFailure(connected ? 'outcome_unknown' : 'connection_failed'))
    socket.once('close', () => {
      if (!settled) {
        settleFailure(connected ? 'outcome_unknown' : 'connection_failed')
      }
    })
    socket.on('data', (chunk: string) => {
      if (settled) {
        return
      }
      buffer += chunk
      receivedBytes += Buffer.byteLength(chunk, 'utf8')
      if (receivedBytes > MAX_LAB_GATEWAY_RESPONSE_BYTES) {
        settleFailure('response_too_large')
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline !== -1 && !settled) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          let parsed: LabGatewayClientResult | null
          try {
            parsed = parseResponse(line, requestId, args.expectedReceipt)
          } catch (error) {
            settleError(error)
            return
          }
          if (parsed) {
            settleResult(parsed)
            return
          }
        }
        newline = buffer.indexOf('\n')
      }
    })
    args.signal?.addEventListener('abort', abort, { once: true })
    if (args.signal?.aborted) {
      abort()
    }
  })
}

function assertClientRequest(args: {
  endpoint: string
  credential: string
  operation: LabGatewayOperation
  expectedReceipt: LabGatewayServerReceipt
  timeoutMs?: number
}): void {
  if (
    !isAbsolute(args.endpoint) ||
    normalize(args.endpoint) !== args.endpoint ||
    args.endpoint.includes('\u0000') ||
    !LAB_GATEWAY_ALLOWED_OPERATIONS.includes(args.operation) ||
    args.expectedReceipt.schema !== 'orca.lab-dispatch-gateway.v1' ||
    args.expectedReceipt.transport !== 'unix' ||
    args.expectedReceipt.socketMode !== '0600' ||
    args.expectedReceipt.endpointSha256 !== sha256(args.endpoint) ||
    JSON.stringify(args.expectedReceipt.allowedOperations) !==
      JSON.stringify(LAB_GATEWAY_ALLOWED_OPERATIONS) ||
    args.expectedReceipt.receiptSha256 !== receiptSha256(args.expectedReceipt) ||
    !LAB_GATEWAY_CREDENTIAL_PATTERN.test(args.credential)
  ) {
    throw new LabGatewayClientFailure('request_invalid')
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_LAB_GATEWAY_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
    throw new LabGatewayClientFailure('request_invalid')
  }
}

function parseResponse(
  line: string,
  requestId: string,
  expectedReceipt: LabGatewayServerReceipt
): LabGatewayClientResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new LabGatewayClientFailure('response_invalid')
  }
  if (!isRecord(parsed)) {
    throw new LabGatewayClientFailure('response_invalid')
  }
  if (parsed._keepalive === true && Object.keys(parsed).length === 1) {
    return null
  }
  if (parsed.id !== requestId || typeof parsed.ok !== 'boolean' || !isRecord(parsed.receipt)) {
    throw new LabGatewayClientFailure('response_invalid')
  }
  if (!sameReceipt(parsed.receipt, expectedReceipt)) {
    throw new LabGatewayClientFailure('response_receipt_mismatch')
  }
  if (parsed.ok) {
    return Object.freeze({ ok: true, result: parsed.result ?? null, receipt: expectedReceipt })
  }
  if (!isRecord(parsed.error) || !isRecord(parsed.error.data)) {
    throw new LabGatewayClientFailure('response_invalid')
  }
  const reason = parsed.error.data.reason
  const field = parsed.error.data.field
  if (parsed.error.code !== 'lab_gateway_refused' || typeof reason !== 'string') {
    throw new LabGatewayClientFailure('response_invalid')
  }
  if (field !== undefined && typeof field !== 'string') {
    throw new LabGatewayClientFailure('response_invalid')
  }
  return Object.freeze({
    ok: false,
    reason,
    ...(field === undefined ? {} : { field }),
    receipt: expectedReceipt
  })
}

function sameReceipt(
  candidate: Readonly<Record<string, unknown>>,
  expected: LabGatewayServerReceipt
): boolean {
  return (
    candidate.schema === expected.schema &&
    candidate.policyId === expected.policyId &&
    candidate.dispatchId === expected.dispatchId &&
    candidate.transport === expected.transport &&
    candidate.socketMode === expected.socketMode &&
    candidate.endpointSha256 === expected.endpointSha256 &&
    candidate.processIncarnationSha256 === expected.processIncarnationSha256 &&
    candidate.lifecycleSource === expected.lifecycleSource &&
    candidate.dcapCustody === expected.dcapCustody &&
    candidate.receiptSha256 === expected.receiptSha256 &&
    Array.isArray(candidate.allowedOperations) &&
    JSON.stringify(candidate.allowedOperations) === JSON.stringify(expected.allowedOperations)
  )
}

function cleanup(socket: Socket, signal: AbortSignal | undefined, abort: () => void): void {
  socket.removeAllListeners('data')
  socket.removeAllListeners('connect')
  socket.removeAllListeners('error')
  socket.removeAllListeners('close')
  socket.setTimeout(0)
  signal?.removeEventListener('abort', abort)
}

function receiptSha256(receipt: LabGatewayServerReceipt): string {
  const { receiptSha256: _receiptSha256, ...stable } = receipt
  return sha256(JSON.stringify(stable))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
