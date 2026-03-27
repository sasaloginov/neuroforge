import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn before importing the adapter
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args) => mockSpawn(...args),
}));

const { ClaudeCLIAdapter } = await import('./claudeCLIAdapter.js');

import { RoleRegistry } from '../../domain/services/RoleRegistry.js';
import { Role } from '../../domain/valueObjects/Role.js';

/**
 * Create a fake child process (EventEmitter with stdin/stdout/stderr).
 */
function createFakeProc() {
  const proc = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

/**
 * Wraps RoleRegistry to satisfy IRoleResolver interface (async resolve()).
 */
function wrapAsResolver(registry) {
  return {
    resolve: async (roleName, _projectWorkDir = null) => registry.get(roleName),
  };
}

/** Flush microtask queue (needed because resolve() is async with fake timers). */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('ClaudeCLIAdapter', () => {
  let registry;
  let adapter;
  let logger;

  beforeEach(() => {
    vi.useFakeTimers();

    registry = new RoleRegistry();
    registry.register(new Role({
      name: 'developer',
      model: 'sonnet',
      timeoutMs: 60000,
      allowedTools: ['Read', 'Write', 'Bash'],
      systemPrompt: 'You are a developer agent.',
    }));
    registry.register(new Role({
      name: 'analyst',
      model: 'opus',
      timeoutMs: 120000,
      allowedTools: [],
      systemPrompt: '',
    }));

    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    adapter = new ClaudeCLIAdapter({
      roleRegistry: wrapAsResolver(registry),
      workDir: '/tmp/test-workdir',
      logger,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('builds correct CLI args from role config', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'implement feature X');
    await flush();

    // Simulate successful JSON response
    const jsonResponse = JSON.stringify({
      result: 'Done implementing feature X',
      session_id: 'sess-123',
    });
    proc.stdout.emit('data', Buffer.from(jsonResponse));
    proc.emit('close', 0);

    const result = await promise;

    // Verify spawn was called with correct args
    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '--print',
        '--output-format', 'json',
        '--model', 'sonnet',
        '--system-prompt', 'You are a developer agent.',
        '--allowed-tools', 'Read,Write,Bash',
      ]),
      expect.objectContaining({
        cwd: '/tmp/test-workdir',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );

    // Verify prompt was written to stdin
    expect(proc.stdin.write).toHaveBeenCalledWith('implement feature X');
    expect(proc.stdin.end).toHaveBeenCalled();

    // Verify result
    expect(result.response).toBe('Done implementing feature X');
    expect(result.sessionId).toBe('sess-123');
  });

  it('adds --resume with sessionId when sessionId is provided', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'continue', {
      sessionId: 'existing-session',
    });
    await flush();

    const jsonResponse = JSON.stringify({
      result: 'Continued',
      session_id: 'existing-session',
    });
    proc.stdout.emit('data', Buffer.from(jsonResponse));
    proc.emit('close', 0);

    await promise;

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--resume');
    expect(args).toContain('existing-session');
    const resumeIdx = args.indexOf('--resume');
    expect(args[resumeIdx + 1]).toBe('existing-session');
  });

  it('does not add --resume without sessionId', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'hello');
    await flush();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'Hi', session_id: 's1' })));
    proc.emit('close', 0);

    await promise;

    const args = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain('--resume');
  });

  it('skips --system-prompt and --allowed-tools when empty', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('analyst', 'analyze this');
    await flush();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'Analysis done', session_id: 's2' })));
    proc.emit('close', 0);

    await promise;

    const args = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain('--system-prompt');
    expect(args).not.toContain('--allowed-tools');
    expect(args).toContain('--model');
    expect(args).toContain('opus');
  });

  it('handles timeout with SIGTERM then SIGKILL', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'slow task');

    // Advance past the soft timeout (60000ms from role)
    await vi.advanceTimersByTimeAsync(60001);

    // SIGTERM should have been sent
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Advance past the hard timeout (5s after soft) WITHOUT closing the process
    // so the SIGKILL guard (!done) passes
    await vi.advanceTimersByTimeAsync(5000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');

    // Now simulate the process closing after being killed
    proc.emit('close', null);

    await expect(promise).rejects.toThrow('Claude CLI timeout after 60 seconds');
  });

  it('respects options.timeoutMs override', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'fast task', { timeoutMs: 5000 });

    await vi.advanceTimersByTimeAsync(5001);
    proc.emit('close', null);

    await expect(promise).rejects.toThrow('Claude CLI timeout after 5 seconds');
  });

  it('handles AbortSignal cancellation', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    const promise = adapter.runPrompt('developer', 'abortable task', {
      signal: controller.signal,
    });
    await flush();

    controller.abort();

    await expect(promise).rejects.toThrow('Aborted');
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects immediately if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.runPrompt('developer', 'too late', { signal: controller.signal })
    ).rejects.toThrow('Aborted');

    // spawn should not have been called
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('parses JSON output correctly', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'test');
    await flush();

    proc.stdout.emit('data', Buffer.from('{"result":"hello world"'));
    proc.stdout.emit('data', Buffer.from(',"session_id":"abc-123"}'));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.response).toBe('hello world');
    expect(result.sessionId).toBe('abc-123');
  });

  it('rejects on non-zero exit code', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'bad');
    await flush();

    proc.stderr.emit('data', Buffer.from('something went wrong'));
    proc.emit('close', 1);

    await expect(promise).rejects.toThrow('Claude CLI exited with code 1: something went wrong');
  });

  it('rejects on is_error in JSON response', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'error');
    await flush();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({
      is_error: true,
      result: 'rate limited',
    })));
    proc.emit('close', 0);

    await expect(promise).rejects.toThrow('Claude CLI error: rate limited');
  });

  it('rejects on empty response', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'empty');
    await flush();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: '', session_id: 's1' })));
    proc.emit('close', 0);

    await expect(promise).rejects.toThrow('Claude CLI returned empty response');
  });

  it('falls back to raw output on JSON parse failure', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'raw');
    await flush();

    proc.stdout.emit('data', Buffer.from('plain text response'));
    proc.emit('close', 0);

    const result = await promise;
    expect(result.response).toBe('plain text response');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('JSON parse failed'),
      expect.any(String)
    );
  });

  it('rejects on spawn error', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'test');
    await flush();

    proc.emit('error', new Error('ENOENT'));

    await expect(promise).rejects.toThrow('Failed to spawn claude CLI: ENOENT');
  });

  it('throws RoleNotFoundError for unknown role', async () => {
    await expect(
      adapter.runPrompt('nonexistent', 'test')
    ).rejects.toThrow('Role not found: nonexistent');
  });

  it('adds --mcp-config when mcpConfigPath set and runId+taskId provided', async () => {
    const adapterWithMcp = new ClaudeCLIAdapter({
      roleRegistry: wrapAsResolver(registry),
      workDir: '/tmp/test-workdir',
      logger,
      mcpConfigPath: '/tmp/neuroforge-mcp/mcp-config.json',
    });

    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapterWithMcp.runPrompt('developer', 'do work', {
      runId: 'run-42',
      taskId: 'task-99',
    });
    await flush();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok', session_id: 's1' })));
    proc.emit('close', 0);

    await promise;

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/neuroforge-mcp/mcp-config.json');
  });

  it('does not add --mcp-config without mcpConfigPath', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'do work', {
      runId: 'run-42',
      taskId: 'task-99',
    });
    await flush();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok', session_id: 's1' })));
    proc.emit('close', 0);

    await promise;

    const args = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain('--mcp-config');
  });

  it('does not add --mcp-config without runId/taskId', async () => {
    const adapterWithMcp = new ClaudeCLIAdapter({
      roleRegistry: wrapAsResolver(registry),
      workDir: '/tmp/test-workdir',
      logger,
      mcpConfigPath: '/tmp/neuroforge-mcp/mcp-config.json',
    });

    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapterWithMcp.runPrompt('developer', 'no run context');
    await flush();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok', session_id: 's1' })));
    proc.emit('close', 0);

    await promise;

    const args = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain('--mcp-config');
  });

  it('uses spawn without shell option (security)', async () => {
    const proc = createFakeProc();
    mockSpawn.mockReturnValue(proc);

    const promise = adapter.runPrompt('developer', 'test');
    await flush();

    proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'ok', session_id: 's1' })));
    proc.emit('close', 0);

    await promise;

    const spawnOptions = mockSpawn.mock.calls[0][2];
    expect(spawnOptions.shell).toBeUndefined();
  });
});
