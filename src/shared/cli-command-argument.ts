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
