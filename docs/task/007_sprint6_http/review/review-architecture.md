# Architecture Review: Sprint 6 — HTTP API + Auth

**Reviewer:** Аркадий (architecture)
**Date:** 2026-03-21
**Verdict:** APPROVED with minor remarks

---

## 1. DDD Layer Compliance

**Status: PASS**

Dependency flow is correct throughout:

- `server.js`, `authMiddleware.js`, route files — all reside in `infrastructure/` and depend only on domain entities (`User`, `ApiKey`, `Project`, `DomainError`) and application use cases. No reverse dependencies detected.
- `errorHandler.js` imports only `DomainError` from domain — correct.
- `scopeHelpers.js` is pure logic with no imports — correct placement in infrastructure.
- `cli.js` imports domain entities + infrastructure repos, acting as a composition root — acceptable.

## 2. Thin Controllers / Route Delegation

**Status: PASS**

- `taskRoutes.js` — all four endpoints delegate to use cases (`createTask`, `getTaskStatus`, `replyToQuestion`, `cancelTask`). Route handlers contain only scope checks and use case calls. No business logic in controllers.
- `adminRoutes.js` — user CRUD and API key CRUD delegate directly to repos. API key creation contains token generation logic (hash + save), which is acceptable at the infrastructure level since it is a crypto/persistence concern, not domain logic.
- `projectRoutes.js` — project CRUD delegates to repos. `POST /projects` instantiates `Project.create()` and saves — thin and correct.

**Remark (minor):** `projectRoutes.js` and `adminRoutes.js` talk to repos directly rather than through use cases. This is acceptable for simple CRUD where a use case would be a trivial pass-through (KISS principle), but should be revisited if business rules emerge around project/user creation (e.g., limits, notifications).

## 3. Auth Middleware

**Status: PASS**

- Bearer token extraction is correct — checks header prefix, slices token.
- SHA-256 hashing before lookup — matches ADR #28.
- Expiration check via `apiKey.isExpired()` — delegates to domain entity, correct.
- User lookup after key validation — correct ordering.
- Request decoration (`request.user`, `request.apiKey`) — clean pattern for downstream access.
- Health endpoint skip — handled both in middleware (`if (request.url === '/health')`) and in server (registered before auth hook). Double protection is fine.

**Remark (minor):** The URL check `request.url === '/health'` is fragile if query parameters are appended (e.g., `/health?check=db`). Consider using `request.routeOptions.url` or a route-level config flag instead. Low priority since `/health` is a simple endpoint.

## 4. Error Handler

**Status: PASS**

- Maps domain error codes to HTTP statuses via `CODE_TO_STATUS` lookup — clean and extensible.
- Fastify schema validation errors handled separately with `error.validation` check.
- Errors with explicit `statusCode` (from scope/admin helpers) pass through correctly.
- Domain errors with status >= 500 are logged and sanitized to "Internal server error" — prevents information leakage.
- Unknown errors logged and returned as 500 — correct.

No issues found.

## 5. Scope Helpers

**Status: PASS**

- `assertProjectScope` — correctly checks `apiKey.projectId` against the target project, allows unrestricted keys (no projectId).
- `assertAdmin` — simple role check.
- Both throw plain `Error` with `statusCode` property, which the error handler catches via the `error.statusCode < 500` branch. Consistent pattern.

## 6. CLI Bootstrap

**Status: PASS**

- Uses `node:util` `parseArgs` — standard Node.js API, no extra dependencies.
- Creates User + ApiKey with proper hashing, outputs raw token once.
- Closes the pool after operation — no leaked connections.
- Acts as a separate composition root — correct DDD pattern.

**Remark (minor):** `strict: false` in `parseArgs` silently ignores unknown flags. Consider `strict: true` with `allowPositionals: true` to catch typos.

## 7. SOLID / DRY / KISS

**Status: PASS**

- **SRP:** Each file has a single responsibility (auth, error handling, scope checks, routes per domain area).
- **OCP:** Error handler is extensible via `CODE_TO_STATUS` map. Routes are registered as plugins — new route files can be added without modifying `server.js` internals.
- **DIP:** `server.js` receives dependencies via `{ useCases, repos, logger }` — proper DI from composition root.
- **DRY:** Scope check logic is extracted to `scopeHelpers.js` and reused across task and project routes. Test helper (`testHelper.js`) eliminates test boilerplate across all test files.
- **KISS:** No unnecessary abstractions. Schemas are co-located with routes. No framework over-abstraction.

## 8. Test Coverage

**Status: PASS**

- Auth middleware: 7 tests covering no header, malformed header, unknown token, expired token, missing user, valid auth, health skip.
- Error handler: 8 tests covering all domain error types, Fastify validation, statusCode pass-through, unknown errors.
- Task routes: 9 tests — happy paths + validation errors + scope + domain errors for all 4 endpoints.
- Project routes: 7 tests — CRUD + scope + not found + duplicate name.
- Admin routes: 10 tests — user CRUD admin checks + API key CRUD + ownership checks.
- `testHelper.js` provides reusable server setup with configurable mocks — well designed.

All tests use mocked use cases and repos — no database dependency, fast execution.

## 9. Issues Found

### 9.1 No overengineering detected

The code is appropriately minimal. No unnecessary middleware layers, no premature abstractions.

### 9.2 Minor: `POST /tasks/:id/reply` and `POST /tasks/:id/cancel` double-fetch task

Both endpoints call `getTaskStatus.execute()` for scope checking, then call the actual use case. This results in two database queries for the task. Not a critical issue — the scope check is necessary and the alternative (embedding scope in each use case) would violate separation of concerns. Acceptable trade-off.

### 9.3 Minor: `projectRoutes.js` catches PG error code `'23505'` directly

Line 71 in `projectRoutes.js` checks `err.code === '23505'` (PostgreSQL unique violation). This couples the route handler to PostgreSQL internals. Ideally, the repo or a domain service should catch this and throw a domain error (e.g., `ProjectAlreadyExistsError`). Low priority for Sprint 6 but worth a follow-up.

### 9.4 Cosmetic: `server.js` uses `{ prefix: '/' }` for all route groups

Passing `{ prefix: '/' }` is equivalent to no prefix. Not harmful but unnecessary. Consider removing or using meaningful prefixes (`/api/v1`) if API versioning is planned.

---

## Summary

| Area                  | Verdict |
|-----------------------|---------|
| DDD layer compliance  | PASS    |
| Thin controllers      | PASS    |
| Auth middleware        | PASS    |
| Error handler         | PASS    |
| Scope enforcement     | PASS    |
| CLI bootstrap         | PASS    |
| SOLID / DRY / KISS    | PASS    |
| Test coverage         | PASS    |
| No overengineering    | PASS    |

**Overall: APPROVED**

Three minor remarks for backlog consideration:
1. PG error code `'23505'` in route handler -- move to repo/domain layer
2. Auth middleware URL string matching for `/health` -- consider route-level config
3. `parseArgs` with `strict: false` -- consider `strict: true`

None of these block the sprint.
