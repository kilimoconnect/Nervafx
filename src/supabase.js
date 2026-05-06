const { createClient } = require('@supabase/supabase-js');
const { config } = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

async function upsertCandles(candles) {
  if (candles.length === 0) return { inserted: 0 };

  const { data, error } = await supabase
    .from('market_candles')
    .upsert(candles, { onConflict: 'instrument,timeframe,time', ignoreDuplicates: true });

  if (error) throw new Error(`Supabase upsert error: ${error.message}`);
  return { inserted: candles.length };
}

async function getCandlesForInstrument(instrument, timeframe) {
  const { data, error } = await supabase
    .from('market_candles')
    .select('time')
    .eq('instrument', instrument)
    .eq('timeframe', timeframe)
    .order('time', { ascending: true });

  if (error) throw new Error(`Supabase select error: ${error.message}`);
  return data;
}

async function insertQualityCheck(check) {
  const { error } = await supabase
    .from('data_quality_checks')
    .insert(check);

  if (error) throw new Error(`Quality check insert error: ${error.message}`);
}

async function getCandleCount(instrument, timeframe) {
  const { count, error } = await supabase
    .from('market_candles')
    .select('*', { count: 'exact', head: true })
    .eq('instrument', instrument)
    .eq('timeframe', timeframe);

  if (error) throw new Error(`Count error: ${error.message}`);
  return count;
}

module.exports = { supabase, upsertCandles, getCandlesForInstrument, insertQualityCheck, getCandleCount };
