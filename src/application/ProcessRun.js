import { RunTimeoutError } from '../domain/errors/RunTimeoutError.js';
import { resolveWorkDir, assertBranchMatchesProject } from './resolveWorkDir.js';

export class ProcessRun {
  #runRepo;
  #runService;
  #taskRepo;
  #projectRepo;
  #chatEngine;
  #sessionRepo;
  #roleResolver;
  #callbackSender;
  #gitOps;
  #workDir;
  #runAbortRegistry;
  #logger;

  constructor({ runRepo, runService, taskRepo, projectRepo, chatEngine, sessionRepo, roleRegistry, callbackSender, gitOps, workDir, runAbortRegistry, logger }) {
    this.#runRepo = runRepo;
    this.#runService = runService;
    this.#taskRepo = taskRepo;
    this.#projectRepo = projectRepo || null;
    this.#chatEngine = chatEngine;
    this.#sessionRepo = sessionRepo;
    this.#roleResolver = roleRegistry;
    this.#callbackSender = callbackSender;
    this.#gitOps = gitOps || null;
    this.#workDir = workDir || null;
    this.#runAbortRegistry = runAbortRegistry || null;
    this.#logger = logger || console;
  }

  async execute() {
    // takeNext() atomically dequeues and transitions to 'running'
    const run = await this.#runRepo.takeNext();
    if (!run) return null;

    // Create AbortController and register before CLI call
    const abortController = new AbortController();
    if (this.#runAbortRegistry) {
      this.#runAbortRegistry.register(run.id, abortController);
    }

    let result = null;
    let task = null;

    try {
      // Resolve projectId from task
      task = run.taskId ? await this.#taskRepo.findById(run.taskId) : null;
      const projectId = task ? task.projectId : run.taskId;

      // Find or create session — prefer task-scoped sessions (Pipeline v2)
      let session;
      if (task && this.#sessionRepo.findOrCreateForTask) {
        session = await this.#sessionRepo.findOrCreateForTask(task.id, projectId, run.roleName);
      } else {
        session = await this.#sessionRepo.findOrCreate(projectId, run.roleName);
      }

      // Developer resumes analyst session (shared context via --resume)
      if (run.roleName === 'developer' && !session.cliSessionId) {
        let srcSession = null;
        if (task && this.#sessionRepo.findByTaskAndRole) {
          srcSession = await this.#sessionRepo.findByTaskAndRole(task.id, 'analyst');
        } else {
          srcSession = await this.#sessionRepo.findByProjectAndRole(projectId, 'analyst');
        }
        if (srcSession?.cliSessionId) {
          session.cliSessionId = srcSession.cliSessionId;
          await this.#sessionRepo.save(session);
          this.#logger.info('[ProcessRun] developer inheriting analyst session: %s', srcSession.cliSessionId);
        }
      }

      // Bind session to run before executing
      run.sessionId = session.id;
      await this.#runRepo.save(run);

      // Resolve project and working directory
      const project = task?.projectId && this.#projectRepo
        ? await this.#projectRepo.findById(task.projectId)
        : null;
      const effectiveWorkDir = await resolveWorkDir({ project, fallback: this.#workDir });

      // Resolve role with project-level override (must be after workDir resolution)
      const role = await this.#roleResolver.resolve(run.roleName, effectiveWorkDir);

      // Guard: branch prefix must match project prefix
      if (task?.branchName && project?.prefix) {
        assertBranchMatchesProject(task.branchName, project.prefix);
      }

      // Ensure task branch is checked out (if configured)
      if (this.#gitOps && effectiveWorkDir && task?.branchName) {
        try {
          await this.#gitOps.ensureBranch(task.branchName, effectiveWorkDir);
        } catch (err) {
          this.#logger.warn('[ProcessRun] Git branch checkout failed for %s: %s', task.branchName, err.message);
        }
        try {
          await this.#gitOps.syncAllWorktrees(task.branchName, effectiveWorkDir);
        } catch (err) {
          this.#logger.warn('[ProcessRun] Worktree sync failed for %s: %s', task.branchName, err.message);
        }
      }

      // Pass CLI session id for continuation
      result = await this.#chatEngine.runPrompt(run.roleName, run.prompt, {
        sessionId: session.cliSessionId || null,
        timeoutMs: role.timeoutMs,
        runId: run.id,
        taskId: run.taskId,
        signal: abortController.signal,
        workDir: effectiveWorkDir,
        projectId,
      });

      // Update session's cliSessionId if returned
      if (result.sessionId && result.sessionId !== session.cliSessionId) {
        session.cliSessionId = result.sessionId;
        await this.#sessionRepo.save(session);
      }

      // Complete the run with usage stats
      const usage = result.usage
        ? { ...result.usage, cost_usd: result.costUsd ?? null }
        : null;
      await this.#runService.complete(run.id, result.response, usage);

      if (run.callbackUrl) {
        await this.#callbackSender.send(
          run.callbackUrl,
          { type: 'progress', taskId: run.taskId, shortId: task?.shortId ?? null, stage: run.roleName, message: 'Шаг завершен' },
          run.callbackMeta,
        );
      }
    } catch (error) {
      // If run was cancelled via CancelTask — don't overwrite with fail()
      if (error.name === 'AbortError' || error.message === 'Aborted') {
        const freshRun = await this.#runRepo.findById(run.id);
        if (freshRun && freshRun.status === 'cancelled') {
          return { run, result: null };
        }
      }

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
    } finally {
      // Always unregister from abort registry
      if (this.#runAbortRegistry) {
        this.#runAbortRegistry.unregister(run.id);
      }
    }

    return { run, result };
  }
}
