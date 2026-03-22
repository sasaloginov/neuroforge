import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StartPendingTask } from './StartPendingTask.js';

describe('StartPendingTask', () => {
  let startPendingTask;
  let taskService;
  let taskRepo;
  let runService;
  let roleRegistry;
  let callbackSender;

  const pendingTask = {
    id: 'task-1',
    title: 'Build feature',
    description: 'Some description',
    callbackUrl: 'https://cb.example.com',
    callbackMeta: { chatId: 1 },
    shortId: 'NF-3',
  };

  beforeEach(() => {
    taskService = {
      hasActiveTask: vi.fn().mockResolvedValue(false),
      findOldestPending: vi.fn().mockResolvedValue(pendingTask),
      advanceTask: vi.fn().mockResolvedValue({ ...pendingTask, status: 'in_progress' }),
    };
    taskRepo = {
      findProjectsWithPendingTasks: vi.fn().mockResolvedValue(['proj-1']),
    };
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-1' }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'analyst', timeoutMs: 300000 }),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({}),
    };

    startPendingTask = new StartPendingTask({ taskService, taskRepo, runService, roleRegistry, callbackSender });
  });

  describe('execute (single project)', () => {
    it('starts the oldest pending task', async () => {
      const result = await startPendingTask.execute('proj-1');

      expect(taskService.hasActiveTask).toHaveBeenCalledWith('proj-1');
      expect(taskService.findOldestPending).toHaveBeenCalledWith('proj-1');
      expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        taskId: 'task-1',
        roleName: 'analyst',
        prompt: expect.stringContaining('Build feature'),
      }));
      expect(taskService.advanceTask).toHaveBeenCalledWith('task-1');
      expect(result).toBe(pendingTask);
    });

    it('returns null when project already has active task', async () => {
      taskService.hasActiveTask.mockResolvedValue(true);

      const result = await startPendingTask.execute('proj-1');

      expect(result).toBeNull();
      expect(runService.enqueue).not.toHaveBeenCalled();
    });

    it('returns null when no pending tasks', async () => {
      taskService.findOldestPending.mockResolvedValue(null);

      const result = await startPendingTask.execute('proj-1');

      expect(result).toBeNull();
      expect(runService.enqueue).not.toHaveBeenCalled();
    });

    it('sends callback after starting', async () => {
      await startPendingTask.execute('proj-1');

      expect(callbackSender.send).toHaveBeenCalledWith(
        'https://cb.example.com',
        expect.objectContaining({ type: 'progress', stage: 'queued' }),
        { chatId: 1 },
      );
    });

    it('does not send callback when task has no callbackUrl', async () => {
      taskService.findOldestPending.mockResolvedValue({ ...pendingTask, callbackUrl: null });

      await startPendingTask.execute('proj-1');

      expect(callbackSender.send).not.toHaveBeenCalled();
    });
  });

  describe('checkAndStartAll', () => {
    it('starts pending tasks across all projects', async () => {
      taskRepo.findProjectsWithPendingTasks.mockResolvedValue(['proj-1', 'proj-2']);
      taskService.findOldestPending
        .mockResolvedValueOnce(pendingTask)
        .mockResolvedValueOnce({ ...pendingTask, id: 'task-2' });

      const count = await startPendingTask.checkAndStartAll();
      expect(count).toBe(2);
    });

    it('returns 0 when no projects have pending tasks', async () => {
      taskRepo.findProjectsWithPendingTasks.mockResolvedValue([]);
      const count = await startPendingTask.checkAndStartAll();
      expect(count).toBe(0);
    });

    it('skips projects where execute returns null', async () => {
      taskRepo.findProjectsWithPendingTasks.mockResolvedValue(['proj-1', 'proj-2']);
      taskService.hasActiveTask
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true); // proj-2 has active task

      const count = await startPendingTask.checkAndStartAll();
      expect(count).toBe(1);
    });
  });
});
