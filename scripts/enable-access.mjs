import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const aud = process.env.CF_ACCESS_AUD;
const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN || process.env.ACCESS_TEAM_DOMAIN;
const config = process.env.WRANGLER_CONFIG || (existsSync("wrangler.production.toml") ? "wrangler.production.toml" : "wrangler.toml");
const workerUrl = process.env.WORKER_URL;
const adminToken = process.env.ADMIN_TOKEN;

if (!aud || !teamDomain) {
  console.error("Set CF_ACCESS_AUD and CF_ACCESS_TEAM_DOMAIN.");
  process.exit(1);
}

putSecret("CF_ACCESS_AUD", aud);
putSecret("CF_ACCESS_TEAM_DOMAIN", teamDomain);
run("npx", ["wrangler", "deploy", "-c", config]);

if (workerUrl && adminToken) {
  const response = await fetch(new URL(`/admin/status?admin_token=${encodeURIComponent(adminToken)}`, workerUrl));
  if (response.status !== 401 && response.status !== 403) {
    console.error(`Expected admin_token to be rejected after Access is enabled, got HTTP ${response.status}.`);
    process.exit(1);
  }
  console.log(`admin_token rejected with HTTP ${response.status}.`);
}

console.log("Cloudflare Access Worker secrets are enabled.");

function putSecret(name, value) {
  const result = spawnSync("npx", ["wrangler", "secret", "put", name, "-c", config], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf8",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
