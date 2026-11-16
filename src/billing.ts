import { readFileSync } from 'node:fs';
import type { Catalog } from './catalog/index.js';
import { registrableDomain } from './hosts.js';
import type { Config, SpendItem } from './types.js';

/**
 * Billing exports → monthly spend per payee → matched to vendors.
 *
 * Works with the CSV most banks, card providers and accounting tools export
 * (comma / semicolon / tab, English or German number formats). Only needs a payee
 * column and an amount column; a date column turns totals into monthly figures.
 */

export interface BillingData {
  items: SpendItem[];
  window?: { from: string; to: string };
  warnings: string[];
}

export interface VendorSpend {
  monthly: number;
  total: number;
  currency: string;
  payees: string[];
}

const PAYEE_COL = [/^(vendor|merchant|payee|supplier|lieferant|counterparty|beneficiary|empf(ä|ae)nger|zahlungsempf(ä|ae)nger|beg(ü|ue)nstigter|name|partner|company)$/i, /(vendor|merchant|payee|counterpart|empf|beg(ü|ue)nstigt|name|auftraggeber)/i, /(description|beschreibung|verwendungszweck|text|memo|details)/i];
const AMOUNT_COL = [/^(amount|betrag|total|sum|summe|value|wert)$/i, /(amount|betrag|total|brutto|gross|net|netto|umsatz)/i];
const CURRENCY_COL = [/^(currency|w(ä|ae)hrung|ccy|cur)$/i, /(currency|w(ä|ae)hrung)/i];
const DATE_COL = [/^(date|datum|buchungstag|booking date|transaction date|posted|valuta|wertstellung)$/i, /(date|datum|buchung|valuta)/i];

export function loadBilling(paths: string[], defaultCurrency: string): BillingData {
  const warnings: string[] = [];
  const rows: { payee: string; amount: number; currency: string; date?: string }[] = [];

  for (const path of paths) {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    const delimiter = sniffDelimiter(text);
    const table = parseCsv(text, delimiter).filter((r) => r.some((c) => c.trim()));
    const headerIdx = table.findIndex((r) => r.filter((c) => c.trim() && !/^[-\d.,\s€$£%]+$/.test(c)).length >= 2);
    if (headerIdx === -1) {
      warnings.push(`${path}: no header row found`);
      continue;
    }
    const header = table[headerIdx]!.map((h) => h.trim());
    const col = (patterns: RegExp[]) => {
      for (const p of patterns) {
        const i = header.findIndex((h) => p.test(h));
        if (i !== -1) return i;
      }
      return -1;
    };
    const payeeI = col(PAYEE_COL);
    const amountI = col(AMOUNT_COL);
    if (payeeI === -1 || amountI === -1) {
      warnings.push(`${path}: need a payee and an amount column (found: ${header.join(', ')})`);
      continue;
    }
    const currencyI = col(CURRENCY_COL);
    const dateI = col(DATE_COL);
    const parsed = table.slice(headerIdx + 1).map((r) => ({
      payee: (r[payeeI] ?? '').trim(),
      amount: parseAmount(r[amountI] ?? ''),
      currency: (currencyI !== -1 ? r[currencyI]?.trim() : '') || currencyFromAmount(r[amountI] ?? '') || defaultCurrency,
      date: dateI !== -1 ? parseDate(r[dateI] ?? '') : undefined,
    }));
    const valid = parsed.filter((r) => r.payee && Number.isFinite(r.amount) && r.amount !== 0);
    // Bank exports mix income (+) and spend (−): keep the spend side.
    const neg = valid.filter((r) => r.amount < 0).length;
    const keep = neg > 0 && neg < valid.length ? valid.filter((r) => r.amount < 0) : valid;
    for (const r of keep) rows.push({ ...r, amount: Math.abs(r.amount) });
  }

  const dates = rows.map((r) => r.date).filter((d): d is string => !!d).sort();
  const window = dates.length ? { from: dates[0]!, to: dates.at(-1)! } : undefined;
  const months = window ? Math.max(1, Math.round((Date.parse(window.to) - Date.parse(window.from)) / (30.44 * 86_400_000)) + 1) : 1;

  const byPayee = new Map<string, SpendItem>();
  for (const r of rows) {
    const key = normalizePayee(r.payee);
    if (!key) continue;
    let item = byPayee.get(key);
    if (!item) byPayee.set(key, (item = { payee: cleanPayee(r.payee), monthly: 0, total: 0, payments: 0, currency: r.currency.toUpperCase() }));
    item.total += r.amount;
    item.payments++;
  }
  for (const item of byPayee.values()) {
    item.total = round(item.total);
    item.monthly = round(item.total / months);
  }
  return { items: [...byPayee.values()].sort((a, b) => b.monthly - a.monthly), window, warnings };
}

/** Match payees to vendors via id, name, API domains and `aliases:` in config. */
export function matchBilling(data: BillingData, catalog: Catalog, config: Config): { byVendor: Map<string, VendorSpend>; unmatched: SpendItem[] } {
  const keys = new Map<string, Set<string>>(); // normalized key → vendor ids
  const addKey = (k: string, id: string) => {
    const n = normalizePayee(k);
    if (!n || n.length < 3) return;
    let s = keys.get(n);
    if (!s) keys.set(n, (s = new Set()));
    s.add(id);
  };
  for (const v of catalog.vendors) {
    addKey(v.id, v.id);
    addKey(v.name.replace(/\(.*?\)/g, ''), v.id);
    for (const h of v.hosts ?? []) {
      const d = registrableDomain(h.replace(/^\*\./, ''));
      if (!d.includes('*') && catalog.ownsDomain(d)) addKey(d.split('.')[0]!, v.id);
    }
  }
  for (const [id, meta] of Object.entries(config.integrations ?? {})) {
    addKey(id, id);
    if (meta.name) addKey(meta.name, id);
    for (const a of meta.aliases ?? []) addKey(a, id);
  }
  // Explicit aliases always win, so keep them separately.
  const aliasKeys = new Map<string, string>();
  for (const [id, meta] of Object.entries(config.integrations ?? {})) for (const a of meta.aliases ?? []) aliasKeys.set(normalizePayee(a), id);

  const byVendor = new Map<string, VendorSpend>();
  const unmatched: SpendItem[] = [];
  for (const item of data.items) {
    const p = normalizePayee(item.payee);
    let id = aliasKeys.get(p);
    if (!id) {
      let best: { key: string; ids: Set<string> } | undefined;
      for (const [key, ids] of keys) {
        if (ids.size !== 1) continue; // ambiguous ("aws" → many services)
        if (p === key || new RegExp(`(^| )${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(p)) {
          if (!best || key.length > best.key.length) best = { key, ids };
        }
      }
      id = best ? [...best.ids][0] : undefined;
    }
    if (!id) {
      unmatched.push(item);
      continue;
    }
    item.vendorId = id;
    const s = byVendor.get(id) ?? { monthly: 0, total: 0, currency: item.currency, payees: [] };
    s.monthly = round(s.monthly + item.monthly);
    s.total = round(s.total + item.total);
    s.payees.push(item.payee);
    byVendor.set(id, s);
  }
  return { byVendor, unmatched };
}

const LEGAL = /\b(gmbh|ug|ag|kg|ohg|e\.?k|inc|incorporated|ltd|limited|llc|llp|plc|pbc|bv|b\.v|nv|sa|sas|sarl|srl|spa|ab|oy|as|aps|pty|co|corp|corporation|company|holding|holdings|technologies|technology|software|services|labs|lab|hq|ireland|europe|emea|deutschland|germany|international)\b\.?/g;

/** Payment processors that put their own name before the merchant: "PADDLE.NET* TELEMETRIX". */
const PROCESSORS = /^(paypal|pp|paddle(\.net)?|stripe|sq|sumup|fs|fastspring|2co|lemonsqueezy|ls|dri|digitalriver|chargebee|recurly|zettle|izettle|cleverbridge|avangate|mollie|adyen|klarna|wise|revolut)\s*\*/i;

/** The merchant part of a card descriptor: "PADDLE.NET* TELEMETRIX" → "TELEMETRIX", "OPENAI *CHATGPT" → whole. */
function merchantPart(raw: string): string {
  return PROCESSORS.test(raw.trim()) ? raw.slice(raw.indexOf('*') + 1) : raw;
}

/** "PADDLE.NET* TELEMETRIX AI GMBH" → "telemetrix ai"; "Stripe, Inc." → "stripe"; "OPENAI *CHATGPT" → "openai chatgpt" */
export function normalizePayee(raw: string): string {
  let s = merchantPart(raw).toLowerCase();
  s = s
    .replace(/https?:\/\//g, '')
    .replace(/\b([a-z0-9-]+)\.(com|io|ai|net|org|dev|app|co|de|eu|so|sh|cloud|tech|xyz)\b/g, '$1')
    .replace(LEGAL, ' ')
    .replace(/[^a-z0-9äöüß ]+/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

function cleanPayee(raw: string): string {
  return merchantPart(raw).replace(/\s+/g, ' ').trim().slice(0, 60);
}

function sniffDelimiter(text: string): string {
  const first = text.split('\n').slice(0, 5).join('\n');
  const counts = [';', ',', '\t'].map((d) => ({ d, n: first.split(d).length }));
  return counts.sort((a, b) => b.n - a.n)[0]!.d;
}

export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** "1.234,56 €", "-1,234.56", "(12.00)", "12,5" → number */
export function parseAmount(raw: string): number {
  let s = raw.trim();
  const negative = /^\(.*\)$/.test(s) || s.includes('-') || /\bS$/.test(s) /* German "Soll" */;
  s = s.replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
  else s = s.replace(/,/g, ''); // 1,234.56
  const n = Number(s);
  return negative ? -n : n;
}

function currencyFromAmount(raw: string): string | undefined {
  if (raw.includes('€')) return 'EUR';
  if (raw.includes('$')) return 'USD';
  if (raw.includes('£')) return 'GBP';
  return undefined;
}

/** ISO, 31.12.2026, 31/12/2026, 12/31/2026 → YYYY-MM-DD */
export function parseDate(raw: string): string | undefined {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/.exec(s);
  if (!m) return undefined;
  let [a, b] = [Number(m[1]), Number(m[2])];
  const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  if (s.includes('/') && b > 12) [a, b] = [b, a]; // US mm/dd/yyyy
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y}-${pad(b)}-${pad(a)}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
