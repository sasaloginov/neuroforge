import { ProjectNotFoundError } from '../domain/errors/ProjectNotFoundError.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^([A-Z][A-Z0-9]{0,9})-(\d+)$/i;

/**
 * Parse a task identifier — either a UUID or a short id (PREFIX-N).
 * @returns {{ uuid: string } | { prefix: string, seqNumber: number }}
 */
function parseTaskRef(ref) {
  if (UUID_RE.test(ref)) {
    return { uuid: ref };
  }
  const m = SHORT_ID_RE.exec(ref);
  if (m) {
    return { prefix: m[1].toUpperCase(), seqNumber: parseInt(m[2], 10) };
  }
  // Fallback: treat as UUID and let downstream error naturally
  return { uuid: ref };
}

export class GetTaskStatus {
  #taskService;
  #runRepo;
  #projectRepo;

  constructor({ taskService, runRepo, projectRepo }) {
    this.#taskService = taskService;
    this.#runRepo = runRepo;
    this.#projectRepo = projectRepo;
  }

  /**
   * @param {{ taskId: string }} params — taskId can be a UUID or "PREFIX-N" short id
   */
  async execute({ taskId }) {
    const parsed = parseTaskRef(taskId);

    let task;
    let project;

    if (parsed.uuid) {
      task = await this.#taskService.getTask(parsed.uuid);
      project = await this.#projectRepo.findById(task.projectId);
    } else {
      project = await this.#projectRepo.findByPrefix(parsed.prefix);
      if (!project) throw new ProjectNotFoundError(parsed.prefix);
      task = await this.#taskService.getTaskByShortId(project.id, parsed.seqNumber);
    }

    const shortId = project && task.seqNumber != null
      ? `${project.prefix}-${task.seqNumber}`
      : undefined;

    const runs = await this.#runRepo.findByTaskId(task.id);

    return {
      task: {
        id: task.id,
        shortId,
        projectId: task.projectId,
        title: task.title,
        status: task.status,
        revisionCount: task.revisionCount,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      },
      runs: runs.map(r => ({
        id: r.id,
        roleName: r.roleName,
        status: r.status,
        response: r.response,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
      })),
    };
  }
}
