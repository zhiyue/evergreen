import { createRemoteJWKSet, jwtVerify } from "jose";

type SourceConfig = {
  name: string;
  url: string;
  enabled: boolean;
  ttlSeconds?: number;
  headers?: Record<string, string>;
};

type CacheMetadata = {
  sourceName: string;
  updatedAt: string;
  contentType: string;
  status: number;
  bytes: number;
  ttlSeconds: number;
  proxyCount?: number;
};

type RefreshResult = {
  name: string;
  ok: boolean;
  attemptedAt: string;
  cacheStatus?: string;
  updatedAt?: string;
  bytes?: number;
  proxyCount?: number;
  skipped?: boolean;
  reason?: string;
  status?: number;
  error?: string;
};

type Env = {
  SUB_CACHE: KVNamespace;
  ADMIN_TOKEN?: string;
  PUBLIC_TOKEN?: string;
  DEFAULT_SOURCES?: string;
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CACHE_TTL_SECONDS?: string;
  STALE_TTL_SECONDS?: string;
};

type ExecutionLike = Pick<ExecutionContext, "waitUntil">;
type RemoteJWKSet = ReturnType<typeof createRemoteJWKSet>;

const SOURCE_INDEX_KEY = "sources:index";
const REFRESH_PREFIX = "refresh:";
const DEFAULT_CACHE_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_STALE_TTL_SECONDS = 14 * 24 * 60 * 60;
const MAX_SUBSCRIPTION_BYTES = 10 * 1024 * 1024;
const EMPTY_SUBSCRIPTION_BODY = [
  "Evergreen Empty = reject",
  "Evergreen Empty 1x = reject",
  "Evergreen Empty 家宽 = reject",
  "",
].join("\n");
const SURGE_UPSTREAM_HEADERS = {
  "user-agent": "Surge/5.0",
  accept: "*/*",
  "accept-language": "zh-Hans-CN;q=1, en-CN;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};
const jwksCache = new Map<string, RemoteJWKSet>();

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionLike = { waitUntil() {} },
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = normalizePath(url.pathname);

  if (request.method === "GET" && pathname === "/") {
    return new Response("Surge subscription cache is running.\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (request.method === "GET" && pathname === "/health") {
    return json({ ok: true });
  }

  if (request.method === "GET" && pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  if (pathname === "/admin" && request.method === "GET") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    return adminPage(request, await buildStatus(env));
  }

  if (pathname === "/admin/status" && request.method === "GET") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    return json({ sources: await buildStatus(env) });
  }

  if (pathname === "/admin/sources") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;

    if (request.method === "GET") {
      return json({ sources: await listSources(env) });
    }

    if (request.method === "POST") {
      const body = await readJson(request);
      const sources = Array.isArray(body) ? body : body.sources;
      if (!Array.isArray(sources)) return json({ error: "Expected a sources array" }, 400);
      const saved = await replaceSources(env, sources);
      return json({ saved });
    }
  }

  const adminSourceMatch = pathname.match(/^\/admin\/source\/(.+)$/);
  if (adminSourceMatch && ["PUT", "POST", "PATCH"].includes(request.method)) {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    const name = decodeURIComponent(adminSourceMatch[1]);
    const body = await readJson(request);
    const source =
      request.method === "PATCH" ? await patchSource(env, name, body) : await upsertSource(env, { ...body, name });
    return json({ saved: summarizeSource(source) });
  }

  if (adminSourceMatch && request.method === "DELETE") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    const name = decodeURIComponent(adminSourceMatch[1]);
    const deleted = await deleteSource(env, name);
    return json({ deleted });
  }

  if (pathname === "/admin/refresh" && request.method === "POST") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    const body = await readJson(request, {});
    const results = await refreshAllSources(env, body.names);
    return json({ results });
  }

  const refreshMatch = pathname.match(/^\/admin\/refresh\/(.+)$/);
  if (refreshMatch && request.method === "POST") {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    const name = decodeURIComponent(refreshMatch[1]);
    const result = await refreshSource(env, name);
    return json({ result });
  }

  const subMatch = pathname.match(/^\/sub\/(.+)$/);
  if (subMatch && ["GET", "HEAD"].includes(request.method)) {
    const denied = requirePublicToken(request, env);
    if (denied) return denied;
    const name = decodeURIComponent(subMatch[1]);
    if (request.method === "HEAD") return headSubscription(env, name);
    return serveSubscription(env, ctx, name);
  }

  return json({ error: "Not found" }, 404);
}

async function serveSubscription(env: Env, ctx: ExecutionLike, name: string): Promise<Response> {
  validateName(name);
  const source = await getSource(env, name);
  if (!source) return json({ error: `Unknown source: ${name}` }, 404);
  if (source.enabled === false) return json({ error: `Source is disabled: ${name}` }, 409);

  const cached = await getCachedSubscription(env, name);
  const hasUsableCache = Boolean(cached.value && countSubscriptionItems(cached.value) > 0);
  const now = Date.now();

  if (hasUsableCache && cached.value && isFresh(cached.metadata, ttlSeconds(env, source), now)) {
    return subscriptionResponse(cached.value, cached.metadata, "HIT");
  }

  if (hasUsableCache && cached.value && isWithinStaleWindow(cached.metadata, staleTtlSeconds(env), now)) {
    ctx.waitUntil(
      refreshSource(env, name).catch((error) => {
        console.error(`Background refresh failed for ${name}:`, error);
      }),
    );
    return subscriptionResponse(cached.value, cached.metadata, "STALE");
  }

  try {
    const result = await refreshSource(env, name);
    if (!result.ok) {
      if (hasUsableCache && cached.value) return subscriptionResponse(cached.value, cached.metadata, "STALE");
      return emptySubscriptionResponse(result.error || "Refresh failed");
    }
    const next = await getCachedSubscription(env, name);
    if (!next.value) return emptySubscriptionResponse("Refresh succeeded but cache is empty");
    return subscriptionResponse(next.value, next.metadata, String(result.cacheStatus || "REFRESHED"));
  } catch (error) {
    if (hasUsableCache && cached.value) return subscriptionResponse(cached.value, cached.metadata, "STALE");
    return emptySubscriptionResponse(error instanceof Error ? error.message : "Refresh failed");
  }
}

async function headSubscription(env: Env, name: string): Promise<Response> {
  validateName(name);
  const source = await getSource(env, name);
  if (!source) return new Response(null, { status: 404 });
  if (source.enabled === false) return new Response(null, { status: 409 });

  const cached = await getCachedSubscription(env, name);
  const hasUsableCache = Boolean(cached.value && countSubscriptionItems(cached.value) > 0);
  const cacheStatus = hasUsableCache ? "AVAILABLE" : "EMPTY";
  return new Response(null, {
    headers: {
      "content-type": subscriptionContentType(cached.metadata?.contentType || null),
      "cache-control": "no-store",
      "x-sub-cache": cacheStatus,
      "x-sub-updated-at": cached.metadata?.updatedAt || "",
    },
  });
}

export async function refreshAllSources(env: Env, names?: unknown): Promise<RefreshResult[]> {
  const sourceNames = Array.isArray(names) && names.length > 0 ? names.map(String) : await listSourceNames(env);
  const results = await Promise.allSettled(sourceNames.map((name) => refreshSource(env, name)));
  return results.map((result, index) => {
    const name = sourceNames[index];
    if (result.status === "fulfilled") return result.value;
    return {
      name,
      ok: false,
      attemptedAt: new Date().toISOString(),
      error: result.reason instanceof Error ? result.reason.message : "Refresh failed",
    };
  });
}

export async function refreshSource(env: Env, name: string): Promise<RefreshResult> {
  validateName(name);
  const source = await getSource(env, name);
  if (!source) return rememberRefreshResult(env, { name, ok: false, attemptedAt: new Date().toISOString(), error: `Unknown source: ${name}` });
  if (source.enabled === false) {
    return rememberRefreshResult(env, {
      name,
      ok: false,
      attemptedAt: new Date().toISOString(),
      skipped: true,
      reason: "disabled",
      error: "Source is disabled",
    });
  }

  try {
    const response = await fetch(source.url, {
      headers: {
        ...SURGE_UPSTREAM_HEADERS,
        ...(source.headers || {}),
      },
    });

    if (!response.ok) {
      return rememberRefreshResult(env, {
        name,
        ok: false,
        attemptedAt: new Date().toISOString(),
        status: response.status,
        error: `Upstream returned ${response.status}`,
      });
    }

    const upstreamBody = await response.text();
    const body = normalizeSubscriptionBody(upstreamBody);
    if (!body.trim()) {
      return rememberRefreshResult(env, {
        name,
        ok: false,
        attemptedAt: new Date().toISOString(),
        status: response.status,
        error: "Upstream returned no Surge-compatible proxy nodes",
      });
    }

    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > MAX_SUBSCRIPTION_BYTES) {
      return rememberRefreshResult(env, {
        name,
        ok: false,
        attemptedAt: new Date().toISOString(),
        status: response.status,
        error: "Subscription is too large for this cache",
      });
    }
    const proxyCount = countSubscriptionItems(body);
    if (proxyCount < 1) {
      return rememberRefreshResult(env, {
        name,
        ok: false,
        attemptedAt: new Date().toISOString(),
        status: response.status,
        bytes,
        proxyCount,
        error: "Upstream returned no proxy nodes",
      });
    }

    const metadata: CacheMetadata = {
      sourceName: name,
      updatedAt: new Date().toISOString(),
      contentType: subscriptionContentType(response.headers.get("content-type")),
      status: response.status,
      bytes,
      ttlSeconds: ttlSeconds(env, source),
      proxyCount,
    };

    await env.SUB_CACHE.put(cacheKey(name), body, { metadata });
    return rememberRefreshResult(env, {
      name,
      ok: true,
      attemptedAt: metadata.updatedAt,
      cacheStatus: "REFRESHED",
      updatedAt: metadata.updatedAt,
      bytes: metadata.bytes,
      proxyCount: metadata.proxyCount,
    });
  } catch (error) {
    return rememberRefreshResult(env, {
      name,
      ok: false,
      attemptedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Refresh failed",
    });
  }
}

async function buildStatus(env: Env): Promise<Record<string, unknown>[]> {
  const sources = await listSources(env);
  const defaultNames = new Set(getDefaultSources(env).map((source) => source.name));
  const storedNames = new Set((await readStoredSourceNames(env)) ?? []);
  return Promise.all(
    sources.map(async (source) => {
      const cached = await getCachedSubscription(env, source.name);
      const refreshResult = await getRefreshResult(env, source.name);
      const metadata = cached.metadata;
      const hasStoredConfig = Boolean(await env.SUB_CACHE.get(sourceKey(source.name)));
      const fresh = cached.value ? isFresh(metadata, ttlSeconds(env, source), Date.now()) : false;
      const proxyCount = cached.value ? countSubscriptionItems(cached.value) : metadata?.proxyCount || 0;
      const hasUsableCache = Boolean(cached.value && proxyCount > 0);
      const sourceType = storedNames.has(source.name) && hasStoredConfig
        ? defaultNames.has(source.name)
          ? "override"
          : "dynamic"
        : "default";
      return {
        ...summarizeSource(source),
        url: source.url,
        sourceType,
        cached: hasUsableCache,
        updatedAt: metadata?.updatedAt || null,
        bytes: metadata?.bytes || 0,
        proxyCount,
        proxyCountKnown: hasUsableCache,
        fresh,
        cacheState: cached.value ? (hasUsableCache ? (fresh ? "fresh" : "stale") : "invalid") : "empty",
        lastRefreshOk: refreshResult?.ok ?? null,
        lastRefreshError: refreshResult?.error || null,
        lastRefreshAt: refreshResult?.attemptedAt || null,
      };
    }),
  );
}

async function replaceSources(env: Env, rawSources: unknown[]): Promise<Record<string, unknown>[]> {
  const sources = rawSources.map(validateSource);
  const names = sources.map((source) => source.name);
  if (new Set(names).size !== names.length) throw new Error("Source names must be unique");

  const previousNames = new Set((await readStoredSourceNames(env)) ?? []);
  for (const name of names) previousNames.delete(name);

  await Promise.all(sources.map((source) => env.SUB_CACHE.put(sourceKey(source.name), JSON.stringify(source))));
  await Promise.all([...previousNames].flatMap((name) => deleteSourceArtifacts(env, name)));
  await env.SUB_CACHE.put(SOURCE_INDEX_KEY, JSON.stringify(names));
  return sources.map(summarizeSource);
}

async function upsertSource(env: Env, rawSource: unknown): Promise<SourceConfig> {
  const source = validateSource(rawSource);
  const names = new Set((await readStoredSourceNames(env)) ?? []);
  names.add(source.name);
  await env.SUB_CACHE.put(sourceKey(source.name), JSON.stringify(source));
  await env.SUB_CACHE.put(SOURCE_INDEX_KEY, JSON.stringify([...names]));
  return source;
}

async function patchSource(env: Env, name: string, patch: unknown): Promise<SourceConfig> {
  validateName(name);
  if (!patch || typeof patch !== "object") throw new Error("Patch must be an object");
  const current = await getSource(env, name);
  if (!current) throw new Error(`Unknown source: ${name}`);
  return upsertSource(env, { ...current, ...(patch as Record<string, unknown>), name });
}

async function deleteSource(env: Env, name: string): Promise<boolean> {
  validateName(name);
  const names = new Set((await readStoredSourceNames(env)) ?? []);
  const deleted = names.delete(name);
  await Promise.all(deleteSourceArtifacts(env, name));
  await env.SUB_CACHE.put(SOURCE_INDEX_KEY, JSON.stringify([...names]));
  return deleted;
}

function deleteSourceArtifacts(env: Env, name: string): Promise<void>[] {
  return [
    env.SUB_CACHE.delete(sourceKey(name)),
    env.SUB_CACHE.delete(cacheKey(name)),
    env.SUB_CACHE.delete(refreshKey(name)),
  ];
}

async function listSources(env: Env): Promise<SourceConfig[]> {
  const names = await listSourceNames(env);
  const sources = await Promise.all(names.map((name) => getSource(env, name)));
  return sources.filter((source): source is SourceConfig => Boolean(source));
}

async function listSourceNames(env: Env): Promise<string[]> {
  const names = new Set(getDefaultSources(env).map((source) => source.name));
  for (const name of (await readStoredSourceNames(env)) ?? []) names.add(name);
  return [...names];
}

async function readStoredSourceNames(env: Env): Promise<string[] | null> {
  const raw = await env.SUB_CACHE.get(SOURCE_INDEX_KEY);
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((name): name is string => typeof name === "string");
}

async function getSource(env: Env, name: string): Promise<SourceConfig | null> {
  const raw = await env.SUB_CACHE.get(sourceKey(name));
  if (raw) return JSON.parse(raw) as SourceConfig;
  return getDefaultSources(env).find((source) => source.name === name) || null;
}

async function getCachedSubscription(env: Env, name: string): Promise<{ value: string | null; metadata: CacheMetadata | null }> {
  const result = await env.SUB_CACHE.getWithMetadata<CacheMetadata>(cacheKey(name));
  return { value: result.value || null, metadata: result.metadata || null };
}

async function rememberRefreshResult(env: Env, result: RefreshResult): Promise<RefreshResult> {
  await env.SUB_CACHE.put(refreshKey(result.name), JSON.stringify(result));
  return result;
}

async function getRefreshResult(env: Env, name: string): Promise<RefreshResult | null> {
  const raw = await env.SUB_CACHE.get(refreshKey(name));
  return raw ? (JSON.parse(raw) as RefreshResult) : null;
}

function validateSource(rawSource: unknown): SourceConfig {
  if (!rawSource || typeof rawSource !== "object") throw new Error("Source must be an object");
  const input = rawSource as Record<string, unknown>;
  const name = String(input.name || "").trim();
  validateName(name);

  const sourceUrl = String(input.url || "").trim();
  const parsed = new URL(sourceUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`Invalid source URL for ${name}`);

  const source: SourceConfig = {
    name,
    url: sourceUrl,
    enabled: input.enabled !== false,
  };

  if (input.ttlSeconds !== undefined) {
    const ttl = Number(input.ttlSeconds);
    if (!Number.isFinite(ttl) || ttl < 60) throw new Error(`Invalid ttlSeconds for ${name}`);
    source.ttlSeconds = Math.floor(ttl);
  }

  if (input.headers !== undefined) {
    if (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) {
      throw new Error(`Invalid headers for ${name}`);
    }
    source.headers = Object.fromEntries(
      Object.entries(input.headers as Record<string, unknown>).map(([key, value]) => [String(key), String(value)]),
    );
  }

  return source;
}

function getDefaultSources(env: Env): SourceConfig[] {
  if (!env.DEFAULT_SOURCES) return [];
  const parsed: unknown = JSON.parse(env.DEFAULT_SOURCES);
  const sources = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)?.sources;
  if (!Array.isArray(sources)) throw new Error("DEFAULT_SOURCES must be a JSON array or an object with a sources array");

  const validated = sources.map(validateSource);
  const names = validated.map((source) => source.name);
  if (new Set(names).size !== names.length) throw new Error("DEFAULT_SOURCES names must be unique");
  return validated;
}

function validateName(name: string): void {
  if (!name) throw new Error("Source name is required");
  if (name.length > 80) throw new Error("Source name is too long");
  if (/[/?#\\\u0000-\u001f\u007f]/u.test(name)) throw new Error(`Invalid source name: ${name}`);
}

function summarizeSource(source: SourceConfig): Record<string, unknown> {
  return {
    name: source.name,
    enabled: source.enabled !== false,
    ttlSeconds: source.ttlSeconds || null,
    url: redactUrl(source.url),
  };
}

function redactUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}${url.search ? "?..." : ""}`;
}

function countSubscriptionItems(body: string): number {
  const plainCount = countPlainSubscriptionItems(body);
  if (plainCount > 0) return plainCount;

  const compact = body.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1) return 0;

  try {
    return countPlainSubscriptionItems(atob(compact));
  } catch {
    return 0;
  }
}

function normalizeSubscriptionBody(body: string): string {
  const plain = decodeBase64Subscription(body) || body;
  const lines = subscriptionLines(plain);
  if (lines.length === 0 || lines.some(isSurgeProxyLine)) return body;

  const uriLines = lines.filter(isUriLine);
  if (uriLines.length === 0) return body;

  const converted = uriLines
    .map(convertUriToSurgeProxyLine)
    .filter((line): line is string => Boolean(line));

  return converted.length > 0 ? `${converted.join("\n")}\n` : "";
}

function decodeBase64Subscription(body: string): string | null {
  const compact = body.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1) return null;

  try {
    const decoded = atob(compact);
    return decoded.includes("://") || decoded.includes("[Proxy]") ? decoded : null;
  } catch {
    return null;
  }
}

function subscriptionLines(text: string): string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(";") && !line.startsWith("//"));
}

function countPlainSubscriptionItems(text: string): number {
  const lines = subscriptionLines(text);
  const proxySection = extractProxySection(lines);
  const candidates = proxySection.length > 0 ? proxySection : lines;
  const uriPattern = /^(ssr?|vmess|vless|trojan|hysteria2?|hy2|tuic|snell):\/\//iu;
  const surgePattern =
    /^[^=]+=\s*(direct|reject|reject-tinygif|reject-drop|ss|socks5?|http|https|vmess|vless|trojan|snell|wireguard|hysteria2?|hy2|tuic|ssh)\b/iu;
  const clashNamePattern = /^-\s*name\s*:/iu;

  return candidates.filter((line) => uriPattern.test(line) || surgePattern.test(line) || clashNamePattern.test(line))
    .length;
}

function isUriLine(line: string): boolean {
  return /^(ssr?|vmess|vless|trojan|hysteria2?|hy2|tuic|snell):\/\//iu.test(line);
}

function isSurgeProxyLine(line: string): boolean {
  return /^[^=]+=\s*(direct|reject|reject-tinygif|reject-drop|ss|socks5?|http|https|vmess|trojan|snell|wireguard|hysteria2?|hy2|tuic|ssh)\b/iu
    .test(line);
}

function convertUriToSurgeProxyLine(line: string): string | null {
  try {
    const url = new URL(line);
    if (url.protocol !== "trojan:") return null;
    if (!url.hostname || url.hostname === "0.0.0.0" || !url.port) return null;

    const password = decodeUrlPart(url.username);
    if (!password) return null;

    const name = surgeName(decodeUrlPart(url.hash.slice(1)) || url.hostname);
    const params = [`password=${surgeValue(password)}`];
    const sni = url.searchParams.get("sni") || url.searchParams.get("peer");
    if (sni) params.push(`sni=${surgeValue(sni)}`);

    const allowInsecure = url.searchParams.get("allowInsecure") || url.searchParams.get("allowinsecure");
    if (allowInsecure === "1" || allowInsecure === "true") params.push("skip-cert-verify=true");

    if (url.searchParams.get("type")?.toLowerCase() === "ws") {
      params.push("ws=true");
      const wsPath = url.searchParams.get("path");
      if (wsPath) params.push(`ws-path=${surgeValue(wsPath)}`);
      const wsHost = url.searchParams.get("host");
      if (wsHost) params.push(`ws-headers=Host:${surgeValue(wsHost)}`);
    }

    return `${name} = trojan, ${url.hostname}, ${url.port}, ${params.join(", ")}`;
  } catch {
    return null;
  }
}

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function surgeName(value: string): string {
  return value.replace(/[=\r\n]/gu, " ").replace(/\s+/gu, " ").trim() || "proxy";
}

function surgeValue(value: string): string {
  return /[\s,",]/u.test(value) ? JSON.stringify(value) : value;
}

function extractProxySection(lines: string[]): string[] {
  const result: string[] = [];
  let inProxySection = false;

  for (const line of lines) {
    const section = line.match(/^\[(.+)\]$/u)?.[1]?.toLowerCase();
    if (section) {
      inProxySection = section === "proxy" || section === "proxies";
      continue;
    }
    if (inProxySection) result.push(line);
  }

  return result;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function subscriptionResponse(body: string, metadata: CacheMetadata | null, cacheStatus: string): Response {
  return new Response(body, {
    headers: {
      "content-type": subscriptionContentType(metadata?.contentType || null),
      "cache-control": "no-store",
      "x-sub-cache": cacheStatus,
      "x-sub-updated-at": metadata?.updatedAt || "",
    },
  });
}

function emptySubscriptionResponse(reason: string): Response {
  return new Response(EMPTY_SUBSCRIPTION_BODY, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-sub-cache": "EMPTY",
      "x-sub-empty-reason": safeHeaderValue(reason),
    },
  });
}

function subscriptionContentType(contentType: string | null): string {
  return contentType && !/^text\/html\b/iu.test(contentType) ? contentType : "text/plain; charset=utf-8";
}

function safeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/gu, "?").replace(/[\r\n]/gu, " ").slice(0, 200);
}

function adminPage(request: Request, sources: Record<string, unknown>[]): Response {
  const url = new URL(request.url);
  const token = url.searchParams.get("admin_token") || "";
  const authMode = url.searchParams.has("admin_token") ? "token" : "access";
  const sourceCount = sources.length;
  const enabledCount = sources.filter((source) => source.enabled).length;
  const cachedCount = sources.filter((source) => source.cached).length;
  const needsAttentionCount = sources.filter((source) => source.cacheState === "invalid" || source.lastRefreshOk === false)
    .length;
  const proxyCount = sources.reduce((sum, source) => sum + Number(source.proxyCount || 0), 0);
  const rows = sources.length
    ? sources
        .map((source) => {
          const sourceName = String(source.name);
          const cacheState = String(source.cacheState || "empty");
          const deleteLabel = source.sourceType === "default" ? "Clear cache" : "Delete";
          const proxyCountLabel = source.proxyCountKnown ? String(Number(source.proxyCount || 0)) : "未刷新";
          const refreshStatus =
            source.lastRefreshOk === true ? "成功" : source.lastRefreshOk === false ? "失败" : "未刷新";
          const refreshClass =
            source.lastRefreshOk === true ? "ok" : source.lastRefreshOk === false ? "bad" : "neutral";
          const cacheLabel = cacheState === "invalid" ? "无效" : cacheState === "empty" ? "未缓存" : cacheState;
          const rowClass = cacheState === "invalid" || source.lastRefreshOk === false ? " class=\"needs-attention\"" : "";
          const proxyClass = source.proxyCountKnown ? "proxy-count" : "proxy-count pending";

          return `<tr${rowClass}>
            <td class="source-cell">
              <div class="source-name">${escapeHtml(sourceName)}</div>
              <div class="source-meta">
                <span>${escapeHtml(source.sourceType)}</span>
                <span>${source.enabled ? "enabled" : "disabled"}</span>
                <span>TTL ${escapeHtml(source.ttlSeconds || "default")}</span>
              </div>
            </td>
            <td>
              <span class="state ${escapeHtml(cacheState)}">${escapeHtml(cacheLabel)}</span>
              <div class="subtext">${formatBytes(Number(source.bytes || 0))}</div>
            </td>
            <td class="${proxyClass}">${escapeHtml(proxyCountLabel)}</td>
            <td>
              <span class="refresh ${refreshClass}">${refreshStatus}</span>
              <div class="subtext">${escapeHtml(source.lastRefreshAt || source.updatedAt || "-")}</div>
              ${source.lastRefreshError ? `<div class="error-text">${escapeHtml(source.lastRefreshError)}</div>` : ""}
            </td>
            <td class="subtext">${escapeHtml(source.updatedAt || "-")}</td>
            <td class="actions">
              <button data-refresh="${escapeHtml(sourceName)}">Refresh</button>
              <button data-delete="${escapeHtml(sourceName)}">${deleteLabel}</button>
            </td>
          </tr>
          <tr class="url-row${rowClass ? " needs-attention" : ""}">
            <td colspan="6"><div class="source-url">${escapeHtml(source.url)}</div></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="empty">No sources configured.</td></tr>`;

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Subscription Cache</title>
  <style>
    :root { color-scheme: light; --border: #d8dde6; --soft: #f7f8fa; --text: #111827; --muted: #667085; --ok: #047857; --warn: #b45309; --bad: #b42318; --blue: #175cd3; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f6f8; color: var(--text); font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 1400px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 16px; }
    p { margin: 6px 0 0; color: var(--muted); }
    .toolbar { display: flex; gap: 8px; align-items: center; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .metric { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 4px; font-size: 24px; }
    .panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 14px; overflow: hidden; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; background: var(--soft); border-bottom: 1px solid var(--border); }
    form { display: grid; grid-template-columns: 160px 1fr 140px 120px; gap: 12px; padding: 16px; align-items: end; }
    label { display: grid; gap: 5px; color: var(--muted); font-size: 12px; }
    input { width: 100%; border: 1px solid #98a2b3; border-radius: 6px; padding: 8px 10px; font: inherit; color: var(--text); }
    .check { display: flex; gap: 8px; align-items: center; min-height: 38px; color: var(--text); }
    .check input { width: auto; }
    button { border: 1px solid #98a2b3; border-radius: 6px; background: #fff; color: var(--text); padding: 8px 12px; font: inherit; cursor: pointer; }
    button.primary { border-color: var(--blue); background: var(--blue); color: #fff; }
    button:hover { background: #f2f4f7; }
    button.primary:hover { background: #1849a9; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .table-wrap { overflow-x: auto; }
    .table-wrap table { min-width: 1320px; }
    th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { color: #344054; font-size: 12px; background: #fbfcfe; white-space: nowrap; }
    tr.needs-attention { background: #fffafa; }
    .source-cell { width: 44%; }
    .source-name { font-weight: 700; margin-bottom: 5px; }
    .source-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
    .source-meta span { display: inline-flex; align-items: center; min-height: 22px; border-radius: 999px; padding: 1px 8px; background: #eef2f6; color: #344054; font-size: 12px; }
    tr.url-row td { padding-top: 0; }
    .source-url { color: var(--muted); font-size: 12px; white-space: nowrap; overflow-x: auto; padding-bottom: 10px; }
    .subtext { color: var(--muted); font-size: 12px; margin-top: 4px; overflow-wrap: anywhere; }
    .error-text { color: var(--bad); font-size: 12px; margin-top: 5px; max-width: 260px; overflow-wrap: anywhere; }
    .number { text-align: right; white-space: nowrap; }
    .state, .refresh { display: inline-flex; align-items: center; min-height: 18px; border-radius: 4px; padding: 0 6px; font-size: 12px; line-height: 18px; background: #eef2f6; color: #344054; white-space: nowrap; }
    .state.fresh, .refresh.ok { background: #ecfdf3; color: var(--ok); }
    .state.stale { background: #fffaeb; color: var(--warn); }
    .state.empty { background: transparent; color: var(--muted); padding: 0; }
    .state.invalid, .refresh.bad { background: transparent; color: var(--bad); padding: 0; }
    .refresh.neutral { background: #eef2f6; color: #344054; }
    .proxy-count { font-size: 14px; font-weight: 700; text-align: right; white-space: nowrap; }
    .proxy-count.pending { color: var(--muted); font-weight: 500; }
    .actions { white-space: nowrap; }
    .actions button { margin-right: 6px; padding: 6px 9px; }
    .empty { color: var(--muted); text-align: center; padding: 32px; }
    #result { display: none; margin: 0; padding: 10px 14px; border-top: 1px solid var(--border); background: #f8fafc; color: #344054; white-space: pre-wrap; overflow-x: auto; }
    #result:not(:empty) { display: block; }
    @media (max-width: 900px) {
      main { padding: 18px; }
      header { display: block; }
      .toolbar { margin-top: 12px; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      form { grid-template-columns: 1fr; }
      .panel { overflow-x: auto; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Subscription Cache</h1>
        <p>Admin auth: ${escapeHtml(authMode)}. Surge reads stable Worker URLs while this page manages upstream sources.</p>
      </div>
      <div class="toolbar">
        <button id="refresh-all" class="primary">Refresh all</button>
      </div>
    </header>

    <section class="metrics" aria-label="Summary">
      <div class="metric"><span>Sources</span><strong>${sourceCount}</strong></div>
      <div class="metric"><span>Enabled</span><strong>${enabledCount}</strong></div>
      <div class="metric"><span>Cached</span><strong>${cachedCount}</strong></div>
      <div class="metric"><span>Needs attention</span><strong>${needsAttentionCount}</strong></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>Add or update source</h2>
        <p>Use the same name to overwrite a configured airport.</p>
      </div>
      <form id="source-form">
        <label>Name <input name="name" required placeholder="ssrdog"></label>
        <label>URL <input name="url" required placeholder="https://example.com/sub?token=..."></label>
        <label>TTL seconds <input name="ttlSeconds" type="number" min="60" placeholder="21600"></label>
        <label class="check"><input name="enabled" type="checkbox" checked> Enabled</label>
        <button type="submit" class="primary">Save source</button>
      </form>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>机场配置</h2>
        <p>每个机场的代理数量会在刷新成功后显示；未刷新前显示“未刷新”。</p>
      </div>
      <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Cache</th>
            <th class="number">代理数量</th>
            <th>Last refresh</th>
            <th>Cached at</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
      <pre id="result"></pre>
    </section>
  </main>
  <script>
    const token = ${JSON.stringify(token)};
    const result = document.getElementById("result");
    function adminPath(path) {
      return token ? path + "?admin_token=" + encodeURIComponent(token) : path;
    }
    async function refresh(path) {
      result.textContent = "Refreshing...";
      const response = await fetch(adminPath(path), { method: "POST" });
      result.textContent = await response.text();
      if (response.ok) location.reload();
    }
    document.getElementById("refresh-all").onclick = () => refresh("/admin/refresh");
    document.querySelectorAll("button[data-refresh]").forEach((button) => {
      button.onclick = () => refresh("/admin/refresh/" + encodeURIComponent(button.dataset.refresh));
    });
    document.querySelectorAll("button[data-delete]").forEach((button) => {
      button.onclick = async () => {
        result.textContent = "Updating...";
        const response = await fetch(adminPath("/admin/source/" + encodeURIComponent(button.dataset.delete)), { method: "DELETE" });
        result.textContent = await response.text();
        if (response.ok) location.reload();
      };
    });
    document.getElementById("source-form").onsubmit = async (event) => {
      event.preventDefault();
      result.textContent = "Saving...";
      const form = new FormData(event.currentTarget);
      const payload = {
        url: String(form.get("url")),
        enabled: form.get("enabled") === "on"
      };
      const ttlSeconds = Number(form.get("ttlSeconds"));
      if (ttlSeconds) payload.ttlSeconds = ttlSeconds;
      const name = String(form.get("name"));
      const response = await fetch(adminPath("/admin/source/" + encodeURIComponent(name)), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      result.textContent = await response.text();
      if (response.ok) location.reload();
    };
  </script>
</body>
</html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char];
  });
}

function isFresh(metadata: CacheMetadata | null, ttlSecondsValue: number, now: number): boolean {
  const updatedAt = Date.parse(metadata?.updatedAt || "");
  return Number.isFinite(updatedAt) && now - updatedAt <= ttlSecondsValue * 1000;
}

function isWithinStaleWindow(metadata: CacheMetadata | null, staleTtlSecondsValue: number, now: number): boolean {
  const updatedAt = Date.parse(metadata?.updatedAt || "");
  return Number.isFinite(updatedAt) && now - updatedAt <= staleTtlSecondsValue * 1000;
}

function ttlSeconds(env: Env, source: SourceConfig): number {
  return Number(source.ttlSeconds || env.CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS);
}

function staleTtlSeconds(env: Env): number {
  return Number(env.STALE_TTL_SECONDS || DEFAULT_STALE_TTL_SECONDS);
}

function sourceKey(name: string): string {
  return `source:${name}`;
}

function cacheKey(name: string): string {
  return `cache:${name}`;
}

function refreshKey(name: string): string {
  return `${REFRESH_PREFIX}${name}`;
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
}

async function readJson(request: Request, fallback?: Record<string, unknown>): Promise<any> {
  if (!request.body) return fallback;
  try {
    return await request.json();
  } catch {
    if (fallback !== undefined) return fallback;
    throw new Error("Invalid JSON body");
  }
}

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  if (env.CF_ACCESS_AUD && env.CF_ACCESS_TEAM_DOMAIN) {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) return json({ error: "Missing Cloudflare Access login" }, 401);

    try {
      await verifyAccessJwt(token, env);
      return null;
    } catch {
      return json({ error: "Invalid Cloudflare Access login" }, 403);
    }
  }

  if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN is not configured" }, 503);
  return tokenFromRequest(request, "admin_token", "x-admin-token") === env.ADMIN_TOKEN
    ? null
    : json({ error: "Unauthorized" }, 401);
}

function requirePublicToken(request: Request, env: Env): Response | null {
  if (!env.PUBLIC_TOKEN) return json({ error: "PUBLIC_TOKEN is not configured" }, 503);
  return tokenFromRequest(request, "token", "x-sub-token") === env.PUBLIC_TOKEN
    ? null
    : json({ error: "Unauthorized" }, 401);
}

function tokenFromRequest(request: Request, queryName: string, headerName: string): string {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  const headerToken = request.headers.get(headerName);
  if (headerToken) return headerToken.trim();
  return new URL(request.url).searchParams.get(queryName) || "";
}

async function verifyAccessJwt(token: string, env: Env): Promise<void> {
  if (!env.CF_ACCESS_AUD || !env.CF_ACCESS_TEAM_DOMAIN) throw new Error("Cloudflare Access is not configured");
  const issuer = normalizeAccessIssuer(env.CF_ACCESS_TEAM_DOMAIN);
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksCache.set(issuer, jwks);
  }

  await jwtVerify(token, jwks, {
    issuer,
    audience: env.CF_ACCESS_AUD,
  });
}

function normalizeAccessIssuer(teamDomain: string): string {
  const withProtocol = /^https?:\/\//u.test(teamDomain) ? teamDomain : `https://${teamDomain}`;
  return withProtocol.replace(/\/+$/u, "");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
