import { InvalidTransitionError } from '../errors/InvalidTransitionError.js';

const STATUSES = {
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
};

const TRANSITIONS = {
  [STATUSES.QUEUED]:      [STATUSES.RUNNING, STATUSES.CANCELLED],
  [STATUSES.RUNNING]:     [STATUSES.DONE, STATUSES.FAILED, STATUSES.TIMEOUT, STATUSES.INTERRUPTED, STATUSES.CANCELLED],
  [STATUSES.DONE]:        [],
  [STATUSES.FAILED]:      [],
  [STATUSES.TIMEOUT]:     [],
  [STATUSES.CANCELLED]:   [],
  [STATUSES.INTERRUPTED]: [],
};

export class Run {
  static STATUSES = STATUSES;

  constructor({ id, sessionId, taskId, stepId, roleName, prompt, response, status, callbackUrl, callbackMeta, startedAt, finishedAt, durationMs, error, createdAt }) {
    this.id = id;
    this.sessionId = sessionId ?? null;
    this.taskId = taskId ?? null;
    this.stepId = stepId ?? null;
    this.roleName = roleName;
    this.prompt = prompt;
    this.response = response ?? null;
    this.status = status;
    this.callbackUrl = callbackUrl ?? null;
    this.callbackMeta = callbackMeta ?? null;
    this.startedAt = startedAt ?? null;
    this.finishedAt = finishedAt ?? null;
    this.durationMs = durationMs ?? null;
    this.error = error ?? null;
    this.createdAt = createdAt;
  }

  static create({ taskId, stepId, roleName, prompt, callbackUrl, callbackMeta }) {
    return new Run({
      id: crypto.randomUUID(),
      sessionId: null,
      taskId,
      stepId,
      roleName,
      prompt,
      response: null,
      status: STATUSES.QUEUED,
      callbackUrl,
      callbackMeta,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      error: null,
      createdAt: new Date(),
    });
  }

  canTransitionTo(newStatus) {
    const allowed = TRANSITIONS[this.status];
    return allowed ? allowed.includes(newStatus) : false;
  }

  transitionTo(newStatus) {
    if (!this.canTransitionTo(newStatus)) {
      throw new InvalidTransitionError(this.status, newStatus, 'Run');
    }
    this.status = newStatus;
  }

  start(sessionId) {
    this.transitionTo(STATUSES.RUNNING);
    this.sessionId = sessionId;
    this.startedAt = new Date();
  }

  complete(response) {
    this.transitionTo(STATUSES.DONE);
    this.response = response;
    this.finishedAt = new Date();
    this.durationMs = this.finishedAt - this.startedAt;
  }

  fail(error) {
    this.transitionTo(STATUSES.FAILED);
    this.error = error;
    this.finishedAt = new Date();
    this.durationMs = this.startedAt ? this.finishedAt - this.startedAt : null;
  }

  markTimeout() {
    this.transitionTo(STATUSES.TIMEOUT);
    this.finishedAt = new Date();
    this.durationMs = this.startedAt ? this.finishedAt - this.startedAt : null;
  }

  interrupt() {
    this.transitionTo(STATUSES.INTERRUPTED);
    this.finishedAt = new Date();
    this.durationMs = this.startedAt ? this.finishedAt - this.startedAt : null;
  }

  cancel() {
    this.transitionTo(STATUSES.CANCELLED);
    this.finishedAt = new Date();
    this.durationMs = this.startedAt ? this.finishedAt - this.startedAt : null;
  }

  static fromRow(row) {
    return new Run({
      id: row.id,
      sessionId: row.session_id,
      taskId: row.task_id,
      stepId: row.step_id,
      roleName: row.role_name,
      prompt: row.prompt,
      response: row.response,
      status: row.status,
      callbackUrl: row.callback_url,
      callbackMeta: row.callback_meta,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      error: row.error,
      createdAt: row.created_at,
    });
  }

  toRow() {
    return {
      id: this.id,
      session_id: this.sessionId,
      task_id: this.taskId,
      step_id: this.stepId,
      role_name: this.roleName,
      prompt: this.prompt,
      response: this.response,
      status: this.status,
      callback_url: this.callbackUrl,
      callback_meta: this.callbackMeta,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      duration_ms: this.durationMs,
      error: this.error,
      created_at: this.createdAt,
    };
  }
}
