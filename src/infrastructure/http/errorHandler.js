import { DomainError } from '../../domain/errors/DomainError.js';

const CODE_TO_STATUS = {
  VALIDATION_ERROR: 400,
  TASK_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  ROLE_NOT_FOUND: 500,
  RUN_TIMEOUT: 500,
  INVALID_STATE: 409,
  INVALID_TRANSITION: 409,
  REVISION_LIMIT: 409,
  DUPLICATE_PREFIX: 409,
};

export function errorHandler(error, request, reply) {
  // Fastify schema validation error
  if (error.validation) {
    return reply.code(400).send({
      error: 'Validation failed',
      details: error.validation,
    });
  }

  // Explicit statusCode (from scope/admin checks)
  if (error.statusCode && error.statusCode < 500) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  // Domain errors
  if (error instanceof DomainError) {
    const status = CODE_TO_STATUS[error.code] ?? 500;
    if (status >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Internal server error' });
    }
    return reply.code(status).send({ error: error.message });
  }

  // Unknown errors
  request.log.error(error);
  return reply.code(500).send({ error: 'Internal server error' });
}
