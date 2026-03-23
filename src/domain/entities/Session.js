import { InvalidTransitionError } from '../errors/InvalidTransitionError.js';

const STATUSES = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  CLOSED: 'closed',
};

const TRANSITIONS = {
  [STATUSES.ACTIVE]:  [STATUSES.EXPIRED, STATUSES.CLOSED],
  [STATUSES.EXPIRED]: [STATUSES.CLOSED],
  [STATUSES.CLOSED]:  [],
};

export class Session {
  static STATUSES = STATUSES;

  constructor({ id, projectId, taskId, cliSessionId, roleName, status, createdAt, updatedAt }) {
    this.id = id;
    this.projectId = projectId;
    this.taskId = taskId ?? null;
    this.cliSessionId = cliSessionId ?? null;
    this.roleName = roleName;
    this.status = status;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  static create({ projectId, taskId, roleName, cliSessionId }) {
    const now = new Date();
    return new Session({
      id: crypto.randomUUID(),
      projectId,
      taskId: taskId ?? null,
      cliSessionId,
      roleName,
      status: STATUSES.ACTIVE,
      createdAt: now,
      updatedAt: now,
    });
  }

  canTransitionTo(newStatus) {
    const allowed = TRANSITIONS[this.status];
    return allowed ? allowed.includes(newStatus) : false;
  }

  transitionTo(newStatus) {
    if (!this.canTransitionTo(newStatus)) {
      throw new InvalidTransitionError(this.status, newStatus, 'Session');
    }
    this.status = newStatus;
    this.updatedAt = new Date();
  }

  close() {
    this.transitionTo(STATUSES.CLOSED);
  }

  expire() {
    this.transitionTo(STATUSES.EXPIRED);
  }

  static fromRow(row) {
    return new Session({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id ?? null,
      cliSessionId: row.cli_session_id,
      roleName: row.role_name,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  toRow() {
    return {
      id: this.id,
      project_id: this.projectId,
      task_id: this.taskId,
      cli_session_id: this.cliSessionId,
      role_name: this.roleName,
      status: this.status,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }
}
