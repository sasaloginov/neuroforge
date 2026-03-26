import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResumeTask } from './ResumeTask.js';
import { TaskNotFoundError } from '../domain/errors/TaskNotFoundError.js';
import { InvalidStateError } from '../domain/errors/InvalidStateError.js';

describe('ResumeTask', () => {
  let resumeTask;
  let taskService;
  let runService;
  let runRepo;
  let taskRepo;
  let projectRepo;
  let managerDecision;
  let callbackSender;

  const makeTask = (overrides = {}) => ({
    id: 'task-1',
    projectId: 'proj-1',
    seqNumber: 3,
    title: 'Build feature X',
    description: 'Details',
    status: 'failed',
    callbackUrl: 'https://example.com/cb',
    callbackMeta: { chatId: 1 },
    ...overrides,
  });

  const makeRun = (overrides = {}) => ({
    id: 'run-1',
    taskId: 'task-1',
    roleName: 'developer',
    status: 'done',
    response: 'Completed',
    createdAt: new Date('2026-01-01T10:00:00'),
    ...overrides,
  });

  beforeEach(() => {
    taskService = {
      getTask: vi.fn().mockResolvedValue(makeTask()),
    };
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-new', status: 'queued' }),
    };
    runRepo = {
      findByTaskId: vi.fn().mockResolvedValue([makeRun()]),
    };
    taskRepo = {
      activateIfNoActive: vi.fn().mockResolvedValue(true),
    };
    projectRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'proj-1', prefix: 'NF' }),
    };
    managerDecision = {
      execute: vi.fn().mockResolvedValue({ action: 'spawn_run', role: 'developer', prompt: 'Fix the code' }),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };

    resumeTask = new ResumeTask({
      taskService, runService, runRepo, taskRepo, projectRepo,
      managerDecision, callbackSender, logger: { info: vi.fn() },
    });
  });

  it('resumes a failed task with terminal runs — delegates to managerDecision', async () => {
    const result = await resumeTask.execute({ taskId: 'task-1' });

    expect(taskRepo.activateIfNoActive).toHaveBeenCalledWith('task-1', 'proj-1', 'failed');
    expect(managerDecision.execute).toHaveBeenCalledWith({ completedRunId: 'run-1' });
    expect(result).toEqual({
      taskId: 'task-1',
      shortId: 'NF-3',
      status: 'in_progress',
      decision: { action: 'spawn_run', role: 'developer', prompt: 'Fix the code' },
    });
  });

  it('resumes a needs_escalation task', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'needs_escalation' }));

    const result = await resumeTask.execute({ taskId: 'task-1' });

    expect(taskRepo.activateIfNoActive).toHaveBeenCalledWith('task-1', 'proj-1', 'needs_escalation');
    expect(result.status).toBe('in_progress');
  });

  it('resumes a cancelled task', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'cancelled' }));

    const result = await resumeTask.execute({ taskId: 'task-1' });

    expect(taskRepo.activateIfNoActive).toHaveBeenCalledWith('task-1', 'proj-1', 'cancelled');
    expect(result.status).toBe('in_progress');
  });

  it('enqueues analyst when no terminal runs exist', async () => {
    runRepo.findByTaskId.mockResolvedValue([]);

    const result = await resumeTask.execute({ taskId: 'task-1' });

    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      roleName: 'analyst',
      taskId: 'task-1',
    }));
    expect(managerDecision.execute).not.toHaveBeenCalled();
    expect(result.decision).toEqual({ action: 'spawn_run', role: 'analyst' });
  });

  it('includes instruction in analyst prompt when no terminal runs', async () => {
    runRepo.findByTaskId.mockResolvedValue([]);

    await resumeTask.execute({ taskId: 'task-1', instruction: 'Focus on performance' });

    const prompt = runService.enqueue.mock.calls[0][0].prompt;
    expect(prompt).toContain('Focus on performance');
  });

  it('filters out non-terminal runs when finding last run', async () => {
    runRepo.findByTaskId.mockResolvedValue([
      makeRun({ id: 'run-queued', status: 'queued', createdAt: new Date('2026-01-01T11:00:00') }),
      makeRun({ id: 'run-running', status: 'running', createdAt: new Date('2026-01-01T12:00:00') }),
    ]);

    const result = await resumeTask.execute({ taskId: 'task-1' });

    // No terminal runs — should enqueue analyst
    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ roleName: 'analyst' }));
    expect(result.decision.role).toBe('analyst');
  });

  it('throws InvalidStateError when task is in_progress', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'in_progress' }));

    await expect(resumeTask.execute({ taskId: 'task-1' })).rejects.toThrow(InvalidStateError);
    expect(taskRepo.activateIfNoActive).not.toHaveBeenCalled();
  });

  it('throws InvalidStateError when task is done', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'done' }));

    await expect(resumeTask.execute({ taskId: 'task-1' })).rejects.toThrow(InvalidStateError);
  });

  it('throws InvalidStateError when task is research_done', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ status: 'research_done' }));

    await expect(resumeTask.execute({ taskId: 'task-1' })).rejects.toThrow(InvalidStateError);
  });

  it('throws InvalidStateError when another task is active (activateIfNoActive returns false)', async () => {
    taskRepo.activateIfNoActive.mockResolvedValue(false);

    await expect(resumeTask.execute({ taskId: 'task-1' })).rejects.toThrow(InvalidStateError);
    await expect(resumeTask.execute({ taskId: 'task-1' })).rejects.toThrow('another task is active');
  });

  it('throws TaskNotFoundError when task does not exist', async () => {
    taskService.getTask.mockRejectedValue(new TaskNotFoundError('task-1'));

    await expect(resumeTask.execute({ taskId: 'task-1' })).rejects.toThrow(TaskNotFoundError);
  });

  it('sends callback with stage resumed', async () => {
    await resumeTask.execute({ taskId: 'task-1' });

    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'progress', taskId: 'task-1', shortId: 'NF-3', stage: 'resumed' }),
      { chatId: 1 },
    );
  });

  it('does not send callback when callbackUrl is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ callbackUrl: null }));

    await resumeTask.execute({ taskId: 'task-1' });

    expect(callbackSender.send).not.toHaveBeenCalled();
  });

  it('returns undefined shortId when seqNumber is null', async () => {
    taskService.getTask.mockResolvedValue(makeTask({ seqNumber: null }));

    const result = await resumeTask.execute({ taskId: 'task-1' });

    expect(result.shortId).toBeUndefined();
  });
});
