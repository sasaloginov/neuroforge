export class StartNextPendingTask {
  #taskRepo;
  #runService;
  #roleRegistry;

  constructor({ taskRepo, taskService, runService, roleRegistry }) {
    this.#taskRepo = taskRepo;
    // taskService kept in constructor signature for backward compat but no longer used
    this.#runService = runService;
    this.#roleRegistry = roleRegistry;
  }

  /**
   * Atomically find the oldest pending task for a project and activate it.
   * Uses a single atomic DB operation to avoid TOCTOU race conditions.
   * No-op if there's already an active task or no pending tasks.
   * @param {{ projectId: string }} params
   * @returns {{ started: boolean, taskId?: string, reason?: string }}
   */
  async execute({ projectId }) {
    // Validate analyst role exists before attempting activation
    this.#roleRegistry.get('analyst');

    // Atomic: check no active + find oldest pending + transition to in_progress
    const task = await this.#taskRepo.activateOldestPending(projectId);
    if (!task) {
      return { started: false, reason: 'no_eligible_task' };
    }

    const prompt = `Задача: ${task.title}\n\n${task.description ?? ''}\n\nПроанализируй задачу и создай спецификацию.`;

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName: 'analyst',
      prompt,
      callbackUrl: task.callbackUrl,
      callbackMeta: task.callbackMeta,
    });

    return { started: true, taskId: task.id };
  }
}
