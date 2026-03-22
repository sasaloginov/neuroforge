import { ValidationError } from '../domain/errors/ValidationError.js';
import { Task } from '../domain/entities/Task.js';

export class EnqueueTask {
  #taskService;
  #projectRepo;
  #callbackSender;

  constructor({ taskService, projectRepo, callbackSender }) {
    this.#taskService = taskService;
    this.#projectRepo = projectRepo;
    this.#callbackSender = callbackSender;
  }

  async execute({ taskId }) {
    if (!taskId) throw new ValidationError('taskId is required');

    const task = await this.#taskService.enqueueTask(taskId);

    const project = await this.#projectRepo.findById(task.projectId);
    const shortId = project?.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'progress', taskId: task.id, shortId, stage: 'queued', message: 'Задача перенесена из бэклога в очередь' },
        task.callbackMeta,
      );
    }

    return { taskId: task.id, shortId, status: task.status };
  }
}
