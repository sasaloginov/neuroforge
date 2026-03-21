# Business Review: Task 003

**Reviewer:** business
**Date:** 2026-03-21
**Commit:** be0f0f2 (main)

## Result: PASS

## Acceptance Criteria Check

| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1 | Task.js: factory create(), state machine, canTransitionTo(), revisionCount, fromRow()/toRow() | PASS | State machine includes extra `waiting_reply` status (good extension). All methods present. |
| 2 | Run.js: lifecycle (queued->running->done/failed/timeout/cancelled/interrupted), durationMs, fromRow()/toRow() | PASS | All statuses, lifecycle methods (start/complete/fail/markTimeout/interrupt), durationMs computed on completion. |
| 3 | Session.js: project+role binding, statuses (active/expired/closed), fromRow()/toRow() | PASS | Binds projectId+roleName. State machine with close()/expire() helpers. |
| 4 | TaskStep.js: task binding, stepOrder, promptTemplate, fromRow()/toRow() | PASS | State machine (pending->running->done/failed/timeout). All fields serialized. |
| 5 | Role.js: immutable (name, model, timeoutMs, allowedTools, systemPrompt), validation, equals() | PASS | Private fields via #, frozen allowedTools, validation for name/model/timeoutMs, equality by name. |
| 6 | DomainError base class | PASS | Extends Error, sets name and code. |
| 7 | TaskNotFoundError | PASS | Extends DomainError, stores taskId, code TASK_NOT_FOUND. |
| 8 | InvalidTransitionError | PASS | Stores from/to/entityType, code INVALID_TRANSITION. |
| 9 | RoleNotFoundError | PASS | Stores roleName, code ROLE_NOT_FOUND. |
| 10 | RunTimeoutError | PASS | Stores runId and timeoutMs, code RUN_TIMEOUT. |
| 11 | RevisionLimitError | PASS | Stores taskId and limit, code REVISION_LIMIT. |
| 12 | IChatEngine port: runPrompt(roleName, prompt, options) | PASS | JSDoc with typedefs for options and result. |
| 13 | ITaskRepo port: findById, findByProjectId, save, delete | PASS | All 4 methods with JSDoc. |
| 14 | IRunRepo port: findById, findByTaskId, save, takeNext, findRunning | PASS | All 5 methods with JSDoc including queue semantics note. |
| 15 | ISessionRepo port: findById, findByProjectAndRole, save, delete | PASS | All 4 methods with JSDoc. |
| 16 | IProjectRepo port: findById, findByName, save, findAll | PASS | All 4 methods with JSDoc. |
| 17 | ICallbackSender port: send(callbackUrl, payload, callbackMeta) | PASS | JSDoc with param descriptions. |
| 18 | RoleRegistry: register, get, has, getAll | PASS | Uses private Map, throws RoleNotFoundError on missing get(). |
| 19 | TaskService: createTask, advanceTask, failTask, cancelTask, revision limit | PASS | Also includes completeTask, requestReply, resumeAfterReply, incrementRevision. MAX_REVISIONS=5. |
| 20 | RunService: enqueue, start, complete, fail, timeout, interrupt | PASS | All 6 methods delegate to Run entity methods, persist via repo. |
| 21 | Tests for each entity (state machine, transitions, serialization) | PASS | Task (8 tests), Run (7 tests), Session (4 tests), TaskStep (4 tests). |
| 22 | Tests Role (validation, immutability) | PASS | 5 tests: creation, 3 validation, immutability, equality. |
| 23 | Tests RoleRegistry, TaskService, RunService | PASS | RoleRegistry (4), TaskService (8), RunService (6). Repos mocked with in-memory Map. |
| 24 | No DB required for tests | PASS | All repos mocked, `npx vitest run` -- 61 tests pass. |
| 25 | Zero imports from application/infrastructure | PASS | Verified via grep -- no matches. |
| 26 | DI through constructors in services | PASS | TaskService({taskRepo}), RunService({runRepo}) -- destructured from constructor arg. |

## Findings

### Critical
None.

### Major
None.

### Minor

1. **RunService lacks null-check on findById** -- `RunService.start()`, `.complete()`, `.fail()`, `.timeout()`, `.interrupt()` all call `this.#runRepo.findById(runId)` without checking for null. If the run does not exist, the code will throw a generic `TypeError: Cannot read properties of null` instead of a descriptive `RunNotFoundError`. TaskService handles this correctly with `#getTask()`. Consider adding a `#getRun()` private helper with a proper domain error. *Severity: minor because the error still surfaces, but the message is unhelpful for debugging.*

2. **No `canTransitionTo()` on Session and TaskStep** -- Task and Run expose `canTransitionTo()` for checking transitions without throwing. Session and TaskStep only have `transitionTo()` which throws on invalid transitions. For consistency, consider adding `canTransitionTo()` to these entities as well.

3. **Role model validation is hardcoded** -- `VALID_MODELS = ['opus', 'sonnet', 'haiku']` is hardcoded in the value object. If Claude model offerings change, this requires a code change. Consider making valid models configurable or at least extractable as a constant.

4. **Task state machine is richer than spec** -- The spec defines `pending -> in_progress -> done/failed/cancelled`. The implementation adds `waiting_reply` as an intermediate state. This is a good extension for the business flow (clarification requests) but deviates from the documented spec. Recommend updating the task spec to reflect the actual design.

5. **No test for Role property setter rejection** -- The test verifies `allowedTools` is frozen but does not verify that direct property assignment (e.g., `role.name = 'x'`) is rejected. Since private fields are used, assignment to `role.name` would create a new public property shadowing the getter, which may cause subtle bugs. Consider adding a test that verifies `role.name = 'x'` does not change `role.name` getter behavior, or using `Object.freeze` on the instance.
