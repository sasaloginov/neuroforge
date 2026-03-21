# Business Review — Sprint 5: Application Layer (Use Cases)

**Reviewer:** Аркадий (reviewer-business)
**Date:** 2026-03-21
**Verdict:** APPROVED with remarks

---

## Summary

All 6 use cases are implemented, tested, and match the specification. The application layer correctly orchestrates domain services and ports without importing infrastructure. Tests cover happy paths and error cases comprehensively. A few non-blocking observations are listed below.

---

## Acceptance Criteria Check

### Use Cases Implementation

| Criterion | Status | Notes |
|-----------|--------|-------|
| **CreateTask** — prompt, create task, analyst run, enqueue, return taskId | PASS | Full match with spec algorithm (steps 1-10) |
| **ProcessRun** — take from queue, run Claude CLI, save result, send callback | PASS | Lifecycle queued->running->done covered; timeout and error paths handled |
| **ReplyToQuestion** — accept answer, restore context, resume to in_progress | PASS | Finds last done run, creates new run with same role, resumes task |
| **CancelTask** — cancel task and all queued runs | PASS | Filters only queued runs (running left untouched), calls cancelTask |
| **GetTaskStatus** — return task status for REST fallback | PASS | Returns sanitized data (no prompt/response leak) |
| **ManagerDecision** — run manager agent, decide next step | PASS | All 4 actions implemented: spawn_run, ask_owner, complete_task, fail_task |

### Architectural Requirements

| Criterion | Status | Notes |
|-----------|--------|-------|
| Use cases depend only on domain (ports, entities, services) | PASS | Imports only from `../domain/` |
| DI via constructors | PASS | All 6 use cases use constructor injection with destructuring |
| One use case per file | PASS | 6 files, 6 classes |
| SOLID, DRY, KISS | PASS | Single responsibility per use case; no unnecessary abstractions |

### Test Coverage

| Criterion | Status | Notes |
|-----------|--------|-------|
| Unit tests with mock ports | PASS | All dependencies are vi.fn() mocks |
| CreateTask: task created, first run queued | PASS | 6 tests: happy path, validation, project not found, no callback, no description, role missing |
| ProcessRun: full lifecycle (queued->running->done), callback sent | PASS | 8 tests: happy path, empty queue, timeout (typed + string), error, session create/reuse/update, no callback |
| ReplyToQuestion: waiting_reply -> in_progress | PASS | 6 tests: happy path, task not found, wrong state, no completed runs, role reuse, no callback |
| CancelTask: task + runs cancelled | PASS | 7 tests: with/without runs, not found, already done/cancelled, running runs preserved, callback/no callback |
| ManagerDecision: correct next step | PASS | 13 tests + 5 parseManagerDecision + 1 buildManagerPrompt = 19 total. All 4 actions, pending runs, unparseable, revision limit, terminal task, error cases |

---

## Detailed Findings

### 1. CreateTask — PASS

Implementation matches spec steps 1-10 exactly. Validation order is correct: projectId first, then title, then project existence, then role check, then create. Callback is conditional on callbackUrl presence.

### 2. ProcessRun — PASS

Spec variant (A) chosen for runRepo injection -- matches the design decision D2. The `runService.start()` call from the spec (step 4) is absent; instead `takeNext()` atomically transitions to running. This is an acceptable simplification since takeNext does the same thing at the DB level. Session management (find-or-create, cliSessionId update) works correctly.

**Remark (non-blocking):** The spec mentions `taskService` as a dependency for ProcessRun, but the implementation does not inject or use `taskService`. The spec says ProcessRun might update task status on question/fail, but the implementation correctly delegates that to ManagerDecision (per design decision "ProcessRun is a pure executor"). This is consistent with spec section "ProcessRun does not make decisions."

### 3. ManagerDecision — PASS

All 4 decision branches are implemented and tested. Key behaviors:
- Parallel run waiting (pendingCount check) -- correct
- Unparseable response -> fail task -- correct
- ChatEngine crash -> fail task -- correct
- Revision limit check on re-spawn of developer -- correct
- Terminal task skip -- correct
- `parseManagerDecision` and `buildManagerPrompt` are exported and tested independently

**Remark (non-blocking):** The `parseManagerDecision` regex `\{[\s\S]*\}` is greedy. If the manager response contains multiple JSON objects or text after a JSON block with braces, it would match the longest possible span. For MVP this is acceptable since the manager is instructed to return a single JSON. Worth noting for future hardening.

### 4. ReplyToQuestion — PASS

Correctly checks `waiting_reply` status, finds last `done` run sorted by `createdAt` descending, creates new run with same `roleName` and `stepId`. Prompt includes the answer. Task is resumed via `taskService.resumeAfterReply()`.

**Remark (non-blocking):** The `questionId` parameter is accepted in `execute()` but not used in the implementation. The spec signature includes it (`execute({ taskId, questionId, answer })`), and the test passes it, but the actual logic ignores it. This is fine for MVP (the question context comes from the last run, not from a stored question entity), but should be documented or cleaned up.

### 5. CancelTask — PASS

Correctly cancels only `queued` runs (running runs are left as-is, per the test). Calls `transitionTo('cancelled')` on each queued run, then cancels the task via `taskService.cancelTask()`. Callback type is `'failed'` with error message "Task cancelled by user."

**Remark (non-blocking):** The callback type for cancellation is `'failed'` rather than a dedicated `'cancelled'` type. This is consistent with the spec (which does not define a separate cancelled callback type), but clients will need to distinguish cancellation from actual failures by reading the error message string. Consider adding a `'cancelled'` callback type in a future sprint.

### 6. GetTaskStatus — PASS

Returns sanitized projection of task and runs. Specifically tested that `prompt` and `response` fields are NOT exposed in the run output -- good security practice. Returns empty runs array gracefully.

---

## Callback Types Consistency

| Action | Callback type | Correct? |
|--------|--------------|----------|
| CreateTask (queued) | `progress` | Yes |
| ProcessRun (success) | `progress` | Yes |
| ProcessRun (failure) | `failed` | Yes |
| ManagerDecision: spawn_run | `progress` | Yes |
| ManagerDecision: ask_owner | `question` | Yes |
| ManagerDecision: complete_task | `done` | Yes |
| ManagerDecision: fail_task | `failed` | Yes |
| CancelTask | `failed` | Yes (see remark above) |
| ReplyToQuestion | `progress` | Yes |

All callback types match the architecture expectations.

---

## Non-Blocking Remarks Summary

1. **ProcessRun does not use taskService** -- injected in spec but not in implementation. Acceptable per "pure executor" design.
2. **parseManagerDecision greedy regex** -- could match too much in edge cases. Fine for MVP.
3. **ReplyToQuestion ignores questionId** -- parameter accepted but unused. Clean up or document.
4. **CancelTask callback type is `failed`** -- no dedicated `cancelled` type. Works but may confuse clients.

---

## Verdict

**APPROVED.** All 6 use cases are implemented correctly per the specification and acceptance criteria. Tests are thorough with 46 total test cases covering happy paths, error handling, edge cases, and boundary conditions. The application layer correctly depends only on domain, uses DI via constructors, and follows SOLID principles. Non-blocking remarks do not affect correctness or functionality.
