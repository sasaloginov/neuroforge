# Project Map — Neuroforge

Карта модулей проекта. Используй для навигации вместо самостоятельного обхода через Glob/Grep.
Analyst обновляет этот файл при добавлении/изменении модулей.

---

## Domain Layer

### Entities (`src/domain/entities/`)

| Файл | Класс | Назначение | Ключевые методы |
|-------|-------|-----------|----------------|
| Task.js | `Task` | Задача с state machine | `create()`, `transitionTo()`, `incrementRevision()`, `get shortId()` |
| Run.js | `Run` | Запуск агента | `create()`, `start(sessionId)`, `complete(response, usage)`, `fail()`, `cancel()` |
| Session.js | `Session` | CLI-сессия агента | `create()`, `close()`, `expire()` |
| TaskStep.js | `TaskStep` | Шаг пайплайна (legacy) | `create()`, `transitionTo()` |
| Project.js | `Project` | Проект (prefix, repo, workDir) | `create()` — валидация prefix `^[A-Z][A-Z0-9]{0,9}$` |
| User.js | `User` | Пользователь | `create()` — default role='member' |
| ApiKey.js | `ApiKey` | API-ключ | `create()`, `isExpired()` |
| AgentMemory.js | `AgentMemory` | Память агента (vector) | `create()` — валидация section, `get age()` |

**Task statuses:** backlog → pending → in_progress → waiting_reply / needs_escalation / research_done → done / failed / cancelled

**Run statuses:** queued → running → done / failed / timeout / interrupted / cancelled

### Value Objects (`src/domain/valueObjects/`)

| Файл | Export | Назначение |
|-------|--------|-----------|
| Role.js | `Role` | Конфиг роли: name, model, timeoutMs, allowedTools, systemPrompt |
| TaskMode.js | `TaskMode`, `isValidMode()` | Режимы: 'full', 'research' |
| BranchName.js | `generateBranchName()` | Транслитерация + slug: `NF-1/nazvaniye-zadachi` |
| ReviewFindings.js | `ReviewFindings` | Парсинг VERDICT/FINDINGS из review response. Severity: CRITICAL > MAJOR > HIGH (blocking) > MINOR > LOW |

### Ports (`src/domain/ports/`)

| Файл | Интерфейс | Методы |
|-------|----------|--------|
| IChatEngine.js | `IChatEngine` | `runPrompt(role, prompt, opts)` → `{ response, sessionId, usage, costUsd }` |
| ITaskRepo.js | `ITaskRepo` | `findById`, `save`, `saveWithSeqNumber`, `activateOldestPending`, `activateIfNoActive` |
| IRunRepo.js | `IRunRepo` | `findById`, `findByTaskId`, `save`, `takeNext` (FOR UPDATE SKIP LOCKED) |
| ISessionRepo.js | `ISessionRepo` | `findById`, `findOrCreate` (atomic upsert), `save` |
| IProjectRepo.js | `IProjectRepo` | `findById`, `findByPrefix`, `save`, `findAll` |
| ICallbackSender.js | `ICallbackSender` | `send(url, payload, meta)` |
| IGitOps.js | `IGitOps` | `ensureBranch(branch, workDir)`, `syncAllWorktrees(branch, workDir)` |
| IEmbeddingEngine.js | `IEmbeddingEngine` | `embed(text)`, `embedBatch(texts)`, `getDimensions()` |
| IAgentMemoryRepo.js | `IAgentMemoryRepo` | `save`, `search` (hybrid vector+FTS+RRF), `archive` |
| IInsightExtractor.js | `IInsightExtractor` | `extractInsights(role, prompt, response)` → insights[] |

### Services (`src/domain/services/`)

| Файл | Класс | DI | Назначение |
|-------|-------|-----|-----------|
| TaskService.js | `TaskService` | `{ taskRepo }` | CRUD + state transitions задач. `advanceTask`, `completeTask`, `escalateTask`, `incrementRevision` |
| RunService.js | `RunService` | `{ runRepo }` | Lifecycle run'ов: `enqueue`, `complete(id, response, usage)`, `fail`, `timeout`, `cancel` |
| RoleRegistry.js | `RoleRegistry` | — | In-memory реестр ролей: `register(role)`, `get(name)`, `getAll()` |
| AgentMemoryService.js | `AgentMemoryService` | `{ memoryRepo, embeddingEngine, insightExtractor }` | Retrieve (hybrid search) + store (extract → embed → dedup → save). NOT wired in index.js |

### Errors (`src/domain/errors/`)

`DomainError` (base) → `InvalidTransitionError`, `ValidationError`, `TaskNotFoundError`, `RunNotFoundError`, `ProjectNotFoundError`, `RoleNotFoundError`, `InvalidStateError`, `DuplicatePrefixError`, `RevisionLimitError`, `RunTimeoutError`

---

## Application Layer (`src/application/`)

| Файл | Класс | DI | Назначение |
|-------|-------|-----|-----------|
| CreateTask.js | `CreateTask` | taskService, runService, roleRegistry, projectRepo, taskRepo, callbackSender | Создание задачи → генерация ветки → активация или очередь → enqueue analyst |
| EnqueueTask.js | `EnqueueTask` | taskService, startNextPendingTask, projectRepo | backlog → pending, попытка активации |
| ProcessRun.js | `ProcessRun` | runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender, gitOps, workDir, agentMemoryService, runAbortRegistry | Dequeue → session → git checkout → memory enrichment → Claude CLI → complete с usage |
| ManagerDecision.js | `ManagerDecision` | runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo, startNextPendingTask | Оркестратор: research auto-complete, review findings handler, manager LLM → spawn_run/spawn_runs/complete/fail/ask_owner |
| StartNextPendingTask.js | `StartNextPendingTask` | taskRepo, taskService, runService, roleRegistry | Atomic: oldest pending → in_progress → enqueue analyst |
| GetTaskStatus.js | `GetTaskStatus` | taskService, runRepo, projectRepo | Статус задачи + runs. Поддержка UUID и short ID (PREFIX-N) |
| GetRunDetail.js | `GetRunDetail` | taskService, runRepo | Детали run'а с контекстом задачи |
| CancelTask.js | `CancelTask` | taskService, runRepo, runService, projectRepo, callbackSender, startNextPendingTask, runAbortRegistry | Cancel queued → abort running (через AbortController) → cancel task → start next |
| ReplyToQuestion.js | `ReplyToQuestion` | taskService, runService, runRepo, projectRepo, callbackSender | Ответ владельца → resume task → enqueue role с контекстом |
| RestartTask.js | `RestartTask` | taskService, runRepo, projectRepo, managerDecision, callbackSender | failed → in_progress, manager решает следующий шаг |
| ResumeResearch.js | `ResumeResearch` | taskService, runService, runRepo, taskRepo, projectRepo, roleRegistry, callbackSender | research_done → in_progress, mode=full, enqueue developer с research контекстом |
| RunAbortRegistry.js | `RunAbortRegistry` | — | In-memory Map: runId → AbortController. `register`, `abort`, `unregister` |

---

## Infrastructure Layer

### Claude CLI (`src/infrastructure/claude/`)

| Файл | Класс | Implements | Назначение |
|-------|-------|-----------|-----------|
| claudeCLIAdapter.js | `ClaudeCLIAdapter` | IChatEngine | Spawn `claude --print --output-format json`. Session resume, AbortSignal, SIGTERM/SIGKILL timeout, usage parsing |
| agentInsightExtractor.js | `AgentInsightExtractor` | IInsightExtractor | Haiku API для извлечения insights из response. До 5 insights/run. NOT wired |

### Persistence (`src/infrastructure/persistence/`)

| Файл | Класс | Implements | Особенности |
|-------|-------|-----------|------------|
| pg.js | — | — | Connection pool: `createPool`, `getPool`, `closePool` |
| PgTaskRepo.js | `PgTaskRepo` | ITaskRepo | `saveWithSeqNumber` — atomic seq assignment. `activateOldestPending` — FOR UPDATE SKIP LOCKED |
| PgRunRepo.js | `PgRunRepo` | IRunRepo | `takeNext` — atomic dequeue. `save` — UPSERT с usage jsonb |
| PgSessionRepo.js | `PgSessionRepo` | ISessionRepo | `findOrCreate` — atomic upsert. Unique (project, role, active) |
| PgProjectRepo.js | `PgProjectRepo` | IProjectRepo | Standard CRUD |
| PgUserRepo.js | `PgUserRepo` | — | Standard CRUD |
| PgApiKeyRepo.js | `PgApiKeyRepo` | — | `findByHash` для auth |
| PgAgentMemoryRepo.js | `PgAgentMemoryRepo` | IAgentMemoryRepo | Hybrid search: pgvector cosine + FTS + RRF. NOT wired |

### HTTP (`src/infrastructure/http/`)

| Файл | Назначение |
|-------|-----------|
| server.js | Fastify: CORS, auth hook, routes, error handler |
| authMiddleware.js | Bearer token → SHA-256 → apiKeyRepo lookup → `request.user` |
| taskRoutes.js | POST /tasks, GET /tasks/:id, POST /tasks/:id/cancel, /reply, /restart, /resume-research |
| projectRoutes.js | POST /projects, GET /projects/:id, GET /projects/:id/tasks |
| adminRoutes.js | Admin endpoints |
| errorHandler.js | Domain errors → HTTP status codes |

### Scheduler (`src/infrastructure/scheduler/`)

| Файл | Назначение |
|-------|-----------|
| managerScheduler.js | `ManagerScheduler` — setInterval tick, concurrent slots (maxConcurrent), recover stale runs on start |
| worker.js | `createWorker` → `{ processOne }`: ProcessRun → ManagerDecision chain |

### Other Adapters

| Файл | Класс | Implements | Назначение |
|-------|-------|-----------|-----------|
| git/gitCLIAdapter.js | `GitCLIAdapter` | IGitOps | `ensureBranch`, `syncAllWorktrees` (agent-* worktrees) |
| callback/callbackClient.js | `CallbackClient` | ICallbackSender | HTTP POST + retry (3x exponential backoff) |
| embedding/OllamaEmbeddingAdapter.js | `OllamaEmbeddingAdapter` | IEmbeddingEngine | BGE-M3, 1024 dim, batch embed. NOT wired |
| roles/fileRoleLoader.js | `loadRoles(dir)` | — | Parse YAML frontmatter + markdown body → Role[] |

---

## Composition Root (`src/index.js`)

Порядок инициализации:
1. Config из env (DATABASE_URL, ROLES_DIR, WORKSPACE_DIR, PORT)
2. PG pool + Knex migrations
3. Load roles → RoleRegistry
4. Create repos (Pg*)
5. Start MCP HTTP server (port 3100) → write mcp-config.json
6. Create adapters: ClaudeCLIAdapter, CallbackClient, GitCLIAdapter
7. Create domain services: TaskService, RunService
8. Create use cases (CreateTask, ProcessRun, ManagerDecision, ...)
9. Create worker + ManagerScheduler
10. Create Fastify server → listen
11. Start scheduler (interval=10s, maxConcurrent from env)
12. Graceful shutdown: SIGINT/SIGTERM → scheduler.stop → server.close → mcp.close → pool.end

**NOT wired:** AgentMemoryService, OllamaEmbeddingAdapter, PgAgentMemoryRepo, AgentInsightExtractor
