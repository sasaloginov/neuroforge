# Sprint 5 — Application Layer: Research Context

## 1. Available Domain Services and Ports

### Domain Services

| Service | Method | What it does |
|---------|--------|-------------|
| `TaskService` | `createTask({ projectId, title, description, callbackUrl, callbackMeta })` | Creates Task entity (status=pending), saves to repo |
| `TaskService` | `advanceTask(taskId)` | pending -> in_progress |
| `TaskService` | `requestReply(taskId)` | in_progress -> waiting_reply |
| `TaskService` | `resumeAfterReply(taskId)` | waiting_reply -> in_progress |
| `TaskService` | `completeTask(taskId)` | in_progress -> done |
| `TaskService` | `failTask(taskId)` | in_progress -> failed |
| `TaskService` | `cancelTask(taskId)` | pending/in_progress/waiting_reply -> cancelled |
| `TaskService` | `incrementRevision(taskId)` | revisionCount++, throws RevisionLimitError if > 5 |
| `RunService` | `enqueue({ taskId, stepId, roleName, prompt, callbackUrl, callbackMeta })` | Creates Run (status=queued), saves to repo |
| `RunService` | `start(runId, sessionId)` | queued -> running, sets startedAt |
| `RunService` | `complete(runId, response)` | running -> done, sets response + finishedAt |
| `RunService` | `fail(runId, error)` | running -> failed, sets error |
| `RunService` | `timeout(runId)` | running -> timeout |
| `RunService` | `interrupt(runId)` | running -> interrupted |
| `RoleRegistry` | `get(name)` | Returns Role value object (model, timeoutMs, allowedTools, systemPrompt) |
| `RoleRegistry` | `has(name)` | Boolean check |
| `RoleRegistry` | `getAll()` | All registered roles |

### Domain Ports (Interfaces)

| Port | Method | Contract |
|------|--------|----------|
| `ITaskRepo` | `findById(id)` | Task or null |
| `ITaskRepo` | `findByProjectId(projectId, filters?)` | Task[] |
| `ITaskRepo` | `save(task)` | Upsert |
| `ITaskRepo` | `delete(id)` | Hard delete |
| `IRunRepo` | `findById(id)` | Run or null |
| `IRunRepo` | `findByTaskId(taskId)` | Run[] ordered by created_at |
| `IRunRepo` | `findRunning()` | All runs with status=running |
| `IRunRepo` | `save(run)` | Upsert |
| `IRunRepo` | `takeNext()` | Atomic dequeue: SELECT FOR UPDATE SKIP LOCKED, returns Run (already transitioned to running) or null |
| `ISessionRepo` | `findById(id)` | Session or null |
| `ISessionRepo` | `findByProjectAndRole(projectId, roleName)` | Session or null |
| `ISessionRepo` | `save(session)` | Upsert |
| `ISessionRepo` | `delete(id)` | Hard delete |
| `IProjectRepo` | `findById(id)` | Project or null |
| `IProjectRepo` | `findByName(name)` | Project or null |
| `IProjectRepo` | `save(project)` | Upsert |
| `IProjectRepo` | `findAll()` | Project[] |
| `IChatEngine` | `runPrompt(roleName, prompt, options?)` | Returns `{ response, sessionId }`. Options: `{ sessionId, signal, timeoutMs }` |
| `ICallbackSender` | `send(callbackUrl, payload, callbackMeta?)` | Returns `{ ok, statusCode, attempts }`. Never throws. Retries with backoff. |

### Domain Entities (State Machines)

**Task statuses:** `pending -> in_progress -> waiting_reply -> in_progress -> done/failed/cancelled`
- Fields: id, projectId, title, description, status, callbackUrl, callbackMeta, revisionCount, createdAt, updatedAt

**Run statuses:** `queued -> running -> done/failed/timeout/interrupted`
- Fields: id, sessionId, taskId, stepId, roleName, prompt, response, status, callbackUrl, callbackMeta, startedAt, finishedAt, durationMs, error, createdAt

**TaskStep statuses:** `pending -> running -> done/failed/timeout`
- Fields: id, taskId, roleName, sessionId, stepOrder, promptTemplate, status, createdAt

**Session statuses:** `active -> expired/closed`
- Fields: id, projectId, cliSessionId, roleName, status, createdAt, updatedAt

**Project:** id, name, repoUrl, workDir, createdAt

### Missing Ports/Services (Identified Gaps)

1. **No ITaskStepRepo port** -- TaskStep entity exists but has no persistence port or repo implementation. Use cases that create/update steps will need this. Either:
   - Add a new `ITaskStepRepo` port (preferred, consistent with pattern), or
   - Extend `ITaskRepo` with step-related methods (less clean)

2. **No dedicated port for `findByStatus` on runs** -- `IRunRepo.takeNext()` covers the queue case, but `findByTaskId` is the only way to get runs for a specific task, requiring in-memory filtering by status.

3. **TaskService doesn't expose `getTask(taskId)`** -- the `#getTask` method is private. Use cases that need to read task status (GetTaskStatus, ManagerDecision) would need to call `ITaskRepo.findById` directly. This is fine architecturally (use cases can use ports directly).

---

## 2. Use Case Specifications

### 2.1 CreateTask

**Purpose:** Accept a prompt from the client, create task + first step (analyst), enqueue a run, return taskId.

**Input:**
```
{ projectId, prompt, callbackUrl?, callbackMeta? }
```

**Data Flow:**
1. Validate projectId exists via `IProjectRepo.findById(projectId)` -- fail if not found
2. `TaskService.createTask({ projectId, title: prompt (or extract from prompt), description: prompt, callbackUrl, callbackMeta })` -> task (status=pending)
3. `TaskService.advanceTask(task.id)` -> status=in_progress
4. Create TaskStep via `ITaskStepRepo` (role=analyst, stepOrder=1, promptTemplate=prompt) -- **requires ITaskStepRepo**
5. `RunService.enqueue({ taskId: task.id, stepId: step.id, roleName: 'analyst', prompt, callbackUrl, callbackMeta })` -> run (status=queued)
6. Optionally send progress callback: `ICallbackSender.send(callbackUrl, { type: 'progress', taskId, stage: 'queued', message: 'Task accepted' }, callbackMeta)`
7. Return `{ taskId: task.id, status: 'in_progress' }`

**Output:** `{ taskId, status }`

**Dependencies:** IProjectRepo, TaskService, RunService, ICallbackSender (optional), RoleRegistry (validate 'analyst' exists), ITaskStepRepo (NEW)

**Edge Cases:**
- projectId not found -> throw/return error
- Role 'analyst' not registered -> throw RoleNotFoundError
- DB failure during save -> transaction rollback needed?

### 2.2 ProcessRun

**Purpose:** Worker picks up a queued run, executes it via Claude CLI, saves result, sends callback.

**Input:** None (pulls from queue)

**Data Flow:**
1. `IRunRepo.takeNext()` -> run or null. If null, return (no work).
   - Note: `takeNext()` already transitions run to `running` and sets `startedAt` in a single atomic DB transaction. The Run object returned has status=running.
2. Load task via `ITaskRepo.findById(run.taskId)` -- need project context
3. Load project via `IProjectRepo.findById(task.projectId)` -- need workDir for Claude CLI cwd
4. Create or find session: `ISessionRepo.findByProjectAndRole(task.projectId, run.roleName)` -- reuse existing or create new via `Session.create(...)`
5. `IChatEngine.runPrompt(run.roleName, run.prompt, { sessionId: session.cliSessionId, timeoutMs: role.timeoutMs })` -> `{ response, sessionId: cliSessionId }`
6. On success:
   - Update session.cliSessionId if new
   - `RunService.complete(run.id, response)` -- but run was already loaded by takeNext(). Since RunService.complete() re-loads from DB, this is fine.
   - `ICallbackSender.send(task.callbackUrl, { type: 'progress', taskId: task.id, stage: 'run_done', message: response }, task.callbackMeta)`
7. On failure (catch):
   - `RunService.fail(run.id, error.message)`
   - `ICallbackSender.send(task.callbackUrl, { type: 'failed', taskId: task.id, error: error.message }, task.callbackMeta)`
8. On timeout (catch specific error):
   - `RunService.timeout(run.id)` -- but timeout is detected by CLI adapter throwing. Need to distinguish timeout errors from other failures.
   - Alternative: ClaudeCLIAdapter throws with message containing "timeout" -- fragile.

**Output:** `{ run, result }` or `null` if no work

**Dependencies:** IRunRepo, ITaskRepo, IProjectRepo, ISessionRepo, IChatEngine, RunService, ICallbackSender, RoleRegistry

**Edge Cases:**
- Queue empty -> return null
- Claude CLI crashes -> fail the run, send callback
- Claude CLI timeout -> timeout the run, send callback
- Task/project not found for run -> fail the run (orphaned run)
- Session creation fails -> fail the run
- Callback send fails -> log warning, don't block (CallbackClient already never throws)

**Important:** `takeNext()` already transitions to `running` in the DB. RunService.start() would fail because the run in DB is already `running`. The use case should NOT call RunService.start() -- the run from takeNext() is already started. If the use case needs to call RunService.complete/fail, those re-load from DB and transition from `running`.

### 2.3 ReplyToQuestion

**Purpose:** Accept client's answer to a question, resume the task.

**Input:**
```
{ taskId, questionId?, answer }
```

**Data Flow:**
1. `ITaskRepo.findById(taskId)` -> task. Validate status == waiting_reply.
2. `TaskService.resumeAfterReply(taskId)` -> status=in_progress
3. Build a resume prompt incorporating the answer + original context
4. Determine which step/role was active when the question was asked -- need to find the last run or step
5. `RunService.enqueue({ taskId, stepId, roleName: <same role>, prompt: <resume prompt with answer>, callbackUrl: task.callbackUrl, callbackMeta: task.callbackMeta })` -> new queued run
6. `ICallbackSender.send(task.callbackUrl, { type: 'progress', taskId, stage: 'resumed', message: 'Reply received, resuming work' }, task.callbackMeta)`
7. Return `{ taskId, status: 'in_progress' }`

**Output:** `{ taskId, status }`

**Dependencies:** TaskService, ITaskRepo, IRunRepo (find last run for context), RunService, ICallbackSender

**Edge Cases:**
- Task not found -> TaskNotFoundError
- Task not in waiting_reply -> InvalidTransitionError
- How to find the right role/step to resume? Options:
  - Store pending_questions + context_snapshot in task (architecture decision 33 mentions this)
  - Find last run by taskId and use its roleName
  - Need a convention: the last run for the task contains the question context

**Open Question:** Where is the question context stored? Architecture mentions `pending_questions` and `context_snapshot` fields, but the Task entity doesn't have these fields. Either:
- Add fields to Task entity (description could serve as context?)
- Store question data in the last Run's response
- Add a dedicated questions table

### 2.4 CancelTask

**Purpose:** Cancel a task and all its pending/queued runs.

**Input:**
```
{ taskId }
```

**Data Flow:**
1. `TaskService.cancelTask(taskId)` -> transitions to cancelled. Throws if terminal state.
2. `IRunRepo.findByTaskId(taskId)` -> all runs
3. For each run with status `queued`:
   - run.transitionTo('cancelled'), IRunRepo.save(run)
   - Or: RunService doesn't have a cancel method -- Run entity does support queued->cancelled transition
4. For runs with status `running`: need to decide. Options:
   - Also cancel (but Run transitions: running can't go to cancelled! Only done/failed/timeout/interrupted allowed)
   - Interrupt them: `RunService.interrupt(runId)` -- but how to actually stop the Claude CLI process? Need AbortController.
   - Leave them running and let ProcessRun handle it when it completes
5. Send callback: `ICallbackSender.send(task.callbackUrl, { type: 'failed', taskId, error: 'Task cancelled' }, task.callbackMeta)`
6. Return `{ taskId, status: 'cancelled' }`

**Output:** `{ taskId, status }`

**Dependencies:** TaskService, IRunRepo, ICallbackSender, ITaskRepo (to get callbackUrl)

**Edge Cases:**
- Task already done/failed/cancelled -> InvalidTransitionError
- Running runs can't be cancelled via Run state machine (no running->cancelled transition). Must use `interrupt()` instead.
- Race condition: run finishes while we cancel -- handle gracefully

**Important Design Note:** The Run state machine has `running -> [done, failed, timeout, interrupted]` but NOT `running -> cancelled`. For running runs, the use case must call `interrupt()`. For queued runs, `cancelled` is allowed.

### 2.5 GetTaskStatus

**Purpose:** Return current task status for REST fallback polling.

**Input:**
```
{ taskId }
```

**Data Flow:**
1. `ITaskRepo.findById(taskId)` -> task or null
2. If not found -> throw TaskNotFoundError
3. Optionally load runs: `IRunRepo.findByTaskId(taskId)` for detailed status
4. Return task status + optional run info

**Output:**
```
{
  taskId,
  status,
  title,
  revisionCount,
  runs: [{ id, roleName, status, durationMs }], // optional
  createdAt,
  updatedAt
}
```

**Dependencies:** ITaskRepo, IRunRepo (optional for detailed info)

**Edge Cases:**
- Task not found -> TaskNotFoundError
- This is a pure read -- no state mutations, no side effects

### 2.6 ManagerDecision

**Purpose:** After a run completes, invoke the manager agent to decide the next step.

**Input:**
```
{ runId }
```

**Data Flow:**
1. `IRunRepo.findById(runId)` -> completedRun. Validate status is done/failed/timeout.
2. `ITaskRepo.findById(completedRun.taskId)` -> task
3. `IProjectRepo.findById(task.projectId)` -> project (for context)
4. `IRunRepo.findByTaskId(task.id)` -> allRuns (history for manager context)
5. Build manager prompt with:
   - Task description
   - Completed run's role + response
   - History of previous runs
   - Available next steps/roles
6. `IChatEngine.runPrompt('manager', managerPrompt)` -> manager's decision
7. Parse manager's response (structured via MCP tools):
   - **spawn_run(role, prompt):** `RunService.enqueue(...)` for next role
   - **ask_owner(question):** `TaskService.requestReply(taskId)`, send question callback
   - **complete_task(summary):** `TaskService.completeTask(taskId)`, send done callback
   - **fail_task(reason):** `TaskService.failTask(taskId)`, send failed callback
8. Execute the decision

**Output:** `{ decision, taskId }` where decision is one of: spawn_run, ask_owner, complete_task, fail_task

**Dependencies:** IRunRepo, ITaskRepo, IProjectRepo, IChatEngine, RunService, TaskService, ICallbackSender, RoleRegistry

**Edge Cases:**
- Run not found -> RunNotFoundError
- Run not in terminal state (still running) -> error, don't make decisions on incomplete runs
- Manager agent crashes/fails -> fail the task? Or retry? Architecture says manager is critical.
- Manager returns unparseable response -> fail_task with error
- RevisionLimitError during spawn_run for review cycle -> catch and fail task
- Parallel runs: manager spawned 3 reviewers, one finishes. Manager should check if other parallel runs are still pending before deciding next step. Need `IRunRepo.findByTaskId()` and check all related runs.
- Task already cancelled between run completion and manager decision -> skip

---

## 3. Dependencies Between Use Cases

```
Client                       Worker/Scheduler
  |                               |
  v                               v
CreateTask ----enqueues---> ProcessRun
                               |
                               v (on completion)
                          ManagerDecision
                           /    |    \     \
                          v     v     v     v
                    spawn_run  ask   done  fail
                    (enqueue   owner
                     new run)    |
                                 v
ReplyToQuestion <--- callback -- (question callback to client)
  |
  v (enqueues new run)
ProcessRun (picks up resumed run)

CancelTask -- independent, can be called anytime
GetTaskStatus -- independent, read-only
```

**Dependency Graph:**
- `CreateTask` -> standalone entry point
- `ProcessRun` -> standalone (worker loop), triggers ManagerDecision on completion
- `ManagerDecision` -> called by ProcessRun (or scheduler after run completes)
- `ReplyToQuestion` -> called by client, enqueues run (picked up by ProcessRun)
- `CancelTask` -> standalone, can cancel in-flight work
- `GetTaskStatus` -> standalone, read-only

**ProcessRun and ManagerDecision coupling:** ProcessRun should call ManagerDecision after completing a run, OR ManagerDecision should be triggered by the scheduler (event-driven via PG LISTEN/NOTIFY or polling). Architecture says manager is triggered after each completed run. Recommendation: ProcessRun calls ManagerDecision directly as the last step after completing a run.

Alternative: ProcessRun just completes the run and sends callback. A separate ManagerScheduler polls for completed runs that haven't been processed by manager yet. This decouples the two but adds complexity.

**Recommendation:** ProcessRun invokes ManagerDecision at the end. If ProcessRun fails after completing the run but before ManagerDecision, the scheduler (fallback polling) will pick it up.

---

## 4. Data Flow Diagrams

### CreateTask Flow
```
POST /tasks { projectId, prompt, callbackUrl, callbackMeta }
  |
  v
CreateTask.execute()
  |-- IProjectRepo.findById(projectId) -- validate project exists
  |-- TaskService.createTask(...)       -- Task(pending)
  |-- TaskService.advanceTask(taskId)   -- Task(in_progress)
  |-- [NEW] ITaskStepRepo.save(step)    -- TaskStep(analyst, pending)
  |-- RunService.enqueue(...)           -- Run(queued)
  |-- ICallbackSender.send(progress)    -- notify client (optional)
  |
  v
return { taskId, status: 'in_progress' }
```

### ProcessRun Flow
```
Worker loop (or scheduler trigger)
  |
  v
ProcessRun.execute()
  |-- IRunRepo.takeNext()               -- Run(running) or null
  |   (already transitioned to running atomically)
  |
  |-- ITaskRepo.findById(run.taskId)    -- load task context
  |-- IProjectRepo.findById(...)         -- get workDir
  |-- ISessionRepo.findByProjectAndRole -- find/create session
  |
  |-- IChatEngine.runPrompt(...)         -- BLOCKING: Claude CLI execution
  |   |
  |   v success:
  |   |-- RunService.complete(runId, response)
  |   |-- ICallbackSender.send(progress)
  |   |-- ManagerDecision.execute(runId) -- decide next step
  |   |
  |   v failure:
  |   |-- RunService.fail(runId, error)
  |   |-- ICallbackSender.send(failed)
  |
  v
return { run, result }
```

### ManagerDecision Flow
```
ManagerDecision.execute(runId)
  |
  |-- Load context: run, task, project, all runs history
  |-- Build manager prompt with context
  |-- IChatEngine.runPrompt('manager', prompt)
  |
  |-- Parse decision:
  |   |
  |   v spawn_run(role, prompt):
  |   |-- RoleRegistry.get(role)         -- validate
  |   |-- RunService.enqueue(...)        -- new run in queue
  |   |-- ICallbackSender.send(progress)
  |   |
  |   v ask_owner(question):
  |   |-- TaskService.requestReply(taskId)  -- task -> waiting_reply
  |   |-- ICallbackSender.send({ type: 'question', ... })
  |   |
  |   v complete_task(summary):
  |   |-- TaskService.completeTask(taskId)  -- task -> done
  |   |-- ICallbackSender.send({ type: 'done', summary })
  |   |
  |   v fail_task(reason):
  |   |-- TaskService.failTask(taskId)      -- task -> failed
  |   |-- ICallbackSender.send({ type: 'failed', error: reason })
```

---

## 5. Edge Cases and Error Scenarios

### Cross-Cutting
- **Transaction boundaries:** Multiple saves (task + step + run) in CreateTask should ideally be in one DB transaction. Current ports don't support transactions. Options: (a) accept partial failure risk, (b) add transaction support to ports later, (c) use a UnitOfWork pattern. Recommendation: accept partial failure for now (Sprint 5 focus is correctness, not ACID guarantees across aggregates).
- **Idempotency:** ProcessRun's `takeNext()` is already idempotent via FOR UPDATE SKIP LOCKED. CreateTask should be idempotent by design (each call creates a new task).
- **Concurrent cancellation:** A task may be cancelled while ProcessRun is executing. After Claude CLI returns, ProcessRun should check task status before proceeding. If cancelled, skip ManagerDecision and discard result.

### CreateTask
- Invalid projectId -> error (project not found)
- Missing prompt -> validation error (at HTTP layer, not use case)
- Role 'analyst' not loaded -> RoleNotFoundError

### ProcessRun
- `takeNext()` returns run with deleted task -> fail run, log warning
- Claude CLI process killed by OOM -> caught as failure, run.fail()
- Timeout detection: ClaudeCLIAdapter throws `Error("Claude CLI timeout after X seconds")`. ProcessRun should detect this and call `RunService.timeout()` instead of `RunService.fail()`. Pattern: check error message or use a custom error class.
- Session reuse: if session expired/closed, create new one

### ReplyToQuestion
- Answer to wrong task (task not in waiting_reply) -> InvalidTransitionError
- Race condition: two replies to same question -> second one fails on transition
- Missing context for resume prompt -> need to reconstruct from last run's prompt + response

### CancelTask
- Task with running runs -> interrupt (not cancel, since Run state machine doesn't allow running->cancelled)
- Task already terminal -> InvalidTransitionError (let it propagate or catch and return success?)

### ManagerDecision
- Manager agent returns malformed response -> fail task
- Manager spawns run for non-existent role -> RoleNotFoundError -> fail task
- All parallel reviewers not done yet -> manager should wait (check all runs for step, only proceed if all done)
- Revision limit exceeded -> RevisionLimitError -> fail task with specific message

---

## 6. Open Questions

### Q1: ITaskStepRepo Port
TaskStep entity exists but has no persistence port. CreateTask needs to create a TaskStep, ManagerDecision needs to create new steps when spawning runs. **Decision needed:** create `ITaskStepRepo` with methods: `save(step)`, `findByTaskId(taskId)`, `findById(id)`.

### Q2: Question Context Storage
Architecture decision #33 mentions `pending_questions` and `context_snapshot` fields, but Task entity doesn't have them. For ReplyToQuestion to work properly, we need to know:
- What question was asked (to include in resume prompt)
- What role was working when question was raised
- What session was active
**Options:**
- (a) Add `pendingQuestions` and `contextSnapshot` fields to Task entity
- (b) Store question in the last Run's response field (convention-based)
- (c) Derive from last run: find last run by taskId, use its roleName and prompt

**Recommendation:** Option (c) for Sprint 5 -- derive from last run. It avoids schema changes and the run already contains roleName + prompt. The question text can be passed through the callback and stored in the reply endpoint request.

### Q3: ProcessRun <-> ManagerDecision Coupling
Should ProcessRun call ManagerDecision directly, or should they be decoupled (scheduler triggers ManagerDecision separately)?

**Recommendation:** Direct call within ProcessRun for simplicity. The scheduler serves as a fallback for missed events.

### Q4: Manager Response Parsing
How does the manager agent communicate its decision? Architecture mentions MCP tools (`spawn_run`, `ask_owner`, `complete_task`, `fail_task`). In Sprint 5 with mocked infrastructure, we can:
- Define a structured JSON response format for the manager
- Parse the response for tool calls
- In tests, mock IChatEngine to return pre-formatted decisions

**Recommendation:** Define a response contract (JSON with `{ action, params }`) and implement a `parseManagerDecision(response)` helper. Actual MCP integration is infrastructure concern (later sprint).

### Q5: Timeout vs Failure Distinction
ClaudeCLIAdapter throws generic `Error` for both timeout and failure. ProcessRun needs to distinguish them to call `RunService.timeout()` vs `RunService.fail()`.

**Recommendation:** Check error message for "timeout" substring. Or better: introduce a `TimeoutError` class in ClaudeCLIAdapter and catch by type.

### Q6: TaskStep Lifecycle Management
Who manages TaskStep status transitions? CreateTask creates the first step, but:
- When a run starts for a step -> step should go to `running`
- When a run completes -> step should go to `done`
- When a run fails -> step should go to `failed`

This logic could live in ProcessRun or ManagerDecision. **Recommendation:** ProcessRun updates step status alongside run status.

### Q7: Multiple spawn_run Calls from Manager
Architecture says manager can call `spawn_run()` multiple times (e.g., 3 reviewers in parallel). The ManagerDecision use case must support parsing multiple actions from a single manager response.

---

## 7. Reference Pattern (from mybot SendMessage)

The reference use case (`/root/bot/mybot/src/application/SendMessage.js`) demonstrates:

1. **Constructor DI:** All dependencies injected via constructor destructuring
2. **Single execute method:** `async execute(...)` as the public API
3. **Graceful degradation:** Optional dependencies (memory, facts) -- if null, skip that step
4. **Fire-and-forget side effects:** Memory storage and fact extraction are async, non-blocking
5. **Error isolation:** Memory retrieval failure doesn't block the main response
6. **Logging with timing:** Performance metrics for each step

**Recommended pattern for Neuroforge use cases:**
```js
export class CreateTask {
  #taskService;
  #runService;
  #projectRepo;
  #callbackSender;

  constructor({ taskService, runService, projectRepo, callbackSender }) {
    this.#taskService = taskService;
    this.#runService = runService;
    this.#projectRepo = projectRepo;
    this.#callbackSender = callbackSender;
  }

  async execute({ projectId, prompt, callbackUrl, callbackMeta }) {
    // ... orchestration logic
  }
}
```

---

## 8. Summary: Implementation Checklist

### Prerequisites (before use cases)
- [ ] Create `ITaskStepRepo` port in `src/domain/ports/`
- [ ] Create `PgTaskStepRepo` in `src/infrastructure/persistence/` (or defer to Sprint 6 if only mocks are needed now)

### Use Cases (order of implementation)
1. **GetTaskStatus** -- simplest, read-only, no side effects. Good for establishing the pattern.
2. **CreateTask** -- core entry point. Tests the create + enqueue flow.
3. **CancelTask** -- straightforward state management.
4. **ProcessRun** -- most complex, involves Claude CLI and session management.
5. **ReplyToQuestion** -- depends on understanding how questions flow.
6. **ManagerDecision** -- most complex orchestration, depends on ProcessRun pattern.

### Test Strategy
Each use case gets a test file with mocked ports:
- Mock `ITaskRepo`, `IRunRepo`, `ISessionRepo`, `IProjectRepo` -- return canned data
- Mock `IChatEngine` -- return predefined responses
- Mock `ICallbackSender` -- verify calls were made with correct payloads
- Test happy path + each error scenario
- For ManagerDecision: test each decision type (spawn_run, ask_owner, complete_task, fail_task)
