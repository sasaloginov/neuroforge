export class StartNextPendingTask {
  #taskRepo;
  #taskService;
  #runService;
  #roleRegistry;

  constructor({ taskRepo, taskService, runService, roleRegistry }) {
    this.#taskRepo = taskRepo;
    this.#taskService = taskService;
    this.#runService = runService;
    this.#roleRegistry = roleRegistry;
  }

  /**
   * Find the oldest pending task for a project and start it.
   * No-op if there's already an active task or no pending tasks.
   * @param {{ projectId: string }} params
   * @returns {{ started: boolean, taskId?: string }}
   */
  async execute({ projectId }) {
    const hasActive = await this.#taskRepo.hasActiveTask(projectId);
    if (hasActive) {
      return { started: false, reason: 'active_task_exists' };
    }

    const task = await this.#taskRepo.findOldestPending(projectId);
    if (!task) {
      return { started: false, reason: 'no_pending_tasks' };
    }

    // Validate analyst role exists
    this.#roleRegistry.get('analyst');

    const prompt = `Задача: ${task.title}\n\n${task.description ?? ''}\n\nПроанализируй задачу и создай спецификацию.`;

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName: 'analyst',
      prompt,
      callbackUrl: task.callbackUrl,
      callbackMeta: task.callbackMeta,
    });

    await this.#taskService.advanceTask(task.id);

    return { started: true, taskId: task.id };
  }
}
