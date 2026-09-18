import { describe, expect, it, vi } from 'vitest'
import { verifiedCodexLabHostPrerequisiteReceipt } from './orchestration/lab-profile/codex-lab-host-prerequisites.test-support'
import { bootstrapRuntimeLabProfileReadiness } from './runtime-lab-profile-readiness-bootstrap'

describe('runtime lab-profile readiness bootstrap', () => {
  it('opens orchestration state before publishing verified process-wide prerequisites', () => {
    const receipt = verifiedCodexLabHostPrerequisiteReceipt()
    const installLabProfileHostPrerequisites = vi.fn()
    const order: string[] = []

    const result = bootstrapRuntimeLabProfileReadiness(
      {
        getOrchestrationDb: vi.fn(() => {
          order.push('orchestration-state')
        }),
        installLabProfileHostPrerequisites: vi.fn((installed) => {
          order.push('install')
          installLabProfileHostPrerequisites(installed)
        })
      },
      () => {
        order.push('host-prerequisites')
        return receipt
      }
    )

    expect(result).toEqual({ ready: true, receipt })
    expect(installLabProfileHostPrerequisites).toHaveBeenCalledExactlyOnceWith(receipt)
    expect(order).toEqual(['host-prerequisites', 'orchestration-state', 'install'])
  })

  it('leaves the capability dark when orchestration state cannot be opened', () => {
    const installLabProfileHostPrerequisites = vi.fn()
    const verify = vi.fn(() => verifiedCodexLabHostPrerequisiteReceipt())
    const failure = new Error('unreadable orchestration state')

    const result = bootstrapRuntimeLabProfileReadiness(
      {
        getOrchestrationDb: () => {
          throw failure
        },
        installLabProfileHostPrerequisites
      },
      verify
    )

    expect(result).toEqual({ ready: false, error: failure })
    expect(verify).toHaveBeenCalledOnce()
    expect(installLabProfileHostPrerequisites).not.toHaveBeenCalled()
  })

  it('leaves the capability dark when native prerequisite verification fails', () => {
    const installLabProfileHostPrerequisites = vi.fn()
    const failure = new Error('unsupported host')

    const result = bootstrapRuntimeLabProfileReadiness(
      {
        getOrchestrationDb: vi.fn(),
        installLabProfileHostPrerequisites
      },
      () => {
        throw failure
      }
    )

    expect(result).toEqual({ ready: false, error: failure })
    expect(installLabProfileHostPrerequisites).not.toHaveBeenCalled()
  })
})
