import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetTaskStatus } from './GetTaskStatus.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';
import { ProjectNotFoundError } from '../domain/errors/ProjectNotFoundError.js';

describe('GetTaskStatus', () => {
  let getTaskStatus;
  let taskService;
  let runRepo;
  let projectRepo;

  const TASK_UUID = '00000000-0000-0000-0000-000000000200';
  const PROJECT_UUID = '00000000-0000-0000-0000-000000000100';

  const makeTask = (overrides = {}) => ({
    id: TASK_UUID,
    projectId: PROJECT_UUID,
    title: 'Build feature X',
    status: 'in_progress',
    revisionCount: 0,
    seqNumber: 1,
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
      getTaskByShortId: vi.fn().mockResolvedValue(makeTask()),
    };
    runRepo = {
      findByTaskId: vi.fn().mockResolvedValue([makeRun()]),
    };
    projectRepo = {
      findById: vi.fn().mockResolvedValue({ id: PROJECT_UUID, prefix: 'NF' }),
      findByPrefix: vi.fn().mockResolvedValue({ id: PROJECT_UUID, prefix: 'NF' }),
    };

    getTaskStatus = new GetTaskStatus({ taskService, runRepo, projectRepo });
  });

  it('returns task and runs by UUID taskId', async () => {
    const result = await getTaskStatus.execute({ taskId: TASK_UUID });

    expect(result.task).toEqual({
      id: TASK_UUID,
      shortId: 'NF-1',
      projectId: PROJECT_UUID,
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
    expect(taskService.getTask).toHaveBeenCalledWith(TASK_UUID);
    expect(projectRepo.findById).toHaveBeenCalledWith(PROJECT_UUID);
  });

  it('resolves short ID (PREFIX-N) and returns task', async () => {
    const result = await getTaskStatus.execute({ taskId: 'NF-1' });

    expect(result.task.id).toBe(TASK_UUID);
    expect(result.task.shortId).toBe('NF-1');
    expect(projectRepo.findByPrefix).toHaveBeenCalledWith('NF');
    expect(taskService.getTaskByShortId).toHaveBeenCalledWith(PROJECT_UUID, 1);
    expect(taskService.getTask).not.toHaveBeenCalled();
  });

  it('throws ProjectNotFoundError for unknown prefix', async () => {
    projectRepo.findByPrefix.mockResolvedValue(null);

    await expect(getTaskStatus.execute({ taskId: 'UNKNOWN-1' })).rejects.toThrow(ProjectNotFoundError);
  });

  it('throws TaskNotFoundError when task does not exist', async () => {
    taskService.getTask.mockRejectedValue(new TaskNotFoundError(TASK_UUID));

    await expect(getTaskStatus.execute({ taskId: TASK_UUID })).rejects.toThrow(TaskNotFoundError);
  });

  it('returns empty runs array when task has no runs', async () => {
    runRepo.findByTaskId.mockResolvedValue([]);

    const result = await getTaskStatus.execute({ taskId: TASK_UUID });

    expect(result.runs).toEqual([]);
  });

  it('returns runs in order', async () => {
    runRepo.findByTaskId.mockResolvedValue([
      makeRun({ id: 'run-1', roleName: 'analyst' }),
      makeRun({ id: 'run-2', roleName: 'developer' }),
    ]);

    const result = await getTaskStatus.execute({ taskId: TASK_UUID });

    expect(result.runs).toHaveLength(2);
    expect(result.runs[0].roleName).toBe('analyst');
    expect(result.runs[1].roleName).toBe('developer');
  });

  it('does not expose prompt field in runs', async () => {
    const result = await getTaskStatus.execute({ taskId: TASK_UUID });

    expect(result.runs[0]).not.toHaveProperty('prompt');
    expect(result.runs[0]).toHaveProperty('response');
  });

  it('computes shortId from project prefix + seqNumber', async () => {
    const result = await getTaskStatus.execute({ taskId: TASK_UUID });
    expect(result.task.shortId).toBe('NF-1');
  });

  it('returns undefined shortId when seqNumber is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ seqNumber: null }));

    const result = await getTaskStatus.execute({ taskId: TASK_UUID });
    expect(result.task.shortId).toBeUndefined();
  });
});
