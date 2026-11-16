# stackprune

**Keep your dependencies clean. Find unused packages, duplicate libraries and paid integrations nobody uses, in your repo, on every pull request, and in production.**

```bash
npx stackprune
```

![stackprune report](docs/report.png)

## Why

AI coding assistants install whatever fixes the problem in front of them. The bug gets fixed, and the package stays. A few months later you have:

- `moment` next to `dayjs` next to `date-fns`, three icon sets, `uuid` and `nanoid`;
- `lodash` that one prompt needed and no file imports any more;
- a telemetry SDK "for a quick test" that never got a production key, and is still billed;
- API keys in `.env` for services nobody calls;
- two error trackers, two analytics tools, three email providers.

Dependency tools see packages. Finance sees invoices. Nobody connects them. stackprune reads the code, the manifests, the env files, the git history (including which AI assistant was credited) and, optionally, production traffic and your billing export. Then it tells you what to remove.

## What it finds

| | Example |
|---|---|
| **Unused packages** | `lodash` is in `package.json`, but nothing imports, runs or configures it |
| **Duplicate libraries** | Day.js in 41 files, Moment in 3, date-fns in 1: pick one, and moving the rest touches 4 files |
| **Unused integrations** | Twilio is installed and never imported, or `MIXPANEL_TOKEN` is set and nothing reads it |
| **Switched-off integrations** | the SDK is wired up, but the key it needs isn't set anywhere |
| **Experiments that shipped** | the file that wires it up calls itself a "quick test" or "spike" |
| **Overlapping services** | Sentry *and* Bugsnag in the same app |
| **Unlisted vendor SDKs** | `@acme/browser` + `ACME_PUBLISHABLE_KEY` gets treated as a vendor even when it's not in the catalog |
| **Spend with no code behind it** | your card statement says you pay for it, and no repo mentions it |
| **Code that never runs in production** | it's imported, but the production probe never saw it load |
| **Who added it** | when, by whom, and whether the commit credits Claude, Copilot, Cursor, Codex, Aider, Devin, Gemini… |

## Sample output

```
stackprune · 3 repos · 16 integrations · 27 dependencies
  integrations  6 cut   4 review   6 keep   │   potential savings $428/mo (+$267/mo under review)
  packages      1 unused   3 duplicates
  8 added in AI-assisted commits — 6 of them unused

✂ CUT — integrations nothing uses
  LaunchDarkly      feature-flags   api   $150/mo   Installed (@launchdarkly/node-server-sdk) in api but never imported
                                                    ↳ Added in an AI-assisted commit (Claude) on 2026-03-18
  Segment (Twilio)  analytics       web   $120/mo   Installed (@segment/analytics-next) in web but never imported
  Mixpanel          analytics       api   $28/mo    Configured (MIXPANEL_TOKEN in .env.example) but nothing in code uses it

? REVIEW — integrations where something looks off
  Telemetrix        other           web   $99/mo    Used in 1 file across web
                                                    ↳ Needs NEXT_PUBLIC_TELEMETRIX_PUBLISHABLE_KEY, which no env file in the repo sets
                                                    ↳ app/telemetry.ts describes itself as "Telemetrix browser SDK (quick test, remove before release)."
                                                    ↳ Not in the catalog: detected as a vendor SDK (@telemetrix/browser)
  Sentry            error-tracking  api   $89/mo    Overlaps with Bugsnag in acme (error-tracking)

▢ UNUSED PACKAGES — declared, but nothing imports, runs or configures them
  lodash            web             added 2026-07-21 by Sam · AI: Claude

⇄ DUPLICATES — different libraries doing the same job in one app
  Date & time handling in acme
    ● Day.js        2 files   dayjs
    ○ Moment        1 file    moment · AI: Claude 2026-07-21
    → pick one. Moving everything onto Day.js (most used) touches 1 file.
  Icon library in acme
    ● Lucide        2 files   lucide-react
    ○ react-icons   1 file    react-icons · AI: Claude 2026-07-21
```

That's a made-up company: `pnpm build && pnpm demo` reproduces it. Reports come as a terminal table, Markdown, JSON or a self-contained HTML page ([example](examples/demo-report.html)).

## Three ways to run it

### 1. In your project

```bash
npx stackprune                      # the current repo
npx stackprune ~/code/acme          # a folder of repos: one app, judged together
npx stackprune --out report.html    # shareable report
npx stackprune init                 # write a stackprune.yml from what it found
```

### 2. On every pull request

`stackprune check` compares a branch with its base and comments when the PR adds a package nothing uses, a second library for a job you already have a library for, or a new paid service nobody owns. Old code isn't flagged, only what this PR adds.

```yaml
# .github/workflows/stackprune.yml
name: stackprune
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: YlldritQ/stackprune@main
```

```yaml
# stackprune.yml: make it block instead of just comment
check:
  blockDuplicates: true       # "moment duplicates Day.js (Date & time handling)"
  blockUnusedPackages: true   # "left-pad is added but never used"
  requireOwner: true          # every new paid integration needs an owner
```

Locally: `npx stackprune check --base origin/main`.

### 3. In production

Static analysis tells you something is *imported*. It can't tell you the code path still runs. Add the probe to a Node service:

```bash
node --import stackprune/register server.js
# or: NODE_OPTIONS="--import stackprune/register" npm start
```

Each minute it appends a line to `.stackprune/usage-<app>-<host>.jsonl`. It records:

- **which packages the process actually loaded**, as package names only;
- **which external APIs it called**: hostname, call count, errors and latency. No paths, query strings, headers or bodies.

It uses Node's built-in `module.registerHooks` and `diagnostics_channel` (fetch/undici, http/https, so axios, got and most SDKs are covered) and patches nothing. Localhost and private-network calls are ignored.

After a few weeks of traffic, feed it back:

```bash
npx stackprune --usage ./usage-from-prod/
```

Packages that are imported but never loaded become "never loaded in production (21 days of data)". Integrations in code with zero calls become `review · dormant`.

| Env var | Default | |
|---|---|---|
| `STACKPRUNE_APP` | npm package name | Use the repo name so production data lines up with the scan |
| `STACKPRUNE_OUT` | `.stackprune` | Folder for the JSONL files (`""` disables) |
| `STACKPRUNE_ENDPOINT` | – | Also POST each batch here (for containers without a persistent disk) |
| `STACKPRUNE_FLUSH_MS` | `60000` | Flush interval |
| `STACKPRUNE_DISABLED` | – | `1` turns it off |

Not on Node? The format is plain JSONL, so you can generate it from egress-proxy logs, an API gateway or an OpenTelemetry exporter:

```json
{"ts":"2026-05-31T00:00:00Z","from":"2026-05-01T00:00:00Z","app":"worker","host":"api.openai.com","calls":18234,"errors":12}
{"kind":"packages","ts":"2026-05-31T00:00:00Z","app":"worker","packages":["fastify","pino","openai"]}
```

## Follow the money: billing exports

Some paid services barely touch the code, or don't touch it at all. Give stackprune your card or bank statement, or an accounting export:

```bash
npx stackprune --billing payments.csv
```

It reads the CSV most banks and tools export: comma, semicolon or tab separated, English or German number formats, card descriptors like `PADDLE.NET* ACME`. It averages the spend per payee per month and matches payees to vendors. The output:

- **Paid, no trace in code:** "Billed $99/mo (ACME) but no repo references it."
- **Paid, recognised:** costs fill in automatically, so savings are real numbers.
- **Paid, not recognised:** payees it can't place get their own list. Map them with `aliases:`, or mark them `kind: tool` when people use them directly (Figma, Notion seats).

## Configuration

`stackprune.yml` next to the code you scan (or `.stackprune.yml` / `stackprune.json`, or `--config`):

```yaml
currency: EUR

# Name your apps and list their repos (relative to this file). Running `stackprune`
# with no paths audits all of them; duplicates and overlaps are judged per app.
apps:
  shop: [../shop-api, ../shop-web, ../shop-mobile]
  backoffice: [../admin]

billing: [exports/card-2026.csv]

integrations:
  stripe:   { owner: payments, purpose: Checkout and subscriptions, cost: 420 }
  sentry:   { owner: platform, cost: { monthly: 89, plan: Team } }
  acme:     { name: Acme Telemetry, aliases: ["ACME GMBH"], cost: 99 }   # paid; flagged if no code uses it
  figma:    { kind: tool, aliases: ["FIGMA"] }                           # used by people, not code
  segment:  { keep: true, purpose: Contractually required export }       # never suggest cutting

# Partner APIs, in-house services, niche vendors.
vendors:
  - id: parcelpartner
    name: ParcelPartner
    category: other
    hosts: ["*.parcelpartner.io"]
    env: ["PARCELPARTNER_*"]

ignore: [vercel]                         # vendor ids to leave out
ignoreHosts: [acme.com, "*.acme.dev"]    # your own domains
exclude: [legacy/, scripts/fixtures]     # paths to skip (node_modules, dist, build… are skipped already)

check:
  blockDuplicates: true
  blockUnusedPackages: true
  requireOwner: true
```

## How it decides

**Is a package used?** It counts as used if any of these hold:
- something under its manifest's folder imports it (JS/TS, CSS `@import`, Python, Go);
- a script runs it: `package.json` scripts, Dockerfiles, Procfiles, CI workflows, including CLI names read from `node_modules` (`typescript` → `tsc`);
- a config file names it (`.eslintrc` `plugins: ["react"]`, Babel/PostCSS/Vite/Next configs, `app.json` plugins);
- it's a type package for something you use, or a peer dependency of something you use;
- a framework convention needs it: `.tsx` files need `react`, `.scss` files need `sass`, a `tsconfig.json` needs `typescript`.

Lockfiles are ignored, since they mention everything. Dev tooling, tool plugins and React Native native modules are reported as *check first*, because those are used in ways a scan can miss.

**Is it a duplicate?** A catalog of 69 "jobs" (dates, HTTP clients, icons, charts, validation, state, forms, ORMs, loggers, test runners… for npm, PyPI and Go) groups libraries by what they do. A library and its companions (`chart.js` + `react-chartjs-2`) are one family and never count as duplicates of each other. Two families in one app is a duplicate. The most-used one is listed first, along with how many files you'd touch to consolidate.

**What about integrations?** 220+ services are recognised by package, env var and API host. Each one gets a verdict:

| Verdict | When |
|---|---|
| **cut** | Installed but never imported · credentials configured that nothing reads · you pay for it and no repo references it |
| **review** | Overlaps with a paid service doing the same job in the same app · the key it needs isn't set anywhere · the file calls itself a test or spike · only read as env vars · zero calls in production · billed, but not found in code |
| **keep** | Used, with no overlap, or marked `keep: true` |

## Use it as a library

```ts
import { scan } from 'stackprune';

const r = await scan({ paths: ['../api', '../web'], usage: ['./usage'], billing: ['./card.csv'] });
r.unusedPackages.filter((p) => p.confidence === 'high').forEach((p) => console.log(p.name, p.where));
r.duplicates.forEach((d) => console.log(d.label, d.families.map((f) => f.name)));
```

## Privacy

- Runs locally. The CLI makes no network requests.
- `.env` files are read for **variable names only**. Values never reach a report.
- The production probe records package names, hostnames and counters, never request content.
- Billing exports stay on your machine. Reports include payee names and amounts, so treat them like the export itself.

## Supported

| | Unused packages | Duplicates | Integrations |
|---|---|---|---|
| JavaScript / TypeScript (npm, pnpm, yarn, bun) | ✅ | ✅ | ✅ |
| Python (pip, Poetry, uv, Pipenv) | ✅ | ✅ | ✅ |
| Go | ✅ | ✅ | ✅ |
| Ruby, Rust | – | – | ✅ |
| PHP (Composer), .NET (NuGet) | – | – | ✅ *(dependencies assumed used)* |

`npx stackprune catalog` lists all known vendors; `npx stackprune catalog analytics` filters them.

## Limitations

Here's what a finding means, and where it can be wrong:

- **Static is not live.** "Imported" doesn't mean the code path runs. Add production data for that.
- **Bundled apps.** Next.js and webpack server bundles inline their dependencies, so the probe can't see them load. stackprune only uses package data when it saw an app load real `node_modules` packages.
- **Browser and mobile code** can't be probed from a server. Its findings are static only.
- **Dynamic imports** (`require(name)`) and plugins loaded by string from code aren't followed. That's why tool plugins are marked *check first*.
- **Ruby and PHP** load dependencies through autoloaders, so "unused" can't be judged from imports there.
- **The catalogs are finite.** Unlisted SDK detection, unknown domains and `vendors:` fill the gaps, and PRs are welcome.

## Contributing

Two data files drive most of the results:
- [`src/catalog/vendors.ts`](src/catalog/vendors.ts): services, recognised by package, env var pattern and API host;
- [`src/catalog/purposes.ts`](src/catalog/purposes.ts): jobs (dates, icons, HTTP…) and the library families that do them.

Keep patterns specific (`STRIPE_*`, never `*_KEY`). The tests reject over-broad ones and catch a package listed in two families of the same job.

```bash
pnpm install
pnpm test
pnpm build && pnpm demo
```

## License

MIT
