import { describe, expect, it } from 'vitest'
import { retryRoutingContext } from './retry-routing-context'

describe('retryRoutingContext', () => {
  it('preserves explicit and host-derived non-secret environment selectors', () => {
    expect(retryRoutingContext(new Map([['environment', 'gpu']]), {})).toEqual({
      remoteEnvironmentSelector: 'gpu',
      remoteRoutingRequired: true
    })
    expect(retryRoutingContext(new Map([['host', 'runtime:environment-1']]), {})).toEqual({
      remoteEnvironmentSelector: 'environment-1',
      remoteRoutingRequired: true
    })
  })

  it('marks pairing-only routing without retaining the secret', () => {
    const context = retryRoutingContext(new Map([['pairing-code', 'secret-pairing-code']]), {})

    expect(context).toEqual({ remoteRoutingRequired: true })
    expect(JSON.stringify(context)).not.toContain('secret-pairing-code')
    expect(retryRoutingContext(new Map(), { ORCA_REMOTE_PAIRING: 'legacy-secret' })).toEqual({
      remoteRoutingRequired: true
    })
  })
})
