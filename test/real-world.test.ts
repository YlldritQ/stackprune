// Regressions found by scanning real open-source projects (Next.js, Nuxt, Angular, SvelteKit,
// Expo, Django, FastAPI, Go, turborepo monorepos). Each fixture is the smallest shape that
// reproduced a wrong finding.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan } from '../src/index.js';
import { commit, initRepo, tempDir, writeFiles } from './helpers.js';

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: 'app', dependencies: deps, ...extra }, null, 2);
const unusedNames = async (dir: string, confidence?: 'high' | 'low') =>
  (await scan({ paths: [dir], config: {}, git: false })).unusedPackages
    .filter((u) => !confidence || u.confidence === confidence)
    .map((u) => u.name)
    .sort();

describe('python', () => {
  it('reads every line of consecutive from-imports', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'requirements.txt': 'pydantic==2\npydantic-settings==2\nrich==13\nhuggingface-hub==1\n',
      'app/config.py': 'from pydantic import BaseModel, Field\nfrom pydantic_settings import BaseSettings\nfrom rich.console import Console\nfrom huggingface_hub import snapshot_download\n',
    });
    expect(await unusedNames(dir)).toEqual([]);
  });

  it('resolves Django apps, stubs, GPU variants and extras', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'requirements.txt': 'django==5\ndjango-taggit==5\ndjango-debug-toolbar==4\ntypes-requests==2\nrequests==2\nonnxruntime-gpu==1\ntzdata==2024\npytest==8\npytest-cov==5\n',
      'pyproject.toml': '[project]\nname = "x"\ndependencies = []\n\n[project.optional-dependencies]\ncuda = ["nvidia-cuda-runtime-cu12"]\n',
      'site/settings.py': "INSTALLED_APPS = ['django.contrib.admin', 'taggit', 'debug_toolbar']\n",
      'site/net.py': 'import requests\nimport onnxruntime as ort\n',
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    expect(r.unusedPackages.map((u) => [u.name, u.confidence])).toEqual([['nvidia-cuda-runtime-cu12', 'low']]);
  });
});

describe('env vars', () => {
  it('does not read UPPER_SNAKE constants and settings as env vars', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': pkg({ firebase: '10' }),
      'src/constants.ts': 'export const ZOOM_STEP = 0.1;\nexport const RADAR_PADDING = 4;\n',
      'src/firebase.ts':
        "import { initializeApp } from 'firebase/app';\nlet FIREBASE_CONFIG: object;\nFIREBASE_CONFIG = JSON.parse(import.meta.env.VITE_APP_FIREBASE_CONFIG);\ninitializeApp(FIREBASE_CONFIG);\n",
      '.env.development': 'VITE_APP_FIREBASE_CONFIG={}\n',
      'settings.py': "SENTRY_ENABLED = getattr(configuration, 'SENTRY_ENABLED', False)\n",
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    expect(r.integrations.map((i) => [i.vendor.id, i.verdict])).toEqual([['firebase', 'keep']]);
  });

  it('keeps secrets that only CI or deploy config uses; cuts ones only an .env file lists', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': pkg({}),
      '.github/workflows/deploy.yml': 'jobs:\n  deploy:\n    env:\n      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n',
      '.env.example': 'MIXPANEL_TOKEN=\n',
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    const byId = Object.fromEntries(r.integrations.map((i) => [i.vendor.id, i]));
    expect(byId['cloudflare-api']?.verdict).toBe('keep');
    expect(byId['cloudflare-api']?.reasons[0]).toMatch(/Only set in CI \/ deploy config/);
    expect(byId.mixpanel?.verdict).toBe('cut');
  });

  it('ignores env vars the hosting platform sets when judging "switched off"', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': pkg({ '@vercel/analytics': '1' }),
      'app/a.ts': "import { inject } from '@vercel/analytics';\nif (process.env.VERCEL_ENV === 'production') inject();\n",
      '.env.example': 'DATABASE_URL=\n',
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    expect(r.integrations.find((i) => i.vendor.id === 'vercel-analytics')?.verdict).toBe('keep');
  });
});

describe('monorepos', () => {
  it('credits a dependency used by a sibling workspace that does not declare it', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': pkg({}, { workspaces: ['packages/*'] }),
      'packages/app/package.json': pkg({ 'perfect-freehand': '1' }),
      'packages/element/package.json': pkg({}),
      'packages/element/src/shape.ts': "import { getStroke } from 'perfect-freehand';\n",
    });
    expect(await unusedNames(dir)).toEqual([]);
  });

  it('calls out a redundant copy, and credits the root manifest with every workspace', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': pkg({ ai: '5' }, { workspaces: ['apps/*', 'packages/*'] }),
      'apps/web/package.json': pkg({ 'react-rnd': '10' }),
      'packages/ui/package.json': pkg({ 'react-rnd': '10', ai: '5' }),
      'packages/ui/field.tsx': "import { Rnd } from 'react-rnd';\nimport { generateObject } from 'ai';\n",
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    expect(r.unusedPackages.map((u) => u.name)).toEqual(['react-rnd']);
    expect(r.unusedPackages[0]!.reason).toMatch(/packages\/ui imports it and declares it too, so this copy is redundant/);
  });
});

describe('packages used without an import', () => {
  it('sees CLIs, hooks, tool config files, node_modules paths, builders and createRequire', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': pkg(
        { 'react-email': '3', 'js-cookie': '3', '@angular/build': '19', '@bull-board/ui': '6', '@bull-board/api': '6', 'lint-staged': '15', husky: '9' },
        { scripts: { email: 'email dev --port 3333' } },
      ),
      'bundle.cjs': "copy({ source: './node_modules/js-cookie/dist/js.cookie.min.js' });\n",
      'angular.json': JSON.stringify({ projects: { app: { architect: { build: { builder: '@angular/build:application' } } } } }),
      'src/jobs.ts': "import { createBullBoard } from '@bull-board/api';\nconst _require = createRequire(import.meta.url);\nconst ui = _require.resolve('@bull-board/ui/package.json');\n",
      '.lintstagedrc.json': '{ "*.ts": "eslint" }\n',
      '.husky/pre-commit': 'npx lint-staged\n',
    });
    expect(await unusedNames(dir)).toEqual([]);
  });

  it('knows companions: peers, unstorage drivers, meta-packages, Angular and Nuxt', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': pkg({
        '@angular/core': '19',
        '@angular/compiler': '19',
        '@rx-angular/template': '19',
        '@rx-angular/cdk': '19',
        unstorage: '1',
        '@vercel/kv': '3',
        '@upstash/redis': '1',
        'radix-ui': '1',
        nuxt: '3',
        '@nuxt/devtools': '1',
        '@vueuse/math': '11',
      }),
      'src/a.ts':
        "import { Component } from '@angular/core';\nimport { RxLet } from '@rx-angular/template/let';\nimport vercelKV from 'unstorage/drivers/vercel-kv';\nimport * as Tooltip from '@radix-ui/react-tooltip';\n",
      'nuxt.config.ts': 'export default defineNuxtConfig({ devtools: { enabled: true } })\n',
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    // @vueuse/math may be auto-imported by Nuxt: reported, but only as "double-check".
    expect(r.unusedPackages.map((u) => [u.name, u.confidence])).toEqual([['@vueuse/math', 'low']]);
    // @vercel/kv is a vendor SDK loaded by its unstorage driver: in use, not "installed but never imported".
    expect(r.integrations.find((i) => i.vendor.id === 'vercel')?.verdict ?? 'keep').toBe('keep');
  });
});

describe('duplicates', () => {
  it('needs two libraries the code really uses', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'package.json': pkg({}, { devDependencies: { vitest: '2', '@types/jest': '29', 'jest-diff': '29' }, scripts: { test: 'vitest run' } }),
      'src/a.test.ts': "import { describe } from 'vitest';\nimport { diff } from 'jest-diff';\n",
    });
    const r = await scan({ paths: [dir], config: {}, git: false });
    expect(r.duplicates).toEqual([]);
  });
});

describe('config lookup', () => {
  it('uses the scanned repo config (or its root), never the one in the current folder', async () => {
    const repo = join(tempDir(), 'mono');
    writeFiles(repo, {
      'stackprune.yml': 'exclude:\n  - legacy\n',
      'packages/web/package.json': pkg({ lodash: '4' }),
      'packages/web/legacy/a.js': "require('lodash')\n",
    });
    initRepo(repo);
    commit(repo, 'init');
    // From a subfolder: the repo-root config applies, so legacy/ is excluded and lodash is unused.
    const r = await scan({ paths: [join(repo, 'packages/web')], git: false });
    expect(r.unusedPackages.map((u) => u.name)).toEqual(['lodash']);
  });
});
