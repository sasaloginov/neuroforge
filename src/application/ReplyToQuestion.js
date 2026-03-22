import { InvalidStateError } from '../domain/errors/InvalidStateError.js';

export class ReplyToQuestion {
  #taskService;
  #runService;
  #runRepo;
  #projectRepo;
  #callbackSender;

  constructor({ taskService, runService, runRepo, projectRepo, callbackSender }) {
    this.#taskService = taskService;
    this.#runService = runService;
    this.#runRepo = runRepo;
    this.#projectRepo = projectRepo;
    this.#callbackSender = callbackSender;
  }

  async execute({ taskId, questionId, answer }) {
    const task = await this.#taskService.getTask(taskId);

    if (task.status !== 'waiting_reply') {
      throw new InvalidStateError('Task is not waiting for reply');
    }

    const runs = await this.#runRepo.findByTaskId(taskId);
    const lastRun = runs
      .filter(r => r.status === 'done')
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    if (!lastRun) {
      throw new InvalidStateError('No completed run found');
    }

    const prompt = `Предыдущий контекст: ты работал над задачей "${task.title}" в роли ${lastRun.roleName}.\nТы задал вопрос владельцу задачи.\nОтвет от владельца: ${answer}\nПродолжи работу с учётом ответа.`;

    await this.#taskService.resumeAfterReply(taskId);

    await this.#runService.enqueue({
      taskId,
      stepId: lastRun.stepId,
      roleName: lastRun.roleName,
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
        { type: 'progress', taskId, shortId, stage: 'reply_received', message: 'Ответ получен, продолжаю работу' },
        task.callbackMeta,
      );
    }

    return { taskId, shortId, status: 'in_progress' };
  }
}
