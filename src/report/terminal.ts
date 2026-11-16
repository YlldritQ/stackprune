import type { Integration, ScanResult, Verdict } from '../types.js';
import { costOf, money, summarize, targetsOf } from './format.js';

const useColor = !process.env.NO_COLOR && (process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== '0' : !!process.stdout.isTTY);
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const red = c('31');
const yellow = c('33');
const green = c('32');
const cyan = c('36');
const magenta = c('35');

const SECTION: Record<Verdict, { title: string; hint: string; color: (s: string) => string; mark: string }> = {
  cut: { title: 'CUT', hint: 'integrations nothing uses', color: red, mark: '✂' },
  review: { title: 'REVIEW', hint: 'integrations where something looks off', color: yellow, mark: '?' },
  keep: { title: 'KEEP', hint: 'in use', color: green, mark: '✓' },
};

function pad(s: string, n: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length > n) return `${visible.slice(0, n - 1)}…`;
  return s + ' '.repeat(n - visible.length);
}

function row(i: Integration, currency: string, width: number): string[] {
  const nameW = 22;
  const catW = 15;
  const whereW = 26;
  const costW = 11;
  void width; // the reason is the last column: let it wrap instead of truncating it
  const [first = '', ...rest] = i.reasons;
  const lines = [`  ${pad(bold(i.vendor.name), nameW)} ${pad(dim(i.vendor.category), catW)} ${pad(targetsOf(i), whereW)} ${pad(costOf(i, currency), costW)} ${first}`];
  const indent = ' '.repeat(2 + nameW + catW + whereW + costW + 4);
  for (const r of rest) {
    const isAI = r.startsWith('Added in an AI-assisted');
    lines.push(`${indent}${dim('↳')} ${isAI ? magenta(r) : dim(r)}`);
  }
  return lines;
}

export function renderTerminal(r: ScanResult, opts: { all?: boolean; width?: number } = {}): string {
  const width = opts.width ?? Math.min(process.stdout.columns || 140, 160);
  const s = summarize(r);
  const out: string[] = [];
  const repoCount = r.targets.length;
  const highUnused = r.unusedPackages.filter((u) => u.confidence === 'high');
  const lowUnused = r.unusedPackages.filter((u) => u.confidence === 'low');
  const aiPkgs = r.unusedPackages.filter((u) => u.introducedWithAI).length;

  out.push('');
  out.push(
    `${bold('stackprune')} ${dim('·')} ${repoCount} ${repoCount === 1 ? 'repo' : 'repos'} ${dim('·')} ${s.total} integrations ${dim('·')} ${r.packageStats.declared} dependencies` +
      (r.usageWindow ? dim(` · runtime data ${r.usageWindow.from.slice(0, 10)} → ${r.usageWindow.to.slice(0, 10)}`) : ''),
  );
  const counts = `${red(`${s.byVerdict.cut} cut`)}   ${yellow(`${s.byVerdict.review} review`)}   ${green(`${s.byVerdict.keep} keep`)}`;
  const savings = s.savingsCut || s.savingsReview ? `   ${dim('│')}   potential savings ${bold(money(s.savingsCut, r.currency))}/mo${s.savingsReview ? dim(` (+${money(s.savingsReview, r.currency)}/mo under review)`) : ''}` : '';
  out.push(`  integrations  ${counts}${savings}`);
  out.push(`  packages      ${red(`${highUnused.length} unused`)}${lowUnused.length ? dim(` (+${lowUnused.length} to double-check)`) : ''}   ${yellow(`${r.duplicates.length} duplicate${r.duplicates.length === 1 ? '' : 's'}`)}`);
  const ai = s.aiIntroduced + aiPkgs;
  if (ai) out.push(`  ${magenta(`${ai} added in AI-assisted commits`)}${s.aiIntroducedUnused + aiPkgs ? magenta(` — ${s.aiIntroducedUnused + aiPkgs} of them unused`) : ''}`);

  for (const verdict of ['cut', 'review'] as Verdict[]) {
    const items = r.integrations.filter((i) => i.verdict === verdict);
    if (!items.length) continue;
    const sec = SECTION[verdict];
    out.push('');
    out.push(`${sec.color(bold(`${sec.mark} ${sec.title}`))} ${dim(`— ${sec.hint}`)}`);
    for (const i of items) out.push(...row(i, r.currency, width));
  }

  if (r.unusedPackages.length) {
    const shown = opts.all ? r.unusedPackages : highUnused;
    out.push('');
    out.push(`${red(bold('▢ UNUSED PACKAGES'))} ${dim('— declared, but nothing imports, runs or configures them')}`);
    for (const u of shown) {
      const where = u.where.map((w) => `${w.target}${w.manifest !== 'package.json' && w.manifest !== 'requirements.txt' && w.manifest !== 'go.mod' ? `/${w.manifest}` : ''}`);
      const tags = [u.dev ? 'dev' : '', u.confidence === 'low' ? 'check' : '', u.runtime ? 'prod data' : ''].filter(Boolean).join(', ');
      const added = u.introducedAt ? `added ${u.introducedAt.slice(0, 10)}${u.introducedBy ? ` by ${u.introducedBy}` : ''}` : '';
      const ai = u.introducedWithAI ? magenta(` · AI: ${u.introducedWithAI}`) : '';
      out.push(`  ${pad(bold(u.name), 34)} ${pad(where.join(', '), 34)} ${pad(dim(tags), 16)} ${dim(added)}${ai}${u.runtime ? `\n${' '.repeat(88)}${dim('↳ ' + u.reason)}` : ''}`);
    }
    if (!opts.all && lowUnused.length) out.push(dim(`  + ${lowUnused.length} more to double-check (dev tooling, plugins, native modules): use --all`));
  }

  if (r.duplicates.length) {
    out.push('');
    out.push(`${yellow(bold('⇄ DUPLICATES'))} ${dim('— different libraries doing the same job in one app')}`);
    for (const d of r.duplicates) {
      out.push(`  ${bold(d.label)} ${dim(`in ${d.app}`)}`);
      const [keep, ...rest] = d.families;
      for (const f of d.families) {
        const files = `${f.files} file${f.files === 1 ? '' : 's'}`;
        const ai = f.introducedWithAI ? magenta(` · AI: ${f.introducedWithAI}${f.introducedAt ? ` ${f.introducedAt.slice(0, 10)}` : ''}`) : '';
        out.push(`    ${f === keep ? green('●') : dim('○')} ${pad(f.name, 22)} ${pad(files, 10)} ${dim(f.packages.join(', '))}${ai}`);
      }
      const move = rest.reduce((n, f) => n + f.files, 0);
      out.push(dim(`    → pick one. Moving everything onto ${keep!.name} (most used) touches ${move} file${move === 1 ? '' : 's'}${d.note ? `. ${d.note}` : ''}`));
    }
  }

  const keep = r.integrations.filter((i) => i.verdict === 'keep');
  if (keep.length) {
    out.push('');
    out.push(`${green(bold('✓ KEEP'))} ${dim('— integrations in use')}`);
    if (opts.all) for (const i of keep) out.push(...row(i, r.currency, width));
    else out.push(`  ${keep.map((i) => i.vendor.name).join(dim(' · '))}`);
  }

  if (r.unmatchedSpend.length) {
    const top = r.unmatchedSpend.slice(0, opts.all ? 100 : 12);
    out.push('');
    out.push(`${cyan(bold('€ PAID, NOT RECOGNISED'))} ${dim('— payments in your billing export that match no known integration')}`);
    for (const p of top) out.push(`  ${pad(bold(p.payee), 34)} ${pad(`${money(p.monthly, p.currency)}/mo`, 14)} ${dim(`${p.payments} payment${p.payments === 1 ? '' : 's'}`)}`);
    if (r.unmatchedSpend.length > top.length) out.push(dim(`  … ${r.unmatchedSpend.length - top.length} more (use --all)`));
    out.push(dim('  Map them in stackprune.yml: `integrations: { <id>: { aliases: ["PAYEE NAME"] } }`, or `kind: tool` for things people use directly.'));
  }

  if (r.unknownHosts.length) {
    const top = r.unknownHosts.slice(0, opts.all ? 50 : 10);
    out.push('');
    out.push(`${cyan(bold('◌ UNKNOWN'))} ${dim('— external domains in code that match no known vendor')}`);
    for (const h of top) {
      const where = h.targets.length <= 3 ? h.targets.join(', ') : `${h.targets.slice(0, 3).join(', ')} +${h.targets.length - 3}`;
      const calls = h.calls ? `${h.calls.toLocaleString('en-US')} calls` : `${h.files} file${h.files === 1 ? '' : 's'}`;
      out.push(`  ${pad(bold(h.domain), 28)} ${pad(calls, 12)} ${pad(where, 30)} ${dim(pad(h.hosts.join(', '), Math.max(20, width - 76)))}`);
    }
    if (r.unknownHosts.length > top.length) out.push(dim(`  … ${r.unknownHosts.length - top.length} more (use --all)`));
    out.push(dim('  Track the real ones by adding them under `vendors:` in stackprune.yml; hide your own domains with `ignoreHosts:`.'));
  }

  if (r.warnings.length) {
    out.push('');
    for (const w of r.warnings.slice(0, 10)) out.push(yellow(`! ${w}`));
    if (r.warnings.length > 10) out.push(dim(`  … ${r.warnings.length - 10} more warnings`));
  }

  const tips: string[] = [];
  if (s.unpricedPaid) tips.push(`${s.unpricedPaid} paid integration${s.unpricedPaid === 1 ? ' has' : 's have'} no cost yet — add costs under \`integrations:\` in stackprune.yml, or pass a billing export with \`--billing payments.csv\`.`);
  if (!r.usageWindow) tips.push('Static scan only. Run the production probe (`node --import stackprune/register`) and pass `--usage .stackprune` to find code that is imported but never runs.');
  if (tips.length) {
    out.push('');
    for (const t of tips) out.push(dim(`• ${t}`));
  }
  out.push('');
  return out.join('\n');
}
