import { describe, expect, it } from 'vitest';
import { detectAI } from '../src/scan/git.js';
import { parseEnvNames } from '../src/scan/env.js';
import { parseManifest } from '../src/scan/manifests.js';
import { extract } from '../src/scan/source.js';
import { isEnvFile, isTestPath, type WalkedFile } from '../src/scan/walk.js';

const names = (xs: { name: string; dev: boolean }[]) => xs.map((x) => `${x.name}${x.dev ? ' (dev)' : ''}`);

describe('manifests', () => {
  it('package.json: prod, peer, optional and dev deps', () => {
    const r = parseManifest('package.json', JSON.stringify({ dependencies: { stripe: '^14' }, peerDependencies: { react: '*' }, devDependencies: { '@sentry/cli': '2' } }, null, 2));
    expect(names(r)).toEqual(['stripe', 'react', '@sentry/cli (dev)']);
    expect(r[0]!.line).toBe(3);
  });

  it('requirements.txt: skips comments, flags and URLs; dev by file name', () => {
    const txt = '# deps\nstripe==7.0.0\nsentry-sdk[django]>=1.0 ; python_version > "3.8"\n-r base.txt\ngit+https://x/y.git\n';
    expect(names(parseManifest('requirements.txt', txt))).toEqual(['stripe', 'sentry-sdk']);
    expect(parseManifest('requirements-dev.txt', 'pytest\n')[0]!.dev).toBe(true);
  });

  it('pyproject.toml: PEP 621, optional deps, dependency groups and poetry', () => {
    const toml = `[project]
name = "app"
dependencies = [
  "stripe>=7",
  "openai",
]

[project.optional-dependencies]
dev = ["pytest"]

[dependency-groups]
test = ["coverage"]

[tool.poetry.dependencies]
python = "^3.11"
twilio = "^9"

[tool.poetry.group.dev.dependencies]
ruff = "*"
`;
    expect(names(parseManifest('pyproject.toml', toml))).toEqual(['stripe', 'openai', 'pytest (dev)', 'coverage (dev)', 'twilio', 'ruff (dev)']);
  });

  it('go.mod: require blocks, single requires, skips indirect', () => {
    const mod = 'module x\n\nrequire github.com/stripe/stripe-go/v76 v76.0.0\n\nrequire (\n\tgithub.com/getsentry/sentry-go v0.27.0\n\tgolang.org/x/net v0.1.0 // indirect\n)\n';
    expect(names(parseManifest('go.mod', mod))).toEqual(['github.com/getsentry/sentry-go', 'github.com/stripe/stripe-go/v76']);
  });

  it('Gemfile: groups mark dev gems', () => {
    const gem = "source 'https://rubygems.org'\ngem 'stripe'\ngroup :development, :test do\n  gem 'rspec'\nend\ngem 'twilio-ruby'\n";
    expect(names(parseManifest('Gemfile', gem))).toEqual(['stripe', 'rspec (dev)', 'twilio-ruby']);
  });

  it('Cargo.toml, composer.json and .csproj', () => {
    expect(names(parseManifest('Cargo.toml', '[dependencies]\nasync-stripe = "0.3"\n\n[dev-dependencies]\nmockito = "1"\n'))).toEqual(['async-stripe', 'mockito (dev)']);
    expect(names(parseManifest('composer.json', JSON.stringify({ require: { php: '>=8', 'stripe/stripe-php': '^13' }, 'require-dev': { 'phpunit/phpunit': '*' } })))).toEqual(['stripe/stripe-php', 'phpunit/phpunit (dev)']);
    expect(names(parseManifest('App.csproj', '<ItemGroup><PackageReference Include="Stripe.net" Version="43" /></ItemGroup>'))).toEqual(['Stripe.net']);
  });

  it('ignores malformed manifests', () => {
    expect(parseManifest('package.json', '{ nope')).toEqual([]);
  });
});

const file = (rel: string, lang: WalkedFile['lang'], kind: WalkedFile['kind'] = 'source'): WalkedFile => ({ abs: rel, rel, kind, lang, test: false, size: 0 });

describe('source extraction', () => {
  it('finds JS/TS imports, requires and dynamic imports, not commented-out ones', () => {
    const src = `import Stripe from 'stripe';
import {
  init,
  captureException,
} from "@sentry/node";
import type { PostHog } from 'posthog-node';
const twilio = require('twilio');
const lazy = await import('openai');
// import mixpanel from 'mixpanel';
export * from '@vercel/analytics';
import './styles.css';
`;
    const f = extract(file('a.ts', 'js'), src);
    expect(f.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['stripe', '@sentry/node', 'posthog-node', 'twilio', 'openai', '@vercel/analytics', './styles.css']));
    expect(f.imports.map((i) => i.spec)).not.toContain('mixpanel');
    expect(f.imports.find((i) => i.spec === '@sentry/node')!.line).toBe(2);
  });

  it('finds python imports including from-imports of submodules', () => {
    const f = extract(file('a.py', 'python'), 'import os, sentry_sdk as s\nfrom google.cloud import storage, pubsub_v1\nfrom .local import x\n');
    expect(f.imports.map((i) => i.spec)).toEqual(['os', 'sentry_sdk', 'google.cloud', 'google.cloud.storage', 'google.cloud.pubsub_v1']);
  });

  it('finds go imports in blocks and single lines', () => {
    const f = extract(file('main.go', 'go'), 'package main\n\nimport "fmt"\n\nimport (\n\t"github.com/stripe/stripe-go/v76"\n\tsentry "github.com/getsentry/sentry-go"\n)\n');
    expect(f.imports.map((i) => i.spec)).toEqual(['fmt', 'github.com/stripe/stripe-go/v76', 'github.com/getsentry/sentry-go']);
  });

  it('collects env tokens except in comments, and hosts from URLs and quoted strings', () => {
    const src = `const key = process.env.STRIPE_SECRET_KEY;
// SENTRY_DSN is optional
fetch('https://api.openai.com/v1/chat');
const host = 'api.eu.mixpanel.com';
// see https://docs.example.org/page
`;
    const f = extract(file('a.ts', 'js'), src);
    expect([...f.envTokens.keys()]).toEqual(['STRIPE_SECRET_KEY']);
    expect([...f.hosts.keys()]).toEqual(expect.arrayContaining(['api.openai.com', 'api.eu.mixpanel.com', 'docs.example.org']));
    expect(f.codeUrlHosts.has('api.openai.com')).toBe(true);
    expect(f.codeUrlHosts.has('docs.example.org')).toBe(false); // comment line
  });
});

describe('generic AWS SDKs', () => {
  it('maps boto3 clients and aws-sdk v2 constructors to the billed service', () => {
    const py = extract(file('a.py', 'python'), 'import boto3\ns3 = boto3.client("s3")\nq = boto3.resource(service_name="sqs")\n# boto3.client("sns")\nx = boto3.client("made-up")\n');
    expect(py.awsServices.map((s) => s.vendorId)).toEqual(['aws-s3', 'aws-sqs']);
    const js = extract(file('a.js', 'js'), "const AWS = require('aws-sdk');\nconst s3 = new AWS.S3();\nconst ddb = new AWS.DynamoDB({});\n");
    expect(js.awsServices.map((s) => s.vendorId)).toEqual(['aws-s3', 'aws-dynamodb']);
  });
});

describe('env files', () => {
  it('reads names only, never values', () => {
    const r = parseEnvNames('# comment\nSTRIPE_SECRET_KEY=sk_live_123\nexport TWILIO_AUTH_TOKEN="abc"\n\nEMPTY=\n');
    expect(r.map((x) => x.name)).toEqual(['STRIPE_SECRET_KEY', 'TWILIO_AUTH_TOKEN', 'EMPTY']);
    expect(JSON.stringify(r)).not.toContain('sk_live_123');
  });

  it('recognises env file names without catching source files', () => {
    for (const n of ['.env', '.env.local', '.env.production', '.env.example', 'api.env', '.envrc', 'env.example']) expect(isEnvFile(n), n).toBe(true);
    for (const n of ['env.ts', 'config.env.ts', 'environment.js', '.envoy.yaml']) expect(isEnvFile(n), n).toBe(false);
  });

  it('flags test paths', () => {
    for (const p of ['src/__tests__/a.ts', 'test/x.js', 'a.spec.tsx', 'pkg/x_test.go', 'tests/test_api.py', 'e2e/login.ts']) expect(isTestPath(p), p).toBe(true);
    for (const p of ['src/contest.ts', 'src/latest/a.ts', 'src/testimonials.tsx']) expect(isTestPath(p), p).toBe(false);
  });
});

describe('AI attribution', () => {
  it('detects assistants from trailers and bot authors', () => {
    expect(detectAI('Dev', 'dev@x.com', 'feat: add mixpanel\n\nCo-Authored-By: Claude <noreply@anthropic.com>')).toBe('Claude');
    expect(detectAI('Dev', 'dev@x.com', 'feat\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)')).toBe('Claude');
    expect(detectAI('Dev', 'dev@x.com', 'x\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>')).toBe('GitHub Copilot');
    expect(detectAI('copilot-swe-agent[bot]', 'bot@github.com', 'Initial plan')).toBe('GitHub Copilot');
    expect(detectAI('Dev (aider)', 'dev@x.com', 'add stripe')).toBe('Aider');
    expect(detectAI('Dev', 'dev@x.com', 'x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>')).toBe('Cursor');
  });

  it('does not flag ordinary commits that merely mention AI', () => {
    expect(detectAI('Dev', 'dev@x.com', 'feat: add OpenAI client for summaries')).toBeUndefined();
    expect(detectAI('Dev', 'dev@x.com', 'fix: claude api retry')).toBeUndefined();
  });
});
