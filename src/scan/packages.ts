import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Ecosystem } from '../types.js';
import type { ProjectFacts, TargetScan } from './index.js';
import { scriptMentions } from './index.js';
import type { DeclaredPackage } from './manifests.js';

/** Ecosystems where "declared but never imported" is reliable enough to report. */
export const PACKAGE_CHECK_ECOSYSTEMS = new Set<Ecosystem>(['npm', 'pypi', 'go']);

export type UsedBy = 'import' | 'types' | 'script' | 'config' | 'peer' | 'implicit';

export interface PackageUse {
  ecosystem: Ecosystem;
  name: string;
  dev: boolean;
  manifest: string;
  line?: number;
  used: boolean;
  usedBy?: UsedBy;
  /** For peer/implicit use: which package or file pulls it in. */
  via?: string;
  /** Files (under the manifest's folder) that import it. */
  files: string[];
  /** "low" when we're more likely to be wrong (tool plugins, native modules, dev tooling). */
  confidence: 'high' | 'low';
}

/** Command names that differ from the package name. */
const KNOWN_BINS: Record<string, string[]> = {
  typescript: ['tsc', 'tsserver'],
  '@biomejs/biome': ['biome'],
  '@playwright/test': ['playwright'],
  '@nestjs/cli': ['nest'],
  '@angular/cli': ['ng'],
  '@vue/cli-service': ['vue-cli-service'],
  '@sentry/cli': ['sentry-cli'],
  'firebase-tools': ['firebase'],
  'netlify-cli': ['netlify'],
  'npm-run-all': ['run-s', 'run-p', 'npm-run-all'],
  'npm-run-all2': ['run-s', 'run-p', 'npm-run-all'],
  'dotenv-cli': ['dotenv'],
  'sequelize-cli': ['sequelize'],
  '@graphql-codegen/cli': ['graphql-codegen', 'gql-gen'],
  '@changesets/cli': ['changeset'],
  'expo-cli': ['expo'],
  '@expo/cli': ['expo'],
  'eas-cli': ['eas'],
  '@react-native-community/cli': ['react-native'],
  'ts-node-dev': ['ts-node-dev', 'tsnd'],
  'drizzle-kit': ['drizzle-kit'],
  'openapi-typescript': ['openapi-typescript'],
  '@svgr/cli': ['svgr'],
  'json-server': ['json-server'],
  '@commitlint/cli': ['commitlint'],
  'cross-env': ['cross-env'],
  'start-server-and-test': ['start-server-and-test', 'server-test'],
  'patch-package': ['patch-package'],
  'node-gyp': ['node-gyp'],
  'shx': ['shx'],
  'rimraf': ['rimraf'],
  'serve': ['serve'],
  'http-server': ['http-server'],
  'pm2': ['pm2', 'pm2-runtime'],
};

/** Packages pulled in by another package or by convention rather than an import. */
const PEERS: Record<string, string[]> = {
  react: ['react-dom', 'react-is', 'scheduler'],
  next: ['react', 'react-dom', 'sharp', '@next/font', 'eslint-config-next'],
  gatsby: ['react', 'react-dom'],
  '@remix-run/react': ['react', 'react-dom'],
  expo: ['react-native', 'react', 'react-dom', 'react-native-web', '@expo/metro-runtime', 'expo-constants', 'expo-linking', 'expo-modules-core', 'expo-asset', 'expo-font', 'expo-splash-screen', 'expo-status-bar', 'expo-system-ui', 'expo-dev-client', 'expo-updates', 'expo-build-properties', 'babel-preset-expo'],
  'expo-router': ['react-native-screens', 'react-native-safe-area-context', 'expo-linking', 'expo-constants', '@expo/metro-runtime', 'react-native-gesture-handler', '@react-navigation/native', '@react-navigation/bottom-tabs', '@react-navigation/drawer', '@react-navigation/elements', '@react-navigation/native-stack', '@react-navigation/stack'],
  '@react-navigation/native': ['react-native-screens', 'react-native-safe-area-context'],
  '@react-navigation/stack': ['react-native-gesture-handler'],
  '@react-navigation/drawer': ['react-native-gesture-handler', 'react-native-reanimated'],
  'react-native': ['react'],
  '@mui/material': ['@emotion/react', '@emotion/styled'],
  '@mui/x-date-pickers': ['dayjs', 'date-fns', 'moment', 'luxon'],
  '@mui/lab': ['@mui/material'],
  '@apollo/client': ['graphql'],
  'graphql-request': ['graphql'],
  'type-graphql': ['graphql', 'reflect-metadata', 'class-validator'],
  '@nestjs/core': ['reflect-metadata', 'rxjs', '@nestjs/platform-express'],
  '@nestjs/graphql': ['graphql', '@apollo/server'],
  typeorm: ['reflect-metadata', 'pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'mssql', 'oracledb'],
  sequelize: ['pg', 'pg-hstore', 'mysql2', 'sqlite3', 'tedious', 'mariadb'],
  knex: ['pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'tedious', 'oracledb'],
  '@mikro-orm/core': ['reflect-metadata'],
  'drizzle-orm': ['pg', 'postgres', 'mysql2', 'better-sqlite3', '@libsql/client'],
  'socket.io': ['bufferutil', 'utf-8-validate'],
  ws: ['bufferutil', 'utf-8-validate'],
  'chart.js': ['chartjs-adapter-date-fns', 'chartjs-adapter-moment', 'chartjs-adapter-luxon'],
  'react-chartjs-2': ['chart.js'],
  'styled-components': ['react-is'],
  'tailwindcss': ['postcss', 'autoprefixer'],
  vite: ['@vitejs/plugin-react', '@vitejs/plugin-react-swc', '@vitejs/plugin-vue'],
  jest: ['ts-jest', 'babel-jest', 'jest-environment-jsdom'],
  vitest: ['jsdom', 'happy-dom', '@vitest/coverage-v8', '@vitest/ui'],
  eslint: ['@typescript-eslint/parser', '@typescript-eslint/eslint-plugin', 'typescript-eslint'],
  '@prisma/client': ['prisma'],
  prisma: ['@prisma/client'],
  sqlalchemy: ['psycopg2', 'psycopg2-binary', 'psycopg', 'asyncpg', 'pymysql', 'mysqlclient', 'aiosqlite', 'cx-oracle', 'pyodbc'],
  django: ['psycopg2', 'psycopg2-binary', 'psycopg', 'mysqlclient', 'gunicorn', 'whitenoise'],
  fastapi: ['uvicorn', 'python-multipart', 'pydantic'],
  celery: ['redis', 'kombu', 'flower'],
  pandas: ['openpyxl', 'xlrd', 'pyarrow', 'fastparquet', 'sqlalchemy'],
};

/** pypi distribution name → import name, where they differ. */
const PY_MODULES: Record<string, string[]> = {
  beautifulsoup4: ['bs4'],
  pyyaml: ['yaml'],
  pillow: ['PIL'],
  'python-dotenv': ['dotenv'],
  'scikit-learn': ['sklearn'],
  'scikit-image': ['skimage'],
  'opencv-python': ['cv2'],
  'opencv-python-headless': ['cv2'],
  'python-dateutil': ['dateutil'],
  'python-jose': ['jose'],
  'python-multipart': ['multipart'],
  'python-slugify': ['slugify'],
  'python-magic': ['magic'],
  'pyjwt': ['jwt'],
  'protobuf': ['google.protobuf'],
  'google-api-python-client': ['googleapiclient'],
  'msgpack-python': ['msgpack'],
  'pymongo': ['pymongo', 'bson', 'gridfs'],
  'psycopg2-binary': ['psycopg2'],
  'mysqlclient': ['MySQLdb'],
  'pycryptodome': ['Crypto'],
  'pycryptodomex': ['Cryptodome'],
  'attrs': ['attr', 'attrs'],
  'djangorestframework': ['rest_framework'],
  'django-cors-headers': ['corsheaders'],
  'django-filter': ['django_filters'],
  'django-environ': ['environ'],
  'django-storages': ['storages'],
  'djangorestframework-simplejwt': ['rest_framework_simplejwt'],
  'typing-extensions': ['typing_extensions'],
  'websocket-client': ['websocket'],
  'ruamel.yaml': ['ruamel'],
  'email-validator': ['email_validator'],
  'pydantic-settings': ['pydantic_settings'],
  'faiss-cpu': ['faiss'],
  'tensorflow-cpu': ['tensorflow'],
};

/** Python tools used from the command line, not imported. */
const PY_CLI = new Set(['gunicorn', 'uvicorn', 'hypercorn', 'daphne', 'waitress', 'pytest', 'black', 'ruff', 'flake8', 'mypy', 'isort', 'pylint', 'pre-commit', 'coverage', 'alembic', 'celery', 'flower', 'tox', 'nox', 'invoke', 'honcho', 'supervisor', 'pip-tools', 'setuptools', 'wheel', 'build', 'twine', 'poetry', 'bandit', 'autopep8', 'yapf', 'pyright']);

/** Tool-plugin style names: likely referenced by short names in config. Lower confidence. */
const PLUGIN_LIKE = /^(@[\w-]+\/)?(eslint|babel|postcss|prettier|stylelint|webpack|rollup|vite|esbuild|remark|rehype|tailwindcss|commitlint|jest|karma|gulp|grunt|metro|typedoc|unplugin)[-/]|(-loader|-plugin|-preset|-config)$|^@types\//;

export function checkPackages(scan: TargetScan): PackageUse[] {
  const { facts } = scan;
  const declaredNames = new Set(facts.declared.map((d) => d.name));
  const anyImported = (eco: Ecosystem, name: string) => facts.imports.has(`${eco}:${name}`);
  const usedNames = new Set<string>(); // grows as we resolve, for peer rules
  const out: PackageUse[] = [];

  const relevant = facts.declared.filter(
    (d) =>
      PACKAGE_CHECK_ECOSYSTEMS.has(d.ecosystem) &&
      !d.indirect &&
      !/^(workspace:|file:|link:|portal:)/.test(d.version ?? '') &&
      !facts.workspaceNames.has(d.name) &&
      d.name !== 'python',
  );

  // Pass 1: direct evidence. Pass 2: peers/implicit, which depend on what pass 1 found.
  const pending: { d: (typeof relevant)[number]; files: string[] }[] = [];
  for (const d of relevant) {
    const dir = dirname(d.file) === '.' ? '' : `${dirname(d.file)}/`;
    const files = importFiles(facts, d, dir);
    let usedBy: UsedBy | undefined;
    let via: string | undefined;
    if (files.length) usedBy = 'import';
    else if (d.ecosystem === 'npm' && d.name.startsWith('@types/')) {
      const base = typesBase(d.name);
      if (declaredNames.has(base) || anyImported('npm', base) || base === 'node' || facts.configText.includes(`"${base}"`) || BUILTIN_TYPES.has(base)) {
        usedBy = 'types';
        via = base;
      }
    } else if (binsOf(scan, d).some((b) => scriptMentions(facts.scriptsText, b)) || scriptMentions(facts.scriptsText, d.name)) usedBy = 'script';
    else if (configMentions(facts.configText, d.name)) usedBy = 'config';
    else if (d.ecosystem === 'pypi' && (PY_CLI.has(d.name.toLowerCase()) || pyModulesOf(d.name).some((m) => facts.pyStrings.has(m)))) usedBy = PY_CLI.has(d.name.toLowerCase()) ? 'script' : 'config';
    if (usedBy) {
      usedNames.add(d.name);
      out.push(use(d, true, usedBy, files, via));
    } else pending.push({ d, files });
  }

  const installedPeers = readInstalledPeers(scan, usedNames);
  for (const { d, files } of pending) {
    const implicit = implicitUse(facts, d.name);
    const peerOf = implicit ? undefined : peerSource(d.name, usedNames, installedPeers);
    if (implicit) out.push(use(d, true, 'implicit', files, implicit));
    else if (peerOf) out.push(use(d, true, 'peer', files, peerOf));
    else out.push(use(d, false, undefined, files));
  }
  return out;

  function use(d: DeclaredPackage & { file: string }, used: boolean, usedBy: UsedBy | undefined, files: string[], via?: string): PackageUse {
    const isNative = /^(react-native-|@react-native|@react-navigation\/|expo-|@expo\/)/.test(d.name) && (declaredNames.has('expo') || declaredNames.has('react-native'));
    const confidence: PackageUse['confidence'] = d.dev || PLUGIN_LIKE.test(d.name) || isNative ? 'low' : 'high';
    return { ecosystem: d.ecosystem, name: d.name, dev: d.dev, manifest: d.file, line: d.line, used, usedBy, via, files, confidence };
  }
}

const BUILTIN_TYPES = new Set(['jest', 'mocha', 'jasmine', 'node', 'web', 'webpack-env', 'testing-library__jest-dom']);

function typesBase(name: string): string {
  const raw = name.slice('@types/'.length);
  return raw.includes('__') ? `@${raw.replace('__', '/')}` : raw;
}

function importFiles(facts: ProjectFacts, d: DeclaredPackage, dir: string): string[] {
  const files = new Set<string>();
  const inDir = (f: string) => !dir || f.startsWith(dir);
  if (d.ecosystem === 'npm') {
    for (const f of facts.imports.get(`npm:${d.name}`) ?? []) if (inDir(f)) files.add(f);
  } else if (d.ecosystem === 'pypi') {
    const mods = pyModulesOf(d.name);
    for (const [key, set] of facts.imports) {
      if (!key.startsWith('pypi:')) continue;
      const mod = key.slice(5);
      if (mods.some((m) => mod === m || mod.startsWith(`${m}.`))) for (const f of set) if (inDir(f)) files.add(f);
    }
  } else if (d.ecosystem === 'go') {
    for (const [key, set] of facts.imports) {
      if (!key.startsWith('go:')) continue;
      const p = key.slice(3);
      if (p === d.name || p.startsWith(`${d.name}/`)) for (const f of set) if (inDir(f)) files.add(f);
    }
  }
  return [...files].sort();
}

function pyModulesOf(dist: string): string[] {
  const n = dist.toLowerCase().replace(/_/g, '-');
  const known = PY_MODULES[n];
  if (known) return known;
  const base = n.replace(/^python-/, '').replace(/-python$/, '').replace(/^py-/, '');
  return [...new Set([n.replace(/[-.]/g, '_'), base.replace(/[-.]/g, '_'), n.replace(/-/g, '.')])];
}

/** Command names a package installs: from node_modules when present, else a built-in table. */
function binsOf(scan: TargetScan, d: DeclaredPackage & { file: string }): string[] {
  if (d.ecosystem !== 'npm') return [];
  const bins = new Set(KNOWN_BINS[d.name] ?? []);
  for (const base of [join(scan.target.root, dirname(d.file)), scan.target.root]) {
    const pj = join(base, 'node_modules', d.name, 'package.json');
    if (!existsSync(pj)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pj, 'utf8')) as { bin?: string | Record<string, string> };
      if (typeof pkg.bin === 'string') bins.add(d.name.split('/').pop()!);
      else for (const b of Object.keys(pkg.bin ?? {})) bins.add(b);
    } catch {
      /* ignore */
    }
    break;
  }
  return [...bins];
}

/** Short names tools use in config: eslint-plugin-react → "react", @babel/preset-env → "@babel/env"… */
function configMentions(text: string, name: string): boolean {
  if (!text) return false;
  const q = (s: string) => text.includes(`"${s}"`) || text.includes(`'${s}'`) || text.includes(`"${s}/`) || text.includes(`'${s}/`) || text.includes(`\`${s}\``);
  if (q(name)) return true;
  // unquoted object keys: `plugins: { tailwindcss: {}, autoprefixer: {} }`
  if (/^[a-z][\w-]*$/.test(name) && new RegExp(`(^|[\\s{,])['"]?${name.replace(/[-]/g, '\\-')}['"]?\\s*:`, 'm').test(text)) return true;
  const short: string[] = [];
  let m: RegExpMatchArray | null;
  if ((m = name.match(/^eslint-(?:plugin|config)-(.+)$/))) short.push(m[1]!, `plugin:${m[1]}/`);
  if ((m = name.match(/^(@[\w-]+)\/eslint-(?:plugin|config)(?:-(.+))?$/))) short.push(m[2] ? `${m[1]}/${m[2]}` : m[1]!, `plugin:${m[1]}/`);
  if ((m = name.match(/^babel-(?:plugin|preset)-(.+)$/))) short.push(m[1]!);
  if ((m = name.match(/^@babel\/(?:plugin|preset)-(.+)$/))) short.push(`@babel/${m[1]}`);
  if ((m = name.match(/^(?:stylelint|prettier)-(?:config|plugin)-(.+)$/))) short.push(m[1]!);
  if ((m = name.match(/^@commitlint\/config-(.+)$/))) short.push(`@commitlint/config-${m[1]}`);
  if ((m = name.match(/^postcss-(.+)$/))) short.push(name);
  return short.some((s) => (s.endsWith('/') ? text.includes(s) : q(s)));
}

/** Use by convention: a file type or config that makes a tool necessary. Returns the reason. */
function implicitUse(facts: ProjectFacts, name: string): string | undefined {
  const has = (f: string | RegExp) => (typeof f === 'string' ? facts.markerFiles.has(f) : [...facts.markerFiles].some((x) => f.test(x)));
  const ext = (e: string) => facts.exts.has(e);
  switch (name) {
    case 'typescript':
      return ext('.ts') || ext('.tsx') || has(/^tsconfig.*\.json$/) ? 'TypeScript files' : undefined;
    case 'react':
      return ext('.jsx') || ext('.tsx') ? 'JSX files (automatic JSX runtime)' : undefined;
    case 'next':
      return has(/^next\.config\./) || ((has('page.tsx') || has('page.jsx') || has('page.js')) && (has('layout.tsx') || has('layout.jsx') || has('layout.js'))) || has('_app.tsx') || has('_app.js') ? 'Next.js app' : undefined;
    case 'expo':
      return has('app.json') || has(/^app\.config\./) || has(/^eas\.json$/) ? 'Expo app config' : undefined;
    case 'react-native':
      return has(/^metro\.config\./) || has('app.json') ? 'React Native app' : undefined;
    case 'sass':
    case 'node-sass':
    case 'sass-embedded':
      return ext('.scss') || ext('.sass') ? '.scss files' : undefined;
    case 'less':
      return ext('.less') ? '.less files' : undefined;
    case 'stylus':
      return ext('.styl') ? '.styl files' : undefined;
    case 'postcss':
      return has(/^postcss\.config\./) || has('.postcssrc') || has('.postcssrc.json') ? 'postcss config' : undefined;
    case 'eslint':
      return has(/^\.eslintrc/) || has(/^eslint\.config\./) ? 'eslint config' : undefined;
    case 'prettier':
      return has(/^\.prettierrc/) || has(/^prettier\.config\./) || facts.configText.includes('"prettier"') ? 'prettier config' : undefined;
    case 'husky':
      return facts.markerFiles.has('pre-commit') || facts.configText.includes('husky') ? 'git hooks' : undefined;
    case 'webpack':
      return has(/^webpack\.config\./) ? 'webpack config' : undefined;
    case '@babel/core':
      return has(/^(\.babelrc|babel\.config\.)/) ? 'babel config' : undefined;
    case 'tslib':
      return facts.configText.includes('importHelpers') ? 'tsconfig importHelpers' : undefined;
    case 'core-js':
    case 'regenerator-runtime':
      return facts.configText.includes('useBuiltIns') ? 'babel useBuiltIns' : undefined;
    case 'vite':
      return has(/^vite\.config\./) ? 'vite config' : undefined;
    case 'tailwindcss':
      return has(/^tailwind\.config\./) ? 'tailwind config' : undefined;
    default:
      return undefined;
  }
}

/** A package required by another package that is in use (peer dependency or companion). */
function peerSource(name: string, used: Set<string>, installed: Map<string, string>): string | undefined {
  for (const [parent, peers] of Object.entries(PEERS)) if (peers.includes(name) && used.has(parent)) return parent;
  return installed.get(name);
}

/** peer → parent, from the real peerDependencies of installed packages (when node_modules exists). */
function readInstalledPeers(scan: TargetScan, used: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  const nm = join(scan.target.root, 'node_modules');
  if (!existsSync(nm)) return out;
  for (const parent of used) {
    const pj = join(nm, parent, 'package.json');
    if (!existsSync(pj)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pj, 'utf8')) as { peerDependencies?: Record<string, string> };
      for (const peer of Object.keys(pkg.peerDependencies ?? {})) if (!out.has(peer)) out.set(peer, parent);
    } catch {
      /* ignore */
    }
  }
  return out;
}
