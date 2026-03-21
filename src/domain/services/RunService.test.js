import { RunService } from './RunService.js';
import { Run } from '../entities/Run.js';
import { RunNotFoundError } from '../errors/RunNotFoundError.js';

function makeMockRepo() {
  const store = new Map();
  return {
    findById: vi.fn(async (id) => store.get(id) ?? null),
    findByTaskId: vi.fn(async () => []),
    findRunning: vi.fn(async () => []),
    save: vi.fn(async (run) => store.set(run.id, run)),
    takeNext: vi.fn(async () => null),
    _store: store,
  };
}

describe('RunService', () => {
  let service, repo;

  beforeEach(() => {
    repo = makeMockRepo();
    service = new RunService({ runRepo: repo });
  });

  it('enqueues a run with queued status', async () => {
    const run = await service.enqueue({ taskId: 't-1', stepId: 's-1', roleName: 'developer', prompt: 'build it' });
    expect(run.status).toBe('queued');
    expect(repo.save).toHaveBeenCalledWith(run);
  });

  it('starts a run', async () => {
    const run = await service.enqueue({ taskId: 't-1', stepId: 's-1', roleName: 'dev', prompt: 'go' });
    const started = await service.start(run.id, 'session-1');
    expect(started.status).toBe('running');
    expect(started.sessionId).toBe('session-1');
  });

  it('completes a run', async () => {
    const run = await service.enqueue({ taskId: 't-1', stepId: 's-1', roleName: 'dev', prompt: 'go' });
    await service.start(run.id, 's-1');
    const done = await service.complete(run.id, 'result');
    expect(done.status).toBe('done');
    expect(done.response).toBe('result');
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails a run', async () => {
    const run = await service.enqueue({ taskId: 't-1', stepId: 's-1', roleName: 'dev', prompt: 'go' });
    await service.start(run.id, 's-1');
    const failed = await service.fail(run.id, 'crash');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('crash');
  });

  it('times out a run', async () => {
    const run = await service.enqueue({ taskId: 't-1', stepId: 's-1', roleName: 'dev', prompt: 'go' });
    await service.start(run.id, 's-1');
    const timedOut = await service.timeout(run.id);
    expect(timedOut.status).toBe('timeout');
  });

  it('interrupts a run', async () => {
    const run = await service.enqueue({ taskId: 't-1', stepId: 's-1', roleName: 'dev', prompt: 'go' });
    await service.start(run.id, 's-1');
    const interrupted = await service.interrupt(run.id);
    expect(interrupted.status).toBe('interrupted');
  });

  it('throws RunNotFoundError for unknown id', async () => {
    await expect(service.start('unknown', 's-1')).rejects.toThrow(RunNotFoundError);
  });
});
