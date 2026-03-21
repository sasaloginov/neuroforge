export class CancelTask {
  #taskService;
  #runRepo;
  #callbackSender;

  constructor({ taskService, runRepo, callbackSender }) {
    this.#taskService = taskService;
    this.#runRepo = runRepo;
    this.#callbackSender = callbackSender;
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

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'failed', taskId, error: 'Task cancelled by user' },
        task.callbackMeta,
      );
    }

    return { taskId, status: 'cancelled', cancelledRuns: queuedRuns.length };
  }
}
