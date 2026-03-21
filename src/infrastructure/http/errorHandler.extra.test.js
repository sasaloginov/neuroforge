import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from './errorHandler.js';
import { RoleNotFoundError } from '../../domain/errors/RoleNotFoundError.js';
import { RunNotFoundError } from '../../domain/errors/RunNotFoundError.js';
import { TaskNotFoundError } from '../../domain/errors/TaskNotFoundError.js';

function createMocks() {
  const reply = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  const request = {
    log: { error: vi.fn() },
  };
  return { reply, request };
}

describe('errorHandler — additional coverage', () => {
  it('maps RoleNotFoundError to 500 (internal, logged)', () => {
    const { reply, request } = createMocks();
    errorHandler(new RoleNotFoundError('unknown-role'), request, reply);
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(request.log.error).toHaveBeenCalled();
  });

  it('maps RunNotFoundError to 404', () => {
    const { reply, request } = createMocks();
    errorHandler(new RunNotFoundError('abc'), request, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it('does not log for non-500 domain errors', () => {
    const { reply, request } = createMocks();
    errorHandler(new TaskNotFoundError('abc'), request, reply);
    expect(request.log.error).not.toHaveBeenCalled();
  });

  it('handles error with statusCode exactly 500 as unknown', () => {
    const { reply, request } = createMocks();
    const err = new Error('Server broke');
    err.statusCode = 500;
    errorHandler(err, request, reply);
    // statusCode >= 500 falls through to unknown error handler
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(request.log.error).toHaveBeenCalled();
  });
});
