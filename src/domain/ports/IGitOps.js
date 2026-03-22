/**
 * Port for Git operations.
 *
 * @interface IGitOps
 * @method ensureBranch(branchName, workDir) — checkout or create branch
 */
export class IGitOps {
  async ensureBranch(_branchName, _workDir) { throw new Error('Not implemented'); }
}
