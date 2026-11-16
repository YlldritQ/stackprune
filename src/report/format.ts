import type { Integration, ScanResult, Verdict } from '../types.js';

export const VERDICT_LABEL: Record<Verdict, string> = { cut: 'Cut', review: 'Review', keep: 'Keep' };

export function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

export function costOf(i: Integration, currency: string): string {
  if (!i.cost) return i.vendor.paid ? '?' : '–';
  if (i.cost.monthly === 0) return 'free';
  return `${money(i.cost.monthly, i.cost.currency ?? currency)}/mo`;
}

/** Targets where the integration lives, strongest usage first. */
export function targetsOf(i: Integration, max = 3): string {
  const score = (h: Integration['hits'][number]) =>
    h.evidence.some((e) => !e.dev && (e.kind === 'import' || e.kind === 'host')) ? 2 : h.evidence.some((e) => !e.dev && e.kind === 'manifest') ? 1 : 0;
  const names = [...new Set([...i.hits].sort((a, b) => score(b) - score(a)).map((h) => h.target))];
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

export interface Summary {
  total: number;
  byVerdict: Record<Verdict, number>;
  savingsCut: number;
  savingsReview: number;
  unpricedPaid: number;
  aiIntroduced: number;
  aiIntroducedUnused: number;
  overlaps: number;
}

export function summarize(r: ScanResult): Summary {
  const s: Summary = { total: r.integrations.length, byVerdict: { cut: 0, review: 0, keep: 0 }, savingsCut: 0, savingsReview: 0, unpricedPaid: 0, aiIntroduced: 0, aiIntroducedUnused: 0, overlaps: 0 };
  for (const i of r.integrations) {
    s.byVerdict[i.verdict]++;
    if (i.verdict === 'cut') s.savingsCut += i.cost?.monthly ?? 0;
    if (i.verdict === 'review') s.savingsReview += i.cost?.monthly ?? 0;
    if (!i.cost && i.vendor.paid && i.status !== 'dev-only') s.unpricedPaid++;
    if (i.introducedWithAI) {
      s.aiIntroduced++;
      if (i.verdict === 'cut') s.aiIntroducedUnused++;
    }
    if (i.overlapsWith.length) s.overlaps++;
  }
  return s;
}

export function evidenceSummary(i: Integration): string {
  const kinds = new Map<string, number>();
  for (const h of i.hits) for (const e of h.evidence) if (!e.dev) kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
  const label: Record<string, string> = { manifest: 'dep', import: 'import', 'env-declared': 'env', 'env-referenced': 'env ref', host: 'host' };
  return [...kinds.entries()].map(([k, n]) => `${n} ${label[k] ?? k}${n === 1 ? '' : 's'}`).join(', ') || 'dev only';
}
