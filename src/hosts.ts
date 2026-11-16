/** Hosts that show up in code all the time but aren't integrations. */
const NOISE_EXACT = new Set([
  'localhost',
  'example.com',
  'example.org',
  'example.net',
  'schema.org',
  'json-schema.org',
  'w3.org',
  'www.w3.org',
  'github.com',
  'raw.githubusercontent.com',
  'gist.github.com',
  'avatars.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'npmjs.com',
  'www.npmjs.com',
  'registry.npmjs.org',
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'developer.mozilla.org',
  'stackoverflow.com',
  'react.dev',
  'reactjs.org',
  'nextjs.org',
  'nodejs.org',
  'tailwindcss.com',
  'typescriptlang.org',
  'www.typescriptlang.org',
  'reactnative.dev',
  'pypi.org',
  'pkg.go.dev',
  'golang.org',
  'go.dev',
  'rubygems.org',
  'packagist.org',
  'nuget.org',
  'crates.io',
  'docs.rs',
  'mozilla.org',
  'apache.org',
  'www.apache.org',
  'opensource.org',
  'creativecommons.org',
  'shields.io',
  'img.shields.io',
  'placehold.co',
  'placeholder.com',
  'via.placeholder.com',
  'picsum.photos',
  'xmlsoap.org',
  'schemas.xmlsoap.org',
  'schemas.microsoft.com',
  'purl.org',
  'ogp.me',
  'gravatar.com',
  'www.gravatar.com',
  'semver.org',
  'keepachangelog.com',
  'conventionalcommits.org',
  'swagger.io',
  'yaml.org',
  'json.org',
  'ietf.org',
  'tools.ietf.org',
  'datatracker.ietf.org',
  'iana.org',
  'www.iana.org',
  // social / app-store / share links — links, not integrations
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'pinterest.com',
  'reddit.com',
  'wa.me',
  't.me',
  'apps.apple.com',
  'itunes.apple.com',
  'play.google.com',
  'maps.google.com',
  'goo.gl',
  'bit.ly',
]);
const NOISE_SUFFIX = ['.localhost', '.local', '.test', '.internal', '.invalid', '.example', '.example.com', '.wikipedia.org', '.svc.cluster.local', '.ts.net', '.lan', '.home.arpa'];
const NOISE_PREFIX = ['docs.', 'developer.', 'developers.', 'dev.to', 'learn.', 'support.', 'help.', 'blog.'];

const TWO_PART_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'com.br', 'com.mx', 'co.za', 'com.tr', 'com.cn', 'com.sg', 'co.in', 'co.kr', 'com.hk', 'co.il', 'com.ar', 'com.pl', 'co.at', 'or.at', 'gv.at']);

export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split('.');
  if (parts.length <= 2) return host.toLowerCase();
  const lastTwo = parts.slice(-2).join('.');
  return TWO_PART_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export function isNoiseHost(host: string, ignore: string[] = []): boolean {
  const h = host.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  if (NOISE_EXACT.has(h) || NOISE_EXACT.has(registrableDomain(h))) return true;
  if (NOISE_SUFFIX.some((s) => h.endsWith(s))) return true;
  if (NOISE_PREFIX.some((p) => h.startsWith(p))) return true;
  if (!/\.[a-z]{2,}$/.test(h)) return true; // e.g. "foo.bar1"
  // Placeholders from docs and .env.example: your-provider.com, yourdomain.com, my-app.example
  if (/^(your|my)[-_]?(own[-_]?)?(domain|site|app|company|provider|server|host|instance|project|api|bucket|store|org|tenant)\b/.test(registrableDomain(h))) return true;
  for (const pattern of ignore) {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p || registrableDomain(h) === p) return true;
  }
  return false;
}
