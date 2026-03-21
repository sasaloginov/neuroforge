# Security Review — Sprint 3: Persistence Layer

**Reviewer:** reviewer-security
**Date:** 2026-03-21
**Status:** PASS (with recommendations)

---

## Scope

| File | Path |
|------|------|
| pg.js | `src/infrastructure/persistence/pg.js` |
| PgTaskRepo.js | `src/infrastructure/persistence/PgTaskRepo.js` |
| PgRunRepo.js | `src/infrastructure/persistence/PgRunRepo.js` |
| PgSessionRepo.js | `src/infrastructure/persistence/PgSessionRepo.js` |
| PgProjectRepo.js | `src/infrastructure/persistence/PgProjectRepo.js` |
| PgUserRepo.js | `src/infrastructure/persistence/PgUserRepo.js` |
| PgApiKeyRepo.js | `src/infrastructure/persistence/PgApiKeyRepo.js` |
| knexfile.js | `src/infrastructure/persistence/knexfile.js` |
| migration | `src/infrastructure/persistence/migrations/20260321_001_initial_schema.js` |
| fileRoleLoader.js | `src/infrastructure/roles/fileRoleLoader.js` |

---

## 1. SQL Injection

**Verdict: PASS**

All SQL queries across every `Pg*Repo.js` file use parameterized queries with positional placeholders (`$1`, `$2`, ...). No string concatenation or template literal interpolation is used to build SQL.

Specific verification:

- **PgTaskRepo.findByProjectId** — dynamic `AND status = $N` filter is built with positional parameter index (`$${params.length}`), not string interpolation of the value itself. The filter value is pushed into the params array. This is safe.
- **PgRunRepo.takeNext** — uses a hardcoded string literal `'queued'` in the WHERE clause, not user input. Safe.
- All `save()` methods use `INSERT ... ON CONFLICT ... DO UPDATE` with parameterized values. Safe.

No issues found.

---

## 2. Connection Pool & Credentials

**Verdict: PASS with recommendations**

### What is done correctly
- `pg.js` accepts `connectionString` as a parameter, not hardcoded.
- `knexfile.js` reads from `process.env.DATABASE_URL` via `dotenv/config`.
- Pool error handler logs only `err.message`, not the full error object (avoids leaking stack traces with connection details in default logging).

### Recommendations

- **[SEC-POOL-01] Pool size limits missing in pg.js.** The `new Pool({ connectionString })` call passes no `max` / `idleTimeoutMillis` / `connectionTimeoutMillis` settings. The `node-pg` defaults are `max: 10`, which is fine, but explicit limits would prevent accidental resource exhaustion if the code is later changed. The knexfile sets `pool.max: 5` for migrations, but the runtime pool in `pg.js` does not.
  - **Severity:** Low
  - **Action:** Add explicit `max`, `idleTimeoutMillis`, and `connectionTimeoutMillis` to the Pool constructor.

- **[SEC-POOL-02] No SSL configuration.** `pg.js` does not set `ssl: { rejectUnauthorized: true }` or any TLS options. If PostgreSQL is accessed over a network (not localhost), credentials travel in plaintext.
  - **Severity:** Medium (environment-dependent)
  - **Action:** Add SSL config gated on an env variable (e.g., `PG_SSL=true`).

---

## 3. File Operations — Path Traversal in fileRoleLoader

**Verdict: PASS with one recommendation**

### What is done correctly
- `loadRoles(rolesDir)` calls `readdir(rolesDir)` to enumerate files, then filters to `.endsWith('.md')`.
- File paths are constructed with `join(rolesDir, file)` where `file` comes from `readdir` output, not from user input.
- Since `readdir` returns only direct children (no recursive traversal), and the filenames originate from the filesystem itself rather than from an external request, there is no path traversal vector in the current design.

### Recommendation

- **[SEC-FILE-01] Validate that rolesDir is an absolute path.** If `rolesDir` were ever set from user input (currently it is not), a relative path could resolve unexpectedly. A defensive check would be:
  ```js
  if (!path.isAbsolute(rolesDir)) throw new Error('rolesDir must be absolute');
  ```
  - **Severity:** Low (defense-in-depth)

---

## 4. Error Handling & Information Leakage

**Verdict: PASS with recommendations**

### What is done correctly
- `pg.js` pool error handler logs only `err.message`.
- `fileRoleLoader.js` throws errors with the filename but does not leak filesystem paths beyond the role filename itself.

### Findings

- **[SEC-ERR-01] PgRunRepo.takeNext re-throws raw database errors.** The `catch` block does `throw err`, which may propagate a `pg` error object containing the SQL query text, connection info, or internal state up to the HTTP layer. If Fastify's error handler does not sanitize this, it could reach the client.
  - **Severity:** Medium
  - **Action:** Wrap the thrown error in a domain-specific error (e.g., `throw new Error('Failed to dequeue run')`) or ensure the HTTP layer has a global error handler that strips internal details. Log the original error server-side.

- **[SEC-ERR-02] No error wrapping in any other repo method.** All `findById`, `save`, `delete` methods let `pg` errors propagate raw. Same risk as above.
  - **Severity:** Medium
  - **Action:** Implement a centralized error handler at the HTTP/Fastify layer that catches all errors and returns only a generic message to the client. Log full errors server-side with a correlation ID.

---

## 5. FOR UPDATE SKIP LOCKED — Race Conditions

**Verdict: PASS**

`PgRunRepo.takeNext()` correctly implements the atomic dequeue pattern:

1. `BEGIN` transaction.
2. `SELECT ... WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED` — locks the row, skips already-locked rows.
3. `UPDATE ... SET status = 'running'` within the same transaction.
4. `COMMIT`.
5. `ROLLBACK` on error.
6. `client.release()` in `finally`.

This is the standard PostgreSQL queue pattern and is race-condition-free. Multiple concurrent workers calling `takeNext()` will each get a different row (or null if queue is empty).

No issues found.

---

## 6. Input Validation on Repo Methods

**Verdict: NEEDS IMPROVEMENT**

### Findings

- **[SEC-VAL-01] No input validation in any repo method.** None of the `findById(id)`, `save(entity)`, `delete(id)` methods validate their inputs before passing them to SQL. For example:
  - `findById(undefined)` will execute `SELECT * FROM tasks WHERE id = $1` with `[undefined]`, which `node-pg` converts to `NULL`. This is safe from SQL injection but may produce confusing results.
  - `save()` with missing fields will result in a database-level constraint violation, but the error will be a raw `pg` error (see SEC-ERR-02).
  - **Severity:** Low
  - **Action:** Input validation should happen at the domain/application layer (use-case level), not in the repos. Verify that the calling code (use cases) validates IDs and entity completeness before calling repo methods. Repos are internal infrastructure and can trust their callers if the architecture is enforced.

- **[SEC-VAL-02] PgTaskRepo.findByProjectId accepts arbitrary status filter.** The `filters.status` value is parameterized (safe from injection), but there is no validation that it matches a known task status. An invalid status simply returns zero rows, so this is a correctness issue rather than a security issue.
  - **Severity:** Informational

---

## 7. Migration Schema Review

**Verdict: PASS**

- Foreign keys with `ON DELETE CASCADE` are set appropriately (users -> api_keys, projects -> sessions/tasks).
- `key_hash` column has a `UNIQUE` constraint and an index, which is correct for auth lookup.
- UUID primary keys use `gen_random_uuid()`, which is cryptographically random.
- String columns have explicit length limits (`name(128)`, `status(32)`, `role_name(64)`), preventing unbounded input storage.

---

## Summary

| ID | Finding | Severity | Status |
|----|---------|----------|--------|
| SEC-POOL-01 | No explicit pool size limits in pg.js | Low | Recommendation |
| SEC-POOL-02 | No SSL/TLS configuration for PG connection | Medium | Recommendation |
| SEC-FILE-01 | No absolute-path assertion in loadRoles | Low | Recommendation |
| SEC-ERR-01 | Raw DB errors re-thrown in takeNext | Medium | Recommendation |
| SEC-ERR-02 | No error wrapping in repo methods globally | Medium | Recommendation |
| SEC-VAL-01 | No input validation in repo methods | Low | Recommendation |
| SEC-VAL-02 | No status enum validation in findByProjectId | Informational | Recommendation |

**Critical / High findings: 0**
**Medium findings: 3** (SEC-POOL-02, SEC-ERR-01, SEC-ERR-02)
**Low findings: 3**
**Informational: 1**

## Verdict

**PASS.** The persistence layer is well-written from a security standpoint. All SQL is parameterized, the queue pattern is correctly implemented, and file operations are not vulnerable to path traversal. The medium-severity items (SSL config and error leakage) should be addressed before production deployment but are not blockers for continued development.
