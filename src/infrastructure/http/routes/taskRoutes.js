import { assertProjectScope } from '../scopeHelpers.js';

const createTaskSchema = {
  body: {
    type: 'object',
    required: ['projectId', 'title'],
    properties: {
      projectId: { type: 'string', format: 'uuid' },
      title: { type: 'string', minLength: 1, maxLength: 255 },
      description: { type: 'string', maxLength: 10000 },
      callbackUrl: { type: 'string', format: 'uri', maxLength: 512 },
      callbackMeta: { type: 'object' },
    },
    additionalProperties: false,
  },
  response: {
    202: {
      type: 'object',
      properties: {
        taskId: { type: 'string', format: 'uuid' },
        status: { type: 'string' },
      },
    },
  },
};

const getTaskSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
};

const replySchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['answer'],
    properties: {
      questionId: { type: 'string', format: 'uuid' },
      answer: { type: 'string', minLength: 1, maxLength: 10000 },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string' },
      },
    },
  },
};

const getRunSchema = {
  params: {
    type: 'object',
    required: ['id', 'runId'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      runId: { type: 'string', format: 'uuid' },
    },
  },
};

const cancelSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        status: { type: 'string' },
        cancelledRuns: { type: 'integer' },
      },
    },
  },
};

export function taskRoutes({ useCases }) {
  return async function (fastify) {
    fastify.post('/tasks', { schema: createTaskSchema }, async (request, reply) => {
      assertProjectScope(request.apiKey, request.body.projectId);
      const result = await useCases.createTask.execute(request.body);
      return reply.code(202).send(result);
    });

    fastify.get('/tasks/:id', { schema: getTaskSchema }, async (request, reply) => {
      const result = await useCases.getTaskStatus.execute({ taskId: request.params.id });
      assertProjectScope(request.apiKey, result.task.projectId);
      return reply.send(result);
    });

    fastify.get('/tasks/:id/runs/:runId', { schema: getRunSchema }, async (request, reply) => {
      const result = await useCases.getRunDetail.execute({
        taskId: request.params.id,
        runId: request.params.runId,
      });
      assertProjectScope(request.apiKey, result.task.projectId);
      return reply.send({ run: result.run });
    });

    fastify.post('/tasks/:id/reply', { schema: replySchema }, async (request, reply) => {
      // Scope check: load task first via getTaskStatus
      const status = await useCases.getTaskStatus.execute({ taskId: request.params.id });
      assertProjectScope(request.apiKey, status.task.projectId);

      const result = await useCases.replyToQuestion.execute({
        taskId: request.params.id,
        questionId: request.body.questionId,
        answer: request.body.answer,
      });
      return reply.send(result);
    });

    fastify.post('/tasks/:id/cancel', { schema: cancelSchema }, async (request, reply) => {
      // Scope check: load task first via getTaskStatus
      const status = await useCases.getTaskStatus.execute({ taskId: request.params.id });
      assertProjectScope(request.apiKey, status.task.projectId);

      const result = await useCases.cancelTask.execute({ taskId: request.params.id });
      return reply.send(result);
    });
  };
}
