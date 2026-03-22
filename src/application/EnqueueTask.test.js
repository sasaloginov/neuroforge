import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnqueueTask } from './EnqueueTask.js';
import { ValidationError } from '../domain/errors/ValidationError.js';

describe('EnqueueTask', () => {
  let enqueueTask;
  let taskService;
  let projectRepo;
  let callbackSender;

  beforeEach(() => {
    taskService = {
      enqueueTask: vi.fn().mockResolvedValue({
        id: 'task-1',
        status: 'pending',
        seqNumber: 3,
        projectId: 'proj-1',
        callbackUrl: 'https://cb.example.com',
        callbackMeta: { chatId: 1 },
        shortId: null,
      }),
    };
    projectRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'proj-1', prefix: 'NF' }),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({}),
    };

    enqueueTask = new EnqueueTask({ taskService, projectRepo, callbackSender });
  });

  it('moves task from backlog to pending and sends callback', async () => {
    const result = await enqueueTask.execute({ taskId: 'task-1' });

    expect(result.status).toBe('pending');
    expect(result.shortId).toBe('NF-3');
    expect(taskService.enqueueTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://cb.example.com',
      expect.objectContaining({ type: 'progress', stage: 'queued' }),
      { chatId: 1 },
    );
  });

  it('throws ValidationError when taskId is missing', async () => {
    await expect(enqueueTask.execute({})).rejects.toThrow(ValidationError);
    expect(taskService.enqueueTask).not.toHaveBeenCalled();
  });

  it('does not send callback when task has no callbackUrl', async () => {
    taskService.enqueueTask.mockResolvedValue({
      id: 'task-1',
      status: 'pending',
      seqNumber: 1,
      projectId: 'proj-1',
      callbackUrl: null,
      callbackMeta: null,
      shortId: null,
    });

    await enqueueTask.execute({ taskId: 'task-1' });
    expect(callbackSender.send).not.toHaveBeenCalled();
  });
});
