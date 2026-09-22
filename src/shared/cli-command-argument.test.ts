import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { quoteCliCommandArgument } from './cli-command-argument'

describe('quoteCliCommandArgument', () => {
  it.runIf(process.platform !== 'win32')('round trips arbitrary text through /bin/sh', () => {
    const value = `Alice's "quoted" $HOME && $(do-not-run) | <review> %PATH% \`tick\`\nnext line`
    const output = execFileSync('/bin/sh', [
      '-c',
      `printf %s ${quoteCliCommandArgument(value, 'darwin')}`
    ]).toString()

    expect(output).toBe(value)
  })

  it('renders PowerShell arguments without expandable quoting', () => {
    const value = `Alice's "quoted" $HOME && $(do-not-run) | <review> %PATH% \`tick\``

    expect(quoteCliCommandArgument(value, 'win32', { ComSpec: 'powershell.exe' })).toBe(
      `'Alice''s \\"quoted\\" $HOME && $(do-not-run) | <review> %PATH% \`tick\`'`
    )
  })

  it('renders cmd arguments without percent expansion', () => {
    expect(
      quoteCliCommandArgument('literal %PATH% & "quoted"', 'win32', {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe'
      })
    ).toBe('"literal "^%"PATH"^%" & ""quoted"""')
  })
})
