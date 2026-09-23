import { quoteWindowsCmdArgument } from './child-process/windows-command-line'
import { quotePowerShellNativeArgument } from './powershell-native-argument'
import { quoteStartupArg } from './tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from './windows-terminal-shell'

export function quoteCliCommandArgument(
  value: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  if (platform !== 'win32') {
    return quoteStartupArg(value, 'posix')
  }
  const shell = resolveWindowsShellStartupFamily(
    env.ORCA_TERMINAL_WINDOWS_SHELL ?? env.ORCA_WINDOWS_SHELL ?? env.ComSpec ?? env.COMSPEC
  )
  if (shell === 'cmd') {
    return quoteWindowsCmdArgument(value)
  }
  return shell === 'powershell'
    ? quotePowerShellNativeArgument(value)
    : quoteStartupArg(value, 'posix')
}

export type RenderCliCommandResult =
  | { ok: true; command: string }
  | { ok: false; reason: 'cmd_line_break' | 'cmd_delayed_expansion' }

export function renderCliCommandArguments(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): RenderCliCommandResult {
  const shell =
    platform === 'win32'
      ? resolveWindowsShellStartupFamily(
          env.ORCA_TERMINAL_WINDOWS_SHELL ?? env.ORCA_WINDOWS_SHELL ?? env.ComSpec ?? env.COMSPEC
        )
      : 'posix'
  if (shell === 'cmd' && args.some((arg) => /[\r\n]/.test(arg))) {
    return { ok: false, reason: 'cmd_line_break' }
  }
  if (shell === 'cmd' && args.some((arg) => arg.includes('!'))) {
    return { ok: false, reason: 'cmd_delayed_expansion' }
  }
  const command = args.map((arg) => quoteCliCommandArgument(arg, platform, env)).join(' ')
  return { ok: true, command: shell === 'powershell' && command ? `& ${command}` : command }
}
