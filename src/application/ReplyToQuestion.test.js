import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplyToQuestion } from './ReplyToQuestion.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';
import { InvalidStateError } from '../domain/errors/InvalidStateError.js';

describe('ReplyToQuestion', () => {
  let replyToQuestion;
  let taskService;
  let runService;
  let runRepo;
  let callbackSender;

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    title: 'Build feature X',
    status: 'waiting_reply',
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    ...overrides,
  });

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    taskId: 'task-1',
    roleName: 'analyst',
    stepId: 'step-1',
    status: 'done',
    prompt: 'Original prompt',
    response: 'Some analysis',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  });

  beforeEach(() => {
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
      resumeAfterReply: vi.fn().mockResolvedValue(makeTask({ status: 'in_progress' })),
    };
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-2', status: 'queued' }),
    };
    runRepo = {
      findByTaskId: vi.fn().mockResolvedValue([makeRun()]),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };

    replyToQuestion = new ReplyToQuestion({ taskService, runService, runRepo, callbackSender });
  });

  it('resumes task, creates new run with answer context, sends callback', async () => {
    const result = await replyToQuestion.execute({
      taskId: 'task-1',
      questionId: 'q-1',
      answer: 'Use PostgreSQL',
    });

    expect(result).toEqual({ taskId: 'task-1', status: 'in_progress' });
    expect(taskService.resumeAfterReply).toHaveBeenCalledWith('task-1');
    expect(runService.enqueue).toHaveBeenCalledWith({
      taskId: 'task-1',
      stepId: 'step-1',
      roleName: 'analyst',
      prompt: expect.stringContaining('Use PostgreSQL'),
      callbackUrl: 'https://example.com/cb',
      callbackMeta: { chatId: 1 },
    });
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'progress', stage: 'reply_received' }),
      { chatId: 1 },
    );
  });

  it('throws TaskNotFoundError when task does not exist', async () => {
    taskService.getTask.mockRejectedValue(new TaskNotFoundError('task-1'));

    await expect(replyToQuestion.execute({
      taskId: 'task-1',
      answer: 'Yes',
    })).rejects.toThrow(TaskNotFoundError);
  });

  it('throws InvalidStateError when task is not in waiting_reply', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'in_progress' }));

    await expect(replyToQuestion.execute({
      taskId: 'task-1',
      answer: 'Yes',
    })).rejects.toThrow(InvalidStateError);
  });

  it('throws InvalidStateError when no completed runs found', async () => {
    runRepo.findByTaskId.mockResolvedValue([
      makeRun({ status: 'failed' }),
    ]);

    await expect(replyToQuestion.execute({
      taskId: 'task-1',
      answer: 'Yes',
    })).rejects.toThrow(InvalidStateError);
  });

  it('prompt contains the answer text', async () => {
    await replyToQuestion.execute({
      taskId: 'task-1',
      answer: 'The answer is 42',
    });

    const enqueuedPrompt = runService.enqueue.mock.calls[0][0].prompt;
    expect(enqueuedPrompt).toContain('The answer is 42');
  });

  it('uses the same roleName as the last completed run', async () => {
    runRepo.findByTaskId.mockResolvedValue([
      makeRun({ id: 'run-1', roleName: 'developer', createdAt: new Date('2026-01-01') }),
      makeRun({ id: 'run-2', roleName: 'analyst', createdAt: new Date('2026-01-02') }),
    ]);

    await replyToQuestion.execute({
      taskId: 'task-1',
      answer: 'Answer',
    });

    expect(runService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ roleName: 'analyst' }),
    );
  });

  it('does not send callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));

    await replyToQuestion.execute({
      taskId: 'task-1',
      answer: 'Yes',
    });

    expect(callbackSender.send).not.toHaveBeenCalled();
  });
});
