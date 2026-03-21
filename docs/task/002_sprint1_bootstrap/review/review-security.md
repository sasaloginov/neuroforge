# Security Review: Task 002

## Result: PASS (with Medium/Low findings)

## Summary

Sprint 1 bootstrap establishes a solid security foundation. No critical or high severity vulnerabilities found. The codebase correctly uses Knex parameterized queries, runs Docker containers as non-root, keeps `.env` out of Git, and stores API keys as hashes. Several medium and low findings require attention before production deployment.

## Attack Surface

| Surface | Component | Risk Level |
|---------|-----------|------------|
| HTTP API | Fastify (port 3000) | Medium — exposed externally |
| PostgreSQL | pg17 (port 5432) | Medium — exposed in docker-compose |
| Workspace volume | Host filesystem mount | High — agent can access host files |
| Claude CLI | child_process (future) | High — command injection vector |
| Callback URLs | HTTP POST to user-supplied URL | Medium — SSRF vector |

## Findings

### Critical

None.

### High

None.

### Medium

#### M1. PostgreSQL port exposed to host network

**File:** `docker-compose.yml:27`

```yaml
ports:
  - "${PG_PORT:-5432}:5432"
```

PostgreSQL is bound to all interfaces on the host. In production, the database should only be accessible from the application container via the Docker network, not from the host or external network.

**Recommendation:** Remove the `ports` mapping for postgres in production compose, or bind to `127.0.0.1:${PG_PORT:-5432}:5432`.

---

#### M2. Default database credentials are weak

**Files:** `docker-compose.yml:5`, `.env.example:2-4`

Database credentials are `bot:bot`. While acceptable for local development, there is no documentation or mechanism enforcing stronger credentials in staging/production environments.

**Recommendation:** Add a comment in `.env.example` noting these are dev-only defaults. Consider adding a startup check that rejects default credentials when `NODE_ENV=production`.

---

#### M3. Missing `.dockerignore` file

**File:** (absent)

Without `.dockerignore`, `COPY . .` in the Dockerfile copies `.env`, `.git/`, `node_modules/`, test files, and documentation into the production image. This leaks secrets and increases attack surface.

**Recommendation:** Create `.dockerignore` with at minimum:
```
.env
.git
node_modules
coverage
*.log
docs
```

---

#### M4. Workspace volume mounted with full host access

**File:** `docker-compose.yml:14`

```yaml
volumes:
  - ${WORKSPACE_DIR:-/root/dev}:/workspace
```

The agent container gets read-write access to the host filesystem under `/root/dev`. A compromised agent (or prompt injection via Claude CLI) could read/modify any project on the host.

**Recommendation:** Mount specific project directories read-only where possible. Consider using `:ro` for the base volume and only mounting the active project directory read-write. Document this risk for operations.

---

#### M5. No `callback_url` validation in schema

**File:** `migrations/20260321_001_initial_schema.js:49,81`

The `callback_url` field (in `tasks` and `runs` tables) is a plain `string(512)` with no domain or protocol restriction at the database level. This is an SSRF vector when the application eventually POSTs results to these URLs.

**Recommendation:** Implement allowlist-based URL validation in the application layer before sending callbacks. Restrict to HTTPS and known domains.

### Low

#### L1. No `key_hash` algorithm or length enforcement at DB level

**File:** `migrations/20260321_001_initial_schema.js:21`

`key_hash` is `string(256)`, which is correct for storing hex-encoded SHA-256 hashes (64 chars) or base64 (44 chars). However, there is no CHECK constraint to enforce minimum length or format. A bug in the application layer could store a plaintext key.

**Recommendation:** Add a CHECK constraint: `CHECK (length(key_hash) >= 44)` to prevent accidental plaintext storage.

---

#### L2. No `api_keys.revoked_at` or `is_active` column

**File:** `migrations/20260321_001_initial_schema.js:18-29`

There is `expires_at` but no mechanism to immediately revoke a key. If a key is compromised, the only option is to delete the row, losing audit trail.

**Recommendation:** Add `revoked_at timestamp` column. Check both `expires_at` and `revoked_at` during authentication.

---

#### L3. `status` fields lack CHECK constraints

**File:** `migrations/20260321_001_initial_schema.js` (multiple tables)

Status columns (`users.role`, `sessions.status`, `tasks.status`, `runs.status`) are plain strings with no enum or CHECK constraint. Invalid status values could be inserted, bypassing business logic assumptions.

**Recommendation:** Add CHECK constraints or use Knex `.enum()` for status fields.

---

#### L4. Developer role has `Bash` and `Write` tools combined

**File:** `roles/developer.md:9-12`

The developer agent has both `Bash` (arbitrary command execution) and `Write` (file creation) tools. This is intentional for a code-writing agent but represents the highest-privilege role. A prompt injection in the task description could lead to arbitrary command execution.

**Recommendation:** This is an accepted risk for the developer role. Ensure the manager role validates and sanitizes task descriptions before forwarding to the developer. Consider sandboxing Bash execution (e.g., restricted shell, seccomp profile).

---

#### L5. Default role has `Bash` tool

**File:** `roles/default.md:11`

The default/fallback role includes `Bash` access. This should be the most restrictive role, not one with shell access.

**Recommendation:** Remove `Bash` from the default role's `allowed_tools` or document why it is necessary.

---

#### L6. No `updated_at` trigger for automatic timestamp update

**File:** `migrations/20260321_001_initial_schema.js`

Tables with `updated_at` columns (`sessions`, `tasks`) set a default but have no trigger to auto-update on modification. The application must remember to update this field, and a bug could leave stale timestamps.

**Recommendation:** Add a PostgreSQL trigger for `updated_at` or document that the application layer is responsible.

## Checklist

| Check | Status | Notes |
|-------|--------|-------|
| No hardcoded secrets in code | PASS | Credentials via env vars |
| `.env` in `.gitignore` | PASS | Line 2 of `.gitignore` |
| Docker non-root user | PASS | `USER neuroforge` (uid 1001) |
| Minimal base image | PASS | `node:22-alpine` |
| No secrets in Dockerfile | PASS | No env vars or tokens in build |
| Multi-stage Docker build | PASS | deps stage separates build from runtime |
| SQL injection prevention (Knex) | PASS | Schema uses Knex builder, no raw SQL with user input |
| Proper FK constraints | PASS | All foreign keys defined with appropriate ON DELETE |
| `key_hash` not plaintext | PASS | Column is `key_hash`, not `key` |
| `.dockerignore` exists | **FAIL** | Missing (M3) |
| DB port not exposed externally | **WARN** | Exposed to host (M1) |
| Callback URL validation | **WARN** | No validation yet (M5) |
| Role timeout limits set | PASS | All roles have `timeout_ms` |
| No dangerous tool combos | **WARN** | Developer has Bash+Write (L4, accepted risk) |
| Dependencies — known CVEs | PASS | All deps are recent versions, no known CVEs at time of review |
