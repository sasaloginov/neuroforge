import { DomainError } from './DomainError.js';

export class RoleNotFoundError extends DomainError {
  constructor(roleName) {
    super(`Role not found: ${roleName}`, 'ROLE_NOT_FOUND');
    this.roleName = roleName;
  }
}
