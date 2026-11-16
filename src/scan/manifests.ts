import type { Ecosystem } from '../types.js';

export interface DeclaredPackage {
  ecosystem: Ecosystem;
  name: string;
  dev: boolean;
  line?: number;
}

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function findLine(text: string, needle: string): number | undefined {
  const i = text.indexOf(needle);
  return i === -1 ? undefined : lineOf(text, i);
}

export class ManifestError extends Error {}

/** Throws ManifestError for JSON manifests that can't be parsed (so the caller can warn). */
export function parseManifestStrict(fileName: string, text: string): DeclaredPackage[] {
  if (fileName.endsWith('.json')) {
    try {
      JSON.parse(text);
    } catch (e) {
      throw new ManifestError(`could not parse ${fileName}: ${(e as Error).message}`);
    }
  }
  return parseManifest(fileName, text);
}

export function parseManifest(fileName: string, text: string): DeclaredPackage[] {
  try {
    if (fileName === 'package.json') return parsePackageJson(text);
    if (fileName === 'composer.json') return parseComposer(text);
    if (fileName === 'go.mod') return parseGoMod(text);
    if (fileName === 'Gemfile') return parseGemfile(text);
    if (fileName === 'Pipfile') return parseTomlTables(text, 'pypi', (t) => (t === 'packages' ? false : t === 'dev-packages' ? true : undefined));
    if (fileName === 'pyproject.toml') return parsePyproject(text);
    if (fileName === 'Cargo.toml') return parseTomlTables(text, 'cargo', (t) => (t === 'dependencies' || /^target\..+\.dependencies$/.test(t) ? false : /dev-dependencies|build-dependencies/.test(t) ? true : undefined));
    if (fileName.endsWith('.csproj')) return parseCsproj(text);
    if (/^requirements/i.test(fileName)) return parseRequirements(text, /dev|test|lint|doc/i.test(fileName));
  } catch {
    /* malformed manifest: ignore */
  }
  return [];
}

function parsePackageJson(text: string): DeclaredPackage[] {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const out: DeclaredPackage[] = [];
  const sections: [string, boolean][] = [
    ['dependencies', false],
    ['peerDependencies', false],
    ['optionalDependencies', false],
    ['devDependencies', true],
  ];
  for (const [section, dev] of sections) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      out.push({ ecosystem: 'npm', name, dev, line: findLine(text, `"${name}"`) });
    }
  }
  return out;
}

function parseComposer(text: string): DeclaredPackage[] {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const out: DeclaredPackage[] = [];
  for (const [section, dev] of [['require', false], ['require-dev', true]] as const) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      if (name === 'php' || name.startsWith('ext-')) continue;
      out.push({ ecosystem: 'composer', name, dev, line: findLine(text, `"${name}"`) });
    }
  }
  return out;
}

function parseGoMod(text: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const add = (spec: string, index: number) => {
    if (/\/\/\s*indirect/.test(spec)) return;
    const name = spec.trim().split(/\s+/)[0];
    if (name) out.push({ ecosystem: 'go', name, dev: false, line: lineOf(text, index) });
  };
  const block = /^require\s*\(([\s\S]*?)^\)/gm;
  let m: RegExpExecArray | null;
  while ((m = block.exec(text))) {
    let offset = m.index + m[0].indexOf('(') + 1;
    for (const l of (m[1] ?? '').split('\n')) {
      if (l.trim() && !l.trim().startsWith('//')) add(l, offset);
      offset += l.length + 1;
    }
  }
  const single = /^require\s+([^\s(][^\n]*)$/gm;
  while ((m = single.exec(text))) add(m[1] ?? '', m.index);
  return out;
}

function parseGemfile(text: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const groupStack: boolean[] = [];
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const l = raw.trim();
    const group = /^group\s+(.+?)\s+do\b/.exec(l);
    if (group) {
      groupStack.push(/:development|:test|"development"|"test"|'development'|'test'/.test(group[1] ?? '') && !/:production/.test(group[1] ?? ''));
      return;
    }
    if (/^(platforms?|source|install_if|git|path)\b.*\bdo\b/.test(l)) {
      groupStack.push(groupStack.at(-1) ?? false);
      return;
    }
    if (l === 'end') {
      groupStack.pop();
      return;
    }
    const gem = /^gem\s+['"]([^'"]+)['"](.*)$/.exec(l);
    if (gem?.[1]) {
      const inlineDev = /group[s]?:\s*\[?[^\]]*:(development|test)/.test(gem[2] ?? '');
      out.push({ ecosystem: 'rubygems', name: gem[1], dev: inlineDev || groupStack.some(Boolean), line: i + 1 });
    }
  });
  return out;
}

function parseCsproj(text: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  const re = /<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) if (m[1]) out.push({ ecosystem: 'nuget', name: m[1], dev: false, line: lineOf(text, m.index) });
  return out;
}

const REQ_NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*)/;

function parseRequirements(text: string, dev: boolean): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.replace(/#.*/, '').trim();
    if (!l || l.startsWith('-') || l.includes('://')) return;
    const m = REQ_NAME.exec(l);
    if (m?.[1]) out.push({ ecosystem: 'pypi', name: m[1], dev, line: i + 1 });
  });
  return out;
}

/** Extracts package names from PEP 508 strings inside a TOML array (possibly multi-line). */
function pep508Names(arrayBody: string): string[] {
  const names: string[] = [];
  const re = /["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arrayBody))) {
    const n = REQ_NAME.exec(m[1]!.trim());
    if (n?.[1]) names.push(n[1]);
  }
  return names;
}

function parsePyproject(text: string): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  let table = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.replace(/\s+#.*$/, '').trim();
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(l);
    if (header) {
      table = header[1]!.trim();
      continue;
    }
    const isDevTable = /dev|test|lint|docs?\b/.test(table);
    // PEP 621 / PEP 735 arrays: dependencies = [ ... ], <extra> = [ ... ]
    const arr = /^([\w.-]+|"[^"]+")\s*=\s*\[(.*)$/.exec(l);
    if (arr && (table === 'project' || table === 'project.optional-dependencies' || table === 'dependency-groups')) {
      const key = arr[1]!.replace(/"/g, '');
      if (table === 'project' && key !== 'dependencies') continue;
      let body = arr[2] ?? '';
      const start = i;
      while (!body.includes(']') && i + 1 < lines.length) body += `\n${lines[++i]}`;
      const dev = table === 'dependency-groups' ? /dev|test|lint|docs?/.test(key) : table === 'project.optional-dependencies' ? /dev|test|lint|docs?/.test(key) : false;
      for (const name of pep508Names(body)) out.push({ ecosystem: 'pypi', name, dev, line: start + 1 });
      continue;
    }
    // Poetry: [tool.poetry.dependencies] name = "^1.0"
    if (/^tool\.poetry(\.group\.[\w-]+)?\.(dev-)?dependencies$/.test(table)) {
      const kv = /^([A-Za-z0-9][\w.-]*)\s*=/.exec(l);
      if (kv?.[1] && kv[1] !== 'python') out.push({ ecosystem: 'pypi', name: kv[1], dev: isDevTable, line: i + 1 });
    }
  }
  return out;
}

function parseTomlTables(text: string, ecosystem: Ecosystem, devForTable: (table: string) => boolean | undefined): DeclaredPackage[] {
  const out: DeclaredPackage[] = [];
  let dev: boolean | undefined;
  text.split('\n').forEach((raw, i) => {
    const l = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(l);
    if (header) {
      dev = devForTable(header[1]!.trim());
      return;
    }
    if (dev === undefined) return;
    const kv = /^"?([A-Za-z0-9][\w.-]*)"?\s*=/.exec(l);
    if (kv?.[1]) out.push({ ecosystem, name: kv[1], dev, line: i + 1 });
  });
  return out;
}
