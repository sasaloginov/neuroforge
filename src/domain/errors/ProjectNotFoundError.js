import { DomainError } from './DomainError.js';

export class ProjectNotFoundError extends DomainError {
  constructor(projectId) {
    super(`Project not found: ${projectId}`, 'PROJECT_NOT_FOUND');
    this.projectId = projectId;
  }
}
