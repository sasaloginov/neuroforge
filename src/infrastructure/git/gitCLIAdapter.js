import { execFile } from 'node:child_process';
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
