import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { openCodexAppServerConnection } from './codex-app-server-connection'

type StubChild = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  pid: number | undefined
  kill: ReturnType<typeof vi.fn>
}

function stubChild(options: { processExists?: boolean; exitOnStdinEnd?: boolean } = {}): {
  child: StubChild
  spawnImpl: typeof spawnProcess
} {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The streams and process fields required by this controlled child stub are assigned immediately below.
  const child = new EventEmitter() as StubChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.pid = options.processExists === false ? undefined : 9_999_998
  child.kill = vi.fn()
  if (options.exitOnStdinEnd !== false) {
    child.stdin.on('finish', () => child.emit('exit', 0, null))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Production only consumes the ChildProcess fields fully modeled by StubChild in these focused tests.
  return { child, spawnImpl: (() => child) as unknown as typeof spawnProcess }
}

function answerInitialize(child: StubChild, error?: string): void {
  child.stdin.once('data', () => {
    const response = error
      ? { id: 1, error: { code: -32602, message: error } }
      : { id: 1, result: {} }
    child.stdout.write(`${JSON.stringify(response)}\n`)
  })
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Codex app-server child exit observation', () => {
  it('reports one observed exit for a requested close without changing onExit semantics', async () => {
    const { child, spawnImpl } = stubChild()
    answerInitialize(child)
    const onExit = vi.fn()
    const onExitObserved = vi.fn()
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit, onExitObserved },
      spawnImpl
    )

    await expect(connection.close()).resolves.toBe(true)
    child.emit('close', 0, null)
    child.emit('exit', 0, null)

    expect(onExitObserved).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('reports one observed exit across unexpected exit and close events', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const onExit = vi.fn()
    const onExitObserved = vi.fn()
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit, onExitObserved },
      spawnImpl
    )

    child.emit('exit', 1, null)
    child.emit('close', 1, null)

    expect(onExitObserved).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledOnce()
    await expect(connection.close()).resolves.toBe(true)
  })

  it('does not report a failed close until a later child exit is observed', async () => {
    vi.useFakeTimers()
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    answerInitialize(child)
    const onExitObserved = vi.fn()
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExitObserved },
      spawnImpl
    )

    const closing = connection.close()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(closing).resolves.toBe(false)
    expect(onExitObserved).not.toHaveBeenCalled()

    child.emit('close', null, 'SIGKILL')
    child.emit('exit', null, 'SIGKILL')
    expect(onExitObserved).toHaveBeenCalledOnce()
  })

  it('waits for actual exit during handshake teardown when a child existed', async () => {
    const { child, spawnImpl } = stubChild({ exitOnStdinEnd: false })
    const onExitObserved = vi.fn()
    const opening = openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExitObserved },
      spawnImpl
    ).catch((error: unknown) => error)

    child.emit('error', new Error('spawn transport failed'))
    await flushMicrotasks()
    expect(onExitObserved).not.toHaveBeenCalled()

    child.emit('exit', 1, null)
    expect(await opening).toBeInstanceOf(Error)
    expect(onExitObserved).toHaveBeenCalledOnce()
  })

  it('reports handshake rejection teardown after the requested close observes exit', async () => {
    const { child, spawnImpl } = stubChild()
    answerInitialize(child, 'initialize rejected')
    const onExitObserved = vi.fn()

    await expect(
      openCodexAppServerConnection(
        { command: 'codex', args: ['app-server'] },
        { onExitObserved },
        spawnImpl
      )
    ).rejects.toThrow('initialize rejected')
    expect(onExitObserved).toHaveBeenCalledOnce()
  })

  it('does not claim process exit when spawn never produced a child pid', async () => {
    const { child, spawnImpl } = stubChild({ processExists: false, exitOnStdinEnd: false })
    const onExitObserved = vi.fn()
    const opening = openCodexAppServerConnection(
      { command: 'missing-codex', args: ['app-server'] },
      { onExitObserved },
      spawnImpl
    ).catch((error: unknown) => error)

    child.emit('error', new Error('spawn ENOENT'))
    child.emit('close', -2, null)

    expect(await opening).toBeInstanceOf(Error)
    expect(onExitObserved).not.toHaveBeenCalled()
  })
})
