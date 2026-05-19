import * as React from "react";
import { createRoot } from "react-dom/client";
import { Clipboard, Loader2, RefreshCcw, Save, Trash2, Wifi, WifiOff } from "lucide-react";
import "./styles.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

type AdminSource = {
  name: string;
  url: string;
  sourceType: string;
  enabled: boolean;
  ttlSeconds: number | null;
  cached: boolean;
  updatedAt: string | null;
  bytes: number;
  proxyCount: number;
  proxyCountKnown: boolean;
  cacheState: string;
  lastRefreshOk: boolean | null;
  lastRefreshError: string | null;
  lastRefreshAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessCacheStatus: string | null;
  lastSuccessProxyCount: number | null;
  lastSuccessBytes: number | null;
  lastFailureAt: string | null;
  lastFailureStatus: number | null;
  lastFailureError: string | null;
};

type AdminBoot = {
  token: string;
  authMode: string;
  publicToken: string;
  timezone: "Asia/Shanghai";
  generatedAt: string;
  sources: AdminSource[];
};

declare global {
  interface Window {
    __EVERGREEN_ADMIN__?: AdminBoot;
  }
}

const boot = window.__EVERGREEN_ADMIN__ || {
  token: "",
  authMode: "Cloudflare Access",
  publicToken: "",
  timezone: "Asia/Shanghai",
  generatedAt: new Date().toISOString(),
  sources: [],
};

function App() {
  const [sources, setSources] = React.useState(boot.sources);
  const [busy, setBusy] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [form, setForm] = React.useState({ name: "", url: "", ttlSeconds: "", enabled: true });

  const sourceCount = sources.length;
  const cachedCount = sources.filter((source) => source.cached).length;
  const attentionCount = sources.filter((source) => source.cacheState === "invalid" || source.lastRefreshOk === false).length;
  const proxyCount = sources.reduce((sum, source) => sum + Number(source.proxyCount || 0), 0);

  async function adminFetch(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    if (boot.token) headers.set("x-admin-token", boot.token);
    return fetch(path, { ...options, headers });
  }

  async function reloadStatus() {
    const response = await adminFetch("/admin/status");
    const data = (await response.json()) as { sources?: AdminSource[]; error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setSources(data.sources || []);
  }

  async function runAction(label: string, task: () => Promise<Response | void>) {
    setBusy(label);
    setMessage("");
    try {
      const response = await task();
      if (response) {
        const text = await response.text();
        if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
      }
      await reloadStatus();
      setMessage("已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy("");
    }
  }

  async function saveSource(event: React.FormEvent) {
    event.preventDefault();
    await runAction("save", async () =>
      adminFetch(`/admin/source/${encodeURIComponent(form.name)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: form.url,
          enabled: form.enabled,
          ...(form.ttlSeconds ? { ttlSeconds: Number(form.ttlSeconds) } : {}),
        }),
      }),
    );
  }

  async function copySubscription(source: AdminSource) {
    if (!boot.publicToken) return;
    const value = new URL(`/sub/${encodeURIComponent(source.name)}?token=${encodeURIComponent(boot.publicToken)}`, location.origin).toString();
    await navigator.clipboard.writeText(value);
    setMessage("订阅地址已复制");
  }

  return (
    <main className="mx-auto flex max-w-[1440px] flex-col gap-5 px-5 py-6 lg:px-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-normal">Evergreen</h1>
            <Badge variant="secondary">{boot.authMode}</Badge>
            <Badge variant="outline">UTC+8</Badge>
          </div>
          <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
            <span>刷新于 {formatTime(boot.generatedAt)}</span>
            <span>{sourceCount} 个机场源</span>
          </div>
        </div>
        <Button onClick={() => runAction("refresh-all", () => adminFetch("/admin/refresh", { method: "POST" }))} disabled={Boolean(busy)}>
          {busy === "refresh-all" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          Refresh all
        </Button>
      </header>

      <section className="grid gap-3 md:grid-cols-4">
        <Metric label="机场源" value={sourceCount} />
        <Metric label="已缓存" value={cachedCount} />
        <Metric label="需处理" value={attentionCount} tone={attentionCount > 0 ? "bad" : "normal"} />
        <Metric label="代理总数" value={proxyCount} />
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>添加或更新机场</CardTitle>
          <CardDescription>同名保存会覆盖当前配置。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 lg:grid-cols-[180px_1fr_140px_110px_130px]" onSubmit={saveSource}>
            <Field label="名称">
              <Input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="ssrdog" />
            </Field>
            <Field label="URL">
              <Input required type="url" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://example.com/sub?token=..." />
            </Field>
            <Field label="TTL 秒">
              <Input value={form.ttlSeconds} onChange={(event) => setForm({ ...form, ttlSeconds: event.target.value })} type="number" min="60" placeholder="21600" />
            </Field>
            <label className="flex h-16 items-end gap-2 pb-2 text-sm">
              <Checkbox checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })} />
              启用
            </label>
            <div className="flex h-16 items-end">
              <Button className="w-full" type="submit" disabled={Boolean(busy)}>
                {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b pb-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle>机场配置</CardTitle>
              <CardDescription>所有时间均按 UTC+8 显示。</CardDescription>
            </div>
            {message ? (
              <div className={cn("rounded-md border px-3 py-2 text-sm", message.includes("失败") || message.includes("error") || message.includes("HTTP") ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700")}>
                {message}
              </div>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-[1220px] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[430px]">Source</TableHead>
                  <TableHead className="w-[150px]">Cache</TableHead>
                  <TableHead className="w-[90px] text-right">代理</TableHead>
                  <TableHead className="w-[190px]">最近成功</TableHead>
                  <TableHead className="w-[210px]">最近失败</TableHead>
                  <TableHead className="sticky right-0 w-[150px] bg-card text-right shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.45)]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-28 text-center text-muted-foreground">No sources configured.</TableCell>
                  </TableRow>
                ) : (
                  sources.map((source) => (
                    <SourceRow
                      key={source.name}
                      source={source}
                      busy={busy}
                      onRefresh={() => runAction(`refresh:${source.name}`, () => adminFetch(`/admin/refresh/${encodeURIComponent(source.name)}`, { method: "POST" }))}
                      onDelete={() => runAction(`delete:${source.name}`, () => adminFetch(`/admin/source/${encodeURIComponent(source.name)}`, { method: "DELETE" }))}
                      onCopy={() => copySubscription(source)}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

function Metric({ label, value, tone = "normal" }: { label: string; value: number; tone?: "normal" | "bad" }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className={cn("mt-2 text-2xl font-semibold", tone === "bad" && value > 0 ? "text-red-700" : "text-foreground")}>{value}</div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function SourceRow({ source, busy, onRefresh, onDelete, onCopy }: {
  source: AdminSource;
  busy: string;
  onRefresh: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const attention = source.cacheState === "invalid" || source.lastRefreshOk === false;
  const deleteLabel = source.sourceType === "default" ? "Clear cache" : "Delete";
  return (
    <TableRow className={cn(attention && "bg-red-50/35 hover:bg-red-50/50")}>
      <TableCell>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            {source.enabled ? <Wifi className="h-4 w-4 text-emerald-600" /> : <WifiOff className="h-4 w-4 text-muted-foreground" />}
            <span className="font-semibold">{source.name}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{sourceTypeLabel(source.sourceType)}</Badge>
            <Badge variant={source.enabled ? "success" : "secondary"}>{source.enabled ? "enabled" : "disabled"}</Badge>
            <Badge variant="outline">TTL {source.ttlSeconds || "default"}</Badge>
          </div>
          <div className="w-full overflow-x-auto whitespace-nowrap rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground">
            {source.url}
          </div>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant={cacheVariant(source.cacheState)}>{cacheLabel(source.cacheState)}</Badge>
        <div className="mt-2 text-xs text-muted-foreground">{formatBytes(source.bytes)}</div>
        <div className="mt-1 text-xs text-muted-foreground">{formatTime(source.updatedAt)}</div>
      </TableCell>
      <TableCell className="text-right">
        <span className={cn("font-semibold", !source.proxyCountKnown && "font-medium text-muted-foreground")}>
          {source.proxyCountKnown ? source.proxyCount : "未刷新"}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant={source.lastSuccessAt ? "success" : "secondary"}>{source.lastSuccessAt ? "成功" : "未成功"}</Badge>
        <div className="mt-2 text-xs text-muted-foreground">{formatTime(source.lastSuccessAt)}</div>
        {source.lastSuccessProxyCount !== null ? (
          <div className="mt-1 text-xs text-muted-foreground">{source.lastSuccessProxyCount} proxies · {formatBytes(source.lastSuccessBytes || 0)}</div>
        ) : null}
      </TableCell>
      <TableCell>
        <Badge variant={source.lastFailureAt ? "destructive" : "secondary"}>{source.lastFailureAt ? "失败" : "未失败"}</Badge>
        <div className="mt-2 text-xs text-muted-foreground">{formatTime(source.lastFailureAt)}</div>
        {source.lastFailureStatus ? <div className="mt-1 text-xs text-muted-foreground">HTTP {source.lastFailureStatus}</div> : null}
        {source.lastFailureError ? <div className="mt-1 max-w-[220px] text-xs text-red-700">{source.lastFailureError}</div> : null}
      </TableCell>
      <TableCell className="sticky right-0 bg-card shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.45)]">
        <div className="flex justify-end gap-2">
          <Button size="icon" variant="outline" onClick={onRefresh} disabled={Boolean(busy)} title="Refresh" aria-label="Refresh">
            {busy === `refresh:${source.name}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
          </Button>
          <Button size="icon" variant="outline" onClick={onCopy} disabled={!boot.publicToken} title="Copy URL" aria-label="Copy URL">
            <Clipboard className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant={deleteLabel === "Delete" ? "destructive" : "outline"} onClick={onDelete} disabled={Boolean(busy)} title={deleteLabel} aria-label={deleteLabel}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function sourceTypeLabel(value: string) {
  if (value === "default") return "默认";
  if (value === "override") return "覆盖";
  if (value === "dynamic") return "动态";
  return value;
}

function cacheLabel(value: string) {
  if (value === "fresh") return "新鲜";
  if (value === "stale") return "过期";
  if (value === "invalid") return "无效";
  if (value === "empty") return "未缓存";
  return value || "未知";
}

function cacheVariant(value: string) {
  if (value === "fresh") return "success";
  if (value === "stale") return "warning";
  if (value === "invalid") return "destructive";
  return "secondary";
}

function formatTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}:${lookup.second} UTC+8`;
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
