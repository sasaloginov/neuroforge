import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreateTask } from './CreateTask.js';
import { ProjectNotFoundError } from '../domain/errors/ProjectNotFoundError.js';
import { ValidationError } from '../domain/errors/ValidationError.js';
import { RoleNotFoundError } from '../domain/errors/RoleNotFoundError.js';

describe('CreateTask', () => {
  let createTask;
  let taskService;
  let runService;
  let roleRegistry;
  let projectRepo;
  let taskRepo;
  let callbackSender;

  beforeEach(() => {
    taskService = {
      createTask: vi.fn().mockResolvedValue({ id: 'task-1', status: 'pending', seqNumber: 1, shortId: 'TP-1' }),
      advanceTask: vi.fn().mockResolvedValue({ id: 'task-1', status: 'in_progress' }),
      updateBranchName: vi.fn().mockResolvedValue(undefined),
    };
    runService = {
      enqueue: vi.fn().mockResolvedValue({ id: 'run-1', status: 'queued' }),
    };
    roleRegistry = {
      get: vi.fn().mockReturnValue({ name: 'analyst', timeoutMs: 300000 }),
    };
    projectRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'test-project', prefix: 'TP' }),
    };
    taskRepo = {
      activateIfNoActive: vi.fn().mockResolvedValue(true),
    };
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };

    createTask = new CreateTask({ taskService, runService, roleRegistry, projectRepo, taskRepo, callbackSender });
  });

  it('creates task, generates branchName, enqueues analyst, sends callback', async () => {
    const result = await createTask.execute({
      projectId: 'proj-1',
      title: 'Build feature X',
      description: 'Details about feature X',
      callbackUrl: 'https://example.com/callback',
      callbackMeta: { chatId: 123 },
    });

    expect(result.taskId).toBe('task-1');
    expect(result.shortId).toBe('TP-1');
    expect(result.branchName).toEqual(expect.stringContaining('TP-1/'));
    expect(result.status).toBe('in_progress');

    expect(taskService.updateBranchName).toHaveBeenCalledWith('task-1', expect.stringContaining('TP-1/'));
    expect(taskRepo.activateIfNoActive).toHaveBeenCalledWith('task-1', 'proj-1');
    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      roleName: 'analyst',
    }));
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/callback',
      expect.objectContaining({ type: 'progress', taskId: 'task-1', stage: 'queued' }),
      { chatId: 123 },
    );
  });

  it('queues task when activateIfNoActive returns false (active task exists)', async () => {
    taskRepo.activateIfNoActive.mockResolvedValue(false);

    const result = await createTask.execute({
      projectId: 'proj-1',
      title: 'Build feature X',
      callbackUrl: 'https://example.com/cb',
      callbackMeta: { chatId: 1 },
    });

    expect(result.status).toBe('pending');
    expect(runService.enqueue).not.toHaveBeenCalled();
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'queued', stage: 'pending' }),
      { chatId: 1 },
    );
  });

  it('creates backlog task without enqueuing', async () => {
    taskService.createTask.mockResolvedValue({ id: 'task-2', status: 'backlog', seqNumber: 2 });

    const result = await createTask.execute({
      projectId: 'proj-1',
      title: 'Future feature',
      status: 'backlog',
      callbackUrl: 'https://example.com/cb',
      callbackMeta: { chatId: 1 },
    });

    expect(result.status).toBe('backlog');
    expect(runService.enqueue).not.toHaveBeenCalled();
    expect(taskRepo.activateIfNoActive).not.toHaveBeenCalled();
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/cb',
      expect.objectContaining({ type: 'progress', stage: 'backlog' }),
      { chatId: 1 },
    );
  });

  it('throws ProjectNotFoundError when project does not exist', async () => {
    projectRepo.findById.mockResolvedValue(null);

    await expect(createTask.execute({
      projectId: 'nonexistent',
      title: 'Test',
    })).rejects.toThrow(ProjectNotFoundError);

    expect(taskService.createTask).not.toHaveBeenCalled();
  });

  it('throws ValidationError when title is empty', async () => {
    await expect(createTask.execute({
      projectId: 'proj-1',
      title: '',
    })).rejects.toThrow(ValidationError);

    expect(projectRepo.findById).not.toHaveBeenCalled();
  });

  it('throws ValidationError when projectId is missing', async () => {
    await expect(createTask.execute({
      title: 'Test',
    })).rejects.toThrow(ValidationError);
  });

  it('works without callbackUrl — no callback sent', async () => {
    const result = await createTask.execute({
      projectId: 'proj-1',
      title: 'Build feature X',
    });

    expect(result.taskId).toBe('task-1');
    expect(result.status).toBe('in_progress');
    expect(callbackSender.send).not.toHaveBeenCalled();
  });

  it('works without description — description is null', async () => {
    const result = await createTask.execute({
      projectId: 'proj-1',
      title: 'Build feature X',
    });

    expect(result.taskId).toBe('task-1');
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ description: null }),
    );
  });

  it('throws RoleNotFoundError when analyst role is not registered', async () => {
    roleRegistry.get.mockImplementation(() => { throw new RoleNotFoundError('analyst'); });

    await expect(createTask.execute({
      projectId: 'proj-1',
      title: 'Test',
    })).rejects.toThrow(RoleNotFoundError);

    expect(taskService.createTask).not.toHaveBeenCalled();
  });
});
