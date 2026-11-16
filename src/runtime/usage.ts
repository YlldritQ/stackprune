import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Catalog } from '../catalog/index.js';
import type { RuntimeUsage } from '../types.js';

/**
 * One line of a usage file. Written by the stackprune runtime probe, or by anything else
 * (egress proxy logs, OpenTelemetry exporters, a cron over your gateway logs).
 */
export interface UsageRecord {
  /** End of the aggregation window (ISO). */
  ts: string;
  /** Start of the aggregation window (ISO). Defaults to ts. */
  from?: string;
  app?: string;
  /** Vendor id, if the producer already knows it. Otherwise it's derived from `host`. */
  vendor?: string;
  host?: string;
  calls: number;
  errors?: number;
}

export interface UsageData {
  byVendor: Map<string, RuntimeUsage>;
  unknownHosts: Map<string, number>;
  window?: { from: string; to: string };
  /** App names seen in the records. */
  apps: Set<string>;
  /** True when some records carry no app name (they're assumed to cover every target). */
  anonymous: boolean;
}

function listFiles(p: string): string[] {
  if (!existsSync(p)) throw new Error(`Usage path not found: ${p}`);
  if (statSync(p).isDirectory()) {
    return readdirSync(p)
      .filter((f) => f.endsWith('.jsonl') || f.endsWith('.ndjson'))
      .map((f) => join(p, f));
  }
  return [p];
}

export function loadUsage(paths: string[], catalog: Catalog): UsageData {
  const byVendor = new Map<string, RuntimeUsage>();
  const unknownHosts = new Map<string, number>();
  const apps = new Set<string>();
  let anonymous = false;
  let from: string | undefined;
  let to: string | undefined;

  for (const file of paths.flatMap(listFiles)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r: UsageRecord;
      try {
        r = JSON.parse(line) as UsageRecord;
      } catch {
        continue;
      }
      if (typeof r.calls !== 'number' || !r.ts) continue;
      if (r.app) apps.add(r.app);
      else anonymous = true;
      const start = r.from ?? r.ts;
      if (!from || start < from) from = start;
      if (!to || r.ts > to) to = r.ts;
      const vendor = r.vendor && catalog.byId.has(r.vendor) ? r.vendor : r.host ? catalog.matchHost(r.host)?.id : undefined;
      if (!vendor) {
        if (r.host) unknownHosts.set(r.host, (unknownHosts.get(r.host) ?? 0) + r.calls);
        continue;
      }
      let u = byVendor.get(vendor);
      if (!u) byVendor.set(vendor, (u = { calls: 0, errors: 0, hosts: [] }));
      u.calls += r.calls;
      u.errors += r.errors ?? 0;
      if (r.host && !u.hosts.includes(r.host)) u.hosts.push(r.host);
      if (r.calls > 0) {
        if (!u.firstSeen || start < u.firstSeen) u.firstSeen = start;
        if (!u.lastSeen || r.ts > u.lastSeen) u.lastSeen = r.ts;
      }
    }
  }
  return { byVendor, unknownHosts, window: from && to ? { from, to } : undefined, apps, anonymous };
}
