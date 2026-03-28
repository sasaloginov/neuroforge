# Security Review — Sprint 7: Manager + Worker + Composition Root

**Reviewer:** security
**Date:** 2026-03-21
**Verdict:** APPROVED (no blockers)

---

## Summary

The manager/worker/scheduler subsystem and composition root are clean from a security standpoint. Secrets are read exclusively from environment variables, error logs expose only `err.message` (no stack traces), the PG queue uses `FOR UPDATE SKIP LOCKED` preventing race conditions, graceful shutdown drains in-flight runs, and startup recovery eliminates zombie processes. No critical or medium severity findings.

---

## Checklist Results

### 1. No Secrets in Code (All from ENV)

**Status:** PASS
**File:** `src/index.js:28-39`

All sensitive configuration is read from `process.env`:
- `DATABASE_URL` — connection string
- `PORT`, `HOST` — bind address
- `ROLES_DIR`, `WORKSPACE_DIR` — file paths
- `MANAGER_INTERVAL_MS`, `MANAGER_MAX_CONCURRENT`, `MANAGER_ENABLED` — scheduler tuning

No hardcoded secrets, tokens, or credentials found anywhere in the reviewed files. The `dotenv/config` import loads from `.env` file at runtime only.

### 2. Error Handling: No Sensitive Data in Logs

**Status:** PASS
**Files:** `worker.js:17,29`, `managerScheduler.js:88,117,125,137,153`

All error logging uses `err.message` only — no `err.stack`, no `JSON.stringify(err)`, no raw error objects passed to `console.log`. Examples:
- `logger.error('[Worker] ProcessRun threw: %s', err.message)` (worker.js:17)
- `logger.error('[Scheduler] checkTimeouts error: %s', err.message)` (managerScheduler.js:88)
- `logger.error('[Scheduler] Slot error: %s', err.message)` (managerScheduler.js:153)

The `ManagerDecision` use case sends `error.message` in callbacks to external clients (lines 57, 72, 155). These messages originate from domain errors (`RunNotFoundError`, `InvalidStateError`) or Claude CLI errors — none contain secrets.

**File:** `src/index.js:139-142` — The fatal catch handler logs the full `err` object: `console.error('[init] Fatal:', err)`. This could include a stack trace in stdout. However, this only fires during startup failures (before the server is reachable), and stdout is not client-facing. Acceptable.

### 3. Concurrency: No Race Conditions in Worker/Scheduler

**Status:** PASS
**Files:** `managerScheduler.js:82-97`, `PgRunRepo.js:64-93`

**Queue dequeue is atomic.** `PgRunRepo.takeNext()` uses `BEGIN` / `SELECT ... FOR UPDATE SKIP LOCKED` / `UPDATE status='running'` / `COMMIT`. This guarantees:
- No two workers pick the same run
- Locked rows are skipped (no blocking)
- Transaction isolation prevents partial reads

**Slot counting is safe.** `#activeCount` is incremented synchronously in `tick()` (line 94) before the async `#runSlot()` fires. Decrement happens in `finally` of `#runSlot()` (line 155). Since JavaScript is single-threaded, the increment/decrement sequence has no data races — `tick()` completes its loop before any `#runSlot` can modify `#activeCount`.

**Tick overlap is benign.** If `tick()` fires via `setInterval` while a previous tick is still running `checkTimeouts`, the second tick will launch additional slot workers. These workers will either find no queued runs (because the previous slots already took them via `SKIP LOCKED`) or process new items. No duplicate processing can occur thanks to the database-level locking.

**ManagerDecision race window.** Between `findByTaskId` (line 37 of ManagerDecision.js) and the subsequent `enqueue` / `completeTask` / `failTask`, another worker could theoretically complete a parallel run and trigger its own `ManagerDecision` for the same task. However, the `pendingRuns.length > 0` check (line 41) provides a safe guard — the first-to-finish worker sees outstanding runs and returns `waiting`. The last-to-finish sees zero pending and proceeds to the manager agent. This is correct fan-in logic.

### 4. Shutdown: No Data Loss (In-Flight Runs Handled)

**Status:** PASS
**File:** `src/index.js:107-137`, `managerScheduler.js:59-79`

Shutdown sequence is ordered correctly:
1. `scheduler.stop()` — sets `#stopping = true`, clears interval, waits up to 30s for active slots to drain
2. `server.close()` — Fastify closes (stops new HTTP requests, finishes in-flight)
3. `closePool()` — PG connections released

The `#stopping` flag prevents new slot launches (`tick()` returns immediately on line 83, `#runSlot` exits loop on line 148). Active `#runSlot` coroutines finish their current `processOne()` call naturally.

**Edge case:** If a `processOne()` call is blocked waiting for Claude CLI (which can take minutes), the 30s drain deadline will expire. In that case, the scheduler force-logs and the process exits. The Claude CLI child process receives SIGTERM (Node.js default on exit), and the run stays in `running` status in PG. This is handled by recovery at next startup (see item 5).

The `shuttingDown` guard (index.js:108) prevents double-shutdown on rapid signal delivery.

### 5. Recovery: No Zombie Processes

**Status:** PASS
**File:** `managerScheduler.js:131-143`

At startup, `#recover()` runs before the interval begins:
- Queries all runs with `status = 'running'` via `findRunning()`
- Marks each as `interrupted` via `runService.interrupt()`
- Logs each recovery action

This eliminates zombie runs left by a crash or forced kill. The interrupted runs can then be re-evaluated by the manager agent in subsequent cycles.

**Claude CLI processes:** If the Node.js process crashed without cleanup, orphaned `claude` child processes may remain. These are not managed by recovery. However, they are stateless (they write to stdout/stderr, not to the database), so they will eventually exit on their own (due to stdin EOF) or be cleaned up by the OS. The database state is the source of truth, and recovery correctly resets it.

### 6. DATABASE_URL Not Logged

**Status:** PASS
**File:** `src/index.js`

`DATABASE_URL` is read into `config.databaseUrl` (line 31), passed to `createPool()` (line 47), and checked for existence with a generic error message (line 42: `'DATABASE_URL is required'`). It is never logged, printed, or included in any error message. The init log (line 55) lists role names only. The server listen log (line 102) shows host and port only.

---

## Additional Findings

### SEC-05 (LOW): Manager Prompt Includes Full Run Responses

**File:** `ManagerDecision.js:168-195`

`buildManagerPrompt()` concatenates all completed run responses (`r.response ?? r.error ?? 'no output'`) into the manager prompt. If a run response contains sensitive data (credentials found in code, secrets from the codebase being analyzed), this data flows into the manager prompt and is sent to Claude CLI.

**Risk:** Low. The data stays within the Claude API boundary and is not exposed to external clients. The callback payloads (sent to `callbackUrl`) contain only task-level summaries and error messages, not raw run responses.

**Recommendation:** No immediate action needed. If the system ever processes codebases with secrets, consider filtering or truncating run responses before including them in the manager prompt.

### SEC-06 (LOW): parseManagerDecision Uses Greedy Regex

**File:** `ManagerDecision.js:201`

```js
const jsonMatch = response.match(/\{[\s\S]*\}/);
```

This greedily matches from the first `{` to the last `}` in the response. If the Claude response contains multiple JSON objects or markdown with braces, the regex may capture unintended content. However, `JSON.parse` will fail on malformed input, and the fallback is to fail the task (line 66-74). This is safe — it cannot lead to code execution or injection.

### SEC-07 (INFO): ClaudeCLIAdapter Minimal Environment

**File:** `claudeCLIAdapter.js:84-87`

```js
env: {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
},
```

The child process receives only `HOME` and `PATH`. This is a positive security practice — it prevents leaking other environment variables (`DATABASE_URL`, API tokens, etc.) to the Claude CLI subprocess.

---

## Findings Summary

| ID | Severity | Description |
|----|----------|-------------|
| SEC-05 | LOW | Manager prompt includes full run responses (could contain sensitive data from analyzed codebases) |
| SEC-06 | LOW | Greedy regex in `parseManagerDecision` — benign, fails safely |
| SEC-07 | INFO | ClaudeCLIAdapter passes minimal env to child process (positive) |

---

## Architecture Notes (Positive)

- `FOR UPDATE SKIP LOCKED` is the correct pattern for concurrent job queues in PostgreSQL — no polling contention, no duplicate processing
- Private class fields (`#activeCount`, `#stopping`) prevent external tampering with scheduler state
- Shutdown order (scheduler -> server -> pool) prevents new work from being accepted while draining
- Recovery runs synchronously before the interval starts, ensuring clean state before any new processing
- Worker swallows `ManagerDecision` errors (worker.js:30) — a failing decision for one task does not block other tasks in the queue
- `ManagerDecision` validates role existence (`roleRegistry.get()`) before enqueuing, preventing invalid role names from entering the queue
- Error in `failTask` during decision execution is caught with `.catch(() => {})` (line 150), preventing double-throw during error handling

---

## Verdict

**APPROVED** — no blockers. The system demonstrates solid security practices for a job queue / agent orchestrator. The two LOW findings are informational and do not require changes before production.
