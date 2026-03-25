/**
 * @typedef {Object} RunPromptOptions
 * @property {string} [sessionId] - existing CLI session ID
 * @property {AbortSignal} [signal] - cancellation signal
 * @property {number} [timeoutMs] - override default timeout
 * @property {string} [runId] - current run ID (used by MCP config for agent tools)
 * @property {string} [taskId] - current task ID (used by MCP config for agent tools)
 * @property {string} [workDir] - per-project working directory (overrides global)
 */

/**
 * @typedef {Object} RunPromptResult
 * @property {string} response - agent's text response
 * @property {string} sessionId - CLI session ID (new or reused)
 * @property {Object|null} usage - token usage stats (input_tokens, output_tokens, cache_read_input_tokens, etc.)
 * @property {number|null} costUsd - total cost in USD
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
