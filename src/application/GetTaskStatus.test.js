import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetTaskStatus } from './GetTaskStatus.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';

describe('GetTaskStatus', () => {
  let getTaskStatus;
  let taskService;
  let runRepo;

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    projectId: 'proj-1',
    title: 'Build feature X',
    status: 'in_progress',
    revisionCount: 0,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    ...overrides,
  });

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    roleName: 'analyst',
    status: 'done',
    prompt: 'Secret prompt',
    response: 'Secret response',
    startedAt: new Date('2026-01-01T10:00:00'),
    finishedAt: new Date('2026-01-01T10:05:00'),
    durationMs: 300000,
    ...overrides,
  });

  beforeEach(() => {
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
    };
    runRepo = {
      findByTaskId: vi.fn().mockResolvedValue([makeRun()]),
    };

    getTaskStatus = new GetTaskStatus({ taskService, runRepo });
  });

  it('returns task and runs', async () => {
    const result = await getTaskStatus.execute({ taskId: 'task-1' });

    expect(result.task).toEqual({
      id: 'task-1',
      projectId: 'proj-1',
      title: 'Build feature X',
      status: 'in_progress',
      revisionCount: 0,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toEqual({
      id: 'run-1',
      roleName: 'analyst',
      status: 'done',
      response: 'Secret response',
      startedAt: expect.any(Date),
      finishedAt: expect.any(Date),
      durationMs: 300000,
    });
  });

  it('throws TaskNotFoundError when task does not exist', async () => {
    taskService.getTask.mockRejectedValue(new TaskNotFoundError('task-1'));

    await expect(getTaskStatus.execute({ taskId: 'task-1' })).rejects.toThrow(TaskNotFoundError);
  });

  it('returns empty runs array when task has no runs', async () => {
    runRepo.findByTaskId.mockResolvedValue([]);

    const result = await getTaskStatus.execute({ taskId: 'task-1' });

    expect(result.runs).toEqual([]);
  });

  it('returns runs in order', async () => {
    runRepo.findByTaskId.mockResolvedValue([
      makeRun({ id: 'run-1', roleName: 'analyst' }),
      makeRun({ id: 'run-2', roleName: 'developer' }),
    ]);

    const result = await getTaskStatus.execute({ taskId: 'task-1' });

    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].roleName).toBe('analyst');
    expect(result.runs[1].roleName).toBe('developer');
  });

  it('does not expose prompt field in runs', async () => {
    const result = await getTaskStatus.execute({ taskId: 'task-1' });

    expect(result.runs[0]).not.toHaveProperty('prompt');
    expect(result.runs[0]).toHaveProperty('response');
  });
});
