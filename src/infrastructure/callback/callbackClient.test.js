import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { CallbackClient } = await import('./callbackClient.js');

describe('CallbackClient', () => {
  let client;
  let logger;
  let originalFetch;

  beforeEach(() => {
    vi.useFakeTimers();

    originalFetch = globalThis.fetch;

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    client = new CallbackClient({
      logger,
      timeoutMs: 5000,
      maxRetries: 3,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends POST request with correct payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });

    const result = await client.send(
      'https://example.com/webhook',
      { type: 'task.progress', taskId: 'task-1', progress: 50 },
      { telegramChatId: 123 }
    );

    expect(result).toEqual({ ok: true, statusCode: 200, attempts: 1 });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'task.progress',
          taskId: 'task-1',
          progress: 50,
          callbackMeta: { telegramChatId: 123 },
        }),
      })
    );
  });

  it('sends payload without callbackMeta when not provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await client.send(
      'https://example.com/webhook',
      { type: 'task.done', taskId: 'task-2' }
    );

    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ type: 'task.done', taskId: 'task-2' });
    expect(body.callbackMeta).toBeUndefined();
  });

  it('retries on failure with exponential backoff', async () => {
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const promise = client.send(
      'https://example.com/webhook',
      { type: 'task.progress', taskId: 'task-1' }
    );

    // First attempt fails immediately, then waits 1s
    await vi.advanceTimersByTimeAsync(1000);
    // Second attempt fails, then waits 2s
    await vi.advanceTimersByTimeAsync(2000);
    // Third attempt succeeds

    const result = await promise;

    expect(result).toEqual({ ok: true, statusCode: 200, attempts: 3 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries on non-ok HTTP status', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const promise = client.send(
      'https://example.com/webhook',
      { type: 'task.done', taskId: 'task-3' }
    );

    // Wait for backoff after first failure
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;

    expect(result).toEqual({ ok: true, statusCode: 200, attempts: 2 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns failure result after all retries exhausted', async () => {
    globalThis.fetch = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockRejectedValueOnce(new Error('fail 3'));

    const promise = client.send(
      'https://example.com/webhook',
      { type: 'task.error', taskId: 'task-4' }
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    expect(result).toEqual({ ok: false, statusCode: undefined, attempts: 3 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not throw on callback failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const promise = client.send(
      'https://example.com/webhook',
      { type: 'task.done', taskId: 'task-5' }
    );

    // Advance through all retries
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    // Should NOT throw
    const result = await promise;
    expect(result.ok).toBe(false);
  });

  it('uses AbortController for timeout', async () => {
    let capturedSignal;
    globalThis.fetch = vi.fn().mockImplementation((_url, opts) => {
      capturedSignal = opts.signal;
      return Promise.resolve({ ok: true, status: 200 });
    });

    await client.send(
      'https://example.com/webhook',
      { type: 'task.done', taskId: 'task-6' }
    );

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });

  it('uses default config values', () => {
    const defaultClient = new CallbackClient();
    expect(defaultClient.timeoutMs).toBe(10000);
    expect(defaultClient.maxRetries).toBe(3);
  });

  it('returns last statusCode on exhausted retries with HTTP errors', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 502 });

    const promise = client.send(
      'https://example.com/webhook',
      { type: 'task.done', taskId: 'task-7' }
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(502);
    expect(result.attempts).toBe(3);
  });
});
