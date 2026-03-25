/**
 * Resolve the effective working directory for a project.
 * Single source of truth for workDir resolution across all use cases.
 *
 * @param {object} params
 * @param {object} [params.projectRepo] - IProjectRepo instance
 * @param {string} [params.projectId] - project UUID
 * @param {object} [params.project] - already-loaded Project entity (skips DB lookup)
 * @param {string} [params.fallback] - global workDir fallback
 * @returns {Promise<string|null>}
 */
export async function resolveWorkDir({ projectRepo, projectId, project, fallback = null }) {
  if (project?.workDir) return project.workDir;

  if (projectRepo && projectId) {
    const p = await projectRepo.findById(projectId);
    if (p?.workDir) return p.workDir;
  }

  return fallback;
}

/**
 * Verify that a branch name prefix matches the project prefix.
 * Prevents cross-project contamination (e.g. BOT-19 code in NF repo).
 *
 * @param {string} branchName - e.g. "BOT-19/knowledge-graph-..."
 * @param {string} projectPrefix - e.g. "NF"
 * @throws {Error} if prefixes don't match
 */
export function assertBranchMatchesProject(branchName, projectPrefix) {
  if (!branchName || !projectPrefix) return;

  const match = branchName.match(/^([A-Z][A-Z0-9]*)-\d+\//);
  if (!match) return; // non-standard branch name, skip check

  const branchPrefix = match[1];
  if (branchPrefix !== projectPrefix) {
    throw new Error(
      `Branch prefix mismatch: branch "${branchName}" has prefix "${branchPrefix}", ` +
      `but project expects "${projectPrefix}". Aborting to prevent cross-project contamination.`
    );
  }
}
