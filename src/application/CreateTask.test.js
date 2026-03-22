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
  let callbackSender;

  beforeEach(() => {
    taskService = {
      createTask: vi.fn().mockImplementation(({ title, description }) =>
        Promise.resolve({ id: 'task-1', title, description, status: 'pending', seqNumber: 1 }),
      ),
      advanceTask: vi.fn().mockResolvedValue({ id: 'task-1', status: 'in_progress' }),
      hasActiveTask: vi.fn().mockResolvedValue(false),
      setBranchName: vi.fn().mockResolvedValue({}),
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
    callbackSender = {
      send: vi.fn().mockResolvedValue({ ok: true }),
    };

    createTask = new CreateTask({ taskService, runService, roleRegistry, projectRepo, callbackSender });
  });

  it('creates task, enqueues analyst run, sends callback (no active task)', async () => {
    taskService.hasActiveTask.mockResolvedValue(false);

    const result = await createTask.execute({
      projectId: 'proj-1',
      title: 'Build feature X',
      description: 'Details about feature X',
      callbackUrl: 'https://example.com/callback',
      callbackMeta: { chatId: 123 },
    });

    expect(result).toEqual({ taskId: 'task-1', shortId: 'TP-1', status: 'in_progress' });

    expect(projectRepo.findById).toHaveBeenCalledWith('proj-1');
    expect(roleRegistry.get).toHaveBeenCalledWith('analyst');
    expect(taskService.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-1',
        title: 'Build feature X',
        description: 'Details about feature X',
        status: 'pending',
      }),
    );
    expect(runService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-1',
      roleName: 'analyst',
      prompt: expect.stringContaining('Build feature X'),
    }));
    expect(taskService.advanceTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalled();
  });

  it('queues task as pending when project already has an active task', async () => {
    taskService.hasActiveTask.mockResolvedValue(true);

    const result = await createTask.execute({
      projectId: 'proj-1',
      title: 'Second task',
      callbackUrl: 'https://example.com/callback',
      callbackMeta: { chatId: 123 },
    });

    expect(result.status).toBe('pending');
    expect(runService.enqueue).not.toHaveBeenCalled();
    expect(taskService.advanceTask).not.toHaveBeenCalled();
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/callback',
      expect.objectContaining({ stage: 'queued', message: expect.stringContaining('очередь') }),
      { chatId: 123 },
    );
  });

  it('creates backlog task — never enqueues, stays in backlog status', async () => {
    taskService.createTask.mockResolvedValue({ id: 'task-1', status: 'backlog', seqNumber: 1 });

    const result = await createTask.execute({
      projectId: 'proj-1',
      title: 'Future task',
      status: 'backlog',
    });

    expect(result.status).toBe('backlog');
    expect(runService.enqueue).not.toHaveBeenCalled();
    expect(taskService.advanceTask).not.toHaveBeenCalled();
    expect(taskService.hasActiveTask).not.toHaveBeenCalled();
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

    expect(result).toEqual({ taskId: 'task-1', shortId: 'TP-1', status: 'in_progress' });
    expect(callbackSender.send).not.toHaveBeenCalled();
  });

  it('works without description — description is null', async () => {
    const result = await createTask.execute({
      projectId: 'proj-1',
      title: 'Build feature X',
    });

    expect(result).toEqual({ taskId: 'task-1', shortId: 'TP-1', status: 'in_progress' });
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
