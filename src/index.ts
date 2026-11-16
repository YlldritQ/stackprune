import { analyze } from './analyze/verdict.js';
import { buildCatalog, type Catalog } from './catalog/index.js';
import { findConfig, loadConfig } from './config.js';
import { isNoiseHost, registrableDomain } from './hosts.js';
import { loadUsage, type UsageData } from './runtime/usage.js';
import { gitInfoFor, isGitRepo } from './scan/git.js';
import { scanTarget, type Target, type TargetScan } from './scan/index.js';
import { resolveTargets } from './scan/targets.js';
import type { Config, ScanResult, UnknownHost } from './types.js';

export interface ScanOptions {
  /** Repos or folders to scan. Folders full of repos are expanded. Defaults to cwd. */
  paths?: string[];
  /** Explicit config. If omitted, `configPath` or an auto-discovered stackprune.yml is used. */
  config?: Config;
  configPath?: string;
  /** JSONL usage files or folders (from the runtime probe or your own exporter). */
  usage?: string[];
  /** Collect git history signals (introduced when/by whom/with which AI, last touched). Default true. */
  git?: boolean;
  /** Pre-resolved targets (skips path expansion). */
  targets?: Target[];
  now?: Date;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

export async function scan(opts: ScanOptions = {}): Promise<ScanResult & { catalog: Catalog; scans: TargetScan[] }> {
  const paths = opts.paths?.length ? opts.paths : ['.'];
  const configPath = opts.configPath ?? (opts.config ? undefined : findConfig(['.', ...paths]));
  const config = opts.config ?? loadConfig(configPath);
  const catalog = buildCatalog(config.vendors, config.ignore);
  const targets = opts.targets ?? resolveTargets(paths);

  const scans = targets.map((t) => scanTarget(t, catalog, { exclude: config.exclude }));
  const gitFlags = new Map<string, boolean>();

  if (opts.git !== false) {
    const jobs: { scan: TargetScan; id: string }[] = [];
    for (const s of scans) {
      const isGit = await isGitRepo(s.target.root);
      gitFlags.set(s.target.root, isGit);
      if (isGit) for (const id of s.hits.keys()) jobs.push({ scan: s, id });
    }
    await pool(jobs, 8, async ({ scan: s, id }) => {
      const hit = s.hits.get(id)!;
      hit.git = await gitInfoFor(s.target.root, hit.evidence);
    });
  }

  const usage: UsageData | undefined = opts.usage?.length ? loadUsage(opts.usage, catalog) : undefined;
  const integrations = analyze({ scans, catalog, config, usage, now: opts.now });

  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    targets: scans.map((s) => ({ name: s.target.name, group: s.target.group, root: s.target.root, files: s.files, git: gitFlags.get(s.target.root) ?? false })),
    integrations,
    unknownHosts: collectUnknownHosts(scans, usage, config.ignoreHosts).filter((h) => !catalog.ownsDomain(h.domain)),
    currency: config.currency ?? 'USD',
    usageWindow: usage?.window,
    warnings: scans.flatMap((s) => s.warnings),
    catalog,
    scans,
  };
}

function collectUnknownHosts(scans: TargetScan[], usage: UsageData | undefined, ignore: string[] = []): UnknownHost[] {
  const byDomain = new Map<string, { hosts: Set<string>; files: Set<string>; targets: Set<string>; calls: number }>();
  const get = (host: string) => {
    const d = registrableDomain(host);
    let e = byDomain.get(d);
    if (!e) byDomain.set(d, (e = { hosts: new Set(), files: new Set(), targets: new Set(), calls: 0 }));
    return e;
  };
  for (const s of scans) {
    for (const [host, files] of s.unknownHosts) {
      if (isNoiseHost(host, ignore)) continue;
      const e = get(host);
      e.hosts.add(host);
      e.targets.add(s.target.name);
      for (const f of files) e.files.add(`${s.target.name}:${f}`);
    }
  }
  for (const [host, calls] of usage?.unknownHosts ?? []) {
    if (isNoiseHost(host, ignore)) continue;
    const e = get(host);
    e.hosts.add(host);
    e.calls += calls;
  }
  return [...byDomain.entries()]
    .map(([domain, e]) => ({ domain, hosts: [...e.hosts].sort(), files: e.files.size, targets: [...e.targets].sort(), calls: usage ? e.calls : undefined }))
    .sort((a, b) => (b.calls ?? 0) - (a.calls ?? 0) || b.files - a.files || a.domain.localeCompare(b.domain));
}

export { analyze } from './analyze/verdict.js';
export { buildCatalog, Catalog, VENDORS } from './catalog/index.js';
export { findConfig, loadConfig } from './config.js';
export { loadUsage } from './runtime/usage.js';
export { resolveTargets } from './scan/targets.js';
export { scanTarget } from './scan/index.js';
export type * from './types.js';
