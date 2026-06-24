'use strict';

/**
 * Layer 9 — Historical Intelligence: store one structure snapshot per pair
 * every hour. Called from the pipeline after candles are synced.
 *
 * Requires table `structure_snapshots` (see SQL in createTableSQL below).
 */

const { createClient } = require('@supabase/supabase-js');
const engine = require('../api/structure-engine');

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Hour bucket (truncate to the top of the current UTC hour) so re-runs upsert
function hourBucket(iso) {
  const d = new Date(iso || Date.now());
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

async function storeStructureSnapshots(sb) {
  if (!sb) sb = getDB();

  const data = await engine.computeStructure(sb);
  if (!data?.pairs?.length) {
    console.log('[STRUCTURE-SNAPSHOT] No pairs computed');
    return { stored: 0 };
  }

  const bucket = hourBucket(data.generatedAt);

  const rows = data.pairs.map(p => {
    const [base, quote] = p.instrument.split('_');
    return {
      time_utc: bucket,
      instrument: p.instrument,
      structure_score: p.structureScore,
      structure_label: p.structureLabel,
      trend: p.trend,
      market_state: p.state,
      trend_valid: p.trendValid,
      bos_direction: p.bos ? p.bos.direction : null,
      bos_level: p.bos ? p.bos.level : null,
      choch: p.choch || null,
      nearest_support: p.nearestSupport ? p.nearestSupport.price : null,
      nearest_resistance: p.nearestResistance ? p.nearestResistance.price : null,
      invalidation: p.invalidation,
      efficiency: p.efficiency,
      persistence: p.persistence,
      expansion: p.expansion,
      pullback_quality: p.pullbackQuality,
      m15_score: p.m15 ? p.m15.score : null,
      m15_state: p.m15 ? p.m15.state : null,
      base_ccy_score: data.currencies[base]?.avgStructure ?? null,
      quote_ccy_score: data.currencies[quote]?.avgStructure ?? null,
      trade_approved: p.approval.approved,
    };
  });

  // Upsert on (time_utc, instrument) so re-runs within the same hour replace
  const { error } = await sb
    .from('structure_snapshots')
    .upsert(rows, { onConflict: 'time_utc,instrument' });

  if (error) {
    console.error('[STRUCTURE-SNAPSHOT]', error.message);
    return { stored: 0, error: error.message };
  }

  console.log(`[STRUCTURE-SNAPSHOT] Stored ${rows.length} pair snapshots @ ${bucket}`);

  // Email any newly-approved trades (reuses the data we just computed)
  let alerts = { sent: 0 };
  try {
    const { sendApprovedTradeAlerts } = require('./structureAlerts');
    alerts = await sendApprovedTradeAlerts(sb, data);
  } catch (e) {
    console.error('[STRUCTURE-SNAPSHOT] alert error:', e.message);
  }

  return { stored: rows.length, time: bucket, alerts };
}

// Reference SQL (run once in Supabase SQL editor):
const createTableSQL = `
create table if not exists structure_snapshots (
  id bigint generated always as identity primary key,
  time_utc timestamptz not null,
  instrument text not null,
  structure_score int,
  structure_label text,
  trend text,
  market_state text,
  trend_valid text,
  bos_direction text,
  bos_level double precision,
  choch text,
  nearest_support double precision,
  nearest_resistance double precision,
  invalidation double precision,
  efficiency int,
  persistence int,
  expansion int,
  pullback_quality int,
  m15_score int,
  m15_state text,
  base_ccy_score int,
  quote_ccy_score int,
  trade_approved boolean,
  created_at timestamptz default now(),
  unique (time_utc, instrument)
);
create index if not exists idx_structure_snap_inst_time on structure_snapshots (instrument, time_utc desc);
create index if not exists idx_structure_snap_time on structure_snapshots (time_utc desc);
`;

module.exports = { storeStructureSnapshots, createTableSQL };
