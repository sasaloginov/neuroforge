# Research: Sprint 6 — HTTP API + Auth

## 1. Inventory of existing codebase

### 1.1 Application layer (use cases)

Четыре use case, каждый принимает зависимости через конструктор (DI), каждый имеет `execute(params)`.

| Use Case | Input | Output | Ошибки |
|---|---|---|---|
| `CreateTask` | `{ projectId, title, description, callbackUrl, callbackMeta }` | `{ taskId, status: 'in_progress' }` | `ValidationError`, `ProjectNotFoundError` |
| `GetTaskStatus` | `{ taskId }` | `{ task: {...}, runs: [...] }` | `TaskNotFoundError` |
| `ReplyToQuestion` | `{ taskId, questionId, answer }` | `{ taskId, status: 'in_progress' }` | `TaskNotFoundError`, `InvalidStateError` |
| `CancelTask` | `{ taskId }` | `{ taskId, status: 'cancelled', cancelledRuns }` | `TaskNotFoundError`, `InvalidTransitionError` |

Зависимости use case:
- `CreateTask` — taskService, runService, roleRegistry, projectRepo, callbackSender
- `GetTaskStatus` — taskService, runRepo
- `ReplyToQuestion` — taskService, runService, runRepo, callbackSender
- `CancelTask` — taskService, runRepo, callbackSender

**Два внутренних use case** (не для HTTP):
- `ProcessRun` — обработка run воркером
- `ManagerDecision` — принятие решения менеджером

### 1.2 Domain entities (auth-related)

**User** (`src/domain/entities/User.js`):
- Поля: `id`, `name`, `role`, `createdAt`
- `role` принимает значения: `admin`, `member`
- `User.create({ name, role = 'member' })` — фабрика, генерирует UUID
- `fromRow()` / `toRow()` — маппинг на БД

**ApiKey** (`src/domain/entities/ApiKey.js`):
- Поля: `id`, `name`, `keyHash`, `userId`, `projectId` (nullable), `expiresAt` (nullable), `createdAt`
- `ApiKey.create({ name, keyHash, userId, projectId, expiresAt })` — фабрика
- `isExpired()` — проверка `expiresAt` по текущему времени
- `projectId` — scope: если задан, ключ ограничен одним проектом

**Project** (`src/domain/entities/Project.js`):
- Поля: `id`, `name`, `repoUrl`, `workDir` (nullable), `createdAt`
- `Project.create({ name, repoUrl, workDir })`

**Task** (`src/domain/entities/Task.js`):
- Поля: `id`, `projectId`, `title`, `description`, `status`, `callbackUrl`, `callbackMeta`, `revisionCount`, `createdAt`, `updatedAt`
- Статусы: `pending`, `in_progress`, `waiting_reply`, `done`, `failed`, `cancelled`

### 1.3 Domain errors

Все ошибки наследуют `DomainError extends Error` с полем `code`:

| Error | code | HTTP status (маппинг) |
|---|---|---|
| `ValidationError` | `VALIDATION_ERROR` | 400 |
| `TaskNotFoundError` | `TASK_NOT_FOUND` | 404 |
| `ProjectNotFoundError` | `PROJECT_NOT_FOUND` | 404 |
| `InvalidStateError` | `INVALID_STATE` | 409 |
| `InvalidTransitionError` | `INVALID_TRANSITION` | 409 |
| `RoleNotFoundError` | `ROLE_NOT_FOUND` | 500 (внутренняя) |
| `RunNotFoundError` | `RUN_NOT_FOUND` | 404 |
| `RunTimeoutError` | `RUN_TIMEOUT` | 500 (внутренняя) |
| `RevisionLimitError` | `REVISION_LIMIT` | 500 (внутренняя) |

### 1.4 Infrastructure repos (persistence)

**PgApiKeyRepo** (`src/infrastructure/persistence/PgApiKeyRepo.js`):
- `findByHash(keyHash)` — lookup по SHA-256 хешу (для auth)
- `findByUserId(userId)` — список ключей пользователя
- `save(apiKey)` — upsert
- `delete(id)` — удалить ключ

**PgUserRepo** (`src/infrastructure/persistence/PgUserRepo.js`):
- `findById(id)` — по UUID
- `findByRole(role)` — пользователи с определённой ролью
- `save(user)` — upsert
- `delete(id)` — удалить

> **Обнаружен пробел:** нет метода `findAll()` — для `GET /users` (admin) нужно будет добавить.

**PgProjectRepo** (`src/infrastructure/persistence/PgProjectRepo.js`):
- `findById(id)` — по UUID
- `findByName(name)` — по имени (для `GET /projects/:name`)
- `findAll()` — все проекты
- `save(project)` — upsert

**PgTaskRepo** (`src/infrastructure/persistence/PgTaskRepo.js`):
- `findById(id)` — по UUID
- `findByProjectId(projectId, { status? })` — задачи проекта с фильтром
- `save(task)` — upsert
- `delete(id)`

### 1.5 Текущее состояние HTTP-слоя

Директория `src/infrastructure/http/` **не существует** — нужно создать с нуля.

### 1.6 Dependencies (package.json)

- `fastify`: `^5.2.1` — Fastify 5
- `@fastify/cors`: `^10.0.2` — CORS plugin
- `pino`: `^9.6.0` — logger (Fastify 5 использует pino встроенно)
- `dotenv`: `^16.4.7`
- `uuid`: `^11.1.0`

---

## 2. Fastify 5 — ключевые паттерны

### 2.1 Hooks и декораторы для auth middleware

Fastify предоставляет `onRequest` hook для проверки авторизации до обработки запроса:

```js
// authMiddleware.js
import { createHash } from 'node:crypto';

export function authMiddleware({ apiKeyRepo, userRepo }) {
  return async function authenticate(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    const keyHash = createHash('sha256').update(token).digest('hex');

    const apiKey = await apiKeyRepo.findByHash(keyHash);
    if (!apiKey) {
      reply.code(401).send({ error: 'Invalid API key' });
      return;
    }

    if (apiKey.isExpired()) {
      reply.code(401).send({ error: 'API key expired' });
      return;
    }

    const user = await userRepo.findById(apiKey.userId);
    if (!user) {
      reply.code(401).send({ error: 'User not found' });
      return;
    }

    // Декорируем request для доступа из route handlers
    request.apiKey = apiKey;
    request.user = user;
  };
}
```

**Подключение к серверу через `addHook`:**
```js
fastify.addHook('onRequest', authenticate);
```

Или через plugin encapsulation — только для определённых route groups.

**Важно для Fastify 5:** декораторы нужно объявлять через `decorateRequest` до использования:
```js
fastify.decorateRequest('apiKey', null);
fastify.decorateRequest('user', null);
```

### 2.2 JSON Schema validation

Fastify 5 использует `ajv` (через `@fastify/ajv-compiler`) для валидации. Схемы задаются в route options:

```js
fastify.post('/tasks', {
  schema: {
    body: {
      type: 'object',
      required: ['projectId', 'title'],
      properties: {
        projectId: { type: 'string', format: 'uuid' },
        title: { type: 'string', minLength: 1, maxLength: 500 },
        description: { type: 'string' },
        callbackUrl: { type: 'string', format: 'uri' },
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
    params: { ... },  // для :id в URL
    querystring: { ... },  // для query params
  },
}, handler);
```

Fastify автоматически возвращает 400 при невалидном input с описанием ошибок. Response schema сериализует output (убирает лишние поля, ускоряет JSON.stringify через `fast-json-stringify`).

### 2.3 Структура routes через plugins

Fastify routes организуются через `register` — каждый plugin получает свой encapsulated context:

```js
// server.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { taskRoutes } from './routes/taskRoutes.js';
import { projectRoutes } from './routes/projectRoutes.js';
import { adminRoutes } from './routes/adminRoutes.js';

export async function buildServer(deps) {
  const fastify = Fastify({
    logger: true,  // pino включён
  });

  await fastify.register(cors);

  // Декорируем request
  fastify.decorateRequest('apiKey', null);
  fastify.decorateRequest('user', null);

  // Auth hook — применяется ко ВСЕМ дочерним routes
  fastify.addHook('onRequest', authMiddleware(deps));

  // Группы маршрутов
  fastify.register(taskRoutes(deps), { prefix: '/tasks' });
  fastify.register(projectRoutes(deps), { prefix: '/projects' });
  fastify.register(adminRoutes(deps), { prefix: '' });

  return fastify;
}
```

**Файловая структура routes:**
```
src/infrastructure/http/
├── server.js              # buildServer(), Fastify setup
├── authMiddleware.js      # Bearer token → apiKey + user on request
├── errorHandler.js        # DomainError → HTTP status mapping
└── routes/
    ├── taskRoutes.js      # POST /tasks, GET /tasks/:id, POST /tasks/:id/reply, /cancel
    ├── projectRoutes.js   # POST/GET /projects, GET /projects/:name, /projects/:name/tasks
    └── adminRoutes.js     # POST/GET/DELETE /users, POST/GET/DELETE /api-keys
```

**Plugin pattern:** каждый route file экспортирует функцию, возвращающую async plugin:

```js
// routes/taskRoutes.js
export function taskRoutes(deps) {
  return async function (fastify) {
    fastify.post('/', { schema: { ... } }, async (request, reply) => {
      const result = await deps.createTask.execute(request.body);
      reply.code(202).send(result);
    });
  };
}
```

### 2.4 SHA-256 хеширование API-ключей

Node.js `crypto` модуль (built-in, не нужен npm пакет):

```js
import { createHash, randomBytes } from 'node:crypto';

// Генерация нового API-ключа (при create-admin или POST /api-keys):
function generateApiKey() {
  const rawKey = randomBytes(32).toString('hex');  // 64 символа hex
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  return { rawKey, keyHash };
  // rawKey показать пользователю один раз, keyHash сохранить в БД
}

// При auth — хешируем входящий token для lookup:
function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}
```

**Формат rawKey:** `nf_` prefix + 32 bytes hex = `nf_<64 hex chars>` (67 символов). Prefix помогает идентифицировать ключи Нейроцеха.

### 2.5 Pino logging

Fastify 5 использует pino как встроенный logger. При `logger: true` каждый запрос автоматически логируется:
- Request: method, url, hostname, remoteAddress
- Response: statusCode, responseTime

Настройка уровня и формата:
```js
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    // pretty-print для dev:
    ...(process.env.NODE_ENV === 'development' && {
      transport: { target: 'pino-pretty' },
    }),
  },
});
```

Request-scoped logger доступен как `request.log.info(...)`.

### 2.6 Error handler

Fastify позволяет задать `setErrorHandler` для маппинга domain errors → HTTP responses:

```js
fastify.setErrorHandler((error, request, reply) => {
  // Fastify validation errors (from JSON Schema)
  if (error.validation) {
    reply.code(400).send({
      error: 'Validation Error',
      message: error.message,
      details: error.validation,
    });
    return;
  }

  // Domain errors
  const statusMap = {
    VALIDATION_ERROR: 400,
    TASK_NOT_FOUND: 404,
    PROJECT_NOT_FOUND: 404,
    RUN_NOT_FOUND: 404,
    INVALID_STATE: 409,
    INVALID_TRANSITION: 409,
  };

  if (error.code && statusMap[error.code]) {
    reply.code(statusMap[error.code]).send({
      error: error.code,
      message: error.message,
    });
    return;
  }

  // Unknown errors
  request.log.error(error);
  reply.code(500).send({ error: 'Internal Server Error' });
});
```

### 2.7 Graceful shutdown

```js
// В index.js (composition root):
const server = await buildServer(deps);

await server.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.log.info(`Received ${signal}, shutting down...`);
    await server.close();
    await pool.end();  // закрыть PG pool
    process.exit(0);
  });
}
```

---

## 3. Auth middleware — scope enforcement

### 3.1 Логика проверки scope

API-ключ может иметь `projectId` (scope). Если задан — ключ видит только этот проект.

```
1. Извлечь Bearer token из Authorization header → 401 если нет
2. SHA-256(token) → lookup в api_keys → 401 если не найден
3. Проверить expires_at → 401 если просрочен
4. Загрузить user по apiKey.userId → 401 если не найден
5. Установить request.apiKey и request.user
```

**Scope enforcement в route handlers:**
```js
// Для GET /projects — фильтровать список по scope
if (request.apiKey.projectId) {
  // Показать только один проект
} else {
  // Показать все проекты
}

// Для POST /tasks — проверить что projectId совпадает со scope
if (request.apiKey.projectId && request.apiKey.projectId !== body.projectId) {
  reply.code(403).send({ error: 'API key scope does not include this project' });
  return;
}
```

### 3.2 Admin-only routes

Для `POST/GET/DELETE /users` нужна проверка `request.user.role === 'admin'`:

```js
function requireAdmin(request, reply) {
  if (request.user.role !== 'admin') {
    reply.code(403).send({ error: 'Admin access required' });
  }
}

// В adminRoutes:
fastify.addHook('onRequest', requireAdmin);  // только для user-management routes
```

---

## 4. CLI Bootstrap (`src/cli.js`)

```js
// node src/cli.js create-admin --name "Саша"
import { createHash, randomBytes } from 'node:crypto';
import { User } from './domain/entities/User.js';
import { ApiKey } from './domain/entities/ApiKey.js';

// 1. Парсим args (process.argv, без внешних пакетов)
// 2. Создаём User с role=admin
// 3. Генерируем rawKey + keyHash
// 4. Создаём ApiKey (без projectId scope, без expiresAt)
// 5. Сохраняем в БД
// 6. Выводим rawKey один раз
```

Парсинг аргументов — простой `process.argv` без commander/yargs (лишняя зависимость для одной команды).

---

## 5. Endpoints — полный маппинг на use cases и repos

### Task Routes (`/tasks`)

| Method | Path | Schema body | Use case / Logic | Response |
|---|---|---|---|---|
| `POST` | `/tasks` | `{ projectId, title, description?, callbackUrl?, callbackMeta? }` | `CreateTask.execute()` | 202 `{ taskId, status }` |
| `GET` | `/tasks/:id` | params: `{ id: uuid }` | `GetTaskStatus.execute()` | 200 `{ task, runs }` |
| `POST` | `/tasks/:id/reply` | `{ questionId, answer }` | `ReplyToQuestion.execute()` | 200 `{ taskId, status }` |
| `POST` | `/tasks/:id/cancel` | — | `CancelTask.execute()` | 200 `{ taskId, status, cancelledRuns }` |

**Scope check:** для POST /tasks — `projectId` должен совпадать со scope ключа (если есть). Для GET/reply/cancel — task.projectId должен совпадать со scope.

### Project Routes (`/projects`)

| Method | Path | Use case / Logic | Response |
|---|---|---|---|
| `POST` | `/projects` | `projectRepo.save(Project.create(...))` | 201 `{ id, name }` |
| `GET` | `/projects` | `projectRepo.findAll()` + scope filter | 200 `[{ id, name, repoUrl }]` |
| `GET` | `/projects/:name` | `projectRepo.findByName(name)` | 200 `{ id, name, repoUrl, workDir }` |
| `GET` | `/projects/:name/tasks` | `findByName` → `taskRepo.findByProjectId(id, { status? })` | 200 `[{ id, title, status }]` |

**Нет use case для projects** — логика простая, можно обращаться к repo напрямую из routes. Альтернатива — создать ProjectService в domain/services или use cases в application. Рекомендация: напрямую через repo, т.к. бизнес-логики минимум.

### Admin Routes

| Method | Path | Guard | Logic | Response |
|---|---|---|---|---|
| `POST` | `/users` | admin | `userRepo.save(User.create(...))` | 201 `{ id, name, role }` |
| `GET` | `/users` | admin | `userRepo.findAll()` (нужно добавить) | 200 `[...]` |
| `DELETE` | `/users/:id` | admin | `userRepo.delete(id)` | 204 |
| `POST` | `/api-keys` | auth | generate key, `apiKeyRepo.save(...)` | 201 `{ id, name, key }` (key один раз) |
| `GET` | `/api-keys` | auth | `apiKeyRepo.findByUserId(user.id)` | 200 `[{ id, name, projectId, expiresAt }]` |
| `DELETE` | `/api-keys/:id` | auth | `apiKeyRepo.delete(id)` (проверить ownership) | 204 |

---

## 6. Обнаруженные пробелы (действия для developer)

### 6.1 Требуется добавить в persistence

1. **`PgUserRepo.findAll()`** — для `GET /users` (admin). Аналогично `PgProjectRepo.findAll()`.

### 6.2 Требуется создать (новые файлы)

1. `src/infrastructure/http/server.js` — Fastify setup, CORS, error handler, graceful shutdown
2. `src/infrastructure/http/authMiddleware.js` — Bearer token auth + scope
3. `src/infrastructure/http/errorHandler.js` — DomainError → HTTP status mapping
4. `src/infrastructure/http/routes/taskRoutes.js`
5. `src/infrastructure/http/routes/projectRoutes.js`
6. `src/infrastructure/http/routes/adminRoutes.js`
7. `src/cli.js` — CLI bootstrap create-admin
8. `src/index.js` — composition root (DI wiring + server start)

### 6.3 Тесты

1. `src/infrastructure/http/authMiddleware.test.js` — unit tests с моками
2. `src/infrastructure/http/routes/taskRoutes.test.js` — с `fastify.inject()`
3. `src/infrastructure/http/routes/projectRoutes.test.js`
4. `src/infrastructure/http/routes/adminRoutes.test.js`

**Fastify `inject()`** — встроенный механизм для тестов без поднятия сервера:
```js
const response = await fastify.inject({
  method: 'POST',
  url: '/tasks',
  headers: { authorization: 'Bearer valid-token' },
  payload: { projectId: '...', title: 'Test' },
});
expect(response.statusCode).toBe(202);
```

---

## 7. Рекомендации по реализации

### 7.1 Порядок реализации

1. `errorHandler.js` — маппинг ошибок (используется везде)
2. `authMiddleware.js` — auth (используется всеми routes)
3. `server.js` — Fastify setup, подключение middleware и routes
4. `routes/taskRoutes.js` — основной функционал
5. `routes/projectRoutes.js`
6. `routes/adminRoutes.js` + добавить `PgUserRepo.findAll()`
7. `cli.js` — bootstrap admin
8. `src/index.js` — composition root
9. Тесты

### 7.2 API key format

Рекомендуемый формат: `nf_` + 32 random bytes hex = `nf_<64 hex chars>`.
Prefix `nf_` позволяет:
- Быстро идентифицировать ключ как принадлежащий Neuroforge
- GitHub secret scanning может распознать формат
- Пользователь визуально отличает от других токенов

### 7.3 DDD compliance

HTTP-слой — это infrastructure. Он:
- Не содержит бизнес-логику
- Вызывает use cases из application или repos из infrastructure
- Маппит HTTP request → use case input, use case output → HTTP response
- Маппит domain errors → HTTP status codes

Route handlers должны быть тонкими: извлечь данные из request, вызвать use case, вернуть ответ.

### 7.4 Scope enforcement — единая функция

Создать хелпер `checkScope(apiKey, projectId)` чтобы не дублировать проверку в каждом route:

```js
export function checkScope(apiKey, projectId) {
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    const err = new Error('API key scope does not include this project');
    err.statusCode = 403;
    throw err;
  }
}
```
