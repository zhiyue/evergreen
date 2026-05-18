# Evergreen

Evergreen is a Cloudflare Worker that keeps Surge external policy subscriptions usable when upstream subscription links expire, return 401/403/502, or are temporarily unavailable.

It gives Surge a stable URL, stores the last successful subscription in Cloudflare KV, and exposes a small admin page for source management and manual refreshes.

## Why

Some proxy providers issue subscription URLs with short-lived tokens. Surge then pulls the upstream URL directly and can fail with 401 or 403 after the token expires. Some providers also require the user to open the provider page before the subscription URL works again, so a blind cron job is not enough.

Evergreen solves the practical part:

- Surge reads a stable Worker URL.
- The Worker fetches the real provider URL.
- Successful results are cached in KV.
- Later upstream failures do not overwrite the last good cache.
- If a source has never been cached and the upstream is down, the Worker returns an empty Surge policy instead of an HTTP failure.

## Features

- Stable public subscription URLs: `/sub/:name?token=...`
- Admin page: `/admin`
- Admin API for adding, updating, deleting, and refreshing sources
- Default source list from `DEFAULT_SOURCES`
- Dynamic source overrides stored in Cloudflare KV
- Stale cache fallback for expired or blocked upstream links
- Empty Surge response for cold-cache upstream failures
- Surge-like upstream headers when fetching providers
- Built-in conversion for common base64 URI subscriptions into Surge policy lines where safe
- Optional Cloudflare Zero Trust Access validation for admin routes

## Current Limits

Evergreen does not magically refresh provider account tokens. If the provider only makes the subscription available after a browser login or manual activation, you still need to do that once. Evergreen preserves the last successful result so Surge does not break afterward.

The built-in converter only emits protocols that Surge can actually use. For example, Trojan URI nodes can be converted. VLESS with XTLS Vision is not emitted because Surge does not support that protocol family.

## How It Works

```text
Surge
  -> https://your-worker/sub/source-name?token=PUBLIC_TOKEN
  -> Cloudflare Worker
  -> Cloudflare KV cache
  -> upstream provider subscription URL
```

Request behavior:

- Fresh cache exists: return cached subscription.
- Stale cache exists: return cached subscription and refresh in the background.
- No cache exists: try upstream immediately.
- Upstream succeeds: cache and return the subscription.
- Upstream fails and no cache exists: return an empty Surge policy:

```text
[Proxy]
```

That empty response is not cached. The first later success still writes the real subscription into KV.

## Project Layout

```text
src/index.ts                  Worker implementation
test/worker.test.ts           Node tests
scripts/seed-sources.mjs      Import source config through the admin API
examples/sources.example.json Example source config
examples/surge-policy-groups.conf Surge policy-path examples
wrangler.toml                 Cloudflare Worker configuration template
```

## Setup

Install dependencies:

```sh
npm install
```

Create a KV namespace:

```sh
npx wrangler kv namespace create SUB_CACHE
npx wrangler kv namespace create SUB_CACHE_PREVIEW
```

Put the returned IDs into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SUB_CACHE"
id = "YOUR_KV_NAMESPACE_ID"
preview_id = "YOUR_PREVIEW_KV_NAMESPACE_ID"
```

Set secrets:

```sh
npx wrangler secret put PUBLIC_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put DEFAULT_SOURCES
```

`DEFAULT_SOURCES` should be JSON:

```json
{
  "sources": [
    {
      "name": "example",
      "url": "https://provider.example/sub?token=REDACTED"
    }
  ]
}
```

Do not commit real provider URLs or tokens. Use `.dev.vars` only for local development.

## Local Development

Create `.dev.vars` from the example:

```sh
cp .dev.vars.example .dev.vars
```

Run locally:

```sh
npm run dev
```

Open the admin page:

```text
http://127.0.0.1:8787/admin?admin_token=YOUR_ADMIN_TOKEN
```

Run checks:

```sh
npm run typecheck
npm test
```

## Deploy

Optional custom domain:

```toml
[[routes]]
pattern = "subscriptions.example.com"
custom_domain = true
```

Deploy:

```sh
npm run deploy
```

Check the Worker:

```sh
curl "https://subscriptions.example.com/health"
```

## Surge Configuration

Replace provider `policy-path` values with Worker URLs:

```ini
example = select, timeout=30s, policy-path=https://subscriptions.example.com/sub/example?token=PUBLIC_TOKEN, update-interval=3600, external-policy-name-prefix=[example]
```

See `examples/surge-policy-groups.conf` for a larger template.

`update-interval=3600` is usually enough. Evergreen already keeps the cache; Surge does not need to hammer the upstream provider.

## Admin Authentication

Local and simple deployments can use `ADMIN_TOKEN`.

For production, you can protect `/admin*` with Cloudflare Zero Trust Access:

```sh
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
```

When both values are configured, admin requests must carry a valid Cloudflare Access login token. The public `/sub/:name` endpoint still uses `PUBLIC_TOKEN`, because Surge cannot complete an interactive login.

## Admin API

List sources:

```sh
curl -H "Authorization: Bearer ADMIN_TOKEN" \
  "https://subscriptions.example.com/admin/sources"
```

Replace all dynamic sources:

```sh
WORKER_URL=https://subscriptions.example.com \
ADMIN_TOKEN=ADMIN_TOKEN \
node scripts/seed-sources.mjs examples/sources.example.json
```

Add or update one source:

```sh
curl -X PUT "https://subscriptions.example.com/admin/source/example" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"url":"https://provider.example/sub?token=REDACTED","enabled":true}'
```

Refresh one source:

```sh
curl -X POST -H "Authorization: Bearer ADMIN_TOKEN" \
  "https://subscriptions.example.com/admin/refresh/example"
```

Refresh all sources:

```sh
curl -X POST -H "Authorization: Bearer ADMIN_TOKEN" \
  "https://subscriptions.example.com/admin/refresh"
```

## Response Headers

Subscription responses include cache state:

- `x-sub-cache: HIT` means fresh cache was returned.
- `x-sub-cache: STALE` means stale cache was returned while refresh happens in the background.
- `x-sub-cache: REFRESHED` means upstream was fetched and cached during the request.
- `x-sub-cache: EMPTY` means upstream failed and no usable cache exists yet.

## Security Notes

- Keep `PUBLIC_TOKEN`, `ADMIN_TOKEN`, and provider subscription URLs out of git.
- `.dev.vars` is ignored on purpose.
- `DEFAULT_SOURCES` is a secret because provider URLs often contain real account tokens.
- KV namespace IDs are not credentials, but the public template keeps placeholders so the repo can be reused safely.
