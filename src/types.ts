/**
 * Core types for stackprune.
 *
 * A "vendor" is a third-party service you integrate with (Stripe, Sentry, OpenAI…).
 * A "target" is one repository (or one folder) that gets scanned.
 * An "integration" is a vendor as seen in one or more targets, with the evidence and a verdict.
 */

export type Ecosystem = 'npm' | 'pypi' | 'go' | 'rubygems' | 'composer' | 'nuget' | 'cargo';

export type Category =
  | 'ai'
  | 'analytics'
  | 'apm'
  | 'auth'
  | 'cdn'
  | 'cloud'
  | 'cms'
  | 'communication'
  | 'crm'
  | 'database'
  | 'email'
  | 'error-tracking'
  | 'feature-flags'
  | 'hosting'
  | 'localization'
  | 'logging'
  | 'maps'
  | 'marketing'
  | 'media'
  | 'payments'
  | 'push'
  | 'queue'
  | 'search'
  | 'sms'
  | 'social-login'
  | 'storage'
  | 'support'
  | 'other';

export interface Vendor {
  /** Stable kebab-case id, e.g. "stripe", "aws-s3". */
  id: string;
  /** Display name, e.g. "Stripe", "AWS S3". */
  name: string;
  category: Category;
  /**
   * Package names per ecosystem. A trailing `*` is a prefix match,
   * e.g. "@sentry/*" or "@aws-sdk/client-s3".
   */
  packages?: Partial<Record<Ecosystem, string[]>>;
  /**
   * Import/module names when they differ from the package name.
   * Mostly needed for Python (package "sentry-sdk" → module "sentry_sdk").
   * A trailing `*` is a prefix match.
   */
  modules?: Partial<Record<'python' | 'go', string[]>>;
  /** Env var name patterns. `*` matches any suffix, e.g. "STRIPE_*". */
  env?: string[];
  /** API hostnames. A leading `*.` matches any subdomain, e.g. "*.stripe.com". */
  hosts?: string[];
  /** True when the vendor normally costs money at production scale. */
  paid?: boolean;
  /** Homepage or pricing page. */
  url?: string;
}

/** Where a piece of evidence came from. */
export interface Evidence {
  kind: 'manifest' | 'import' | 'env-declared' | 'env-referenced' | 'host';
  file: string; // relative to the target root
  line?: number;
  detail: string; // package name, env var name, host, …
  ecosystem?: Ecosystem; // for manifest evidence
  dev?: boolean; // devDependency / test file
}

export interface GitInfo {
  introducedAt?: string; // ISO date
  introducedBy?: string; // author name
  introducedCommit?: string;
  /** Name of the AI assistant credited on the introducing commit, if any. */
  introducedWithAI?: string;
  lastTouchedAt?: string; // latest commit touching any file that uses the vendor
}

/** One vendor inside one target. */
export interface TargetHit {
  target: string; // target name
  group?: string; // the path the user passed when targets were auto-discovered
  root: string; // absolute path
  evidence: Evidence[];
  git?: GitInfo;
}

export interface RuntimeUsage {
  calls: number;
  errors: number;
  firstSeen?: string;
  lastSeen?: string;
  hosts: string[];
}

export type Status =
  | 'unused' // declared in a manifest, never imported
  | 'config-only' // env vars declared, nothing in code reads them, no imports
  | 'dormant' // in code, but runtime data shows zero calls
  | 'dev-only' // only in devDependencies / tests
  | 'active';

export type Verdict = 'cut' | 'review' | 'keep';

export interface Integration {
  vendor: Vendor;
  status: Status;
  verdict: Verdict;
  reasons: string[];
  hits: TargetHit[];
  /** Number of distinct source files that import or call the vendor. */
  codeFiles: number;
  /** Files you would touch to remove it (imports + manifests + env refs). */
  removalFiles: number;
  overlapsWith: string[]; // vendor ids in the same exclusive category
  usage?: RuntimeUsage;
  cost?: CostEntry;
  owner?: string;
  purpose?: string;
  introducedWithAI?: string;
  lastTouchedAt?: string;
  introducedAt?: string;
}

export interface CostEntry {
  monthly: number;
  currency?: string;
  plan?: string;
  notes?: string;
}

export interface IntegrationConfig {
  owner?: string;
  purpose?: string;
  cost?: CostEntry | number;
  /** Mark as intentionally kept, e.g. legally required. */
  keep?: boolean;
}

export interface Config {
  /**
   * Named apps and the repos/folders that make them up, relative to the config file.
   * Used when no paths are passed on the command line. A folder of repos is expanded.
   *   apps: { shop: [../shop-api, ../shop-web], backoffice: [../admin] }
   */
  apps?: Record<string, string[]>;
  /** Extra or overriding vendor definitions (in-house APIs, niche vendors, partners). */
  vendors?: Vendor[];
  /** Per-vendor metadata keyed by vendor id. */
  integrations?: Record<string, IntegrationConfig>;
  /** Glob-ish path fragments to skip, in addition to the defaults. */
  exclude?: string[];
  /** Vendor ids to ignore completely. */
  ignore?: string[];
  /** Hosts (or `*.suffix`) to leave out of the "unknown external hosts" list, e.g. your own domains. */
  ignoreHosts?: string[];
  /** Code untouched for this many days gets a "stale" note. Default 365. */
  staleDays?: number;
  /** Default currency for costs. Default "USD". */
  currency?: string;
  check?: {
    /** Fail `stackprune check` when a newly added integration has no owner/purpose in config. */
    requireOwner?: boolean;
    requirePurpose?: boolean;
  };
}

/** External domain referenced in code (or seen at runtime) that matched no known vendor. */
export interface UnknownHost {
  /** Registrable domain, e.g. "bolt.eu". */
  domain: string;
  hosts: string[];
  files: number;
  targets: string[];
  /** Calls seen by the runtime probe, if usage data was loaded. */
  calls?: number;
}

export interface ScanResult {
  generatedAt: string;
  targets: { name: string; group?: string; root: string; files: number; git: boolean }[];
  integrations: Integration[];
  unknownHosts: UnknownHost[];
  currency: string;
  usageWindow?: { from: string; to: string };
  /** Non-fatal problems: unparseable manifests, truncated walks… */
  warnings: string[];
}
