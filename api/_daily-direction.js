'use strict';

const VALID_PAIRS = [
  'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
  'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
  'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
  'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
  'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
];

function getForexYesterday() {
  const now = new Date();
  const h = now.getUTCHours();
  let dayStart;
  if (h >= 21) {
    dayStart = new Date(now); dayStart.setUTCHours(21, 0, 0, 0);
  } else {
    dayStart = new Date(now); dayStart.setUTCDate(dayStart.getUTCDate() - 1); dayStart.setUTCHours(21, 0, 0, 0);
  }
  const dsDay = dayStart.getUTCDay();
  if (dsDay === 5) dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  else if (dsDay === 6) dayStart.setUTCDate(dayStart.getUTCDate() - 2);

  let prevStart = new Date(dayStart.getTime() - 24 * 3600000);
  const pdDay = prevStart.getUTCDay();
  if (pdDay === 6) prevStart.setUTCDate(prevStart.getUTCDate() - 2);
  else if (pdDay === 5) prevStart.setUTCDate(prevStart.getUTCDate() - 1);

  return { dayStartISO: dayStart.toISOString(), prevStartISO: prevStart.toISOString() };
}

async function fetchDailyDirection(sb, pairs) {
  const { dayStartISO, prevStartISO } = getForexYesterday();
  const PAGE = 1000;
  const dailyDirection = {};

  for (let b = 0; b < pairs.length; b += 7) {
    const batch = pairs.slice(b, b + 7);
    const results = await Promise.all(batch.map(async inst => {
      const { data, error } = await sb
        .from('backtest_candles')
        .select('time, open, high, low, close')
        .eq('instrument', inst).eq('timeframe', 'H1')
        .gte('time', prevStartISO).lt('time', dayStartISO)
        .order('time', { ascending: true }).limit(PAGE);
      return { inst, data: error ? [] : data || [] };
    }));
    for (const { inst, data } of results) {
      if (data.length < 5) continue;
      const ydOpen = parseFloat(data[0].open);
      const ydClose = parseFloat(data[data.length - 1].close);
      let ydHigh = -Infinity, ydLow = Infinity;
      for (const c of data) {
        const h = parseFloat(c.high), l = parseFloat(c.low);
        if (h > ydHigh) ydHigh = h;
        if (l < ydLow) ydLow = l;
      }
      const ydRange = ydHigh - ydLow;
      const pd = inst.includes('JPY') ? 0.01 : 0.0001;
      if (ydRange < pd) continue;
      const ydBody = Math.abs(ydClose - ydOpen);
      dailyDirection[inst] = {
        direction: ydClose > ydOpen ? 'BUY' : 'SELL',
        bodyPct: Math.round((ydBody / ydRange) * 100),
        rangePips: Math.round((ydRange / pd) * 10) / 10,
      };
    }
  }

  return dailyDirection;
}

function computeDailyDirectionFromCache(h1Cache, pairs) {
  const { dayStartISO, prevStartISO } = getForexYesterday();
  const dailyDirection = {};

  for (const inst of pairs) {
    const candles = h1Cache[inst] || [];
    const ydCandles = candles.filter(c => c.time >= prevStartISO && c.time < dayStartISO);
    if (ydCandles.length < 5) continue;
    const ydOpen = ydCandles[0].open;
    const ydClose = ydCandles[ydCandles.length - 1].close;
    let ydHigh = -Infinity, ydLow = Infinity;
    for (const c of ydCandles) {
      if (c.high > ydHigh) ydHigh = c.high;
      if (c.low < ydLow) ydLow = c.low;
    }
    const ydRange = ydHigh - ydLow;
    const pd = inst.includes('JPY') ? 0.01 : 0.0001;
    if (ydRange < pd) continue;
    const ydBody = Math.abs(ydClose - ydOpen);
    dailyDirection[inst] = {
      direction: ydClose > ydOpen ? 'BUY' : 'SELL',
      bodyPct: Math.round((ydBody / ydRange) * 100),
      rangePips: Math.round((ydRange / pd) * 10) / 10,
    };
  }

  return dailyDirection;
}

module.exports = { VALID_PAIRS, fetchDailyDirection, computeDailyDirectionFromCache };
