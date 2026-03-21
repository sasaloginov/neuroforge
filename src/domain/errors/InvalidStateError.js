import { DomainError } from './DomainError.js';

export class InvalidStateError extends DomainError {
  constructor(message) {
    super(message, 'INVALID_STATE');
  }
}
