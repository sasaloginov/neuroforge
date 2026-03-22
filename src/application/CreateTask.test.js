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
      createTask: vi.fn().mockResolvedValue({ id: 'task-1', status: 'pending', seqNumber: 1 }),
      advanceTask: vi.fn().mockResolvedValue({ id: 'task-1', status: 'in_progress' }),
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

  it('creates task, enqueues analyst run, sends callback', async () => {
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
    expect(taskService.createTask).toHaveBeenCalledWith({
      projectId: 'proj-1',
      title: 'Build feature X',
      description: 'Details about feature X',
      callbackUrl: 'https://example.com/callback',
      callbackMeta: { chatId: 123 },
    });
    expect(runService.enqueue).toHaveBeenCalledWith({
      taskId: 'task-1',
      stepId: null,
      roleName: 'analyst',
      prompt: expect.stringContaining('Build feature X'),
      callbackUrl: 'https://example.com/callback',
      callbackMeta: { chatId: 123 },
    });
    expect(taskService.advanceTask).toHaveBeenCalledWith('task-1');
    expect(callbackSender.send).toHaveBeenCalledWith(
      'https://example.com/callback',
      expect.objectContaining({ type: 'progress', taskId: 'task-1', shortId: 'TP-1', stage: 'queued' }),
      { chatId: 123 },
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
