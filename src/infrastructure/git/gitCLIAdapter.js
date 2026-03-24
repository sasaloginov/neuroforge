import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { IGitOps } from '../../domain/ports/IGitOps.js';

/**
 * Git operations via CLI (execFile).
 */
export class GitCLIAdapter extends IGitOps {
  #logger;

  constructor({ logger } = {}) {
    super();
    this.#logger = logger || console;
  }

  /**
   * Ensure a git branch exists and is checked out.
   * If branch exists locally, checkout. Otherwise create it.
   * @param {string} branchName
   * @param {string} workDir
   */
  async ensureBranch(branchName, workDir) {
    const exists = await this.#branchExists(branchName, workDir);
    if (exists) {
      await this.#exec(['checkout', branchName], workDir);
      this.#logger.info('[GitCLIAdapter] Checked out existing branch: %s', branchName);
      try {
        await this.#exec(['pull', '--ff-only'], workDir);
        this.#logger.info('[GitCLIAdapter] Pulled latest commits for branch: %s', branchName);
      } catch (err) {
        this.#logger.warn('[GitCLIAdapter] git pull failed (ignored): %s', err.message);
      }
    } else {
      await this.#exec(['checkout', '-b', branchName], workDir);
      this.#logger.info('[GitCLIAdapter] Created and checked out branch: %s', branchName);
    }
  }

  /**
   * Sync all .claude/worktrees/agent-* to the given branch.
   * Errors per-worktree are logged and swallowed — best-effort.
   * @param {string} branchName
   * @param {string} workDir
   */
  async syncAllWorktrees(branchName, workDir) {
    const worktreesDir = join(workDir, '.claude', 'worktrees');
    let entries;
    try {
      entries = await readdir(worktreesDir, { withFileTypes: true });
    } catch {
      // No worktrees directory — nothing to sync
      return;
    }

    const agentDirs = entries
      .filter(e => e.isDirectory() && e.name.startsWith('agent-'))
      .map(e => join(worktreesDir, e.name));

    for (const wtPath of agentDirs) {
      try {
        // Worktrees share the local repo — no need to fetch origin.
        // Developer commits locally without pushing, so reset to local branch.
        await this.#exec(['checkout', branchName], wtPath);
        await this.#exec(['reset', '--hard', branchName], wtPath);
        this.#logger.info('[GitCLIAdapter] Synced worktree %s to branch %s', wtPath, branchName);
      } catch (err) {
        this.#logger.warn('[GitCLIAdapter] Failed to sync worktree %s: %s', wtPath, err.message);
      }
    }
  }

  /**
   * Merge a feature branch into main.
   * Checkout main, pull, merge --no-ff, push, delete feature branch.
   * @param {string} branchName
   * @param {string} workDir
   */
  async mergeBranch(branchName, workDir) {
    await this.#exec(['checkout', 'main'], workDir);
    try {
      await this.#exec(['pull', '--ff-only'], workDir);
    } catch (err) {
      this.#logger.warn('[GitCLIAdapter] git pull on main failed (ignored): %s', err.message);
    }
    await this.#exec(['merge', branchName, '--no-ff'], workDir);
    await this.#exec(['push'], workDir);
    try {
      await this.#exec(['branch', '-d', branchName], workDir);
      this.#logger.info('[GitCLIAdapter] Deleted branch: %s', branchName);
    } catch (err) {
      this.#logger.warn('[GitCLIAdapter] Failed to delete branch %s: %s', branchName, err.message);
    }
    this.#logger.info('[GitCLIAdapter] Merged %s into main', branchName);
  }

  /**
   * @param {string} branchName
   * @param {string} workDir
   * @returns {boolean}
   */
  async #branchExists(branchName, workDir) {
    try {
      await this.#exec(['rev-parse', '--verify', branchName], workDir);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @param {string[]} args
   * @param {string} cwd
   * @returns {Promise<string>}
   */
  #exec(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }
}
