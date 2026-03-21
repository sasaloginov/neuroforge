import { Session } from '../domain/entities/Session.js';
import { RunTimeoutError } from '../domain/errors/RunTimeoutError.js';

export class ProcessRun {
  #runRepo;
  #runService;
  #taskRepo;
  #chatEngine;
  #sessionRepo;
  #roleRegistry;
  #callbackSender;

  constructor({ runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender }) {
    this.#runRepo = runRepo;
    this.#runService = runService;
    this.#taskRepo = taskRepo;
    this.#chatEngine = chatEngine;
    this.#sessionRepo = sessionRepo;
    this.#roleRegistry = roleRegistry;
    this.#callbackSender = callbackSender;
  }

  async execute() {
    // takeNext() atomically dequeues and transitions to 'running'
    const run = await this.#runRepo.takeNext();
    if (!run) return null;

    let result = null;

    try {
      const role = this.#roleRegistry.get(run.roleName);

      // Resolve projectId from task
      const task = run.taskId ? await this.#taskRepo.findById(run.taskId) : null;
      const projectId = task ? task.projectId : run.taskId;

      // Find or create session record
      let session = await this.#sessionRepo.findByProjectAndRole(projectId, run.roleName);
      if (!session) {
        session = Session.create({ projectId, roleName: run.roleName, cliSessionId: null });
        await this.#sessionRepo.save(session);
      }

      // Only pass sessionId for continuation if explicitly set on the run
      result = await this.#chatEngine.runPrompt(run.roleName, run.prompt, {
        sessionId: run.sessionId || null,
        timeoutMs: role.timeoutMs,
      });

      // Update session's cliSessionId if returned
      if (result.sessionId && result.sessionId !== session.cliSessionId) {
        session.cliSessionId = result.sessionId;
        await this.#sessionRepo.save(session);
      }

      // Complete the run (RunService re-loads from DB, so the running status from takeNext is fine)
      await this.#runService.complete(run.id, result.response);

      if (run.callbackUrl) {
        await this.#callbackSender.send(
          run.callbackUrl,
          { type: 'progress', taskId: run.taskId, stage: run.roleName, message: 'Шаг завершен' },
          run.callbackMeta,
        );
      }
    } catch (error) {
      if (error instanceof RunTimeoutError || (error.message && error.message.toLowerCase().includes('timeout'))) {
        await this.#runService.timeout(run.id);
      } else {
        await this.#runService.fail(run.id, error.message);
      }

      if (run.callbackUrl) {
        await this.#callbackSender.send(
          run.callbackUrl,
          { type: 'failed', taskId: run.taskId, error: error.message },
          run.callbackMeta,
        );
      }
    }

    return { run, result };
  }
}
