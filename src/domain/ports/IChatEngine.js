/**
 * @typedef {Object} RunPromptOptions
 * @property {string} [sessionId] - existing CLI session ID
 * @property {AbortSignal} [signal] - cancellation signal
 * @property {number} [timeoutMs] - override default timeout
 */

/**
 * @typedef {Object} RunPromptResult
 * @property {string} response - agent's text response
 * @property {string} sessionId - CLI session ID (new or reused)
 */

/**
 * Port for executing prompts via AI engine (Claude CLI).
 *
 * @interface IChatEngine
 * @method runPrompt
 * @param {string} roleName - role to use
 * @param {string} prompt - prompt text
 * @param {RunPromptOptions} [options]
 * @returns {Promise<RunPromptResult>}
 */
export class IChatEngine {
  async runPrompt(_roleName, _prompt, _options) {
    throw new Error('Not implemented');
  }
}
