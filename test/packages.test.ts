import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PURPOSES } from '../src/catalog/purposes.js';
import { check } from '../src/check.js';
import { scan } from '../src/index.js';
import { packageFromPath, startProbe } from '../src/runtime/probe.js';
import { commit, git, initRepo, tempDir, writeFiles } from './helpers.js';

const pkgJson = (deps: Record<string, string>, dev: Record<string, string> = {}, scripts: Record<string, string> = {}) =>
  JSON.stringify({ name: 'web', scripts, dependencies: deps, devDependencies: dev }, null, 2);

function webApp(): string {
  const dir = join(tempDir(), 'web');
  writeFiles(dir, {
    'package.json': pkgJson(
      { react: '18', 'react-dom': '18', lodash: '4', moment: '2', dayjs: '1', 'date-fns': '3', 'left-pad': '1', zustand: '4', tailwindcss: '3' },
      { typescript: '5', '@types/lodash': '4', '@types/express': '4', 'eslint-plugin-react': '7', rimraf: '5', sass: '1', vitest: '2' },
      { clean: 'rimraf dist', test: 'vitest run' },
    ),
    'src/App.tsx': "import React from 'react';\nimport _ from 'lodash';\nimport dayjs from 'dayjs';\nimport moment from 'moment';\nexport const x = [_, dayjs(), moment()];\n",
    'src/other.ts': "import { format } from 'date-fns';\nimport dayjs from 'dayjs';\nexport const y = [format, dayjs];\n",
    'src/old.ts': "// import { create } from 'zustand';\nexport const z = 1;\n",
    'src/styles.scss': '.a { color: red; }\n',
    'src/index.css': '@tailwind base;\n',
    '.eslintrc.json': JSON.stringify({ plugins: ['react'] }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\npackages:\n  left-pad@1.0.0: {}\n  zustand@4.0.0: {}\n",
  });
  return dir;
}

describe('unused packages', () => {
  it('finds dependencies nothing imports, runs or configures — and only those', async () => {
    const r = await scan({ paths: [webApp()], config: {}, git: false });
    const unused = r.unusedPackages.map((u) => u.name).sort();
    expect(unused).toEqual(['@types/express', 'left-pad', 'zustand']);
    const types = r.unusedPackages.find((u) => u.name === '@types/express')!;
    expect(types).toMatchObject({ dev: true, confidence: 'low' });
    expect(r.unusedPackages.find((u) => u.name === 'zustand')).toMatchObject({ dev: false, confidence: 'high' });
  });

  it('scopes usage to the manifest folder in monorepos', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'apps/api/package.json': pkgJson({ axios: '1' }),
      'apps/web/package.json': pkgJson({ axios: '1' }),
      'apps/web/src/a.ts': "import axios from 'axios';\n",
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    expect(r.unusedPackages).toHaveLength(1);
    expect(r.unusedPackages[0]!.where[0]!.manifest).toBe('apps/api/package.json');
  });

  it('checks python and go dependencies', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'requirements.txt': 'requests==2\nbeautifulsoup4==4\npyyaml==6\nhttpx==0.27\ngunicorn==21\nrich==13\n',
      'app/main.py': 'import requests\nfrom bs4 import BeautifulSoup\nimport yaml\n',
      'Procfile': 'web: gunicorn app.main:app\n',
      'svc/go.mod': 'module x\n\nrequire (\n\tgithub.com/go-chi/chi/v5 v5.0.0\n\tgithub.com/spf13/cobra v1.8.0\n)\n',
      'svc/main.go': 'package main\n\nimport "github.com/go-chi/chi/v5"\n',
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    expect(r.unusedPackages.map((u) => u.name).sort()).toEqual(['github.com/spf13/cobra', 'httpx', 'rich']);
  });

  it('records who added an unused package and whether an AI assistant was credited', async () => {
    const dir = join(tempDir(), 'svc');
    writeFiles(dir, { 'package.json': pkgJson({ express: '4' }), 'index.js': "require('express')\n" });
    initRepo(dir);
    commit(dir, 'init');
    writeFiles(dir, { 'package.json': pkgJson({ express: '4', 'node-cron': '3' }) });
    commit(dir, 'feat: schedule reports\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const r = await scan({ paths: [dir], config: {} });
    expect(r.unusedPackages).toHaveLength(1);
    expect(r.unusedPackages[0]).toMatchObject({ name: 'node-cron', introducedWithAI: 'Claude' });
  });
});

describe('duplicates', () => {
  it('flags libraries doing the same job, most-used first', async () => {
    const r = await scan({ paths: [webApp()], config: {}, git: false });
    const dates = r.duplicates.find((d) => d.group === 'dates');
    expect(dates?.families.map((f) => [f.name, f.files])).toEqual([
      ['Day.js', 2],
      ['date-fns', 1],
      ['Moment', 1],
    ]);
  });

  it('never treats a library and its companions as duplicates', () => {
    for (const g of PURPOSES) {
      const seen = new Map<string, string>();
      for (const f of g.families) for (const p of f.packages) {
        expect(seen.get(p), `${g.id}: ${p} in ${seen.get(p)} and ${f.name}`).toBeUndefined();
        seen.set(p, f.name);
      }
    }
    expect(new Set(PURPOSES.map((g) => g.id)).size).toBe(PURPOSES.length);
  });

  it('judges duplicates per app, not across apps', async () => {
    const parent = tempDir();
    writeFiles(parent, {
      'a/package.json': pkgJson({ dayjs: '1' }),
      'a/i.js': "require('dayjs')\n",
      'b/package.json': pkgJson({ moment: '2' }),
      'b/i.js': "require('moment')\n",
    });
    for (const n of ['a', 'b']) initRepo(join(parent, n));
    const r = await scan({ paths: [join(parent, 'a'), join(parent, 'b')], config: {}, git: false });
    expect(r.duplicates).toEqual([]);
  });
});

describe('vendor SDKs the catalog does not know', () => {
  it('detects them from a package + credential env var, and flags switched-off test code', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': pkgJson({ '@acmetel/otel-browser': '0.4.0', axios: '1' }),
      'src/acme.ts':
        '// Acmetel browser bootstrap (local telemetry test).\nimport { register } from "@acmetel/otel-browser";\nconst key = process.env.VITE_ACMETEL_PUBLISHABLE_KEY;\nif (key) register({ key });\n',
      'src/http.ts': "import axios from 'axios';\nexport const base = process.env.AXIOS_BASE_URL;\n",
      '.env.example': 'VITE_SENTRY_DSN=\n',
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    const acme = r.integrations.find((i) => i.vendor.id === 'acmetel');
    expect(acme?.vendor.detected).toBe('sdk');
    expect(acme?.verdict).toBe('review');
    const why = acme!.reasons.join('\n');
    expect(why).toMatch(/Needs VITE_ACMETEL_PUBLISHABLE_KEY, which no env file/);
    expect(why).toMatch(/describes itself as "Acmetel browser bootstrap \(local telemetry test\)\."/);
    expect(r.integrations.find((i) => i.vendor.id === 'axios')).toBeUndefined(); // a base URL isn't a credential
  });
});

describe('runtime: packages loaded in production', () => {
  it('maps node_modules paths to package names', () => {
    expect(packageFromPath('/app/node_modules/express/lib/router.js')).toBe('express');
    expect(packageFromPath('/app/node_modules/.pnpm/@scope+x@1.0.0/node_modules/@scope/x/dist/i.js')).toBe('@scope/x');
    expect(packageFromPath('C:\\app\\node_modules\\lodash\\index.js')).toBe('lodash');
    expect(packageFromPath('/app/src/index.js')).toBeUndefined();
  });

  it('records packages the process loads', () => {
    const probe = startProbe({ app: 'pkgtest', outDir: '', trackPackages: true });
    createRequire(import.meta.url)('yaml');
    expect(probe.packages()).toContain('yaml');
    probe.stop();
  });

  it('flags dependencies imported in code but never loaded in production', async () => {
    const dir = join(tempDir(), 'api');
    writeFiles(dir, {
      'package.json': pkgJson({ express: '4', pdfkit: '0.15', pino: '9', zod: '3', 'node-cron': '3', helmet: '7', cors: '2' }),
      'src/server.js': "require('express');require('pino');require('zod');require('helmet');require('cors');\n",
      'src/reports/pdf.js': "require('pdfkit');\n",
      'src/jobs.js': "require('node-cron');\n",
    });
    const usage = join(tempDir(), 'usage.jsonl');
    writeFileSync(usage, `${JSON.stringify({ v: 1, kind: 'packages', ts: '2026-06-15T00:00:00Z', from: '2026-06-01T00:00:00Z', app: 'api', packages: ['express', 'pino', 'zod', 'helmet', 'cors', 'node-cron'] })}\n`);
    const r = await scan({ paths: [dir], config: {}, usage: [usage], git: false });
    const rt = r.unusedPackages.filter((u) => u.runtime);
    expect(rt.map((u) => u.name)).toEqual(['pdfkit']);
    expect(rt[0]!.reason).toMatch(/never loaded in production \(14 days of data\)/);
  });
});

describe('check on a pull request', () => {
  it('flags new packages that are unused or duplicate an existing library', async () => {
    const repo = join(tempDir(), 'web');
    writeFiles(repo, {
      'package.json': pkgJson({ dayjs: '1' }),
      'src/a.js': "import dayjs from 'dayjs';\n",
      'stackprune.yml': 'check:\n  blockDuplicates: true\n',
    });
    initRepo(repo);
    commit(repo, 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFiles(repo, {
      'package.json': pkgJson({ dayjs: '1', moment: '2', 'left-pad': '1' }),
      'src/b.js': "import moment from 'moment';\n",
    });
    commit(repo, 'fix date bug\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const r = await check({ path: repo, base: 'main' });
    const byName = Object.fromEntries(r.addedPackages.map((p) => [p.name, p]));
    expect(byName.moment?.duplicateOf).toEqual({ label: 'Date & time handling', existing: ['Day.js'] });
    expect(byName['left-pad']).toMatchObject({ unused: true, introducedWithAI: 'Claude' });
    expect(r.packageViolations).toEqual(['moment duplicates Day.js (Date & time handling)']);
  });
});
