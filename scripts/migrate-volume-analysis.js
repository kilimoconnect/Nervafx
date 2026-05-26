#!/usr/bin/env node
'use strict';

/**
 * Migration: Create m15_volume_analysis table.
 *
 * Run once:  node scripts/migrate-volume-analysis.js
 *
 * If the table doesn't exist, prints the SQL to run in Supabase SQL Editor.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const SQL = `
-- M15 Volume Analysis — Participation Intelligence
CREATE TABLE IF NOT EXISTS m15_volume_analysis (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  time                  timestamptz NOT NULL,
  instrument            text NOT NULL,
  session               text NOT NULL,            -- ASIA / LONDON / NEW_YORK / LOW_LIQUIDITY
  volume                integer NOT NULL DEFAULT 0,
  relative_volume       real NOT NULL DEFAULT 0,   -- current / session_avg
  volume_acceleration   integer NOT NULL DEFAULT 0, -- current - previous
  volume_persistence    integer NOT NULL DEFAULT 0, -- consecutive high-vol candles
  volume_efficiency     real NOT NULL DEFAULT 0,   -- net_move / normalized_volume
  participation_score   integer NOT NULL DEFAULT 0, -- 0–100 composite
  participation_grade   text NOT NULL DEFAULT 'NORMAL', -- INSTITUTIONAL/STRONG/NORMAL/WEAK/DEAD
  created_at            timestamptz DEFAULT now(),
  UNIQUE (time, instrument)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_m15_vol_time ON m15_volume_analysis (time);
CREATE INDEX IF NOT EXISTS idx_m15_vol_instrument_time ON m15_volume_analysis (instrument, time);
CREATE INDEX IF NOT EXISTS idx_m15_vol_session ON m15_volume_analysis (session, time);
CREATE INDEX IF NOT EXISTS idx_m15_vol_grade ON m15_volume_analysis (participation_grade, time);
`;

async function migrate() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Check if table already exists
  const { data, error } = await sb
    .from('m15_volume_analysis')
    .select('id')
    .limit(1);

  if (!error) {
    console.log('✓ m15_volume_analysis table already exists');
    return;
  }

  if (error && (error.message.includes('does not exist') || error.message.includes('relation'))) {
    console.log('Table m15_volume_analysis does not exist yet.');
    console.log('');
    console.log('Please run this SQL in the Supabase SQL Editor:');
    console.log('');
    console.log(SQL);
    console.log('');
    console.log('Then re-run this script to verify.');
    process.exit(1);
  }

  console.error('Unexpected error:', error.message);
  process.exit(1);
}

migrate();
