import { DomainError } from './DomainError.js';
import { TaskNotFoundError } from './TaskNotFoundError.js';
import { InvalidTransitionError } from './InvalidTransitionError.js';
import { RoleNotFoundError } from './RoleNotFoundError.js';
import { RunTimeoutError } from './RunTimeoutError.js';
import { RevisionLimitError } from './RevisionLimitError.js';
import { RunNotFoundError } from './RunNotFoundError.js';

describe('Domain Errors', () => {
  it('DomainError has name and code', () => {
    const err = new DomainError('oops', 'OOPS');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DomainError');
    expect(err.code).toBe('OOPS');
    expect(err.message).toBe('oops');
  });

  it('TaskNotFoundError', () => {
    const err = new TaskNotFoundError('t-1');
    expect(err).toBeInstanceOf(DomainError);
    expect(err.name).toBe('TaskNotFoundError');
    expect(err.taskId).toBe('t-1');
    expect(err.code).toBe('TASK_NOT_FOUND');
  });

  it('InvalidTransitionError', () => {
    const err = new InvalidTransitionError('pending', 'done', 'Task');
    expect(err).toBeInstanceOf(DomainError);
    expect(err.from).toBe('pending');
    expect(err.to).toBe('done');
    expect(err.entityType).toBe('Task');
  });

  it('RoleNotFoundError', () => {
    const err = new RoleNotFoundError('wizard');
    expect(err).toBeInstanceOf(DomainError);
    expect(err.roleName).toBe('wizard');
  });

  it('RunTimeoutError', () => {
    const err = new RunTimeoutError('r-1', 60000);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.runId).toBe('r-1');
    expect(err.timeoutMs).toBe(60000);
  });

  it('RevisionLimitError', () => {
    const err = new RevisionLimitError('t-1', 5);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.taskId).toBe('t-1');
    expect(err.limit).toBe(5);
  });

  it('RunNotFoundError', () => {
    const err = new RunNotFoundError('r-99');
    expect(err).toBeInstanceOf(DomainError);
    expect(err.runId).toBe('r-99');
    expect(err.code).toBe('RUN_NOT_FOUND');
  });
});
