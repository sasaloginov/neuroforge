# Security Review — Sprint 6: HTTP API + Auth

**Reviewer:** security
**Date:** 2026-03-21
**Verdict:** APPROVED with findings (no blockers)

---

## Summary

The HTTP layer implements a solid authentication and authorization model: SHA-256 hashed API keys, project-scoped access, admin guards, JSON Schema validation on all mutation endpoints, and safe error handling. No critical vulnerabilities found. Several medium and low severity items are documented below.

---

## Checklist Results

### 1. Auth: Timing-Safe Comparison for Token Hashing

**Status:** NOT APPLICABLE / ACCEPTABLE
**Severity:** Info

The auth flow hashes the incoming token with SHA-256 and performs a database lookup by hash (`findByHash(keyHash)`). There is no string comparison of raw tokens in application code — the comparison happens in PostgreSQL's `WHERE key_hash = $1`. This is a database equality check on a fixed-length hex digest, which is not vulnerable to timing attacks in practice (the DB query time dwarfs any byte-by-byte comparison timing). No `timingSafeEqual` is needed here.

### 2. Token Generation Entropy

**Status:** PASS
**Files:** `adminRoutes.js:130`, `cli.js:29`

Token generation uses `randomBytes(32)` (256 bits of entropy from Node.js CSPRNG), prefixed with `nf_`. This provides excellent entropy — 256 bits is far above the recommended minimum of 128 bits for API tokens.

### 3. Bearer Token Extraction: Edge Cases

**Status:** PASS
**File:** `authMiddleware.js:13-21`

The middleware checks:
1. Header exists and starts with `'Bearer '` (with space)
2. Token after slicing is non-empty

Edge cases handled correctly:
- Missing header -> 401
- `"Bearer "` (empty token) -> 401
- `"Bearer"` (no space) -> 401 (fails `startsWith('Bearer ')`)
- `"bearer ..."` (lowercase) -> 401 (case-sensitive, correct per RFC 6750)

**Minor note:** A header like `"Bearer  token"` (double space) would pass with a token starting with a space. This is an extremely unlikely edge case and not a practical concern.

### 4. Scope Enforcement: Cross-Project Access

**Status:** PASS
**File:** `scopeHelpers.js:5-11`

`assertProjectScope` correctly blocks scoped keys from accessing other projects. Keys without `projectId` (null) are treated as global-scope. This is enforced on:
- `POST /tasks` — checks body.projectId
- `GET /tasks/:id` — checks result.task.projectId
- `POST /tasks/:id/reply` — loads task, checks projectId
- `POST /tasks/:id/cancel` — loads task, checks projectId
- `GET /projects/:name` — checks project.id
- `GET /projects/:name/tasks` — checks project.id
- `GET /projects` — scoped keys see only their project (line 89-93)

All task and project routes enforce scope. No bypass path found.

### 5. Admin Guards

**Status:** PASS with finding (MEDIUM)
**File:** `adminRoutes.js`

Admin-only routes correctly protected by `assertAdmin()`:
- `POST /users` — admin only
- `GET /users` — admin only
- `DELETE /users/:id` — admin only

**Finding SEC-01 (MEDIUM): `POST /api-keys` lacks admin guard.**
Any authenticated user can create API keys, including keys scoped to projects they may not own. A `member` user can create a key for any `projectId` they know the UUID of (line 117-151). The route only verifies the project exists, not that the user has access to it.

**Recommendation:** Either:
- Add `assertAdmin(request.user)` to `POST /api-keys`, or
- Add `assertProjectScope(request.apiKey, projectId)` to ensure the requesting key already has access to that project, or
- Let members only create unscoped keys and restrict scope assignment to admins.

**Finding SEC-02 (LOW): `GET /api-keys` returns all keys for current user regardless of role.**
This is fine — users seeing their own keys is expected. But an admin cannot list other users' keys. This is a functionality gap rather than a security issue.

### 6. Input Validation: JSON Schema

**Status:** PASS
**Files:** `taskRoutes.js`, `projectRoutes.js`, `adminRoutes.js`

All mutation endpoints have JSON Schemas with:
- `required` fields specified
- `additionalProperties: false` on all body schemas (prevents mass assignment)
- `format: 'uuid'` on all ID fields
- `maxLength` limits on strings (prevents oversized payloads)
- `minLength: 1` where appropriate (prevents empty strings)
- `enum` constraints on role values (`admin`, `member`) and task status filters
- `pattern: '^[a-z0-9_-]+$'` on project name (prevents injection)

**Finding SEC-03 (LOW): `callbackMeta` in `createTaskSchema` accepts any object without constraints.**
`callbackMeta: { type: 'object' }` allows arbitrarily deep/large nested objects. Could be used to store excessively large payloads.

**Recommendation:** Add `maxProperties` and/or a size limit, or validate at the application layer.

### 7. Error Responses: Information Leakage

**Status:** PASS
**File:** `errorHandler.js`

- 500 errors return generic `"Internal server error"` — no stack traces, no internal details
- Domain errors with 5xx codes also return generic message (line 33-35)
- 4xx domain errors return `error.message` which is controlled by the application
- Fastify validation errors return structured validation details (standard and safe)
- Unique constraint error on project name (line 71 in projectRoutes) leaks the project name back, but this is user-supplied input echoed back, which is acceptable

No stack traces or sensitive information leaked to clients.

### 8. API Key Storage

**Status:** PASS
**Files:** `adminRoutes.js:130-131`, `cli.js:29-30`, `ApiKey.js`

- Raw token is generated, hashed with SHA-256, and only the hash is stored in DB (`key_hash` column)
- Raw token is returned in the `201` response exactly once
- Subsequent `GET /api-keys` does NOT include the token or hash in the response (line 155-163)
- The `ApiKey` entity stores `keyHash`, never the raw token

### 9. CLI: Token Security

**Status:** PASS with note
**File:** `cli.js:38-39`

Token is printed to stdout with a clear warning: `"API Token (save it, shown only once)"`. This is the standard pattern (similar to GitHub, Stripe, etc.).

**Note:** The token will appear in terminal scrollback and possibly shell history (if the command itself is logged). This is acceptable for a CLI bootstrap tool — the operator is expected to handle the secret responsibly.

### 10. CORS Configuration

**Status:** FINDING (MEDIUM)
**File:** `server.js:22`

```js
await app.register(cors, { origin: true });
```

**Finding SEC-04 (MEDIUM): CORS allows all origins.**
`origin: true` reflects the requesting origin in `Access-Control-Allow-Origin`, effectively making the API accessible from any web page. If this API is intended for server-to-server use only (TG bot, CLI, webhooks as stated in CLAUDE.md), CORS should be disabled or restricted.

**Recommendation:** Either:
- Set `origin: false` (no CORS headers, blocks browser requests entirely), or
- Specify an explicit allowlist: `origin: ['https://admin.neuroforge.example']`

---

## Findings Summary

| ID | Severity | Description |
|----|----------|-------------|
| SEC-01 | MEDIUM | `POST /api-keys` allows any user to create keys scoped to any project |
| SEC-02 | LOW | Admin cannot list/manage other users' API keys |
| SEC-03 | LOW | `callbackMeta` body field has no size/depth constraints |
| SEC-04 | MEDIUM | CORS set to `origin: true`, allows all browser origins |

---

## Architecture Notes (Positive)

- Hash-based token lookup avoids storing raw secrets — good practice
- `additionalProperties: false` on all body schemas prevents mass assignment
- Auth middleware runs as `onRequest` hook, ensuring all routes (except `/health`) are protected
- Error handler cleanly separates 4xx (user-visible messages) from 5xx (generic responses)
- Scope checks are done at the route level before any mutations, preventing TOCTOU issues on create operations
- Project name pattern `^[a-z0-9_-]+$` prevents path traversal or injection via project names
- UUID format validation on all ID parameters prevents SQL injection via malformed IDs

---

## Verdict

**APPROVED** — no blockers. The two MEDIUM findings (SEC-01, SEC-04) should be addressed before production deployment but do not block further development.
