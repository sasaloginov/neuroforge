import { InvalidTransitionError } from '../errors/InvalidTransitionError.js';

const STATUSES = {
  BACKLOG: 'backlog',
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  WAITING_REPLY: 'waiting_reply',
  NEEDS_ESCALATION: 'needs_escalation',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const TRANSITIONS = {
  [STATUSES.BACKLOG]:          [STATUSES.PENDING, STATUSES.CANCELLED],
  [STATUSES.PENDING]:          [STATUSES.IN_PROGRESS, STATUSES.CANCELLED],
  [STATUSES.IN_PROGRESS]:      [STATUSES.WAITING_REPLY, STATUSES.NEEDS_ESCALATION, STATUSES.DONE, STATUSES.FAILED, STATUSES.CANCELLED],
  [STATUSES.WAITING_REPLY]:    [STATUSES.IN_PROGRESS, STATUSES.CANCELLED],
  [STATUSES.NEEDS_ESCALATION]: [STATUSES.IN_PROGRESS, STATUSES.CANCELLED],
  [STATUSES.DONE]:             [],
  [STATUSES.FAILED]:           [STATUSES.IN_PROGRESS],
  [STATUSES.CANCELLED]:        [],
};

export class Task {
  static STATUSES = STATUSES;

  constructor({ id, projectId, title, description, status, callbackUrl, callbackMeta, revisionCount, seqNumber, projectPrefix, branchName, createdAt, updatedAt }) {
    this.id = id;
    this.projectId = projectId;
    this.title = title;
    this.description = description ?? null;
    this.status = status;
    this.callbackUrl = callbackUrl ?? null;
    this.callbackMeta = callbackMeta ?? null;
    this.revisionCount = revisionCount ?? 0;
    this.seqNumber = seqNumber ?? null;
    this.projectPrefix = projectPrefix ?? null;
    this.branchName = branchName ?? null;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  get shortId() {
    if (this.projectPrefix && this.seqNumber != null) {
      return `${this.projectPrefix}-${this.seqNumber}`;
    }
    return null;
  }

  static create({ projectId, title, description, callbackUrl, callbackMeta, seqNumber, status }) {
    const now = new Date();
    return new Task({
      id: crypto.randomUUID(),
      projectId,
      title,
      description,
      status: status || STATUSES.PENDING,
      callbackUrl,
      callbackMeta,
      revisionCount: 0,
      seqNumber: seqNumber ?? null,
      branchName: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static generateBranchName(shortId, title) {
    const slug = title
      .toLowerCase()
      .replace(/[^a-zа-яё0-9\s-]/gi, '')
      .trim()
      .replace(/[\s]+/g, '-')
      .substring(0, 50)
      .replace(/-$/, '');
    return `${shortId}/${slug}`;
  }

  canTransitionTo(newStatus) {
    const allowed = TRANSITIONS[this.status];
    return allowed ? allowed.includes(newStatus) : false;
  }

  transitionTo(newStatus) {
    if (!this.canTransitionTo(newStatus)) {
      throw new InvalidTransitionError(this.status, newStatus, 'Task');
    }
    this.status = newStatus;
    this.updatedAt = new Date();
  }

  incrementRevision() {
    this.revisionCount += 1;
  }

  static fromRow(row) {
    return new Task({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status,
      callbackUrl: row.callback_url,
      callbackMeta: row.callback_meta,
      revisionCount: row.revision_count,
      seqNumber: row.seq_number ?? null,
      projectPrefix: row.project_prefix ?? null,
      branchName: row.branch_name ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  toRow() {
    return {
      id: this.id,
      project_id: this.projectId,
      title: this.title,
      description: this.description,
      status: this.status,
      callback_url: this.callbackUrl,
      callback_meta: this.callbackMeta,
      revision_count: this.revisionCount,
      seq_number: this.seqNumber,
      branch_name: this.branchName,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }
}
