/**
 * Health check components for the /health endpoint.
 */

/**
 * Checks PostgreSQL connectivity by running `SELECT 1`.
 */
export class DatabaseHealthChecker {
  #pool;
  #timeoutMs;

  /**
   * @param {{ pool: import('pg').Pool, timeoutMs?: number }} opts
   */
  constructor({ pool, timeoutMs = 3000 }) {
    this.#pool = pool;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * @returns {Promise<{ status: 'ok'|'error', latencyMs: number, error?: string }>}
   */
  async check() {
    const start = Date.now();
    try {
      const client = await this.#pool.connect();
      try {
        await client.query({
          text: 'SELECT 1',
          timeout: this.#timeoutMs,
        });
      } finally {
        client.release();
      }
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      return { status: 'error', latencyMs: Date.now() - start, error: err.message };
    }
  }
}

/**
 * Checks the ManagerScheduler state.
 */
export class SchedulerHealthChecker {
  #scheduler;

  /**
   * @param {{ scheduler: { stopping: boolean, activeCount: number } }} opts
   */
  constructor({ scheduler }) {
    this.#scheduler = scheduler;
  }

  /**
   * @returns {{ status: 'ok'|'error', activeWorkers: number }}
   */
  check() {
    const stopping = this.#scheduler.stopping;
    const activeWorkers = this.#scheduler.activeCount;

    if (stopping) {
      return { status: 'error', activeWorkers };
    }
    return { status: 'ok', activeWorkers };
  }
}
