import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CancelTask } from './CancelTask.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';
import { InvalidTransitionError } from '../domain/errors/InvalidTransitionError.js';

describe('CancelTask', () => {
  let cancelTask;
  let taskService;
  let runRepo;
  let callbackSender;

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    status: 'in_progress',
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    ...overrides,
  });

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    taskId: 'task-1',
    status: 'queued',
    transitionTo: vi.fn(),
    ...overrides,
  });

  beforeEach(() => {
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
      cancelTask: vi.fn().mockResolvedValue(makeTask({ status: 'cancelled' })),
    };
    runRepo = {
      findByTaskId: vi.fn().mockResolvedValue([]),
      save: vi.fn().mockResolvedValue(undefined),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };

    cancelTask = new CancelTask({ taskService, runRepo, callbackSender });
  });

  it('cancels task with queued runs', async () => {
    const queuedRun1 = makeRun({ id: 'run-1' });
    const queuedRun2 = makeRun({ id: 'run-2' });
    runRepo.findByTaskId.mockResolvedValue([queuedRun1, queuedRun2]);

    const result = await cancelTask.execute({ taskId: 'task-1' });

    expect(result).toEqual({ taskId: 'task-1', status: 'cancelled', cancelledRuns: 2 });
    expect(queuedRun1.transitionTo).toHaveBeenCalledWith('cancelled');
    expect(queuedRun2.transitionTo).toHaveBeenCalledWith('cancelled');
    expect(runRepo.save).toHaveBeenCalledTimes(2);
    expect(taskService.cancelTask).toHaveBeenCalledWith('task-1');
  });

  it('cancels task without runs', async () => {
    runRepo.findByTaskId.mockResolvedValue([]);

    const result = await cancelTask.execute({ taskId: 'task-1' });

    expect(result).toEqual({ taskId: 'task-1', status: 'cancelled', cancelledRuns: 0 });
    expect(taskService.cancelTask).toHaveBeenCalledWith('task-1');
  });

  it('throws TaskNotFoundError when task does not exist', async () => {
    taskService.getTask.mockRejectedValue(new TaskNotFoundError('task-1'));

    await expect(cancelTask.execute({ taskId: 'task-1' })).rejects.toThrow(TaskNotFoundError);
  });

  it('throws InvalidTransitionError when task is already done', async () => {
    taskService.cancelTask.mockRejectedValue(new InvalidTransitionError('done', 'cancelled', 'Task'));

    await expect(cancelTask.execute({ taskId: 'task-1' })).rejects.toThrow(InvalidTransitionError);
  });

  it('throws InvalidTransitionError when task is already cancelled', async () => {
    taskService.cancelTask.mockRejectedValue(new InvalidTransitionError('cancelled', 'cancelled', 'Task'));

    await expect(cancelTask.execute({ taskId: 'task-1' })).rejects.toThrow(InvalidTransitionError);
  });

  it('does not cancel running runs — they stay running', async () => {
    const runningRun = makeRun({ id: 'run-3', status: 'running' });
    const queuedRun = makeRun({ id: 'run-4', status: 'queued' });
    runRepo.findByTaskId.mockResolvedValue([runningRun, queuedRun]);

    const result = await cancelTask.execute({ taskId: 'task-1' });

    expect(result.cancelledRuns).toBe(1);
    expect(runningRun.transitionTo).not.toHaveBeenCalled();
    expect(queuedRun.transitionTo).toHaveBeenCalledWith('cancelled');
  });

  it('sends callback on cancellation', async () => {
    await cancelTask.execute({ taskId: 'task-1' });

    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'failed', taskId: 'task-1', error: 'Task cancelled by user' }),
      { chatId: 1 },
    );
  });

  it('does not send callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));

    await cancelTask.execute({ taskId: 'task-1' });

    expect(callbackSender.send).not.toHaveBeenCalled();
  });
});
