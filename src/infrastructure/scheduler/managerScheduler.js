/**
 * ManagerScheduler — periodic tick that drives the worker loop,
 * monitors run timeouts, and performs recovery at startup.
 */
export class ManagerScheduler {
  #worker;
  #runRepo;
  #runService;
  #roleRegistry;
  #startPendingTask;
  #logger;
  #intervalMs;
  #maxConcurrent;
  #enabled;

  #intervalHandle = null;
  #activeCount = 0;
  #stopping = false;

  /**
   * @param {object} deps
   * @param {object} deps.worker — { processOne() }
   * @param {object} deps.runRepo — { findRunning() }
   * @param {object} deps.runService — { interrupt(), timeout() }
   * @param {object} deps.roleRegistry — { get(name) }
   * @param {object} [deps.startPendingTask] — { checkAndStartAll() }
   * @param {object} deps.logger
   * @param {object} deps.config
   * @param {number} [deps.config.intervalMs=10000]
   * @param {number} [deps.config.maxConcurrent=3]
   * @param {boolean} [deps.config.enabled=true]
   */
  constructor({ worker, runRepo, runService, roleRegistry, startPendingTask, logger, config = {} }) {
    this.#worker = worker;
    this.#runRepo = runRepo;
    this.#runService = runService;
    this.#roleRegistry = roleRegistry;
    this.#startPendingTask = startPendingTask || null;
    this.#logger = logger;
    this.#intervalMs = config.intervalMs ?? 10000;
    this.#maxConcurrent = config.maxConcurrent ?? 3;
    this.#enabled = config.enabled ?? true;
  }

  /** Start the scheduler: recover stale runs, then begin ticking. */
  async start() {
    if (!this.#enabled) {
      this.#logger.info('[Scheduler] Disabled via config');
      return;
    }

    await this.#recover();

    this.#intervalHandle = setInterval(() => this.tick(), this.#intervalMs);
    this.#logger.info(
      '[Scheduler] Started (interval=%dms, maxConcurrent=%d)',
      this.#intervalMs,
      this.#maxConcurrent,
    );
  }

  /** Stop the scheduler, wait for active slots to drain. */
  async stop() {
    this.#stopping = true;

    if (this.#intervalHandle) {
      clearInterval(this.#intervalHandle);
      this.#intervalHandle = null;
    }

    // Wait for active slots (poll every 200ms, deadline 30s)
    const deadline = Date.now() + 30_000;
    while (this.#activeCount > 0 && Date.now() < deadline) {
      await sleep(200);
    }

    if (this.#activeCount > 0) {
      this.#logger.warn('[Scheduler] Force stopped with %d active slots', this.#activeCount);
    }

    this.#logger.info('[Scheduler] Stopped');
  }

  /** One tick: check timeouts, start pending tasks, fill worker slots. */
  async tick() {
    if (this.#stopping) return;

    try {
      await this.checkTimeouts();
    } catch (err) {
      this.#logger.error('[Scheduler] checkTimeouts error: %s', err.message);
    }

    // Auto-start pending tasks (FIFO) for projects with no active tasks
    if (this.#startPendingTask) {
      try {
        const started = await this.#startPendingTask.checkAndStartAll();
        if (started > 0) {
          this.#logger.info('[Scheduler] Auto-started %d pending task(s)', started);
        }
      } catch (err) {
        this.#logger.error('[Scheduler] startPendingTask error: %s', err.message);
      }
    }

    // Fill free slots
    const slotsAvailable = this.#maxConcurrent - this.#activeCount;
    for (let i = 0; i < slotsAvailable; i++) {
      this.#activeCount++;
      this.#runSlot(); // fire-and-forget
    }
  }

  /** Check running runs for timeout. */
  async checkTimeouts() {
    const TIMEOUT_BUFFER_MS = 30_000;
    const runningRuns = await this.#runRepo.findRunning();
    const now = Date.now();

    for (const run of runningRuns) {
      let role;
      try {
        role = this.#roleRegistry.get(run.roleName);
      } catch {
        continue; // role not found — skip
      }

      const elapsed = now - run.startedAt.getTime();
      if (elapsed > role.timeoutMs + TIMEOUT_BUFFER_MS) {
        try {
          await this.#runService.timeout(run.id);
          this.#logger.warn(
            '[Timeout] Run %s (role=%s) timed out after %dms',
            run.id,
            run.roleName,
            elapsed,
          );
        } catch (err) {
          // May throw InvalidTransitionError if CLI adapter already handled it
          this.#logger.warn('[Timeout] Could not timeout run %s: %s', run.id, err.message);
        }
      }
    }
  }

  /** @private Recovery — mark all running runs as interrupted at startup. */
  async #recover() {
    const runningRuns = await this.#runRepo.findRunning();

    for (const run of runningRuns) {
      await this.#runService.interrupt(run.id);
      this.#logger.warn('[Recovery] Run %s (role=%s) marked as interrupted', run.id, run.roleName);
    }

    if (runningRuns.length > 0) {
      this.#logger.info('[Recovery] Interrupted %d stale runs', runningRuns.length);
    }
  }

  /** @private Process runs in a slot until queue is empty or stopping. */
  async #runSlot() {
    try {
      while (!this.#stopping) {
        const processed = await this.#worker.processOne();
        if (!processed) break; // queue empty
      }
    } catch (err) {
      this.#logger.error('[Scheduler] Slot error: %s', err.message);
    } finally {
      this.#activeCount--;
    }
  }

  /** Expose for testing. */
  get activeCount() {
    return this.#activeCount;
  }

  get stopping() {
    return this.#stopping;
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
