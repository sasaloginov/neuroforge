import { DomainError } from './DomainError.js';

export class InvalidTransitionError extends DomainError {
  constructor(from, to, entityType = 'Task') {
    super(`Invalid ${entityType} transition: ${from} → ${to}`, 'INVALID_TRANSITION');
    this.from = from;
    this.to = to;
    this.entityType = entityType;
  }
}
