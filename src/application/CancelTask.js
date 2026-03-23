export class CancelTask {
  #taskService;
  #runRepo;
  #runService;
  #projectRepo;
  #callbackSender;
  #startNextPendingTask;
  #runAbortRegistry;
  #logger;

  constructor({ taskService, runRepo, runService, projectRepo, callbackSender, startNextPendingTask, runAbortRegistry, logger }) {
    this.#taskService = taskService;
    this.#runRepo = runRepo;
    this.#runService = runService || null;
    this.#projectRepo = projectRepo;
    this.#callbackSender = callbackSender;
    this.#startNextPendingTask = startNextPendingTask || null;
    this.#runAbortRegistry = runAbortRegistry || null;
    this.#logger = logger || console;
  }

  async execute({ taskId }) {
    const task = await this.#taskService.getTask(taskId);

    const runs = await this.#runRepo.findByTaskId(taskId);
    const queuedRuns = runs.filter(r => r.status === 'queued');
    const runningRuns = runs.filter(r => r.status === 'running');

    // 1. Cancel queued runs
    for (const run of queuedRuns) {
      run.transitionTo('cancelled');
      await this.#runRepo.save(run);
    }

    // 2. Abort + cancel running runs
    for (const run of runningRuns) {
      if (this.#runAbortRegistry) {
        this.#runAbortRegistry.abort(run.id);
      }
      try {
        await this.#runService.cancel(run.id);
      } catch (err) {
        // Run may have already completed — that's OK
        this.#logger.warn('[CancelTask] Could not cancel run %s: %s', run.id, err.message);
      }
    }

    // 3. Cancel the task (throws InvalidTransitionError if already terminal)
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

    const totalCancelled = queuedRuns.length + runningRuns.length;
    return { taskId, shortId, status: 'cancelled', cancelledRuns: totalCancelled };
  }
}
