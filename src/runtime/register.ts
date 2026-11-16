/**
 * Preload entry: `node --import stackprune/register app.js`
 *
 * Env:
 *   STACKPRUNE_APP       app name (default: npm package name)
 *   STACKPRUNE_OUT       folder for usage JSONL (default: .stackprune, "" to disable)
 *   STACKPRUNE_ENDPOINT  URL to POST usage batches to
 *   STACKPRUNE_FLUSH_MS  flush interval (default 60000)
 *   STACKPRUNE_DISABLED  set to 1 to turn the probe off
 */
import { startProbe } from './probe.js';

if (process.env.STACKPRUNE_DISABLED !== '1') {
  startProbe({
    app: process.env.STACKPRUNE_APP || undefined,
    outDir: process.env.STACKPRUNE_OUT,
    endpoint: process.env.STACKPRUNE_ENDPOINT || undefined,
    flushIntervalMs: process.env.STACKPRUNE_FLUSH_MS ? Number(process.env.STACKPRUNE_FLUSH_MS) : undefined,
  });
}
