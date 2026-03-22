import { execSync } from 'node:child_process';
import { RunTimeoutError } from '../domain/errors/RunTimeoutError.js';

export class ProcessRun {
  #runRepo;
  #runService;
  #taskRepo;
  #projectRepo;
  #chatEngine;
  #sessionRepo;
  #roleRegistry;
  #callbackSender;

  constructor({ runRepo, runService, taskRepo, projectRepo, chatEngine, sessionRepo, roleRegistry, callbackSender }) {
    this.#runRepo = runRepo;
    this.#runService = runService;
    this.#taskRepo = taskRepo;
    this.#projectRepo = projectRepo;
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
    let task = null;

    try {
      const role = this.#roleRegistry.get(run.roleName);

      // Resolve projectId and workDir from task/project
      task = run.taskId ? await this.#taskRepo.findById(run.taskId) : null;
      const projectId = task ? task.projectId : run.taskId;

      const project = projectId ? await this.#projectRepo.findById(projectId) : null;
      const workDir = project?.workDir || null;

      // Checkout task branch before running agent
      if (task?.branchName && workDir) {
        this.#checkoutBranch(task.branchName, workDir, run.roleName);
      }

      // Find or create session record (atomic upsert)
      const session = await this.#sessionRepo.findOrCreate(projectId, run.roleName);

      // Bind session to run before executing
      run.sessionId = session.id;
      await this.#runRepo.save(run);

      // Pass CLI session id for continuation
      result = await this.#chatEngine.runPrompt(run.roleName, run.prompt, {
        sessionId: session.cliSessionId || null,
        timeoutMs: role.timeoutMs,
        runId: run.id,
        taskId: run.taskId,
        workDir,
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
          { type: 'progress', taskId: run.taskId, shortId: task?.shortId ?? null, stage: run.roleName, message: 'Шаг завершен' },
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
          { type: 'failed', taskId: run.taskId, shortId: task?.shortId ?? null, error: error.message },
          run.callbackMeta,
        );
      }

      return { run, result: null };
    }

    return { run, result };
  }

  /** Checkout the task branch in the project's workDir. */
  #checkoutBranch(branchName, workDir, roleName) {
    try {
      // Check if branch exists locally
      try {
        execSync(`git rev-parse --verify ${branchName}`, { cwd: workDir, stdio: 'pipe' });
        // Branch exists — just checkout
        execSync(`git checkout ${branchName}`, { cwd: workDir, stdio: 'pipe' });
      } catch {
        // Branch doesn't exist — analyst creates it from main
        if (roleName === 'analyst') {
          execSync(`git checkout -b ${branchName}`, { cwd: workDir, stdio: 'pipe' });
        } else {
          // For other roles, branch should already exist
          throw new Error(`Branch ${branchName} does not exist`);
        }
      }
    } catch (err) {
      throw new Error(`Git checkout failed for branch ${branchName}: ${err.message}`);
    }
  }
}
