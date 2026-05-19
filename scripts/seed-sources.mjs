import { readFile } from "node:fs/promises";

const file = process.argv[2];
const workerUrl = process.env.WORKER_URL;
const adminToken = process.env.ADMIN_TOKEN;
const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

if (!file || !workerUrl || (!adminToken && (!accessClientId || !accessClientSecret))) {
  console.error("Usage: WORKER_URL=https://worker.example.com ADMIN_TOKEN=... node scripts/seed-sources.mjs examples/sources.example.json");
  console.error("For Cloudflare Access, use CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET instead of ADMIN_TOKEN.");
  process.exit(1);
}

const payload = JSON.parse(await readFile(file, "utf8"));
const headers = {
  "content-type": "application/json",
};
if (adminToken) headers.authorization = `Bearer ${adminToken}`;
if (accessClientId && accessClientSecret) {
  headers["CF-Access-Client-Id"] = accessClientId;
  headers["CF-Access-Client-Secret"] = accessClientSecret;
}

const response = await fetch(new URL("/admin/sources", workerUrl), {
  method: "POST",
  headers,
  body: JSON.stringify(payload),
});

const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exit(1);
}

console.log(text);
