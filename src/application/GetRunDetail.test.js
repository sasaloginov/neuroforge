import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetRunDetail } from './GetRunDetail.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';
import { RunNotFoundError } from '../domain/errors/RunNotFoundError.js';

describe('GetRunDetail', () => {
  let getRunDetail;
  let taskService;
  let runRepo;

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    projectId: 'proj-1',
    title: 'Build feature X',
    status: 'in_progress',
    ...overrides,
  });

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    taskId: 'task-1',
    roleName: 'analyst',
    status: 'done',
    prompt: 'Secret prompt',
    response: 'Analyst response',
    error: null,
    startedAt: new Date('2026-01-01T10:00:00'),
    finishedAt: new Date('2026-01-01T10:05:00'),
    durationMs: 300000,
    createdAt: new Date('2026-01-01T09:59:00'),
    ...overrides,
  });

  beforeEach(() => {
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
    };
    runRepo = {
      findById: vi.fn().mockResolvedValue(makeRun()),
    };

    getRunDetail = new GetRunDetail({ taskService, runRepo });
  });

  it('returns run with response', async () => {
    const result = await getRunDetail.execute({ taskId: 'task-1', runId: 'run-1' });

    expect(result.task).toEqual({ id: 'task-1', projectId: 'proj-1' });
    expect(result.run).toEqual({
      id: 'run-1',
      taskId: 'task-1',
      roleName: 'analyst',
      status: 'done',
      response: 'Analyst response',
      error: null,
      startedAt: expect.any(Date),
      finishedAt: expect.any(Date),
      durationMs: 300000,
      createdAt: expect.any(Date),
    });
  });

  it('throws TaskNotFoundError when task missing', async () => {
    taskService.getTask.mockRejectedValue(new TaskNotFoundError('task-1'));

    await expect(getRunDetail.execute({ taskId: 'task-1', runId: 'run-1' }))
      .rejects.toThrow(TaskNotFoundError);
  });

  it('throws RunNotFoundError when run missing', async () => {
    runRepo.findById.mockResolvedValue(null);

    await expect(getRunDetail.execute({ taskId: 'task-1', runId: 'run-1' }))
      .rejects.toThrow(RunNotFoundError);
  });

  it('throws RunNotFoundError when run belongs to different task', async () => {
    runRepo.findById.mockResolvedValue(makeRun({ taskId: 'other-task' }));

    await expect(getRunDetail.execute({ taskId: 'task-1', runId: 'run-1' }))
      .rejects.toThrow(RunNotFoundError);
  });

  it('does not expose prompt', async () => {
    const result = await getRunDetail.execute({ taskId: 'task-1', runId: 'run-1' });

    expect(result.run).not.toHaveProperty('prompt');
  });
});
