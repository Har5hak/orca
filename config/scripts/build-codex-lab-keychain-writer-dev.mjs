import { execFileSync } from 'node:child_process'
import path from 'node:path'

/** Build the signed-bundle input; the caller's existing deep codesign pass owns signing. */
export function buildCodexLabKeychainWriterForDev({ repoRoot, appPath, processExecPath }) {
  execFileSync(
    processExecPath,
    [
      path.join(repoRoot, 'config', 'scripts', 'build-codex-lab-keychain-writer-macos.mjs'),
      '--single-arch',
      '--output',
      path.join(appPath, 'Contents', 'MacOS', 'orca-codex-lab-keychain-writer')
    ],
    { stdio: 'inherit' }
  )
}
