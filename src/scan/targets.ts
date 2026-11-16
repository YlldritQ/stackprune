import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Target } from './index.js';
import { DEFAULT_EXCLUDE_DIRS } from './walk.js';

/**
 * Turn the paths the user passed into scan targets.
 * - A git repo (or a folder inside one) is one target.
 * - A plain folder that contains git repos is expanded into one target per repo
 *   (e.g. `~/code/acme` holding `api/`, `web/`, `mobile/`), grouped under the folder name.
 * - Anything else is scanned as a single folder.
 */
export function resolveTargets(paths: string[]): Target[] {
  const targets: Target[] = [];
  const seen = new Set<string>();
  const push = (t: Target) => {
    if (seen.has(t.root)) return;
    seen.add(t.root);
    targets.push(t);
  };

  for (const p of paths.length ? paths : ['.']) {
    const root = resolve(p);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Not a directory: ${p}`);
    if (existsSync(join(root, '.git')) || insideGitRepo(root)) {
      push({ name: basename(root), root });
      continue;
    }
    const children = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !DEFAULT_EXCLUDE_DIRS.has(d.name) && !d.name.startsWith('.'))
      .map((d) => join(root, d.name))
      .filter((d) => existsSync(join(d, '.git')));
    if (children.length) {
      for (const c of children.sort()) push({ name: basename(c), group: basename(root), root: c });
    } else {
      push({ name: basename(root), root });
    }
  }
  // Disambiguate duplicate names (two repos called "api" in different groups).
  const counts = new Map<string, number>();
  for (const t of targets) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  for (const t of targets) if ((counts.get(t.name) ?? 0) > 1 && t.group) t.name = `${t.group}/${t.name}`;
  return targets;
}

function insideGitRepo(dir: string): boolean {
  let cur = dir;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(cur, '.git'))) return true;
    const parent = resolve(cur, '..');
    if (parent === cur) return false;
    cur = parent;
  }
  return false;
}
