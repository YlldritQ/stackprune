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
  /** Why an unused package is low confidence, when there's a specific reason. */
  hint?: string;
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
  'react-email': ['email'],
  '@react-router/serve': ['react-router-serve'],
  '@react-router/dev': ['react-router'],
  '@remix-run/dev': ['remix'],
  '@remix-run/serve': ['remix-serve'],
  'markdownlint-cli': ['markdownlint'],
  '@stoplight/spectral-cli': ['spectral'],
  'spectral-cli-bundle': ['spectral'],
  '@redocly/cli': ['redocly'],
  '@hey-api/openapi-ts': ['openapi-ts'],
  '@docusaurus/core': ['docusaurus'],
  '@sveltejs/kit': ['svelte-kit'],
  '@lingui/cli': ['lingui'],
  concurrently: ['concurrently', 'conc'],
  storybook: ['storybook', 'sb'],
  '@storybook/cli': ['storybook', 'sb'],
  '@microsoft/api-extractor': ['api-extractor'],
  'npm-check-updates': ['ncu'],
  '@electron-forge/cli': ['electron-forge'],
  '@swc/cli': ['swc'],
  '@babel/cli': ['babel'],
  '@babel/node': ['babel-node'],
  '@tauri-apps/cli': ['tauri'],
  '@capacitor/cli': ['cap'],
  '@ionic/cli': ['ionic'],
  'webpack-cli': ['webpack'],
  'ts-patch': ['tspc', 'ts-patch'],
  '@vercel/ncc': ['ncc'],
  '@cloudflare/wrangler': ['wrangler'],
  'supabase': ['supabase'],
  '@nx/cli': ['nx'],
  'vue-tsc': ['vue-tsc'],
};

/**
 * Packages pulled in by another package or by convention rather than an import.
 * Either side may end in `*`: `'@aws-sdk/*'` is any used AWS SDK client, `'pytest-*'` any pytest plugin.
 */
const PEERS: Record<string, string[]> = {
  react: ['react-dom', 'react-is', 'scheduler'],
  'react-dom': ['scheduler'],
  '@angular/core': ['@angular/compiler', '@angular/platform-browser', '@angular/platform-browser-dynamic', 'zone.js', 'rxjs', 'tslib'],
  '@angular/compiler-cli': ['@angular/compiler', 'typescript'],
  '@angular/build': ['@angular/compiler-cli', '@angular/compiler', 'typescript'],
  '@angular-devkit/build-angular': ['@angular/compiler-cli', '@angular/compiler', 'typescript'],
  '@rx-angular/template': ['@rx-angular/cdk'],
  '@rx-angular/state': ['@rx-angular/cdk'],
  '@docusaurus/core': ['@mdx-js/react', 'prism-react-renderer', 'clsx', 'react', 'react-dom'],
  '@docusaurus/preset-classic': ['@docusaurus/core', '@mdx-js/react', 'prism-react-renderer'],
  'docusaurus-lunr-search': ['lunr'],
  '@easyops-cn/docusaurus-search-local': ['lunr'],
  // unstorage loads its driver's client package by name (`unstorage/drivers/vercel-kv` → @vercel/kv)
  unstorage: ['@vercel/kv', '@upstash/redis', 'ioredis', '@netlify/blobs', '@planetscale/database', '@azure/*', '@capacitor/preferences', 'idb-keyval', 'mongodb', 'uploadthing', 'aws4fetch', 'db0', '@deno/kv'],
  '@vercel/kv': ['@upstash/redis'],
  '@vueuse/integrations': ['focus-trap', 'async-validator', 'axios', 'change-case', 'drauu', 'fuse.js', 'idb-keyval', 'jwt-decode', 'nprogress', 'qrcode', 'sortablejs', 'universal-cookie'],
  nuxt: ['vue', 'vue-router', '@nuxt/devtools', '@nuxt/kit', '@nuxt/schema', 'unimport', 'h3', 'nitropack', 'ofetch', 'unstorage', '@unhead/vue', 'vue-tsc'],
  unocss: ['@iconify/json', '@iconify-json/*', '@unocss/*'],
  '@unocss/nuxt': ['@iconify/json', '@iconify-json/*', 'unocss'],
  '@unocss/preset-icons': ['@iconify/json', '@iconify-json/*'],
  '@vitejs/plugin-vue': ['vue', '@vue/compiler-sfc'],
  vue: ['@vue/compiler-sfc', 'vue-template-compiler'],
  'babel-plugin-react-compiler': ['react-compiler-runtime'],
  'eslint-config-airbnb': ['eslint-plugin-import', 'eslint-plugin-react', 'eslint-plugin-jsx-a11y', 'eslint-plugin-react-hooks'],
  'eslint-config-airbnb-base': ['eslint-plugin-import'],
  'eslint-config-airbnb-typescript': ['eslint-plugin-import', '@typescript-eslint/eslint-plugin', '@typescript-eslint/parser'],
  'eslint-config-standard': ['eslint-plugin-import', 'eslint-plugin-n', 'eslint-plugin-promise'],
  'eslint-config-next': ['eslint-plugin-react', 'eslint-plugin-react-hooks', 'eslint-plugin-jsx-a11y', 'eslint-plugin-import'],
  'eslint-plugin-import': ['eslint-import-resolver-typescript', 'eslint-import-resolver-node'],
  'eslint-plugin-import-x': ['eslint-import-resolver-typescript'],
  '@floating-ui/react-dom': ['@floating-ui/dom'],
  '@floating-ui/react': ['@floating-ui/dom', '@floating-ui/react-dom'],
  // pino transports are named by string: transport: { target: 'pino-pretty' }
  pino: ['pino-pretty', 'pino-std-serializers', 'thread-stream'],
  '@react-router/dev': ['@react-router/node', '@react-router/serve', 'isbot'],
  '@remix-run/dev': ['@remix-run/node', '@remix-run/serve', 'isbot'],
  '@lingui/core': ['@lingui/macro', '@lingui/babel-plugin-lingui-macro', '@lingui/swc-plugin'],
  '@lingui/react': ['@lingui/macro'],
  '@aws-sdk/*': ['@aws-sdk/signature-v4-crt', 'aws-crt'],
  'size-limit': ['@size-limit/*'],
  '@sveltejs/kit': ['svelte', '@sveltejs/adapter-*', '@sveltejs/vite-plugin-svelte'],
  '@playwright/test': ['playwright', 'playwright-core'],
  'webpack-cli': ['webpack', 'webpack-dev-server'],
  'ts-jest': ['jest', 'typescript'],
  '@tanstack/react-query': ['@tanstack/query-core'],
  '@testing-library/react': ['@testing-library/dom'],
  '@testing-library/user-event': ['@testing-library/dom'],
  'react-native-reanimated': ['react-native-worklets'],
  mongoose: ['mongodb'],
  bullmq: ['ioredis'],
  bull: ['ioredis'],
  'isomorphic-dompurify': ['dompurify', 'jsdom'],
  'graphql-ws': ['ws'],
  '@bull-board/*': ['@bull-board/ui'],
  graphiql: ['graphql'],
  '@graphiql/*': ['graphql', 'graphiql'],
  'django-tables2': ['tablib'],
  'django-import-export': ['tablib'],
  '@prisma/adapter-pg': ['pg'],
  '@prisma/adapter-neon': ['@neondatabase/serverless', 'ws'],
  '@prisma/adapter-planetscale': ['@planetscale/database'],
  '@prisma/adapter-libsql': ['@libsql/client'],
  // Python: plugins that load themselves once installed
  pytest: ['pytest-*', 'pluggy'],
  flake8: ['flake8-*', 'pep8-naming'],
  mkdocs: ['mkdocs-*', 'mkdocstrings', 'mkdocstrings-*', 'pymdown-extensions'],
  sphinx: ['sphinx-*', 'sphinxcontrib-*', 'furo', 'myst-parser'],
  requests: ['certifi', 'charset-normalizer', 'idna', 'urllib3'],
  click: ['colorama'],
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

/** Meta-packages whose own dependencies the code imports directly: `radix-ui` → `@radix-ui/react-tooltip`. */
const PROVIDES: Record<string, string[]> = {
  'radix-ui': ['@radix-ui/'],
  firebase: ['@firebase/'],
  'aws-amplify': ['@aws-amplify/'],
  storybook: ['@storybook/'],
  'react-native': ['@react-native/'],
  '@mui/material': ['@mui/system', '@mui/base', '@mui/utils'],
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
  'faiss-gpu': ['faiss'],
  'tensorflow-cpu': ['tensorflow'],
  'huggingface-hub': ['huggingface_hub'],
  'social-auth-app-django': ['social_django'],
  'social-auth-core': ['social_core'],
  'strawberry-graphql': ['strawberry'],
  'strawberry-graphql-django': ['strawberry_django'],
  'python3-saml': ['onelogin'],
  'django-storage-swift': ['swift'],
  'drf-spectacular': ['drf_spectacular'],
  'pymdown-extensions': ['pymdownx'],
  'mkdocs-material': ['material'],
  'grpcio': ['grpc'],
  'grpcio-tools': ['grpc_tools'],
  'grpcio-status': ['grpc_status'],
  'opentelemetry-api': ['opentelemetry'],
  'opentelemetry-sdk': ['opentelemetry.sdk'],
  'python-json-logger': ['pythonjsonlogger'],
  'pyserial': ['serial'],
  'pymupdf': ['fitz', 'pymupdf'],
  'python-ldap': ['ldap'],
  'dnspython': ['dns'],
  'pyzmq': ['zmq'],
  'pyopenssl': ['OpenSSL'],
  'pynacl': ['nacl'],
  'pygithub': ['github'],
  'python-telegram-bot': ['telegram'],
  'discord.py': ['discord'],
  'opencv-contrib-python': ['cv2'],
  'opencv-contrib-python-headless': ['cv2'],
  'setuptools': ['setuptools', 'pkg_resources'],
  'pywin32': ['win32api', 'win32con', 'win32com', 'pywintypes'],
  'pillow-avif-plugin': ['pillow_avif'],
  'pytorch-lightning': ['pytorch_lightning', 'lightning'],
};

/** Python tools used from the command line (or loaded by the interpreter), not imported. */
const PY_CLI = new Set(['gunicorn', 'uvicorn', 'hypercorn', 'daphne', 'waitress', 'pytest', 'black', 'ruff', 'flake8', 'mypy', 'isort', 'pylint', 'pre-commit', 'coverage', 'alembic', 'celery', 'flower', 'tox', 'nox', 'invoke', 'honcho', 'supervisor', 'pip-tools', 'setuptools', 'wheel', 'build', 'twine', 'poetry', 'bandit', 'autopep8', 'yapf', 'pyright', 'mkdocs', 'sphinx', 'locust', 'pip', 'uv', 'hatch', 'hatchling', 'pdm', 'flit', 'maturin', 'cython', 'pyinstaller', 'jupyter', 'jupyterlab', 'notebook', 'ipython', 'ipykernel', 'debugpy', 'tzdata', 'codespell', 'pyupgrade', 'django-upgrade', 'pip-audit', 'safety', 'vulture', 'deptry']);

/** Tool config files that prove a tool is set up, even if nothing in scripts names it. */
const TOOL_CONFIG: [RegExp, RegExp][] = [
  [/^lint-staged$/, /^(\.lintstagedrc(\.\w+)?|lint-staged\.config\.[cm]?[jt]s)$/],
  [/^@commitlint\/cli$/, /^(\.commitlintrc(\.\w+)?|commitlint\.config\.[cm]?[jt]s)$/],
  [/^stylelint$/, /^(\.stylelintrc(\.\w+)?|stylelint\.config\.[cm]?[jt]s)$/],
  [/^jest$/, /^jest\.config\./],
  [/^vitest$/, /^vitest\.(config|workspace)\./],
  [/^@playwright\/test$/, /^playwright\.config\./],
  [/^cypress$/, /^cypress\.config\./],
  [/^size-limit$/, /^\.size-limit(\.\w+)?$/],
  [/^markdownlint-cli2?$/, /^\.markdownlint(-cli2)?(\.\w+)?$/],
  [/^knip$/, /^\.?knip\.(json|jsonc|ts|js)$/],
  [/^syncpack$/, /^\.syncpackrc(\.\w+)?$/],
  [/^semantic-release$/, /^(\.releaserc(\.\w+)?|release\.config\.[cm]?js)$/],
  [/^release-it$/, /^\.release-it\.\w+$/],
  [/^lerna$/, /^lerna\.json$/],
  [/^turbo$/, /^turbo\.json$/],
  [/^nx$/, /^nx\.json$/],
  [/^(svelte|@sveltejs\/kit)$/, /^svelte\.config\./],
  [/^astro$/, /^astro\.config\./],
  [/^nuxt$/, /^nuxt\.config\./],
  [/^gatsby$/, /^gatsby-config\./],
  [/^@docusaurus\/core$/, /^docusaurus\.config\./],
  [/^wrangler$/, /^wrangler\.(toml|json|jsonc)$/],
  [/^vercel$/, /^vercel\.json$/],
  [/^netlify-cli$/, /^netlify\.toml$/],
  [/^drizzle-kit$/, /^drizzle\.config\./],
  [/^tsup$/, /^tsup\.config\./],
  [/^rollup$/, /^rollup\.config\./],
  [/^@swc\/core$/, /^\.swcrc$/],
  [/^unocss$/, /^(uno|unocss)\.config\./],
  [/^@biomejs\/biome$/, /^biome\.jsonc?$/],
  [/^oxlint$/, /^\.?oxlintrc\.json$/],
  [/^typedoc$/, /^typedoc\.json$/],
  [/^@remix-run\/dev$/, /^remix\.config\./],
  [/^@react-router\/dev$/, /^react-router\.config\./],
  [/^electron-builder$/, /^electron-builder\./],
  [/^nodemon$/, /^nodemon\.json$/],
  [/^pm2$/, /^ecosystem\.config\./],
  [/^@nestjs\/cli$/, /^nest-cli\.json$/],
  [/^@angular\/cli$/, /^angular\.json$/],
  [/^karma$/, /^karma\.conf\./],
  [/^lefthook$/, /^lefthook\.ya?ml$/],
  [/^dependency-cruiser$/, /^\.dependency-cruiser\./],
  [/^@lhci\/cli$/, /^lighthouserc\./],
  [/^@lingui\/cli$/, /^lingui\.config\./],
  [/^@graphql-codegen\/cli$/, /^codegen\.(ya?ml|ts|js|json)$/],
  [/^@hey-api\/openapi-ts$/, /^openapi-ts\.config\./],
  [/^orval$/, /^orval\.config\./],
  [/^cspell$/, /^(\.?cspell\.json|cspell\.config\.\w+)$/],
  [/^@rsbuild\/core$/, /^rsbuild\.config\./],
  [/^@rspack\/cli$/, /^rspack\.config\./],
  [/^webpack-cli$/, /^webpack\.config\./],
  [/^eas-cli$/, /^eas\.json$/],
  [/^detox$/, /^\.detoxrc/],
  [/^mkdocs$/, /^mkdocs\.ya?ml$/],
];

/** Vue/Nuxt libraries that auto-import setups (Nuxt, unplugin-auto-import) use without an import line. */
const AUTO_IMPORTABLE = /^(@vueuse\/|@vue\/|vue-|pinia$|@pinia\/|@headlessui\/vue|@unhead\/|@nuxt\/|@nuxtjs\/|@formkit\/|floating-vue$)|[-/]vue$/;
const AUTO_IMPORT_TOOLS = ['nuxt', 'unplugin-auto-import', 'unplugin-vue-components', '@nuxt/kit'];

/** The part after a scope that usually names another package's building block, not a feature. */
const BUILDING_BLOCK = /^(core|cdk|shared|common|compiler|runtime|utils?|base|types|kit|engine|internal|dom|server|client|parser|message-compiler|[\w-]+-(core|runtime|shared|compiler|common))$/;

/** Tool-plugin style names: likely referenced by short names in config. Lower confidence. */
const PLUGIN_LIKE = /^(@[\w-]+\/)?(eslint|babel|postcss|prettier|stylelint|webpack|rollup|vite|esbuild|remark|rehype|tailwindcss|commitlint|jest|karma|gulp|grunt|metro|typedoc|unplugin)[-/]|(-loader|-plugin|-preset|-config)$|^@types\//;

export function checkPackages(scan: TargetScan): PackageUse[] {
  const { facts } = scan;
  const declaredNames = new Set(facts.declared.map((d) => d.name));
  const declaredPy = new Set(facts.declared.filter((d) => d.ecosystem === 'pypi').map((d) => normPy(d.name)));
  const anyImported = (eco: Ecosystem, name: string) => facts.imports.has(`${eco}:${name}`);
  const usedNames = new Set<string>(); // grows as we resolve, for peer rules
  const autoImports = AUTO_IMPORT_TOOLS.some((t) => declaredNames.has(t));
  const owners = declaringDirs(facts);
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
    const files = importFiles(facts, d, owners);
    let usedBy: UsedBy | undefined;
    let via: string | undefined;
    const stubs = d.ecosystem === 'pypi' ? stubsBase(d.name) : undefined;
    const provided = d.ecosystem === 'npm' ? providedImport(facts, d.name, declaredNames) : undefined;
    if (files.length) usedBy = 'import';
    else if (provided) {
      usedBy = 'import';
      via = provided;
    } else if (d.ecosystem === 'npm' && d.name.startsWith('@types/')) {
      const base = typesBase(d.name);
      if (declaredNames.has(base) || anyImported('npm', base) || base === 'node' || facts.configText.includes(`"${base}"`) || BUILTIN_TYPES.has(base)) {
        usedBy = 'types';
        via = base;
      }
    } else if (stubs) {
      // types-requests, django-stubs: type stubs for another package
      if (declaredPy.has(normPy(stubs)) || pyModulesOf(stubs).some((m) => pyImported(facts, m))) {
        usedBy = 'types';
        via = stubs;
      }
    } else if (binsOf(scan, d).some((b) => scriptMentions(facts.scriptsText, b)) || scriptMentions(facts.scriptsText, d.name)) usedBy = 'script';
    else if (configMentions(facts.configText, d.name) || (d.ecosystem === 'pypi' && pyModulesOf(d.name).some((m) => pyConfigMention(facts.configText, m)))) usedBy = 'config';
    else if ((via = toolConfigFile(facts, d.name))) usedBy = 'config';
    else if (d.ecosystem === 'pypi' && (PY_CLI.has(normPy(d.name)) || pyModulesOf(d.name).some((m) => pyStringMention(facts, m)))) usedBy = PY_CLI.has(normPy(d.name)) ? 'script' : 'config';
    if (usedBy) {
      usedNames.add(d.ecosystem === 'pypi' ? normPy(d.name) : d.name);
      out.push(use(d, true, usedBy, files, via));
    } else pending.push({ d, files });
  }

  const installedPeers = readInstalledPeers(scan, usedNames);
  for (const { d, files } of pending) {
    const implicit = implicitUse(facts, d.name);
    const peerOf = implicit ? undefined : peerSource(d.ecosystem === 'pypi' ? normPy(d.name) : d.name, usedNames, installedPeers);
    if (implicit) out.push(use(d, true, 'implicit', files, implicit));
    else if (peerOf) out.push(use(d, true, 'peer', files, peerOf));
    else out.push(use(d, false, undefined, files));
  }
  return out;

  function use(d: DeclaredPackage & { file: string }, used: boolean, usedBy: UsedBy | undefined, files: string[], via?: string): PackageUse {
    const isNative = /^(react-native-|@react-native|@react-navigation\/|expo-|@expo\/)/.test(d.name) && (declaredNames.has('expo') || declaredNames.has('react-native'));
    let low = d.dev || PLUGIN_LIKE.test(d.name) || isNative;
    let hint: string | undefined;
    if (!used) {
      const sibling = buildingBlockOf(d.name, usedNames);
      const elsewhere = importedElsewhere(facts, d);
      if (elsewhere.length) return { ...base(), hint: `${list(elsewhere)} import${elsewhere.length === 1 ? 's' : ''} it and declare${elsewhere.length === 1 ? 's' : ''} it too, so this copy is redundant` };
      if (d.optional) hint = 'an optional extra, often imported inside try/except';
      else if (d.ecosystem === 'pypi' && /^nvidia-|-cu\d+$/.test(normPy(d.name))) hint = 'a native GPU runtime, loaded by another library';
      else if (d.ecosystem === 'pypi' && stubsBase(d.name)) hint = 'type stubs';
      else if (autoImports && AUTO_IMPORTABLE.test(d.name)) hint = 'this project auto-imports, so it can be used without an import line';
      else if (sibling) hint = `may be a dependency of ${sibling}`;
      if (hint) low = true;
    }
    return { ...base(), ...(hint ? { hint } : {}) };

    function base(): PackageUse {
      return { ecosystem: d.ecosystem, name: d.name, dev: d.dev, manifest: d.file, line: d.line, used, usedBy, via, files, confidence: low ? 'low' : 'high' };
    }
  }
}

function list(items: string[], max = 2): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} +${items.length - max} more`;
}

/** An import of a package this meta-package brings in, which the project doesn't declare itself. */
function providedImport(facts: ProjectFacts, name: string, declared: Set<string>): string | undefined {
  const prefixes = PROVIDES[name];
  if (!prefixes) return undefined;
  for (const key of facts.imports.keys()) {
    if (!key.startsWith('npm:')) continue;
    const pkg = key.slice(4);
    if (!declared.has(pkg) && prefixes.some((p) => (p.endsWith('/') ? pkg.startsWith(p) : pkg === p))) return pkg;
  }
  return undefined;
}

/** `@scope/cdk` unused while `@scope/template` is used: the former is probably the latter's dependency. */
function buildingBlockOf(name: string, used: Set<string>): string | undefined {
  const m = /^(@[^/]+)\/(.+)$/.exec(name);
  if (!m || !BUILDING_BLOCK.test(m[2]!)) return undefined;
  return [...used].find((u) => u !== name && u.startsWith(`${m[1]}/`));
}

function normPy(name: string): string {
  return name.toLowerCase().replace(/[_.]/g, '-');
}

/** types-requests → requests, django-stubs → django, boto3-stubs → boto3. */
function stubsBase(dist: string): string | undefined {
  const n = normPy(dist);
  if (n.startsWith('types-')) return n.slice(6);
  if (n.endsWith('-stubs')) return n.slice(0, -6);
  return undefined;
}

/** A dotted path in a Python string: INSTALLED_APPS 'taggit', MIDDLEWARE 'debug_toolbar.middleware.X'. */
function pyStringMention(facts: ProjectFacts, mod: string): boolean {
  if (facts.pyStrings.has(mod)) return true;
  for (const s of facts.pyStrings) if (s.startsWith(`${mod}.`)) return true;
  return false;
}

function pyImported(facts: ProjectFacts, mod: string): boolean {
  for (const key of facts.imports.keys()) if (key === `pypi:${mod}` || key.startsWith(`pypi:${mod}.`)) return true;
  return false;
}

/** A module name in YAML/TOML config: mkdocs `- pymdownx.superfences`, `plugins: [mkdocstrings]`. */
function pyConfigMention(text: string, mod: string): boolean {
  if (!text || mod.length < 6) return false;
  return new RegExp(`(^|[^\\w.-])${mod.replace(/[.]/g, '\\.')}(?=[.:'"\\s,\\]]|$)`, 'm').test(text);
}

/** A config file for this tool exists (.lintstagedrc, jest.config.ts, …). Returns its name. */
function toolConfigFile(facts: ProjectFacts, name: string): string | undefined {
  for (const [pkg, file] of TOOL_CONFIG) {
    if (!pkg.test(name)) continue;
    for (const f of facts.markerFiles) if (file.test(f)) return f;
  }
  return undefined;
}

const dirOf = (file: string) => (dirname(file) === '.' ? '' : `${dirname(file)}/`);
const ownerKey = (d: DeclaredPackage) => `${d.ecosystem}:${d.ecosystem === 'pypi' ? normPy(d.name) : d.name}`;

/** package → folders whose manifest declares it. */
function declaringDirs(facts: ProjectFacts): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of facts.declared) {
    const k = ownerKey(d);
    const dirs = out.get(k) ?? [];
    if (!dirs.includes(dirOf(d.file))) dirs.push(dirOf(d.file));
    out.set(k, dirs);
  }
  return out;
}

const BUILTIN_TYPES = new Set(['jest', 'mocha', 'jasmine', 'node', 'web', 'webpack-env', 'testing-library__jest-dom']);

function typesBase(name: string): string {
  const raw = name.slice('@types/'.length);
  return raw.includes('__') ? `@${raw.replace('__', '/')}` : raw;
}

/**
 * Files that import this declaration. An import belongs to the nearest folder that declares the
 * package; an import from a folder that doesn't declare it at all (a hoisted dependency used by a
 * sibling workspace) counts for every manifest that does.
 */
function importFiles(facts: ProjectFacts, d: DeclaredPackage & { file: string }, owners: Map<string, string[]>): string[] {
  const all = new Set<string>();
  if (d.ecosystem === 'npm') {
    for (const f of facts.imports.get(`npm:${d.name}`) ?? []) all.add(f);
  } else if (d.ecosystem === 'pypi') {
    const mods = pyModulesOf(d.name);
    const dist = normPy(d.name);
    for (const [key, set] of facts.imports) {
      if (!key.startsWith('pypi:')) continue;
      const mod = key.slice(5);
      const top = mod.split('.')[0]!;
      // onnxruntime-gpu / psycopg2-binary / tensorflow-macos provide the module of their base name
      const variant = top.length >= 4 && dist.startsWith(`${normPy(top)}-`);
      if (variant || mods.some((m) => mod === m || mod.startsWith(`${m}.`))) for (const f of set) all.add(f);
    }
  } else if (d.ecosystem === 'go') {
    for (const [key, set] of facts.imports) {
      if (!key.startsWith('go:')) continue;
      const p = key.slice(3);
      if (p === d.name || p.startsWith(`${d.name}/`)) for (const f of set) all.add(f);
    }
  }
  const dir = dirOf(d.file);
  // The root manifest's packages are visible to every workspace (shared / hoisted deps).
  if (!dir) return [...all].sort();
  const dirs = (owners.get(ownerKey(d)) ?? [dir]).filter(Boolean);
  return [...all]
    .filter((f) => {
      const mine = dirs.filter((x) => f.startsWith(x));
      if (!mine.length) return true;
      return mine.reduce((a, b) => (b.length > a.length ? b : a)) === dir;
    })
    .sort();
}

/** Folders that import a package but declare it themselves, for "this copy is redundant". */
function importedElsewhere(facts: ProjectFacts, d: DeclaredPackage & { file: string }): string[] {
  if (d.ecosystem !== 'npm') return [];
  const files = facts.imports.get(`npm:${d.name}`);
  if (!files?.size) return [];
  const dirs = new Set<string>();
  for (const f of files) {
    const owner = facts.declared
      .filter((x) => x.name === d.name && x.file !== d.file && f.startsWith(dirOf(x.file)))
      .map((x) => dirOf(x.file))
      .sort((a, b) => b.length - a.length)[0];
    if (owner) dirs.add(owner.replace(/\/$/, '') || '.');
  }
  return [...dirs].sort();
}

function pyModulesOf(dist: string): string[] {
  const n = normPy(dist);
  const known = PY_MODULES[n];
  if (known) return known;
  const out = new Set<string>();
  const add = (x: string) => out.add(x.replace(/[-.]/g, '_'));
  add(n);
  out.add(n.replace(/-/g, '.'));
  add(n.replace(/^python3?-/, '').replace(/-python3?$/, '').replace(/^py-/, ''));
  if (n.startsWith('django-')) add(n.slice('django-'.length)); // django-taggit → taggit
  const parts = n.split('-');
  if (parts.length >= 3) add(parts.slice(1).join('-')); // netboxlabs-netbox-branching → netbox_branching
  return [...out];
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
  const q = (s: string) => ['"', "'", '`'].some((c) => text.includes(`${c}${s}${c}`) || text.includes(`${c}${s}/`) || text.includes(`${c}${s}:`));
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
    case 'vue':
      return ext('.vue') ? '.vue files' : undefined;
    case 'svelte':
      return ext('.svelte') ? '.svelte files' : undefined;
    case 'astro':
      return ext('.astro') ? '.astro files' : undefined;
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
  const is = (pattern: string, n: string) => (pattern.endsWith('*') ? n.startsWith(pattern.slice(0, -1)) : pattern === n);
  for (const [parent, peers] of Object.entries(PEERS)) {
    if (!peers.some((p) => is(p, name))) continue;
    if (parent.endsWith('*')) {
      const hit = [...used].find((u) => u !== name && is(parent, u));
      if (hit) return hit;
    } else if (parent !== name && used.has(parent)) return parent;
  }
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
