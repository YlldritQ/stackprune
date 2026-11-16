/**
 * stackprune runtime probe.
 *
 * Counts outbound HTTP calls per vendor using Node's built-in diagnostics channels
 * (fetch/undici and http/https, which covers axios, got, node-fetch and most SDKs).
 * No monkey-patching, no request bodies, no paths, no headers: only hostname, count,
 * error count and total latency, aggregated in memory and flushed every minute.
 *
 * It also records which npm packages the app actually loads (names only), so
 * `stackprune --usage` can point at dependencies that are imported somewhere but never
 * run in production.
 *
 *   node --import stackprune/register server.js
 *   NODE_OPTIONS="--import stackprune/register" npm start
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import dc from 'node:diagnostics_channel';
import nodeModule, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hostname as osHostname } from 'node:os';
import { join, resolve } from 'node:path';
import { buildCatalog, type Catalog } from '../catalog/index.js';

export interface ProbeOptions {
  /** Name of this app/service. Use the repo name so usage lines up with the static scan. */
  app?: string;
  /** Folder to append JSONL usage files to. Default ".stackprune". Set to "" to disable. */
  outDir?: string;
  /** Optional URL to POST each flush to (JSON array of records). */
  endpoint?: string;
  /** Flush interval in ms. Default 60000. */
  flushIntervalMs?: number;
  /** Also record hosts that match no known vendor (helps discover integrations). Default true. */
  recordUnknown?: boolean;
  /** Record which packages get loaded from node_modules. Default true. */
  trackPackages?: boolean;
  /** Count localhost / private-network calls too. Off by default; mainly for tests. */
  allowPrivate?: boolean;
  catalog?: Catalog;
}

interface Counter {
  vendor?: string;
  host: string;
  calls: number;
  errors: number;
  status4xx: number;
  status5xx: number;
  ms: number;
}

export interface Probe {
  flush(): void;
  stop(): void;
  /** Snapshot of the current (unflushed) window — handy in tests. */
  peek(): Counter[];
  /** Packages loaded so far. */
  packages(): string[];
}

/** "/app/node_modules/.pnpm/x@1/node_modules/@scope/pkg/dist/i.js" → "@scope/pkg" */
export function packageFromPath(p: string): string | undefined {
  const norm = p.replace(/\\/g, '/');
  const i = norm.lastIndexOf('/node_modules/');
  if (i === -1) return undefined;
  const parts = norm.slice(i + '/node_modules/'.length).split('/');
  if (!parts[0] || parts[0].startsWith('.')) return undefined;
  return parts[0].startsWith('@') ? (parts[1] ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?|[^.]+$)|\.(local|internal|localhost|svc|cluster\.local)$/i;

let active: Probe | undefined;

export function startProbe(opts: ProbeOptions = {}): Probe {
  if (active) return active;
  const catalog = opts.catalog ?? buildCatalog();
  const app = opts.app ?? process.env.npm_package_name ?? 'app';
  const outDir = opts.outDir ?? '.stackprune';
  const endpointHost = opts.endpoint ? safeHost(opts.endpoint) : undefined;
  const recordUnknown = opts.recordUnknown ?? true;
  const counters = new Map<string, Counter>();
  const startedAt = new WeakMap<object, number>();
  let windowStart = new Date();

  const counterFor = (rawHost: string | undefined): Counter | undefined => {
    if (!rawHost) return undefined;
    const host = rawHost.toLowerCase().replace(/:\d+$/, '');
    if (host === endpointHost || (!opts.allowPrivate && PRIVATE_HOST.test(host))) return undefined;
    const vendor = catalog.matchHost(host)?.id;
    if (!vendor && !recordUnknown) return undefined;
    const key = vendor ? `${vendor}|${host}` : `|${host}`;
    let c = counters.get(key);
    if (!c) counters.set(key, (c = { vendor, host, calls: 0, errors: 0, status4xx: 0, status5xx: 0, ms: 0 }));
    return c;
  };

  const onStatus = (c: Counter | undefined, status: number | undefined, req: object) => {
    if (!c) return;
    const t = startedAt.get(req);
    if (t !== undefined) c.ms += Date.now() - t;
    if (status && status >= 500) c.status5xx++;
    else if (status && status >= 400) c.status4xx++;
  };

  // fetch() / undici
  type UndiciReq = { origin?: string | URL };
  const undiciHost = (r: UndiciReq | undefined) => (r?.origin ? safeHost(String(r.origin)) : undefined);
  const subs: [string, (m: unknown) => void][] = [
    [
      'undici:request:create',
      (m) => {
        const req = (m as { request: UndiciReq }).request;
        const c = counterFor(undiciHost(req));
        if (!c) return;
        c.calls++;
        startedAt.set(req as object, Date.now());
      },
    ],
    [
      'undici:request:headers',
      (m) => {
        const { request, response } = m as { request: UndiciReq; response: { statusCode?: number } };
        onStatus(counterFor(undiciHost(request)), response?.statusCode, request as object);
      },
    ],
    [
      'undici:request:error',
      (m) => {
        const c = counterFor(undiciHost((m as { request: UndiciReq }).request));
        if (c) c.errors++;
      },
    ],
    [
      'undici:client:connectError',
      (m) => {
        const p = (m as { connectParams?: { hostname?: string; host?: string } }).connectParams;
        const c = counterFor(p?.hostname ?? p?.host);
        if (c) {
          c.calls++;
          c.errors++;
        }
      },
    ],
    // http / https (axios, got, node-fetch, most SDKs)
    [
      'http.client.request.start',
      (m) => {
        const req = (m as { request: { host?: string } }).request;
        const c = counterFor(req?.host);
        if (!c) return;
        c.calls++;
        startedAt.set(req, Date.now());
      },
    ],
    [
      'http.client.response.finish',
      (m) => {
        const { request, response } = m as { request: { host?: string }; response: { statusCode?: number } };
        onStatus(counterFor(request?.host), response?.statusCode, request);
      },
    ],
    [
      'http.client.request.error',
      (m) => {
        const c = counterFor((m as { request: { host?: string } }).request?.host);
        if (c) c.errors++;
      },
    ],
  ];
  for (const [name, fn] of subs) dc.subscribe(name, fn);

  // Which packages does the app really load? (ESM + CJS via module.registerHooks where
  // available, plus require.cache for CJS on older Node versions.)
  const loaded = new Set<string>();
  const fresh = new Set<string>();
  const notePath = (p: string | undefined) => {
    const pkg = p ? packageFromPath(p) : undefined;
    if (!pkg || pkg === 'stackprune' || loaded.has(pkg)) return;
    loaded.add(pkg);
    fresh.add(pkg);
  };
  const trackPackages = opts.trackPackages !== false;
  let hooks: { deregister?: () => void } | undefined;
  if (trackPackages) {
    const registerHooks = (nodeModule as unknown as { registerHooks?: (h: unknown) => { deregister?: () => void } }).registerHooks;
    if (typeof registerHooks === 'function') {
      try {
        hooks = registerHooks({
          resolve(specifier: string, context: unknown, nextResolve: (s: string, c: unknown) => { url?: string }) {
            const r = nextResolve(specifier, context);
            if (r?.url?.startsWith('file:') && r.url.includes('/node_modules/')) notePath(fileURLToPath(r.url));
            return r;
          },
        });
      } catch {
        /* older API shape: fall back to require.cache */
      }
    }
  }
  const requireCache = createRequire(import.meta.url).cache;
  const sweepRequireCache = () => {
    if (trackPackages) for (const p of Object.keys(requireCache)) notePath(p);
  };

  const flush = () => {
    sweepRequireCache();
    if (!counters.size && !fresh.size) {
      windowStart = new Date();
      return;
    }
    const to = new Date().toISOString();
    const from = windowStart.toISOString();
    const records: object[] = [...counters.values()].map((c) => ({ v: 1, ts: to, from, app, ...c, errors: c.errors + c.status5xx }));
    if (fresh.size) {
      records.push({ v: 1, kind: 'packages', ts: to, from, app, packages: [...fresh].sort() });
      fresh.clear();
    }
    counters.clear();
    windowStart = new Date();
    if (outDir) {
      try {
        const dir = resolve(outDir);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `usage-${sanitize(app)}-${sanitize(osHostname())}.jsonl`);
        appendFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
      } catch {
        /* never take the app down because of telemetry */
      }
    }
    if (opts.endpoint) {
      // Our own POST is excluded from counting via endpointHost.
      fetch(opts.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(records) }).catch(() => {});
    }
  };

  const timer = setInterval(flush, opts.flushIntervalMs ?? 60_000);
  timer.unref();
  const onExit = () => flush();
  process.once('beforeExit', onExit);
  process.once('exit', onExit);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      flush();
      // Re-raise so the app's own handlers / default behaviour still run.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    });
  }

  active = {
    flush,
    peek: () => [...counters.values()].map((c) => ({ ...c })),
    packages: () => {
      sweepRequireCache();
      return [...loaded].sort();
    },
    stop: () => {
      clearInterval(timer);
      hooks?.deregister?.();
      for (const [name, fn] of subs) dc.unsubscribe(name, fn);
      process.off('beforeExit', onExit);
      process.off('exit', onExit);
      flush();
      active = undefined;
    },
  };
  return active;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64);
}
