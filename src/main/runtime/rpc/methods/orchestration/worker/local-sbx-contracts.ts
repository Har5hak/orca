import { z } from 'zod'

const ContractId = z.string().min(1).max(256)
const Nonce = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)
const BoundedText = z.string().min(1).max(32 * 1024)

export const LOCAL_SBX_EXECUTOR = 'local-sbx-v1' as const
export const LOCAL_SBX_CONTRACT_VERSION = 'orca.local-sbx.v1' as const

export const LocalSbxTaskContract = z
  .object({
    version: z.literal(LOCAL_SBX_CONTRACT_VERSION),
    runId: ContractId,
    taskId: ContractId,
    dispatchId: ContractId,
    nonce: Nonce,
    agent: z.literal('codex'),
    spec: BoundedText
  })
  .strict()

export const LocalSbxReadyContract = z
  .object({
    version: z.literal(LOCAL_SBX_CONTRACT_VERSION),
    dispatchId: ContractId,
    nonce: Nonce,
    sandboxName: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/),
    state: z.literal('ready')
  })
  .strict()

const LocalSbxInboxMessage = z
  .object({
    id: ContractId,
    type: z.enum([
      'status',
      'dispatch',
      'merge_ready',
      'escalation',
      'handoff',
      'decision_gate',
      'question'
    ]),
    subject: z.string().max(4 * 1024),
    body: BoundedText,
    payload: z.string().max(64 * 1024).nullable()
  })
  .strict()

export const LocalSbxInboxContract = z
  .object({
    version: z.literal(LOCAL_SBX_CONTRACT_VERSION),
    dispatchId: ContractId,
    nonce: Nonce,
    deliveryId: ContractId,
    messages: z.array(LocalSbxInboxMessage).min(1).max(50)
  })
  .strict()
  .superRefine((value, context) => {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 128 * 1024) {
      context.addIssue({
        code: 'custom',
        message: 'Sandbox inbox exceeds 128 KiB.'
      })
    }
  })

export const LocalSbxResultContract = z
  .object({
    version: z.literal(LOCAL_SBX_CONTRACT_VERSION),
    taskId: ContractId,
    dispatchId: ContractId,
    nonce: Nonce,
    deliveryId: ContractId,
    outcome: z.enum(['succeeded', 'failed']),
    summary: z.string().min(1).max(8 * 1024),
    evidence: z.array(z.string().min(1).max(8 * 1024)).max(20)
  })
  .strict()

export type LocalSbxTask = z.infer<typeof LocalSbxTaskContract>
export type LocalSbxReady = z.infer<typeof LocalSbxReadyContract>
export type LocalSbxInbox = z.infer<typeof LocalSbxInboxContract>
export type LocalSbxResult = z.infer<typeof LocalSbxResultContract>
