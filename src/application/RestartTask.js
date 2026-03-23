import { InvalidStateError } from '../domain/errors/InvalidStateError.js';

export class RestartTask {
  #taskService;
  #runRepo;
  #projectRepo;
  #managerDecision;
  #callbackSender;

  constructor({ taskService, runRepo, projectRepo, managerDecision, callbackSender }) {
    this.#taskService = taskService;
    this.#runRepo = runRepo;
    this.#projectRepo = projectRepo;
    this.#managerDecision = managerDecision;
    this.#callbackSender = callbackSender;
  }

  async execute({ taskId }) {
    const task = await this.#taskService.getTask(taskId);

    if (task.status !== 'failed') {
      throw new InvalidStateError(`Cannot restart task in status '${task.status}', expected 'failed'`);
    }

    // Find the last terminal run to feed to ManagerDecision
    const allRuns = await this.#runRepo.findByTaskId(taskId);
    const terminalRuns = allRuns
      .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt);

    // Transition back to in_progress
    await this.#taskService.restartTask(taskId);

    const project = await this.#projectRepo.findById(task.projectId);
    const shortId = project?.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'progress', taskId, shortId, stage: 'restarted', message: 'Задача перезапущена' },
        task.callbackMeta,
      );
    }

    // No terminal runs — start from scratch with analyst phase
    if (terminalRuns.length === 0) {
      const { RunService } = await import('../domain/services/RunService.js');
      const runService = new RunService({ runRepo: this.#runRepo });
      const roleName = 'implementer'; // Pipeline v2: use implementer
      await runService.enqueue({
        taskId,
        roleName,
        prompt: `Фаза: analyst.\n\nИсследуй и спроектируй задачу: ${task.title}\n\n${task.description || ''}`,
        callbackUrl: task.callbackUrl,
        callbackMeta: task.callbackMeta,
      });
      return { taskId, shortId, status: 'in_progress', decision: { action: 'spawn_run', role: roleName } };
    }

    // Let manager decide next step based on run history
    const lastRun = terminalRuns[0];
    const decision = await this.#managerDecision.execute({ completedRunId: lastRun.id });

    return { taskId, shortId, status: 'in_progress', decision };
  }
}
