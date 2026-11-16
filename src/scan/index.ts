import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Catalog } from '../catalog/index.js';
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
}

const IMPORT_AWARE: Record<string, Ecosystem> = { js: 'npm', python: 'pypi', go: 'go', ruby: 'rubygems', rust: 'cargo' };

export function scanTarget(target: Target, catalog: Catalog, opts: { exclude?: string[] } = {}): TargetScan {
  const { files, truncated } = walk(target.root, { exclude: opts.exclude });
  const hits = new Map<string, TargetHit>();
  const unknownHosts = new Map<string, Set<string>>();
  const importAware = new Set<Ecosystem>();
  const warnings: string[] = [];
  if (truncated) warnings.push(`${target.name}: stopped after ${files.length} files; use \`exclude:\` to skip generated folders`);
  const declared: (DeclaredPackage & { file: string; vendor: Vendor })[] = [];

  const add = (vendor: Vendor, ev: Evidence) => {
    let hit = hits.get(vendor.id);
    if (!hit) hits.set(vendor.id, (hit = { target: target.name, group: target.group, root: target.root, evidence: [] }));
    // de-duplicate identical evidence (same kind, file, detail)
    if (!hit.evidence.some((e) => e.kind === ev.kind && e.file === ev.file && e.detail === ev.detail)) hit.evidence.push(ev);
  };

  const scripts: { file: WalkedFile; text: string }[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue; // binary

    const name = basename(file.rel);
    if (file.kind === 'manifest') {
      let pkgs: DeclaredPackage[] = [];
      try {
        pkgs = parseManifestStrict(name, text);
      } catch (e) {
        warnings.push(`${target.name}/${file.rel}: ${(e as Error).message}`);
      }
      for (const pkg of pkgs) {
        const vendor = catalog.matchPackage(pkg.ecosystem, pkg.name);
        if (!vendor) continue;
        declared.push({ ...pkg, file: file.rel, vendor });
        add(vendor, { kind: 'manifest', file: file.rel, line: pkg.line, detail: pkg.name, ecosystem: pkg.ecosystem, dev: pkg.dev || file.test });
      }
      if (name === 'package.json') scripts.push({ file, text: packageScripts(text) });
      continue;
    }

    if (file.kind === 'env' && !/\.ya?ml$/.test(name)) {
      for (const { name: envName, line } of parseEnvNames(text)) {
        const vendor = catalog.matchEnv(envName);
        if (vendor) add(vendor, { kind: 'env-declared', file: file.rel, line, detail: envName, dev: file.test });
      }
      continue;
    }

    if (file.kind === 'script') scripts.push({ file, text });

    if (file.lang && IMPORT_AWARE[file.lang]) importAware.add(IMPORT_AWARE[file.lang]!);
    const f = extract(file, text);
    const inCode = file.kind === 'source';

    for (const { spec, line } of f.imports) {
      const vendor = matchImport(catalog, file.lang, spec);
      if (vendor) add(vendor, { kind: 'import', file: file.rel, line, detail: spec, dev: file.test });
    }
    for (const { vendorId, detail, line } of f.awsServices) {
      const vendor = catalog.byId.get(vendorId);
      if (vendor) add(vendor, { kind: 'import', file: file.rel, line, detail, dev: file.test });
    }
    for (const [token, line] of f.envTokens) {
      const vendor = catalog.matchEnv(token);
      if (vendor) add(vendor, { kind: inCode ? 'env-referenced' : 'env-declared', file: file.rel, line, detail: token, dev: file.test });
    }
    for (const [host, line] of f.hosts) {
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

  // Packages wired up from scripts rather than imports: `node -r dd-trace/init`, `sentry-cli`, Dockerfile NODE_OPTIONS, …
  for (const { file, text } of scripts) {
    for (const pkg of declared) {
      if (pkg.ecosystem !== 'npm') continue;
      if (scriptMentions(text, pkg.name)) add(pkg.vendor, { kind: 'import', file: file.rel, detail: `${pkg.name} (script)`, dev: file.test });
    }
  }

  // Config files that reference a declared package by name (Expo config plugins, Babel/Next plugins, …)
  for (const file of files) {
    if (file.kind !== 'config' || !/\.(json|ya?ml|toml)$/.test(file.rel)) continue;
    let text: string;
    try {
      text = readFileSync(file.abs, 'utf8');
    } catch {
      continue;
    }
    for (const pkg of declared) {
      if (text.includes(`"${pkg.name}"`) || text.includes(`"${pkg.name}/`) || text.includes(`'${pkg.name}'`)) {
        add(pkg.vendor, { kind: 'import', file: file.rel, detail: `${pkg.name} (config)`, dev: file.test });
      }
    }
  }

  return { target, files: files.length, truncated, hits, unknownHosts, importAware, warnings };
}

function matchImport(catalog: Catalog, lang: WalkedFile['lang'], spec: string): Vendor | undefined {
  switch (lang) {
    case 'js':
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

function packageScripts(text: string): string {
  try {
    const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
    return Object.values(pkg.scripts ?? {}).join('\n');
  } catch {
    return '';
  }
}

function scriptMentions(text: string, pkg: string): boolean {
  const re = new RegExp(`(^|[\\s'"=(])${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s'"/@)])`, 'm');
  return re.test(text);
}
