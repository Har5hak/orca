import { randomUUID } from 'node:crypto'

export function mintStructuredWorkerSessionId(): string {
  return randomUUID()
}
