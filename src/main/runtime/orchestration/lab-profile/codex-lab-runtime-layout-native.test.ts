import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as nativeProductionFacade from './codex-lab-runtime-layout-native'
import {
  createNativeCodexLabRuntimeLayoutHostForTest,
  type NativeCodexLabRuntimeLayoutTestHooks
} from './codex-lab-runtime-layout-native.test-support'
import { CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE_CODE } from './codex-lab-runtime-layout'
import type {
  CodexLabExistingPathObservation,
  CodexLabRuntimeLayoutHost
} from './codex-lab-runtime-layout'

type NativeFixture = Readonly<{
  host: CodexLabRuntimeLayoutHost
  runtimeRoot: string
  dispatchesRoot: string
  dispatchRoot: string
  dispatches: CodexLabExistingPathObservation
  root: CodexLabExistingPathObservation
}>

let sandbox = ''

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(join(tmpdir(), 'orca-lab-layout-')))
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

async function createFixture(
  hooks: NativeCodexLabRuntimeLayoutTestHooks = {}
): Promise<NativeFixture> {
  const runtimeRoot = join(sandbox, 'runtime')
  const dispatchesRoot = join(runtimeRoot, 'dispatches')
  const dispatchRoot = join(dispatchesRoot, 'dispatch-native-test')
  const host = createNativeCodexLabRuntimeLayoutHostForTest(runtimeRoot, hooks)
  const sandboxObservation = await host.observePath(sandbox)
  if (sandboxObservation.kind !== 'directory') {
    throw new Error('temporary sandbox must be a directory')
  }
  const runtime = await host.makeDirectoryExclusive(runtimeRoot, 0o700, sandboxObservation.identity)
  const dispatches = await host.makeDirectoryExclusive(dispatchesRoot, 0o700, runtime.identity)
  const root = await host.makeDirectoryExclusive(dispatchRoot, 0o700, dispatches.identity)
  return { host, runtimeRoot, dispatchesRoot, dispatchRoot, dispatches, root }
}

describe('native Codex laboratory runtime layout host', () => {
  it('exports only the canonical zero-argument production factory', () => {
    expect(Object.keys(nativeProductionFacade).sort()).toEqual([
      'createNativeCodexLabRuntimeLayoutHost'
    ])
  })

  it('uses exclusive exact-mode entries and hashes the captured config inode', async () => {
    const fixture = await createFixture()
    const codexHomePath = join(fixture.dispatchRoot, 'codex-home')
    const fakeHomePath = join(fixture.dispatchRoot, 'fake-home')
    const configPath = join(codexHomePath, 'config.toml')
    const codexHome = await fixture.host.makeDirectoryExclusive(
      codexHomePath,
      0o700,
      fixture.root.identity
    )
    await fixture.host.makeDirectoryExclusive(fakeHomePath, 0o700, fixture.root.identity)
    const configContents = 'approval_policy = "never"\n'
    const config = await fixture.host.writeFileExclusive(
      configPath,
      configContents,
      0o600,
      codexHome.identity
    )

    expect(await fixture.host.observePath(fixture.dispatchRoot)).toMatchObject({
      kind: 'directory',
      mode: 0o700,
      ownedByCurrentUser: true,
      identity: fixture.root.identity
    })
    expect(await fixture.host.observePath(configPath)).toMatchObject({
      kind: 'file',
      mode: 0o600,
      ownedByCurrentUser: true,
      identity: config.identity
    })
    await expect(fixture.host.sha256File(configPath, config.identity)).resolves.toBe(
      createHash('sha256').update(configContents).digest('hex')
    )
    await expect(
      fixture.host.writeFileExclusive(configPath, 'replacement', 0o600, codexHome.identity)
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(configPath, 'utf8')).toBe(configContents)
  })

  it('lstats symlinks and refuses both symlink claims and path escapes', async () => {
    const fixture = await createFixture()
    const external = join(sandbox, 'external.txt')
    const linkedConfig = join(fixture.dispatchRoot, 'config.toml')
    await writeFile(external, 'sentinel')
    await symlink(external, linkedConfig)

    expect(await fixture.host.observePath(linkedConfig)).toMatchObject({ kind: 'other' })
    await expect(
      fixture.host.writeFileExclusive(linkedConfig, 'replacement', 0o600, fixture.root.identity)
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(fixture.host.observePath(join(sandbox, 'sibling-escape'))).rejects.toThrow(
      /escaped/u
    )
    expect(await readFile(external, 'utf8')).toBe('sentinel')
  })

  it('refuses a symlink in place of an owned runtime parent without touching its target', async () => {
    const runtimeRoot = join(sandbox, 'runtime')
    const external = join(sandbox, 'external')
    const sentinel = join(external, 'sentinel.txt')
    await mkdir(external, { mode: 0o700 })
    await writeFile(sentinel, 'keep')
    await symlink(external, runtimeRoot)
    const host = createNativeCodexLabRuntimeLayoutHostForTest(runtimeRoot)
    const sandboxObservation = await host.observePath(sandbox)
    if (sandboxObservation.kind !== 'directory') {
      throw new Error('temporary sandbox must be a directory')
    }

    expect(await host.observePath(runtimeRoot)).toMatchObject({ kind: 'other' })
    await expect(
      host.makeDirectoryExclusive(runtimeRoot, 0o700, sandboxObservation.identity)
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep')
  })

  it('rejects wrong config mode during descriptor-bound digest readback', async () => {
    const fixture = await createFixture()
    const configPath = join(fixture.dispatchRoot, 'config.toml')
    const config = await fixture.host.writeFileExclusive(
      configPath,
      'sealed',
      0o600,
      fixture.root.identity
    )
    await chmod(configPath, 0o644)

    await expect(fixture.host.sha256File(configPath, config.identity)).rejects.toThrow(
      /captured identity/u
    )
  })

  it('quarantines the captured root and reports cleanup incomplete without deleting nested targets', async () => {
    const fixture = await createFixture({ randomId: () => 'retained' })
    const sibling = join(fixture.dispatchesRoot, 'sibling')
    const external = join(sandbox, 'external')
    const externalSentinel = join(external, 'sentinel.txt')
    await mkdir(sibling, { mode: 0o700 })
    await mkdir(external, { mode: 0o700 })
    await writeFile(externalSentinel, 'keep')
    await symlink(external, join(fixture.dispatchRoot, 'external-link'))

    await expect(
      fixture.host.removeTree(
        fixture.dispatchRoot,
        fixture.root.identity,
        fixture.dispatches.identity
      )
    ).rejects.toMatchObject({
      code: CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE_CODE,
      reason: 'cleanup_incomplete',
      message: expect.not.stringContaining('removed')
    })

    await expect(lstat(fixture.dispatchRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    const quarantines = (await readdir(fixture.dispatchesRoot)).filter((name) =>
      name.includes('.cleanup-')
    )
    expect(quarantines).toHaveLength(1)
    const quarantine = join(fixture.dispatchesRoot, quarantines[0]!)
    expect((await lstat(quarantine)).isDirectory()).toBe(true)
    expect((await lstat(join(quarantine, 'external-link'))).isSymbolicLink()).toBe(true)
    await expect(lstat(sibling)).resolves.toBeDefined()
    await expect(readFile(externalSentinel, 'utf8')).resolves.toBe('keep')
  })

  it('retains a same-path replacement when cleanup holds a stale dev/inode identity', async () => {
    const fixture = await createFixture()
    const original = join(fixture.dispatchesRoot, 'original-generation')
    await rename(fixture.dispatchRoot, original)
    await mkdir(fixture.dispatchRoot, { mode: 0o700 })
    await writeFile(join(fixture.dispatchRoot, 'replacement.txt'), 'keep')

    await expect(
      fixture.host.removeTree(
        fixture.dispatchRoot,
        fixture.root.identity,
        fixture.dispatches.identity
      )
    ).rejects.toThrow(/captured identity/u)
    await expect(readFile(join(fixture.dispatchRoot, 'replacement.txt'), 'utf8')).resolves.toBe(
      'keep'
    )
    await expect(lstat(original)).resolves.toBeDefined()
  })

  it('refuses a symlink replacement at cleanup and preserves the external tree', async () => {
    const fixture = await createFixture()
    const original = join(fixture.dispatchesRoot, 'original-generation')
    const sentinel = join(original, 'sentinel.txt')
    await writeFile(join(fixture.dispatchRoot, 'sentinel.txt'), 'keep')
    await rename(fixture.dispatchRoot, original)
    await symlink(original, fixture.dispatchRoot)

    await expect(
      fixture.host.removeTree(
        fixture.dispatchRoot,
        fixture.root.identity,
        fixture.dispatches.identity
      )
    ).rejects.toThrow(/captured identity/u)

    expect((await lstat(fixture.dispatchRoot)).isSymbolicLink()).toBe(true)
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep')
  })

  it('detects a replacement between precheck and quarantine and never deletes it', async () => {
    let dispatchRoot = ''
    let displaced = ''
    const fixture = await createFixture({
      randomId: () => {
        displaced = join(dirname(dispatchRoot), 'displaced-generation')
        renameSync(dispatchRoot, displaced)
        mkdirSync(dispatchRoot, { mode: 0o700 })
        return 'race'
      }
    })
    dispatchRoot = fixture.dispatchRoot

    await expect(
      fixture.host.removeTree(
        fixture.dispatchRoot,
        fixture.root.identity,
        fixture.dispatches.identity
      )
    ).rejects.toThrow(/retained/u)

    await expect(lstat(displaced)).resolves.toBeDefined()
    const quarantines = (await readdir(fixture.dispatchesRoot)).filter((name) =>
      name.includes('.cleanup-')
    )
    expect(quarantines).toHaveLength(1)
    await expect(lstat(join(fixture.dispatchesRoot, quarantines[0]!))).resolves.toBeDefined()
  })

  it('never deletes either generation when the quarantine path is replaced after re-attestation', async () => {
    let quarantine = ''
    let capturedElsewhere = ''
    const fixture = await createFixture({
      randomId: () => 'post-attestation-race',
      afterQuarantineAttested: (quarantinePath) => {
        quarantine = quarantinePath
        capturedElsewhere = join(dirname(quarantinePath), 'captured-after-attestation')
        renameSync(quarantinePath, capturedElsewhere)
        mkdirSync(quarantinePath, { mode: 0o700 })
        writeFileSync(join(quarantinePath, 'replacement.txt'), 'keep')
      }
    })
    writeFileSync(join(fixture.dispatchRoot, 'captured.txt'), 'keep')

    await expect(
      fixture.host.removeTree(
        fixture.dispatchRoot,
        fixture.root.identity,
        fixture.dispatches.identity
      )
    ).rejects.toMatchObject({
      code: CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE_CODE,
      reason: 'cleanup_incomplete',
      quarantinePath: quarantine
    })

    await expect(readFile(join(capturedElsewhere, 'captured.txt'), 'utf8')).resolves.toBe('keep')
    await expect(readFile(join(quarantine, 'replacement.txt'), 'utf8')).resolves.toBe('keep')
  })
})
