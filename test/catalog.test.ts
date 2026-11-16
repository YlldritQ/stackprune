import { describe, expect, it } from 'vitest';
import { buildCatalog, jsPackageName, VENDORS } from '../src/catalog/index.js';

const catalog = buildCatalog();

describe('built-in catalog', () => {
  it('has unique ids and valid shapes', () => {
    const ids = VENDORS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of VENDORS) {
      expect(v.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(v.name.length).toBeGreaterThan(1);
      expect(v.packages || v.env || v.hosts).toBeTruthy();
    }
  });

  it('never uses env patterns that would match half the internet', () => {
    const tooBroad = new Set(['*', 'API_KEY', 'SECRET_KEY', 'DATABASE_URL', 'REDIS_URL', 'AWS_*', 'NEXT_PUBLIC_*', 'VITE_*', 'TOKEN', '*_TOKEN', '*_API_KEY']);
    for (const v of VENDORS) for (const e of v.env ?? []) expect(tooBroad.has(e), `${v.id}: ${e}`).toBe(false);
  });

  it('does not treat generic database drivers as a paid cloud service', () => {
    expect(catalog.matchPackage('npm', 'mongodb')).toBeUndefined();
    expect(catalog.matchPackage('npm', 'mongoose')).toBeUndefined();
    expect(catalog.matchPackage('npm', 'pg')).toBeUndefined();
    expect(catalog.matchPackage('npm', 'ioredis')).toBeUndefined();
  });
});

describe('matching', () => {
  it('matches npm packages exactly and by prefix', () => {
    expect(catalog.matchPackage('npm', 'stripe')?.id).toBe('stripe');
    expect(catalog.matchPackage('npm', '@sentry/nextjs')?.id).toBe('sentry');
    expect(catalog.matchPackage('npm', '@aws-sdk/client-s3')?.id).toBe('aws-s3');
    expect(catalog.matchPackage('npm', 'left-pad')).toBeUndefined();
  });

  it('resolves JS import specifiers to packages', () => {
    expect(jsPackageName('@sentry/node/esm/index.js')).toBe('@sentry/node');
    expect(jsPackageName('firebase/auth')).toBe('firebase');
    expect(jsPackageName('./local')).toBeUndefined();
    expect(jsPackageName('node:fs')).toBeUndefined();
    expect(jsPackageName('@/components/x')).toBeUndefined();
    expect(catalog.matchJsImport('stripe')?.id).toBe('stripe');
  });

  it('normalises pypi names and resolves dotted python modules', () => {
    expect(catalog.matchPackage('pypi', 'Sentry_SDK')?.id).toBe('sentry');
    expect(catalog.matchPythonModule('sentry_sdk')?.id).toBe('sentry');
    expect(catalog.matchPythonModule('sentry_sdk.integrations.django')?.id).toBe('sentry');
    expect(catalog.matchPythonModule('stripe')?.id).toBe('stripe');
    expect(catalog.matchPythonModule('os.path')).toBeUndefined();
  });

  it('matches versioned go import paths', () => {
    expect(catalog.matchGoImport('github.com/stripe/stripe-go/v76/customer')?.id).toBe('stripe');
  });

  it('matches env var patterns', () => {
    expect(catalog.matchEnv('STRIPE_SECRET_KEY')?.id).toBe('stripe');
    expect(catalog.matchEnv('NEXT_PUBLIC_POSTHOG_KEY')?.id).toBe('posthog');
    expect(catalog.matchEnv('DATABASE_URL')).toBeUndefined();
  });

  it('matches hosts exactly, by subdomain and with mid-pattern wildcards', () => {
    expect(catalog.matchHost('api.stripe.com')?.id).toBe('stripe');
    expect(catalog.matchHost('o123.ingest.sentry.io')?.id).toBe('sentry');
    expect(catalog.matchHost('sqs.eu-central-1.amazonaws.com')?.id).toBe('aws-sqs');
    expect(catalog.matchHost('my-bucket.s3.eu-central-1.amazonaws.com')?.id).toBe('aws-s3');
    expect(catalog.matchHost('stripe.com.evil.example')).toBeUndefined();
    expect(catalog.matchHost('example.com')).toBeUndefined();
  });

  it('knows which registrable domains belong to one vendor', () => {
    expect(catalog.ownsDomain('stripe.com')).toBe(true);
    expect(catalog.ownsDomain('amazonaws.com')).toBe(false);
    expect(catalog.ownsDomain('googleapis.com')).toBe(false);
  });
});

describe('user vendors', () => {
  it('adds in-house vendors and lets them win over built-ins', () => {
    const c = buildCatalog([{ id: 'acme-api', name: 'Acme API', category: 'other', hosts: ['*.acme.io'], env: ['ACME_*'] }]);
    expect(c.matchHost('api.acme.io')?.id).toBe('acme-api');
    expect(c.matchEnv('ACME_TOKEN')?.id).toBe('acme-api');
    expect(c.byId.get('acme-api')?.paid).toBe(true);
  });

  it('merges extra patterns into an existing vendor', () => {
    const c = buildCatalog([{ id: 'stripe', name: 'Stripe', category: 'payments', env: ['PAYMENTS_STRIPE_*'] }]);
    expect(c.matchEnv('PAYMENTS_STRIPE_KEY')?.id).toBe('stripe');
    expect(c.matchEnv('STRIPE_SECRET_KEY')?.id).toBe('stripe');
  });

  it('drops ignored vendors', () => {
    const c = buildCatalog([], ['stripe']);
    expect(c.matchPackage('npm', 'stripe')).toBeUndefined();
  });
});
