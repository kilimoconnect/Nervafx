'use strict';

/**
 * GET /api/currency-chart — candlestick data for one instrument at one timeframe
 * (research, UNVALIDATED). Higher timeframes are aggregated from the stored base
 * candles (M15 for intraday, H1 for H4 and up); W1 starts Monday 00:00 UTC, MN the
 * 1st 00:00 UTC. Pairs are real OHLC; currency indices are the relative zero-sum index
 * path sampled at the base resolution (disclosed — not intrabar synthetic extremes).
 *
 *   ?instrument=EUR_USD     a stored pair, OR
 *   ?instrument=IDX:USD     a currency index (one of the 8 majors)
 *   ?tf=M15|M30|H1|H4|D1|W1|MN   (default H1)
 *   ?asOf=<ms|ISO>          causal historical replay (no look-ahead)
 */

const { getClient, cors } = require('./_db');
const { loadTf, loadParallel } = require('../research/comparison/dbload');
const { buildIndices } = require('../research/comparison/index-build');
const { TIMEFRAMES, baseForTf, lookbackDaysForTf, aggregatePairs, aggregateIndexPath } = require('../research/comparison/aggregate');
const { CURRENCIES, PAIRS, BASE_VALUE, legsFor } = require('../research/comparison/config');

const DAY = 24 * 60 * 60 * 1000, MAX_BARS = 1500;
const sec = (ms) => Math.floor(ms / 1000);

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  try {
    const q = req.query || {};
    const tf = TIMEFRAMES.indexOf(q.tf) >= 0 ? q.tf : 'H1';
    const instrument = (q.instrument || '').toUpperCase();
    const isIndex = instrument.indexOf('IDX:') === 0;
    const ccy = isIndex ? instrument.slice(4) : null;

    if (isIndex ? CURRENCIES.indexOf(ccy) < 0 : PAIRS.indexOf(instrument) < 0) {
      return res.status(400).json({ ok: false, error: 'unknown instrument (use a stored pair or IDX:<CCY>)' });
    }

    let asOfMs = Date.now(), mode = 'live';
    if (q.asOf != null && q.asOf !== '') {
      const t = /^\d+$/.test('' + q.asOf) ? parseInt(q.asOf, 10) : Date.parse(q.asOf);
      if (!isNaN(t) && t < Date.now()) { asOfMs = t; mode = 'historical'; }
    }

    const baseTf = baseForTf(tf);
    const fromIso = new Date(asOfMs - lookbackDaysForTf(tf) * DAY).toISOString();
    const opts = { fromIso }; if (mode === 'historical') opts.toIso = new Date(asOfMs).toISOString();
    const sb = getClient();

    let candles, resolutionNote;
    if (!isIndex) {
      const base = await loadTf(sb, instrument, baseTf, Object.assign({ withVolume: true }, opts));
      if (!base.length) return res.json({ ok: true, available: false, instrument, tf, mode, reason: 'no candles for this instrument/window' });
      candles = aggregatePairs(base, tf);
      resolutionNote = tf === baseTf ? ('Stored ' + baseTf + ' candles.') : ('Aggregated from stored ' + baseTf + ' candles.');
    } else {
      const by = await loadParallel(sb, PAIRS, baseTf, Object.assign({ withVolume: true }, opts), 8);
      const built = buildIndices(by, { baseMs: baseTf === 'M15' ? 15 * 60 * 1000 : 60 * 60 * 1000 });
      if (!built.ok) return res.json({ ok: true, available: false, instrument, tf, mode, reason: built.reason || 'insufficient synchronized candles' });
      candles = aggregateIndexPath(built, ccy, tf);
      // Basket volume PROXY: sum the tick volume of the currency's 7 pairs per bucket.
      const volByTime = new Map();
      for (const leg of legsFor(ccy)) { for (const c of aggregatePairs(by[leg.pair] || [], tf)) { if (c.volume != null) volByTime.set(c.time, (volByTime.get(c.time) || 0) + c.volume); } }
      for (const c of candles) { const v = volByTime.get(c.time); c.volume = (v == null ? null : v); }
      resolutionNote = 'Relative zero-sum index (base ' + BASE_VALUE + '), built from ' + built.resolution +
        ' pair log-returns then aggregated to ' + tf + '. Highs/lows sampled at ' + built.resolution + ' — not intrabar synthetic extremes.';
    }

    if (candles.length > MAX_BARS) candles = candles.slice(candles.length - MAX_BARS);
    const hasVolume = candles.some((c) => c.volume != null);
    const volumeKind = isIndex ? 'basket proxy (Σ tick volume of the 7 pairs)' : 'tick volume';
    const data = candles.map((c) => { const d = { time: sec(c.time), open: c.open, high: c.high, low: c.low, close: c.close }; if (hasVolume) d.volume = c.volume == null ? 0 : c.volume; return d; });

    res.json({
      ok: true, available: data.length > 0, mode,
      instrument, kind: isIndex ? 'index' : 'pair', tf, base: baseTf,
      hasVolume, volumeKind: hasVolume ? volumeKind : null, count: data.length,
      firstUtc: data.length ? new Date(data[0].time * 1000).toISOString() : null,
      lastUtc: data.length ? new Date(data[data.length - 1].time * 1000).toISOString() : null,
      resolutionNote,
      precision: isIndex ? 3 : (instrument.indexOf('JPY') >= 0 ? 3 : 5),
      candles: data,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

module.exports.maxDuration = 60;
