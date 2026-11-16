import type { WalkedFile } from './walk.js';

export interface FileFindings {
  /** Raw import specifiers (JS specifier, Python dotted module, Go path, Ruby require, Rust crate). */
  imports: { spec: string; line: number }[];
  /** UPPER_CASE tokens that look like env var names → first line seen. */
  envTokens: Map<string, number>;
  /** Hostnames from URLs and quoted host strings → first line seen. */
  hosts: Map<string, number>;
  /** Hostnames from URLs on non-comment lines (used for unknown-host discovery). */
  codeUrlHosts: Set<string>;
  /** AWS services used through a generic SDK (boto3.client("s3"), new AWS.S3()) → vendor id. */
  awsServices: { vendorId: string; detail: string; line: number }[];
}

/** boto3 / aws-sdk v2 service names → catalog vendor ids. */
const AWS_SERVICES: Record<string, string> = {
  s3: 'aws-s3',
  sqs: 'aws-sqs',
  sns: 'aws-sns',
  ses: 'aws-ses',
  sesv2: 'aws-ses',
  dynamodb: 'aws-dynamodb',
  lambda: 'aws-lambda',
  'bedrock-runtime': 'aws-bedrock',
  'bedrock-agent-runtime': 'aws-bedrock',
  bedrock: 'aws-bedrock',
  'cognito-idp': 'aws-cognito',
  cognitoidentityserviceprovider: 'aws-cognito',
  cloudfront: 'aws-cloudfront',
};
const BOTO3_CALL = /\.(?:client|resource)\(\s*(?:service_name\s*=\s*)?['"]([a-z0-9-]+)['"]/g;
const AWS_V2_NEW = /new\s+AWS\.([A-Za-z0-9]+)\s*\(/g;

class Lines {
  private readonly starts: number[] = [0];
  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  lineAt(index: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  lineText(line: number): string {
    const s = this.starts[line - 1] ?? 0;
    const e = this.starts[line] ?? this.text.length;
    return this.text.slice(s, e);
  }
  isComment(line: number): boolean {
    const t = this.lineText(line).trimStart();
    return t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--') || t.startsWith('--');
  }
}

const JS_IMPORT_RES = [
  /(?:^|[^\w$.])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  /(?:^|[^\w$.])require\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /(?:^|[^\w$.])import\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /(?:^|[^\w$.])require\.resolve\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
const PY_IMPORT = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm;
const PY_FROM = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+\(?([\w\s,*]+)\)?/gm;
const GO_SINGLE = /^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/gm;
const GO_BLOCK = /^[ \t]*import[ \t]*\(([\s\S]*?)\)/gm;
const RUBY_REQUIRE = /(?:^|\s)require(?:_relative)?\s*\(?\s*['"]([^'"\n]+)['"]/g;
const RUST_USE = /(?:^|\s)(?:use|extern\s+crate)\s+([a-z_][a-z0-9_]*)/g;

const ENV_TOKEN = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g;
const URL_HOST = /\b(?:https?|wss?):\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;
const QUOTED_HOST = /['"`]([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,})(?::\d+)?\/?['"`]/gi;

export function extract(file: WalkedFile, text: string): FileFindings {
  const lines = new Lines(text);
  const out: FileFindings = { imports: [], envTokens: new Map(), hosts: new Map(), codeUrlHosts: new Set(), awsServices: [] };

  if (file.kind === 'source') {
    extractImports(file.lang, text, lines, out);
    if (file.lang === 'python' && text.includes('boto3')) awsCalls(BOTO3_CALL, text, lines, out, (s) => `boto3.client("${s}")`);
    if (file.lang === 'js' && text.includes('AWS.')) awsCalls(AWS_V2_NEW, text, lines, out, (s) => `new AWS.${s}()`);
  }

  let m: RegExpExecArray | null;
  ENV_TOKEN.lastIndex = 0;
  while ((m = ENV_TOKEN.exec(text))) {
    if (out.envTokens.has(m[0])) continue;
    const line = lines.lineAt(m.index);
    if (!lines.isComment(line)) out.envTokens.set(m[0], line); // a var mentioned only in a comment isn't wired up
  }
  URL_HOST.lastIndex = 0;
  while ((m = URL_HOST.exec(text))) {
    const host = m[1]!.toLowerCase();
    const line = lines.lineAt(m.index);
    if (!out.hosts.has(host)) out.hosts.set(host, line);
    if (!lines.isComment(line)) out.codeUrlHosts.add(host);
  }
  QUOTED_HOST.lastIndex = 0;
  while ((m = QUOTED_HOST.exec(text))) {
    const host = m[1]!.toLowerCase();
    if (!out.hosts.has(host)) out.hosts.set(host, lines.lineAt(m.index));
  }
  return out;
}

function awsCalls(re: RegExp, text: string, lines: Lines, out: FileFindings, label: (s: string) => string): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const vendorId = AWS_SERVICES[m[1]!.toLowerCase()];
    const line = lines.lineAt(m.index);
    if (vendorId && !lines.isComment(line)) out.awsServices.push({ vendorId, detail: label(m[1]!), line });
  }
}

function push(out: FileFindings, lines: Lines, spec: string, index: number): void {
  const line = lines.lineAt(index);
  if (lines.isComment(line)) return; // commented-out code doesn't count as usage
  out.imports.push({ spec, line });
}

function extractImports(lang: WalkedFile['lang'], text: string, lines: Lines, out: FileFindings): void {
  let m: RegExpExecArray | null;
  switch (lang) {
    case 'js':
      for (const re of JS_IMPORT_RES) {
        re.lastIndex = 0;
        while ((m = re.exec(text))) push(out, lines, m[1]!, m.index + Math.max(0, m[0].search(/import|export|require/)));
      }
      break;
    case 'python':
      PY_IMPORT.lastIndex = 0;
      while ((m = PY_IMPORT.exec(text))) {
        for (const part of m[1]!.split(',')) {
          const mod = part.trim().split(/\s+/)[0];
          if (mod) push(out, lines, mod, m.index);
        }
      }
      PY_FROM.lastIndex = 0;
      while ((m = PY_FROM.exec(text))) {
        const base = m[1]!;
        if (base.startsWith('.')) continue;
        push(out, lines, base, m.index);
        for (const part of m[2]!.split(',')) {
          const name = part.trim().split(/\s+/)[0];
          if (name && name !== '*') push(out, lines, `${base}.${name}`, m.index);
        }
      }
      break;
    case 'go':
      GO_SINGLE.lastIndex = 0;
      while ((m = GO_SINGLE.exec(text))) push(out, lines, m[1]!, m.index);
      GO_BLOCK.lastIndex = 0;
      while ((m = GO_BLOCK.exec(text))) {
        const body = m[1]!;
        const bodyStart = m.index + m[0].indexOf('(') + 1;
        const inner = /"([^"]+)"/g;
        let im: RegExpExecArray | null;
        while ((im = inner.exec(body))) push(out, lines, im[1]!, bodyStart + im.index);
      }
      break;
    case 'ruby':
      RUBY_REQUIRE.lastIndex = 0;
      while ((m = RUBY_REQUIRE.exec(text))) push(out, lines, m[1]!, m.index);
      break;
    case 'rust':
      RUST_USE.lastIndex = 0;
      while ((m = RUST_USE.exec(text))) push(out, lines, m[1]!, m.index);
      break;
    default:
      break;
  }
}
