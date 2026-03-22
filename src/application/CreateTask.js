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

  async execute({ projectId, title, description, callbackUrl, callbackMeta }) {
    if (!projectId) throw new ValidationError('projectId is required');
    if (!title || !title.trim()) throw new ValidationError('title is required');

    const project = await this.#projectRepo.findById(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);

    // Validate analyst role exists
    this.#roleRegistry.get('analyst');

    const task = await this.#taskService.createTask({
      projectId,
      title,
      description: description ?? null,
      callbackUrl,
      callbackMeta,
    });

    const prompt = `Задача: ${title}\n\n${description ?? ''}\n\nПроанализируй задачу и создай спецификацию.`;

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName: 'analyst',
      prompt,
      callbackUrl,
      callbackMeta,
    });

    await this.#taskService.advanceTask(task.id);

    const shortId = project.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    if (callbackUrl) {
      await this.#callbackSender.send(
        callbackUrl,
        { type: 'progress', taskId: task.id, shortId, stage: 'queued', message: 'Задача принята, начинаю анализ' },
        callbackMeta,
      );
    }

    return { taskId: task.id, shortId, status: 'in_progress' };
  }
}
