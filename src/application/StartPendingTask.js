export class StartPendingTask {
  #taskService;
  #taskRepo;
  #runService;
  #roleRegistry;
  #callbackSender;

  constructor({ taskService, taskRepo, runService, roleRegistry, callbackSender }) {
    this.#taskService = taskService;
    this.#taskRepo = taskRepo;
    this.#runService = runService;
    this.#roleRegistry = roleRegistry;
    this.#callbackSender = callbackSender;
  }

  /**
   * Start the oldest pending task for a given project.
   * Called by scheduler when a project has no active tasks.
   * @returns {Task|null} — started task or null if nothing to start
   */
  async execute(projectId) {
    // Double-check no active task
    const hasActive = await this.#taskService.hasActiveTask(projectId);
    if (hasActive) return null;

    const task = await this.#taskService.findOldestPending(projectId);
    if (!task) return null;

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

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'progress', taskId: task.id, shortId: task.shortId, stage: 'queued', message: 'Задача принята из очереди, начинаю анализ' },
        task.callbackMeta,
      );
    }

    return task;
  }

  /**
   * Check all projects for pending tasks and start them if possible.
   * @returns {number} — number of tasks started
   */
  async checkAndStartAll() {
    const projectIds = await this.#taskRepo.findProjectsWithPendingTasks();
    let started = 0;

    for (const projectId of projectIds) {
      try {
        const task = await this.execute(projectId);
        if (task) started++;
      } catch {
        // Skip failures — will retry on next tick
      }
    }

    return started;
  }
}
