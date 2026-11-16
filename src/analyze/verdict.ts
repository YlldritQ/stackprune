import type { VendorSpend } from '../billing.js';
import type { Catalog } from '../catalog/index.js';
import type { UsageData } from '../runtime/usage.js';
import type { TargetScan } from '../scan/index.js';
import { isEnvFile } from '../scan/walk.js';
import type { Category, Config, CostEntry, Integration, IntegrationConfig, Status, TargetHit, Verdict } from '../types.js';

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

/** Set by the hosting platform itself, so no env file in the repo is expected to define them. */
const PLATFORM_VAR = /^(VERCEL|NETLIFY|RENDER|RAILWAY|FLY|HEROKU|CF_PAGES|GITHUB|GITLAB|CI|AWS_LAMBDA|AWS_EXECUTION_ENV|K_SERVICE|FUNCTION_|WEBSITE_|AZURE_FUNCTIONS|EAS_BUILD|EXPO_PUBLIC_EAS)(_|$)/;

const isDotenv = (file: string) => isEnvFile(file.split('/').pop() ?? file);

function targetStatus(hit: TargetHit, scan: TargetScan | undefined): Status {
  const prod = hit.evidence.filter((e) => !e.dev);
  if (!prod.length) return 'dev-only';
  // An env var read in code means the code talks to the service, SDK or not.
  if (prod.some((e) => e.kind === 'import' || e.kind === 'host' || e.kind === 'env-referenced')) return 'active';
  const manifests = prod.filter((e) => e.kind === 'manifest');
  // We can't see imports for every ecosystem (PHP, .NET). Don't call those unused.
  if (manifests.some((e) => e.ecosystem && !scan?.importAware.has(e.ecosystem))) return 'active';
  if (manifests.length) return 'unused';
  return 'config-only';
}

const RANK: Record<Status, number> = { active: 4, tool: 4, dormant: 3, unused: 2, 'config-only': 1, absent: 0, 'dev-only': 0 };

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
  /** Monthly spend per vendor id, from billing exports. */
  spend?: Map<string, VendorSpend>;
  currency?: string;
  now?: Date;
}

function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

export function analyze({ scans, catalog, config, usage, spend, currency = 'USD', now = new Date() }: AnalyzeInput): Integration[] {
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
    const cost = costFor(id, meta, spend);
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
        const files = [...new Set(prod.map((e) => e.file))];
        const elsewhere = files.filter((f) => !isDotenv(f));
        if (elsewhere.length) {
          // CI secrets, Dockerfile build args, deploy configs: used by the pipeline, not the app.
          reasons.push(`Only set in CI / deploy config (${list(elsewhere)}), not read by app code`);
        } else {
          verdict = 'cut';
          reasons.push(`Listed in ${list(files)} (${list(prod.map((e) => e.detail))}) but nothing reads it`);
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
        const direct = prod.filter((e) => (e.kind === 'import' && !e.via) || e.kind === 'host');
        const via = prod.filter((e) => e.kind === 'import' && e.via);
        if (direct.length) reasons.push(`Used in ${n} file${n === 1 ? '' : 's'} across ${list(where('active'))}`);
        else if (via.length) reasons.push(`Used through ${list(via.map((e) => e.via!))}, not imported directly`);
        else reasons.push(`Code reads its settings (${list(envRefs.map((e) => e.detail))}) in ${n} file${n === 1 ? '' : 's'}; no SDK, so it likely calls the API directly`);
        if (u?.calls) reasons.push(`${u.calls.toLocaleString('en-US')} calls at runtime`);

        // Wired up, but maybe never switched on: the SDK is imported, but nothing in the repo sets its key.
        const sdkImported = prod.some((e) => e.kind === 'import' && !e.via);
        const hasHost = prod.some((e) => e.kind === 'host');
        const readEnv = [...new Set(envRefs.map((e) => e.detail))].filter((e) => !PLATFORM_VAR.test(e));
        const declaredAnywhere = (name: string) => hits.some((h) => scanByTarget.get(h.target)?.facts.declaredEnv.has(name));
        const envFilesSeen = hits.every((h) => (scanByTarget.get(h.target)?.facts.envFiles ?? 0) > 0);
        if (sdkImported && !hasHost && readEnv.length && envFilesSeen && !readEnv.some(declaredAnywhere)) {
          reasons.push(`Needs ${list(readEnv)}, which no env file in the repo sets. If your hosting dashboard doesn't set it either, this is switched off`);
          verdict = 'review';
        }
        // The file that wires it up calls itself a test / spike / PoC.
        const marked = prod.find((e) => e.kind === 'import' && e.marker);
        if (marked) {
          reasons.push(`${marked.file} describes itself as "${marked.marker}"`);
          verdict = 'review';
        }
        break;
      }
    }
    if (vendor.detected === 'sdk') {
      const pkg = prod.find((e) => e.kind === 'manifest')?.detail;
      reasons.push(`Not in the catalog: detected as a vendor SDK${pkg ? ` (${pkg})` : ''} from its credentials or API domain`);
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

  // Paid for, but no repo references it at all (from config costs or billing exports).
  const seen = new Set(out.map((i) => i.vendor.id));
  const paidIds = new Set<string>([
    ...Object.entries(config.integrations ?? {})
      .filter(([, m]) => m.kind === 'tool' || (typeof m.cost === 'number' ? m.cost > 0 : (m.cost?.monthly ?? 0) > 0))
      .map(([id]) => id),
    ...(spend?.keys() ?? []),
  ]);
  for (const id of paidIds) {
    if (seen.has(id) || config.ignore?.includes(id)) continue;
    const meta = config.integrations?.[id] ?? {};
    const s = spend?.get(id);
    const vendor = catalog.byId.get(id) ?? { id, name: meta.name ?? s?.payees[0] ?? id, category: 'other' as const, paid: true, detected: s ? ('billing' as const) : ('config' as const) };
    const cost = costFor(id, meta, spend);
    const amount = cost ? `${money(cost.monthly, cost.currency ?? currency)}/mo` : 'it';
    const reasons: string[] = [];
    let status: Status = 'absent';
    let verdict: Verdict;
    if (meta.kind === 'tool') {
      status = 'tool';
      verdict = 'keep';
      reasons.push('Used by people, not code (kind: tool), so the code scan doesn\'t judge it');
    } else if (cost?.source === 'billing') {
      verdict = 'review';
      reasons.push(`Billed ${amount} (${list(s?.payees ?? [])}) but no repo references it. If people use it directly (seats), mark it \`kind: tool\`; otherwise cancel it`);
    } else {
      verdict = 'cut';
      reasons.push(`You pay ${amount} but no repo references it: no package, import, env var or API host`);
    }
    out.push({ vendor, status, verdict, reasons, hits: [], codeFiles: 0, removalFiles: 0, overlapsWith: [], cost, owner: meta.owner, purpose: meta.purpose });
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

function costFor(id: string, meta: IntegrationConfig, spend?: Map<string, VendorSpend>): CostEntry | undefined {
  if (meta.cost !== undefined && meta.cost !== null) return typeof meta.cost === 'number' ? { monthly: meta.cost, source: 'config' } : { ...meta.cost, source: 'config' };
  const s = spend?.get(id);
  return s ? { monthly: s.monthly, currency: s.currency, source: 'billing', notes: s.payees.join(', ') } : undefined;
}
