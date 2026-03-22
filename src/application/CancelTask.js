export class CancelTask {
  #taskService;
  #runRepo;
  #projectRepo;
  #callbackSender;
  #startNextPendingTask;
  #logger;

  constructor({ taskService, runRepo, projectRepo, callbackSender, startNextPendingTask, logger }) {
    this.#taskService = taskService;
    this.#runRepo = runRepo;
    this.#projectRepo = projectRepo;
    this.#callbackSender = callbackSender;
    this.#startNextPendingTask = startNextPendingTask || null;
    this.#logger = logger || console;
  }

  async execute({ taskId }) {
    const task = await this.#taskService.getTask(taskId);

    // Cancel all queued runs first
    const runs = await this.#runRepo.findByTaskId(taskId);
    const queuedRuns = runs.filter(r => r.status === 'queued');

    for (const run of queuedRuns) {
      run.transitionTo('cancelled');
      await this.#runRepo.save(run);
    }

    // Cancel the task (throws InvalidTransitionError if already terminal)
    await this.#taskService.cancelTask(taskId);

    const project = await this.#projectRepo.findById(task.projectId);
    const shortId = project?.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'failed', taskId, shortId, error: 'Task cancelled by user' },
        task.callbackMeta,
      );
    }

    // Try to start next pending task for the project
    if (this.#startNextPendingTask) {
      try {
        await this.#startNextPendingTask.execute({ projectId: task.projectId });
      } catch (err) {
        this.#logger.error('[CancelTask] Failed to start next pending task: %s', err.message);
      }
    }

    return { taskId, shortId, status: 'cancelled', cancelledRuns: queuedRuns.length };
  }
}
