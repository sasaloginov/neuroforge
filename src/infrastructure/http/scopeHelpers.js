/**
 * Assert that the API key's project scope allows access to the given projectId.
 * Keys without a projectId scope can access any project.
 */
export function assertProjectScope(apiKey, projectId) {
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    const err = new Error('Access denied: API key restricted to another project');
    err.statusCode = 403;
    throw err;
  }
}

/**
 * Assert that the user has admin role.
 */
export function assertAdmin(user) {
  if (user.role !== 'admin') {
    const err = new Error('Admin access required');
    err.statusCode = 403;
    throw err;
  }
}
