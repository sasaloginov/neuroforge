/**
 * In-memory registry mapping runId → AbortController.
 * Allows CancelTask to abort running CLI processes by runId.
 * Single-process singleton — no external dependencies.
 */
export class RunAbortRegistry {
  #controllers = new Map();

  /** @param {string} runId  @param {AbortController} controller */
  register(runId, controller) {
    this.#controllers.set(runId, controller);
  }

  /** @param {string} runId */
  unregister(runId) {
    this.#controllers.delete(runId);
  }

  /**
   * Abort a running run. No-op if runId not registered.
   * @param {string} runId
   * @returns {boolean} true if aborted
   */
  abort(runId) {
    const controller = this.#controllers.get(runId);
    if (controller) {
      controller.abort();
      this.#controllers.delete(runId);
      return true;
    }
    return false;
  }

  /** @param {string} runId  @returns {boolean} */
  has(runId) {
    return this.#controllers.has(runId);
  }
}
