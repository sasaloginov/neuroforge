import { Task } from '../entities/Task.js';
import { RevisionLimitError } from '../errors/RevisionLimitError.js';
import { TaskNotFoundError } from '../errors/TaskNotFoundError.js';

const MAX_REVISIONS = 5;

export class TaskService {
  #taskRepo;

  constructor({ taskRepo }) {
    this.#taskRepo = taskRepo;
  }

  async createTask({ projectId, title, description, callbackUrl, callbackMeta }) {
    const task = Task.create({ projectId, title, description, callbackUrl, callbackMeta });
    await this.#taskRepo.save(task);
    return task;
  }

  async advanceTask(taskId) {
    const task = await this.#getTask(taskId);
    task.transitionTo(Task.STATUSES.IN_PROGRESS);
    await this.#taskRepo.save(task);
    return task;
  }

  async requestReply(taskId) {
    const task = await this.#getTask(taskId);
    task.transitionTo(Task.STATUSES.WAITING_REPLY);
    await this.#taskRepo.save(task);
    return task;
  }

  async resumeAfterReply(taskId) {
    const task = await this.#getTask(taskId);
    task.transitionTo(Task.STATUSES.IN_PROGRESS);
    await this.#taskRepo.save(task);
    return task;
  }

  async completeTask(taskId) {
    const task = await this.#getTask(taskId);
    task.transitionTo(Task.STATUSES.DONE);
    await this.#taskRepo.save(task);
    return task;
  }

  async failTask(taskId) {
    const task = await this.#getTask(taskId);
    task.transitionTo(Task.STATUSES.FAILED);
    await this.#taskRepo.save(task);
    return task;
  }

  async cancelTask(taskId) {
    const task = await this.#getTask(taskId);
    task.transitionTo(Task.STATUSES.CANCELLED);
    await this.#taskRepo.save(task);
    return task;
  }

  async incrementRevision(taskId) {
    const task = await this.#getTask(taskId);
    task.incrementRevision();
    if (task.revisionCount > MAX_REVISIONS) {
      throw new RevisionLimitError(taskId, MAX_REVISIONS);
    }
    await this.#taskRepo.save(task);
    return task;
  }

  async #getTask(taskId) {
    const task = await this.#taskRepo.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }
}
