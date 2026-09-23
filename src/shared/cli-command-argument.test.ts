import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { quoteCliCommandArgument, renderCliCommandArguments } from './cli-command-argument'

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

  it('renders argument vectors for the caller shell and rejects cmd line breaks', () => {
    expect(
      renderCliCommandArguments(['orca', 'literal $HOME'], 'win32', {
        ComSpec: 'powershell.exe'
      })
    ).toEqual({ ok: true, command: "& orca 'literal $HOME'" })
    expect(
      renderCliCommandArguments(['orca', 'line 1\r\nline 2'], 'win32', {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe'
      })
    ).toEqual({ ok: false, reason: 'cmd_line_break' })
    expect(
      renderCliCommandArguments(['orca', '--description=!PATH!'], 'win32', {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe'
      })
    ).toEqual({ ok: false, reason: 'cmd_delayed_expansion' })
  })
})
