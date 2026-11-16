import { registrableDomain } from '../hosts.js';
import type { Catalog } from '../catalog/index.js';
import type { Ecosystem, Vendor } from '../types.js';
import type { TargetScan } from './index.js';

/**
 * Finds vendor SDKs the catalog doesn't know.
 *
 * A dependency is treated as a third-party service when its name lines up with a
 * credential-looking env var (`@telemetrix/otel-browser` + `REACT_APP_TELEMETRIX_PUBLISHABLE_KEY`)
 * or with an external API domain in the code (`acme-sdk` + `api.acme.io`).
 * That's how small, recently added SaaS SDKs get caught before anyone adds them to a catalog.
 */
export function detectUnlistedVendors(scans: TargetScan[], catalog: Catalog): Vendor[] {
  const envNames = new Set<string>();
  const hostDomains = new Map<string, string>(); // first label → registrable domain
  for (const s of scans) {
    s.facts.envNames.forEach((e) => envNames.add(e));
    // Only URLs used in code (not comments, not tests), so docs links don't count.
    for (const h of s.unknownHosts.keys()) {
      const d = registrableDomain(h);
      const label = d.split('.')[0]!;
      if (!hostDomains.has(label)) hostDomains.set(label, d);
    }
  }

  const found = new Map<string, Vendor>();
  for (const s of scans) {
    for (const d of s.facts.declared) {
      if (d.ecosystem !== 'npm' && d.ecosystem !== 'pypi' && d.ecosystem !== 'go') continue;
      if (catalog.matchPackage(d.ecosystem, d.name) || s.facts.workspaceNames.has(d.name)) continue;
      const token = vendorToken(d.ecosystem, d.name);
      if (!token || GENERIC.has(token) || catalog.byId.has(token) || found.has(token)) continue;

      const TOKEN = token.toUpperCase().replace(/-/g, '_');
      // Scoped packages (@acme/…) are almost always a vendor's SDK; for plain names
      // (axios, moment…) only a real secret counts, not a base URL.
      const scoped = d.ecosystem === 'npm' && d.name.startsWith('@');
      const credential = [...envNames].find((e) => {
        const bare = e.replace(/^(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|NUXT_PUBLIC_|PUBLIC_|GATSBY_)/, '');
        return bare.startsWith(`${TOKEN}_`) && (scoped ? CREDENTIAL : SECRET).test(bare);
      });
      const domain = hostDomains.get(token.replace(/-/g, '')) ?? hostDomains.get(token);
      if (!credential && !domain) continue;

      found.set(token, {
        id: token,
        name: token.charAt(0).toUpperCase() + token.slice(1),
        category: 'other',
        paid: true,
        detected: 'sdk',
        packages: { [d.ecosystem]: [scopeOrName(d.ecosystem, d.name)] } as Partial<Record<Ecosystem, string[]>>,
        env: [`${TOKEN}_*`, `NEXT_PUBLIC_${TOKEN}_*`, `VITE_${TOKEN}_*`, `REACT_APP_${TOKEN}_*`, `EXPO_PUBLIC_${TOKEN}_*`],
        hosts: domain ? [domain, `*.${domain}`] : [],
      });
    }
  }
  return [...found.values()];
}

/** Suffixes that are unmistakably a secret for a hosted service. */
const SECRET = /_(API_?KEY|SECRET|SECRET_KEY|ACCESS_KEY|ACCESS_TOKEN|PUBLISHABLE_KEY|WRITE_KEY|DSN|LICENSE_KEY)$/;
/** Env var suffixes that mean "this is a key for a hosted service". */
const CREDENTIAL = /_(API_?KEY|KEY|TOKEN|SECRET|SECRET_KEY|ACCESS_KEY|ACCESS_TOKEN|PUBLISHABLE_KEY|PUBLIC_KEY|CLIENT_ID|CLIENT_SECRET|APP_ID|PROJECT_ID|PROJECT_KEY|WRITE_KEY|DSN|LICENSE|LICENSE_KEY|ORG_ID|WORKSPACE_ID|ENDPOINT|URL|HOST)$/;

/** Words that show up as package scopes/prefixes without meaning "a vendor". */
const GENERIC = new Set([
  'types', 'react', 'next', 'vue', 'node', 'nodejs', 'babel', 'eslint', 'typescript', 'vite', 'vitejs', 'rollup', 'webpack', 'jest', 'vitest',
  'testing', 'testing-library', 'storybook', 'angular', 'nestjs', 'nuxt', 'svelte', 'sveltejs', 'expo', 'react-native', 'mui', 'emotion', 'tanstack',
  'radix-ui', 'headlessui', 'heroicons', 'fortawesome', 'opentelemetry', 'otel', 'aws', 'google', 'azure', 'microsoft', 'apollo', 'graphql', 'prisma',
  'trpc', 'reduxjs', 'redux', 'hookform', 'floating-ui', 'popperjs', 'formatjs', 'fontsource', 'tiptap', 'lexical', 'dnd-kit', 'use', 'app', 'api',
  'core', 'utils', 'lib', 'sdk', 'client', 'server', 'config', 'shared', 'common', 'ui', 'web', 'mobile', 'admin', 'internal', 'golang', 'github',
  'gitlab', 'x', 'go', 'gopkg', 'pkg', 'swc', 'esbuild', 'biomejs', 'changesets', 'commitlint', 'semantic-release', 'octokit', 'smithy', 'zod',
  'tailwindcss', 'headless', 'auth', 'db', 'database', 'data', 'log', 'logger', 'test', 'mock', 'mocks', 'dev', 'build', 'cli', 'docs', 'env',
  'socket', 'http', 'https', 'express', 'mongo', 'redis', 'mail', 'email', 'sms', 'push', 'jwt', 'crypto', 'file', 'image', 'pdf', 'map', 'maps',
]);

function vendorToken(eco: Ecosystem, name: string): string | undefined {
  if (eco === 'go') {
    // github.com/acme/acme-go → acme
    const parts = name.split('/');
    const owner = parts[0]?.includes('.') && parts[0] !== 'github.com' && parts[0] !== 'gitlab.com' ? registrableDomain(parts[0]).split('.')[0] : parts[1];
    return clean(owner);
  }
  if (eco === 'npm' && name.startsWith('@')) return clean(name.slice(1).split('/')[0]);
  // Plain names count only as a whole ("socket.io-client" → "socket.io", never "socket").
  const whole = name.replace(/^python-/, '').toLowerCase().replace(/[-_.]?(sdk|js|node|client|api)$/, '');
  return /^[a-z][a-z0-9]*$/.test(whole) ? clean(whole) : undefined;
}

function clean(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.toLowerCase().replace(/(-?(sdk|js|node|io|hq|app|api|client|dev))$/, '');
  return t.length >= 3 && /^[a-z][a-z0-9-]*$/.test(t) ? t : undefined;
}

function scopeOrName(eco: Ecosystem, name: string): string {
  if (eco === 'npm' && name.startsWith('@')) return `${name.split('/')[0]}/*`;
  return name;
}
