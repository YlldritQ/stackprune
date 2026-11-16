import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';

export const DEFAULT_EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.vercel',
  '.netlify',
  '.serverless',
  '.terraform',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.expo',
  '.gradle',
  '.idea',
  '.vscode',
  '.yarn',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  'site-packages',
  'vendor',
  'target',
  'Pods',
  'DerivedData',
  'coverage',
  'bower_components',
  'jspm_packages',
  'storybook-static',
  'graphify-out',
  '.stackprune',
]);

export type FileKind = 'source' | 'manifest' | 'env' | 'config' | 'script';

export interface WalkedFile {
  abs: string;
  rel: string; // posix-style, relative to root
  kind: FileKind;
  lang?: 'js' | 'python' | 'go' | 'ruby' | 'rust' | 'other';
  test: boolean;
  size: number;
}

const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro']);
const OTHER_SOURCE_EXT: Record<string, WalkedFile['lang']> = {
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.php': 'other',
  '.cs': 'other',
  '.java': 'other',
  '.kt': 'other',
  '.kts': 'other',
  '.swift': 'other',
  '.dart': 'other',
  '.scala': 'other',
  '.ex': 'other',
  '.exs': 'other',
  '.m': 'other',
};
const CONFIG_EXT = new Set(['.yml', '.yaml', '.toml', '.tf', '.tfvars', '.ini', '.conf', '.properties', '.gradle', '.xml', '.plist']);
const CONFIG_JSON = new Set(['app.json', 'app.config.json', 'vercel.json', 'netlify.json', 'firebase.json', 'eas.json', 'now.json', 'railway.json', 'render.json', 'fly.json', 'wrangler.json', 'wrangler.jsonc', 'serverless.json', 'appsettings.json', 'appsettings.Development.json', 'appsettings.Production.json']);
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'Pipfile', 'go.mod', 'Gemfile', 'composer.json', 'Cargo.toml']);
const SCRIPT_NAMES = new Set(['Dockerfile', 'Procfile', 'Makefile', 'Justfile', 'justfile']);
const MAX_BYTES = 768 * 1024;

export function isEnvFile(name: string): boolean {
  return (
    /^\.env(\.[\w.-]+)?$/.test(name) ||
    name === '.envrc' ||
    /^[\w.-]+\.env$/.test(name) ||
    /^[\w-]*\.?env\.(sample|template|example|dist|local|development|production|staging|test|dev|prod)$/.test(name)
  );
}

export function isTestPath(rel: string): boolean {
  return (
    /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|cypress|playwright|fixtures?|mocks?|stories|storybook|\.storybook)(\/|$)/i.test(rel) ||
    /\.(test|spec|e2e|stories|story)\.[a-z]+$/i.test(rel) ||
    /(^|\/)test_[^/]+\.py$/.test(rel) ||
    /_test\.(py|go)$/.test(rel)
  );
}

function classify(name: string, rel: string): Pick<WalkedFile, 'kind' | 'lang'> | undefined {
  if (MANIFESTS.has(name) || /^requirements([-_.][\w.-]+)?\.txt$/i.test(name) || name.endsWith('.csproj')) {
    return { kind: 'manifest' };
  }
  if (isEnvFile(name)) return { kind: 'env' };
  if (SCRIPT_NAMES.has(name) || name.startsWith('Dockerfile.') || name.endsWith('.Dockerfile') || name.endsWith('.sh')) return { kind: 'script' };
  if (/^(docker-)?compose([.-][\w-]+)?\.ya?ml$/.test(name)) return { kind: 'env' };
  if (/\.min\.[cm]?js$|\.bundle\.js$|\.chunk\.js$|\.d\.[cm]?ts$|\.map$/.test(name)) return undefined;
  const ext = extname(name).toLowerCase();
  if (JS_EXT.has(ext)) return { kind: 'source', lang: 'js' };
  const lang = OTHER_SOURCE_EXT[ext];
  if (lang) return { kind: 'source', lang };
  if (CONFIG_EXT.has(ext) || CONFIG_JSON.has(name)) {
    if (rel.includes('.github/') && ext !== '.yml' && ext !== '.yaml') return undefined;
    return { kind: 'config' };
  }
  return undefined;
}

export interface WalkOptions {
  exclude?: string[];
  maxFiles?: number;
}

/**
 * Walk a target directory. Skips dependency/build folders and nested git repositories
 * (they are separate targets), keeps files that can carry integration evidence.
 */
export function walk(root: string, opts: WalkOptions = {}): { files: WalkedFile[]; truncated: boolean } {
  const files: WalkedFile[] = [];
  const maxFiles = opts.maxFiles ?? 60_000;
  const extraExclude = (opts.exclude ?? []).map((e) => e.replace(/^\/+|\/+$/g, ''));
  let truncated = false;

  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (extraExclude.some((e) => rel === e || rel.startsWith(`${e}/`) || ent.name === e)) continue;
      if (ent.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(ent.name)) continue;
        if (existsSync(join(abs, 'pyvenv.cfg'))) continue; // python virtualenv with a custom name
        if (existsSync(join(abs, '.git'))) continue; // nested repo / worktree → its own target
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const c = classify(ent.name, rel);
      if (!c) continue;
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (size > MAX_BYTES) continue;
      files.push({ abs, rel, ...c, test: isTestPath(rel), size });
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, truncated };
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, truncated };
}

export function displayName(root: string): string {
  return basename(root);
}
