# Architecture Review — Sprint 3: Persistence Layer

**Reviewer:** reviewer-architecture
**Date:** 2026-03-21
**Status:** APPROVED with remarks

---

## Summary

The persistence layer is well-structured, follows DDD conventions, and correctly implements the port-adapter pattern for Task, Run, Session, and Project repositories. The `takeNext()` queue implementation is correct. FileRoleLoader is clean and production-ready. Several issues need attention, mostly around missing port interfaces and inconsistent mapping patterns.

---

## Checklist Results

### 1. Repos correctly implement their port interfaces

**PASS (partial)**

- `PgTaskRepo extends ITaskRepo` — all 4 methods implemented: `findById`, `findByProjectId`, `save`, `delete`.
- `PgRunRepo extends IRunRepo` — all 5 methods implemented: `findById`, `findByTaskId`, `findRunning`, `save`, `takeNext`.
- `PgSessionRepo extends ISessionRepo` — all 4 methods implemented: `findById`, `findByProjectAndRole`, `save`, `delete`.
- `PgProjectRepo extends IProjectRepo` — all 4 methods implemented: `findById`, `findByName`, `save`, `findAll`.

**ISSUE [medium]:** `PgUserRepo` and `PgApiKeyRepo` do NOT extend any port interface. There are no `IUserRepo` or `IApiKeyRepo` defined in `src/domain/ports/`. These repos exist as infrastructure-only classes without domain contracts.

**Recommendation:** Define `IUserRepo.js` and `IApiKeyRepo.js` in `src/domain/ports/` and have the Pg implementations extend them. This is required for consistent DI and testability via the Composition Root.

### 2. DDD: infrastructure depends on domain (not vice versa)

**PASS**

All imports flow correctly:
- `PgTaskRepo` imports from `../../domain/ports/ITaskRepo.js` and `../../domain/entities/Task.js`
- `PgRunRepo` imports from `../../domain/ports/IRunRepo.js` and `../../domain/entities/Run.js`
- `PgSessionRepo` imports from `../../domain/ports/ISessionRepo.js` and `../../domain/entities/Session.js`
- `PgProjectRepo` imports from `../../domain/ports/IProjectRepo.js`
- `fileRoleLoader.js` imports from `../../domain/valueObjects/Role.js`

No domain file imports anything from infrastructure. Dependency flow is correct: Infrastructure -> Domain.

### 3. Repos use entity.fromRow()/toRow() for mapping

**PASS (partial)**

- `PgTaskRepo` — uses `Task.fromRow()` and `task.toRow()`. Correct.
- `PgRunRepo` — uses `Run.fromRow()` and `run.toRow()`. Correct.
- `PgSessionRepo` — uses `Session.fromRow()` and `session.toRow()`. Correct.

**ISSUE [medium]:** `PgProjectRepo` defines inline `fromRow()`/`toRow()` functions at module level instead of using a `Project` entity. The comment says "no domain entity yet." This is inconsistent with the other repos and violates the pattern where mapping logic lives in the domain entity.

**ISSUE [low]:** `PgUserRepo` and `PgApiKeyRepo` also use inline `fromRow()` functions. No domain entities exist for User or ApiKey. While these are simpler models, they should follow the same pattern for consistency.

**Recommendation:** Create `Project`, `User`, and `ApiKey` entities in `src/domain/entities/` with `fromRow()`/`toRow()` static/instance methods.

### 4. PgRunRepo.takeNext() uses FOR UPDATE SKIP LOCKED correctly

**PASS**

The implementation is correct and follows the prescribed pattern from ADR #5:

1. Acquires a dedicated client from the pool (`pool.connect()`)
2. Opens a transaction (`BEGIN`)
3. Selects the oldest queued run with `FOR UPDATE SKIP LOCKED`
4. Updates status to `'running'` and sets `started_at`
5. Commits the transaction
6. Releases the client in a `finally` block
7. On error: rolls back and re-throws

One subtle detail done well: the row object is mutated with the new status/started_at before calling `Run.fromRow()`, so the returned entity matches the DB state.

**Note:** The test at line 113-129 in `PgRunRepo.test.js` correctly validates concurrent dequeue behavior via `Promise.all`.

### 5. DRY: no duplicated query patterns across repos

**PASS**

Each repo has its own queries tailored to its table. The upsert pattern (`INSERT ... ON CONFLICT DO UPDATE`) is repeated but with different columns for each table — this is inherent to the approach and not harmful duplication. Extracting a generic upsert helper would add complexity without benefit (YAGNI).

No unnecessary abstractions or base classes. Each repo is standalone. This is appropriate for the current scale.

### 6. KISS: no overengineering

**PASS**

- `pg.js` is a minimal singleton pool — 3 functions, ~50 lines. No unnecessary abstraction.
- Repos use raw `pg` queries (no query builder despite Knex being in the tech stack). This is simpler and acceptable for the current query complexity. If queries grow more complex, consider introducing Knex.
- `fileRoleLoader.js` is straightforward: read files, parse YAML frontmatter, construct Role objects. Good error messages with filename context.
- No repository base class, no generic patterns, no unnecessary indirection.

### 7. SOLID: each repo = one responsibility, implements port interface

**PASS (with caveats on User/ApiKey)**

- Each Pg*Repo has a single responsibility: persistence for one aggregate/entity.
- Task, Run, Session, Project repos correctly implement their port interfaces via `extends`.
- User and ApiKey repos fulfill SRP but lack the interface segregation (no port defined).

### 8. Naming: camelCase files, PascalCase classes

**PASS**

- Files: `pg.js`, `PgTaskRepo.js`, `PgRunRepo.js`, `PgSessionRepo.js`, `PgProjectRepo.js`, `PgUserRepo.js`, `PgApiKeyRepo.js`, `fileRoleLoader.js` — all camelCase (Pg prefix is class-name convention, acceptable).
- Classes: `PgTaskRepo`, `PgRunRepo`, `PgSessionRepo`, `PgProjectRepo`, `PgUserRepo`, `PgApiKeyRepo` — all PascalCase.
- `fileRoleLoader.js` exports named functions (`loadRoles`, `parseRoleFile`), not a class — consistent with the module being a utility, not a service.

---

## Test Coverage Assessment

**Overall: Good**

All 7 test files are present. Tests are integration tests against a real PostgreSQL database, gated by `describe.skipIf(!DATABASE_URL)`.

Strengths:
- Each repo test covers CRUD operations (save, find, update, delete)
- `takeNext()` has 3 tests: basic dequeue, empty queue, concurrent dequeue (SKIP LOCKED)
- FileRoleLoader tests cover both unit (parseRoleFile) and integration (loadRoles from real files)
- Proper cleanup in `afterAll`/`beforeEach` — no test pollution
- FK dependencies set up correctly in beforeAll (project for tasks, task for runs, user for api_keys)

Missing test scenarios:
- No test for `PgProjectRepo.delete()` (though the port doesn't define delete, so this is fine)
- No negative test for `PgUserRepo.save()` with duplicate ID (upsert behavior is implicitly tested)
- FileRoleLoader: no test for empty directory or directory with non-.md files (edge cases)

---

## Issues Summary

| # | Severity | Description | File(s) |
|---|----------|-------------|---------|
| 1 | Medium | `PgUserRepo` and `PgApiKeyRepo` do not extend a port interface. No `IUserRepo`/`IApiKeyRepo` defined in domain. | `PgUserRepo.js`, `PgApiKeyRepo.js`, `src/domain/ports/` |
| 2 | Medium | `PgProjectRepo` uses inline `fromRow()`/`toRow()` instead of a `Project` entity. Inconsistent with Task/Run/Session repos. | `PgProjectRepo.js` |
| 3 | Low | `PgUserRepo` and `PgApiKeyRepo` use inline `fromRow()` — no domain entities for User/ApiKey. | `PgUserRepo.js`, `PgApiKeyRepo.js` |

---

## Verdict

**APPROVED** — the core persistence layer (Task, Run, Session repos + pg pool + FileRoleLoader) is solid, correctly follows DDD port-adapter pattern, and the queue mechanism is properly implemented. The issues found are structural gaps (missing ports/entities for User, ApiKey, Project) that should be addressed but do not block the sprint.

### Recommended follow-up:
1. Create `IUserRepo.js`, `IApiKeyRepo.js` port interfaces in `src/domain/ports/`.
2. Create `Project.js`, `User.js`, `ApiKey.js` entities in `src/domain/entities/` with `fromRow()`/`toRow()`.
3. Update `PgProjectRepo`, `PgUserRepo`, `PgApiKeyRepo` to extend their ports and use entity mapping.
