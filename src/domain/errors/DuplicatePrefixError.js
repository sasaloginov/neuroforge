import { DomainError } from './DomainError.js';

export class DuplicatePrefixError extends DomainError {
  constructor(prefix) {
    super(`Project prefix already exists: ${prefix}`, 'DUPLICATE_PREFIX');
    this.prefix = prefix;
  }
}
