import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const enable = process.argv.includes("--enable");
const checkToken = process.argv.includes("--check-token");
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

if (checkToken) {
  await checkAccessToken(accountId);
  process.exit(0);
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

const existingPolicy = await findAccessPolicy(accountId, policyPayload.name);
const policy = existingPolicy || await cloudflare("POST", `/accounts/${accountId}/access/policies`, policyPayload);
const existingApp = await findAccessApp(accountId, appName, appDomain);
const app = existingApp || await cloudflare("POST", `/accounts/${accountId}/access/apps`, appPayload(policy.id));
const resolvedTeamDomain = teamDomain || await detectTeamDomain(accountId);

if (!app.aud) {
  console.error("Access app is missing AUD. Open the Access app in Cloudflare and copy the Application Audience value manually.");
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      policy: { id: policy.id, name: policy.name },
      application: { id: app.id, name: app.name, domain: app.domain, aud: app.aud },
      reused: { policy: Boolean(existingPolicy), application: Boolean(existingApp) },
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
  if (enable) process.exit(1);
}

if (enable) {
  enableWorkerAccess(app.aud, resolvedTeamDomain);
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

async function findAccessPolicy(accountId, name) {
  try {
    const policies = await cloudflare("GET", `/accounts/${accountId}/access/policies?per_page=100`);
    return Array.isArray(policies) ? policies.find((policy) => policy.name === name) : null;
  } catch {
    return null;
  }
}

async function findAccessApp(accountId, _name, domain) {
  try {
    const apps = await cloudflare("GET", `/accounts/${accountId}/access/apps?per_page=100`);
    const app = Array.isArray(apps) ? apps.find((candidate) => candidate.domain === domain) : null;
    return app?.aud ? app : app ? await getAccessApp(accountId, app.id) : null;
  } catch {
    return null;
  }
}

async function getAccessApp(accountId, appId) {
  try {
    return await cloudflare("GET", `/accounts/${accountId}/access/apps/${appId}`);
  } catch {
    return null;
  }
}

function enableWorkerAccess(aud, teamDomain) {
  const result = spawnSync(process.execPath, ["scripts/enable-access.mjs"], {
    env: {
      ...process.env,
      CF_ACCESS_AUD: aud,
      CF_ACCESS_TEAM_DOMAIN: teamDomain,
    },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

async function checkAccessToken(accountId) {
  const token = await verifyApiToken(accountId);
  const organization = await cloudflare("GET", `/accounts/${accountId}/access/organizations`);
  await cloudflare("GET", `/accounts/${accountId}/access/policies?per_page=1`);
  await cloudflare("GET", `/accounts/${accountId}/access/apps?per_page=1`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        accountId,
        token,
        teamDomain: organization?.auth_domain ? normalizeHttps(organization.auth_domain) : null,
        checked: ["token", "zeroTrustOrganization", "accessPolicies", "accessApps"],
      },
      null,
      2,
    ),
  );
}

async function verifyApiToken(accountId) {
  try {
    const token = await cloudflare("GET", "/user/tokens/verify");
    return { kind: "user", id: token.id, status: token.status };
  } catch (error) {
    const token = await cloudflare("GET", `/accounts/${accountId}/tokens/verify`);
    return { kind: "account", id: token.id, status: token.status };
  }
}
