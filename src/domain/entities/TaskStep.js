import { InvalidTransitionError } from '../errors/InvalidTransitionError.js';

const STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
};

const TRANSITIONS = {
  [STATUSES.PENDING]: [STATUSES.RUNNING],
  [STATUSES.RUNNING]: [STATUSES.DONE, STATUSES.FAILED, STATUSES.TIMEOUT],
  [STATUSES.DONE]:    [],
  [STATUSES.FAILED]:  [],
  [STATUSES.TIMEOUT]: [],
};

export class TaskStep {
  static STATUSES = STATUSES;

  constructor({ id, taskId, roleName, sessionId, stepOrder, promptTemplate, status, createdAt }) {
    this.id = id;
    this.taskId = taskId;
    this.roleName = roleName;
    this.sessionId = sessionId ?? null;
    this.stepOrder = stepOrder;
    this.promptTemplate = promptTemplate;
    this.status = status;
    this.createdAt = createdAt;
  }

  static create({ taskId, roleName, stepOrder, promptTemplate }) {
    return new TaskStep({
      id: crypto.randomUUID(),
      taskId,
      roleName,
      sessionId: null,
      stepOrder,
      promptTemplate,
      status: STATUSES.PENDING,
      createdAt: new Date(),
    });
  }

  canTransitionTo(newStatus) {
    const allowed = TRANSITIONS[this.status];
    return allowed ? allowed.includes(newStatus) : false;
  }

  transitionTo(newStatus) {
    if (!this.canTransitionTo(newStatus)) {
      throw new InvalidTransitionError(this.status, newStatus, 'TaskStep');
    }
    this.status = newStatus;
  }

  static fromRow(row) {
    return new TaskStep({
      id: row.id,
      taskId: row.task_id,
      roleName: row.role_name,
      sessionId: row.session_id,
      stepOrder: row.step_order,
      promptTemplate: row.prompt_template,
      status: row.status,
      createdAt: row.created_at,
    });
  }

  toRow() {
    return {
      id: this.id,
      task_id: this.taskId,
      role_name: this.roleName,
      session_id: this.sessionId,
      step_order: this.stepOrder,
      prompt_template: this.promptTemplate,
      status: this.status,
      created_at: this.createdAt,
    };
  }
}
