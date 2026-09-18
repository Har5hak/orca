export type LabGatewayServerStart<TReceipt> = Readonly<{
  startTransport: () => Promise<void>
  buildReceipt: () => Promise<TReceipt>
  stopTransport: () => Promise<void>
}>

export type LabGatewayLocalAuthorityState = 'starting' | 'active' | 'revoked'

export class LabGatewayServerLifecycle<TReceipt> {
  private readonly authorityAbort = new AbortController()
  private authorityStateValue: LabGatewayLocalAuthorityState = 'starting'
  private receiptValue: TReceipt | null = null
  private startOperation: Promise<TReceipt> | null = null
  private stopOperation: Promise<void> | null = null

  get isAuthorityActive(): boolean {
    return this.authorityStateValue === 'active'
  }

  get authorityState(): LabGatewayLocalAuthorityState {
    return this.authorityStateValue
  }

  get authoritySignal(): AbortSignal {
    return this.authorityAbort.signal
  }

  get receipt(): TReceipt | null {
    return this.receiptValue
  }

  start(options: LabGatewayServerStart<TReceipt>): Promise<TReceipt> {
    if (this.authorityStateValue === 'revoked') {
      return Promise.reject(new Error('Laboratory gateway authority has been revoked'))
    }
    if (this.receiptValue) {
      return Promise.resolve(this.receiptValue)
    }
    if (this.startOperation) {
      return this.startOperation
    }

    const operation = this.startOnce(options)
    this.startOperation = operation
    operation.then(
      () => this.clearStartOperation(operation),
      () => this.clearStartOperation(operation)
    )
    return operation
  }

  stop(stopTransport: () => Promise<void>): Promise<void> {
    this.revokeAuthority()
    if (this.stopOperation) {
      return this.stopOperation
    }

    const starting = this.startOperation
    const operation = (async () => {
      if (starting) {
        await starting.catch(() => undefined)
      }
      await stopTransport()
    })()
    this.stopOperation = operation
    operation.then(
      () => this.clearStopOperation(operation),
      () => this.clearStopOperation(operation)
    )
    return operation
  }

  private async startOnce(options: LabGatewayServerStart<TReceipt>): Promise<TReceipt> {
    try {
      await options.startTransport()
      this.requireStartingAuthority()
      const receipt = await options.buildReceipt()
      this.requireStartingAuthority()
      this.receiptValue = receipt
      this.authorityStateValue = 'active'
      return receipt
    } catch (error) {
      this.revokeAuthority()
      try {
        await options.stopTransport()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Laboratory gateway start failed and transport cleanup did not complete'
        )
      }
      throw error
    }
  }

  private revokeAuthority(): void {
    if (this.authorityStateValue === 'revoked') {
      return
    }
    this.authorityStateValue = 'revoked'
    // The receipt is public identity evidence rather than authority. Retain a
    // committed receipt so a client can authenticate a post-revocation refusal.
    this.authorityAbort.abort()
  }

  private requireStartingAuthority(): void {
    if (this.authorityStateValue !== 'starting') {
      throw new Error('Laboratory gateway was stopped while starting')
    }
  }

  private clearStartOperation(operation: Promise<TReceipt>): void {
    if (this.startOperation === operation) {
      this.startOperation = null
    }
  }

  private clearStopOperation(operation: Promise<void>): void {
    if (this.stopOperation === operation) {
      this.stopOperation = null
    }
  }
}
