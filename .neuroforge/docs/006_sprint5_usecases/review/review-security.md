# Security Review — Sprint 5: Application Layer (Use Cases)

**Reviewer:** security
**Date:** 2026-03-21
**Verdict:** APPROVED with findings (no blockers, 3 medium, 4 low)

---

## Scope

Reviewed files:
- `src/application/CreateTask.js`
- `src/application/ProcessRun.js`
- `src/application/ReplyToQuestion.js`
- `src/application/CancelTask.js`
- `src/application/GetTaskStatus.js`
- `src/application/ManagerDecision.js`
- `src/domain/errors/InvalidStateError.js`
- `src/domain/errors/ProjectNotFoundError.js`
- `src/domain/errors/ValidationError.js`
- `src/domain/errors/DomainError.js`

---

## 1. Input Validation

### CreateTask
- **projectId** — checked for presence (`!projectId`). Falsy check is sufficient since UUIDs are non-empty strings.
- **title** — checked for presence and emptiness via `!title || !title.trim()`. Good.
- **description** — optional, defaults to `null`. No length limit. See finding SEC-03.
- **callbackUrl** — not validated. See finding SEC-01.
- **callbackMeta** — passed through without validation. Acceptable if treated as opaque blob, but see SEC-01.

### ReplyToQuestion
- **taskId** — not explicitly validated for format; delegated to `taskService.getTask()` which will throw if not found. Acceptable.
- **questionId** — accepted but **never used** in the execute method. Dead parameter — no security impact but indicates spec drift.
- **answer** — no validation at all. Interpolated directly into a prompt string. See finding SEC-02.

### CancelTask
- **taskId** — delegated to `taskService.getTask()`. Acceptable.

### GetTaskStatus
- **taskId** — delegated to `taskService.getTask()`. Acceptable.

### ManagerDecision
- **completedRunId** — validated via `findById` + null check + status check. Good.

---

## 2. Authorization

Use cases contain **no authorization checks**. Per project architecture this is expected — auth belongs in the HTTP layer. However:

- Use cases trust that `taskId`, `projectId`, and `completedRunId` belong to the calling user. The HTTP layer **must** enforce tenant isolation; use cases provide no safety net.
- **Recommendation:** consider adding an optional `ownerId` / `tenantId` parameter to use cases and asserting ownership at the domain level as defense-in-depth. Not a blocker for Sprint 5.

---

## 3. Error Handling & Information Leakage

### Error classes
- `DomainError`, `InvalidStateError`, `ValidationError`, `ProjectNotFoundError` — clean, no stack traces or internal state leaked in messages. Good.
- `ProjectNotFoundError` includes `projectId` in the message. Acceptable — it's the caller's own ID.

### ProcessRun — error callback
- Line 69: `error: error.message` is sent in the callback payload. If the error originates from `chatEngine` (Claude CLI), the message could contain internal paths, CLI flags, or environment details. See finding SEC-04.

### ManagerDecision — error callback
- Lines 57, 155: same pattern — `error.message` sent to callback. Same concern as SEC-04.

---

## 4. ManagerDecision — JSON Parsing Safety

### `parseManagerDecision(response)`

- Uses `response.match(/\{[\s\S]*\}/)` — greedy regex that captures the **largest** `{...}` block. If the Claude response contains multiple JSON objects or nested braces in text, this could match unintended content. In practice: low risk since invalid JSON will fail `JSON.parse`, and `action` is validated against a whitelist.
- `JSON.parse` is safe (no code execution in Node.js).
- **Action whitelist** (`validActions`) prevents arbitrary action injection. Good.

### Missing field validation in `spawn_run` (SEC-05)
- When `decision.action === 'spawn_run'`, only `decision.role` is validated (via `roleRegistry.get`). The `decision.prompt` field is **not validated** — if the manager returns a decision with no `prompt` or with a manipulated prompt, it is passed directly to `runService.enqueue`. A malicious or malfunctioning Claude response could:
  - Set `prompt` to `undefined`, causing a run with empty/null prompt.
  - Include prompt injection content. This is inherent to LLM orchestration and cannot be fully prevented, but a non-empty check is advisable.

### Missing field validation in other actions
- `ask_owner`: `decision.question` is sent in callback without validation. If null/undefined, the callback consumer receives garbage.
- `complete_task`: `decision.summary` not validated.
- `fail_task`: `decision.reason` not validated.

These are low risk since they only affect callback payloads, but defensive checks would improve robustness.

---

## 5. Callback Payloads — Sensitive Data Exposure

### GetTaskStatus — field filtering
- Properly filters task fields (no `description`, `callbackUrl`, `callbackMeta` exposed). Good.
- Run fields are filtered (no `prompt`, `response`, `error` exposed). Good.

### Callback payloads in general
- `CreateTask`: sends `taskId`, `stage`, `message`. Clean.
- `ProcessRun` (success): sends `taskId`, `stage` (role name), `message`. Clean — no response content leaked.
- `ProcessRun` (failure): sends `error.message`. See SEC-04.
- `ManagerDecision` (`ask_owner`): sends `question` and `context` from manager's response. These originate from Claude output and could contain anything the LLM generated, including echoed user data or fabricated content. Low risk — the callback consumer is the task owner.
- `ManagerDecision` (`complete_task`): sends `summary` from manager. Same consideration.
- No callback sends raw `prompt` or full `response` content. Good.

---

## 6. Prompt Injection Surface

- `CreateTask` line 37: user-supplied `title` and `description` are interpolated into the analyst prompt. This is **by design** (the user's task IS the prompt), but there is no sanitization or escaping.
- `ReplyToQuestion` line 32: user-supplied `answer` is interpolated into the prompt. Same consideration — by design but no guard rails.
- These are inherent to LLM orchestration systems. Mitigation (system prompts, role definitions) is handled at the role level in `roles/*.md`. Acceptable for current architecture.

---

## Findings Summary

| ID | Severity | File | Finding |
|----|----------|------|---------|
| SEC-01 | **Medium** | `CreateTask.js` | `callbackUrl` is not validated. A malicious caller could set it to an internal network address (SSRF via callback). The HTTP layer or `CallbackClient` must validate the URL scheme (https only) and reject private/internal IPs. |
| SEC-02 | **Medium** | `ReplyToQuestion.js` | `answer` parameter has no length limit. An extremely large answer could cause excessive memory usage when building the prompt string and when sent to Claude CLI. Add a max-length check (e.g., 10,000 chars). |
| SEC-03 | **Medium** | `CreateTask.js` | `description` has no length limit. Same resource exhaustion concern as SEC-02. Add a max-length check. |
| SEC-04 | **Low** | `ProcessRun.js`, `ManagerDecision.js` | Raw `error.message` from internal errors (including Claude CLI failures) is forwarded in callback payloads. Could leak internal paths, environment info, or CLI arguments. Sanitize or genericize error messages before sending to callbacks. |
| SEC-05 | **Low** | `ManagerDecision.js` | `parseManagerDecision` does not validate required fields per action type (`prompt` for `spawn_run`, `question` for `ask_owner`, etc.). A malformed manager response could produce runs with null/undefined prompts or callbacks with missing data. |
| SEC-06 | **Low** | `ManagerDecision.js` | Greedy regex `/\{[\s\S]*\}/` matches the largest brace-delimited block. If the response contains multiple JSON objects, the wrong one could be matched. Consider using a non-greedy match `/\{[\s\S]*?\}/` and iterating candidates, or extracting from a code fence. |
| SEC-07 | **Low** | `ReplyToQuestion.js` | `questionId` parameter is accepted but unused. Should either be validated and used (to correlate the answer to a specific question) or removed to avoid confusion. |

---

## Recommendations

1. **SEC-01 (SSRF):** Implement URL validation in `CallbackClient` (infrastructure layer). Restrict to `https://` scheme, reject RFC-1918 / loopback addresses. This is the correct layer for this check per DDD rules.
2. **SEC-02 / SEC-03 (Input length):** Add length validation in use cases or in the HTTP schema layer. Both layers are appropriate — HTTP schema for early rejection, use case for defense-in-depth.
3. **SEC-04 (Error leakage):** Wrap error messages in callbacks with a generic message, log the real error server-side. Example: `error: 'Internal processing error'` + log `error.stack`.
4. **SEC-05 (Field validation):** Add field presence checks in `ManagerDecision` after parsing: require `role` + `prompt` for `spawn_run`, `question` for `ask_owner`, etc.
5. **SEC-06 (Regex):** Low priority. The current approach works because `JSON.parse` + action whitelist provide a second validation layer.

---

## Verdict

**APPROVED.** No blocking security issues found. The architecture correctly delegates auth to the HTTP layer and filters sensitive data from `GetTaskStatus` responses. Medium findings (SSRF via callback URL, input length limits) should be addressed before production deployment but do not block Sprint 5 merge.
