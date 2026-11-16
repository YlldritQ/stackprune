import type { ScanResult } from './types.js';

/** Starter stackprune.yml pre-filled with what the scan found. */
export function renderStarterConfig(r: ScanResult): string {
  const lines: string[] = [
    '# stackprune config — https://github.com/YlldritQ/stackprune',
    '#',
    '# Fill in cost (per month), owner and purpose for each integration.',
    '# Costs turn the report into a savings estimate; owners make `stackprune check` useful in CI.',
    '',
    `currency: ${r.currency}`,
    '',
    '# Code untouched for this long gets a "stale" note in the report.',
    'staleDays: 365',
    '',
    '# Fail `stackprune check` when a PR adds an integration nobody has claimed.',
    'check:',
    '  requireOwner: false',
    '  requirePurpose: false',
    '',
    'integrations:',
  ];
  for (const i of r.integrations) {
    if (i.status === 'dev-only') continue;
    lines.push(`  ${i.vendor.id}: # ${i.vendor.name} · ${i.vendor.category} · ${i.verdict}${i.vendor.url ? ` · ${i.vendor.url}` : ''}`);
    lines.push(i.vendor.paid ? '    cost: ~ # per month, e.g. 49' : '    cost: 0 # usually free');
    lines.push(`    owner: ""`);
    lines.push(`    purpose: ""`);
  }
  if (!r.integrations.length) lines.push('  {}');
  lines.push('');
  lines.push('# Integrations the catalog doesn\'t know: in-house APIs, partners, niche vendors.');
  lines.push('vendors:');
  const unknown = r.unknownHosts.slice(0, 8);
  if (unknown.length) {
    for (const h of unknown) {
      const id = h.domain.replace(/\.[a-z]+$/, '').replace(/[^a-z0-9]+/g, '-');
      lines.push(`  # - id: ${id}`);
      lines.push(`  #   name: ${h.domain}`);
      lines.push(`  #   category: other`);
      lines.push(`  #   hosts: ["*.${h.domain}", "${h.domain}"]`);
      lines.push(`  #   env: ["${id.toUpperCase().replace(/-/g, '_')}_*"]`);
    }
  } else {
    lines.push('  # - id: acme-api');
    lines.push('  #   name: Acme API');
    lines.push('  #   category: other');
    lines.push('  #   hosts: ["api.acme.com"]');
    lines.push('  #   env: ["ACME_*"]');
  }
  lines.push('');
  lines.push('# Your own domains, hidden from the "unknown domains" list.');
  lines.push('ignoreHosts: []');
  lines.push('');
  lines.push('# Paths to skip (in addition to node_modules, dist, build, …).');
  lines.push('exclude: []');
  lines.push('');
  return lines.join('\n');
}
