import { DomainError } from './DomainError.js';

export class RunTimeoutError extends DomainError {
  constructor(runId, timeoutMs) {
    super(`Run timed out after ${timeoutMs}ms: ${runId}`, 'RUN_TIMEOUT');
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
}
