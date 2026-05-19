import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const name = args[0]?.startsWith("--") ? "" : args[0];
const urlFlagIndex = args.indexOf("--url");
const devVars = await readDevVars();
const sourceUrl = urlFlagIndex >= 0 ? args[urlFlagIndex + 1] : process.env.SOURCE_URL || sourceUrlFromEnv(name, devVars);
const workerUrl = process.env.WORKER_URL;
const adminToken = process.env.ADMIN_TOKEN;
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

if (!name || !sourceUrl || !workerUrl || (!adminToken && (!accessClientId || !accessClientSecret))) {
  console.error(
    "Usage: WORKER_URL=https://worker.example.com ADMIN_TOKEN=... node scripts/import-cache.mjs <source-name> [--url https://provider.example/sub]",
  );
  console.error("For Cloudflare Access, use CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET instead of ADMIN_TOKEN.");
  process.exit(1);
}

const upstream = await fetch(sourceUrl, {
  headers: {
    "user-agent": "Surge/5.0",
    accept: "*/*",
    "accept-language": "zh-Hans-CN;q=1, en-CN;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
  },
});

if (!upstream.ok) {
  console.error(`Upstream returned ${upstream.status}`);
  process.exit(1);
}

const headers = {
  "content-type": "application/json",
};
if (adminToken) headers.authorization = `Bearer ${adminToken}`;
if (accessClientId && accessClientSecret) {
  headers["CF-Access-Client-Id"] = accessClientId;
  headers["CF-Access-Client-Secret"] = accessClientSecret;
}

const response = await fetch(new URL(`/admin/cache/${encodeURIComponent(name)}`, workerUrl), {
  method: "POST",
  headers,
  body: JSON.stringify({
    content: await upstream.text(),
    contentType: upstream.headers.get("content-type"),
    status: upstream.status,
  }),
});

const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exit(1);
}

console.log(text);

function sourceUrlFromEnv(sourceName, vars) {
  if (!sourceName) return "";
  const rawSources = process.env.DEFAULT_SOURCES || vars.DEFAULT_SOURCES;
  if (!rawSources) return "";

  const parsed = JSON.parse(rawSources);
  const sources = Array.isArray(parsed) ? parsed : parsed.sources;
  return sources?.find((source) => source?.name === sourceName)?.url || "";
}

async function readDevVars() {
  try {
    return Object.fromEntries(
      (await readFile(".dev.vars", "utf8"))
        .split(/\r?\n/u)
        .filter((line) => line.trim() && !line.trim().startsWith("#"))
        .filter((line) => line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
  } catch {
    return {};
  }
}
