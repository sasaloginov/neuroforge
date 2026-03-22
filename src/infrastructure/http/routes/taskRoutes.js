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
        shortId: { type: 'string' },
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
      id: { type: 'string' },
    },
  },
};

const replySchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
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
        shortId: { type: 'string' },
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
      id: { type: 'string' },
      runId: { type: 'string', format: 'uuid' },
    },
  },
};

const restartSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        shortId: { type: 'string' },
        status: { type: 'string' },
        decision: { type: 'object' },
      },
    },
  },
};

const cancelSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        shortId: { type: 'string' },
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
      // Resolve task (supports UUID and PREFIX-N) via getTaskStatus
      const status = await useCases.getTaskStatus.execute({ taskId: request.params.id });
      assertProjectScope(request.apiKey, status.task.projectId);

      const result = await useCases.getRunDetail.execute({
        taskId: status.task.id,
        runId: request.params.runId,
      });
      return reply.send({ run: result.run });
    });

    fastify.post('/tasks/:id/reply', { schema: replySchema }, async (request, reply) => {
      const status = await useCases.getTaskStatus.execute({ taskId: request.params.id });
      assertProjectScope(request.apiKey, status.task.projectId);

      const result = await useCases.replyToQuestion.execute({
        taskId: status.task.id,
        questionId: request.body.questionId,
        answer: request.body.answer,
      });
      return reply.send(result);
    });

    fastify.post('/tasks/:id/restart', { schema: restartSchema }, async (request, reply) => {
      const status = await useCases.getTaskStatus.execute({ taskId: request.params.id });
      assertProjectScope(request.apiKey, status.task.projectId);

      const result = await useCases.restartTask.execute({ taskId: status.task.id });
      return reply.send(result);
    });

    fastify.post('/tasks/:id/cancel', { schema: cancelSchema }, async (request, reply) => {
      const status = await useCases.getTaskStatus.execute({ taskId: request.params.id });
      assertProjectScope(request.apiKey, status.task.projectId);

      const result = await useCases.cancelTask.execute({ taskId: status.task.id });
      return reply.send(result);
    });
  };
}
