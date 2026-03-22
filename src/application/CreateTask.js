import { Task } from '../domain/entities/Task.js';
import { ProjectNotFoundError } from '../domain/errors/ProjectNotFoundError.js';
import { ValidationError } from '../domain/errors/ValidationError.js';

export class CreateTask {
  #taskService;
  #runService;
  #roleRegistry;
  #projectRepo;
  #callbackSender;

  constructor({ taskService, runService, roleRegistry, projectRepo, callbackSender }) {
    this.#taskService = taskService;
    this.#runService = runService;
    this.#roleRegistry = roleRegistry;
    this.#projectRepo = projectRepo;
    this.#callbackSender = callbackSender;
  }

  async execute({ projectId, title, description, callbackUrl, callbackMeta, status }) {
    if (!projectId) throw new ValidationError('projectId is required');
    if (!title || !title.trim()) throw new ValidationError('title is required');

    const project = await this.#projectRepo.findById(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);

    // Validate analyst role exists
    this.#roleRegistry.get('analyst');

    // Determine initial status
    const isBacklog = status === 'backlog';
    let initialStatus;

    if (isBacklog) {
      initialStatus = Task.STATUSES.BACKLOG;
    } else {
      initialStatus = Task.STATUSES.PENDING;
    }

    const task = await this.#taskService.createTask({
      projectId,
      title,
      description: description ?? null,
      callbackUrl,
      callbackMeta,
      status: initialStatus,
    });

    const shortId = project.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    // Generate and save branch name
    if (shortId) {
      const branchName = Task.generateBranchName(shortId, title);
      await this.#taskService.setBranchName(task.id, branchName);
      task.branchName = branchName;
    }

    // Only start immediately if not backlog and no other active task
    if (!isBacklog) {
      const hasActive = await this.#taskService.hasActiveTask(projectId);
      if (!hasActive) {
        await this.#startTask(task, callbackUrl, callbackMeta, shortId);
        return { taskId: task.id, shortId, status: 'in_progress' };
      }
    }

    // Task stays in pending/backlog — scheduler will pick it up (if pending)
    const message = isBacklog
      ? 'Задача добавлена в бэклог'
      : 'Задача поставлена в очередь';

    if (callbackUrl) {
      await this.#callbackSender.send(
        callbackUrl,
        { type: 'progress', taskId: task.id, shortId, stage: 'queued', message },
        callbackMeta,
      );
    }

    return { taskId: task.id, shortId, status: task.status };
  }

  async #startTask(task, callbackUrl, callbackMeta, shortId) {
    const prompt = `Задача: ${task.title}\n\n${task.description ?? ''}\n\nПроанализируй задачу и создай спецификацию.`;

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
        { type: 'progress', taskId: task.id, shortId, stage: 'queued', message: 'Задача принята, начинаю анализ' },
        callbackMeta,
      );
    }
  }
}
