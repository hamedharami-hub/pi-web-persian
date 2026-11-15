import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./request-security.ts");
}

test("allows same-origin and non-browser API requests", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  })), true);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { host: "localhost:30141" },
  })), true);
});

test("allows LAN same-origin requests when Next.js uses an internal localhost URL", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://192.168.32.7:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), true);
});

test("allows IPv6 and an explicitly configured hostname", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const ipv6 = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "[::1]:30141",
      origin: "http://[::1]:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  const configured = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "pi-web.internal:30141",
      origin: "http://pi-web.internal:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(ipv6), true);
  assert.equal(isApiRequestAllowed(configured, ["pi-web.internal"]), true);
});

test("rejects cross-origin browser API requests", async () => {
  const { isApiRequestAllowed, shouldCheckApiRequestOrigin } = await loadSubject();
  const post = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
  const crossSiteGet = new Request("http://localhost:30141/api/sessions", {
    headers: { host: "localhost:30141", "sec-fetch-site": "cross-site" },
  });
  assert.equal(shouldCheckApiRequestOrigin(post), true);
  assert.equal(isApiRequestAllowed(post), false);
  assert.equal(shouldCheckApiRequestOrigin(crossSiteGet), true);
  assert.equal(isApiRequestAllowed(crossSiteGet), false);
});

test("does not globally trust opaque iframe or alternate loopback origins", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const previewUrl = "http://localhost:30141/api/files/tmp/test.docx?type=preview";
  const opaqueIframe = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "null",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    },
  });
  const alternateLoopback = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "http://127.0.0.1:30141",
      "sec-fetch-site": "cross-site",
    },
  });

  assert.equal(isApiRequestAllowed(opaqueIframe), false);
  assert.equal(isApiRequestAllowed(alternateLoopback), false);
});

test("allows only user-initiated session export document navigations from a PWA", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const navigationHeaders = {
    host: "127.0.0.1:30141",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };

  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: navigationHeaders },
  )), true);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions",
    { headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, "sec-fetch-dest": "empty" } },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    {
      headers: {
        ...navigationHeaders,
        "sec-fetch-user": "",
      },
    },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { method: "POST", headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, host: "attacker.example:30141" } },
  )), false);
});

test("allows only user-initiated PDF reads from Android Chrome's placeholder", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const pdfUrl = "https://pi.tailnet.ts.net/api/files/home/me/project/sample.pdf?type=read&v=1";
  // Chrome's data: placeholder opens the link with target=_blank: no Origin
  // or Referer, and the opaque initiator makes it cross-site (#1298).
  const navigationHeaders = {
    host: "pi.tailnet.ts.net",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };
  const allowed = (url, init = {}) => isApiRequestAllowed(
    new Request(url, { ...init, headers: { ...navigationHeaders, ...init.headers } }),
    ["pi.tailnet.ts.net"],
  );

  assert.equal(allowed(pdfUrl), true);
  assert.equal(allowed("https://pi.tailnet.ts.net/api/files/C%3A/Users/me/Paper%20One.PDF?type=read"), true);
  assert.equal(allowed("https://pi.tailnet.ts.net/api/files/tmp/r%C3%A9sum%C3%A9.pdf?sessionId=s1&type=read"), true);

  for (const url of [
    "https://pi.tailnet.ts.net/api/files/home/me/project/sample.pdf?type=download",
    "https://pi.tailnet.ts.net/api/files/home/me/project/sample.pdf?type=meta",
    "https://pi.tailnet.ts.net/api/files/home/me/project/sample.pdf?type=watch",
    "https://pi.tailnet.ts.net/api/files/home/me/project/sample.pdf",
    "https://pi.tailnet.ts.net/api/files/home/me/project/sample.pdf?type=list&type=read",
    "https://pi.tailnet.ts.net/api/files/home/me/project/page.html?type=read",
    "https://pi.tailnet.ts.net/api/files/home/me/project/image.svg?type=read",
    "https://pi.tailnet.ts.net/api/files/home/me/project/sample.pdf.html?type=read",
    "https://pi.tailnet.ts.net/api/files/home/me/project/sample.pdf%00?type=read",
    "https://pi.tailnet.ts.net/api/files/home/me/project/sample.pdf/?type=read",
    "https://pi.tailnet.ts.net/api/files/home/me/%E0%A4%A.pdf?type=read",
    "https://pi.tailnet.ts.net/api/sessions/x.pdf?type=read",
    "https://pi.tailnet.ts.net/api/filesx/sample.pdf?type=read",
  ]) {
    assert.equal(allowed(url), false, url);
  }

  assert.equal(allowed(pdfUrl, { headers: { "sec-fetch-dest": "iframe" } }), false);
  assert.equal(allowed(pdfUrl, { headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" } }), false);
  assert.equal(allowed(pdfUrl, { headers: { "sec-fetch-user": "?0" } }), false);
  assert.equal(allowed(pdfUrl, { method: "POST" }), false);
  assert.equal(allowed(pdfUrl, { headers: { host: "attacker.example" } }), false);
});

test("rejects an origin that does not match the external request host", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects DNS rebinding even when browser headers say same-origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/skills/install", {
    method: "POST",
    headers: {
      host: "attacker.example:30141",
      origin: "http://attacker.example:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects missing, malformed, and unconfigured Host headers", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test")), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "localhost@attacker.example:30141" },
  })), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "pi-web.internal:30141" },
  })), false);
});

test("recognizes JSON request content types", async () => {
  const { hasJsonContentType } = await loadSubject();
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/json; charset=utf-8" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/problem+json" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "text/plain" },
  })), false);
});

test("allows a proxy that reports the scheme out-of-band and rewrites Origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  // Azure Dev Tunnels normalizes Host and Origin onto the backend authority
  // but keeps the external scheme in x-forwarded-proto.
  const request = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), true);
});

test("still rejects a foreign origin when a proxy is in front", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const foreignHost = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://attacker.example",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  const foreignPort = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30142",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  const alternateLoopback = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://127.0.0.1:30141",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  const opaque = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "null",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });

  assert.equal(isApiRequestAllowed(foreignHost), false);
  assert.equal(isApiRequestAllowed(foreignPort), false);
  assert.equal(isApiRequestAllowed(alternateLoopback), false);
  assert.equal(isApiRequestAllowed(opaque), false);
});

test("does not relax the scheme without same-origin proxy evidence", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);

  request.headers.set("x-forwarded-proto", "https");
  request.headers.set("sec-fetch-site", "same-site");
  assert.equal(isApiRequestAllowed(request), false);
});

test("allows HTTPS reverse-proxy requests to an HTTP backend via x-forwarded-proto only with same-origin Fetch Metadata or PI_WEB_TRUST_PROXY=1", async (t) => {
  const previousTrustProxy = process.env.PI_WEB_TRUST_PROXY;
  t.after(() => {
    if (previousTrustProxy === undefined) delete process.env.PI_WEB_TRUST_PROXY;
    else process.env.PI_WEB_TRUST_PROXY = previousTrustProxy;
  });
  delete process.env.PI_WEB_TRUST_PROXY;

  const { isApiRequestAllowed } = await loadSubject();
  const allowedHosts = ["pi.tailnet.ts.net"];

  // Comma-separated proxy chain x-forwarded-proto with sec-fetch-site: same-origin succeeds without PI_WEB_TRUST_PROXY.
  const chainedProxy = new Request("http://localhost:30141/api/agent/s1/lease", {
    method: "POST",
    headers: {
      host: "pi.tailnet.ts.net",
      origin: "https://pi.tailnet.ts.net",
      "x-forwarded-proto": "https, http",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(chainedProxy, allowedHosts), true);

  // Without sec-fetch-site: same-origin and without PI_WEB_TRUST_PROXY=1, x-forwarded-proto is not trusted.
  const withoutFetchMetadata = new Request("http://127.0.0.1:30141/api/sessions/s1", {
    method: "GET",
    headers: {
      host: "pi.tailnet.ts.net",
      origin: "https://pi.tailnet.ts.net",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(isApiRequestAllowed(withoutFetchMetadata, allowedHosts), false);

  const sameSiteSpoof = new Request("http://127.0.0.1:30141/api/test", {
    method: "POST",
    headers: {
      host: "pi.tailnet.ts.net",
      origin: "https://pi.tailnet.ts.net",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestAllowed(sameSiteSpoof, allowedHosts), false);

  // With PI_WEB_TRUST_PROXY=1, x-forwarded-proto is trusted even when Fetch Metadata is omitted.
  process.env.PI_WEB_TRUST_PROXY = "1";
  assert.equal(isApiRequestAllowed(withoutFetchMetadata, allowedHosts), true);

  // Malformed x-forwarded-proto falls back to backend protocol and never matches an https Origin.
  const malformedProto = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "pi.tailnet.ts.net",
      origin: "https://pi.tailnet.ts.net",
      "x-forwarded-proto": "javascript",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(malformedProto, allowedHosts), false);
});
