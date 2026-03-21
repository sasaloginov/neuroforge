import { describe, it, expect, vi } from 'vitest';
import { DatabaseHealthChecker, SchedulerHealthChecker } from './healthCheckers.js';

describe('DatabaseHealthChecker', () => {
  it('returns ok when SELECT 1 succeeds', async () => {
    const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    const checker = new DatabaseHealthChecker({ pool });
    const result = await checker.check();

    expect(result.status).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(client.release).toHaveBeenCalled();
  });

  it('returns error when query fails', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    const checker = new DatabaseHealthChecker({ pool });
    const result = await checker.check();

    expect(result.status).toBe('error');
    expect(result.error).toBe('connection refused');
    expect(typeof result.latencyMs).toBe('number');
    expect(client.release).toHaveBeenCalled();
  });

  it('returns error when connect fails', async () => {
    const pool = { connect: vi.fn().mockRejectedValue(new Error('pool exhausted')) };

    const checker = new DatabaseHealthChecker({ pool });
    const result = await checker.check();

    expect(result.status).toBe('error');
    expect(result.error).toBe('pool exhausted');
  });

  it('passes timeout to query', async () => {
    const client = { query: vi.fn().mockResolvedValue({}), release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    const checker = new DatabaseHealthChecker({ pool, timeoutMs: 5000 });
    await checker.check();

    expect(client.query).toHaveBeenCalledWith({ text: 'SELECT 1', timeout: 5000 });
  });
});

describe('SchedulerHealthChecker', () => {
  it('returns ok when scheduler is running', () => {
    const scheduler = { stopping: false, activeCount: 2 };
    const checker = new SchedulerHealthChecker({ scheduler });
    const result = checker.check();

    expect(result.status).toBe('ok');
    expect(result.activeWorkers).toBe(2);
  });

  it('returns error when scheduler is stopping', () => {
    const scheduler = { stopping: true, activeCount: 1 };
    const checker = new SchedulerHealthChecker({ scheduler });
    const result = checker.check();

    expect(result.status).toBe('error');
    expect(result.activeWorkers).toBe(1);
  });

  it('returns ok with zero active workers', () => {
    const scheduler = { stopping: false, activeCount: 0 };
    const checker = new SchedulerHealthChecker({ scheduler });
    const result = checker.check();

    expect(result.status).toBe('ok');
    expect(result.activeWorkers).toBe(0);
  });
});
