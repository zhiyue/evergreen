import { readFile } from "node:fs/promises";

const file = process.argv[2];
const workerUrl = process.env.WORKER_URL;
const adminToken = process.env.ADMIN_TOKEN;

if (!file || !workerUrl || !adminToken) {
  console.error("Usage: WORKER_URL=https://worker.example.workers.dev ADMIN_TOKEN=... node scripts/seed-sources.mjs examples/sources.example.json");
  process.exit(1);
}

const payload = JSON.parse(await readFile(file, "utf8"));
const response = await fetch(new URL("/admin/sources", workerUrl), {
  method: "POST",
  headers: {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
});

const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exit(1);
}

console.log(text);
