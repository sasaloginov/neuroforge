import { ProjectNotFoundError } from '../domain/errors/ProjectNotFoundError.js';
import { ValidationError } from '../domain/errors/ValidationError.js';
import { generateBranchName } from '../domain/valueObjects/BranchName.js';

export class CreateTask {
  #taskService;
  #runService;
  #roleRegistry;
  #projectRepo;
  #taskRepo;
  #callbackSender;

  constructor({ taskService, runService, roleRegistry, projectRepo, taskRepo, callbackSender }) {
    this.#taskService = taskService;
    this.#runService = runService;
    this.#roleRegistry = roleRegistry;
    this.#projectRepo = projectRepo;
    this.#taskRepo = taskRepo;
    this.#callbackSender = callbackSender;
  }

  async execute({ projectId, title, description, callbackUrl, callbackMeta, status }) {
    if (!projectId) throw new ValidationError('projectId is required');
    if (!title || !title.trim()) throw new ValidationError('title is required');

    const project = await this.#projectRepo.findById(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);

    // Validate analyst role exists (needed for non-backlog tasks)
    this.#roleRegistry.get('analyst');

    const task = await this.#taskService.createTask({
      projectId,
      title,
      description: description ?? null,
      callbackUrl,
      callbackMeta,
      status,
    });

    // Generate and save branch name
    const shortId = project.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    if (shortId) {
      const branchName = generateBranchName(shortId, title);
      await this.#taskService.updateBranchName(task.id, branchName);
      task.branchName = branchName;
    }

    // Backlog — just save, no enqueue
    if (task.status === 'backlog') {
      if (callbackUrl) {
        await this.#callbackSender.send(
          callbackUrl,
          { type: 'progress', taskId: task.id, shortId, branchName: task.branchName, stage: 'backlog', message: 'Задача добавлена в бэклог' },
          callbackMeta,
        );
      }
      return { taskId: task.id, shortId, branchName: task.branchName, status: 'backlog' };
    }

    // Check if project already has an active task
    const hasActive = await this.#taskRepo.hasActiveTask(projectId);
    if (hasActive) {
      // Leave as pending (queued)
      if (callbackUrl) {
        await this.#callbackSender.send(
          callbackUrl,
          { type: 'queued', taskId: task.id, shortId, branchName: task.branchName, stage: 'pending', message: 'Задача в очереди, ожидает завершения текущей' },
          callbackMeta,
        );
      }
      return { taskId: task.id, shortId, branchName: task.branchName, status: 'pending' };
    }

    // No active task — start immediately
    const prompt = `Задача: ${task.shortId ?? ''} ${title}\n\n${description ?? ''}\n\nПроанализируй задачу и создай спецификацию.`;

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName: 'analyst',
      prompt,
      callbackUrl,
      callbackMeta,
    });

    await this.#taskService.advanceTask(task.id);

    if (callbackUrl) {
      await this.#callbackSender.send(
        callbackUrl,
        { type: 'progress', taskId: task.id, shortId, branchName: task.branchName, stage: 'queued', message: 'Задача принята, начинаю анализ' },
        callbackMeta,
      );
    }

    return { taskId: task.id, shortId, branchName: task.branchName, status: 'in_progress' };
  }
}
