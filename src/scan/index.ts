import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { jsPackageName, type Catalog } from '../catalog/index.js';
import type { Ecosystem, Evidence, TargetHit, Vendor } from '../types.js';
import { parseEnvNames } from './env.js';
import { parseManifestStrict, type DeclaredPackage } from './manifests.js';
import { extract } from './source.js';
import { walk, type WalkedFile } from './walk.js';

export interface Target {
  name: string;
  group?: string;
  root: string;
}

/** Everything the package checks need to know about one target, beyond vendor evidence. */
export interface ProjectFacts {
  /** Every declared dependency, all ecosystems. */
  declared: (DeclaredPackage & { file: string })[];
  /** `${ecosystem}:${name}` → files that import it (npm: package name, pypi: dotted module, go: import path). */
  imports: Map<string, Set<string>>;
  /** Quoted strings in Python files that look like module names (Django INSTALLED_APPS & co.). */
  pyStrings: Set<string>;
  /** package.json scripts, Dockerfiles, Procfiles, shell scripts, CI workflows. */
  scriptsText: string;
  /** Tool config files (.eslintrc, babel/postcss/vite/next configs, tsconfig, package.json minus deps). */
  configText: string;
  /** File extensions present (".ts", ".scss", …). */
  exts: Set<string>;
  /** Basenames of files present that matter for implicit-use rules (tsconfig.json, postcss.config.js, …). */
  markerFiles: Set<string>;
  /** Every env var name read in code or set in env / CI / deploy files. */
  envNames: Set<string>;
  /** Env var names set somewhere outside code: .env files, CI workflows, Dockerfiles, compose, deploy configs. */
  declaredEnv: Set<string>;
  /** Every hostname seen in code (including comments). */
  hosts: Set<string>;
  envFiles: number;
  /** package.json "name"s inside this target (workspace packages are not third-party). */
  workspaceNames: Set<string>;
}

export interface TargetScan {
  target: Target;
  files: number;
  truncated: boolean;
  /** vendor id → hit */
  hits: Map<string, TargetHit>;
  /** URL hosts found in code that matched no vendor → files referencing them */
  unknownHosts: Map<string, Set<string>>;
  /** Ecosystems whose import statements we can resolve for this target */
  importAware: Set<Ecosystem>;
  warnings: string[];
  facts: ProjectFacts;
}

const IMPORT_AWARE: Record<string, Ecosystem> = { js: 'npm', python: 'pypi', go: 'go', ruby: 'rubygems', rust: 'cargo' };
const IMPORT_ECO: Partial<Record<NonNullable<WalkedFile['lang']>, Ecosystem>> = { js: 'npm', css: 'npm', python: 'pypi', go: 'go' };
const JS_CONFIG_FILE = /(^|\/)(\.?[\w-]+\.config\.[cm]?[jt]s|\.[\w-]+rc\.[cm]?js|metro\.config\.js|app\.config\.[jt]s|\.storybook\/main\.[jt]s)$/;
/** Comment words that mark a file as an experiment rather than production code. */
const EXPERIMENT =
  /\b(spike|poc|proof[- ]of[- ]concept|experiment(al)?|prototype|playground|scratch|versuch|testlauf|probelauf|do not ship|remove before (merge|release))\b|\b(local|lokale[rn]?|quick|temporary|temp|tempor(ä|ae)re[rn]?|just a|nur ein)\b[^.]{0,30}\btest\b|\w-test\b|\btest[- ]?(only|setup|integration)\b/i;

export function scanTarget(target: Target, catalog: Catalog, opts: { exclude?: string[] } = {}): TargetScan {
  const { files, truncated, names } = walk(target.root, { exclude: opts.exclude });
  const hits = new Map<string, TargetHit>();
  const unknownHosts = new Map<string, Set<string>>();
  const importAware = new Set<Ecosystem>();
  const warnings: string[] = [];
  if (truncated) warnings.push(`${target.name}: stopped after ${files.length} files; use \`exclude:\` to skip generated folders`);
  const vendorDeclared: (DeclaredPackage & { file: string; vendor: Vendor })[] = [];
  const facts: ProjectFacts = {
    declared: [],
    imports: new Map(),
    pyStrings: new Set(),
    scriptsText: '',
    configText: '',
    exts: new Set(),
    markerFiles: new Set(names),
    envNames: new Set(),
    declaredEnv: new Set(),
    hosts: new Set(),
    envFiles: 0,
    workspaceNames: new Set(),
  };
  const scripts: string[] = [];
  const configs: string[] = [];

  const add = (vendor: Vendor, ev: Evidence) => {
    let hit = hits.get(vendor.id);
    if (!hit) hits.set(vendor.id, (hit = { target: target.name, group: target.group, root: target.root, evidence: [] }));
    // de-duplicate identical evidence (same kind, file, detail)
    if (!hit.evidence.some((e) => e.kind === ev.kind && e.file === ev.file && e.detail === ev.detail)) hit.evidence.push(ev);
  };
  const noteImport = (eco: Ecosystem, name: string, file: string) => {
    const key = `${eco}:${name}`;
    let s = facts.imports.get(key);
    if (!s) facts.imports.set(key, (s = new Set()));
    s.add(file);
  };

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // binary

    const name = basename(file.rel);
    facts.exts.add(extname(name).toLowerCase());
    facts.markerFiles.add(name);

    if (file.kind === 'manifest') {
      let pkgs: DeclaredPackage[] = [];
      try {
        pkgs = parseManifestStrict(name, text);
      } catch (e) {
        warnings.push(`${target.name}/${file.rel}: ${(e as Error).message}`);
      }
      for (const pkg of pkgs) {
        facts.declared.push({ ...pkg, file: file.rel });
        const vendor = catalog.matchPackage(pkg.ecosystem, pkg.name);
        if (!vendor) continue;
        vendorDeclared.push({ ...pkg, file: file.rel, vendor });
        add(vendor, { kind: 'manifest', file: file.rel, line: pkg.line, detail: pkg.name, ecosystem: pkg.ecosystem, dev: pkg.dev || file.test });
      }
      if (name === 'package.json') {
        const { scriptsText, rest, pkgName } = splitPackageJson(text);
        scripts.push(scriptsText);
        configs.push(rest);
        if (pkgName) facts.workspaceNames.add(pkgName);
      }
      continue;
    }

    if (file.kind === 'env' && !/\.ya?ml$/.test(name)) {
      facts.envFiles++;
      for (const { name: envName, line } of parseEnvNames(text)) {
        facts.envNames.add(envName);
        facts.declaredEnv.add(envName);
        const vendor = catalog.matchEnv(envName);
        if (vendor) add(vendor, { kind: 'env-declared', file: file.rel, line, detail: envName, dev: file.test });
      }
      continue;
    }
    if (file.kind === 'env') facts.envFiles++; // docker-compose

    if (file.kind === 'script' || (file.kind === 'config' && file.rel.includes('.github/workflows/'))) scripts.push(text);
    if (file.kind === 'config' || JS_CONFIG_FILE.test(file.rel)) configs.push(text);

    if (file.lang && IMPORT_AWARE[file.lang]) importAware.add(IMPORT_AWARE[file.lang]!);
    const f = extract(file, text);
    const inCode = file.kind === 'source';

    let marker: string | undefined;
    for (const { spec, line } of f.imports) {
      const eco = file.lang ? IMPORT_ECO[file.lang] : undefined;
      if (eco === 'npm') {
        const pkg = jsPackageName(spec);
        if (pkg) noteImport('npm', pkg, file.rel);
      } else if (eco) noteImport(eco, spec, file.rel);

      const vendor = matchImport(catalog, file.lang, spec);
      if (vendor) {
        marker ??= experimentMarker(text);
        add(vendor, { kind: 'import', file: file.rel, line, detail: spec, dev: file.test, ...(marker ? { marker } : {}) });
      }
    }
    for (const pkg of f.nodeModulesRefs) noteImport('npm', pkg, file.rel);
    if (file.lang === 'python') for (const m of text.matchAll(/['"]([a-z_][a-z0-9_.]*)['"]/g)) facts.pyStrings.add(m[1]!);
    for (const { vendorId, detail, line } of f.awsServices) {
      const vendor = catalog.byId.get(vendorId);
      if (vendor) add(vendor, { kind: 'import', file: file.rel, line, detail, dev: file.test });
    }
    for (const [token, line] of f.envTokens) {
      facts.envNames.add(token);
      if (!inCode) facts.declaredEnv.add(token);
      const vendor = catalog.matchEnv(token);
      if (vendor) add(vendor, { kind: inCode ? 'env-referenced' : 'env-declared', file: file.rel, line, detail: token, dev: file.test });
    }
    for (const [host, line] of f.hosts) {
      facts.hosts.add(host);
      const vendor = catalog.matchHost(host);
      if (vendor) add(vendor, { kind: 'host', file: file.rel, line, detail: host, dev: file.test });
    }
    if (inCode && !file.test) {
      for (const host of f.codeUrlHosts) {
        if (catalog.matchHost(host)) continue;
        let s = unknownHosts.get(host);
        if (!s) unknownHosts.set(host, (s = new Set()));
        s.add(file.rel);
      }
    }
  }
  facts.scriptsText = scripts.join('\n');
  facts.configText = configs.join('\n');

  // Packages wired up from scripts rather than imports: `node -r dd-trace/init`, `sentry-cli`, Dockerfile NODE_OPTIONS, …
  for (const pkg of vendorDeclared) {
    if (pkg.ecosystem !== 'npm') continue;
    if (scriptMentions(facts.scriptsText, pkg.name)) add(pkg.vendor, { kind: 'import', file: 'scripts', detail: `${pkg.name} (script)` });
  }
  // Config files that reference a declared package by name (Expo config plugins, Babel/Next plugins, …)
  for (const pkg of vendorDeclared) {
    const t = facts.configText;
    if (['"', "'"].some((q) => t.includes(`${q}${pkg.name}${q}`) || t.includes(`${q}${pkg.name}/`) || t.includes(`${q}${pkg.name}:`))) {
      add(pkg.vendor, { kind: 'import', file: 'config', detail: `${pkg.name} (config)` });
    }
  }

  return { target, files: files.length, truncated, hits, unknownHosts, importAware, warnings, facts };
}

/** The file's header comment, if it calls the file a test / spike / PoC / experiment. */
function experimentMarker(text: string): string | undefined {
  const header = text.split('\n').slice(0, 12);
  for (const raw of header) {
    const l = raw.trim();
    if (!/^(\/\/|#|\*|\/\*|<!--|""")/.test(l)) {
      if (l && !/^(import|from|'use |"use |package |export )/.test(l)) break; // code started
      continue;
    }
    const comment = l.replace(/^(\/\/+|#+|\/?\*+|<!--|""")\s*/, '').replace(/\*\/$/, '').trim();
    if (EXPERIMENT.test(comment) && !/eslint|prettier|ts-|@type|license|copyright/i.test(comment)) return comment.slice(0, 120);
  }
  return undefined;
}

function matchImport(catalog: Catalog, lang: WalkedFile['lang'], spec: string): Vendor | undefined {
  switch (lang) {
    case 'js':
    case 'css':
      return catalog.matchJsImport(spec);
    case 'python':
      return catalog.matchPythonModule(spec);
    case 'go':
      return catalog.matchGoImport(spec);
    case 'ruby':
      return catalog.matchPackage('rubygems', spec) ?? catalog.matchPackage('rubygems', spec.split('/')[0]!) ?? catalog.matchPackage('rubygems', spec.replace(/\//g, '-'));
    case 'rust':
      return catalog.matchPackage('cargo', spec) ?? catalog.matchPackage('cargo', spec.replace(/_/g, '-'));
    default:
      return undefined;
  }
}

/** package.json → its scripts, everything that isn't a dependency list, and its name. */
function splitPackageJson(text: string): { scriptsText: string; rest: string; pkgName?: string } {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const scriptsText = Object.values((pkg.scripts as Record<string, string>) ?? {}).join('\n');
    const rest = { ...pkg };
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'scripts', 'name', 'version', 'description']) delete rest[k];
    return { scriptsText, rest: JSON.stringify(rest), pkgName: typeof pkg.name === 'string' ? pkg.name : undefined };
  } catch {
    return { scriptsText: '', rest: '' };
  }
}

export function scriptMentions(text: string, word: string): boolean {
  const re = new RegExp(`(^|[\\s'"=(;&|])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s'"/@)=;&|])`, 'm');
  return re.test(text);
}
