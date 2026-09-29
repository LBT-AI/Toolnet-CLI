# Phase 1.3 — Web Fetch Resilience

Finding:
TN-R0-005B

Root cause:
The `web_fetch` tool lacked internal resilience, returning transient networking and server failures immediately to the agent model. The model then had to use additional provider turns to manually execute another fetch attempt, consuming the hard turn budget (maxTurns=10) and slowing down execution. 

Retry policy:
- max attempts: 3 (initial + 2 retries)
- retryable errors: `SafeFetchError` with codes `TIMEOUT`, `NETWORK_ERROR`, `NO_RESPONSE` as well as native `TypeError` (e.g. standard Node fetch network disconnects).
- retryable HTTP: 408 (Request Timeout), 425 (Too Early), 429 (Too Many Requests), 500 (Internal Server Error), 502 (Bad Gateway), 503 (Service Unavailable), 504 (Gateway Timeout).
- non-retryable HTTP: 400, 401, 403, 404, 405 (and other non-whitelisted 4xx status codes).
- backoff: Bounded hardcoded delay, waiting 250ms before attempt 2 and 750ms before attempt 3. 

Timeout:
Maintained the existing 20,000ms per attempt to keep worst-case bounded latency tight. Theoretical worst-case fetch latency is now ~60 seconds (3 x 20,000ms) which respects UX thresholds without introducing uncontrolled pauses.

Browser fallback:
NO (Deferred to higher level intelligence, in alignment with Phase 1.2 bounds).

Success-after-retry:
PASS

Timeout exhaustion:
PASS

404 no retry:
PASS

403 no retry:
PASS

Abort stops retry:
PASS

Turn-budget improvement:
By internally capturing transient fetch failures and successfully fetching inside a single provider turn execution, the tool now outputs a success outcome to the agent instead of a failure, thereby completely eliminating wasted LLM retry requests and reducing turn budget depletion.

Tests:
Reused and expanded `src/lib/__tests__/webFetchTimeout.test.ts`. Verified A-L scenarios including success, timeout, exhaustions, status validations and cancellation semantics. Mocks use fake time (or controlled fast sleeps) with intercepted `fetch` to keep test suites blazing fast. 

Production behavior changed:
YES
