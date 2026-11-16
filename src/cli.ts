#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { check, renderCheckMarkdown, renderCheckTerminal } from './check.js';
import { VENDORS } from './catalog/index.js';
import { scan } from './index.js';
import { renderStarterConfig } from './init.js';
import { renderHtml } from './report/html.js';
import { renderMarkdown } from './report/markdown.js';
import { renderTerminal } from './report/terminal.js';
import type { ScanResult } from './types.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const FORMATS = ['table', 'md', 'markdown', 'json', 'html'];
const FAIL_ON = ['cut', 'review'];

const HELP = `stackprune — unused packages, duplicate libraries and paid integrations nobody uses

Usage
  stackprune [scan] [paths...]      Scan repos (a folder of repos is expanded) and report
  stackprune check --base <ref>     What a branch adds vs <ref>: integrations, unused or duplicate packages
  stackprune init [paths...]        Write a starter stackprune.yml from what's detected
  stackprune catalog [search]       List the vendors stackprune knows about

Options
  -f, --format <fmt>   table (default) | md | json | html
  -o, --out <file>     Write the report to a file instead of stdout
  -u, --usage <path>   Runtime usage JSONL file or folder (repeatable), e.g. .stackprune
      --billing <csv>  Bank / card / accounting export to match payments against (repeatable)
  -c, --config <file>  Config file (default: stackprune.yml in the scanned folder or above it, up to the repo root)
      --no-git         Skip git history (faster; no "added by AI" / staleness signals)
      --all            Show details for every integration
      --fail-on <v>    Exit 1 on findings: cut (unused integrations/packages) | review (also duplicates)
  -h, --help           Show help
  -v, --version        Show version

Examples
  npx stackprune ~/code/acme
  npx stackprune . --format html --out stackprune-report.html
  npx stackprune check --base origin/main --format md
  node --import stackprune/register server.js   # collect runtime usage
`;

class UsageError extends Error {}

function parse(argv: string[]) {
  try {
    return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: 'string', short: 'f' },
      out: { type: 'string', short: 'o' },
      usage: { type: 'string', short: 'u', multiple: true },
      billing: { type: 'string', multiple: true },
      config: { type: 'string', short: 'c' },
      base: { type: 'string', short: 'b' },
      'no-git': { type: 'boolean' },
      all: { type: 'boolean' },
      'fail-on': { type: 'string' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    });
  } catch (e) {
    // Node's own messages are long; keep the part that names the option.
    const msg = (e as Error).message.replace(/\. To specify a positional argument.*$/s, '');
    throw new UsageError(`${msg}. See stackprune --help`);
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);

  if (values.help || positionals[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const commands = new Set(['scan', 'check', 'init', 'catalog']);
  const command = positionals[0] && commands.has(positionals[0]) ? positionals[0] : 'scan';
  const args = command === positionals[0] ? positionals.slice(1) : positionals;
  const format = values.format ?? (values.out ? formatFromExt(values.out) : 'table');
  if (!FORMATS.includes(format)) throw new UsageError(`Unknown --format '${format}'. Use one of: table, md, json, html`);
  const failOn = values['fail-on'];
  if (failOn !== undefined && !FAIL_ON.includes(failOn)) throw new UsageError(`Unknown --fail-on '${failOn}'. Use cut or review`);
  for (const b of values.billing ?? []) if (!existsSync(b)) throw new UsageError(`Billing file not found: ${b}`);

  const emit = (text: string) => {
    if (values.out) {
      const p = resolve(values.out);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      process.stderr.write(`Wrote ${values.out}\n`);
    } else {
      process.stdout.write(text);
    }
  };

  switch (command) {
    case 'catalog': {
      const q = args.join(' ').toLowerCase();
      const rows = VENDORS.filter((v) => !q || `${v.id} ${v.name} ${v.category}`.toLowerCase().includes(q)).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
      if (format === 'json') emit(`${JSON.stringify(rows, null, 2)}\n`);
      else emit(`${rows.map((v) => `${v.category.padEnd(16)} ${v.id.padEnd(24)} ${v.name}`).join('\n')}\n${rows.length} vendors\n`);
      return 0;
    }

    case 'init': {
      const target = resolve(values.out ?? 'stackprune.yml');
      if (existsSync(target) && !values.force) {
        process.stderr.write(`${target} already exists (use --force to overwrite)\n`);
        return 1;
      }
      const r = await scan({ paths: args, configPath: values.config, git: false });
      writeFileSync(target, renderStarterConfig(r));
      process.stderr.write(`Wrote ${target} with ${r.integrations.length} integrations. Fill in cost, owner and purpose.\n`);
      return 0;
    }

    case 'check': {
      if (!values.base) {
        process.stderr.write('check needs --base <ref>, e.g. --base origin/main\n');
        return 2;
      }
      const r = await check({ path: args[0], base: values.base, configPath: values.config });
      if (format === 'json') emit(`${JSON.stringify(r, (k, v) => (k === 'hits' ? undefined : v), 2)}\n`);
      else if (format === 'md') emit(renderCheckMarkdown(r));
      else emit(renderCheckTerminal(r));
      return r.violations.length || r.packageViolations.length ? 1 : 0;
    }

    default: {
      const r = await scan({ paths: args, configPath: values.config, usage: values.usage, billing: values.billing, git: !values['no-git'] });
      emit(render(r, format, !!values.all));
      const unusedHigh = r.unusedPackages.some((u) => u.confidence === 'high');
      if (failOn === 'cut' && (unusedHigh || r.integrations.some((i) => i.verdict === 'cut'))) return 1;
      if (failOn === 'review' && (unusedHigh || r.duplicates.length || r.integrations.some((i) => i.verdict !== 'keep'))) return 1;
      return 0;
    }
  }
}

function formatFromExt(file: string): string {
  if (file.endsWith('.html')) return 'html';
  if (file.endsWith('.md')) return 'md';
  if (file.endsWith('.json')) return 'json';
  return 'table';
}

function render(r: ScanResult, format: string, all: boolean): string {
  switch (format) {
    case 'json': {
      const { catalog: _c, scans: _s, ...rest } = r as ScanResult & { catalog?: unknown; scans?: unknown };
      return `${JSON.stringify(rest, null, 2)}\n`;
    }
    case 'md':
    case 'markdown':
      return renderMarkdown(r);
    case 'html':
      return renderHtml(r);
    default:
      return renderTerminal(r, { all });
  }
}

// Set exitCode instead of calling process.exit(), so large reports piped to another
// process are fully flushed before Node exits.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`stackprune: ${err instanceof Error ? err.message : String(err)}\n`);
    if (!(err instanceof UsageError) && process.env.STACKPRUNE_DEBUG && err instanceof Error) process.stderr.write(`${err.stack}\n`);
    process.exitCode = 2;
  },
);
