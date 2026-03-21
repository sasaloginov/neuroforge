import { DomainError } from './DomainError.js';

export class ValidationError extends DomainError {
  constructor(message) {
    super(message, 'VALIDATION_ERROR');
  }
}
