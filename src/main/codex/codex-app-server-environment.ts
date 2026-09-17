export type CodexAppServerEnvironmentMode = 'inherit' | 'exact'

export type CodexAppServerEnvironmentLaunch = Readonly<{
  env?: Readonly<Record<string, string>>
  envToDelete?: readonly string[]
  environmentMode?: CodexAppServerEnvironmentMode
}>

export function buildCodexAppServerChildEnvironment(
  launch: CodexAppServerEnvironmentLaunch,
  ambientEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv =
    launch.environmentMode === 'exact'
      ? { ...launch.env }
      : { ...ambientEnvironment, ...launch.env }
  for (const key of launch.envToDelete ?? []) {
    delete childEnvironment[key]
  }
  return childEnvironment
}
