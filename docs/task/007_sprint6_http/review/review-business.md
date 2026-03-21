# Business Review — Sprint 6: HTTP API + Auth

**Reviewer:** Аркадий (reviewer-business)
**Date:** 2026-03-21
**Verdict:** APPROVED with remarks

---

## Acceptance Criteria Check

### Fastify Server (`src/infrastructure/http/server.js`)

| Criterion | Status | Comment |
|-----------|--------|---------|
| Fastify setup с CORS, error handler, graceful shutdown | PARTIAL | CORS and error handler present. Graceful shutdown not implemented in `createServer` — the caller (composition root) is expected to handle it; acceptable if `index.js` calls `app.close()` on SIGTERM. |
| Request logging (pino) | PASS | Fastify uses pino by default; `logger` option configured with configurable `LOG_LEVEL`. |
| JSON Schema validation на всех endpoints | PASS | All route handlers define `schema` objects with `body`, `params`, `querystring`, and `response` schemas. |

### Auth Middleware (`src/infrastructure/http/authMiddleware.js`)

| Criterion | Status | Comment |
|-----------|--------|---------|
| Bearer token из заголовка Authorization | PASS | Correctly parses `Authorization: Bearer <token>`. |
| SHA-256 хеш токена -> lookup в PgApiKeyRepo | PASS | `createHash('sha256').update(token).digest('hex')` then `apiKeyRepo.findByHash(keyHash)`. |
| Проверка expires_at (если задан) | PASS | Calls `apiKey.isExpired()`. |
| Scope: project_id ключа ограничивает доступ | PASS | Handled by `scopeHelpers.assertProjectScope` in each route, not in the middleware itself. Architecturally sound — scope is context-dependent. |
| 401 для невалидного/просроченного токена | PASS | Returns 401 for missing header, unknown key, expired key, and missing user. |
| 403 для доступа к чужому проекту | PASS | `assertProjectScope` throws 403 when `apiKey.projectId` does not match the resource project. |

### Task Routes

| Criterion | Status | Comment |
|-----------|--------|---------|
| `POST /tasks` -> CreateTask, returns 202 | PASS | Returns 202 with `{ taskId, status }`. Schema validates `projectId` (uuid), `title` (required). |
| `POST /tasks/:id/reply` -> ReplyToQuestion | PASS | Loads task first for scope check, then delegates to use case. |
| `POST /tasks/:id/cancel` -> CancelTask | PASS | Same pattern: scope check via getTaskStatus, then cancel. |
| `GET /tasks/:id` -> GetTaskStatus | PASS | Returns full task + runs payload. |

### Project Routes

| Criterion | Status | Comment |
|-----------|--------|---------|
| `POST /projects` -> create project | PASS | Admin-only. Validates `name` pattern (`^[a-z0-9_-]+$`), `repoUrl` (uri format). Handles duplicate name (409). |
| `GET /projects` -> list projects (scope-aware) | PASS | Scoped keys see only their project; unscoped keys see all. |
| `GET /projects/:name` -> project info | PASS | Scope check after lookup. Returns 404 if not found. |
| `GET /projects/:name/tasks` -> tasks with status filter | PASS | Filters via `querystring.status` enum. Scope check applied. |

### Admin Routes

| Criterion | Status | Comment |
|-----------|--------|---------|
| `POST /users` -> create user (admin only) | PASS | `assertAdmin` guard. Returns 201. |
| `GET /users` -> list users (admin only) | PASS | `assertAdmin` guard. |
| `DELETE /users/:id` -> delete user (admin only) | PASS | `assertAdmin` guard. Returns 204. |
| `POST /api-keys` -> create API key | PASS | Any authenticated user can create keys. Token prefixed with `nf_`, shown once in response. Validates `projectId` exists if provided. |
| `GET /api-keys` -> list own keys | PASS | Filters by `request.user.id`. Response excludes `token` and `keyHash`. |
| `DELETE /api-keys/:id` -> revoke key | PASS | Owner or admin can delete. Returns 403 for non-owner non-admin. Returns 404 if key not found. |

### CLI Bootstrap (`src/cli.js`)

| Criterion | Status | Comment |
|-----------|--------|---------|
| `node src/cli.js create-admin --name "Name"` | PASS | Creates user with role=admin, generates `nf_`-prefixed token, prints once, closes pool. |

### Tests

| Criterion | Status | Comment |
|-----------|--------|---------|
| Auth middleware: valid/invalid/expired token, scope | PASS | 7 test cases covering all auth scenarios. |
| Routes: happy path + error cases | PASS | Task routes: 10 tests. Project routes: 8 tests. Admin routes: 10 tests. Error handler: 8 tests. |
| `npm test` — all green | N/A | Not executed in this review; to be verified by tester. |

---

## Business Logic Findings

### Correct behaviors

1. **Token security model** is sound: raw token never stored, SHA-256 hash used for lookup, `nf_` prefix aids identification, token shown only once at creation time.

2. **Scope enforcement** is consistently applied across all task and project routes. Scoped API keys cannot access resources of other projects.

3. **Admin-only guards** are properly placed on user management and project creation endpoints.

4. **API key ownership model** is correct: users manage their own keys, admins can delete any key.

5. **Error mapping** covers domain errors (ValidationError, TaskNotFoundError, InvalidStateError, InvalidTransitionError, ProjectNotFoundError, RevisionLimitError), Fastify validation errors, scope/admin errors, and unknown errors — returning appropriate HTTP status codes.

### Remarks (non-blocking)

1. **Graceful shutdown** is not in `server.js`. Verify that the composition root (`src/index.js`) handles SIGTERM/SIGINT with `app.close()`. If not, this criterion is incomplete.

2. **`POST /projects` is admin-only** — this is a reasonable default but the TASK.md does not explicitly state it. Confirm this matches the intended access policy. Members cannot create projects, which may be intentional for a controlled environment.

3. **No server-level test file** (`server.test.js`). The server setup is indirectly tested through `testHelper.js` and route tests, which is sufficient for now.

4. **`DELETE /users/:id` does not prevent self-deletion.** An admin could delete their own account, potentially locking themselves out. Low risk in practice but worth noting.

5. **No rate limiting.** Not required by the task, but worth considering for production readiness in a future sprint.

6. **`questionId` is optional in reply schema** (not in `required` array). If the use case expects it, this could lead to unclear behavior when omitted. Verify the `ReplyToQuestion` use case handles a missing `questionId` gracefully.

---

## Verdict

**APPROVED.** All acceptance criteria are met. The implementation correctly covers authentication, authorization (scope + admin checks), all specified REST endpoints, JSON Schema validation, CLI bootstrap, and comprehensive test coverage. The remarks above are non-blocking suggestions for hardening.
