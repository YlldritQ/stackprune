import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBilling, normalizePayee, parseAmount, parseDate } from '../src/billing.js';
import { scan } from '../src/index.js';
import { tempDir, writeFiles } from './helpers.js';

describe('billing parsing', () => {
  it('parses German and English amounts and dates', () => {
    expect(parseAmount('-1.234,56 €')).toBe(-1234.56);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount('(12.00)')).toBe(-12);
    expect(parseAmount('49,00')).toBe(49);
    expect(parseDate('31.12.2026')).toBe('2026-12-31');
    expect(parseDate('2026-03-01')).toBe('2026-03-01');
    expect(parseDate('12/31/2026')).toBe('2026-12-31');
  });

  it('normalises card descriptors and company names', () => {
    expect(normalizePayee('PADDLE.NET* TELEMETRIX AI GMBH')).toBe('telemetrix ai');
    expect(normalizePayee('Stripe, Inc.')).toBe('stripe');
    expect(normalizePayee('OPENAI *CHATGPT SUBSCR')).toBe('openai chatgpt subscr');
    expect(normalizePayee('Sentry.io')).toBe('sentry');
  });

  it('reads a semicolon bank export, keeps the spend side and averages per month', () => {
    const dir = tempDir();
    writeFiles(dir, {
      'bank.csv': [
        'Buchungstag;Empfänger;Verwendungszweck;Betrag;Währung',
        '01.01.2026;Sentry.io;Team plan;-89,00;EUR',
        '01.02.2026;Sentry.io;Team plan;-89,00;EUR',
        '01.03.2026;Sentry.io;Team plan;-89,00;EUR',
        '05.01.2026;Kunde GmbH;Rechnung 42;1.500,00;EUR',
        '15.03.2026;PADDLE.NET* TELEMETRIX;Subscription;-297,00;EUR',
      ].join('\n'),
    });
    const b = loadBilling([join(dir, 'bank.csv')], 'EUR');
    expect(b.window).toEqual({ from: '2026-01-01', to: '2026-03-15' });
    // most expensive first; Sentry's 3 × 89 over 3 months is 89/mo, Telemetrix's one 297 payment is 99/mo
    expect(b.items.map((i) => [i.payee, i.monthly, i.payments])).toEqual([
      ['TELEMETRIX', 99, 1],
      ['Sentry.io', 89, 3],
    ]);
  });
});

describe('billing in a scan', () => {
  it('flags spend with no trace in code, and lists payees it cannot place', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': JSON.stringify({ dependencies: { '@sentry/node': '8' } }),
      'src/a.js': "require('@sentry/node')\n",
      'bank.csv': [
        'Date,Payee,Amount,Currency',
        '2026-01-03,Sentry.io,-89.00,USD',
        '2026-01-05,Mixpanel Inc,-28.00,USD',
        '2026-01-07,FIGMA,-45.00,USD',
        '2026-01-09,PADDLE.NET* TELEMETRIX,-99.00,USD',
        '2026-01-20,Customer payment,2000.00,USD',
      ].join('\n'),
      'stackprune.yml': [
        'billing: [bank.csv]',
        'integrations:',
        '  telemetrix: { name: Telemetrix, aliases: ["TELEMETRIX"] }',
        '  figma: { kind: tool, aliases: ["FIGMA"] }',
        '  launchdarkly: { cost: 150 }',
      ].join('\n'),
    });
    const r = await scan({ paths: [dir], configPath: join(dir, 'stackprune.yml'), git: false });
    const byId = Object.fromEntries(r.integrations.map((i) => [i.vendor.id, i]));
    expect(byId.sentry).toMatchObject({ status: 'active', verdict: 'keep' });
    expect(byId.sentry!.cost).toMatchObject({ monthly: 89, source: 'billing' });
    expect(byId.mixpanel).toMatchObject({ status: 'absent', verdict: 'review' });
    expect(byId.telemetrix).toMatchObject({ status: 'absent', verdict: 'review' });
    expect(byId.telemetrix!.vendor.name).toBe('Telemetrix');
    expect(byId.figma).toMatchObject({ status: 'tool', verdict: 'keep' });
    expect(byId.launchdarkly).toMatchObject({ status: 'absent', verdict: 'cut' });
    expect(byId.launchdarkly!.reasons[0]).toMatch(/You pay \$150\/mo but no repo references it/);
    expect(r.unmatchedSpend.map((s) => s.payee)).toEqual([]);
  });
});
