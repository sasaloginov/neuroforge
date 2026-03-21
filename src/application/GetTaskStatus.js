export class GetTaskStatus {
  #taskService;
  #runRepo;

  constructor({ taskService, runRepo }) {
    this.#taskService = taskService;
    this.#runRepo = runRepo;
  }

  async execute({ taskId }) {
    const task = await this.#taskService.getTask(taskId);
    const runs = await this.#runRepo.findByTaskId(taskId);

    return {
      task: {
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        status: task.status,
        revisionCount: task.revisionCount,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      runs: runs.map(r => ({
        id: r.id,
        roleName: r.roleName,
        status: r.status,
        response: r.response,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
      })),
    };
  }
}
