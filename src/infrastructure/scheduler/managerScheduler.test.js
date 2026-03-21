import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ManagerScheduler } from './managerScheduler.js';

function makeMocks() {
  return {
    worker: { processOne: vi.fn() },
    runRepo: { findRunning: vi.fn().mockResolvedValue([]) },
    runService: { interrupt: vi.fn().mockResolvedValue({}), timeout: vi.fn().mockResolvedValue({}) },
    roleRegistry: { get: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('ManagerScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('TC-S1: start() calls recover and sets interval', async () => {
    const mocks = makeMocks();
    const staleRuns = [
      { id: 'r1', roleName: 'analyst', startedAt: new Date() },
      { id: 'r2', roleName: 'developer', startedAt: new Date() },
    ];
    mocks.runRepo.findRunning.mockResolvedValue(staleRuns);

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 5000, maxConcurrent: 2, enabled: true },
    });

    await scheduler.start();

    expect(mocks.runService.interrupt).toHaveBeenCalledTimes(2);
    expect(mocks.runService.interrupt).toHaveBeenCalledWith('r1');
    expect(mocks.runService.interrupt).toHaveBeenCalledWith('r2');
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[Recovery]'),
      expect.any(Number),
    );

    await scheduler.stop();
  });

  it('TC-S2: start() with enabled=false does nothing', async () => {
    const mocks = makeMocks();
    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { enabled: false },
    });

    await scheduler.start();

    expect(mocks.runRepo.findRunning).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('Disabled'));
  });

  it('TC-S3: tick() launches worker slots', async () => {
    const mocks = makeMocks();
    // processOne returns true once, then false (queue drained)
    mocks.worker.processOne
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 2, enabled: true },
    });

    // Don't call start() to avoid recovery + interval; call tick() directly
    await scheduler.tick();

    // Let micro-tasks (the #runSlot promises) settle
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.worker.processOne).toHaveBeenCalled();
    // Eventually activeCount returns to 0
    expect(scheduler.activeCount).toBe(0);
  });

  it('TC-S4: checkTimeouts detects timed-out run', async () => {
    const mocks = makeMocks();
    const timedOutRun = {
      id: 'r1',
      roleName: 'analyst',
      startedAt: new Date(Date.now() - 600_000), // 10 min ago
    };
    mocks.runRepo.findRunning.mockResolvedValue([timedOutRun]);
    mocks.roleRegistry.get.mockReturnValue({ timeoutMs: 300_000 }); // 5 min timeout

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 1, enabled: true },
    });

    await scheduler.checkTimeouts();

    expect(mocks.runService.timeout).toHaveBeenCalledWith('r1');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Timeout]'),
      'r1',
      'analyst',
      expect.any(Number),
    );
  });

  it('TC-S5: checkTimeouts does not touch fresh run', async () => {
    const mocks = makeMocks();
    const freshRun = {
      id: 'r1',
      roleName: 'analyst',
      startedAt: new Date(Date.now() - 1000), // 1 sec ago
    };
    mocks.runRepo.findRunning.mockResolvedValue([freshRun]);
    mocks.roleRegistry.get.mockReturnValue({ timeoutMs: 300_000 });

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 1, enabled: true },
    });

    await scheduler.checkTimeouts();

    expect(mocks.runService.timeout).not.toHaveBeenCalled();
  });

  it('TC-S6: stop() waits for active slots to drain', async () => {
    const mocks = makeMocks();
    let resolveProcessOne;
    mocks.worker.processOne.mockImplementation(
      () => new Promise((resolve) => { resolveProcessOne = resolve; }),
    );

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 1, enabled: true },
    });

    // Start a tick to launch a slot — must await so checkTimeouts finishes and slots are launched
    const tickPromise = scheduler.tick();
    // Let the tick's checkTimeouts (async) resolve
    await vi.advanceTimersByTimeAsync(0);
    await tickPromise;

    expect(scheduler.activeCount).toBe(1);

    // Start stopping — should wait for active slot
    const stopPromise = scheduler.stop();

    // Let the polling timer fire
    await vi.advanceTimersByTimeAsync(200);

    // Resolve the worker — it returns false (empty queue), slot exits
    resolveProcessOne(false);
    await vi.advanceTimersByTimeAsync(200);

    await stopPromise;

    expect(scheduler.activeCount).toBe(0);
    expect(scheduler.stopping).toBe(true);
  });

  it('TC-S7: stop() force-stops after 30s deadline', async () => {
    const mocks = makeMocks();
    // processOne never resolves — simulates a stuck worker
    mocks.worker.processOne.mockImplementation(() => new Promise(() => {}));

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 1, enabled: true },
    });

    const tickPromise = scheduler.tick();
    await vi.advanceTimersByTimeAsync(0);
    await tickPromise;

    expect(scheduler.activeCount).toBe(1);

    const stopPromise = scheduler.stop();

    // Advance past the 30s deadline
    await vi.advanceTimersByTimeAsync(31_000);

    await stopPromise;

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Force stopped'),
      expect.any(Number),
    );
  });

  it('TC-S8: tick() does nothing when stopping', async () => {
    const mocks = makeMocks();
    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 2, enabled: true },
    });

    // Start and immediately stop
    await scheduler.stop();

    // Now tick should be a no-op
    await scheduler.tick();

    expect(mocks.worker.processOne).not.toHaveBeenCalled();
    expect(mocks.runRepo.findRunning).not.toHaveBeenCalled();
  });

  it('TC-S9: tick() logs error when checkTimeouts throws', async () => {
    const mocks = makeMocks();
    mocks.runRepo.findRunning.mockRejectedValue(new Error('db gone'));
    mocks.worker.processOne.mockResolvedValue(false);

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 1, enabled: true },
    });

    await scheduler.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('checkTimeouts error'),
      'db gone',
    );
    // Slots still launched despite checkTimeouts failure
    expect(mocks.worker.processOne).toHaveBeenCalled();
  });

  it('TC-S10: #runSlot catches error from processOne and decrements activeCount', async () => {
    const mocks = makeMocks();
    mocks.worker.processOne.mockRejectedValue(new Error('unexpected crash'));

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 1, enabled: true },
    });

    await scheduler.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Slot error'),
      'unexpected crash',
    );
    expect(scheduler.activeCount).toBe(0);
  });

  it('TC-S11: checkTimeouts logs warning when timeout() throws', async () => {
    const mocks = makeMocks();
    const timedOutRun = {
      id: 'r1',
      roleName: 'analyst',
      startedAt: new Date(Date.now() - 600_000),
    };
    mocks.runRepo.findRunning.mockResolvedValue([timedOutRun]);
    mocks.roleRegistry.get.mockReturnValue({ timeoutMs: 300_000 });
    mocks.runService.timeout.mockRejectedValue(new Error('InvalidTransitionError'));

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 1, enabled: true },
    });

    await scheduler.checkTimeouts();

    expect(mocks.runService.timeout).toHaveBeenCalledWith('r1');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not timeout'),
      'r1',
      'InvalidTransitionError',
    );
  });

  it('TC-S12: recovery with no running runs skips info log', async () => {
    const mocks = makeMocks();
    mocks.runRepo.findRunning.mockResolvedValue([]);

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 5000, maxConcurrent: 1, enabled: true },
    });

    await scheduler.start();

    expect(mocks.runService.interrupt).not.toHaveBeenCalled();
    // The "[Recovery] Interrupted N stale runs" log should NOT appear
    expect(mocks.logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('[Recovery]'),
      expect.any(Number),
    );
    // But "[Scheduler] Started" should appear
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Started'),
      5000,
      1,
    );

    await scheduler.stop();
  });

  it('TC-S13: tick() respects maxConcurrent slots', async () => {
    const mocks = makeMocks();
    const resolvers = [];
    mocks.worker.processOne.mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
    );

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 3, enabled: true },
    });

    await scheduler.tick();

    // Should have launched exactly 3 slots
    expect(scheduler.activeCount).toBe(3);
    expect(resolvers).toHaveLength(3);

    // Resolve all
    for (const r of resolvers) r(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.activeCount).toBe(0);
  });

  it('TC-S14: constructor uses default config values', async () => {
    const mocks = makeMocks();
    // No config passed — defaults should apply
    const scheduler = new ManagerScheduler({
      ...mocks,
    });

    // enabled=true by default, so start() should call recover
    await scheduler.start();
    expect(mocks.runRepo.findRunning).toHaveBeenCalled();

    await scheduler.stop();
  });

  it('TC-S4b: checkTimeouts skips unknown role', async () => {
    const mocks = makeMocks();
    const run = {
      id: 'r1',
      roleName: 'unknown-role',
      startedAt: new Date(Date.now() - 600_000),
    };
    mocks.runRepo.findRunning.mockResolvedValue([run]);
    mocks.roleRegistry.get.mockImplementation(() => { throw new Error('not found'); });

    const scheduler = new ManagerScheduler({
      ...mocks,
      config: { intervalMs: 60000, maxConcurrent: 1, enabled: true },
    });

    await scheduler.checkTimeouts();

    expect(mocks.runService.timeout).not.toHaveBeenCalled();
  });
});
