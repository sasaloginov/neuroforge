import { DomainError } from './DomainError.js';

export class RunNotFoundError extends DomainError {
  constructor(runId) {
    super(`Run not found: ${runId}`, 'RUN_NOT_FOUND');
    this.runId = runId;
  }
}
