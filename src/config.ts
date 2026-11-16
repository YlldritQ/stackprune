import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Config } from './types.js';

export const CONFIG_FILES = ['stackprune.yml', 'stackprune.yaml', '.stackprune.yml', '.stackprune.yaml', 'stackprune.json', '.stackprune.json'];

export function findConfig(dirs: string[]): string | undefined {
  for (const dir of dirs) {
    for (const f of CONFIG_FILES) {
      const p = join(resolve(dir), f);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

export function loadConfig(path?: string): Config {
  if (!path) return {};
  const text = readFileSync(path, 'utf8');
  const raw = (path.endsWith('.json') ? JSON.parse(text) : parseYaml(text)) as unknown;
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path}: expected a mapping at the top level`);
  const cfg = raw as Config;
  for (const v of cfg.vendors ?? []) {
    if (!v.id || !v.name) throw new Error(`${path}: every entry under "vendors" needs an id and a name`);
  }
  return cfg;
}
