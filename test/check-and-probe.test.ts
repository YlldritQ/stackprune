import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/catalog/index.js';
import { check, renderCheckMarkdown } from '../src/check.js';
import { startProbe } from '../src/runtime/probe.js';
import { commit, git, initRepo, tempDir, writeFiles } from './helpers.js';

describe('check', () => {
  it('reports integrations a branch adds and enforces ownership', async () => {
    const repo = join(tempDir(), 'svc');
    writeFiles(repo, {
      'package.json': JSON.stringify({ dependencies: { '@sentry/node': '8' } }, null, 2),
      'src/a.ts': "import * as Sentry from '@sentry/node';\n",
      'stackprune.yml': 'check:\n  requireOwner: true\nintegrations:\n  sentry:\n    owner: platform\n',
    });
    initRepo(repo);
    commit(repo, 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFiles(repo, {
      'package.json': JSON.stringify({ dependencies: { '@sentry/node': '8', '@bugsnag/js': '7' } }, null, 2),
      'src/b.ts': "import Bugsnag from '@bugsnag/js';\n",
    });
    commit(repo, 'add bugsnag\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>');
    writeFiles(repo, { '.env': 'TWILIO_AUTH_TOKEN=x\n' }); // untracked local file: must not count as "added"

    const r = await check({ path: repo, base: 'main' });
    expect(r.added.map((i) => i.vendor.id)).toEqual(['bugsnag']);
    expect(r.added[0]!.introducedWithAI).toBe('GitHub Copilot');
    expect(r.added[0]!.reasons.join(' ')).toMatch(/Overlaps with Sentry/);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.problems).toEqual(['no owner']);
    expect(r.removed).toEqual([]);

    const md = renderCheckMarkdown(r);
    expect(md).toContain('<!-- stackprune -->');
    expect(md).toContain('**Bugsnag**');
    expect(md).toContain('no owner');

    // worktrees cleaned up
    expect(git(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });
});

describe('runtime probe', () => {
  it('counts calls per vendor from fetch and http, without paths or bodies', async () => {
    const server = createServer((req, res) => {
      res.statusCode = req.url === '/fail' ? 503 : 200;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const out = tempDir();
    const catalog = buildCatalog([{ id: 'local-api', name: 'Local API', category: 'other', hosts: ['127.0.0.1'] }]);
    const probe = startProbe({ app: 'test-app', outDir: out, catalog, allowPrivate: true, flushIntervalMs: 60_000 });

    await fetch(`http://127.0.0.1:${port}/customers/cus_123?email=a@b.c`);
    await fetch(`http://127.0.0.1:${port}/fail`);
    const http = await import('node:http');
    await new Promise<void>((resolve) => http.get(`http://127.0.0.1:${port}/x`, (res) => res.resume().on('end', () => resolve())));

    const snap = probe.peek();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ vendor: 'local-api', host: '127.0.0.1', calls: 3, status5xx: 1 });

    probe.stop();
    server.close();
    const files = readdirSync(out);
    expect(files).toHaveLength(1);
    const text = readFileSync(join(out, files[0]!), 'utf8');
    const rec = JSON.parse(text.trim().split('\n')[0]!) as Record<string, unknown>;
    expect(rec).toMatchObject({ app: 'test-app', vendor: 'local-api', calls: 3, errors: 1 });
    expect(text).not.toContain('cus_123');
    expect(text).not.toContain('a@b.c');
  });
});
