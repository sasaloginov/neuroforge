import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnqueueTask } from './EnqueueTask.js';

describe('EnqueueTask', () => {
  let enqueueTask;
  let taskService;
  let startNextPendingTask;
  let projectRepo;

  beforeEach(() => {
    taskService = {
      enqueueFromBacklog: vi.fn().mockResolvedValue({
        id: 'task-1',
        projectId: 'proj-1',
        seqNumber: 5,
        status: 'pending',
      }),
      updateMode: vi.fn().mockResolvedValue({}),
    };
    startNextPendingTask = {
      execute: vi.fn().mockResolvedValue({ started: true, taskId: 'task-1' }),
    };
    projectRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'proj-1', prefix: 'NF' }),
    };

    enqueueTask = new EnqueueTask({ taskService, startNextPendingTask, projectRepo });
  });

  it('transitions backlog→pending and tries to start', async () => {
    const result = await enqueueTask.execute({ taskId: 'task-1' });

    expect(taskService.enqueueFromBacklog).toHaveBeenCalledWith('task-1');
    expect(startNextPendingTask.execute).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(result).toEqual({ taskId: 'task-1', shortId: 'NF-5', status: 'in_progress' });
  });

  it('returns pending status when start does not happen', async () => {
    startNextPendingTask.execute.mockResolvedValue({ started: false, reason: 'active_task_exists' });

    const result = await enqueueTask.execute({ taskId: 'task-1' });

    expect(result.status).toBe('pending');
  });

  it('works without project prefix', async () => {
    projectRepo.findById.mockResolvedValue({ id: 'proj-1', prefix: null });

    const result = await enqueueTask.execute({ taskId: 'task-1' });

    expect(result.shortId).toBeUndefined();
  });

  it('updates mode when mode is provided', async () => {
    const result = await enqueueTask.execute({ taskId: 'task-1', mode: 'research' });

    expect(taskService.updateMode).toHaveBeenCalledWith('task-1', 'research');
    expect(result.status).toBe('in_progress');
  });

  it('does not update mode when mode is not provided', async () => {
    await enqueueTask.execute({ taskId: 'task-1' });

    expect(taskService.updateMode).not.toHaveBeenCalled();
  });
});
