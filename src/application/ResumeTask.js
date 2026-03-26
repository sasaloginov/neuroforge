import { InvalidStateError } from '../domain/errors/InvalidStateError.js';

const ALLOWED_STATUSES = ['failed', 'needs_escalation', 'cancelled'];

export class ResumeTask {
  #taskService;
  #runService;
  #runRepo;
  #taskRepo;
  #projectRepo;
  #managerDecision;
  #callbackSender;
  #logger;

  constructor({ taskService, runService, runRepo, taskRepo, projectRepo, managerDecision, callbackSender, logger }) {
    this.#taskService = taskService;
    this.#runService = runService;
    this.#runRepo = runRepo;
    this.#taskRepo = taskRepo;
    this.#projectRepo = projectRepo;
    this.#managerDecision = managerDecision;
    this.#callbackSender = callbackSender;
    this.#logger = logger || console;
  }

  async execute({ taskId, instruction }) {
    const task = await this.#taskService.getTask(taskId);

    if (!ALLOWED_STATUSES.includes(task.status)) {
      throw new InvalidStateError(
        `Cannot resume task in status '${task.status}', expected one of: ${ALLOWED_STATUSES.join(', ')}`,
      );
    }

    // Atomically activate (current status → in_progress) — fails if another task is active
    const activated = await this.#taskRepo.activateIfNoActive(task.id, task.projectId, task.status);
    if (!activated) {
      throw new InvalidStateError(
        'Cannot resume: another task is active for this project',
      );
    }

    const project = await this.#projectRepo.findById(task.projectId);
    const shortId = project?.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    // Get run history
    const allRuns = await this.#runRepo.findByTaskId(taskId);
    const terminalRuns = allRuns
      .filter(r => ['done', 'failed', 'timeout', 'interrupted'].includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt);

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'progress', taskId: task.id, shortId, stage: 'resumed', message: 'Задача возобновлена' },
        task.callbackMeta,
      );
    }

    // No terminal runs — start from scratch with analyst phase
    if (terminalRuns.length === 0) {
      const instructionPart = instruction ? `\n\nИнструкция от владельца:\n${instruction}` : '';
      await this.#runService.enqueue({
        taskId,
        roleName: 'analyst',
        prompt: `Фаза: analyst.\n\nИсследуй и спроектируй задачу: ${task.title}\n\n${task.description || ''}${instructionPart}`,
        callbackUrl: task.callbackUrl,
        callbackMeta: task.callbackMeta,
      });
      return { taskId: task.id, shortId, status: 'in_progress', decision: { action: 'spawn_run', role: 'analyst' } };
    }

    // Let manager decide next step based on run history
    if (instruction) {
      this.#logger.info('[ResumeTask] Instruction provided (context only): %s', instruction.substring(0, 200));
    }

    const lastRun = terminalRuns[0];
    const decision = await this.#managerDecision.execute({ completedRunId: lastRun.id });

    return { taskId: task.id, shortId, status: 'in_progress', decision };
  }
}
