import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest, refreshSource } from "../src/index";

class MemoryKV {
  values = new Map<string, { value: string; metadata: unknown }>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key)?.value ?? null;
  }

  async getWithMetadata<T>(key: string): Promise<{ value: string | null; metadata: T | null }> {
    const entry = this.values.get(key);
    return {
      value: entry?.value ?? null,
      metadata: (entry?.metadata as T) ?? null,
    };
  }

  async put(key: string, value: string, options: { metadata?: unknown } = {}): Promise<void> {
    this.values.set(key, { value, metadata: options.metadata ?? null });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function makeEnv(overrides = {}) {
  return {
    SUB_CACHE: new MemoryKV() as unknown as KVNamespace,
    ADMIN_TOKEN: "admin-token",
    PUBLIC_TOKEN: "public-token",
    CACHE_TTL_SECONDS: "3600",
    STALE_TTL_SECONDS: "1209600",
    ...overrides,
  };
}

function adminRequest(path: string, body: unknown): Request {
  return new Request(`https://cache.test${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer admin-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function adminGet(path: string): Request {
  return new Request(`https://cache.test${path}`, {
    headers: {
      authorization: "Bearer admin-token",
    },
  });
}

test("stores any configured source and serves cached subscription content", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "airport-a", url: "https://upstream.test/airport-a" }],
    }),
    env,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("proxy-a = direct\n", { headers: { "content-type": "text/plain" } });

  try {
    const response = await handleRequest(new Request("https://cache.test/sub/airport-a?token=public-token"), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-sub-cache"), "REFRESHED");
    assert.equal(await response.text(), "proxy-a = direct\n");

    const second = await handleRequest(new Request("https://cache.test/sub/airport-a?token=public-token"), env);
    assert.equal(second.headers.get("x-sub-cache"), "HIT");
    assert.equal(await second.text(), "proxy-a = direct\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps serving stale cache when upstream returns 403", async () => {
  const env = makeEnv({ CACHE_TTL_SECONDS: "1" });
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "airport-b", url: "https://upstream.test/airport-b" }],
    }),
    env,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("airport-b-proxy = direct\n", { status: 200 });

  try {
    await refreshSource(env, "airport-b");
    const kv = env.SUB_CACHE as unknown as MemoryKV;
    const entry = kv.values.get("cache:airport-b");
    assert.ok(entry);
    (entry.metadata as { updatedAt: string }).updatedAt = new Date(Date.now() - 10_000).toISOString();

    const waits: Promise<unknown>[] = [];
    globalThis.fetch = async () => new Response("expired", { status: 403 });
    const response = await handleRequest(new Request("https://cache.test/sub/airport-b?token=public-token"), env, {
      waitUntil(promise) {
        waits.push(promise);
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-sub-cache"), "STALE");
    assert.equal(await response.text(), "airport-b-proxy = direct\n");
    await Promise.all(waits);

    const cached = await env.SUB_CACHE.get("cache:airport-b");
    assert.equal(cached, "airport-b-proxy = direct\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("returns an empty subscription when upstream fails before first cache", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "cold-airport", url: "https://upstream.test/cold-airport" }],
    }),
    env,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("temporary failure", { status: 502 });

  try {
    const response = await handleRequest(new Request("https://cache.test/sub/cold-airport?token=public-token"), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-sub-cache"), "EMPTY");
    assert.equal(
      await response.text(),
      "Evergreen Empty = reject\nEvergreen Empty 1x = reject\nEvergreen Empty 家宽 = reject\n",
    );
    assert.equal(await env.SUB_CACHE.get("cache:cold-airport"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects subscription requests without public token", async () => {
  const env = makeEnv();
  const response = await handleRequest(new Request("https://cache.test/sub/airport-a"), env);
  assert.equal(response.status, 401);
});

test("subscription HEAD requests do not fetch upstream", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "head-airport", url: "https://upstream.test/head-airport" }],
    }),
    env,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("HEAD should not fetch upstream");
  };

  try {
    const response = await handleRequest(
      new Request("https://cache.test/sub/head-airport?token=public-token", { method: "HEAD" }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-sub-cache"), "EMPTY");
    assert.equal(await response.text(), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reads default sources before any dynamic configuration is saved", async () => {
  const env = makeEnv({
    DEFAULT_SOURCES: JSON.stringify({
      sources: [{ name: "default-airport", url: "https://upstream.test/default-airport" }],
    }),
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("default-proxy = direct\n", { status: 200 });

  try {
    const response = await handleRequest(new Request("https://cache.test/sub/default-airport?token=public-token"), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "default-proxy = direct\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dynamic source configuration is layered over default sources", async () => {
  const env = makeEnv({
    DEFAULT_SOURCES: JSON.stringify({
      sources: [{ name: "default-airport", url: "https://upstream.test/default-airport" }],
    }),
  });

  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "dynamic-airport", url: "https://upstream.test/dynamic-airport" }],
    }),
    env,
  );

  const status = await handleRequest(adminGet("/admin/status"), env);
  const statusBody = (await status.json()) as { sources: Array<{ name: string }> };
  assert.deepEqual(
    statusBody.sources.map((source) => source.name).sort(),
    ["default-airport", "dynamic-airport"],
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("dynamic-proxy = direct\n", { status: 200 });

  try {
    const response = await handleRequest(new Request("https://cache.test/sub/dynamic-airport?token=public-token"), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "dynamic-proxy = direct\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports proxy count from cached subscription content", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "count-airport", url: "https://upstream.test/count-airport" }],
    }),
    env,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("proxy-a = ss, host-a, 443, encrypt-method=aes-128-gcm, password=p\nproxy-b = trojan, host-b, 443, password=p\n", {
      status: 200,
    });

  try {
    await refreshSource(env, "count-airport");
    const status = await handleRequest(adminGet("/admin/status"), env);
    const body = (await status.json()) as { sources: Array<{ name: string; proxyCount: number; proxyCountKnown: boolean }> };
    assert.equal(body.sources.find((source) => source.name === "count-airport")?.proxyCount, 2);
    assert.equal(body.sources.find((source) => source.name === "count-airport")?.proxyCountKnown, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stores successful and failed refresh state separately", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "state-airport", url: "https://upstream.test/state-airport" }],
    }),
    env,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("state-proxy = direct\n", { status: 200 });

  try {
    const success = await refreshSource(env, "state-airport");
    assert.equal(success.ok, true);

    globalThis.fetch = async () => new Response("blocked", { status: 403 });
    const failure = await refreshSource(env, "state-airport");
    assert.equal(failure.ok, false);

    const status = await handleRequest(adminGet("/admin/status"), env);
    const body = (await status.json()) as {
      sources: Array<{
        name: string;
        lastRefreshOk: boolean;
        lastSuccessAt: string | null;
        lastSuccessProxyCount: number | null;
        lastFailureAt: string | null;
        lastFailureStatus: number | null;
        lastFailureError: string | null;
      }>;
    };
    const source = body.sources.find((item) => item.name === "state-airport");
    assert.equal(source?.lastRefreshOk, false);
    assert.ok(source?.lastSuccessAt);
    assert.equal(source?.lastSuccessProxyCount, 1);
    assert.ok(source?.lastFailureAt);
    assert.equal(source?.lastFailureStatus, 403);
    assert.equal(source?.lastFailureError, "Upstream returned 403");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("imports subscription content into cache through admin API", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "import-airport", url: "https://upstream.test/import-airport" }],
    }),
    env,
  );

  const response = await handleRequest(
    adminRequest("/admin/cache/import-airport", {
      content: "imported-proxy = ss, imported.example, 443, encrypt-method=aes-128-gcm, password=p\n",
      contentType: "text/plain",
      status: 200,
    }),
    env,
  );

  assert.equal(response.status, 200);
  const result = (await response.json()) as { result: { ok: boolean; cacheStatus: string; proxyCount: number } };
  assert.equal(result.result.ok, true);
  assert.equal(result.result.cacheStatus, "IMPORTED");
  assert.equal(result.result.proxyCount, 1);
  assert.equal(
    await env.SUB_CACHE.get("cache:import-airport"),
    "imported-proxy = ss, imported.example, 443, encrypt-method=aes-128-gcm, password=p\n",
  );
});

test("uses Surge-like headers when fetching upstream subscriptions", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "headers-airport", url: "https://upstream.test/headers-airport" }],
    }),
    env,
  );

  const capturedHeaders: Headers[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    capturedHeaders.push(new Headers(init?.headers));
    return new Response("proxy-a = ss, host-a, 443, encrypt-method=aes-128-gcm, password=p\n", { status: 200 });
  };

  try {
    await refreshSource(env, "headers-airport");
    const headers = capturedHeaders[0];
    assert.ok(headers);
    assert.equal(headers.get("user-agent"), "Surge/5.0");
    assert.equal(headers.get("accept"), "*/*");
    assert.equal(headers.get("accept-language"), "zh-Hans-CN;q=1, en-CN;q=0.9");
    assert.equal(headers.get("cache-control"), "no-cache");
    assert.equal(headers.get("pragma"), "no-cache");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("converts base64 URI subscriptions into Surge proxy lines", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "direct-airport", url: "https://upstream.test/direct-airport" }],
    }),
    env,
  );

  const rawSubscription = [
    "trojan://notice@0.0.0.0:443?type=ws#notice",
    "trojan://secret@example.com:443?type=tcp&sni=edge.example.com&allowInsecure=1#US%2001",
    "vless://uuid@example.com:443?type=tcp&security=tls&flow=xtls-rprx-vision#HK%2001",
  ].join("\n");
  const encoded = Buffer.from(rawSubscription, "utf8").toString("base64");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(encoded, { status: 200 });

  try {
    const result = await refreshSource(env, "direct-airport");
    assert.equal(result.ok, true);
    assert.equal(result.proxyCount, 1);

    const cached = await env.SUB_CACHE.get("cache:direct-airport");
    assert.equal(
      cached,
      "US 01 = trojan, example.com, 443, password=secret, sni=edge.example.com, skip-cert-verify=true\n",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deleting a source clears cached content and refresh state", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "delete-airport", url: "https://upstream.test/delete-airport" }],
    }),
    env,
  );

  const kv = env.SUB_CACHE as unknown as MemoryKV;
  await kv.put("cache:delete-airport", "delete-proxy = direct\n", { metadata: { proxyCount: 1 } });
  await kv.put("refresh:delete-airport", JSON.stringify({ name: "delete-airport", ok: true }));
  await kv.put("refresh-success:delete-airport", JSON.stringify({ name: "delete-airport", ok: true }));
  await kv.put("refresh-failure:delete-airport", JSON.stringify({ name: "delete-airport", ok: false }));

  const response = await handleRequest(
    new Request("https://cache.test/admin/source/delete-airport", {
      method: "DELETE",
      headers: { authorization: "Bearer admin-token" },
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(await env.SUB_CACHE.get("source:delete-airport"), null);
  assert.equal(await env.SUB_CACHE.get("cache:delete-airport"), null);
  assert.equal(await env.SUB_CACHE.get("refresh:delete-airport"), null);
  assert.equal(await env.SUB_CACHE.get("refresh-success:delete-airport"), null);
  assert.equal(await env.SUB_CACHE.get("refresh-failure:delete-airport"), null);
});

test("replacing sources removes old dynamic source artifacts", async () => {
  const env = makeEnv();
  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "old-airport", url: "https://upstream.test/old-airport" }],
    }),
    env,
  );
  const kv = env.SUB_CACHE as unknown as MemoryKV;
  await kv.put("cache:old-airport", "old-proxy = direct\n", { metadata: { proxyCount: 1 } });
  await kv.put("refresh:old-airport", JSON.stringify({ name: "old-airport", ok: true }));
  await kv.put("refresh-success:old-airport", JSON.stringify({ name: "old-airport", ok: true }));
  await kv.put("refresh-failure:old-airport", JSON.stringify({ name: "old-airport", ok: false }));

  await handleRequest(
    adminRequest("/admin/sources", {
      sources: [{ name: "new-airport", url: "https://upstream.test/new-airport" }],
    }),
    env,
  );

  assert.equal(await env.SUB_CACHE.get("source:old-airport"), null);
  assert.equal(await env.SUB_CACHE.get("cache:old-airport"), null);
  assert.equal(await env.SUB_CACHE.get("refresh:old-airport"), null);
  assert.equal(await env.SUB_CACHE.get("refresh-success:old-airport"), null);
  assert.equal(await env.SUB_CACHE.get("refresh-failure:old-airport"), null);
  assert.ok(await env.SUB_CACHE.get("source:new-airport"));
});

test("requires Cloudflare Access for admin routes when Access is configured", async () => {
  const env = makeEnv({
    CF_ACCESS_AUD: "audience",
    CF_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
  });

  const response = await handleRequest(new Request("https://cache.test/admin?admin_token=admin-token"), env);
  assert.equal(response.status, 401);
});
