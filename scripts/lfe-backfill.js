#!/usr/bin/env node
'use strict';

/**
 * Driver for the Liquidity Failure Engine historical backfill.
 *
 * Loops the chunked /api/liquidity-failure?action=backfill endpoint, following
 * the returned checkpoint until the whole range is processed. Idempotent — safe
 * to re-run or resume. Requires Node 18+ (global fetch).
 *
 * Usage:
 *   node scripts/lfe-backfill.js --key $LFE_ADMIN_KEY [options]
 * Options:
 *   --base <url>       default https://www.nervafx.com
 *   --from <ISO>       range start (default: coverage earliestSelectable)
 *   --to <ISO>         range end   (default: coverage commonLatest)
 *   --chunkDays <n>    days per invocation (default 14)
 *   --dry              dry-run (counts, writes nothing)
 *   --outcomes         after backfill, run the outcome processor to completion
 */

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const BASE = String(arg('base', 'https://www.nervafx.com')).replace(/\/$/, '');
const KEY = arg('key', process.env.LFE_ADMIN_KEY);
const DRY = !!arg('dry', false);
const CHUNK_DAYS = arg('chunkDays', '3');
const STEP_MIN = arg('stepMinutes', '60');

if (!KEY) { console.error('Missing --key (or LFE_ADMIN_KEY env).'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(BASE + path, { method: 'POST', headers: { 'x-lfe-admin': KEY } });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
      if (!res.ok) throw new Error(`${res.status} ${path} :: ${text.slice(0, 300)}`);
      return json;
    } catch (e) {
      lastErr = e;
      // Retry transient network drops (often a chunk that ran long server-side).
      if (attempt < 4 && /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|502|503|504/i.test(e.message)) {
        console.log(`    (retry ${attempt}/3 after transient error: ${e.message.slice(0, 60)})`);
        await sleep(4000 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function qs(extra) {
  const p = new URLSearchParams({ action: 'backfill', chunkDays: String(CHUNK_DAYS), stepMinutes: String(STEP_MIN) });
  if (DRY) p.set('dryRun', '1');
  if (arg('from')) p.set('from', arg('from'));
  if (arg('to')) p.set('to', arg('to'));
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p.toString();
}

(async function main() {
  console.log(`Backfill → ${BASE}  (chunkDays=${CHUNK_DAYS}${DRY ? ', DRY-RUN' : ''})`);
  let checkpoint = null;
  let totals = { events: 0, signals: 0, transitions: 0 };
  for (let i = 1; ; i++) {
    const extra = checkpoint ? { checkpoint: String(checkpoint) } : {};
    const r = await post('/api/liquidity-failure?' + qs(extra));
    const c = r.created || {};
    totals.events += c.events || 0; totals.signals += c.signals || 0; totals.transitions += c.transitions || 0;
    console.log(`  chunk ${i}: ${r.chunk ? r.chunk.from + ' → ' + r.chunk.to : ''}  ` +
      `+signals=${c.signals || 0} +events=${c.events || 0}  ${Math.round((r.rangeProgressPct || 0) * 100)}%` +
      (r.fetchErrors && r.fetchErrors.length ? `  fetchErrors=${r.fetchErrors.length}` : ''));
    if (r.rangeDone || !r.checkpoint) break;
    checkpoint = r.checkpoint.nextMs;
  }
  console.log(`Backfill complete. Totals: signals=${totals.signals} events=${totals.events} transitions=${totals.transitions}`);

  if (arg('outcomes', false) && !DRY) {
    console.log('Running outcome processor…');
    for (let i = 1; ; i++) {
      const r = await post('/api/liquidity-failure?action=outcomes&limit=500');
      console.log(`  pass ${i}: processed=${r.processed} skipped=${r.skipped} considered=${r.considered}`);
      if ((r.considered || 0) < 500) break;
    }
    console.log('Outcomes complete.');
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
