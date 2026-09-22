import type {
  LinearIssueTaskUpdateRequest,
  LinearIssueTaskUpdateResult,
  LinearLabelDescriptionUpdateRequest,
  LinearLabelDescriptionUpdateResult
} from '../../shared/linear/agent-access'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { formatLinearLabelDescriptionUpdate, formatLinearTaskUpdate } from '../linear-format'
import { buildWriteTargetRequest, rejectAllWorkspaceForWrite } from '../linear-request-builders'

const LINEAR_WRITE_TIMEOUT_MS = 75_000

export const LINEAR_ADMIN_HANDLERS: Record<string, CommandHandler> = {
  'linear milestone set': async (ctx) =>
    runTaskUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'projectMilestone',
      projectMilestone: getRequiredStringFlag(ctx.flags, 'to'),
      writeId: getOptionalStringFlag(ctx.flags, 'write-id')
    }),
  'linear milestone clear': async (ctx) =>
    runTaskUpdate(ctx, {
      ...buildWriteTargetRequest(ctx.flags, ctx.cwd, ctx.client.isRemote),
      operation: 'projectMilestone',
      projectMilestone: null,
      writeId: getOptionalStringFlag(ctx.flags, 'write-id')
    }),
  'linear label description set': async ({ flags, client, json }) => {
    rejectAllWorkspaceForWrite(flags)
    const request: LinearLabelDescriptionUpdateRequest = {
      teamInput: getRequiredStringFlag(flags, 'team'),
      labelInput: getRequiredStringFlag(flags, 'label'),
      description: getRequiredStringFlag(flags, 'description'),
      workspaceId: getOptionalStringFlag(flags, 'workspace'),
      writeId: getOptionalStringFlag(flags, 'write-id')
    }
    const response = await client.call<LinearLabelDescriptionUpdateResult>(
      'linear.labelUpdateDescription',
      request,
      { timeoutMs: LINEAR_WRITE_TIMEOUT_MS }
    )
    printResult(response, json, formatLinearLabelDescriptionUpdate)
  }
}

async function runTaskUpdate(
  { client, json }: Parameters<CommandHandler>[0],
  request: LinearIssueTaskUpdateRequest
): Promise<void> {
  const response = await client.call<LinearIssueTaskUpdateResult>(
    'linear.issueUpdateTask',
    request,
    { timeoutMs: LINEAR_WRITE_TIMEOUT_MS }
  )
  printResult(response, json, formatLinearTaskUpdate)
}
