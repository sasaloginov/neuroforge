import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StartNextPendingTask } from './StartNextPendingTask.js';

describe('StartNextPendingTask', () => {
  let startNext;
  let taskRepo;
  let taskService;
  let runService;
  let roleRegistry;

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    title: 'Build feature X',
    description: 'REST API',
    status: 'pending',
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    ...overrides,
  });

  beforeEach(() => {
    taskRepo = {
      hasActiveTask: vi.fn().mockResolvedValue(false),
      findOldestPending: vi.fn().mockResolvedValue(makeTask()),
    };
    taskService = {
      advanceTask: vi.fn().mockResolvedValue(undefined),
    };
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-1', status: 'queued' }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'analyst', timeoutMs: 1800000 }),
    };

    startNext = new StartNextPendingTask({ taskRepo, taskService, runService, roleRegistry });
  });

  it('starts oldest pending task when no active tasks', async () => {
    const result = await startNext.execute({ projectId: 'proj-1' });

    expect(result).toEqual({ started: true, taskId: 'task-1' });
    expect(taskRepo.hasActiveTask).toHaveBeenCalledWith('proj-1');
    expect(taskRepo.findOldestPending).toHaveBeenCalledWith('proj-1');
    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      roleName: 'analyst',
    }));
    expect(taskService.advanceTask).toHaveBeenCalledWith('task-1');
  });

  it('no-op when active task exists', async () => {
    taskRepo.hasActiveTask.mockResolvedValue(true);

    const result = await startNext.execute({ projectId: 'proj-1' });

    expect(result).toEqual({ started: false, reason: 'active_task_exists' });
    expect(taskRepo.findOldestPending).not.toHaveBeenCalled();
    expect(runService.enqueue).not.toHaveBeenCalled();
  });

  it('no-op when no pending tasks', async () => {
    taskRepo.findOldestPending.mockResolvedValue(null);

    const result = await startNext.execute({ projectId: 'proj-1' });

    expect(result).toEqual({ started: false, reason: 'no_pending_tasks' });
    expect(runService.enqueue).not.toHaveBeenCalled();
  });

  it('includes task description in analyst prompt', async () => {
    const result = await startNext.execute({ projectId: 'proj-1' });

    const prompt = runService.enqueue.mock.calls[0][0].prompt;
    expect(prompt).toContain('Build feature X');
    expect(prompt).toContain('REST API');
  });
});
