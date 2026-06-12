'use strict';

/**
 * Repair hourly momentum_score for days where every hour was stored as 0
 * (written by an older backfill before momentum was computed).
 *
 * Momentum is recomputed from the stored movement_score sequence:
 *   momentum[i] = movement[i] - movement[i-1]   (previous stored hour)
 * momentum_type is re-derived with the same classifier as the live engine.
 *
 * Only rows on all-zero days are updated — live-computed days are untouched.
 *
 * Usage: node scripts/fix-momentum.js [--dry]
 */

require('dotenv').config({ quiet: true });
const { supabase } = require('../src/supabase');

const DRY = process.argv.includes('--dry');

function round1(v) { return Math.round(v * 10) / 10; }

function classifyMomentum(momentumScore, momentumAccel, movementScore) {
  if (momentumScore > 15 && movementScore >= 50) return 'IMPULSE';
  if (momentumScore > 5 && momentumAccel > 2) return 'EXPANSION';
  if (movementScore >= 40 && momentumScore < -5) return 'EXHAUSTION';
  if (momentumScore > 3) return 'TREND';
  if (momentumScore < -3) return 'DECAY';
  return 'STABLE';
}

(async () => {
  // Fetch entire history ordered by time
  const all = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('hourly_session_activity')
      .select('time_utc, session_name, movement_score, momentum_score, momentum_type')
      .order('time_utc', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`Fetched ${all.length} hourly rows`);

  // Identify all-zero days (excluding off-hours sessions)
  const byDay = {};
  for (const r of all) {
    if (['LOW_LIQUIDITY', 'DEAD_HOURS'].includes(r.session_name)) continue;
    const d = r.time_utc.slice(0, 10);
    (byDay[d] = byDay[d] || []).push(r);
  }
  const brokenDays = new Set();
  for (const [d, rows] of Object.entries(byDay)) {
    if (rows.every(r => (parseFloat(r.momentum_score) || 0) === 0)) brokenDays.add(d);
  }
  console.log(`All-zero momentum days: ${[...brokenDays].sort().join(', ') || 'none'}`);
  if (!brokenDays.size) return;

  // Recompute momentum from the stored movement sequence
  const updates = [];
  for (let i = 0; i < all.length; i++) {
    const r = all[i];
    if (!brokenDays.has(r.time_utc.slice(0, 10))) continue;
    if (['LOW_LIQUIDITY', 'DEAD_HOURS'].includes(r.session_name)) continue;
    const prev = i > 0 ? all[i - 1] : null;
    const prev2 = i > 1 ? all[i - 2] : null;
    if (!prev) continue;

    const move = parseFloat(r.movement_score) || 0;
    const prevMove = parseFloat(prev.movement_score) || 0;
    const momentum = round1(move - prevMove);
    const prevMomentum = prev2 ? round1(prevMove - (parseFloat(prev2.movement_score) || 0)) : 0;
    const accel = round1(momentum - prevMomentum);
    const type = classifyMomentum(momentum, accel, move);

    updates.push({ time_utc: r.time_utc, momentum_score: momentum, momentum_type: type });
  }

  console.log(`${updates.length} rows to update${DRY ? ' (dry run — not writing)' : ''}`);
  if (DRY) {
    for (const u of updates.slice(0, 20)) console.log(' ', u.time_utc, '→', u.momentum_score, u.momentum_type);
    return;
  }

  let done = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from('hourly_session_activity')
      .update({ momentum_score: u.momentum_score, momentum_type: u.momentum_type })
      .eq('time_utc', u.time_utc);
    if (error) { console.error(u.time_utc, error.message); continue; }
    done++;
  }
  console.log(`Updated ${done}/${updates.length} rows`);
})();
