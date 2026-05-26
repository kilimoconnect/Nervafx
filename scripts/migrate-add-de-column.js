#!/usr/bin/env node
'use strict';

/**
 * Migration: Add de_combined column to m15_pair_spreads table.
 *
 * Run once:  node scripts/migrate-add-de-column.js
 *
 * This stores DE directly in the M15 pipeline output, eliminating the
 * dependency on backtest_candles M15 data for the de-history endpoint.
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

async function migrate() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Check if column already exists
  const { data, error } = await sb
    .from('m15_pair_spreads')
    .select('de_combined')
    .limit(1);

  if (!error) {
    console.log('✓ de_combined column already exists in m15_pair_spreads');
    return;
  }

  if (error && error.message.includes('does not exist')) {
    console.log('Column de_combined does not exist yet.');
    console.log('');
    console.log('Please add it via the Supabase SQL Editor:');
    console.log('');
    console.log('  ALTER TABLE m15_pair_spreads ADD COLUMN de_combined real DEFAULT 0;');
    console.log('');
    console.log('Then re-run this script to verify.');
    process.exit(1);
  }

  console.error('Unexpected error:', error.message);
  process.exit(1);
}

migrate();
