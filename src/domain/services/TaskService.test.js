import { TaskService } from './TaskService.js';
import { Task } from '../entities/Task.js';
import { TaskNotFoundError } from '../errors/TaskNotFoundError.js';
import { RevisionLimitError } from '../errors/RevisionLimitError.js';
import { InvalidTransitionError } from '../errors/InvalidTransitionError.js';

let seqCounters;

function makeMockRepo() {
  const store = new Map();
  seqCounters = {};
  return {
    findById: vi.fn(async (id) => store.get(id) ?? null),
    findByProjectId: vi.fn(async () => []),
    findByProjectIdAndSeq: vi.fn(async (projectId, seqNumber) => {
      for (const task of store.values()) {
        if (task.projectId === projectId && task.seqNumber === seqNumber) return task;
      }
      return null;
    }),
    save: vi.fn(async (task) => store.set(task.id, task)),
    saveWithSeqNumber: vi.fn(async (task) => {
      seqCounters[task.projectId] = (seqCounters[task.projectId] || 0) + 1;
      task.seqNumber = seqCounters[task.projectId];
      store.set(task.id, task);
      return task;
    }),
    delete: vi.fn(async (id) => store.delete(id)),
    _store: store,
  };
}

describe('TaskService', () => {
  let service, repo;

  beforeEach(() => {
    repo = makeMockRepo();
    service = new TaskService({ taskRepo: repo });
  });

  it('creates a task with pending status and assigns seqNumber', async () => {
    const task = await service.createTask({ projectId: 'p-1', title: 'Do stuff' });
    expect(task.status).toBe('pending');
    expect(task.seqNumber).toBe(1);
    expect(repo.saveWithSeqNumber).toHaveBeenCalledWith(task);
  });

  it('advances task to in_progress', async () => {
    const task = await service.createTask({ projectId: 'p-1', title: 'X' });
    const advanced = await service.advanceTask(task.id);
    expect(advanced.status).toBe('in_progress');
  });

  it('completes a task', async () => {
    const task = await service.createTask({ projectId: 'p-1', title: 'X' });
    await service.advanceTask(task.id);
    const done = await service.completeTask(task.id);
    expect(done.status).toBe('done');
  });

  it('fails a task', async () => {
    const task = await service.createTask({ projectId: 'p-1', title: 'X' });
    await service.advanceTask(task.id);
    const failed = await service.failTask(task.id);
    expect(failed.status).toBe('failed');
  });

  it('cancels a task', async () => {
    const task = await service.createTask({ projectId: 'p-1', title: 'X' });
    const cancelled = await service.cancelTask(task.id);
    expect(cancelled.status).toBe('cancelled');
  });

  it('handles waiting_reply flow', async () => {
    const task = await service.createTask({ projectId: 'p-1', title: 'X' });
    await service.advanceTask(task.id);
    await service.requestReply(task.id);
    expect(task.status).toBe('waiting_reply');
    await service.resumeAfterReply(task.id);
    expect(task.status).toBe('in_progress');
  });

  it('throws TaskNotFoundError for unknown id', async () => {
    await expect(service.advanceTask('unknown')).rejects.toThrow(TaskNotFoundError);
  });

  it('throws InvalidTransitionError for bad transition', async () => {
    const task = await service.createTask({ projectId: 'p-1', title: 'X' });
    await expect(service.completeTask(task.id)).rejects.toThrow(InvalidTransitionError);
  });

  it('throws RevisionLimitError after 3 revisions', async () => {
    const task = await service.createTask({ projectId: 'p-1', title: 'X' });
    for (let i = 0; i < 3; i++) {
      await service.incrementRevision(task.id);
    }
    await expect(service.incrementRevision(task.id)).rejects.toThrow(RevisionLimitError);
  });

  it('escalates a task to needs_escalation', async () => {
    const task = await service.createTask({ projectId: 'p-1', title: 'X' });
    await service.advanceTask(task.id);
    const escalated = await service.escalateTask(task.id);
    expect(escalated.status).toBe('needs_escalation');
  });

  describe('getTaskByShortId', () => {
    it('returns task by projectId and seqNumber', async () => {
      const task = await service.createTask({ projectId: 'p-1', title: 'Short ID task' });
      const found = await service.getTaskByShortId('p-1', task.seqNumber);
      expect(found.id).toBe(task.id);
    });

    it('throws TaskNotFoundError when not found', async () => {
      await expect(service.getTaskByShortId('p-1', 999)).rejects.toThrow(TaskNotFoundError);
    });
  });
});
