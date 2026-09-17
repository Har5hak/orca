import { describe, expect, it } from 'vitest'
import { buildCodexAppServerChildEnvironment } from './codex-app-server-environment'

const launch = {
  command: '/opt/codex',
  args: ['app-server'],
  env: { CODEX_HOME: '/lab/codex-home', HOME: '/lab/fake-home' }
}

describe('Codex app-server child environment', () => {
  it('uses only the supplied environment in exact mode', () => {
    expect(
      buildCodexAppServerChildEnvironment(
        { ...launch, environmentMode: 'exact' },
        { PATH: '/ambient/bin', OPENAI_API_KEY: 'forbidden', HTTP_PROXY: 'forbidden' }
      )
    ).toEqual({ CODEX_HOME: '/lab/codex-home', HOME: '/lab/fake-home' })
  })

  it('preserves inherited overlay behavior when exact mode is absent', () => {
    expect(
      buildCodexAppServerChildEnvironment(launch, {
        PATH: '/ambient/bin',
        AMBIENT_SAFE: 'present'
      })
    ).toEqual({
      PATH: '/ambient/bin',
      AMBIENT_SAFE: 'present',
      CODEX_HOME: '/lab/codex-home',
      HOME: '/lab/fake-home'
    })
  })
})
