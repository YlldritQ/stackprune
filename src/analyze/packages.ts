import type { Catalog } from '../catalog/index.js';
import type { UsageData } from '../runtime/usage.js';
import type { TargetScan } from '../scan/index.js';
import type { PackageUse } from '../scan/packages.js';
import type { Duplicate, Ecosystem, PurposeGroup, UnusedPackage } from '../types.js';

export interface PackageAnalysis {
  unused: UnusedPackage[];
  duplicates: Duplicate[];
  declared: number;
}

const DAY = 86_400_000;

/** Packages that, once loaded in production, show we can see node_modules (not a fully bundled app). */
const MIN_LOADED_FOR_RUNTIME = 5;

export function analyzePackages(input: {
  scans: TargetScan[];
  uses: Map<string, PackageUse[]>; // target name → package uses
  catalog: Catalog;
  purposes: PurposeGroup[];
  usage?: UsageData;
}): PackageAnalysis {
  const { scans, uses, catalog, purposes, usage } = input;
  const scanByName = new Map(scans.map((s) => [s.target.name, s]));
  const unusedByKey = new Map<string, UnusedPackage>();
  let declared = 0;

  const addUnused = (u: PackageUse, target: string, reason: string, runtime = false) => {
    const t = scanByName.get(target);
    const key = `${u.ecosystem}:${u.name}:${runtime ? 'rt' : 'st'}`;
    let entry = unusedByKey.get(key);
    if (!entry) {
      entry = { ecosystem: u.ecosystem, name: u.name, dev: u.dev, confidence: u.confidence, where: [], reason, runtime: runtime || undefined };
      unusedByKey.set(key, entry);
    }
    if (u.confidence === 'high') entry.confidence = 'high';
    if (!u.dev) entry.dev = false;
    entry.where.push({ target, group: t?.target.group, manifest: u.manifest, line: u.line });
  };

  for (const [target, list] of uses) {
    declared += list.length;
    const loaded = usage?.packagesByApp.get(target);
    const runtimeDays = usage?.window ? Math.max(1, Math.round((Date.parse(usage.window.to) - Date.parse(usage.window.from)) / DAY)) : 0;
    for (const u of list) {
      // Paid vendors are reported as integrations, not here.
      if (catalog.matchPackage(u.ecosystem, u.name)) continue;
      if (!u.used) {
        addUnused(u, target, 'Declared but never imported, run or configured');
      } else if (loaded && loaded.size >= MIN_LOADED_FOR_RUNTIME && u.ecosystem === 'npm' && !u.dev && u.usedBy === 'import' && !loaded.has(u.name)) {
        addUnused(u, target, `Imported in ${u.files.length} file${u.files.length === 1 ? '' : 's'}, but never loaded in production (${runtimeDays} day${runtimeDays === 1 ? '' : 's'} of data)`, true);
      }
    }
  }

  const unused = [...unusedByKey.values()].sort(
    (a, b) => Number(a.confidence === 'low') - Number(b.confidence === 'low') || Number(a.dev) - Number(b.dev) || Number(!!a.runtime) - Number(!!b.runtime) || a.name.localeCompare(b.name),
  );

  return { unused, duplicates: findDuplicates(uses, purposes, scanByName), declared };
}

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

function findDuplicates(uses: Map<string, PackageUse[]>, purposes: PurposeGroup[], scanByName: Map<string, TargetScan>): Duplicate[] {
  // app → ecosystem:package → { files, targets }
  const byApp = new Map<string, Map<string, { files: Set<string>; targets: Set<string>; eco: Ecosystem }>>();
  for (const [target, list] of uses) {
    const app = scanByName.get(target)?.target.group ?? target;
    let m = byApp.get(app);
    if (!m) byApp.set(app, (m = new Map()));
    for (const u of list) {
      if (!u.used) continue;
      const key = `${u.ecosystem}:${u.name}`;
      let e = m.get(key);
      if (!e) m.set(key, (e = { files: new Set(), targets: new Set(), eco: u.ecosystem }));
      for (const f of u.files) e.files.add(`${target}:${f}`);
      e.targets.add(target);
    }
  }

  const out: Duplicate[] = [];
  for (const [app, pkgs] of byApp) {
    for (const group of purposes) {
      const families: Duplicate['families'] = [];
      for (const fam of group.families) {
        const members = [...pkgs.entries()].filter(([key, e]) => e.eco === group.ecosystem && fam.packages.some((p) => matches(p, key.slice(key.indexOf(':') + 1))));
        if (!members.length) continue;
        const files = new Set<string>();
        const targets = new Set<string>();
        for (const [, e] of members) {
          e.files.forEach((f) => files.add(f));
          e.targets.forEach((t) => targets.add(t));
        }
        families.push({ name: fam.name, packages: members.map(([k]) => k.slice(k.indexOf(':') + 1)).sort(), files: files.size, targets: [...targets].sort() });
      }
      if (families.length >= 2) {
        families.sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
        out.push({ group: group.id, label: group.label, app, note: group.note, families });
      }
    }
  }
  return out.sort((a, b) => b.families.length - a.families.length || a.app.localeCompare(b.app) || a.label.localeCompare(b.label));
}
