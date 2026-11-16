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
  cut: { title: 'CUT', hint: 'not used, safe to remove', color: red, mark: '✂' },
  review: { title: 'REVIEW', hint: 'used, but something looks off', color: yellow, mark: '?' },
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

  out.push('');
  out.push(`${bold('stackprune')} ${dim('·')} ${repoCount} ${repoCount === 1 ? 'repo' : 'repos'} ${dim('·')} ${s.total} integrations${r.usageWindow ? dim(` · runtime data ${r.usageWindow.from.slice(0, 10)} → ${r.usageWindow.to.slice(0, 10)}`) : ''}`);
  const counts = `${red(`${s.byVerdict.cut} cut`)}   ${yellow(`${s.byVerdict.review} review`)}   ${green(`${s.byVerdict.keep} keep`)}`;
  const savings = s.savingsCut || s.savingsReview ? `   ${dim('│')}   potential savings ${bold(money(s.savingsCut, r.currency))}/mo${s.savingsReview ? dim(` (+${money(s.savingsReview, r.currency)}/mo under review)`) : ''}` : '';
  out.push(`  ${counts}${savings}`);
  if (s.aiIntroduced) out.push(`  ${magenta(`${s.aiIntroduced} added in AI-assisted commits`)}${s.aiIntroducedUnused ? magenta(` — ${s.aiIntroducedUnused} of them unused`) : ''}`);

  for (const verdict of ['cut', 'review', 'keep'] as Verdict[]) {
    const items = r.integrations.filter((i) => i.verdict === verdict);
    if (!items.length) continue;
    const sec = SECTION[verdict];
    out.push('');
    out.push(`${sec.color(bold(`${sec.mark} ${sec.title}`))} ${dim(`— ${sec.hint}`)}`);
    for (const i of items) {
      const lines = row(i, r.currency, width);
      out.push(...(verdict === 'keep' && !opts.all ? lines.slice(0, 1) : lines));
    }
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
  if (s.unpricedPaid) tips.push(`${s.unpricedPaid} paid integration${s.unpricedPaid === 1 ? ' has' : 's have'} no cost yet — add costs under \`integrations:\` in stackprune.yml to see savings (\`stackprune init\` writes a starter file).`);
  if (!r.usageWindow) tips.push('Static scan only. Add the runtime probe (`node --import stackprune/register`) and pass `--usage .stackprune` to catch integrations that are in code but never called.');
  if (tips.length) {
    out.push('');
    for (const t of tips) out.push(dim(`• ${t}`));
  }
  out.push('');
  return out.join('\n');
}
