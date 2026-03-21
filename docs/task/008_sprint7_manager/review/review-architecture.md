# Architecture Review — Sprint 7: Manager + Worker + Composition Root

**Reviewer:** Аркадий (reviewer-architecture)
**Date:** 2026-03-21
**Verdict:** APPROVED with remarks

---

## Reviewed Files

| File | Role |
|---|---|
| `src/infrastructure/scheduler/worker.js` | Worker factory |
| `src/infrastructure/scheduler/managerScheduler.js` | Scheduler lifecycle |
| `src/index.js` | Composition Root / DI |
| `src/application/ManagerDecision.js` | Use case (with `interrupted` fix) |
| `src/infrastructure/scheduler/worker.test.js` | Worker tests |
| `src/infrastructure/scheduler/managerScheduler.test.js` | Scheduler tests |
| `src/application/ManagerDecision.test.js` | ManagerDecision tests |

---

## 1. DDD Compliance

### Dependency flow: PASS

`index.js` is the only DI point. The dependency graph is correct:

```
index.js (Composition Root)
  -> infrastructure/* (repos, adapters, scheduler)
  -> application/* (use cases)
  -> domain/* (entities, services, value objects)
```

- **Worker** (`infrastructure/scheduler/worker.js`) receives `processRun` and `managerDecision` (application use cases) via DI. It never imports domain or application modules directly. Correct.
- **ManagerScheduler** (`infrastructure/scheduler/managerScheduler.js`) receives `runRepo`, `runService`, `roleRegistry`, `worker` via DI. It does not import domain modules. Correct.
- **ManagerDecision** (`application/ManagerDecision.js`) imports only from `domain/errors/`. Correct.
- **Domain** (`RunService`, `Run` entity) imports nothing from application/infrastructure. Correct.

### Single composition root: PASS

All wiring happens in `src/index.js` steps 1-9. No service locator or hidden DI elsewhere.

---

## 2. Worker Design

### Delegation to use cases: PASS

`createWorker` is a thin factory returning `{ processOne() }`. It delegates entirely to `processRun.execute()` and `managerDecision.execute()`. No business logic in the worker itself.

### Error handling: PASS

- `ProcessRun` error: caught, logged, returns `false` (stops draining queue on this slot). Correct behavior -- avoids infinite retry of a broken run.
- `ManagerDecision` error: caught, logged, returns `true` (run was processed, continue). Correct -- the run itself succeeded, only the downstream decision failed.

### Remark (minor)

- The `run.taskId` guard on line 25 skips ManagerDecision for standalone runs (no task). This is correct for the current model where standalone runs are ad-hoc and have no orchestration context.

---

## 3. ManagerScheduler

### Start/stop lifecycle: PASS

- `start()`: runs `#recover()` first, then sets interval. Correct order -- stale runs are cleaned before new ticks begin.
- `stop()`: sets `#stopping = true`, clears interval, polls `#activeCount` with 200ms intervals and a 30s deadline. Force-stops with a warning if deadline exceeded. Clean and predictable.

### Concurrency control: PASS

- `#maxConcurrent` limits the number of simultaneous `#runSlot()` invocations.
- `tick()` calculates `slotsAvailable = maxConcurrent - activeCount` and launches exactly that many slots.
- Each slot increments `#activeCount` before the fire-and-forget call and decrements in `finally`. The counter is always consistent.

### Recovery: PASS

`#recover()` loads all `running` runs via `runRepo.findRunning()` and calls `runService.interrupt(run.id)` on each. The `Run` entity allows `running -> interrupted` transition. This correctly handles the case where the process crashed mid-execution.

### Timeout monitoring: PASS

`checkTimeouts()` uses `role.timeoutMs + TIMEOUT_BUFFER_MS (30s)` to determine if a run has exceeded its allowed time. The buffer prevents premature timeout when the CLI adapter is still within its own timeout window. Sensible.

Unknown roles are silently skipped (`try/catch` around `roleRegistry.get`). This is acceptable -- a run with an unknown role would have failed earlier at creation time.

### Remark: potential slot over-allocation

If `tick()` is called while previous slots are still running (e.g., a slow tick with a fast interval), `slotsAvailable` correctly accounts for `#activeCount`, so no over-allocation occurs. However, `setInterval` does not wait for `tick()` to complete. If `tick()` itself takes longer than `intervalMs`, multiple ticks can overlap. In practice this is benign because:

1. `checkTimeouts()` is idempotent (calling `timeout()` on an already-timed-out run throws, which is caught).
2. Slot allocation is bounded by `#activeCount`.

No action required, but worth documenting in a comment.

### Remark: `#runSlot` is fire-and-forget

`tick()` calls `this.#runSlot()` without awaiting it. This is intentional (concurrency), but if `#runSlot` throws synchronously before reaching the `try` block, the error would be unhandled. In the current implementation this cannot happen (the entire body is wrapped in try/catch), so this is safe.

---

## 4. Composition Root (`src/index.js`)

### Startup sequence: PASS

1. Config from ENV
2. PG pool
3. Roles loaded from filesystem
4. Repos instantiated
5. Adapters instantiated
6. Domain services instantiated
7. Use cases instantiated (with all deps)
8. HTTP server created and started
9. Worker + Scheduler created and started
10. Graceful shutdown registered

The order is correct. Server starts listening before the scheduler, which is the right choice -- the server must be ready to accept health checks/API calls before processing begins.

### Graceful shutdown: PASS

Shutdown order: scheduler.stop() -> server.close() -> closePool().

This is correct:
1. Stop the scheduler first (no new runs picked up, wait for active slots to drain).
2. Close the HTTP server (stop accepting new requests, let in-flight requests finish).
3. Close the PG pool last (all consumers are done).

The `shuttingDown` guard prevents double-shutdown from multiple signals. Correct.

### Remark: missing `unhandledRejection` handler

The main process catches fatal errors in `main().catch()`, but there is no global `unhandledRejection` handler. If a fire-and-forget promise rejects outside of the caught paths (e.g., a callback send failure in a code path that doesn't await), the process may log a warning but not crash. Consider adding:

```js
process.on('unhandledRejection', (err) => {
  console.error('[fatal] Unhandled rejection:', err);
  process.exit(1);
});
```

Severity: low. The current code is defensive with try/catch, so this is unlikely to occur.

---

## 5. ManagerDecision (bug fix: `interrupted` status)

### Terminal statuses: PASS

Line 25: `const terminalStatuses = ['done', 'failed', 'timeout', 'interrupted'];`

The `interrupted` status is correctly included in terminal statuses. This ensures that when a run is marked as interrupted during recovery, the subsequent ManagerDecision call (if any) correctly recognizes it as terminal and proceeds to evaluate the task's next step.

### Guard against non-terminal runs: PASS

Line 26: throws `InvalidStateError` if run is not terminal. This prevents ManagerDecision from being called on a still-running run.

### Callback handling: PASS

All branches (spawn_run, ask_owner, complete_task, fail_task) check `task.callbackUrl` before sending. No callback is sent when URL is null.

### Error resilience: PASS

- Chat engine failure: caught, task failed, callback sent.
- Unparseable response: caught, task failed, callback sent.
- Decision execution error (e.g., RevisionLimitError): caught with `failTask().catch(() => {})`, callback sent. The `.catch(() => {})` on `failTask` prevents double-failure if the task is already in a terminal state.

---

## 6. Tests

### Coverage: PASS

**Worker tests (5 cases):**
- Happy path (process + decision)
- Empty queue
- No taskId (skip decision)
- ManagerDecision error (graceful)
- ProcessRun error (graceful)

**Scheduler tests (8 cases):**
- Recovery at startup
- Disabled mode
- Tick launches slots
- Timeout detection
- Fresh run not timed out
- Stop waits for drain
- Force stop after 30s
- Tick no-op when stopping
- Unknown role skipped

**ManagerDecision tests (15 cases):**
- All 4 decision actions
- Pending parallel runs (waiting)
- Unparseable response
- Revision limit
- Terminal task states (cancelled, done, failed)
- Unknown role
- Run not found
- Non-terminal run state
- Chat engine crash
- No callback URL

Test quality is good. Mocks are minimal and focused. Fake timers are used correctly for scheduler tests.

### Remark: missing edge case

No test for scheduler behavior when `#recover()` throws (e.g., DB connection failure at startup). Currently `start()` would propagate the error to `main().catch()`, which is correct, but an explicit test would document this contract.

---

## 7. SOLID / DRY / KISS

| Principle | Assessment |
|---|---|
| **S** (Single Responsibility) | PASS. Worker processes runs. Scheduler manages lifecycle. ManagerDecision makes orchestration decisions. Clear boundaries. |
| **O** (Open/Closed) | PASS. New decision actions can be added to ManagerDecision's switch without modifying worker or scheduler. |
| **L** (Liskov Substitution) | PASS. All deps are injected via constructor; any conforming implementation can be substituted. |
| **I** (Interface Segregation) | PASS. Worker needs only `{ processOne() }`. Scheduler needs only `{ findRunning() }` from runRepo. Narrow interfaces. |
| **D** (Dependency Inversion) | PASS. All concrete deps injected at composition root. Domain services depend on repo abstractions (ports). |
| **DRY** | PASS. No duplicated logic across the three files. Callback send pattern repeats in ManagerDecision but each branch has distinct payload shape, so extraction would reduce clarity. |
| **KISS** | PASS. Worker is 37 lines. Scheduler is 172 lines. Both are straightforward with no unnecessary abstractions. |

---

## Summary

The implementation is clean, well-structured, and follows the project's DDD conventions. The dependency flow is correct, the composition root is the sole DI point, and the graceful shutdown sequence is properly ordered. Tests cover the critical paths.

### Issues Found: 0 blocking, 0 major

### Remarks (non-blocking):

1. **Low:** Consider adding an `unhandledRejection` handler in `index.js` for defense-in-depth.
2. **Low:** Consider adding a comment in `managerScheduler.js` noting that overlapping ticks are safe due to `#activeCount` guard.
3. **Low:** Consider adding a test for `start()` failure when `#recover()` throws (DB down at startup).
