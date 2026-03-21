import { DomainError } from './DomainError.js';

export class TaskNotFoundError extends DomainError {
  constructor(taskId) {
    super(`Task not found: ${taskId}`, 'TASK_NOT_FOUND');
    this.taskId = taskId;
  }
}
