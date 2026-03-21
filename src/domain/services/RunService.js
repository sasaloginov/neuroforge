import { Run } from '../entities/Run.js';
import { RunNotFoundError } from '../errors/RunNotFoundError.js';

export class RunService {
  #runRepo;

  constructor({ runRepo }) {
    this.#runRepo = runRepo;
  }

  async enqueue({ taskId, stepId, roleName, prompt, callbackUrl, callbackMeta }) {
    const run = Run.create({ taskId, stepId, roleName, prompt, callbackUrl, callbackMeta });
    await this.#runRepo.save(run);
    return run;
  }

  async start(runId, sessionId) {
    const run = await this.#getRun(runId);
    run.start(sessionId);
    await this.#runRepo.save(run);
    return run;
  }

  async complete(runId, response) {
    const run = await this.#getRun(runId);
    run.complete(response);
    await this.#runRepo.save(run);
    return run;
  }

  async fail(runId, error) {
    const run = await this.#getRun(runId);
    run.fail(error);
    await this.#runRepo.save(run);
    return run;
  }

  async timeout(runId) {
    const run = await this.#getRun(runId);
    run.markTimeout();
    await this.#runRepo.save(run);
    return run;
  }

  async interrupt(runId) {
    const run = await this.#getRun(runId);
    run.interrupt();
    await this.#runRepo.save(run);
    return run;
  }

  async #getRun(runId) {
    const run = await this.#runRepo.findById(runId);
    if (!run) throw new RunNotFoundError(runId);
    return run;
  }
}
