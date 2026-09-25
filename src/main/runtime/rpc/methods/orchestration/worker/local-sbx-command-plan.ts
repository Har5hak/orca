import { z } from 'zod'
import { LocalSbxResultContract, type LocalSbxInbox, type LocalSbxTask } from './local-sbx-contracts'

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024
const RESULT_SCHEMA_PATH = '/tmp/orca-local-sbx-result.schema.json'

const SbxVersionOutput = z
  .object({
    client: z.object({ version: z.string().min(1).max(128) }).passthrough(),
    server: z.object({ state: z.literal('running') }).passthrough()
  })
  .passthrough()

const SbxInventoryOutput = z
  .object({
    sandboxes: z
      .array(
        z
          .object({
            name: z.string(),
            agent: z.string(),
            status: z.string(),
            ports: z.array(z.unknown()),
            workspaces: z.array(z.string())
          })
          .passthrough()
      )
      .max(10_000)
  })
  .passthrough()

const CodexAgentMessage = z.object({
  type: z.literal('item.completed'),
  item: z.object({ type: z.literal('agent_message'), text: z.string() }).passthrough()
})

export type SbxInventoryVerdict = 'live' | 'exited' | 'unverifiable'

export function sandboxNameForDispatch(dispatchId: string): string {
  const suffix = dispatchId
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 58)
  if (suffix.length === 0) {
    throw new Error('Dispatch ID cannot form a sandbox name.')
  }
  return `orca-${suffix}`
}

export function sbxVersionArgs(): readonly string[] {
  return ['version', '--json']
}

export function sbxCreateArgs(name: string): readonly string[] {
  return ['create', '--name', name, '--cpus', '2', '--memory', '2g', '--skills', 'off', 'codex']
}

export function sbxInventoryArgs(): readonly string[] {
  return ['ls', '--json']
}

export function sbxWriteResultSchemaArgs(name: string): readonly string[] {
  return ['exec', '-i', name, 'tee', RESULT_SCHEMA_PATH]
}

export function sbxCodexExecArgs(name: string): readonly string[] {
  return [
    'exec',
    '-i',
    name,
    'codex',
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--dangerously-bypass-approvals-and-sandbox',
    '--output-schema',
    RESULT_SCHEMA_PATH,
    '--json',
    '-'
  ]
}

export function sbxStopArgs(name: string): readonly string[] {
  return ['stop', name]
}

export function localSbxResultJsonSchema(): string {
  return JSON.stringify(z.toJSONSchema(LocalSbxResultContract))
}

export function localSbxPrompt(task: LocalSbxTask, inbox: LocalSbxInbox): string {
  return [
    'Execute the synthetic Orca Task below. Do not seek other work, configure integrations, or access host files.',
    'Return only the JSON object required by the supplied output schema. Copy every identity field exactly.',
    JSON.stringify({ task, inbox })
  ].join('\n\n')
}

export function assertHealthySbxVersion(stdout: string): void {
  SbxVersionOutput.parse(parseBoundedJson(stdout))
}

export function inspectSbxInventory(
  stdout: string,
  expected: { name: string; agent: 'codex'; stopped: boolean; missingIsExited?: boolean }
): SbxInventoryVerdict {
  let inventory: z.infer<typeof SbxInventoryOutput>
  try {
    inventory = SbxInventoryOutput.parse(parseBoundedJson(stdout))
  } catch {
    return 'unverifiable'
  }
  const matches = inventory.sandboxes.filter((sandbox) => sandbox.name === expected.name)
  if (matches.length === 0) {
    return expected.missingIsExited ? 'exited' : 'unverifiable'
  }
  if (matches.length !== 1) {
    return 'unverifiable'
  }
  const [sandbox] = matches
  if (
    sandbox.agent !== expected.agent ||
    sandbox.ports.length !== 0 ||
    sandbox.workspaces.length !== 0
  ) {
    return 'unverifiable'
  }
  if (expected.stopped) {
    return sandbox.status === 'stopped' ? 'exited' : 'unverifiable'
  }
  if (sandbox.status === 'running') {
    return 'live'
  }
  return sandbox.status === 'stopped' ? 'exited' : 'unverifiable'
}

export function parseCodexLocalSbxResult(stdout: string): unknown {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error('Codex result stream exceeds 1 MiB.')
  }
  let resultText: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new Error('Codex result stream contains invalid JSONL.')
    }
    const agentMessage = CodexAgentMessage.safeParse(event)
    if (agentMessage.success) {
      resultText = agentMessage.data.item.text
    }
  }
  if (!resultText) {
    throw new Error('Codex result stream contains no completed agent message.')
  }
  return parseBoundedJson(resultText)
}

function parseBoundedJson(value: string): unknown {
  if (Buffer.byteLength(value, 'utf8') > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error('Command JSON exceeds 1 MiB.')
  }
  return JSON.parse(value) as unknown
}
