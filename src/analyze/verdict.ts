import type { Catalog } from '../catalog/index.js';
import type { UsageData } from '../runtime/usage.js';
import type { TargetScan } from '../scan/index.js';
import type { Category, Config, CostEntry, Integration, Status, TargetHit, Verdict } from '../types.js';

/** Categories where running two vendors side by side is usually redundant. */
export const OVERLAP_CATEGORIES = new Set<Category>([
  'error-tracking',
  'analytics',
  'apm',
  'logging',
  'feature-flags',
  'auth',
  'email',
  'sms',
  'push',
  'search',
  'maps',
  'support',
  'crm',
  'cms',
  'localization',
]);

const DAY = 86_400_000;

function targetStatus(hit: TargetHit, scan: TargetScan | undefined): Status {
  const prod = hit.evidence.filter((e) => !e.dev);
  if (!prod.length) return 'dev-only';
  if (prod.some((e) => e.kind === 'import' || e.kind === 'host')) return 'active';
  const manifests = prod.filter((e) => e.kind === 'manifest');
  // We can't see imports for every ecosystem (PHP, .NET). Don't call those unused.
  if (manifests.some((e) => e.ecosystem && !scan?.importAware.has(e.ecosystem))) return 'active';
  if (manifests.length) return 'unused';
  return 'config-only';
}

const RANK: Record<Status, number> = { active: 4, dormant: 3, unused: 2, 'config-only': 1, 'dev-only': 0 };

function list(items: string[], max = 3): string {
  const uniq = [...new Set(items)];
  return uniq.length <= max ? uniq.join(', ') : `${uniq.slice(0, max).join(', ')} +${uniq.length - max} more`;
}

function daysBetween(a: string | Date, b: string | Date): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / DAY);
}

export interface AnalyzeInput {
  scans: TargetScan[];
  catalog: Catalog;
  config: Config;
  usage?: UsageData;
  now?: Date;
}

export function analyze({ scans, catalog, config, usage, now = new Date() }: AnalyzeInput): Integration[] {
  const staleDays = config.staleDays ?? 365;
  const scanByTarget = new Map(scans.map((s) => [s.target.name, s]));
  const hitsByVendor = new Map<string, TargetHit[]>();
  for (const s of scans) {
    for (const [id, hit] of s.hits) {
      const arr = hitsByVendor.get(id) ?? [];
      arr.push(hit);
      hitsByVendor.set(id, arr);
    }
  }

  const out: Integration[] = [];
  for (const [id, hits] of hitsByVendor) {
    const vendor = catalog.byId.get(id);
    if (!vendor) continue;
    const meta = config.integrations?.[id] ?? {};
    const cost: CostEntry | undefined = typeof meta.cost === 'number' ? { monthly: meta.cost } : meta.cost;
    const reasons: string[] = [];

    const perTarget = hits.map((h) => ({ hit: h, status: targetStatus(h, scanByTarget.get(h.target)) }));
    let status: Status = perTarget.reduce<Status>((best, t) => (RANK[t.status] > RANK[best] ? t.status : best), 'dev-only');

    const all = hits.flatMap((h) => h.evidence);
    const prod = all.filter((e) => !e.dev);
    const codeFiles = new Set(
      hits.flatMap((h) => h.evidence.filter((e) => !e.dev && (e.kind === 'import' || e.kind === 'host' || e.kind === 'env-referenced')).map((e) => `${h.target}:${e.file}`)),
    ).size;
    const removalFiles = new Set(hits.flatMap((h) => h.evidence.map((e) => `${h.target}:${e.file}`))).size;
    const envRefs = prod.filter((e) => e.kind === 'env-referenced');

    // Git signals: earliest introduction, latest touch.
    const intro = hits
      .map((h) => h.git)
      .filter((g): g is NonNullable<typeof g> => !!g?.introducedAt)
      .sort((a, b) => a.introducedAt!.localeCompare(b.introducedAt!))[0];
    const lastTouchedAt = hits
      .map((h) => h.git?.lastTouchedAt)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);
    // Attribute AI only when the commit that first introduced the vendor credits an assistant.
    const introducedWithAI = intro?.introducedWithAI;

    // Runtime usage.
    const u = usage?.byVendor.get(id);
    const usageCovers = !!usage?.window && (usage.apps.size === 0 || usage.anonymous || hits.some((h) => usage.apps.has(h.target)));
    const probeable = (vendor.hosts?.length ?? 0) > 0;
    if (status === 'active' && usageCovers && probeable && (!u || u.calls === 0)) status = 'dormant';

    let verdict: Verdict = 'keep';
    const where = (s: Status) => perTarget.filter((t) => t.status === s).map((t) => t.hit.target);

    switch (status) {
      case 'unused': {
        verdict = 'cut';
        const pkgs = list(prod.filter((e) => e.kind === 'manifest').map((e) => e.detail));
        reasons.push(`Installed (${pkgs}) in ${list(where('unused'))} but never imported`);
        break;
      }
      case 'config-only': {
        const declaredIn = list(prod.filter((e) => e.kind === 'env-declared').map((e) => e.file));
        if (envRefs.length) {
          verdict = 'review';
          reasons.push(`Only read as env vars (${list(envRefs.map((e) => e.detail))}) — no SDK import or API host in code. Fine if a framework consumes them; otherwise dead config`);
        } else {
          verdict = 'cut';
          reasons.push(`Configured (${list(prod.map((e) => e.detail))} in ${declaredIn}) but nothing in code uses it`);
        }
        break;
      }
      case 'dormant': {
        verdict = 'review';
        const days = Math.max(1, daysBetween(usage!.window!.from, usage!.window!.to));
        reasons.push(`In code, but 0 calls in ${days} day${days === 1 ? '' : 's'} of runtime data`);
        break;
      }
      case 'dev-only':
        reasons.push('Only used in dev dependencies or tests');
        if (cost && cost.monthly > 0) verdict = 'review';
        break;
      case 'active': {
        const n = codeFiles;
        reasons.push(`Used in ${n} file${n === 1 ? '' : 's'} across ${list(where('active'))}`);
        if (u?.calls) reasons.push(`${u.calls.toLocaleString('en-US')} calls at runtime`);
        break;
      }
    }

    // Partial leftovers: active somewhere, dead weight elsewhere.
    if (status === 'active' || status === 'dormant') {
      const unusedIn = where('unused');
      if (unusedIn.length) reasons.push(`Installed but never imported in ${list(unusedIn)} — drop the dependency there`);
    }

    if (lastTouchedAt) {
      const age = daysBetween(lastTouchedAt, now);
      // Informational only: stable code (payments, auth) is often untouched for a long time.
      if (age > staleDays && (status === 'active' || status === 'dormant')) reasons.push(`Code using it untouched for ${age} days`);
    }
    if (introducedWithAI && intro?.introducedAt) {
      reasons.push(`Added in an AI-assisted commit (${introducedWithAI}) on ${intro.introducedAt.slice(0, 10)}`);
    }

    out.push({
      vendor,
      status,
      verdict,
      reasons,
      hits,
      codeFiles,
      removalFiles,
      overlapsWith: [],
      usage: u,
      cost,
      owner: meta.owner,
      purpose: meta.purpose,
      introducedWithAI,
      introducedAt: intro?.introducedAt,
      lastTouchedAt,
    });
  }

  // Overlap: two live vendors doing the same job inside the same app. An "app" is the folder
  // the repos were grouped under (e.g. api/ + web/ + mobile/ of one product), or the repo itself.
  const appsOf = (i: Integration) =>
    new Set(i.hits.filter((h) => h.evidence.some((e) => !e.dev && (e.kind === 'import' || e.kind === 'host' || e.kind === 'manifest'))).map((h) => h.group ?? h.target));
  const live = out.filter((i) => i.status === 'active' || i.status === 'dormant');
  for (const i of live) {
    if (!OVERLAP_CATEGORIES.has(i.vendor.category)) continue;
    const mine = appsOf(i);
    const same: Integration[] = [];
    const elsewhere: Integration[] = [];
    for (const o of live) {
      if (o === i || o.vendor.category !== i.vendor.category) continue;
      const shared = [...appsOf(o)].filter((a) => mine.has(a));
      (shared.length ? same : elsewhere).push(o);
    }
    if (same.length) {
      i.overlapsWith = same.map((o) => o.vendor.id);
      const perApp = [...mine]
        .map((a) => ({ app: a, others: same.filter((o) => appsOf(o).has(a)).map((o) => o.vendor.name) }))
        .filter((x) => x.others.length)
        .map((x) => `${list(x.others)} in ${x.app}`);
      i.reasons.push(`Overlaps with ${perApp.join('; ')} (${i.vendor.category})`);
      // Only something you pay for is worth a review; a free overlap is just a note.
      const costsMoney = i.cost ? i.cost.monthly > 0 : !!i.vendor.paid;
      if (i.verdict === 'keep' && costsMoney) i.verdict = 'review';
    } else if (elsewhere.length) {
      i.reasons.push(`Other apps use ${list(elsewhere.map((o) => o.vendor.name))} for ${i.vendor.category} — consolidation candidate`);
    }
  }

  for (const i of out) {
    const meta = config.integrations?.[i.vendor.id];
    if (meta?.keep) {
      i.verdict = 'keep';
      i.reasons.unshift('Marked keep in config');
    }
  }

  const order: Record<Verdict, number> = { cut: 0, review: 1, keep: 2 };
  return out.sort(
    (a, b) =>
      order[a.verdict] - order[b.verdict] ||
      (b.cost?.monthly ?? 0) - (a.cost?.monthly ?? 0) ||
      Number(b.vendor.paid ?? false) - Number(a.vendor.paid ?? false) ||
      a.vendor.name.localeCompare(b.vendor.name),
  );
}
