export class StartNextPendingTask {
  #taskRepo;
  #runService;
  #roleRegistry;

  constructor({ taskRepo, runService, roleRegistry }) {
    this.#taskRepo = taskRepo;
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
    // Validate analyst/implementer role exists before attempting activation
    const analystRole = this.#roleRegistry.has('implementer') ? 'implementer' : 'analyst';
    this.#roleRegistry.get(analystRole);

    // Atomic: check no active + find oldest pending + transition to in_progress
    const task = await this.#taskRepo.activateOldestPending(projectId);
    if (!task) {
      return { started: false, reason: 'no_eligible_task' };
    }

    const prompt = `Фаза: analyst.

Задача: ${task.title}
Ветка: ${task.branchName ?? 'не назначена'}

${task.description ?? ''}

Проанализируй задачу и создай спецификацию.`;

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName: analystRole,
      prompt,
      callbackUrl: task.callbackUrl,
      callbackMeta: task.callbackMeta,
    });

    return { started: true, taskId: task.id };
  }
}
