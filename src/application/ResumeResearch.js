import { InvalidStateError } from '../domain/errors/InvalidStateError.js';
import { ValidationError } from '../domain/errors/ValidationError.js';

export class ResumeResearch {
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

  async execute({ taskId, instruction }) {
    const task = await this.#taskService.getTask(taskId);

    if (task.status !== 'research_done') {
      throw new InvalidStateError(
        `Cannot resume task in status '${task.status}', expected 'research_done'`
      );
    }

    if (!instruction || !instruction.trim()) {
      throw new ValidationError('instruction is required');
    }

    // Atomically activate (research_done → in_progress) — fails if another task is active
    const activated = await this.#taskRepo.activateIfNoActive(task.id, task.projectId, 'research_done');
    if (!activated) {
      throw new InvalidStateError(
        'Cannot resume: another task is active for this project'
      );
    }

    // Switch mode to full (research phase is over)
    await this.#taskService.updateMode(task.id, 'full');

    // Get previous analyst's research for context
    const allRuns = await this.#runRepo.findByTaskId(task.id);
    const lastAnalystRun = [...allRuns]
      .filter(r => r.roleName === 'analyst' && r.status === 'done')
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    const researchContext = lastAnalystRun?.response
      ? `\n\nРезультаты предыдущего исследования (аналитик):\n${lastAnalystRun.response.substring(0, 10000)}`
      : '';

    // Enqueue developer phase with research context + owner instruction
    this.#roleRegistry.get('developer');

    const prompt = `Фаза: developer.

Задача: ${task.title}
Описание: ${task.description ?? 'нет'}
${researchContext}

Инструкция от владельца для продолжения работы:
${instruction}

Реализуй задачу на основе результатов исследования и инструкции владельца.`;

    await this.#runService.enqueue({
      taskId: task.id,
      stepId: null,
      roleName: 'developer',
      prompt,
      callbackUrl: task.callbackUrl,
      callbackMeta: task.callbackMeta,
    });

    const project = await this.#projectRepo.findById(task.projectId);
    const shortId = project?.prefix && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        {
          type: 'progress',
          taskId: task.id,
          shortId,
          stage: 'resumed',
          message: 'Задача возобновлена, переход к разработке',
        },
        task.callbackMeta,
      );
    }

    return { taskId: task.id, shortId, status: 'in_progress' };
  }
}
