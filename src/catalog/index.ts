import { registrableDomain } from '../hosts.js';
import type { Ecosystem, Vendor } from '../types.js';
import { VENDORS } from './vendors.js';

/** Domains that host many unrelated services; owning a host there says nothing about the rest. */
const SHARED_DOMAINS = new Set([
  'amazonaws.com',
  'amazon.com',
  'cloudfront.net',
  'googleapis.com',
  'google.com',
  'gstatic.com',
  'googleusercontent.com',
  'appspot.com',
  'firebaseapp.com',
  'web.app',
  'windows.net',
  'azure.com',
  'microsoft.com',
  'azurewebsites.net',
  'cloudflare.com',
  'workers.dev',
  'pages.dev',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'fly.dev',
  'onrender.com',
  'up.railway.app',
  'github.com',
  'githubusercontent.com',
  'apple.com',
  'akamaized.net',
  'fastly.net',
]);

type Matcher<T> = { exact: Map<string, T>; prefix: { p: string; v: T }[]; regex: { re: RegExp; v: T; len: number }[] };

function newMatcher<T>(): Matcher<T> {
  return { exact: new Map(), prefix: [], regex: [] };
}

function addPattern<T>(m: Matcher<T>, pattern: string, value: T): void {
  const star = pattern.indexOf('*');
  if (star === -1) {
    if (!m.exact.has(pattern)) m.exact.set(pattern, value);
  } else if (star === pattern.length - 1) {
    m.prefix.push({ p: pattern.slice(0, -1), v: value });
  } else {
    const src = pattern.split('*').map(escapeRe).join('.*');
    m.regex.push({ re: new RegExp(`^${src}$`), v: value, len: pattern.length });
  }
}

function finalize<T>(m: Matcher<T>): void {
  m.prefix.sort((a, b) => b.p.length - a.p.length);
  m.regex.sort((a, b) => b.len - a.len);
}

function lookup<T>(m: Matcher<T>, key: string): T | undefined {
  const hit = m.exact.get(key);
  if (hit !== undefined) return hit;
  for (const { p, v } of m.prefix) if (key.startsWith(p)) return v;
  for (const { re, v } of m.regex) if (re.test(key)) return v;
  return undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalise a Python distribution name the way pip does (PEP 503). */
export function normalizePypi(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export class Catalog {
  readonly vendors: Vendor[];
  readonly byId = new Map<string, Vendor>();
  private readonly pkg = new Map<Ecosystem, Matcher<Vendor>>();
  private readonly py = newMatcher<Vendor>();
  private readonly go = newMatcher<Vendor>();
  private readonly env = newMatcher<Vendor>();
  /** host suffix → vendor, longest suffix wins */
  private readonly hostExact = new Map<string, Vendor>();
  private readonly hostSuffix: { s: string; v: Vendor }[] = [];
  private readonly hostRegex: { re: RegExp; v: Vendor; len: number }[] = [];

  constructor(vendors: Vendor[]) {
    this.vendors = vendors;
    for (const v of vendors) {
      this.byId.set(v.id, v);
      for (const [eco, names] of Object.entries(v.packages ?? {}) as [Ecosystem, string[]][]) {
        let m = this.pkg.get(eco);
        if (!m) this.pkg.set(eco, (m = newMatcher()));
        for (const n of names) addPattern(m, eco === 'pypi' ? normalizePypi(n) : n, v);
      }
      // Explicit module names add to (not replace) the ones derived from package names.
      const pyModules = new Set([...(v.modules?.python ?? []), ...(v.packages?.pypi ?? []).map((n) => n.replace(/-/g, '_').toLowerCase())]);
      for (const mod of pyModules) addPattern(this.py, mod, v);
      for (const mod of new Set([...(v.modules?.go ?? []), ...(v.packages?.go ?? [])])) addPattern(this.go, mod, v);
      for (const e of v.env ?? []) addPattern(this.env, e, v);
      for (const h of v.hosts ?? []) {
        const host = h.toLowerCase();
        const rest = host.startsWith('*.') ? host.slice(2) : host;
        if (rest.includes('*')) {
          // e.g. "sqs.*.amazonaws.com" or "*.s3.*.amazonaws.com": `*` spans one or more labels
          const label = '[a-z0-9-]+(?:\\.[a-z0-9-]+)*';
          const body = rest.split('*').map(escapeRe).join(label);
          this.hostRegex.push({ re: new RegExp(`^(?:${host.startsWith('*.') ? `${label}\\.` : ''})${body}$`), v, len: host.length });
        } else if (host.startsWith('*.')) this.hostSuffix.push({ s: rest, v });
        else if (!this.hostExact.has(host)) this.hostExact.set(host, v);
      }
    }
    for (const m of this.pkg.values()) finalize(m);
    finalize(this.py);
    finalize(this.go);
    finalize(this.env);
    this.hostSuffix.sort((a, b) => b.s.length - a.s.length);
    this.hostRegex.sort((a, b) => b.len - a.len);
  }

  matchPackage(eco: Ecosystem, name: string): Vendor | undefined {
    const m = this.pkg.get(eco);
    if (!m) return undefined;
    return lookup(m, eco === 'pypi' ? normalizePypi(name) : name);
  }

  /** `spec` is a bare JS import specifier like "stripe", "@sentry/node/esm" or "firebase/auth". */
  matchJsImport(spec: string): Vendor | undefined {
    const name = jsPackageName(spec);
    return name ? this.matchPackage('npm', name) ?? this.matchPackage('npm', spec) : undefined;
  }

  /** `mod` is a dotted Python module like "sentry_sdk" or "google.cloud.storage". */
  matchPythonModule(mod: string): Vendor | undefined {
    const parts = mod.split('.');
    // longest dotted prefix first: google.cloud.storage → google.cloud → google
    for (let i = parts.length; i > 0; i--) {
      const hit = lookup(this.py, parts.slice(0, i).join('.'));
      if (hit) return hit;
    }
    return undefined;
  }

  /** `path` is a Go import path like "github.com/stripe/stripe-go/v76/customer". */
  matchGoImport(path: string): Vendor | undefined {
    const parts = path.split('/');
    for (let i = parts.length; i > 0; i--) {
      const hit = lookup(this.go, parts.slice(0, i).join('/'));
      if (hit) return hit;
    }
    return undefined;
  }

  matchEnv(name: string): Vendor | undefined {
    return lookup(this.env, name);
  }

  /**
   * True when `domain` (registrable, e.g. "stripe.com") belongs to a single known vendor.
   * Used to keep vendor-owned hosts we don't list (js.stripe.com, status pages…) out of the
   * "unknown domains" list. Shared clouds (amazonaws.com, googleapis.com…) never count.
   */
  ownsDomain(domain: string): boolean {
    if (!this.vendorDomains) {
      this.vendorDomains = new Set();
      for (const v of this.vendors) {
        for (const h of v.hosts ?? []) {
          const d = registrableDomain(h.replace(/^\*\./, ''));
          if (!SHARED_DOMAINS.has(d)) this.vendorDomains.add(d);
        }
      }
    }
    return this.vendorDomains.has(domain.toLowerCase());
  }
  private vendorDomains?: Set<string>;

  matchHost(host: string): Vendor | undefined {
    const h = host.toLowerCase().replace(/\.$/, '');
    const exact = this.hostExact.get(h);
    if (exact) return exact;
    for (const { s, v } of this.hostSuffix) if (h === s || h.endsWith(`.${s}`)) return v;
    for (const { re, v } of this.hostRegex) if (re.test(h)) return v;
    return undefined;
  }
}

/** "@scope/pkg/sub" → "@scope/pkg", "pkg/sub" → "pkg". Returns undefined for relative/absolute/builtin specs. */
export function jsPackageName(spec: string): string | undefined {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('#')) return undefined;
  if (spec.startsWith('~/') || spec.startsWith('@/')) return undefined; // common path aliases
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0];
}

export function buildCatalog(extra: Vendor[] = [], ignore: string[] = []): Catalog {
  const merged = new Map<string, Vendor>();
  for (const v of VENDORS) merged.set(v.id, v);
  for (const v of extra) {
    const base = merged.get(v.id);
    merged.set(v.id, base ? mergeVendor(base, v) : { ...v, category: v.category ?? 'other', paid: v.paid ?? true });
  }
  for (const id of ignore) merged.delete(id);
  // User-defined vendors go first so their patterns win ties with the built-in catalog.
  const userIds = new Set(extra.map((v) => v.id));
  const ordered = [...merged.values()].sort((a, b) => Number(userIds.has(b.id)) - Number(userIds.has(a.id)));
  return new Catalog(ordered);
}

function mergeVendor(base: Vendor, over: Partial<Vendor>): Vendor {
  const packages = { ...base.packages };
  for (const [eco, names] of Object.entries(over.packages ?? {}) as [Ecosystem, string[]][]) {
    packages[eco] = [...new Set([...(packages[eco] ?? []), ...names])];
  }
  return {
    ...base,
    ...over,
    packages,
    env: [...new Set([...(base.env ?? []), ...(over.env ?? [])])],
    hosts: [...new Set([...(base.hosts ?? []), ...(over.hosts ?? [])])],
  } as Vendor;
}

export { VENDORS };
