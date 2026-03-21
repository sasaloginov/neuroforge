# Sprint 7 — Manager + Worker + Composition Root: Research Context

## 1. Existing Codebase Summary

### 1.1 Use Cases (Application Layer)

**ProcessRun** (`src/application/ProcessRun.js`)
- Constructor: `{ runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender }`
- `execute()` — no arguments, returns `{ run, result } | null`
- Flow: `runRepo.takeNext()` (atomic dequeue via FOR UPDATE SKIP LOCKED) -> resolves role, session -> `chatEngine.runPrompt()` -> `runService.complete()` -> sends callback
- On timeout: `runService.timeout(run.id)`
- On error: `runService.fail(run.id, error.message)`
- Returns `null` when queue is empty

**ManagerDecision** (`src/application/ManagerDecision.js`)
- Constructor: `{ runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo }`
- `execute({ completedRunId })` — takes ID of the completed run
- Checks if completed run is in terminal state (done/failed/timeout)
- Checks for pending parallel runs (queued/running) — if any, returns `{ action: 'waiting' }`
- Builds manager prompt with full task context + run history
- Calls `chatEngine.runPrompt('manager', ...)` for LLM decision
- Parses JSON decision: `spawn_run | ask_owner | complete_task | fail_task`
- For `spawn_run`: validates role, checks revision limit for developer re-runs, enqueues new run
- Returns `{ action, details }`

**CreateTask** (`src/application/CreateTask.js`)
- Creates task + enqueues first run (analyst role) -> advances task to in_progress

**ReplyToQuestion** (`src/application/ReplyToQuestion.js`)
- Resumes task after owner reply, enqueues new run with reply context

### 1.2 Domain Services

**RunService** (`src/domain/services/RunService.js`)
- `enqueue({ taskId, stepId, roleName, prompt, callbackUrl, callbackMeta })` — creates Run entity, saves
- `start(runId, sessionId)` — transitions queued -> running
- `complete(runId, response)` — running -> done
- `fail(runId, error)` — running -> failed
- `timeout(runId)` — running -> timeout
- `interrupt(runId)` — running -> interrupted

**TaskService** (`src/domain/services/TaskService.js`)
- CRUD + state transitions for tasks
- `advanceTask`, `requestReply`, `resumeAfterReply`, `completeTask`, `failTask`, `cancelTask`
- `incrementRevision` — with MAX_REVISIONS=5 limit

**RoleRegistry** (`src/domain/services/RoleRegistry.js`)
- `register(role)`, `get(name)`, `has(name)`, `getAll()`
- Roles loaded from `roles/*.md` via FileRoleLoader

### 1.3 Infrastructure

**PgRunRepo** (`src/infrastructure/persistence/PgRunRepo.js`)
- `takeNext()` — atomic dequeue: BEGIN -> SELECT ... FOR UPDATE SKIP LOCKED -> UPDATE status='running', started_at=now -> COMMIT -> returns Run
- `findRunning()` — all runs with status='running', ordered by started_at
- `findById(id)`, `findByTaskId(taskId)`, `save(run)`

**PG Pool** (`src/infrastructure/persistence/pg.js`)
- Singleton pattern: `createPool(connectionString)`, `getPool()`, `closePool()`
- `closePool()` — await pool.end(), nullifies singleton

**ClaudeCLIAdapter** (`src/infrastructure/claude/claudeCLIAdapter.js`)
- `runPrompt(roleName, prompt, { sessionId, signal, timeoutMs })`
- Spawns `claude --print` with role config (model, systemPrompt, allowedTools)
- Built-in timeout: SIGTERM at timeoutMs, SIGKILL at timeoutMs + killDelayMs
- Returns `{ response, sessionId }`
- Constructor takes `{ roleRegistry, workDir, logger, killDelayMs }`

**CallbackClient** (`src/infrastructure/callback/callbackClient.js`)
- `send(callbackUrl, payload, callbackMeta)` — HTTP POST with retries (3 attempts, exponential backoff)
- Never throws (callback failure is non-fatal)

**FileRoleLoader** (`src/infrastructure/roles/fileRoleLoader.js`)
- `loadRoles(rolesDir)` — reads `roles/*.md`, parses YAML frontmatter, returns `Role[]`

**HTTP Server** (`src/infrastructure/http/server.js`)
- `createServer({ useCases, repos, logger })` — returns Fastify instance
- Registers auth middleware, routes (task, project, admin), error handler
- `repos` needs: `apiKeyRepo`, `userRepo`

### 1.4 Existing Config (.env.example)

```
DATABASE_URL=postgresql://bot:bot@localhost:5432/neuroforge
CLAUDE_MODEL=opus
PORT=3000
MANAGER_INTERVAL_MS=10000
MANAGER_MAX_CONCURRENT=3
MANAGER_ENABLED=true
WORKSPACE_DIR=/root/dev
```

### 1.5 No `src/index.js` Exists Yet

The composition root is not yet created. The `src/infrastructure/scheduler/` directory does not exist yet either.

---

## 2. Chain Analysis: ProcessRun -> ManagerDecision

### Flow

1. **CreateTask** enqueues first run (analyst) with status `queued`
2. **Worker** calls `ProcessRun.execute()`:
   - `takeNext()` atomically dequeues one run (queued -> running)
   - Runs Claude CLI via `chatEngine.runPrompt()`
   - On success: `runService.complete(run.id, response)` (running -> done)
   - On failure: `runService.fail()` or `runService.timeout()`
3. **Worker** then calls `ManagerDecision.execute({ completedRunId: run.id })`:
   - Loads completed run, checks it's terminal
   - Checks for other pending runs on same task -> waits if any
   - Calls manager LLM for next-step decision
   - `spawn_run` -> enqueues new run (goes back to step 2)
   - `complete_task` -> task done, sends callback
   - `fail_task` -> task failed
   - `ask_owner` -> task waiting_reply (paused)

### Key Insight

The worker must call ManagerDecision **after every completed run** (success or failure), because the manager decides what to do next. The manager handles parallel run coordination internally (checks for pending runs before making decisions).

### Edge Cases

- ProcessRun returns `null` when queue is empty — worker should not call ManagerDecision
- ProcessRun returns `{ run, result }` where `run.taskId` may be null (standalone runs) — ManagerDecision should be skipped for taskless runs
- ManagerDecision can throw on invalid state — worker must handle gracefully

---

## 3. Concurrency Control

### Requirements
- `MANAGER_MAX_CONCURRENT` (default 3) — maximum simultaneous runs being processed
- Server has 2 CPU / 3.8 GB RAM — resource constraints are real

### Implementation Strategy

The worker should maintain a **semaphore/counter** of active workers:
- On each tick, check `activeCount < MANAGER_MAX_CONCURRENT`
- If capacity available, spawn one worker task per available slot
- Each worker task: `ProcessRun.execute()` -> `ManagerDecision.execute()` if applicable
- Decrement counter when done

**Recommended approach:** Use a simple counter + Promise tracking.

```
activeWorkers = 0
maxConcurrent = MANAGER_MAX_CONCURRENT

tick():
  while (activeWorkers < maxConcurrent):
    activeWorkers++
    processOne().finally(() => activeWorkers--)
```

No need for OS-level workers or child processes — all runs share the Node.js event loop. The actual CPU work happens in spawned `claude` CLI processes (child processes managed by ClaudeCLIAdapter), so the Node.js process is I/O-bound.

### FOR UPDATE SKIP LOCKED

The atomic dequeue in `takeNext()` already handles the concurrency at DB level. Even if multiple worker loops call `takeNext()` simultaneously, each will get a different run (or null). No double-processing risk.

---

## 4. Timeout Monitoring

### Current State
- `Role.timeoutMs` — each role has a timeout (set in frontmatter)
- `ClaudeCLIAdapter` already enforces timeout via SIGTERM/SIGKILL on the spawned process
- `ProcessRun` catches timeout errors and calls `runService.timeout(run.id)`
- `Run.startedAt` is set by `takeNext()` when transitioning to 'running'
- `PgRunRepo.findRunning()` returns all runs with status='running'

### Problem: CLI Timeout vs. Manager Timeout

The CLI adapter handles timeouts for normally running processes. But if the Node.js process itself crashes/restarts while a run is in 'running' status, the CLI process is orphaned and the run stays 'running' forever.

### Timeout Monitor Logic (in ManagerScheduler tick)

```
On each tick:
  runningRuns = runRepo.findRunning()
  for each run in runningRuns:
    role = roleRegistry.get(run.roleName)
    if (now - run.startedAt > role.timeoutMs):
      runService.timeout(run.id)
      // optionally send callback
```

### Important: Role Lookup for Timeout

The timeout value is per-role, stored in `Role.timeoutMs`. The monitor needs `roleRegistry` to look up the timeout for each running run. If a role is not found (deleted role definition), use a fallback (e.g., 5 minutes).

### Buffer Recommendation

Add a small buffer (e.g., 30 seconds) to avoid racing with the CLI adapter's own timeout mechanism. The CLI adapter might be in the process of killing the process. Check: `now - run.startedAt > role.timeoutMs + 30000`.

---

## 5. Recovery Strategy

### Requirements (ADR #25)
- At startup, find all runs with status='running' and mark as 'interrupted'
- Do NOT touch runs in 'queued' status (they'll be picked up normally)
- Do NOT touch tasks in 'waiting_reply' status

### Implementation

```
recovery():
  runningRuns = runRepo.findRunning()
  for each run in runningRuns:
    runService.interrupt(run.id)
    log("Interrupted orphaned run", run.id, run.roleName)
```

### Post-Interrupt Behavior

After marking runs as 'interrupted', the manager needs to re-evaluate each affected task. Two options:

**Option A (Simple, Recommended for Sprint 7):**
The ManagerDecision use case is designed to handle any terminal run. 'interrupted' is a terminal status in the Run entity. After recovery, for each interrupted run, trigger `ManagerDecision.execute({ completedRunId })`. The manager LLM will see the interrupted status and decide what to do (likely re-spawn the same role).

**Option B (ADR #25 exact spec):**
Create role-specific recovery: analyst/developer get recovery prompts with git diff context, reviewer/tester get clean restarts. This is more complex and can be deferred to a follow-up.

**Recommendation:** Go with Option A for Sprint 7 — mark as interrupted, then let ManagerDecision handle it. The `buildManagerPrompt` function already includes all run history with statuses, so the manager LLM will see `[developer] status=interrupted` and can decide appropriately.

**Caveat:** Need to verify that 'interrupted' is treated as terminal by ManagerDecision. Looking at the code: `terminalStatuses = ['done', 'failed', 'timeout']` — **'interrupted' is NOT included!** This needs to be fixed: add 'interrupted' to `terminalStatuses` in ManagerDecision, or the interrupted run will be rejected.

---

## 6. Graceful Shutdown Sequence

### Reference Pattern (from mybot/src/index.js)

```js
const shutdown = async (signal) => {
  console.log(`Received ${signal}, stopping...`);
  // 1. Stop accepting new work
  // 2. Stop timers/schedulers
  // 3. Close server (stop accepting HTTP requests)
  // 4. Wait for in-flight work (optional)
  // 5. Close database pool
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

### Neuroforge Shutdown Order

1. **Stop ManagerScheduler** — `scheduler.stop()`: clear interval, set `running = false`
2. **Wait for active workers** — let in-flight ProcessRun executions finish (with a deadline, e.g., 30 seconds). Running Claude CLI processes have their own timeouts, so we can't wait forever.
3. **Close Fastify server** — `app.close()`: stops accepting new HTTP requests, finishes in-flight requests
4. **Close PG pool** — `closePool()`: closes all connections

### In-Flight Worker Handling

Workers that are running Claude CLI processes at shutdown time:
- Option A: Let them finish (could take minutes) — risky with limited resources
- Option B: Set a shutdown deadline (30s), then force-kill — cleaner
- **Recommendation:** Set `stopping = true` flag. Workers check this flag before starting new runs. Existing runs continue. After a timeout (e.g., gracefulShutdownMs = 30000), force exit. On next startup, recovery will handle any interrupted runs.

---

## 7. ENV Configuration

### Required Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | (required) | PostgreSQL connection string |
| `PORT` | `3000` | HTTP server port |
| `MANAGER_INTERVAL_MS` | `10000` | Manager tick interval (ms) |
| `MANAGER_MAX_CONCURRENT` | `3` | Max parallel workers |
| `MANAGER_ENABLED` | `true` | Enable/disable manager scheduler |
| `WORKSPACE_DIR` | `/root/dev` | Root dir for project workspaces |
| `CLAUDE_MODEL` | `opus` | Default Claude model (used by ClaudeCLIAdapter if no role override) |
| `LOG_LEVEL` | `info` | Fastify log level |
| `ROLES_DIR` | `./roles` | Path to role definitions directory |

### Optional / Future

| Variable | Default | Description |
|---|---|---|
| `GRACEFUL_SHUTDOWN_MS` | `30000` | Max wait for in-flight work on shutdown |
| `RUN_MIGRATIONS` | `false` | Auto-run migrations on startup |
| `TIMEOUT_BUFFER_MS` | `30000` | Extra buffer for timeout monitoring |

---

## 8. Component Design

### 8.1 Worker (`src/infrastructure/scheduler/worker.js`)

```
createWorker({ processRun, managerDecision, logger })

Returns: { processOne() }

processOne():
  result = await processRun.execute()
  if (!result) return false  // queue empty

  { run } = result
  if (run.taskId):
    try:
      await managerDecision.execute({ completedRunId: run.id })
    catch (error):
      log error, don't re-throw

  return true  // processed a run
```

**Key design decisions:**
- Worker is a plain function/object, not a class with state
- Returns boolean: true if a run was processed, false if queue empty (useful for tick logic)
- ManagerDecision errors are caught and logged, never propagated (one failed decision should not crash the loop)
- Worker does NOT manage concurrency — that's ManagerScheduler's job

### 8.2 ManagerScheduler (`src/infrastructure/scheduler/managerScheduler.js`)

```
class ManagerScheduler {
  constructor({ worker, runRepo, runService, roleRegistry, config, logger })

  async start():
    await this.recover()       // mark orphaned running runs as interrupted
    this.timer = setInterval(() => this.tick(), config.intervalMs)

  stop():
    clearInterval(this.timer)
    this.stopping = true
    // return promise that resolves when all workers finish

  async recover():
    runs = await runRepo.findRunning()
    for (run of runs):
      await runService.interrupt(run.id)
      log("Recovered interrupted run", run.id)

  async tick():
    if (this.stopping) return
    await this.checkTimeouts()
    this.fillWorkerSlots()

  async checkTimeouts():
    runs = await runRepo.findRunning()
    for (run of runs):
      role = roleRegistry.get(run.roleName)  // with fallback
      elapsed = Date.now() - run.startedAt
      if (elapsed > role.timeoutMs + TIMEOUT_BUFFER):
        await runService.timeout(run.id)

  fillWorkerSlots():
    while (this.activeCount < this.maxConcurrent && !this.stopping):
      this.activeCount++
      worker.processOne()
        .catch(err => log(err))
        .finally(() => this.activeCount--)
```

**Key design decisions:**
- Recovery runs once at startup, before the interval starts
- Timeout checking happens on every tick, before spawning new workers
- `fillWorkerSlots` is non-blocking: fires off worker promises, doesn't await them
- `stopping` flag prevents new work during shutdown
- Timeout monitor adds a buffer to avoid racing with CLI adapter

### 8.3 Composition Root (`src/index.js`)

Startup sequence:

```
1. import 'dotenv/config'
2. Load config from ENV
3. createPool(DATABASE_URL)
4. (Optional) Run migrations
5. loadRoles(ROLES_DIR) -> RoleRegistry
6. Create repos: PgTaskRepo, PgRunRepo, PgSessionRepo, PgProjectRepo, PgUserRepo, PgApiKeyRepo
7. Create adapters: ClaudeCLIAdapter, CallbackClient
8. Create domain services: TaskService, RunService
9. Create use cases: CreateTask, ProcessRun, ManagerDecision, GetTaskStatus, CancelTask, ReplyToQuestion
10. Create Fastify server: createServer({ useCases, repos })
11. Create ManagerScheduler (if MANAGER_ENABLED)
12. Start server: app.listen({ port: PORT, host: '0.0.0.0' })
13. Start scheduler: scheduler.start() (runs recovery + begins ticking)
14. Register SIGINT/SIGTERM handlers for graceful shutdown
```

---

## 9. Dependency Map

```
Composition Root (src/index.js)
├── PG Pool (pg.js)
├── FileRoleLoader -> RoleRegistry
├── Repos
│   ├── PgTaskRepo
│   ├── PgRunRepo
│   ├── PgSessionRepo
│   ├── PgProjectRepo
│   ├── PgUserRepo
│   └── PgApiKeyRepo
├── Adapters
│   ├── ClaudeCLIAdapter  (needs: roleRegistry, workDir)
│   └── CallbackClient    (needs: logger)
├── Domain Services
│   ├── TaskService       (needs: taskRepo)
│   └── RunService        (needs: runRepo)
├── Use Cases
│   ├── CreateTask        (needs: taskService, runService, roleRegistry, projectRepo, callbackSender)
│   ├── ProcessRun        (needs: runRepo, runService, taskRepo, chatEngine, sessionRepo, roleRegistry, callbackSender)
│   ├── ManagerDecision   (needs: runService, taskService, chatEngine, roleRegistry, callbackSender, runRepo)
│   ├── GetTaskStatus     (needs: taskService)
│   ├── CancelTask        (needs: taskService, runRepo, callbackSender)
│   └── ReplyToQuestion   (needs: taskService, runService, runRepo, callbackSender)
├── HTTP Server
│   └── createServer      (needs: useCases, repos{apiKeyRepo, userRepo})
├── Worker                (needs: processRun, managerDecision, logger)
└── ManagerScheduler      (needs: worker, runRepo, runService, roleRegistry, config, logger)
```

---

## 10. Risks and Open Questions

### 10.1 Bug: 'interrupted' Not in ManagerDecision Terminal Statuses

`ManagerDecision.execute()` checks `terminalStatuses = ['done', 'failed', 'timeout']`. The status 'interrupted' is missing. If recovery marks a run as interrupted and then triggers ManagerDecision, it will throw `InvalidStateError`. **Fix needed:** add 'interrupted' to the `terminalStatuses` array.

### 10.2 Timeout Monitor vs. CLI Adapter Race

Both the CLI adapter and the timeout monitor can try to transition a run at the same time. The CLI adapter does `runService.timeout()` on timeout, and the monitor does the same. If both fire simultaneously, the second one will try to transition an already-terminal run and throw `InvalidTransitionError`. **Mitigation:** The timeout buffer (30s) should be sufficient. Additionally, the monitor should catch and ignore `InvalidTransitionError` on timeout operations.

### 10.3 Worker fillWorkerSlots Spin Protection

If `processOne()` returns immediately (queue empty), the `while (activeCount < maxConcurrent)` loop would spin: it fires off a promise, increments counter, fires another, etc. All promises resolve synchronously returning false. **Fix:** `fillWorkerSlots` should be async and await each `processOne()` check, OR use a simpler model where the tick spawns at most one worker per tick, OR check queue emptiness before entering the loop.

**Recommended fix:** Make `processOne()` return a boolean. If it returns false (empty queue), break the loop. Since `processOne()` is async and returns after actually completing the work, the loop naturally throttles:

```
async fillWorkerSlots():
  slotsAvailable = this.maxConcurrent - this.activeCount
  for (let i = 0; i < slotsAvailable; i++):
    this.activeCount++
    // Fire and forget — the finally decrements
    this.runWorker()

async runWorker():
  try:
    const didWork = await worker.processOne()
    if (didWork): this.runWorker()  // chain: keep working while queue has items
  finally:
    this.activeCount--
```

Better approach: start N long-lived worker loops at startup, each loops `processOne()` until queue empty, then waits for next tick.

### 10.4 No LISTEN/NOTIFY (Deferred)

ADR #3 mentions PG LISTEN/NOTIFY as the primary event mechanism, with polling as fallback. Sprint 7 implements polling only (setInterval). LISTEN/NOTIFY can be added later as optimization.

### 10.5 ClaudeCLIAdapter Constructor

The existing `ClaudeCLIAdapter` constructor takes `{ roleRegistry, workDir, logger, killDelayMs }`. This means `roleRegistry` must be created before the adapter. The adapter uses `roleRegistry.get(roleName)` internally in `runPrompt()`, but `ProcessRun` also calls `roleRegistry.get()` separately. No conflict here — both use the same registry instance.

### 10.6 Migration Auto-Run

Whether to run `knex migrate:latest` at startup is configurable via `RUN_MIGRATIONS`. For dev, auto-run is convenient. For production, it's risky. Default should be `false`.
