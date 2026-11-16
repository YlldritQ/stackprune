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
  /** Not in the catalog: inferred from a package + a credential env var, or from config/billing. */
  detected?: 'sdk' | 'config' | 'billing';
}

/**
 * A job that several libraries can do (dates, HTTP client, charts…). Using two families
 * from the same group in one app is a duplicate.
 */
export interface PurposeGroup {
  /** kebab-case id, e.g. "dates", "http-client". */
  id: string;
  /** Human label, e.g. "Date & time handling". */
  label: string;
  ecosystem: Ecosystem;
  /**
   * One entry per library. A family can span several packages that belong together
   * (e.g. chart.js + react-chartjs-2 + chartjs-plugin-*), so they never count as duplicates of each other.
   * A trailing `*` is a prefix match.
   */
  families: { name: string; packages: string[] }[];
  /** Optional hint shown with the duplicate, e.g. "date-fns and dayjs are tree-shakeable; moment is in maintenance mode". */
  note?: string;
}

/** Where a piece of evidence came from. */
export interface Evidence {
  kind: 'manifest' | 'import' | 'env-declared' | 'env-referenced' | 'host';
  file: string; // relative to the target root
  line?: number;
  detail: string; // package name, env var name, host, …
  ecosystem?: Ecosystem; // for manifest evidence
  dev?: boolean; // devDependency / test file
  /** For imports: the file's header comment calls it a test/spike/PoC/experiment. */
  marker?: string;
  /** Used without an import of its own: the package or file that pulls it in. */
  via?: string;
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
  | 'absent' // you pay for it (config or billing), but no repo references it
  | 'tool' // paid, used by people rather than code (seats); not judged by code
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
  /** Where the number came from. */
  source?: 'config' | 'billing';
}

export interface IntegrationConfig {
  owner?: string;
  purpose?: string;
  cost?: CostEntry | number;
  /** Mark as intentionally kept, e.g. legally required. */
  keep?: boolean;
  /** Display name for ids that aren't in the catalog. */
  name?: string;
  /**
   * "api" (default): judged by what the code does.
   * "tool": used by people (seats: Figma, Notion, Linear…); listed, never judged by code.
   */
  kind?: 'api' | 'tool';
  /** Extra names it shows up under on invoices / bank statements, e.g. ["ACME GMBH"]. */
  aliases?: string[];
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
  /** Per-vendor metadata keyed by vendor id. Listing a cost here also means "we pay for this". */
  integrations?: Record<string, IntegrationConfig>;
  /** Billing exports (CSV from your bank, card, accounting tool) to match against, relative to this file. */
  billing?: string[];
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
    /** Fail when a PR adds a dependency nothing uses. */
    blockUnusedPackages?: boolean;
    /** Fail when a PR adds a second library for a job an existing one already does. */
    blockDuplicates?: boolean;
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
  unusedPackages: UnusedPackage[];
  duplicates: Duplicate[];
  packageStats: { declared: number; unused: number; duplicateGroups: number };
  /** Payments in the billing exports that matched no known vendor. */
  unmatchedSpend: SpendItem[];
  billingWindow?: { from: string; to: string };
}

/** A dependency nothing uses (statically, or at runtime in production). */
export interface UnusedPackage {
  ecosystem: Ecosystem;
  name: string;
  dev: boolean;
  /** "low" for tool plugins, native modules and dev tooling: check before removing. */
  confidence: 'high' | 'low';
  where: { target: string; group?: string; manifest: string; line?: number }[];
  reason: string;
  /** Why it's low confidence, or that it's a redundant second copy in a monorepo. */
  hint?: string;
  /** Flagged from production data (imported in code, never loaded at runtime). */
  runtime?: boolean;
  introducedAt?: string;
  introducedBy?: string;
  introducedWithAI?: string;
}

/** Two or more libraries doing the same job in one app. */
export interface Duplicate {
  group: string;
  label: string;
  app: string;
  note?: string;
  /** Most-used first. */
  families: { name: string; packages: string[]; files: number; targets: string[]; introducedWithAI?: string; introducedAt?: string }[];
}

/** A payee from billing exports, aggregated. */
export interface SpendItem {
  payee: string;
  monthly: number;
  total: number;
  payments: number;
  currency: string;
  vendorId?: string;
}
