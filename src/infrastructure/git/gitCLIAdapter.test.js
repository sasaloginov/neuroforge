import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

const { GitCLIAdapter } = await import('./gitCLIAdapter.js');

describe('GitCLIAdapter', () => {
  let adapter;
  let logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    adapter = new GitCLIAdapter({ logger });
  });

  it('checks out existing branch when rev-parse succeeds', async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      cb(null, '', '');
    });

    await adapter.ensureBranch('NF-1/feature', '/tmp/repo');

    // First call: rev-parse --verify
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--verify', 'NF-1/feature'],
      { cwd: '/tmp/repo' },
      expect.any(Function),
    );
    // Second call: checkout (not -b)
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['checkout', 'NF-1/feature'],
      { cwd: '/tmp/repo' },
      expect.any(Function),
    );
  });

  it('creates new branch when rev-parse fails', async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      callCount++;
      if (callCount === 1) {
        // rev-parse fails
        cb(new Error('fatal: not a valid ref'), '', 'fatal: not a valid ref');
      } else {
        cb(null, '', '');
      }
    });

    await adapter.ensureBranch('NF-2/new-feature', '/tmp/repo');

    // Second call: checkout -b
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['checkout', '-b', 'NF-2/new-feature'],
      { cwd: '/tmp/repo' },
      expect.any(Function),
    );
  });

  it('rejects when checkout fails', async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      if (args.includes('rev-parse')) {
        cb(null, '', '');
      } else {
        cb(new Error('checkout failed'), '', 'error');
      }
    });

    await expect(adapter.ensureBranch('NF-3/bad', '/tmp/repo')).rejects.toThrow('git checkout NF-3/bad failed');
  });
});
