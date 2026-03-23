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
    status: 'in_progress', // already activated by atomic method
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    ...overrides,
  });

  beforeEach(() => {
    taskRepo = {
      activateOldestPending: vi.fn().mockResolvedValue(makeTask()),
    };
    taskService = {
      advanceTask: vi.fn().mockResolvedValue(undefined),
    };
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-1', status: 'queued' }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'implementer', timeoutMs: 1800000 }),
      has: vi.fn().mockImplementation((name) => name === 'implementer'),
    };

    startNext = new StartNextPendingTask({ taskRepo, runService, roleRegistry });
  });

  it('atomically activates oldest pending task and enqueues implementer', async () => {
    const result = await startNext.execute({ projectId: 'proj-1' });

    expect(result).toEqual({ started: true, taskId: 'task-1' });
    expect(taskRepo.activateOldestPending).toHaveBeenCalledWith('proj-1');
    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      roleName: 'implementer',
    }));
  });

  it('falls back to analyst when implementer not available', async () => {
    roleRegistry.has.mockReturnValue(false);
    roleRegistry.get.mockReturnValue({ name: 'analyst', timeoutMs: 1800000 });

    const result = await startNext.execute({ projectId: 'proj-1' });

    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      roleName: 'analyst',
    }));
  });

  it('no-op when activateOldestPending returns null (active exists or no pending)', async () => {
    taskRepo.activateOldestPending.mockResolvedValue(null);

    const result = await startNext.execute({ projectId: 'proj-1' });

    expect(result).toEqual({ started: false, reason: 'no_eligible_task' });
    expect(runService.enqueue).not.toHaveBeenCalled();
  });

  it('includes task description in prompt', async () => {
    await startNext.execute({ projectId: 'proj-1' });

    const prompt = runService.enqueue.mock.calls[0][0].prompt;
    expect(prompt).toContain('Build feature X');
    expect(prompt).toContain('REST API');
  });

  it('passes callback info from task to enqueued run', async () => {
    await startNext.execute({ projectId: 'proj-1' });

    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      callbackUrl: 'https://example.com/cb',
      callbackMeta: { chatId: 1 },
    }));
  });
});
