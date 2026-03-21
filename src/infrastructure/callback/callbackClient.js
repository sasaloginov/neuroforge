import { ICallbackSender } from '../../domain/ports/ICallbackSender.js';

/**
 * CallbackClient — implements ICallbackSender port.
 * Sends HTTP POST callbacks to client webhook URLs.
 * Retries on failure with exponential backoff.
 * Never throws — callback failure must not break the pipeline.
 */
export class CallbackClient extends ICallbackSender {
  /**
   * @param {object} [deps]
   * @param {object} [deps.logger] - logger with info/warn/error methods
   * @param {number} [deps.timeoutMs=10000] - request timeout
   * @param {number} [deps.maxRetries=3] - maximum retry attempts
   */
  constructor({ logger, timeoutMs, maxRetries } = {}) {
    super();
    this.logger = logger || console;
    this.timeoutMs = timeoutMs ?? 10000;
    this.maxRetries = maxRetries ?? 3;
  }

  /**
   * Send a callback to the client.
   *
   * @param {string} callbackUrl - client's webhook URL
   * @param {Object} payload - { type, taskId, ...data }
   * @param {Object} [callbackMeta] - opaque JSONB passed through to client
   * @returns {Promise<{ok: boolean, statusCode?: number, attempts: number}>}
   */
  async send(callbackUrl, payload, callbackMeta) {
    const body = callbackMeta
      ? { ...payload, callbackMeta }
      : { ...payload };

    let lastError = null;
    let statusCode;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const res = await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timer);
        statusCode = res.status;

        if (res.ok) {
          this.logger.info(
            '[CallbackClient] Callback sent successfully to %s (attempt %d, status %d)',
            callbackUrl, attempt, statusCode
          );
          return { ok: true, statusCode, attempts: attempt };
        }

        lastError = new Error('HTTP ' + statusCode);
        this.logger.warn(
          '[CallbackClient] Callback failed to %s (attempt %d, status %d)',
          callbackUrl, attempt, statusCode
        );
      } catch (err) {
        lastError = err;
        this.logger.warn(
          '[CallbackClient] Callback error to %s (attempt %d): %s',
          callbackUrl, attempt, err.message
        );
      }

      // Exponential backoff: 1s, 2s, 4s (skip wait after last attempt)
      if (attempt < this.maxRetries) {
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        await this._sleep(delayMs);
      }
    }

    this.logger.error(
      '[CallbackClient] All %d attempts failed for %s: %s',
      this.maxRetries, callbackUrl, lastError?.message
    );

    return { ok: false, statusCode, attempts: this.maxRetries };
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
