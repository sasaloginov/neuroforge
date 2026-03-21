import { InvalidStateError } from '../domain/errors/InvalidStateError.js';

export class ReplyToQuestion {
  #taskService;
  #runService;
  #runRepo;
  #callbackSender;

  constructor({ taskService, runService, runRepo, callbackSender }) {
    this.#taskService = taskService;
    this.#runService = runService;
    this.#runRepo = runRepo;
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

    if (task.callbackUrl) {
      await this.#callbackSender.send(
        task.callbackUrl,
        { type: 'progress', taskId, stage: 'reply_received', message: 'Ответ получен, продолжаю работу' },
        task.callbackMeta,
      );
    }

    return { taskId, status: 'in_progress' };
  }
}
