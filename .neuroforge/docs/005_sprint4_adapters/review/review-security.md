# Security Review — Sprint 4: Claude CLI Adapter + Callback Client

**Reviewer:** security
**Date:** 2026-03-21
**Status:** APPROVED (minor findings)

---

## Scope

| File | Lines |
|------|-------|
| `src/infrastructure/claude/claudeCLIAdapter.js` | 179 |
| `src/infrastructure/claude/claudeCLIAdapter.test.js` | 333 |
| `src/infrastructure/callback/callbackClient.js` | 97 |
| `src/infrastructure/callback/callbackClient.test.js` | 198 |

---

## 1. ClaudeCLIAdapter

### 1.1 Command Injection — PASS

- `spawn('claude', args, ...)` uses the **array-based** signature — no shell interpolation.
- `shell: true` is **not set** (verified: `spawnOptions.shell` is `undefined`). Dedicated test on line 318 confirms this.
- All arguments are pushed via `args.push(key, value)` — no template literals, no string concatenation in arg building.
- The prompt text is written to **stdin** (`proc.stdin.write(prompt)`), never interpolated into CLI arguments. This is the correct pattern: even a malicious prompt string cannot escape into shell execution.

### 1.2 User Input Isolation — PASS

Arguments come from two sources:

| Source | Values | Risk |
|--------|--------|------|
| `RoleRegistry` (server-controlled) | model, systemPrompt, allowedTools, timeoutMs | None — loaded from trusted `.md` files at startup |
| `options` (caller-controlled) | sessionId, signal, timeoutMs | Low |

`sessionId` is passed as a positional arg after `--session-id`. Since `spawn` uses array args, a sessionId containing spaces or shell metacharacters (e.g. `; rm -rf /`) is harmless — it will be treated as a single opaque string by the `claude` binary.

### 1.3 Environment Leakage — PASS

```js
env: {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
}
```

Explicit allowlist of env vars. No `DATABASE_URL`, no API keys, no secrets leak to the child process. This is a strong security posture.

### 1.4 Timeout / Zombie Prevention — PASS

- **Soft timeout:** `SIGTERM` at `effectiveTimeout` ms.
- **Hard timeout:** `SIGKILL` at `effectiveTimeout + killDelayMs` ms — guarantees the process dies even if it ignores SIGTERM.
- Both timers are cleared in `finish()`, preventing memory leaks on normal completion.
- The `done` flag prevents double-resolve/double-reject.
- Test on line 168 verifies the SIGTERM-then-SIGKILL sequence.

### 1.5 AbortSignal Cleanup — PASS

- On abort: sends `SIGTERM`, rejects promise, clears timers, removes event listener.
- Pre-aborted signal check (line 36-38) prevents spawning a process at all.
- `{ once: true }` on the event listener is an extra safety net.
- Tests on lines 203 and 218 cover both cases.

### 1.6 Error Messages — FINDING (low severity)

**F-SEC-01:** On non-zero exit, stderr content is included in the error message:

```js
'Claude CLI exited with code ' + code + ': ' + stderr.trim()
```

If Claude CLI writes internal error details (paths, tokens, internal state) to stderr, these propagate into the error object. If this error is later surfaced to an API client, it may leak server-side information.

**Recommendation:** Truncate stderr in error messages (e.g. first 200 chars) and log the full stderr separately at `error` level. This limits information disclosure while preserving debuggability.

**Severity:** Low. The error stays within the domain layer (no direct HTTP exposure found in current codebase), but defensive truncation is warranted.

---

## 2. CallbackClient

### 2.1 SSRF — FINDING (medium severity)

**F-SEC-02:** `callbackUrl` is passed directly to `fetch()` with no validation:

```js
const res = await fetch(callbackUrl, { ... });
```

If a malicious or compromised client registers a callback URL like `http://169.254.169.254/latest/meta-data/` (AWS IMDS), `http://localhost:5432/`, or `file:///etc/passwd`, the server will make requests to internal infrastructure.

**Recommendation:** Validate `callbackUrl` before use:
1. Parse with `new URL(callbackUrl)` — reject non-http(s) schemes.
2. Resolve the hostname and reject private/reserved IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, fd00::/8).
3. Ideally perform this validation at task creation time (in the HTTP layer), not in the callback client itself — defense in depth says do both.

**Severity:** Medium. Exploitability depends on deployment topology. In a Docker/cloud environment with IMDS or internal services on the network, this is a real risk.

### 2.2 Timeout — PASS

- `AbortController` with configurable `timeoutMs` (default 10s).
- Timer is cleared on success (`clearTimeout(timer)` on line 51).
- Prevents callback targets from holding connections open indefinitely.

### 2.3 Secret Leakage in Logs — PASS

Log messages contain:
- `callbackUrl` — this is the client's own URL, not a server secret.
- `attempt` count and `statusCode` — non-sensitive.
- `err.message` on failure — could contain DNS resolution details but nothing server-secret.

No request body, no headers, no internal state logged. Clean.

### 2.4 Error Swallowing — PASS (by design)

The method never throws — returns `{ ok: false }` on exhausted retries. This is documented and intentional: callback failure must not break the pipeline. The full error chain is logged at `warn`/`error` level.

### 2.5 Retry Amplification — FINDING (low severity)

**F-SEC-03:** With `maxRetries=3` and no circuit breaker, a consistently failing callback URL will generate 3 outbound requests per callback event. If the system sends many callbacks (e.g., progress updates for many tasks), this could amplify into a significant number of outbound requests to a target that is already unhealthy.

**Recommendation:** Consider a circuit breaker or per-URL failure tracking. After N consecutive failures to the same URL, disable callbacks temporarily. This is not urgent for the current scale but is worth tracking.

**Severity:** Low.

### 2.6 Payload Injection — PASS

The payload is serialized via `JSON.stringify(body)` with `Content-Type: application/json`. No risk of header injection or body manipulation.

---

## 3. Test Coverage Assessment

| Concern | ClaudeCLIAdapter | CallbackClient |
|---------|:---:|:---:|
| Happy path | yes | yes |
| Timeout / kill | yes | yes |
| Abort / cancel | yes | n/a |
| Error handling | yes | yes |
| Retry / backoff | n/a | yes |
| Security-specific test (no shell) | yes | no |
| SSRF validation | n/a | **missing** |

Test quality is good. The `claudeCLIAdapter.test.js` includes a dedicated security assertion (line 318: `shell` is undefined). The callback tests cover retry exhaustion and timeout but do not test URL validation — because no validation exists yet.

---

## Findings Summary

| ID | Component | Severity | Description |
|----|-----------|----------|-------------|
| F-SEC-01 | ClaudeCLIAdapter | Low | stderr content in error messages may leak internal details |
| F-SEC-02 | CallbackClient | Medium | No SSRF protection on `callbackUrl` |
| F-SEC-03 | CallbackClient | Low | No circuit breaker for failing callback targets |

---

## Verdict

**APPROVED** with the recommendation to address F-SEC-02 (SSRF) before production deployment. The Claude CLI adapter demonstrates strong security practices: array-based spawn, stdin for untrusted input, explicit env allowlist, and proper process lifecycle management. The callback client is functionally sound but needs URL validation to prevent SSRF in a networked deployment.
