import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const apiToken = process.env.CLOUDFLARE_API_TOKEN || readSecret(process.env.CLOUDFLARE_API_TOKEN_FILE || "/tmp/evergreen-cloudflare-api-token");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || detectAccountId();
const appName = process.env.ACCESS_APP_NAME || "Evergreen admin";
const appDomain = process.env.ACCESS_APP_DOMAIN || "evergreen.atoma.one/admin*";
const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN || process.env.ACCESS_TEAM_DOMAIN;
const allowedEmail = process.env.ACCESS_ALLOWED_EMAIL;
const allowedEmailDomain = process.env.ACCESS_ALLOWED_EMAIL_DOMAIN;

if (!dryRun && (!apiToken || !accountId)) {
  console.error("Put your Cloudflare API token in /tmp/evergreen-cloudflare-api-token, or set CLOUDFLARE_API_TOKEN. Set CLOUDFLARE_ACCOUNT_ID if wrangler has multiple accounts.");
  process.exit(1);
}

if (!allowedEmail && !allowedEmailDomain) {
  console.error("Set ACCESS_ALLOWED_EMAIL or ACCESS_ALLOWED_EMAIL_DOMAIN.");
  process.exit(1);
}

const include = allowedEmail
  ? [{ email: { email: allowedEmail } }]
  : [{ email_domain: { domain: allowedEmailDomain } }];
const policyPayload = {
  name: `${appName} allow`,
  decision: "allow",
  include,
};

const appPayload = (policyId) => ({
  name: appName,
  type: "self_hosted",
  domain: appDomain,
  policies: [policyId],
  allowed_idps: [],
});

if (dryRun) {
  console.log(JSON.stringify({ policy: policyPayload, application: appPayload("<policy-id>") }, null, 2));
  process.exit(0);
}

const policy = await cloudflare("POST", `/accounts/${accountId}/access/policies`, policyPayload);
const app = await cloudflare("POST", `/accounts/${accountId}/access/apps`, appPayload(policy.id));
const resolvedTeamDomain = teamDomain || await detectTeamDomain(accountId);

console.log(
  JSON.stringify(
    {
      policy: { id: policy.id, name: policy.name },
      application: { id: app.id, name: app.name, domain: app.domain, aud: app.aud },
      workerSecrets: {
        CF_ACCESS_AUD: app.aud,
        CF_ACCESS_TEAM_DOMAIN: resolvedTeamDomain || "<set-your-team-domain>",
      },
    },
    null,
    2,
  ),
);

if (!resolvedTeamDomain) {
  console.error("Access app created. Set CF_ACCESS_TEAM_DOMAIN to your Cloudflare Access team domain before enabling Worker verification.");
}

async function cloudflare(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    const message = result.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") || response.statusText;
    throw new Error(message);
  }
  return result.result;
}

function readSecret(path) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

function detectAccountId() {
  const result = spawnSync("npx", ["wrangler", "whoami", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.status !== 0) return "";

  try {
    const accounts = JSON.parse(result.stdout).accounts;
    return Array.isArray(accounts) && accounts.length === 1 ? accounts[0].id : "";
  } catch {
    return "";
  }
}

async function detectTeamDomain(accountId) {
  try {
    const organization = await cloudflare("GET", `/accounts/${accountId}/access/organizations`);
    const authDomain = organization?.auth_domain || organization?.authDomain;
    return authDomain ? normalizeHttps(authDomain) : "";
  } catch {
    return "";
  }
}

function normalizeHttps(value) {
  return /^https?:\/\//u.test(value) ? value : `https://${value}`;
}
