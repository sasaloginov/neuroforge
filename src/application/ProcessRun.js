import { RunTimeoutError } from '../domain/errors/RunTimeoutError.js';

export class ProcessRun {
  #runRepo;
  #runService;
  #taskRepo;
  #chatEngine;
  #sessionRepo;
  #roleRegistry;
  #callbackSender;
  #gitOps;
  #workDir;
  #agentMemoryService;
  #runAbortRegistry;
  #logger;

  constructor({ runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender, gitOps, workDir, agentMemoryService, runAbortRegistry, logger }) {
    this.#runRepo = runRepo;
    this.#runService = runService;
    this.#taskRepo = taskRepo;
    this.#chatEngine = chatEngine;
    this.#sessionRepo = sessionRepo;
    this.#roleRegistry = roleRegistry;
    this.#callbackSender = callbackSender;
    this.#gitOps = gitOps || null;
    this.#workDir = workDir || null;
    this.#agentMemoryService = agentMemoryService || null;
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
      const role = this.#roleRegistry.get(run.roleName);

      // Resolve projectId from task
      task = run.taskId ? await this.#taskRepo.findById(run.taskId) : null;
      const projectId = task ? task.projectId : run.taskId;

      // Find or create session record (atomic upsert)
      const session = await this.#sessionRepo.findOrCreate(projectId, run.roleName);

      // Bind session to run before executing
      run.sessionId = session.id;
      await this.#runRepo.save(run);

      // Ensure task branch is checked out (if configured)
      if (this.#gitOps && this.#workDir && task?.branchName) {
        try {
          await this.#gitOps.ensureBranch(task.branchName, this.#workDir);
        } catch (err) {
          this.#logger.warn('[ProcessRun] Git branch checkout failed for %s: %s', task.branchName, err.message);
        }
        // Sync all agent worktrees to the task branch so Claude CLI agents see fresh code
        try {
          await this.#gitOps.syncAllWorktrees(task.branchName, this.#workDir);
        } catch (err) {
          this.#logger.warn('[ProcessRun] Worktree sync failed for %s: %s', task.branchName, err.message);
        }
      }

      // Retrieve relevant memories and enrich prompt
      let enrichedPrompt = run.prompt;
      if (this.#agentMemoryService && task) {
        try {
          const memories = await this.#agentMemoryService.retrieve(
            task.projectId,
            run.prompt,
            { role: run.roleName, limit: 5 },
          );
          if (memories.length > 0) {
            const memoryContext = this.#agentMemoryService.formatForPrompt(memories);
            enrichedPrompt = `${run.prompt}\n\n<project_memory>\n${memoryContext}\n</project_memory>`;
            this.#logger.log('[ProcessRun] Injected %d memories for %s', memories.length, run.roleName);
          }
        } catch (err) {
          this.#logger.warn('[ProcessRun] Memory retrieval failed: %s', err.message);
        }
      }

      // Pass CLI session id for continuation
      result = await this.#chatEngine.runPrompt(run.roleName, enrichedPrompt, {
        sessionId: session.cliSessionId || null,
        timeoutMs: role.timeoutMs,
        runId: run.id,
        taskId: run.taskId,
        signal: abortController.signal,
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
