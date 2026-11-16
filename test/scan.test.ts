import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { scan } from '../src/index.js';
import { renderHtml } from '../src/report/html.js';
import { renderMarkdown } from '../src/report/markdown.js';
import { renderTerminal } from '../src/report/terminal.js';
import type { Config, Integration } from '../src/types.js';
import { commit, initRepo, tempDir, writeFiles } from './helpers.js';

let repo: string;

beforeAll(() => {
  repo = join(tempDir(), 'shop');
  writeFiles(repo, {
    'package.json': JSON.stringify(
      {
        name: 'shop',
        scripts: { start: 'node -r dd-trace/init server.js' },
        dependencies: { stripe: '^14', '@sentry/node': '^8', '@bugsnag/js': '^7', 'dd-trace': '^5' },
        devDependencies: { vitest: '^2' },
      },
      null,
      2,
    ),
    'src/pay.ts': "import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);\nexport const sync = () => fetch('https://api.partner-xyz.io/v2/orders');\n",
    'src/errors.ts': "import * as Sentry from '@sentry/node';\nimport Bugsnag from '@bugsnag/js';\nSentry.init({});\nBugsnag.start({ apiKey: 'x' });\n",
    'src/config.ts': 'export const resendKey = process.env.RESEND_API_KEY;\n',
    'src/pay.test.ts': "import Stripe from 'stripe';\n",
    '.env.example': 'STRIPE_SECRET_KEY=\nTWILIO_ACCOUNT_SID=\nTWILIO_AUTH_TOKEN=\nRESEND_API_KEY=\n',
    'node_modules/mixpanel/index.js': "import 'stripe';\n", // must be ignored
  });
  initRepo(repo);
  commit(repo, 'initial', '2025-01-10T10:00:00Z');

  // An assistant adds analytics that nobody ends up calling.
  writeFiles(repo, {
    'package.json': JSON.stringify(
      {
        name: 'shop',
        scripts: { start: 'node -r dd-trace/init server.js' },
        dependencies: { stripe: '^14', '@sentry/node': '^8', '@bugsnag/js': '^7', 'dd-trace': '^5', mixpanel: '^0.18' },
        devDependencies: { vitest: '^2' },
      },
      null,
      2,
    ),
  });
  commit(repo, 'feat: add product analytics\n\nCo-Authored-By: Claude <noreply@anthropic.com>', '2026-03-02T09:00:00Z');
});

const find = (list: Integration[], id: string) => {
  const i = list.find((x) => x.vendor.id === id);
  if (!i) throw new Error(`${id} not found in ${list.map((x) => x.vendor.id).join(', ')}`);
  return i;
};

describe('scan', () => {
  it('classifies every integration', async () => {
    const r = await scan({ paths: [repo], config: {}, now: new Date('2026-06-01T00:00:00Z') });
    const ids = r.integrations.map((i) => i.vendor.id);

    expect(find(r.integrations, 'stripe')).toMatchObject({ status: 'active', verdict: 'keep' });
    expect(find(r.integrations, 'datadog')).toMatchObject({ status: 'active' }); // wired up via `node -r dd-trace/init`

    const mixpanel = find(r.integrations, 'mixpanel');
    expect(mixpanel).toMatchObject({ status: 'unused', verdict: 'cut', introducedWithAI: 'Claude' });
    expect(mixpanel.introducedAt?.slice(0, 10)).toBe('2026-03-02');
    expect(mixpanel.reasons[0]).toMatch(/never imported/);

    expect(find(r.integrations, 'twilio')).toMatchObject({ status: 'config-only', verdict: 'cut' });
    // Code that reads the key talks to the service, SDK or not.
    expect(find(r.integrations, 'resend')).toMatchObject({ status: 'active', verdict: 'keep' });
    expect(find(r.integrations, 'resend').reasons[0]).toMatch(/reads its settings \(RESEND_API_KEY\)/);

    const sentry = find(r.integrations, 'sentry');
    const bugsnag = find(r.integrations, 'bugsnag');
    expect(sentry.verdict).toBe('review');
    expect(sentry.overlapsWith).toContain('bugsnag');
    expect(bugsnag.overlapsWith).toContain('sentry');

    expect(ids).not.toContain('vitest');
    expect(r.unknownHosts.map((h) => h.domain)).toContain('partner-xyz.io');
    // verdict ordering: cut first, keep last
    expect(r.integrations[0]!.verdict).toBe('cut');
    expect(r.integrations.at(-1)!.verdict).toBe('keep');
  });

  it('applies config: costs, owners, keep flags, custom vendors, ignores', async () => {
    const config: Config = {
      currency: 'EUR',
      vendors: [{ id: 'partner-xyz', name: 'Partner XYZ', category: 'other', hosts: ['*.partner-xyz.io'] }],
      integrations: { mixpanel: { cost: 89 }, stripe: { owner: 'payments-team', cost: { monthly: 250 } }, twilio: { keep: true } },
      ignore: ['datadog'],
    };
    const r = await scan({ paths: [repo], config, git: false });
    expect(find(r.integrations, 'mixpanel').cost?.monthly).toBe(89);
    expect(find(r.integrations, 'stripe').owner).toBe('payments-team');
    expect(find(r.integrations, 'twilio')).toMatchObject({ verdict: 'keep' });
    expect(find(r.integrations, 'twilio').reasons[0]).toBe('Marked keep in config');
    expect(find(r.integrations, 'partner-xyz').status).toBe('active');
    expect(r.integrations.map((i) => i.vendor.id)).not.toContain('datadog');
    expect(r.unknownHosts.map((h) => h.domain)).not.toContain('partner-xyz.io');

    const md = renderMarkdown(r);
    expect(md).toContain('potential savings **€89/mo**');
    expect(md).toContain('| **Mixpanel** |');
  });

  it('marks code-level integrations dormant when runtime data shows no calls', async () => {
    const usageDir = tempDir();
    const usageFile = join(usageDir, 'usage.jsonl');
    writeFileSync(
      usageFile,
      [
        { ts: '2026-05-31T00:00:00Z', from: '2026-05-01T00:00:00Z', app: 'shop', host: 'api.stripe.com', calls: 1200, errors: 3 },
        { ts: '2026-05-31T00:00:00Z', from: '2026-05-01T00:00:00Z', app: 'shop', host: 'api.partner-xyz.io', calls: 40 },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n'),
    );
    const r = await scan({ paths: [repo], config: {}, usage: [usageDir], git: false });
    const stripe = find(r.integrations, 'stripe');
    expect(stripe.status).toBe('active');
    expect(stripe.usage?.calls).toBe(1200);
    expect(find(r.integrations, 'sentry')).toMatchObject({ status: 'dormant', verdict: 'review' });
    expect(find(r.integrations, 'sentry').reasons[0]).toMatch(/0 calls in 30 days/);
    expect(r.unknownHosts.find((h) => h.domain === 'partner-xyz.io')?.calls).toBe(40);
  });

  it('renders every report format', async () => {
    const r = await scan({ paths: [repo], config: {}, git: false });
    const term = renderTerminal(r);
    expect(term).toContain('CUT');
    expect(term).toContain('Mixpanel');
    const html = renderHtml(r);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('"id":"mixpanel"');
    expect(html).not.toMatch(/<script[^>]+src=/); // self-contained
  });

  it('warns about manifests it cannot parse instead of silently skipping them', async () => {
    const dir = tempDir();
    writeFiles(dir, { 'package.json': '{ "dependencies": { "stripe": "1" }, }' });
    const r = await scan({ paths: [dir], config: {}, git: false });
    expect(r.warnings.join('\n')).toMatch(/package\.json: could not parse/);
  });

  it('scans the apps listed in config, grouped by app', async () => {
    const parent = tempDir();
    writeFiles(parent, {
      'shop-api/package.json': JSON.stringify({ dependencies: { '@sentry/node': '1' } }),
      'shop-api/index.js': "require('@sentry/node')\n",
      'shop-web/package.json': JSON.stringify({ dependencies: { '@bugsnag/js': '1' } }),
      'shop-web/index.js': "require('@bugsnag/js')\n",
      'blog/package.json': JSON.stringify({ dependencies: { '@sentry/node': '1' } }),
      'blog/index.js': "require('@sentry/node')\n",
      'audit/stackprune.yml': 'apps:\n  shop: [../shop-api, ../shop-web]\n  blog: [../blog]\n',
    });
    const r = await scan({ configPath: join(parent, 'audit/stackprune.yml'), git: false });
    expect(r.targets.map((t) => `${t.group}:${t.name}`)).toEqual(['shop:shop-api', 'shop:shop-web', 'blog:blog']);
    // Sentry and Bugsnag overlap inside "shop" (different repos, same app)
    expect(find(r.integrations, 'bugsnag').overlapsWith).toEqual(['sentry']);
  });

  it('expands a folder of repos into one target per repo', async () => {
    const parent = tempDir();
    for (const name of ['api', 'web']) {
      const dir = join(parent, name);
      writeFiles(dir, { 'package.json': JSON.stringify({ dependencies: { stripe: '1' } }), 'index.js': "require('stripe')\n" });
      initRepo(dir);
    }
    const r = await scan({ paths: [parent], config: {}, git: false });
    expect(r.targets.map((t) => t.name)).toEqual(['api', 'web']);
    expect(find(r.integrations, 'stripe').hits.map((h) => h.target)).toEqual(['api', 'web']);
  });
});
