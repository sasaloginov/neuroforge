import { RunNotFoundError } from '../domain/errors/RunNotFoundError.js';

export class GetRunDetail {
  #taskService;
  #runRepo;

  constructor({ taskService, runRepo }) {
    this.#taskService = taskService;
    this.#runRepo = runRepo;
  }

  async execute({ taskId, runId }) {
    const task = await this.#taskService.getTask(taskId);
    const run = await this.#runRepo.findById(runId);

    if (!run || run.taskId !== taskId) {
      throw new RunNotFoundError(runId);
    }

    return {
      task: {
        id: task.id,
        projectId: task.projectId,
      },
      run: {
        id: run.id,
        taskId: run.taskId,
        roleName: run.roleName,
        status: run.status,
        response: run.response,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        createdAt: run.createdAt,
      },
    };
  }
}
