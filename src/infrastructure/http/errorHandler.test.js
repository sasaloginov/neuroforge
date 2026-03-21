import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from './errorHandler.js';
import { ValidationError } from '../../domain/errors/ValidationError.js';
import { TaskNotFoundError } from '../../domain/errors/TaskNotFoundError.js';
import { InvalidStateError } from '../../domain/errors/InvalidStateError.js';
import { InvalidTransitionError } from '../../domain/errors/InvalidTransitionError.js';
import { ProjectNotFoundError } from '../../domain/errors/ProjectNotFoundError.js';
import { RevisionLimitError } from '../../domain/errors/RevisionLimitError.js';

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

describe('errorHandler', () => {
  it('maps ValidationError to 400', () => {
    const { reply, request } = createMocks();
    errorHandler(new ValidationError('bad input'), request, reply);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: 'bad input' });
  });

  it('maps TaskNotFoundError to 404', () => {
    const { reply, request } = createMocks();
    errorHandler(new TaskNotFoundError('abc'), request, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it('maps ProjectNotFoundError to 404', () => {
    const { reply, request } = createMocks();
    errorHandler(new ProjectNotFoundError('abc'), request, reply);
    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it('maps InvalidStateError to 409', () => {
    const { reply, request } = createMocks();
    errorHandler(new InvalidStateError('wrong state'), request, reply);
    expect(reply.code).toHaveBeenCalledWith(409);
  });

  it('maps InvalidTransitionError to 409', () => {
    const { reply, request } = createMocks();
    errorHandler(new InvalidTransitionError('pending', 'done'), request, reply);
    expect(reply.code).toHaveBeenCalledWith(409);
  });

  it('maps RevisionLimitError to 409', () => {
    const { reply, request } = createMocks();
    errorHandler(new RevisionLimitError('abc', 3), request, reply);
    expect(reply.code).toHaveBeenCalledWith(409);
  });

  it('maps Fastify validation error to 400', () => {
    const { reply, request } = createMocks();
    const err = new Error('validation');
    err.validation = [{ message: 'required' }];
    errorHandler(err, request, reply);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Validation failed',
      details: err.validation,
    });
  });

  it('maps errors with statusCode < 500 to that status', () => {
    const { reply, request } = createMocks();
    const err = new Error('Forbidden');
    err.statusCode = 403;
    errorHandler(err, request, reply);
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Forbidden' });
  });

  it('maps unknown errors to 500', () => {
    const { reply, request } = createMocks();
    errorHandler(new Error('crash'), request, reply);
    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(request.log.error).toHaveBeenCalled();
  });
});
