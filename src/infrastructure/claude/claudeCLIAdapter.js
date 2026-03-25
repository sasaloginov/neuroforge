import { spawn } from 'node:child_process';
import { IChatEngine } from '../../domain/ports/IChatEngine.js';

/**
 * ClaudeCLIAdapter — implements IChatEngine port.
 * Spawns `claude` CLI as a child process for each prompt.
 * Uses --session-id / --resume for conversation continuity.
 * Uses a single shared MCP config file (HTTP transport) instead of per-run temp files.
 */
export class ClaudeCLIAdapter extends IChatEngine {
  /**
   * @param {object} deps
   * @param {import('../../domain/services/RoleRegistry.js').RoleRegistry} deps.roleRegistry
   * @param {string} [deps.workDir] - working directory for claude CLI
   * @param {object} [deps.logger] - logger with info/warn/error methods
   * @param {number} [deps.killDelayMs=5000] - delay between SIGTERM and SIGKILL
   * @param {string|null} [deps.mcpConfigPath] - path to shared MCP config JSON
   */
  constructor({ roleRegistry, workDir, logger, killDelayMs, mcpConfigPath } = {}) {
    super();
    this.roleRegistry = roleRegistry;
    this.workDir = workDir || process.cwd();
    this.logger = logger || console;
    this.killDelayMs = killDelayMs ?? 5000;
    this.mcpConfigPath = mcpConfigPath || null;
  }

  /**
   * Run a prompt via Claude CLI with role-based configuration.
   *
   * @param {string} roleName - role to use (must be registered in RoleRegistry)
   * @param {string} prompt - prompt text
   * @param {import('../../domain/ports/IChatEngine.js').RunPromptOptions} [options]
   * @returns {Promise<import('../../domain/ports/IChatEngine.js').RunPromptResult>}
   */
  async runPrompt(roleName, prompt, options = {}) {
    try {
      return await this.#execCLI(roleName, prompt, options);
    } catch (err) {
      if (options.sessionId && err.message?.includes('No conversation found')) {
        this.logger.warn('[ClaudeCLIAdapter] Session %s not found, retrying without resume', options.sessionId);
        return this.#execCLI(roleName, prompt, { ...options, sessionId: null });
      }
      throw err;
    }
  }

  async #execCLI(roleName, prompt, options = {}) {
    const { sessionId, signal, timeoutMs, runId, taskId, workDir } = options;

    const effectiveWorkDir = workDir || this.workDir;

    if (signal && signal.aborted) {
      throw new Error('Aborted');
    }

    const role = this.roleRegistry.get(roleName);

    const args = ['--print', '--output-format', 'json', '--model', role.model];

    if (this.mcpConfigPath && runId && taskId) {
      args.push('--mcp-config', this.mcpConfigPath);
    }

    if (role.systemPrompt) {
      args.push('--system-prompt', role.systemPrompt);
    }

    if (role.allowedTools && role.allowedTools.length > 0) {
      args.push('--allowed-tools', role.allowedTools.join(','));
    }

    args.push('--append-system-prompt', `Project workspace: ${effectiveWorkDir}`);

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    const effectiveTimeout = timeoutMs || role.timeoutMs;

    this.logger.info(
      '[ClaudeCLIAdapter] Spawning claude with role=%s model=%s timeout=%dms session=%s',
      roleName, role.model, effectiveTimeout, sessionId || 'new'
    );

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let done = false;

      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        fn(value);
      };

      const proc = spawn('claude', args, {
        cwd: effectiveWorkDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
        },
      });

      // Write prompt to stdin and close it
      proc.stdin.write(prompt);
      proc.stdin.end();

      // AbortSignal support
      const onAbort = () => {
        killed = true;
        proc.kill('SIGTERM');
        finish(reject, new Error('Aborted'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Soft timeout: SIGTERM
      const softTimer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
      }, effectiveTimeout);

      // Hard timeout: SIGKILL after killDelayMs
      const hardTimer = setTimeout(() => {
        if (!done) proc.kill('SIGKILL');
      }, effectiveTimeout + this.killDelayMs);

      proc.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (text.trim()) {
          this.logger.warn('[ClaudeCLIAdapter] stderr: %s', text.trim());
        }
      });

      proc.on('error', (err) => {
        finish(reject, new Error('Failed to spawn claude CLI: ' + err.message));
      });

      proc.on('close', (code) => {
        if (killed) {
          finish(reject, new Error(
            'Claude CLI timeout after ' + (effectiveTimeout / 1000) + ' seconds'
          ));
          return;
        }

        if (code !== 0) {
          finish(reject, new Error(
            'Claude CLI exited with code ' + code + ': ' + stderr.trim()
          ));
          return;
        }

        try {
          const data = JSON.parse(stdout);

          if (data.is_error) {
            finish(reject, new Error('Claude CLI error: ' + (data.result || '')));
            return;
          }

          const response = data.result || '';
          if (!response) {
            finish(reject, new Error('Claude CLI returned empty response'));
            return;
          }

          finish(resolve, {
            response,
            sessionId: data.session_id || sessionId || '',
            usage: data.usage || null,
            costUsd: data.total_cost_usd ?? null,
          });
        } catch (e) {
          // If JSON parsing fails but we have stdout, use it as raw response
          const text = stdout.trim();
          if (text) {
            this.logger.warn('[ClaudeCLIAdapter] JSON parse failed, using raw output: %s', e.message);
            finish(resolve, { response: text, sessionId: sessionId || '' });
          } else {
            finish(reject, new Error('Failed to parse Claude CLI output: ' + e.message));
          }
        }
      });
    });
  }
}
