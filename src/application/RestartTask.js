import { InvalidStateError } from '../domain/errors/InvalidStateError.js';

export class RestartTask {
  #taskService;
  #runService;
  #runRepo;
  #projectRepo;
  #roleRegistry;
  #managerDecision;
  #callbackSender;

  constructor({ taskService, runService, runRepo, projectRepo, roleRegistry, managerDecision, callbackSender }) {
    this.#taskService = taskService;
    this.#runService = runService;
    this.#runRepo = runRepo;
    this.#projectRepo = projectRepo;
    this.#roleRegistry = roleRegistry;
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
      await this.#runService.enqueue({
        taskId,
        roleName: 'analyst',
        prompt: `Фаза: analyst.\n\nИсследуй и спроектируй задачу: ${task.title}\n\n${task.description || ''}`,
        callbackUrl: task.callbackUrl,
        callbackMeta: task.callbackMeta,
      });
      return { taskId, shortId, status: 'in_progress', decision: { action: 'spawn_run', role: 'analyst' } };
    }

    // Let manager decide next step based on run history
    const lastRun = terminalRuns[0];
    const decision = await this.#managerDecision.execute({ completedRunId: lastRun.id });

    return { taskId, shortId, status: 'in_progress', decision };
  }
}
