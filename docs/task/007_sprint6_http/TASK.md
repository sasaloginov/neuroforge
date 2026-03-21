# Task 007: Sprint 6 — HTTP API + Auth

## Тип
feature

## Приоритет
critical

## Описание
Реализовать HTTP-слой: Fastify сервер, auth middleware (Bearer API-ключи), все REST endpoints из архитектуры, JSON Schema валидация, CLI для bootstrap первого admin. После этого спринта API доступен клиентам.

## Acceptance Criteria

### Fastify Server (`src/infrastructure/http/server.js`)
- [ ] Fastify setup с CORS, error handler, graceful shutdown
- [ ] Request logging (pino)
- [ ] JSON Schema validation на всех endpoints

### Auth Middleware (`src/infrastructure/http/authMiddleware.js`)
- [ ] Bearer token из заголовка Authorization
- [ ] SHA-256 хеш токена → lookup в PgApiKeyRepo
- [ ] Проверка expires_at (если задан)
- [ ] Scope: project_id ключа ограничивает доступ
- [ ] 401 для невалидного/просроченного токена
- [ ] 403 для доступа к чужому проекту

### Task Routes
- [ ] `POST /tasks` → CreateTask use case, возвращает 202 `{ taskId, status }`
- [ ] `POST /tasks/:id/reply` → ReplyToQuestion use case
- [ ] `POST /tasks/:id/cancel` → CancelTask use case
- [ ] `GET /tasks/:id` → GetTaskStatus use case

### Project Routes
- [ ] `POST /projects` → создать проект (name, repo_url, work_dir)
- [ ] `GET /projects` → список проектов (с учётом scope ключа)
- [ ] `GET /projects/:name` → информация о проекте
- [ ] `GET /projects/:name/tasks` → задачи проекта (фильтр по status)

### Admin Routes
- [ ] `POST /users` → создать пользователя (только admin)
- [ ] `GET /users` → список пользователей (только admin)
- [ ] `DELETE /users/:id` → удалить пользователя (только admin)
- [ ] `POST /api-keys` → создать API-ключ
- [ ] `GET /api-keys` → список своих ключей
- [ ] `DELETE /api-keys/:id` → отозвать ключ

### CLI Bootstrap (`src/cli.js`)
- [ ] `node src/cli.js create-admin --name "Имя"` → создаёт user (role=admin) + API-ключ, выводит токен один раз

### Тесты
- [ ] Auth middleware: валидный/невалидный/просроченный токен, scope
- [ ] Routes: happy path + error cases (мок use cases)
- [ ] `npm test` — все зелёные

## Контекст
- Зависит от: Sprint 5 (use cases)
- API: `docs/architecture/neuroforge.md` (раздел "Внешний API")
- ADR #28: Bearer API-ключи, SHA-256, scope
- ADR #29: Bootstrap admin через CLI

## Затрагиваемые компоненты
- Infrastructure: http/ (server, routes, auth), cli.js

## Definition of Done
- [ ] Все endpoints работают
- [ ] Auth с scope проверкой
- [ ] JSON Schema validation
- [ ] CLI создаёт первого admin
- [ ] Тесты проходят
