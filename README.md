# Evergreen

Evergreen 是一个运行在 Cloudflare Workers 上的 Surge 订阅缓存服务。它给 Surge 提供稳定的订阅地址，把上一次成功拉取到的机场订阅保存在 Cloudflare KV 里，避免上游订阅链接过期、临时 401/403/502 或短暂不可用时直接影响 Surge。

适合这种场景：

- 机场订阅链接带短时效 token。
- Surge 直接拉机场链接时经常遇到 401、403、502。
- 某些机场需要先打开网页或手动刷新订阅，Cloudflare Cron 无法替代这个动作。
- 你希望 Surge 永远读一个稳定 URL，而不是直接依赖机场的实时可用性。

## 核心思路

```text
Surge
  -> https://your-worker/sub/source-name?token=PUBLIC_TOKEN
  -> Cloudflare Worker
  -> Cloudflare KV 缓存
  -> 真实机场订阅 URL
```

请求逻辑：

- 有新鲜缓存：直接返回缓存。
- 有过期但仍在保留期内的缓存：返回旧缓存，并在后台尝试刷新。
- 没有缓存：立即尝试拉上游。
- 上游成功：写入 KV，然后返回订阅内容。
- 上游失败且没有任何可用缓存：返回一个空 Surge 订阅，而不是 HTTP 502。

空订阅内容是几条合法但不可用的本地 HTTP 代理占位 policy：

```text
Evergreen Empty = http, 127.0.0.1, 9
Evergreen Empty 1x = http, 127.0.0.1, 9
Evergreen Empty 家宽 = http, 127.0.0.1, 9
```

`policy-path` 需要的是代理定义行列表，不是完整的 `[Proxy]` 配置段。这里保留了普通、`1x`、`家宽` 三种占位名称，是为了让你现有的 `policy-regex-filter` 过滤后仍然至少剩下一条合法 policy，避免 Surge 把远程资源判定为解析失败。它们都指向本机未使用的 9 端口，不会形成可用出站；这个占位响应也不会写入缓存，后面只要上游恢复，第一次成功拉取仍会写入真实缓存。

## 功能

- 稳定订阅地址：`/sub/:name?token=...`
- 管理页面：`/admin`
- 管理 API：新增、更新、删除、刷新机场源
- 管理页可一键复制 Surge 订阅地址
- 默认机场配置来自 `DEFAULT_SOURCES`
- 动态配置和默认配置都存入 Cloudflare KV
- 上游失败时保留上一次成功缓存
- 最后一次成功刷新和最后一次失败刷新分开展示
- 首次无缓存且上游失败时返回空订阅，避免 Surge 拉取接口直接失败
- 拉上游时默认模仿 Surge 请求头
- 内置常见 base64 URI 订阅到 Surge 外部策略格式的转换
- 管理页可选接入 Cloudflare Zero Trust Access
- 支持从本机成功拉取后手工导入 KV，适合 Cloudflare 出口被上游挡住的机场

## 当前限制

Evergreen 不能通用地“自动刷新机场账号 token”。多数机场只给一个订阅 URL，没有公开刷新 token 的接口；如果机场要求先在网页里打开或激活订阅，Worker 也没有你的浏览器登录态。

这个项目解决的是更实际的问题：只要有一次成功拉取，后续 Surge 就可以继续使用 Cloudflare KV 里的最近一次成功缓存。

内置转换也只输出 Surge 能明确支持的协议。例如 Trojan URI 可以转换；VLESS + XTLS Vision 不会输出，因为 Surge 不支持这一类协议。

## 目录结构

```text
src/index.ts                  Worker 主实现
test/worker.test.ts           测试
scripts/import-cache.mjs      本地拉取订阅并导入 Worker KV
scripts/enable-access.mjs     写入 Access secrets、部署并验证 admin_token 被禁用
scripts/setup-access.mjs      创建 Cloudflare Access 应用的辅助脚本
scripts/seed-sources.mjs      通过管理 API 导入机场源
examples/sources.example.json 示例机场源配置
examples/surge-policy-groups.conf Surge policy-path 示例
wrangler.toml                 Cloudflare Worker 配置模板
```

## 安装

```sh
npm install
```

## 创建 KV

```sh
npx wrangler kv namespace create SUB_CACHE
npx wrangler kv namespace create SUB_CACHE_PREVIEW
```

把返回的 ID 填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "SUB_CACHE"
id = "YOUR_KV_NAMESPACE_ID"
preview_id = "YOUR_PREVIEW_KV_NAMESPACE_ID"
```

## 配置密钥

```sh
npx wrangler secret put PUBLIC_TOKEN
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put DEFAULT_SOURCES
```

`DEFAULT_SOURCES` 是 JSON：

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

真实机场订阅 URL 往往包含账号 token，不要提交到 git。生产环境建议放进 Worker secret，本地开发放进 `.dev.vars`。

## 本地开发

复制本地环境变量示例：

```sh
cp .dev.vars.example .dev.vars
```

启动本地 Worker：

```sh
npm run dev
```

打开管理页：

```text
http://127.0.0.1:8787/admin?admin_token=YOUR_ADMIN_TOKEN
```

运行检查：

```sh
npm run typecheck
npm test
```

## 部署

如果要绑定自定义域名，可以在 `wrangler.toml` 里配置：

```toml
[[routes]]
pattern = "subscriptions.example.com"
custom_domain = true
```

部署：

```sh
npm run deploy
```

如果生产环境使用单独的本地配置文件，可以把真实 KV namespace 和自定义域名放进 `wrangler.production.toml`。这个文件已加入 `.gitignore`，不会提交到 GitHub：

```sh
npm run deploy:production
```

检查服务：

```sh
curl "https://subscriptions.example.com/health"
```

## Surge 配置

把原来的机场 `policy-path` 改成 Worker 地址：

```ini
example = select, timeout=30s, policy-path=https://subscriptions.example.com/sub/example?token=PUBLIC_TOKEN, update-interval=3600, external-policy-name-prefix=[example]
```

更完整的模板在 `examples/surge-policy-groups.conf`。

建议把 Surge 的 `update-interval` 设成 `3600` 左右。Evergreen 已经会保留缓存，Surge 没必要频繁打到 Worker，Worker 也没必要频繁打到上游机场。

## 管理认证

简单部署可以直接使用 `ADMIN_TOKEN`：

```text
https://subscriptions.example.com/admin?admin_token=ADMIN_TOKEN
```

生产环境建议用 Cloudflare Zero Trust Access 保护 `/admin*`，避免 `admin_token` 出现在浏览器地址栏：

1. 在 Cloudflare Zero Trust 里创建 Self-hosted application，域名填你的 Worker 域名，路径填 `/admin*`。
2. 给这个应用添加只允许你登录的 Access policy。
3. 在应用详情里复制 Application Audience (AUD)，再确认你的 Team domain，例如 `https://your-team.cloudflareaccess.com`。
4. 写入 Worker secret：

```sh
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
```

配置了这两个值后，管理页面和管理 API 会校验 Cloudflare Access 登录，不再接受 `admin_token`。公开订阅接口 `/sub/:name` 仍然使用 `PUBLIC_TOKEN`，因为 Surge 不能完成交互式登录。

如果脚本也要访问受 Access 保护的管理 API，在 Zero Trust 里创建 Service Token，并把它加入同一个 Access policy。脚本运行时传这两个环境变量：

```sh
CF_ACCESS_CLIENT_ID=xxxxx.access
CF_ACCESS_CLIENT_SECRET=xxxxx
```

如果你有带 Zero Trust Access 权限的 Cloudflare API token，也可以用脚本创建 Access policy/application。推荐给这个 token 两个 account 权限：

- `Access: Apps and Policies` - `Edit`
- `Access: Organizations, Identity Providers, and Groups` - `Read`

第二个权限用于自动读取 Zero Trust team domain；如果不加，也可以手动传 `CF_ACCESS_TEAM_DOMAIN=...`。

把 token 放到本机临时文件：

```sh
printf '%s' '你的_TOKEN' > /tmp/evergreen-cloudflare-api-token
chmod 600 /tmp/evergreen-cloudflare-api-token
```

先做只读预检：

```sh
npm run check-access-token
```

这个预检同时支持用户级 API token 和账号级 API token。

然后运行：

```sh
ACCESS_ALLOWED_EMAIL=you@example.com \
ACCESS_APP_DOMAIN=evergreen.atoma.one/admin* \
CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com \
npm run setup-access
```

脚本会默认读取 `/tmp/evergreen-cloudflare-api-token`，并在当前 `wrangler` 登录态只有一个账号时自动使用这个账号 ID。如果你的 `wrangler` 登录态里有多个账号，再额外传 `CLOUDFLARE_ACCOUNT_ID=...`。

如果 token 有 organization read 权限，可以直接创建 Access app、写入 Worker secrets、部署生产配置：

```sh
ACCESS_ALLOWED_EMAIL=you@example.com \
WORKER_URL=https://evergreen.atoma.one \
ADMIN_TOKEN=ADMIN_TOKEN \
npm run setup-and-enable-access
```

`ADMIN_TOKEN` 只用于部署后验证旧 token 已被拒绝；不传也会启用 Access，但不会做这一步验证。

这个命令可以重复执行：如果同名 Access policy 或同域名 Access app 已经存在，脚本会复用现有对象，避免重复创建。Access app 只按域名复用，避免同名但不同地址的应用被误用。

复用已有 Access app 时，脚本会确认能拿到 Application Audience (AUD)。如果 Cloudflare API 没返回 AUD，脚本会停下来，避免写入错误的 Worker secret。

先检查将要创建的内容：

```sh
ACCESS_ALLOWED_EMAIL=you@example.com npm run setup-access -- --dry-run
```

脚本成功后会输出 `CF_ACCESS_AUD` 和 `CF_ACCESS_TEAM_DOMAIN`。拿到这两个值后，用下面的命令正式切换 Worker：

```sh
CF_ACCESS_AUD=... \
CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com \
npm run enable-access
```

`enable-access` 会优先使用本地的 `wrangler.production.toml`；如果没有这个文件，才会退回 `wrangler.toml`。也可以用 `WRANGLER_CONFIG=...` 手动指定。

验证时，`enable-access` 会把 `admin_token` 访问返回 401/403 或被 Cloudflare Access 跳转登录页都视为通过；只要还返回 200，就会失败。

如果想让脚本部署后顺便验证 `admin_token` 已被拒绝：

```sh
CF_ACCESS_AUD=... \
CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com \
WORKER_URL=https://subscriptions.example.com \
ADMIN_TOKEN=ADMIN_TOKEN \
npm run enable-access
```

## 管理 API

查看机场源：

```sh
curl -H "Authorization: Bearer ADMIN_TOKEN" \
  "https://subscriptions.example.com/admin/sources"
```

批量导入动态源：

```sh
WORKER_URL=https://subscriptions.example.com \
ADMIN_TOKEN=ADMIN_TOKEN \
node scripts/seed-sources.mjs examples/sources.example.json
```

如果管理 API 已切到 Cloudflare Access，用 Service Token：

```sh
WORKER_URL=https://subscriptions.example.com \
CF_ACCESS_CLIENT_ID=xxxxx.access \
CF_ACCESS_CLIENT_SECRET=xxxxx \
node scripts/seed-sources.mjs examples/sources.example.json
```

新增或更新单个源：

```sh
curl -X PUT "https://subscriptions.example.com/admin/source/example" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"url":"https://provider.example/sub?token=REDACTED","enabled":true}'
```

刷新单个源：

```sh
curl -X POST -H "Authorization: Bearer ADMIN_TOKEN" \
  "https://subscriptions.example.com/admin/refresh/example"
```

刷新全部源：

```sh
curl -X POST -H "Authorization: Bearer ADMIN_TOKEN" \
  "https://subscriptions.example.com/admin/refresh"
```

## 本地成功拉取后导入 KV

有些机场从你的本机网络可以拉取，但 Cloudflare Worker 出口会被上游拦截。这种情况下可以让本机先拉取真实订阅，再把成功结果导入 KV：

```sh
WORKER_URL=https://subscriptions.example.com \
ADMIN_TOKEN=ADMIN_TOKEN \
npm run import-cache -- tag
```

脚本会优先从 `DEFAULT_SOURCES` 里找同名源的真实 URL。也可以临时指定 URL：

```sh
WORKER_URL=https://subscriptions.example.com \
ADMIN_TOKEN=ADMIN_TOKEN \
npm run import-cache -- tag --url "https://provider.example/sub?token=REDACTED"
```

如果管理 API 已经由 Cloudflare Access 保护：

```sh
WORKER_URL=https://subscriptions.example.com \
CF_ACCESS_CLIENT_ID=xxxxx.access \
CF_ACCESS_CLIENT_SECRET=xxxxx \
npm run import-cache -- tag
```

导入成功后会更新这个机场的缓存、代理数量和“最后一次成功刷新”时间。之后即使 Worker 自己刷新失败，Surge 仍会继续读取这份缓存。

## 订阅响应头

订阅接口会返回缓存状态：

- `x-sub-cache: HIT`：返回新鲜缓存。
- `x-sub-cache: STALE`：返回旧缓存，同时后台刷新。
- `x-sub-cache: REFRESHED`：本次请求拉上游成功，并已写入缓存。
- `x-sub-cache: EMPTY`：上游失败且当前没有可用缓存，所以返回空订阅。

## 安全注意事项

- 不要提交 `PUBLIC_TOKEN`、`ADMIN_TOKEN` 和真实机场订阅 URL。
- `.dev.vars` 已加入 `.gitignore`，只用于本地开发。
- `DEFAULT_SOURCES` 建议始终作为 Worker secret 管理。
- KV namespace ID 不等于密钥，但公开模板里仍使用占位值，方便复用。
