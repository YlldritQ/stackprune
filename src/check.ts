import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { buildCatalog } from './catalog/index.js';
import { findConfig, loadConfig } from './config.js';
import { scan } from './index.js';
import { addWorktree, gitPrefix, gitTopLevel, mergeBase } from './scan/git.js';
import type { Config, Integration } from './types.js';

export interface CheckResult {
  base: string;
  added: Integration[];
  removed: { id: string; name: string; category: string }[];
  /** Newly added integrations that break the policy in config.check. */
  violations: { integration: Integration; problems: string[] }[];
  /** Integrations unused on the PR branch (all of them, not only new ones). */
  unused: Integration[];
  /** Dependencies this branch adds, with what's wrong with them (if anything). */
  addedPackages: { name: string; ecosystem: string; dev: boolean; unused: boolean; duplicateOf?: { label: string; existing: string[] }; introducedWithAI?: string }[];
  /** Policy problems with added packages (check.blockUnusedPackages / check.blockDuplicates). */
  packageViolations: string[];
}

/**
 * Compare integrations on the working tree against a base ref.
 * Meant for pull requests: "this PR adds Bugsnag, you already use Sentry, and nobody owns it".
 */
export async function check(opts: { path?: string; base: string; configPath?: string }): Promise<CheckResult> {
  // realpath: git reports resolved paths (/private/var/… on macOS), so compare like with like.
  const dir = realpathSync(resolve(opts.path ?? '.'));
  const top = await gitTopLevel(dir);
  if (!top) throw new Error(`${dir} is not inside a git repository`);
  const sub = await gitPrefix(dir);
  const configPath = opts.configPath ?? findConfig([dir, top]);
  const config: Config = loadConfig(configPath);

  const baseRef = (await mergeBase(top, opts.base, 'HEAD')) ?? opts.base;
  // Compare committed trees on both sides, so local untracked files (.env, scratch code) don't show up as "added".
  const tmp = mkdtempSync(join(tmpdir(), 'stackprune-'));
  const baseWt = await addWorktree(top, baseRef, join(tmp, 'base', basename(top)));
  const headWt = await addWorktree(top, 'HEAD', join(tmp, 'head', basename(top)));
  try {
    const name = basename(dir);
    const head = await scan({ config, targets: [{ name, root: join(headWt.path, sub) }] });
    const before = await scan({ config, targets: [{ name, root: join(baseWt.path, sub) }], git: false });

    const live = (i: Integration) => i.status !== 'dev-only';
    const beforeIds = new Set(before.integrations.filter(live).map((i) => i.vendor.id));
    const headIds = new Set(head.integrations.filter(live).map((i) => i.vendor.id));
    const added = head.integrations.filter((i) => live(i) && !beforeIds.has(i.vendor.id));
    const catalog = buildCatalog(config.vendors, config.ignore);
    const removed = [...beforeIds]
      .filter((id) => !headIds.has(id))
      .map((id) => catalog.byId.get(id)!)
      .filter(Boolean)
      .map((v) => ({ id: v.id, name: v.name, category: v.category }));

    const violations: CheckResult['violations'] = [];
    for (const i of added) {
      const problems: string[] = [];
      const meta = config.integrations?.[i.vendor.id];
      if (config.check?.requireOwner && !meta?.owner) problems.push('no owner');
      if (config.check?.requirePurpose && !meta?.purpose) problems.push('no purpose');
      if (problems.length) violations.push({ integration: i, problems });
    }
    // Packages: what does this branch add, and is any of it dead weight or a second library for the same job?
    const key = (eco: string, n: string) => `${eco}:${n}`;
    const beforePkgs = new Set(before.scans.flatMap((s) => s.facts.declared.map((d) => key(d.ecosystem, d.name))));
    const headDeclared = head.scans.flatMap((s) => s.facts.declared);
    const unusedHead = new Map(head.unusedPackages.filter((u) => !u.runtime).map((u) => [key(u.ecosystem, u.name), u]));
    const seenPkg = new Set<string>();
    const addedPackages: CheckResult['addedPackages'] = [];
    for (const d of headDeclared) {
      const k = key(d.ecosystem, d.name);
      if (beforePkgs.has(k) || seenPkg.has(k) || d.name.startsWith('@types/')) continue;
      seenPkg.add(k);
      const dup = head.duplicates.find((x) => x.families.some((f) => f.packages.includes(d.name)));
      const others = dup?.families.filter((f) => !f.packages.includes(d.name)).map((f) => f.name);
      addedPackages.push({
        name: d.name,
        ecosystem: d.ecosystem,
        dev: d.dev,
        unused: unusedHead.has(k),
        duplicateOf: dup && others?.length ? { label: dup.label, existing: others } : undefined,
        introducedWithAI: unusedHead.get(k)?.introducedWithAI,
      });
    }
    const packageViolations: string[] = [];
    for (const p of addedPackages) {
      if (config.check?.blockUnusedPackages && p.unused) packageViolations.push(`${p.name} is added but never used`);
      if (config.check?.blockDuplicates && p.duplicateOf) packageViolations.push(`${p.name} duplicates ${p.duplicateOf.existing.join(', ')} (${p.duplicateOf.label})`);
    }

    return { base: opts.base, added, removed, violations, unused: head.integrations.filter((i) => i.verdict === 'cut'), addedPackages, packageViolations };
  } finally {
    await baseWt.remove();
    await headWt.remove();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function renderCheckMarkdown(r: CheckResult): string {
  const out: string[] = ['<!-- stackprune -->', '### stackprune'];
  const flagged = r.addedPackages.filter((p) => p.unused || p.duplicateOf);
  if (!r.added.length && !r.removed.length && !flagged.length) {
    out.push('', `No integrations added or removed compared to \`${r.base}\`, and no unused or duplicate packages added.`);
  }
  if (flagged.length) {
    out.push('', `**This PR adds ${flagged.length} package${flagged.length === 1 ? '' : 's'} worth a second look:**`, '');
    for (const p of flagged) {
      const why = [p.unused ? 'nothing uses it' : '', p.duplicateOf ? `you already use ${p.duplicateOf.existing.join(', ')} for ${p.duplicateOf.label.toLowerCase()}` : ''].filter(Boolean).join('; ');
      out.push(`- \`${p.name}\`${p.dev ? ' (dev)' : ''}: ${why}${p.introducedWithAI ? ` · added with ${p.introducedWithAI}` : ''}`);
    }
    if (r.packageViolations.length) out.push('', `⚠️ Blocked by policy: ${r.packageViolations.join('; ')}`);
  }
  if (r.added.length) {
    out.push('', `**This PR adds ${r.added.length} integration${r.added.length === 1 ? '' : 's'}:**`, '');
    out.push('| Integration | Category | Status | Notes |', '|---|---|---|---|');
    for (const i of r.added) {
      const notes = [...i.reasons];
      const v = r.violations.find((x) => x.integration === i);
      if (v) notes.unshift(`⚠️ ${v.problems.join(', ')} — add it under \`integrations.${i.vendor.id}\` in stackprune.yml`);
      out.push(`| **${i.vendor.name}** | ${i.vendor.category} | ${i.status} | ${notes.join(' · ').replace(/\|/g, '\\|')} |`);
    }
  }
  if (r.removed.length) {
    out.push('', `**Removed:** ${r.removed.map((x) => x.name).join(', ')} 🎉`);
  }
  if (r.unused.length) {
    out.push('', `<details><summary>${r.unused.length} integration${r.unused.length === 1 ? ' is' : 's are'} installed or configured but unused in this repo</summary>`, '');
    for (const i of r.unused) out.push(`- **${i.vendor.name}** — ${i.reasons[0] ?? ''}`);
    out.push('', '</details>');
  }
  return `${out.join('\n')}\n`;
}

export function renderCheckTerminal(r: CheckResult): string {
  const lines: string[] = [''];
  const flagged = r.addedPackages.filter((p) => p.unused || p.duplicateOf);
  if (!r.added.length && !r.removed.length && !flagged.length) lines.push(`No integrations added or removed compared to ${r.base}, and no unused or duplicate packages added.`);
  for (const p of flagged) {
    const why = [p.unused ? 'unused' : '', p.duplicateOf ? `duplicates ${p.duplicateOf.existing.join(', ')} (${p.duplicateOf.label})` : ''].filter(Boolean).join('; ');
    lines.push(`+ package ${p.name}: ${why}`);
  }
  for (const v of r.packageViolations) lines.push(`  [policy] ${v}`);
  for (const i of r.added) {
    const v = r.violations.find((x) => x.integration === i);
    lines.push(`+ ${i.vendor.name} (${i.vendor.category}) — ${i.reasons.join(' · ')}${v ? `  [policy: ${v.problems.join(', ')}]` : ''}`);
  }
  for (const x of r.removed) lines.push(`- ${x.name} (${x.category})`);
  if (r.unused.length) lines.push('', `${r.unused.length} unused in this repo: ${r.unused.map((i) => i.vendor.name).join(', ')}`);
  lines.push('');
  return lines.join('\n');
}
