import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SWIFT_SOURCE_PATH = join(REPO_ROOT, 'native', 'codex-lab-keychain-writer-macos', 'main.swift')
const BUILD_SCRIPT_PATH = join(
  REPO_ROOT,
  'config',
  'scripts',
  'build-codex-lab-keychain-writer-macos.mjs'
)
const SDK_NAME_COLLATOR = new Intl.Collator('en', { numeric: true })

describe('Codex laboratory Keychain writer contract', () => {
  it.skipIf(process.platform !== 'darwin')(
    'parses as Swift without executing Keychain code',
    () => {
      const parsed = spawnSync('/usr/bin/swiftc', ['-frontend', '-parse', SWIFT_SOURCE_PATH], {
        encoding: 'utf8',
        env: {
          LANG: 'C',
          LC_ALL: 'C',
          CLANG_MODULE_CACHE_PATH: join('/private/tmp', 'orca-swift-contract-module-cache')
        }
      })

      expect(parsed.status, parsed.stderr).toBe(0)
      expect(parsed.stdout).toBe('')
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'builds, signs, and rejects invalid input before any Keychain operation',
    () => {
      const temporaryDirectory = mkdtempSync(join(tmpdir(), 'orca-keychain-writer-contract-'))
      const outputPath = join(temporaryDirectory, 'orca-codex-lab-keychain-writer')
      try {
        const sdkProbe = spawnSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
          encoding: 'utf8'
        })
        expect(sdkProbe.status, sdkProbe.stderr).toBe(0)
        const defaultSdk = sdkProbe.stdout.trim()
        const sdkDirectory = dirname(defaultSdk)
        const installedSdks = readdirSync(sdkDirectory)
          .filter((entry) => /^MacOSX\d+(?:\.\d+)?\.sdk$/u.test(entry))
          .sort(SDK_NAME_COLLATOR.compare)
          .map((entry) => join(sdkDirectory, entry))
        const candidates = [...new Set([...installedSdks, defaultSdk])]
        const failures = []
        let built = false
        for (const sdkRoot of candidates) {
          const build = spawnSync(
            process.execPath,
            [BUILD_SCRIPT_PATH, '--single-arch', '--output', outputPath],
            {
              encoding: 'utf8',
              env: {
                PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                LANG: 'C',
                LC_ALL: 'C',
                SDKROOT: sdkRoot,
                CLANG_MODULE_CACHE_PATH: join(temporaryDirectory, 'module-cache')
              }
            }
          )
          if (build.status === 0) {
            built = true
            break
          }
          failures.push(`${sdkRoot}: ${build.stderr}`)
        }
        expect(built, failures.join('\n')).toBe(true)

        const sign = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', outputPath], {
          encoding: 'utf8'
        })
        expect(sign.status, sign.stderr).toBe(0)
        const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', outputPath], {
          encoding: 'utf8'
        })
        expect(verify.status, verify.stderr).toBe(0)

        const invalidDispatch = spawnSync(outputPath, ['../escape'], {
          encoding: 'utf8',
          input: 'sentinel-secret'
        })
        expect(invalidDispatch).toMatchObject({
          status: 64,
          stdout: '',
          stderr: 'refused:invalid-request\n'
        })
        expect(`${invalidDispatch.stdout}${invalidDispatch.stderr}`).not.toContain(
          'sentinel-secret'
        )

        const oversizedInput = spawnSync(outputPath, ['dispatch-757-bounded'], {
          encoding: 'utf8',
          input: 'x'.repeat(2 * 1024 * 1024 + 1)
        })
        expect(oversizedInput).toMatchObject({
          status: 65,
          stdout: '',
          stderr: 'refused:input-invalid\n'
        })
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true })
      }
    },
    60_000
  )

  it('has one fixed replace-and-verify operation with a bounded stdin secret', () => {
    const source = readFileSync(SWIFT_SOURCE_PATH, 'utf8')

    expect(source).toContain('let keychainService = "Codex Auth"')
    expect(source).toContain('let labRuntimeRoot = "/private/tmp/orca-lab/runtime"')
    expect(source).toContain('let maximumCredentialBytes = 2 * 1024 * 1024')
    expect(source).toContain('guard CommandLine.arguments.count == 2')
    expect(source).toContain('let dispatchId = CommandLine.arguments[1]')
    expect(source).not.toContain('CommandLine.arguments[2]')
    expect(source).toContain('FileHandle.standardInput.read(upToCount:')
    expect(source).toContain('SHA256.hash(data: Data(codexHome(for: dispatchId).utf8))')
    expect(source).toContain('SecItemUpdate(')
    expect(source).toContain('SecItemAdd(')
    expect(source).toContain('SecItemCopyMatching(')
    expect(source).toContain('constantTimeEqual(credential, observed)')
    expect(source).toContain('FileHandle.standardOutput.write(Data("ok\\n".utf8))')
    expect(source).not.toMatch(
      /localizedDescription|String\(describing:|ProcessInfo\.processInfo\.environment/
    )
    expect(source).not.toMatch(/print\s*\(/)
  })

  it('builds, signs, and packages the fixed helper through existing macOS paths', () => {
    const build = readFileSync(BUILD_SCRIPT_PATH, 'utf8')
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    const nativeBuild = readFileSync(
      join(REPO_ROOT, 'config', 'scripts', 'build-native-for-platform.mjs'),
      'utf8'
    )
    const devBuild = readFileSync(
      join(REPO_ROOT, 'config', 'scripts', 'run-electron-vite-dev.mjs'),
      'utf8'
    )
    const devWriterBuild = readFileSync(
      join(REPO_ROOT, 'config', 'scripts', 'build-codex-lab-keychain-writer-dev.mjs'),
      'utf8'
    )
    const packaging = readFileSync(join(REPO_ROOT, 'config', 'electron-builder.config.cjs'), 'utf8')

    expect(build).toContain("'arm64-apple-macosx', 'x86_64-apple-macosx'")
    expect(build).toContain("'-framework',")
    expect(build).toContain("'Security',")
    expect(build).toContain("'orca-codex-lab-keychain-writer'")
    expect(packageJson.scripts['build:codex-lab-keychain-writer-macos']).toBe(
      'node config/scripts/build-codex-lab-keychain-writer-macos.mjs'
    )
    expect(nativeBuild).toContain("'build:codex-lab-keychain-writer-macos'")
    expect(devBuild).toContain('buildCodexLabKeychainWriterForDev({')
    expect(devWriterBuild).toContain("'build-codex-lab-keychain-writer-macos.mjs'")
    expect(devWriterBuild).toContain("'orca-codex-lab-keychain-writer'")
    expect(devBuild).toContain("'/usr/bin/codesign'")
    expect(devBuild).toContain("'--force', '--deep', '--sign', '-', appPath")
    expect(packaging).toContain(
      "from: 'native/codex-lab-keychain-writer-macos/.build/release/orca-codex-lab-keychain-writer'"
    )
    expect(packaging).toContain("to: 'MacOS/orca-codex-lab-keychain-writer'")
  })
})
