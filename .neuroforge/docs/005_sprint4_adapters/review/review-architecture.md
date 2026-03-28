# Architecture Review — Sprint 4: Claude CLI Adapter + Callback Client

**Reviewer:** Аркадий (architecture)
**Date:** 2026-03-21
**Verdict:** APPROVED with minor remarks

---

## 1. Port Interface Compliance

### ClaudeCLIAdapter -> IChatEngine

- Correctly extends `IChatEngine` via `extends IChatEngine` (line 9).
- Signature matches: `runPrompt(roleName, prompt, options)`.
- Returns `{ response, sessionId }` as required by `RunPromptResult` typedef.

### CallbackClient -> ICallbackSender

- Correctly extends `ICallbackSender` via `extends ICallbackSender` (line 9).
- Signature matches: `send(callbackUrl, payload, callbackMeta)`.
- Return type `{ ok, statusCode, attempts }` goes beyond the port contract (port returns `void`). This is not a violation — it is a superset — but the port JSDoc says `send(...) -> void`. **Recommendation:** update `ICallbackSender` JSDoc to document the return shape, or at minimum change it to `Promise<void | object>`, so callers can use the result without contradicting the port definition.

**Status:** PASS

---

## 2. DDD Dependency Direction

- Both adapters import only from `domain/ports/` and `domain/services/`. No reverse dependency exists.
- `ClaudeCLIAdapter` receives `RoleRegistry` via constructor injection — correct DI pattern.
- Neither adapter imports anything from `application/`.

**Status:** PASS

---

## 3. ClaudeCLIAdapter — Detailed Review

### 3.1 Security: spawn with array args

`spawn('claude', args, ...)` — args are built as an array, never interpolated into a shell string. The `shell` option is not set (defaults to `false`). Test `'uses spawn without shell option (security)'` explicitly asserts this. No template literals used in arg construction.

**Status:** PASS

### 3.2 Timeout: soft SIGTERM + hard SIGKILL

- Soft timer fires at `effectiveTimeout`, sends SIGTERM.
- Hard timer fires at `effectiveTimeout + killDelayMs`, sends SIGKILL.
- Both timers are set unconditionally at spawn time.

**Issue (minor):** Both timers start immediately when the promise is created. This means the hard kill timer is always allocated even though it is only needed after SIGTERM. In practice this is harmless (the `!done` guard prevents a kill on an already-finished process), but it does hold two timer references for the entire process lifetime. A cleaner pattern would be to start the hard timer only inside the soft timer callback. Not a blocker.

**Issue (minor):** If `effectiveTimeout` is `undefined` (role has no `timeoutMs` and options has no `timeoutMs`), `setTimeout(fn, undefined)` will fire immediately (treated as 0). The `Role` value object enforces `timeoutMs > 0` at construction time, so this cannot happen in practice through normal flow. However, `ClaudeCLIAdapter` does not validate `effectiveTimeout` itself. Adding a guard (`if (!effectiveTimeout) throw ...`) would make the adapter more robust in isolation.

**Status:** PASS (with minor remarks)

### 3.3 AbortSignal support

- Pre-check: if `signal.aborted` at call time, rejects immediately without spawning.
- Runtime: adds `abort` event listener with `{ once: true }`, sends SIGTERM on abort.
- Cleanup: removes listener in `finish()`.

**Status:** PASS

### 3.4 Environment whitelist

Lines 84-87 pass only `HOME` and `PATH` to the child process. This is a good security practice — prevents leaking credentials from parent env. Worth noting that if Claude CLI ever needs additional env vars (e.g., `ANTHROPIC_API_KEY`), this will need updating. Consider making the env whitelist configurable.

**Status:** PASS (note for future)

### 3.5 JSON parse fallback

Lines 166-173 fall back to raw stdout when JSON parsing fails. This is a pragmatic choice — the adapter does not crash on unexpected CLI output format changes. Logs a warning. Acceptable.

**Status:** PASS

---

## 4. CallbackClient — Detailed Review

### 4.1 No-throw guarantee

The `send` method never throws. On exhausted retries it returns `{ ok: false, ... }`. All exceptions inside the retry loop are caught. Test `'does not throw on callback failure'` verifies this.

**Status:** PASS

### 4.2 Retry with exponential backoff

- 3 attempts, delays: 1s, 2s (formula: `1000 * 2^(attempt-1)`).
- Skips delay after last attempt.
- Retries on both network errors and non-2xx HTTP status.

**Status:** PASS

### 4.3 Timeout

Uses `AbortController` with `setTimeout` for per-request timeout. `clearTimeout` called on success to prevent leak.

**Issue (minor):** If `fetch` rejects (network error), `clearTimeout(timer)` is skipped because the error is caught in the `catch` block before reaching `clearTimeout`. The timer will fire after `timeoutMs` and call `controller.abort()` on an already-settled promise — this is harmless (abort on a completed controller is a no-op), but for cleanliness the `clearTimeout` should be in a `finally` block or moved before the `if (res.ok)` check. Current placement (line 51) only runs on successful fetch resolution.

**Status:** PASS (with minor remark)

### 4.4 Payload construction

```js
const body = callbackMeta
  ? { ...payload, callbackMeta }
  : { ...payload };
```

Correct: `callbackMeta` is appended only when provided. Spreading `payload` ensures a shallow copy.

**Potential issue:** If `payload` itself contains a `callbackMeta` key, the explicit `callbackMeta` parameter will override it (object spread order). This is likely the desired behavior but worth documenting.

**Status:** PASS

### 4.5 `_sleep` as instance method

The `_sleep` helper is an instance method (prefixed with `_` to signal internal use). This is fine for testing (can be spied on to speed up tests, though the tests use `vi.useFakeTimers` instead). No issues.

**Status:** PASS

---

## 5. Naming Conventions

| Item | Convention | Status |
|---|---|---|
| Files: `claudeCLIAdapter.js`, `callbackClient.js` | camelCase | PASS |
| Classes: `ClaudeCLIAdapter`, `CallbackClient` | PascalCase | PASS |
| Ports: `IChatEngine`, `ICallbackSender` | `I` prefix | PASS |
| Test files alongside code | `*.test.js` | PASS |

---

## 6. Tests Review

### ClaudeCLIAdapter tests (14 tests)

- Mock strategy: `vi.mock('node:child_process')` with fake EventEmitter-based process. Solid approach — does not spawn real processes.
- Covers: arg construction, session handling, timeout (SIGTERM + SIGKILL), abort, JSON parsing, chunked stdout, exit codes, is_error flag, empty response, raw fallback, spawn error, unknown role, shell=false security.
- Uses `vi.useFakeTimers()` for deterministic timeout testing.

**Status:** Thorough.

### CallbackClient tests (8 tests)

- Mock strategy: replaces `globalThis.fetch`. Clean approach.
- Covers: correct payload, callbackMeta presence/absence, retry with backoff, non-ok HTTP retry, exhausted retries, no-throw guarantee, AbortSignal presence, defaults, last statusCode tracking.
- Uses `vi.useFakeTimers()` for backoff testing.

**Missing test:** No test verifying that the timeout actually aborts a hanging fetch (i.e., a test where fetch never resolves and the timer fires). The current timeout test only checks that an `AbortSignal` is passed, not that timeout triggers abort. Minor gap.

**Status:** Good coverage with one minor gap.

---

## 7. SOLID Assessment

| Principle | Assessment |
|---|---|
| **S** — Single Responsibility | Each adapter does exactly one thing. PASS |
| **O** — Open/Closed | Adapters are final implementations of ports; extension via new adapters (e.g., `ClaudeSDKAdapter`). PASS |
| **L** — Liskov Substitution | Both can substitute their base port classes. PASS |
| **I** — Interface Segregation | Ports are minimal single-method interfaces. PASS |
| **D** — Dependency Inversion | Both depend on abstractions (ports), injected via constructor. PASS |

---

## 8. Summary of Findings

### Blockers

None.

### Minor Recommendations

1. **ICallbackSender return type** — port JSDoc says `void`, implementation returns `{ ok, statusCode, attempts }`. Align the port definition.
2. **CallbackClient clearTimeout placement** — move `clearTimeout(timer)` to a `finally` block inside the try/catch to guarantee cleanup on both success and failure paths.
3. **ClaudeCLIAdapter hard timer** — consider starting the SIGKILL timer only after SIGTERM fires, rather than pre-scheduling it.
4. **ClaudeCLIAdapter env whitelist** — consider making it configurable for future extensibility.
5. **CallbackClient test gap** — add a test for actual timeout-triggered abort (fetch that hangs past `timeoutMs`).

### Verdict

**APPROVED.** The implementation is clean, secure, and follows DDD / SOLID principles correctly. All acceptance criteria from TASK.md are met. The minor remarks above are quality-of-life improvements, not blockers.
