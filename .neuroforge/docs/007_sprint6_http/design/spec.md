# Sprint 6 — HTTP API + Auth: Design Specification

## 1. Обзор

HTTP-слой Нейроцеха: Fastify-сервер, Bearer-авторизация через SHA-256 хеш API-ключей, REST endpoints для задач/проектов/админки, JSON Schema валидация, CLI для bootstrap первого admin.

---

## 2. Sequence Diagram: Auth Flow

```
Client                    Fastify                  authMiddleware              PgApiKeyRepo       PgUserRepo
  │                         │                          │                          │                  │
  │  GET /tasks/:id         │                          │                          │                  │
  │  Authorization: Bearer <token>                     │                          │                  │
  │─────────────────────────>│                          │                          │                  │
  │                         │  onRequest hook           │                          │                  │
  │                         │─────────────────────────> │                          │                  │
  │                         │                          │  1. Extract token         │                  │
  │                         │                          │     from "Bearer <token>" │                  │
  │                         │                          │                          │                  │
  │                         │                          │  2. SHA-256(token)        │                  │
  │                         │                          │     → keyHash             │                  │
  │                         │                          │                          │                  │
  │                         │                          │  3. findByHash(keyHash)   │                  │
  │                         │                          │─────────────────────────> │                  │
  │                         │                          │  <── ApiKey | null        │                  │
  │                         │                          │                          │                  │
  │                         │                          │  4. if null → 401         │                  │
  │                         │                          │                          │                  │
  │                         │                          │  5. if expired → 401      │                  │
  │                         │                          │                          │                  │
  │                         │                          │  6. findById(apiKey.userId)│                 │
  │                         │                          │──────────────────────────────────────────────>│
  │                         │                          │  <── User                 │                  │
  │                         │                          │                          │                  │
  │                         │                          │  7. Attach to request:    │                  │
  │                         │                          │     req.user = User       │                  │
  │                         │                          │     req.apiKey = ApiKey    │                  │
  │                         │                          │                          │                  │
  │                         │  <── next()               │                          │                  │
  │                         │                          │                          │                  │
  │                         │  Route handler            │                          │                  │
  │                         │  (scope check if needed)  │                          │                  │
  │  <── 200 { ... }        │                          │                          │                  │
```

### Scope Check (выполняется в route handler / middleware)

```
if (apiKey.projectId !== null) {
  // Ключ ограничен одним проектом
  if (requestedProjectId !== apiKey.projectId) → 403 Forbidden
}
```

---

## 3. Data Flow Diagram: POST /tasks

```
Client
  │
  │  POST /tasks
  │  Authorization: Bearer <token>
  │  { projectId, title, description, callbackUrl, callbackMeta }
  │
  ▼
┌─────────────────────────┐
│  Fastify Server          │
│  1. JSON Schema validate │ ─── invalid → 400 { error, details }
│  2. authMiddleware       │ ─── no token → 401
│                          │ ─── expired  → 401
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  taskRoutes handler      │
│  3. Scope check:         │
│     apiKey.projectId     │ ─── mismatch → 403
│     vs body.projectId    │
└──────────┬──────────────┘
           │
           ▼
┌─────────────────────────┐
│  CreateTask use case     │
│  4. Validate input       │ ─── ValidationError → 400
│  5. Check project exists │ ─── ProjectNotFoundError → 404
│  6. Create task entity   │
│  7. Enqueue analyst run  │
│  8. Send callback        │
│  9. Return { taskId }    │
└──────────┬──────────────┘
           │
           ▼
Client ←── 202 { taskId, status: "in_progress" }
```

---

## 4. Route Table

### 4.1 Task Routes (`src/infrastructure/http/routes/taskRoutes.js`)

| Method | Path                  | Auth | Scope Check        | Use Case        | Success | Description                    |
|--------|-----------------------|------|--------------------|-----------------|---------|--------------------------------|
| POST   | `/tasks`              | Yes  | body.projectId     | CreateTask      | 202     | Создать задачу                 |
| GET    | `/tasks/:id`          | Yes  | task.projectId     | GetTaskStatus   | 200     | Статус задачи + runs           |
| POST   | `/tasks/:id/reply`    | Yes  | task.projectId     | ReplyToQuestion | 200     | Ответить на вопрос             |
| POST   | `/tasks/:id/cancel`   | Yes  | task.projectId     | CancelTask      | 200     | Отменить задачу                |

### 4.2 Project Routes (`src/infrastructure/http/routes/projectRoutes.js`)

| Method | Path                      | Auth | Scope Check         | Use Case            | Success | Description                |
|--------|---------------------------|------|---------------------|---------------------|---------|----------------------------|
| POST   | `/projects`               | Yes  | admin only          | (inline)            | 201     | Зарегистрировать проект    |
| GET    | `/projects`               | Yes  | filter by scope     | (inline)            | 200     | Список проектов            |
| GET    | `/projects/:name`         | Yes  | project scope       | (inline)            | 200     | Информация о проекте       |
| GET    | `/projects/:name/tasks`   | Yes  | project scope       | (inline)            | 200     | Задачи проекта             |

### 4.3 Admin Routes (`src/infrastructure/http/routes/adminRoutes.js`)

| Method | Path                | Auth | Scope Check    | Use Case    | Success | Description              |
|--------|---------------------|------|----------------|-------------|---------|--------------------------|
| POST   | `/users`            | Yes  | admin only     | (inline)    | 201     | Создать пользователя     |
| GET    | `/users`            | Yes  | admin only     | (inline)    | 200     | Список пользователей     |
| DELETE | `/users/:id`        | Yes  | admin only     | (inline)    | 204     | Удалить пользователя     |
| POST   | `/api-keys`         | Yes  | —              | (inline)    | 201     | Создать API-ключ         |
| GET    | `/api-keys`         | Yes  | —              | (inline)    | 200     | Список своих ключей      |
| DELETE | `/api-keys/:id`     | Yes  | own key only   | (inline)    | 204     | Отозвать ключ            |

---

## 5. Компоненты

### 5.1 Server Setup (`src/infrastructure/http/server.js`)

```js
// createServer({ useCases, repos, logger }) → FastifyInstance
export async function createServer({ useCases, repos, logger }) {
  const app = Fastify({ logger });

  // CORS
  await app.register(cors, { origin: true });

  // Decorate request
  app.decorateRequest('user', null);
  app.decorateRequest('apiKey', null);

  // Auth middleware (onRequest hook)
  app.addHook('onRequest', authMiddleware({ apiKeyRepo: repos.apiKeyRepo, userRepo: repos.userRepo }));

  // Routes
  app.register(taskRoutes, { prefix: '/', useCases });
  app.register(projectRoutes, { prefix: '/', repos });
  app.register(adminRoutes, { prefix: '/', repos });

  // Error handler
  app.setErrorHandler(errorHandler);

  return app;
}
```

**Graceful shutdown** (в `src/index.js`):
```js
const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutting down...');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

### 5.2 Auth Middleware (`src/infrastructure/http/authMiddleware.js`)

```js
import { createHash } from 'node:crypto';

export function authMiddleware({ apiKeyRepo, userRepo }) {
  return async function authenticate(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);
    const keyHash = createHash('sha256').update(token).digest('hex');

    const apiKey = await apiKeyRepo.findByHash(keyHash);
    if (!apiKey) {
      return reply.code(401).send({ error: 'Invalid API key' });
    }

    if (apiKey.isExpired()) {
      return reply.code(401).send({ error: 'API key expired' });
    }

    const user = await userRepo.findById(apiKey.userId);
    if (!user) {
      return reply.code(401).send({ error: 'User not found' });
    }

    request.user = user;
    request.apiKey = apiKey;
  };
}
```

**Вспомогательные функции проверки (в route handlers):**

```js
// Проверка scope проекта — используется в route handlers
function assertProjectScope(apiKey, projectId) {
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    const err = new Error('Access denied: API key restricted to another project');
    err.statusCode = 403;
    throw err;
  }
}

// Проверка роли admin
function assertAdmin(user) {
  if (user.role !== 'admin') {
    const err = new Error('Admin access required');
    err.statusCode = 403;
    throw err;
  }
}
```

### 5.3 Task Routes (`src/infrastructure/http/routes/taskRoutes.js`)

#### POST /tasks

Schema:
```js
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
```

Handler:
```js
async function createTaskHandler(request, reply) {
  assertProjectScope(request.apiKey, request.body.projectId);
  const result = await useCases.createTask.execute(request.body);
  return reply.code(202).send(result);
}
```

#### GET /tasks/:id

Schema:
```js
const getTaskSchema = {
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
        task: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            projectId: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            revisionCount: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        runs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              roleName: { type: 'string' },
              status: { type: 'string' },
              startedAt: { type: 'string', format: 'date-time', nullable: true },
              finishedAt: { type: 'string', format: 'date-time', nullable: true },
              durationMs: { type: 'integer', nullable: true },
            },
          },
        },
      },
    },
  },
};
```

Handler:
```js
async function getTaskHandler(request, reply) {
  const result = await useCases.getTaskStatus.execute({ taskId: request.params.id });
  assertProjectScope(request.apiKey, result.task.projectId);
  return reply.send(result);
}
```

#### POST /tasks/:id/reply

Schema:
```js
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
```

Handler: загружает задачу для scope-проверки, затем вызывает `ReplyToQuestion.execute({ taskId, questionId, answer })`.

#### POST /tasks/:id/cancel

Schema:
```js
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
```

### 5.4 Project Routes (`src/infrastructure/http/routes/projectRoutes.js`)

#### POST /projects

Только admin. Создает `Project.create({ name, repoUrl, workDir })` и сохраняет через `projectRepo.save()`.

Schema:
```js
const createProjectSchema = {
  body: {
    type: 'object',
    required: ['name', 'repoUrl'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-z0-9_-]+$' },
      repoUrl: { type: 'string', format: 'uri', maxLength: 512 },
      workDir: { type: 'string', maxLength: 512 },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        repoUrl: { type: 'string' },
        workDir: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};
```

#### GET /projects

Список проектов. Если `apiKey.projectId` задан — возвращает только один проект. Иначе — все.

Response: `{ projects: [...] }`

#### GET /projects/:name

Загрузка через `projectRepo.findByName(name)`. Scope check по `project.id`.

#### GET /projects/:name/tasks

Загрузка проекта по имени, затем `taskRepo.findByProjectId(projectId, { status })`.

Schema:
```js
const projectTasksSchema = {
  params: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pending', 'in_progress', 'waiting_reply', 'done', 'failed', 'cancelled'] },
    },
  },
};
```

### 5.5 Admin Routes (`src/infrastructure/http/routes/adminRoutes.js`)

#### POST /users

Schema:
```js
const createUserSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 },
      role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};
```

Handler: `assertAdmin(request.user)` → `User.create({ name, role })` → `userRepo.save(user)`.

#### GET /users

Admin only. Вызывает `userRepo.findAll()` (необходимо добавить метод `findAll()` в `PgUserRepo` — сейчас есть только `findByRole()`).

#### DELETE /users/:id

Admin only. Вызывает `userRepo.delete(id)`. Возвращает 204.

**Важно:** каскадное удаление api_keys (FK ON DELETE CASCADE в миграции).

#### POST /api-keys

Любой аутентифицированный пользователь. Генерирует токен, хеширует SHA-256, сохраняет.

Schema:
```js
const createApiKeySchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 128 },
      projectId: { type: 'string', format: 'uuid' },
      expiresAt: { type: 'string', format: 'date-time' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        token: { type: 'string' },  // Показывается ОДИН раз
        projectId: { type: 'string', nullable: true },
        expiresAt: { type: 'string', format: 'date-time', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};
```

Handler:
```js
async function createApiKeyHandler(request, reply) {
  const { name, projectId, expiresAt } = request.body;

  // Если projectId указан, проверяем что проект существует
  if (projectId) {
    const project = await repos.projectRepo.findById(projectId);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
  }

  const token = crypto.randomBytes(32).toString('hex');  // 64-char hex string
  const keyHash = createHash('sha256').update(token).digest('hex');

  const apiKey = ApiKey.create({
    name,
    keyHash,
    userId: request.user.id,
    projectId: projectId ?? null,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  });

  await repos.apiKeyRepo.save(apiKey);

  return reply.code(201).send({
    id: apiKey.id,
    name: apiKey.name,
    token,  // Показывается ОДИН раз, не хранится
    projectId: apiKey.projectId,
    expiresAt: apiKey.expiresAt,
    createdAt: apiKey.createdAt,
  });
}
```

#### GET /api-keys

Показывает ключи текущего пользователя: `apiKeyRepo.findByUserId(request.user.id)`. Поле `token` не возвращается (хранится только хеш).

#### DELETE /api-keys/:id

Удаление ключа. Проверяет что ключ принадлежит текущему пользователю (или пользователь — admin).

---

## 6. Error Handler (`src/infrastructure/http/errorHandler.js`)

### Error Code Mapping Table

| Domain Error             | `error.code`           | HTTP Status | Response body                        |
|--------------------------|------------------------|-------------|--------------------------------------|
| `ValidationError`        | `VALIDATION_ERROR`     | 400         | `{ error: message }`                |
| Fastify schema violation | —                      | 400         | `{ error: "Validation failed", details: [...] }` |
| Missing/invalid token    | —                      | 401         | `{ error: "..." }`                  |
| Expired token            | —                      | 401         | `{ error: "API key expired" }`      |
| `err.statusCode === 403` | —                      | 403         | `{ error: message }`                |
| `TaskNotFoundError`      | `TASK_NOT_FOUND`       | 404         | `{ error: message }`                |
| `ProjectNotFoundError`   | `PROJECT_NOT_FOUND`    | 404         | `{ error: message }`                |
| `RunNotFoundError`       | `RUN_NOT_FOUND`        | 404         | `{ error: message }`                |
| `InvalidStateError`      | `INVALID_STATE`        | 409         | `{ error: message }`                |
| `InvalidTransitionError` | `INVALID_TRANSITION`   | 409         | `{ error: message }`                |
| `RevisionLimitError`     | `REVISION_LIMIT`       | 409         | `{ error: message }`                |
| `RoleNotFoundError`      | `ROLE_NOT_FOUND`       | 500         | `{ error: "Internal error" }`       |
| `RunTimeoutError`        | `RUN_TIMEOUT`          | 500         | `{ error: "Internal error" }`       |
| Unknown error            | —                      | 500         | `{ error: "Internal server error" }`|

```js
import { DomainError } from '../../../domain/errors/DomainError.js';

const CODE_TO_STATUS = {
  VALIDATION_ERROR: 400,
  TASK_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  INVALID_STATE: 409,
  INVALID_TRANSITION: 409,
  REVISION_LIMIT: 409,
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
```

---

## 7. CLI (`src/cli.js`)

Команда `create-admin` решает bootstrapping problem: при пустой БД нет пользователей и ключей, значит нет доступа к API.

```js
// node src/cli.js create-admin --name "Саша"
import { parseArgs } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { User } from './domain/entities/User.js';
import { ApiKey } from './domain/entities/ApiKey.js';
import { PgUserRepo } from './infrastructure/persistence/PgUserRepo.js';
import { PgApiKeyRepo } from './infrastructure/persistence/PgApiKeyRepo.js';
import { initPool, closePool } from './infrastructure/persistence/pg.js';

async function createAdmin() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
    },
  });

  if (!values.name) {
    console.error('Usage: node src/cli.js create-admin --name "Name"');
    process.exit(1);
  }

  initPool(process.env.DATABASE_URL);
  const userRepo = new PgUserRepo();
  const apiKeyRepo = new PgApiKeyRepo();

  const user = User.create({ name: values.name, role: 'admin' });
  await userRepo.save(user);

  const token = randomBytes(32).toString('hex');
  const keyHash = createHash('sha256').update(token).digest('hex');
  const apiKey = ApiKey.create({
    name: `${values.name}-bootstrap`,
    keyHash,
    userId: user.id,
  });
  await apiKeyRepo.save(apiKey);

  console.log(`Admin created: ${user.name} (${user.id})`);
  console.log(`API Token (save it, shown only once): ${token}`);

  await closePool();
}

const command = process.argv[2];
if (command === 'create-admin') {
  createAdmin().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  console.error('Available: create-admin');
  process.exit(1);
}
```

---

## 8. Необходимые изменения в существующем коде

### 8.1 PgUserRepo — добавить `findAll()`

Сейчас есть `findById()`, `findByRole()`, `save()`, `delete()`. Нужен `findAll()` для `GET /users`.

```js
async findAll() {
  const { rows } = await getPool().query(
    'SELECT * FROM users ORDER BY created_at',
  );
  return rows.map(User.fromRow);
}
```

### 8.2 PgApiKeyRepo — добавить `findById()`

Нужен для `DELETE /api-keys/:id` (проверка владельца перед удалением).

```js
async findById(id) {
  const { rows } = await getPool().query(
    'SELECT * FROM api_keys WHERE id = $1',
    [id],
  );
  return rows.length ? ApiKey.fromRow(rows[0]) : null;
}
```

### 8.3 Composition Root (`src/index.js`)

Добавить создание Fastify-сервера, инжекцию use cases и repos, запуск `app.listen()`.

---

## 9. Файловая структура новых файлов

```
src/
├── cli.js                                          # CLI: create-admin
└── infrastructure/
    └── http/
        ├── server.js                               # createServer() factory
        ├── authMiddleware.js                        # Bearer auth onRequest hook
        ├── errorHandler.js                          # Domain → HTTP error mapping
        ├── scopeHelpers.js                          # assertProjectScope(), assertAdmin()
        └── routes/
            ├── taskRoutes.js                        # POST/GET /tasks
            ├── projectRoutes.js                     # POST/GET /projects
            └── adminRoutes.js                       # POST/GET/DELETE /users, /api-keys
```

---

## 10. Зависимости (npm)

```json
{
  "fastify": "^5.x",
  "@fastify/cors": "^10.x"
}
```

Pino уже включен в Fastify (встроенный логгер).

---

## 11. Конфигурация

Переменные окружения:

| Variable        | Default       | Description                |
|-----------------|---------------|----------------------------|
| `PORT`          | `3000`        | HTTP порт                  |
| `HOST`          | `0.0.0.0`     | Bind адрес                 |
| `DATABASE_URL`  | (required)    | PostgreSQL connection      |
| `LOG_LEVEL`     | `info`        | Pino log level             |

---

## 12. Test Plan

### 12.1 Auth Middleware (`authMiddleware.test.js`)

| # | Test Case                                  | Input                              | Expected       |
|---|--------------------------------------------|------------------------------------|----------------|
| 1 | No Authorization header                    | request without header             | 401            |
| 2 | Malformed header (no "Bearer ")            | `Authorization: Token abc`         | 401            |
| 3 | Unknown token (hash not in DB)             | valid format, unknown token        | 401            |
| 4 | Expired token                              | `expiresAt` in the past            | 401            |
| 5 | Valid token, user found                    | valid token + user in DB           | next(), req.user set |
| 6 | Valid token, user deleted                  | valid token, user not in DB        | 401            |

### 12.2 Scope Helpers (`scopeHelpers.test.js`)

| # | Test Case                                  | Input                              | Expected       |
|---|--------------------------------------------|------------------------------------|----------------|
| 1 | Key without projectId — any project OK     | apiKey.projectId = null            | pass           |
| 2 | Key with projectId — matching project      | apiKey.projectId === requestedId   | pass           |
| 3 | Key with projectId — different project     | apiKey.projectId !== requestedId   | 403            |
| 4 | assertAdmin — admin user                   | user.role = 'admin'               | pass           |
| 5 | assertAdmin — member user                  | user.role = 'member'              | 403            |

### 12.3 Task Routes (`taskRoutes.test.js`)

| # | Test Case                                      | Method | Path                 | Expected |
|---|-------------------------------------------------|--------|----------------------|----------|
| 1 | Create task — happy path                        | POST   | /tasks               | 202      |
| 2 | Create task — missing title                     | POST   | /tasks               | 400      |
| 3 | Create task — invalid projectId format           | POST   | /tasks               | 400      |
| 4 | Create task — project not found                 | POST   | /tasks               | 404      |
| 5 | Create task — scope violation                   | POST   | /tasks               | 403      |
| 6 | Get task — happy path                           | GET    | /tasks/:id           | 200      |
| 7 | Get task — not found                            | GET    | /tasks/:id           | 404      |
| 8 | Reply — happy path                              | POST   | /tasks/:id/reply     | 200      |
| 9 | Reply — task not waiting_reply                  | POST   | /tasks/:id/reply     | 409      |
| 10| Cancel — happy path                             | POST   | /tasks/:id/cancel    | 200      |
| 11| Cancel — already terminal                       | POST   | /tasks/:id/cancel    | 409      |

### 12.4 Project Routes (`projectRoutes.test.js`)

| # | Test Case                                      | Method | Path                      | Expected |
|---|-------------------------------------------------|--------|---------------------------|----------|
| 1 | Create project — happy path (admin)             | POST   | /projects                 | 201      |
| 2 | Create project — non-admin                      | POST   | /projects                 | 403      |
| 3 | Create project — duplicate name                 | POST   | /projects                 | 409      |
| 4 | List projects — no scope                        | GET    | /projects                 | 200      |
| 5 | List projects — scoped key                      | GET    | /projects                 | 200 (1)  |
| 6 | Get project by name — found                     | GET    | /projects/:name           | 200      |
| 7 | Get project by name — not found                 | GET    | /projects/:name           | 404      |
| 8 | Get project tasks — with status filter          | GET    | /projects/:name/tasks     | 200      |

### 12.5 Admin Routes (`adminRoutes.test.js`)

| # | Test Case                                      | Method | Path               | Expected |
|---|-------------------------------------------------|--------|--------------------|----------|
| 1 | Create user — admin                             | POST   | /users             | 201      |
| 2 | Create user — non-admin                         | POST   | /users             | 403      |
| 3 | List users — admin                              | GET    | /users             | 200      |
| 4 | Delete user — admin                             | DELETE | /users/:id         | 204      |
| 5 | Create API key — any user                       | POST   | /api-keys          | 201, has token |
| 6 | Create API key — invalid projectId              | POST   | /api-keys          | 404      |
| 7 | List API keys — own keys only                   | GET    | /api-keys          | 200      |
| 8 | Delete API key — own key                        | DELETE | /api-keys/:id      | 204      |
| 9 | Delete API key — other user's key (non-admin)   | DELETE | /api-keys/:id      | 403      |

### 12.6 Error Handler (`errorHandler.test.js`)

| # | Test Case                                      | Input                           | Expected |
|---|-------------------------------------------------|---------------------------------|----------|
| 1 | ValidationError                                 | `new ValidationError('...')`    | 400      |
| 2 | TaskNotFoundError                               | `new TaskNotFoundError('...')`  | 404      |
| 3 | InvalidStateError                               | `new InvalidStateError('...')`  | 409      |
| 4 | Fastify validation error                        | `error.validation = [...]`      | 400      |
| 5 | Unknown error                                   | `new Error('crash')`            | 500      |

### 12.7 CLI (`cli.test.js`)

| # | Test Case                                      | Expected                        |
|---|-------------------------------------------------|---------------------------------|
| 1 | create-admin — creates user + api key in DB     | user.role = 'admin', token printed |
| 2 | create-admin — no --name flag                   | exit code 1, usage message      |

### Подход к тестированию

- **Unit тесты** (vitest): мок репозиториев и use cases, inject в Fastify через `fastify.inject()`.
- **Тесты authMiddleware**: мок `PgApiKeyRepo`, `PgUserRepo`, вызов хука напрямую.
- **Тесты routes**: `app.inject({ method, url, headers, payload })` — встроенное тестирование Fastify без поднятия сокета.
- **CLI**: интеграционный тест с реальной БД (или мок `PgUserRepo`/`PgApiKeyRepo`).

---

## 13. Решения и обоснования

1. **Один auth hook на весь сервер** — все endpoints требуют авторизацию (по архитектуре). Нет публичных endpoints. Проще один глобальный hook, чем per-route.

2. **Scope check в route handler, не в middleware** — middleware не знает какой projectId запрашивается (он в body, params или зависит от загруженной сущности). Поэтому scope проверяется в handler после извлечения projectId.

3. **Project routes — inline, без use case** — CRUD проектов слишком прост для отдельного use case. Прямой вызов `projectRepo` из route handler. Если логика усложнится — вынесем в use case.

4. **Admin routes — inline** — аналогично, простой CRUD.

5. **Token = 32 random bytes (hex)** — 256 бит энтропии, достаточно для API-ключа. Hex encoding для удобства копирования.

6. **Отдельный `scopeHelpers.js`** — переиспользуемые функции проверки scope и роли, не загромождают route handlers.

7. **`POST /projects` — только admin** — создание проекта = административная операция (привязка к git repo, work_dir). Member-пользователи работают с уже зарегистрированными проектами.

8. **Duplicate project name → 409** — `projects.name` имеет UNIQUE constraint. Ловим ошибку PG и возвращаем 409 Conflict.
