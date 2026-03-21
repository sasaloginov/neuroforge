# Security Review: Task 003 — Sprint 2 Domain Layer

## Result: PASS

## Summary

The domain layer is clean from a security perspective. No critical or high-severity findings. The code follows defensive design practices: strict state machines prevent invalid transitions, private fields (`#`) protect internal state in services and value objects, entities are pure data structures with no I/O side effects, and ports are abstract interfaces with no implementation logic.

Reviewed files (19 source files):
- `src/domain/entities/` — Task.js, Run.js, Session.js, TaskStep.js
- `src/domain/valueObjects/` — Role.js
- `src/domain/errors/` — DomainError.js, TaskNotFoundError.js, InvalidTransitionError.js, RoleNotFoundError.js, RunTimeoutError.js, RevisionLimitError.js
- `src/domain/ports/` — IChatEngine.js, ITaskRepo.js, IRunRepo.js, ISessionRepo.js, IProjectRepo.js, ICallbackSender.js
- `src/domain/services/` — RoleRegistry.js, TaskService.js, RunService.js

## Findings

### Low

**L-01: `RunService` does not check for null when `findById` returns nothing**

In `RunService.js`, methods `start`, `complete`, `fail`, `timeout`, and `interrupt` call `this.#runRepo.findById(runId)` but do not guard against a `null` return. If a non-existent `runId` is provided, the code will throw a generic `TypeError` (e.g., "Cannot read properties of null") rather than a domain-specific error. Compare with `TaskService`, which properly wraps this in `#getTask()` and throws `TaskNotFoundError`.

- **Impact:** Information disclosure via unhandled TypeError stack traces in logs/responses; poor error semantics.
- **Recommendation:** Add a null-check and throw a domain error (e.g., `RunNotFoundError`) similar to `TaskService.#getTask()`.

**L-02: Error messages include user-supplied identifiers without sanitization**

Error classes (`TaskNotFoundError`, `RoleNotFoundError`, `RunTimeoutError`, `RevisionLimitError`, `InvalidTransitionError`) interpolate IDs and names directly into message strings. While these are UUIDs and enum values in normal flow, if an attacker supplies crafted input that reaches these constructors, the message could contain arbitrary strings.

- **Impact:** Minimal in domain layer (no direct HTTP exposure), but if error messages are forwarded to clients or logs without sanitization, they could contain injected content.
- **Recommendation:** Infrastructure/HTTP layer must sanitize error messages before returning to clients. Domain layer behavior is acceptable for internal use.

**L-03: `Role` constructor validates `model` against allowlist but `name` only checks for truthiness**

`Role.js` validates that `model` is in `VALID_MODELS` and `timeoutMs` is positive, but `name` is only checked for truthiness (`if (!name)`). An empty string would pass, and no format/length constraint is enforced.

- **Impact:** Unlikely to cause security issues since roles are loaded from filesystem (infrastructure layer), not from user input. Defense-in-depth concern only.
- **Recommendation:** Consider adding a regex constraint on role names (e.g., `/^[a-z][a-z0-9-]{1,63}$/`) to prevent unexpected values.

## Checklist

| Check | Status | Notes |
|---|---|---|
| No hardcoded secrets | PASS | No credentials, tokens, or API keys |
| No unsafe operations (eval, child_process, fs) | PASS | Zero unsafe imports; domain is pure logic |
| Input validation on entities | PASS | State machines enforce valid transitions; Role validates model against allowlist |
| Error classes don't leak sensitive info | PASS | Errors expose only IDs, status names, and timeout values — no credentials or internal paths |
| Ports don't expose unsafe operations | PASS | All ports are abstract interfaces; `IChatEngine.runPrompt` is the only I/O port and it delegates to infrastructure |
| No prototype pollution vectors | PASS | No `Object.assign` from untrusted input, no bracket-notation property access from user data, private fields via `#` |
| No injection risks in string handling | PASS | String interpolation is limited to error messages with controlled values; no SQL, shell, or template injection |
| DDD boundary respected (no infra imports) | PASS | Domain imports only from within domain |
| Immutability of value objects | PASS | `Role` uses private fields + `Object.freeze` on `allowedTools` |
| State machine completeness | PASS | All entities define terminal states with empty transition arrays |
