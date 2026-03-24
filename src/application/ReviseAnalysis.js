import { InvalidStateError } from '../domain/errors/InvalidStateError.js';
import { ValidationError } from '../domain/errors/ValidationError.js';

export class ReviseAnalysis {
  #taskService;
  #runService;
  #runRepo;
  #taskRepo;
  #projectRepo;
  #roleRegistry;
  #callbackSender;
  #logger;

  constructor({ taskService, runService, runRepo, taskRepo, projectRepo, roleRegistry, callbackSender, logger }) {
    this.#taskService = taskService;
    this.#runService = runService;
    this.#runRepo = runRepo;
    this.#taskRepo = taskRepo;
    this.#projectRepo = projectRepo;
    this.#roleRegistry = roleRegistry;
    this.#callbackSender = callbackSender;
    this.#logger = logger || console;
  }

  /**
   * Re-run analyst with corrections. Resumes analyst's CLI session (--resume)
   * so the analyst sees all previous context and can fix specific issues.
   *
   * Works from status: research_done, in_progress, waiting_reply
   *
   * @param {{ taskId: string, remarks: string }} params
   */
  async execute({ taskId, remarks }) {
    const task = await this.#taskService.getTask(taskId);

    const allowedStatuses = ['research_done', 'in_progress', 'waiting_reply'];
    if (!allowedStatuses.includes(task.status)) {
      throw new InvalidStateError(
        `Cannot revise analysis in status '${task.status}', expected one of: ${allowedStatuses.join(', ')}`
      );
    }

    if (!remarks || !remarks.trim()) {
      throw new ValidationError('remarks is required');
    }

    this.#roleRegistry.get('analyst');

    // If research_done — reactivate task
    if (task.status === 'research_done') {
      const activated = await this.#taskRepo.activateIfNoActive(task.id, task.projectId, 'research_done');
      if (!activated) {
        throw new InvalidStateError('Cannot revise: another task is active for this project');
      }
    }

    // If waiting_reply — move back to in_progress
    if (task.status === 'waiting_reply') {
      await this.#taskService.resumeAfterReply(task.id);
    }

    const project = await this.#projectRepo.findById(task.projectId);
    const shortId = project?.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    const prompt = `Замечания по результатам аналитики. Исправь свою работу с учётом этих замечаний.

Задача: ${shortId ?? ''} ${task.title}

Замечания от владельца:
${remarks}

Учти всё, что ты уже сделал ранее. Обнови артефакты в docs/analyst/${shortId ?? '<shortId>'}/: research, design/spec.md, context.md. Закоммить исправления.`;

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName: 'analyst',
      prompt,
      callbackUrl: task.callbackUrl,
      callbackMeta: task.callbackMeta,
    });

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        {
          type: 'progress',
          taskId: task.id,
          shortId,
          stage: 'revise_analysis',
          message: 'Аналитик перезапущен с замечаниями',
        },
        task.callbackMeta,
      );
    }

    return { taskId: task.id, shortId, status: 'in_progress' };
  }
}
