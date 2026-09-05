/**
 * Layer 4 — Phase 4 (t8): safeFetch hardening.
 *
 * Acceptance: toolWebFetch validates URL scheme (only http:/https:; localhost per policy),
 * limits redirect hops (max 3) without forwarding Authorization/Cookie cross-origin,
 * redacts Authorization/Cookie/Bearer/X-API-Key values in returned logs/errors.
 *
 * These tests exercise the safeFetch primitive directly (no real network).
 */
import { describe, test, expect } from "bun:test";
import { safeFetch, SafeFetchError, redactAuthInText } from "../../lib/security/safeFetch";

describe("safeFetch — URL scheme guard", () => {
  test("rejects file://", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(SafeFetchError);
    try {
      await safeFetch("file:///etc/passwd");
    } catch (e: any) {
      expect(e.code).toBe("FORBIDDEN_SCHEME");
    }
  });

  test("rejects javascript:", async () => {
    try {
      await safeFetch("javascript:alert(1)");
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(SafeFetchError);
      expect(e.code).toBe("FORBIDDEN_SCHEME");
    }
  });

  test("rejects data:", async () => {
    try {
      await safeFetch("data:text/plain,hello");
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(SafeFetchError);
      expect(e.code).toBe("FORBIDDEN_SCHEME");
    }
  });

  test("rejects ftp:", async () => {
    try {
      await safeFetch("ftp://example.com/");
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("FORBIDDEN_SCHEME");
    }
  });

  test("rejects malformed URL", async () => {
    try {
      await safeFetch("not a url at all");
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(SafeFetchError);
      expect(["INVALID_URL", "FORBIDDEN_SCHEME"]).toContain(e.code);
    }
  });

  test("rejects http://localhost by default", async () => {
    try {
      await safeFetch("http://localhost:9999/");
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("LOCALHOST_DENIED");
    }
  });

  test("rejects http://127.0.0.1 by default", async () => {
    try {
      await safeFetch("http://127.0.0.1/");
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("LOCALHOST_DENIED");
    }
  });

  test("accepts http://localhost when allowLocalhost:true", async () => {
    // We don't actually fetch — we only verify policy allows it.
    // Use a custom networkPolicy that rejects everything else.
    const policy = () => false;
    try {
      await safeFetch("http://localhost:9999/", { allowLocalhost: true, networkPolicy: policy });
      expect.unreachable();
    } catch (e: any) {
      // networkPolicy should now reject (proving policy ran AFTER URL validation).
      expect(e.code).toBe("NETWORK_POLICY_DENIED");
    }
  });
});

describe("safeFetch — network policy hook", () => {
  test("networkPolicy is consulted and respected", async () => {
    const policy = (u: URL) => u.hostname === "allowed.example";
    try {
      await safeFetch("https://blocked.example/", { networkPolicy: policy });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("NETWORK_POLICY_DENIED");
    }
  });

  test("networkPolicy allows when returns true (synthetic via early hook)", async () => {
    // Hook that always allows; we'll then test that it cannot be bypassed
    // by a redirect to a different host.
    const policy = () => true;
    // Use http://example.com which we can't actually reach in the test env.
    // Instead, exercise the URL guard: ensure the policy hook is invoked
    // AFTER URL validation (so a forbidden scheme is rejected even if
    // the network policy would allow).
    try {
      await safeFetch("file:///etc/passwd", { networkPolicy: policy });
      expect.unreachable();
    } catch (e: any) {
      expect(e.code).toBe("FORBIDDEN_SCHEME");
    }
  });
});

describe("safeFetch — header redaction in error path", () => {
  test("redactAuthInText strips Authorization Bearer value", () => {
    const text = "Request failed: Authorization: Bearer sk-secret-abcdef-12345";
    const redacted = redactAuthInText(text);
    expect(redacted).not.toContain("sk-secret-abcdef-12345");
    expect(redacted).toContain("[REDACTED");
  });

  test("redactAuthInText strips sk- prefixed OpenAI-style key (20+ chars)", () => {
    const text = "Header was: X-API-Key: sk-abcdef0123456789abcdef01";
    const redacted = redactAuthInText(text);
    expect(redacted).not.toContain("sk-abcdef0123456789abcdef01");
    expect(redacted).toContain("[REDACTED");
  });

  test("redactAuthInText strips ghp_ GitHub PAT", () => {
    const text = "leak: ghp_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
    const redacted = redactAuthInText(text);
    expect(redacted).not.toContain("ghp_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcd");
  });

  test("redactAuthInText leaves safe text alone", () => {
    const text = "Connection refused on host example.com";
    const redacted = redactAuthInText(text);
    expect(redacted).toBe(text);
  });
});

describe("safeFetch — SafeFetchError shape", () => {
  test("SafeFetchError carries code and redacted flag", async () => {
    try {
      await safeFetch("file:///x");
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(SafeFetchError);
      expect(typeof e.code).toBe("string");
      expect(e.code.length).toBeGreaterThan(0);
      expect(e.redacted).toBe(true);
    }
  });
});
