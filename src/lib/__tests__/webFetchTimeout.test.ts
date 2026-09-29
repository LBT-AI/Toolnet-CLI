import { test, expect, mock, afterEach } from "bun:test";
import { toolWebFetch } from "../codingAgent";
import { SafeFetchError } from "../security/safeFetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// A. 200 first attempt
test("A. 200 first attempt -> 1 attempt -> success", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    return new Response("<html>hello</html>", { status: 200 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(true);
  expect(attempts).toBe(1);
});

// B. timeout, then 200
test("B. timeout, then 200 -> 2 attempts -> success", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    if (attempts === 1) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError"; // safeFetch translates this to TIMEOUT
      throw err;
    }
    return new Response("<html>hello</html>", { status: 200 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(true);
  expect(attempts).toBe(2);
});

// C. timeout, 503, 200
test("C. timeout, 503, 200 -> 3 attempts -> success", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    if (attempts === 1) {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    } else if (attempts === 2) {
      return new Response("Service Unavailable", { status: 503 });
    }
    return new Response("<html>hello</html>", { status: 200 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(true);
  expect(attempts).toBe(3);
});

// D. timeout x 3
test("D. timeout x 3 -> failure -> exactly 3 attempts", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(false);
  expect(res.error).toContain("after 3 attempts");
  expect(res.structuredError?.code).toBe("TIMEOUT");
  expect(res.structuredError?.retryable).toBe(true);
  expect(attempts).toBe(3);
});

// E. 500, then 200
test("E. 500, then 200 -> retry then success", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    if (attempts === 1) return new Response("Error", { status: 500 });
    return new Response("<html>hello</html>", { status: 200 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(true);
  expect(attempts).toBe(2);
});

// F. 502, then 200
test("F. 502, then 200 -> retry then success", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    if (attempts === 1) return new Response("Error", { status: 502 });
    return new Response("<html>hello</html>", { status: 200 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(true);
  expect(attempts).toBe(2);
});

// G. 503, then 200
test("G. 503, then 200 -> retry then success", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    if (attempts === 1) return new Response("Error", { status: 503 });
    return new Response("<html>hello</html>", { status: 200 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(true);
  expect(attempts).toBe(2);
});

// H. 504, then 200
test("H. 504, then 200 -> retry then success", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    if (attempts === 1) return new Response("Error", { status: 504 });
    return new Response("<html>hello</html>", { status: 200 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(true);
  expect(attempts).toBe(2);
});

// I. 404 -> exactly 1 attempt
test("I. 404 -> exactly 1 attempt", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    return new Response("Not Found", { status: 404 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(false);
  expect(res.error).not.toContain("after 3 attempts");
  expect(res.structuredError?.code).toBe("HTTP_ERROR");
  expect(res.structuredError?.details?.status).toBe(404);
  expect(attempts).toBe(1);
});

// J. 403 -> exactly 1 attempt
test("J. 403 -> exactly 1 attempt", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    return new Response("Forbidden", { status: 403 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(false);
  expect(res.error).not.toContain("after 3 attempts");
  expect(res.structuredError?.code).toBe("HTTP_ERROR");
  expect(res.structuredError?.details?.status).toBe(403);
  expect(attempts).toBe(1);
});

// K. malformed URL -> no retry
test("K. malformed URL -> no retry", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    return new Response();
  }) as never;

  const res = await toolWebFetch("not-a-url");
  expect(res.success).toBe(false);
  // It shouldn't even reach fetch
  expect(attempts).toBe(0);
});

// L. AbortSignal/cancel -> no further retry
test("L. AbortSignal/cancel -> no further retry", async () => {
  let attempts = 0;
  const ac = new AbortController();
  globalThis.fetch = mock(async () => {
    attempts++;
    ac.abort(); // Cancel during the first attempt
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }) as never;

  const res = await toolWebFetch("https://example.com", ac.signal);
  expect(res.success).toBe(false);
  expect(res.error).toBe("Cancelled");
  expect(res.structuredError?.code).toBe("CANCELLED");
  expect(attempts).toBe(1);
});

// M. 503 x 3 -> failure -> exactly 3 attempts
test("M. 503 x 3 -> failure -> exactly 3 attempts", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    return new Response("Service Unavailable", { status: 503 });
  }) as never;

  const res = await toolWebFetch("https://example.com");
  expect(res.success).toBe(false);
  expect(res.error).toContain("after 3 attempts");
  expect(res.structuredError?.code).toBe("HTTP_ERROR");
  expect(res.structuredError?.details?.status).toBe(503);
  expect(res.structuredError?.retryable).toBe(true);
  expect(attempts).toBe(3);
});
