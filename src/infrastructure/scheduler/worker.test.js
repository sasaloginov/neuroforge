import { describe, it, expect, vi } from 'vitest';
import { createWorker } from './worker.js';

function makeMocks() {
  return {
    processRun: { execute: vi.fn() },
    managerDecision: { execute: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('Worker', () => {
  it('TC-W1: processes run and calls ManagerDecision', async () => {
    const mocks = makeMocks();
    mocks.processRun.execute.mockResolvedValue({
      run: { id: 'r1', taskId: 't1' },
      result: { response: 'ok' },
    });
    mocks.managerDecision.execute.mockResolvedValue({ action: 'complete_task' });

    const worker = createWorker(mocks);
    const processed = await worker.processOne();

    expect(processed).toBe(true);
    expect(mocks.processRun.execute).toHaveBeenCalledOnce();
    expect(mocks.managerDecision.execute).toHaveBeenCalledWith({ completedRunId: 'r1' });
  });

  it('TC-W2: returns false when queue is empty', async () => {
    const mocks = makeMocks();
    mocks.processRun.execute.mockResolvedValue(null);

    const worker = createWorker(mocks);
    const processed = await worker.processOne();

    expect(processed).toBe(false);
    expect(mocks.managerDecision.execute).not.toHaveBeenCalled();
  });

  it('TC-W3: skips ManagerDecision when run has no taskId', async () => {
    const mocks = makeMocks();
    mocks.processRun.execute.mockResolvedValue({
      run: { id: 'r2', taskId: null },
      result: { response: 'ok' },
    });

    const worker = createWorker(mocks);
    const processed = await worker.processOne();

    expect(processed).toBe(true);
    expect(mocks.managerDecision.execute).not.toHaveBeenCalled();
  });

  it('TC-W4: catches ManagerDecision error and returns true', async () => {
    const mocks = makeMocks();
    mocks.processRun.execute.mockResolvedValue({
      run: { id: 'r3', taskId: 't1' },
      result: {},
    });
    mocks.managerDecision.execute.mockRejectedValue(new Error('decision boom'));

    const worker = createWorker(mocks);
    const processed = await worker.processOne();

    expect(processed).toBe(true);
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it('TC-W5: catches ProcessRun error and returns false', async () => {
    const mocks = makeMocks();
    mocks.processRun.execute.mockRejectedValue(new Error('process boom'));

    const worker = createWorker(mocks);
    const processed = await worker.processOne();

    expect(processed).toBe(false);
    expect(mocks.logger.error).toHaveBeenCalled();
    expect(mocks.managerDecision.execute).not.toHaveBeenCalled();
  });
});
