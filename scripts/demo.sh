#!/usr/bin/env bash
# Builds a fake three-repo company ("acme") with realistic history, then runs stackprune on it.
# Used for the README output and screenshots. Everything here is made up.
#
#   pnpm build && bash scripts/demo.sh            # terminal report
#   bash scripts/demo.sh --format html --out examples/demo-report.html
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="${DEMO_DIR:-${TMPDIR:-/tmp}/stackprune-demo}"
ORG="$ROOT/acme"
rm -rf "$ROOT"
mkdir -p "$ORG"

export GIT_CONFIG_NOSYSTEM=1 HOME="$ROOT"
git config --global init.defaultBranch main
git config --global commit.gpgsign false

human() { GIT_AUTHOR_NAME="Dana" GIT_AUTHOR_EMAIL="dana@acme.dev" GIT_COMMITTER_NAME="Dana" GIT_COMMITTER_EMAIL="dana@acme.dev" GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -qam "$2" --allow-empty; }
ai() { GIT_AUTHOR_NAME="Sam" GIT_AUTHOR_EMAIL="sam@acme.dev" GIT_COMMITTER_NAME="Sam" GIT_COMMITTER_EMAIL="sam@acme.dev" GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git commit -qam "$2" -m "Co-Authored-By: $3" --allow-empty; }
pkg() { # name, deps json, [scripts json]
  local scripts="${3:-}"
  [ -n "$scripts" ] || scripts='{}'
  printf '{\n  "name": "%s",\n  "private": true,\n  "scripts": %s,\n  "dependencies": %s\n}\n' "$1" "$scripts" "$2" > package.json
}

# ── api ───────────────────────────────────────────────────────────────
mkdir -p "$ORG/api/src" && cd "$ORG/api" && git init -q
pkg api '{ "stripe": "^14.0.0", "@sentry/node": "^8.0.0", "dd-trace": "^5.0.0", "openai": "^4.0.0" }' '{ "start": "node -r dd-trace/init dist/server.js" }'
cat > src/billing.ts <<'EOF'
import Stripe from 'stripe';
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
export const charge = (customer: string, amount: number) => stripe.paymentIntents.create({ customer, amount, currency: 'eur' });
EOF
cat > src/errors.ts <<'EOF'
import * as Sentry from '@sentry/node';
Sentry.init({ dsn: process.env.SENTRY_DSN });
EOF
cat > src/summaries.ts <<'EOF'
import OpenAI from 'openai';
const client = new OpenAI();
export const summarize = (text: string) => client.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: text }] });
EOF
cat > src/shipping.ts <<'EOF'
export const quote = (zip: string) => fetch(`https://api.parcelpartner.io/v2/quotes?zip=${zip}`).then((r) => r.json());
EOF
printf 'STRIPE_SECRET_KEY=\nSENTRY_DSN=\nOPENAI_API_KEY=\n' > .env.example
git add -A && human 2025-02-03T10:00:00Z "initial api"

pkg api '{ "stripe": "^14.0.0", "@sentry/node": "^8.0.0", "dd-trace": "^5.0.0", "openai": "^4.0.0", "@bugsnag/js": "^7.0.0" }' '{ "start": "node -r dd-trace/init dist/server.js" }'
cat > src/bugsnag.ts <<'EOF'
import Bugsnag from '@bugsnag/js';
Bugsnag.start({ apiKey: process.env.BUGSNAG_API_KEY! });
EOF
git add -A && human 2025-06-12T15:30:00Z "add bugsnag for the mobile team's dashboards"

pkg api '{ "stripe": "^14.0.0", "@sentry/node": "^8.0.0", "dd-trace": "^5.0.0", "openai": "^4.0.0", "@bugsnag/js": "^7.0.0", "twilio": "^5.0.0", "@launchdarkly/node-server-sdk": "^9.0.0" }' '{ "start": "node -r dd-trace/init dist/server.js" }'
printf 'STRIPE_SECRET_KEY=\nSENTRY_DSN=\nOPENAI_API_KEY=\nTWILIO_ACCOUNT_SID=\nTWILIO_AUTH_TOKEN=\nLAUNCHDARKLY_SDK_KEY=\n' > .env.example
git add -A && ai 2026-03-18T22:14:00Z "feat: SMS notifications + feature flags scaffolding" "Claude <noreply@anthropic.com>"

printf 'STRIPE_SECRET_KEY=\nSENTRY_DSN=\nOPENAI_API_KEY=\nTWILIO_ACCOUNT_SID=\nTWILIO_AUTH_TOKEN=\nLAUNCHDARKLY_SDK_KEY=\nMIXPANEL_TOKEN=\n' > .env.example
git add -A && ai 2026-05-02T01:40:00Z "chore: analytics env" "Cursor Agent <cursoragent@cursor.com>"

# ── web ───────────────────────────────────────────────────────────────
mkdir -p "$ORG/web/app" && cd "$ORG/web" && git init -q
pkg web '{ "next": "15.0.0", "@stripe/stripe-js": "^4.0.0", "posthog-js": "^1.0.0", "@sentry/nextjs": "^8.0.0" }'
cat > app/checkout.tsx <<'EOF'
import { loadStripe } from '@stripe/stripe-js';
export const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);
EOF
cat > app/analytics.tsx <<'EOF'
import posthog from 'posthog-js';
posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, { api_host: 'https://eu.i.posthog.com' });
EOF
cat > app/sentry.client.config.ts <<'EOF'
import * as Sentry from '@sentry/nextjs';
Sentry.init({ dsn: process.env.NEXT_PUBLIC_SENTRY_DSN });
EOF
git add -A && human 2025-02-10T09:00:00Z "initial web"

pkg web '{ "next": "15.0.0", "react": "19.0.0", "@stripe/stripe-js": "^4.0.0", "posthog-js": "^1.0.0", "@sentry/nextjs": "^8.0.0", "@vercel/analytics": "^1.0.0", "@segment/analytics-next": "^1.0.0", "algoliasearch": "^5.0.0", "dayjs": "^1.11.0", "lucide-react": "^0.400.0" }'
cat > app/layout.tsx <<'EOF'
import { Analytics } from '@vercel/analytics/react';
export default function Layout({ children }: { children: React.ReactNode }) {
  return (<html><body>{children}<Analytics /></body></html>);
}
EOF
cat > app/orders.tsx <<'EOF'
import dayjs from 'dayjs';
import { Package } from 'lucide-react';
export const Order = ({ at }: { at: string }) => <p><Package /> {dayjs(at).format('D MMM')}</p>;
EOF
cat > app/invoices.tsx <<'EOF'
import dayjs from 'dayjs';
import { FileText } from 'lucide-react';
export const Invoice = ({ at }: { at: string }) => <p><FileText /> {dayjs(at).format('D MMM YYYY')}</p>;
EOF
printf 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=\nNEXT_PUBLIC_POSTHOG_KEY=\nNEXT_PUBLIC_ALGOLIA_APP_ID=\nNEXT_PUBLIC_ALGOLIA_SEARCH_KEY=\n' > .env.example
git add -A && ai 2026-04-09T23:05:00Z "feat: analytics, search and tracking setup" "Claude <noreply@anthropic.com>"

# An assistant fixes a date bug by pulling in a second date library and another icon set,
# adds two id generators and lodash, and wires up a telemetry SDK "for a quick test" that never gets a key.
pkg web '{ "next": "15.0.0", "react": "19.0.0", "@stripe/stripe-js": "^4.0.0", "posthog-js": "^1.0.0", "@sentry/nextjs": "^8.0.0", "@vercel/analytics": "^1.0.0", "@segment/analytics-next": "^1.0.0", "algoliasearch": "^5.0.0", "dayjs": "^1.11.0", "lucide-react": "^0.400.0", "moment": "^2.30.0", "react-icons": "^5.0.0", "@telemetrix/browser": "^0.3.0", "lodash": "^4.17.21", "uuid": "^10.0.0", "nanoid": "^5.0.0" }' '{ "dev": "next dev", "build": "next build" }'
cat > app/schedule.tsx <<'EOF'
import moment from 'moment';
import { FaCalendar } from 'react-icons/fa';
import { nanoid } from 'nanoid';
import { v4 } from 'uuid';
export const Slot = ({ at }: { at: string }) => <p key={nanoid()} id={v4()}><FaCalendar /> {moment(at).fromNow()}</p>;
EOF
cat > app/telemetry.ts <<'EOF'
// Telemetrix browser SDK (quick test, remove before release).
import { init } from '@telemetrix/browser';
const key = process.env.NEXT_PUBLIC_TELEMETRIX_PUBLISHABLE_KEY;
if (key) init({ key });
EOF
git add -A && ai 2026-07-21T00:40:00Z "fix: relative times on schedule page" "Claude <noreply@anthropic.com>"

# ── worker (python) ───────────────────────────────────────────────────
mkdir -p "$ORG/worker/jobs" && cd "$ORG/worker" && git init -q
printf 'sentry-sdk==2.10.0\nopenai==1.40.0\nboto3==1.34.0\nsendgrid==6.11.0\n' > requirements.txt
cat > jobs/reports.py <<'EOF'
import sentry_sdk
from openai import OpenAI
import boto3

sentry_sdk.init()
s3 = boto3.client("s3")

def run(bucket: str):
    client = OpenAI()
    s3.put_object(Bucket=bucket, Key="report.txt", Body=b"...")
    return client.chat.completions.create(model="gpt-4o-mini", messages=[])
EOF
git add -A && human 2024-11-20T11:00:00Z "nightly report worker"

# ── config ────────────────────────────────────────────────────────────
cat > "$ORG/stackprune.yml" <<'EOF'
currency: USD
check:
  requireOwner: true
vendors:
  - id: parcelpartner
    name: ParcelPartner
    category: other
    hosts: ["*.parcelpartner.io"]
integrations:
  stripe:       { owner: payments, purpose: Checkout and subscriptions, cost: 420 }
  sentry:       { owner: platform, cost: 89 }
  bugsnag:      { owner: mobile, cost: 59 }
  datadog:      { owner: platform, cost: 310 }
  openai:       { owner: ai-team, cost: 640 }
  twilio:       { cost: 25 }
  launchdarkly: { cost: 150 }
  posthog:      { owner: growth, cost: 0 }
  vercel-analytics: { cost: 20 }
  segment:      { cost: 120 }
  algolia:      { cost: 85 }
  mixpanel:     { cost: 28 }
  sendgrid:     { cost: 20 }
  aws-s3:       { owner: platform, cost: 14 }
  telemetrix:   { cost: 99 }
EOF

cd "$HERE"
node dist/cli.js "$ORG" "$@"
