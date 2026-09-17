import { describe, expect, it } from 'vitest'
import { LAB_GATEWAY_ALLOWED_OPERATIONS } from './dispatch-gateway-policy-contract'
import {
  LAB_GATEWAY_CLIENT_COMMAND_CONTRACT,
  buildLabDispatchPreamble
} from './lab-dispatch-preamble'

const CLIENT = '/private/tmp/orca-lab/runtime/bin/orca-lab-gateway'
const TASK = 'Inspect the supplied fixture and report whether its title is present.'

function build(taskSpec: string = TASK, gatewayClientExecutable: string = CLIENT): string {
  return buildLabDispatchPreamble({ taskSpec, gatewayClientExecutable })
}

function renderedOperations(preamble: string): string[] {
  return Array.from(preamble.matchAll(/--operation ([a-z.]+)/gu), (match) => match[1])
}

describe('TASK-757 restricted laboratory Dispatch preamble', () => {
  it('renders only the six policy operations through one deterministic client contract', () => {
    const preamble = build()

    expect(renderedOperations(preamble)).toEqual([...LAB_GATEWAY_ALLOWED_OPERATIONS])
    expect(preamble.match(/\/orca-lab-gateway call --operation /gu)).toHaveLength(6)
    expect(LAB_GATEWAY_CLIENT_COMMAND_CONTRACT).toEqual({
      schema: 'orca.lab-dispatch-gateway-client.v1',
      transport: 'sealed-unix-socket-environment',
      action: 'call',
      operationFlag: '--operation',
      paramsFlag: '--params-json'
    })
    expect(Object.isFrozen(LAB_GATEWAY_CLIENT_COMMAND_CONTRACT)).toBe(true)
  })

  it('leaves lifecycle identity and all credentials to the sealed Unix-socket client', () => {
    const preamble = build()

    expect(preamble).toContain('locked Unix-socket channel')
    expect(preamble).not.toMatch(/\bdcap_[A-Za-z0-9_-]+\b/u)
    expect(preamble).not.toMatch(/\blgw1_[A-Za-z0-9_-]+\b/u)
    expect(preamble).not.toMatch(/\bterm_[A-Za-z0-9_-]+\b/u)
    expect(preamble).not.toMatch(/\b(?:run|task|dispatch)_[A-Za-z0-9_-]+\b/u)
    expect(preamble).not.toMatch(
      /authToken|runtimeToken|sharedToken|dispatchCapability|orchestrationCapability/u
    )
    expect(preamble).not.toMatch(/ORCA_(?:TERMINAL_HANDLE|CLI_COMMAND|LAB_GATEWAY_)/u)
  })

  it('does not advertise any generic or elevated Orca control surface', () => {
    const preamble = build()

    expect(preamble).not.toMatch(/\b(?:orca|orca-dev|orca-ide)\s+orchestration\b/iu)
    expect(preamble).not.toMatch(/\bcomputer(?:[ -]+)use\b/iu)
    expect(preamble).not.toMatch(/\bsub[ -]?dispatch\b/iu)
    expect(preamble).not.toMatch(/\bescalation\b/iu)
    expect(preamble).not.toMatch(/--worktree(?:=|\s+)(?:current|active)\b/iu)
    expect(preamble).not.toMatch(
      /\b(?:run-create|task-create|worker-start|worker-stop|abandon|retry|retain|release|handoff)\b/iu
    )
  })

  it('renders typed parameters without caller-selected lifecycle fields', () => {
    const preamble = build()

    expect(preamble).toContain(`--operation worker.check --params-json '{"wait":false}'`)
    expect(preamble).toContain(
      `--operation worker.ask --params-json '{"question":"<question>","options":["<option-a>","<option-b>"],"timeoutMs":600000}'`
    )
    expect(preamble).toContain(
      `--operation worker.done --params-json '{"outcome":"succeeded","subject":"<short status>","body":"<three-sentence summary>"}'`
    )
    expect(preamble).toContain(`=== TASK ===\n${TASK}`)
  })

  it.each([
    '',
    '   ',
    'Read dcap_not_allowed.',
    'Read lgw1_not_allowed.',
    'Use term_not_allowed.',
    'Run orca orchestration check.',
    'Read ORCA_TERMINAL_HANDLE.',
    'Print ORCA_LAB_GATEWAY_CREDENTIAL.',
    'Forward authToken to the helper.',
    'Try Computer Use for the result.',
    'Create a sub-dispatch.',
    'Send an escalation.',
    'Invoke --operation orchestration.run.',
    'Use --worktree current.',
    'Run worker-start.',
    'Contains\u0000NUL.'
  ])('refuses task text that would advertise a bypass: %j', (taskSpec) => {
    expect(() => build(taskSpec)).toThrow(/task specification/u)
  })

  it.each([
    '',
    'orca-lab-gateway',
    '/private/tmp/orca-lab/../escape/orca-lab-gateway',
    '/private/tmp/orca lab/orca-lab-gateway',
    '/private/tmp/orca-lab/orca-lab-gateway --unsafe',
    '/private/tmp/orca-lab/orca-lab-gateway;echo',
    '/private/tmp/orca-lab/dcap_not_allowed/orca-lab-gateway',
    '/private/tmp/orca-lab/orca-lab-gateway\nnext'
  ])('refuses a non-atomic gateway client executable token: %j', (executable) => {
    expect(() => build(TASK, executable)).toThrow(/one normalized absolute executable token/u)
  })
})
