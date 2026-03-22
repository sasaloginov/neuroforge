export class EnqueueTask {
  #taskService;
  #startNextPendingTask;
  #projectRepo;

  constructor({ taskService, startNextPendingTask, projectRepo }) {
    this.#taskService = taskService;
    this.#startNextPendingTask = startNextPendingTask;
    this.#projectRepo = projectRepo;
  }

  /**
   * Move a task from backlog to pending, then attempt to start it.
   * @param {{ taskId: string }} params
   */
  async execute({ taskId }) {
    const task = await this.#taskService.enqueueFromBacklog(taskId);

    const project = await this.#projectRepo.findById(task.projectId);
    const shortId = project?.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    // Try to start immediately if no other active task
    const startResult = await this.#startNextPendingTask.execute({ projectId: task.projectId });

    return {
      taskId: task.id,
      shortId,
      status: startResult.started ? 'in_progress' : 'pending',
    };
  }
}
