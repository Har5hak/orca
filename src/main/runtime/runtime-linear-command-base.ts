import type { RuntimeTerminalShow } from '../../shared/runtime-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { LinearLinkedIssueUpdatedEvent } from './runtime-linear-command-dependencies'
import { RuntimeLinearBrowseCommands } from './runtime-linear-browse-commands'

export type RuntimeLinearCommandPorts = {
  runtimeAvailable: () => boolean
  showTerminal: (handle: string) => Promise<RuntimeTerminalShow>
  resolveWorktreeSelector: (selector: string) => Promise<ResolvedWorktree>
  listResolvedWorktrees: () => Promise<ResolvedWorktree[]>
  setWorktreeMeta: (
    worktreeId: string,
    meta: {
      linkedLinearIssueWorkspaceId: string
      linkedLinearIssueOrganizationUrlKey: string | null
    }
  ) => void
  emitClientEvent: (event: LinearLinkedIssueUpdatedEvent) => void
  beginMutationReceipt: (params: { requestId: string; method: string; payloadHash: string }) => {
    disposition: 'started' | 'pending' | 'completed'
    receipt: string | null
  }
  checkpointMutationReceipt: (params: {
    requestId: string
    method: string
    payloadHash: string
    receipt: string
  }) => void
  completeMutationReceipt: (params: {
    requestId: string
    method: string
    payloadHash: string
    receipt: string
  }) => void
  discardMutationReceipt: (requestId: string) => void
}

// Why: browse reads sit at the chain root so write commands can re-enter them through `this`, as they did on the facade.
export class RuntimeLinearCommandBase extends RuntimeLinearBrowseCommands {
  constructor(private readonly ports: RuntimeLinearCommandPorts) {
    super()
  }

  protected runtimeAvailable(): boolean {
    return this.ports.runtimeAvailable()
  }

  protected showTerminal(handle: string): Promise<RuntimeTerminalShow> {
    return this.ports.showTerminal(handle)
  }

  protected resolveWorktreeSelector(selector: string): Promise<ResolvedWorktree> {
    return this.ports.resolveWorktreeSelector(selector)
  }

  protected listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return this.ports.listResolvedWorktrees()
  }

  protected setWorktreeMeta(
    worktreeId: string,
    meta: {
      linkedLinearIssueWorkspaceId: string
      linkedLinearIssueOrganizationUrlKey: string | null
    }
  ): void {
    this.ports.setWorktreeMeta(worktreeId, meta)
  }

  protected emitClientEvent(event: LinearLinkedIssueUpdatedEvent): void {
    this.ports.emitClientEvent(event)
  }

  protected beginMutationReceipt(
    requestId: string,
    method: string,
    payloadHash: string
  ): { disposition: 'started' | 'pending' | 'completed'; receipt: string | null } {
    return this.ports.beginMutationReceipt({ requestId, method, payloadHash })
  }

  protected checkpointMutationReceipt(
    requestId: string,
    method: string,
    payloadHash: string,
    receipt: string
  ): void {
    this.ports.checkpointMutationReceipt({ requestId, method, payloadHash, receipt })
  }

  protected completeMutationReceipt(
    requestId: string,
    method: string,
    payloadHash: string,
    receipt: string
  ): void {
    this.ports.completeMutationReceipt({ requestId, method, payloadHash, receipt })
  }

  protected discardMutationReceipt(requestId: string): void {
    this.ports.discardMutationReceipt(requestId)
  }
}
