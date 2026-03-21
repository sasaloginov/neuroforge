import { DomainError } from './DomainError.js';

export class RevisionLimitError extends DomainError {
  constructor(taskId, limit) {
    super(`Revision limit (${limit}) exceeded for task: ${taskId}`, 'REVISION_LIMIT');
    this.taskId = taskId;
    this.limit = limit;
  }
}
