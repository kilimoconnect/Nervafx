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

// Compute the start of the forex day containing time t (21:00 UTC boundary, weekend-adjusted)
function getForexDayStart(t) {
  const d = new Date(t);
  const h = d.getUTCHours();
  let dayStart;
  if (h >= 21) {
    dayStart = new Date(d); dayStart.setUTCHours(21, 0, 0, 0);
  } else {
    dayStart = new Date(d); dayStart.setUTCDate(dayStart.getUTCDate() - 1); dayStart.setUTCHours(21, 0, 0, 0);
  }
  const dsDay = dayStart.getUTCDay();
  if (dsDay === 5) dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  else if (dsDay === 6) dayStart.setUTCDate(dayStart.getUTCDate() - 2);
  return dayStart;
}

function getPrevForexDayStart(dayStart) {
  const d = new Date(dayStart);
  let prev = new Date(d.getTime() - 24 * 3600000);
  const pd = prev.getUTCDay();
  if (pd === 6) prev.setUTCDate(prev.getUTCDate() - 2);
  else if (pd === 5) prev.setUTCDate(prev.getUTCDate() - 1);
  return prev;
}

// Fetch daily directions for every forex day in a range.
// Returns { [inst]: [{ dayStartISO, dayEndISO, direction, bodyPct, rangePips }] } sorted by dayStart.
async function fetchDailyDirectionMap(sb, pairs, sinceISO, untilISO) {
  // Extend fetch range back by 2 days to ensure we have the "yesterday" for the earliest signal
  const fetchSince = new Date(new Date(sinceISO).getTime() - 3 * 24 * 3600000).toISOString();
  const fetchUntil = untilISO;

  const PAGE = 1000;
  const byInst = {};

  for (let b = 0; b < pairs.length; b += 7) {
    const batch = pairs.slice(b, b + 7);
    const results = await Promise.all(batch.map(async inst => {
      const allData = [];
      let off = 0;
      while (true) {
        const { data, error } = await sb
          .from('backtest_candles')
          .select('time, open, high, low, close')
          .eq('instrument', inst).eq('timeframe', 'H1')
          .gte('time', fetchSince).lte('time', fetchUntil)
          .order('time', { ascending: true })
          .range(off, off + PAGE - 1);
        if (error) return { inst, data: [] };
        if (!data || !data.length) break;
        allData.push(...data);
        if (data.length < PAGE) break;
        off += PAGE;
      }
      return { inst, data: allData };
    }));

    for (const { inst, data } of results) {
      if (!data.length) continue;
      // Group H1 candles by forex day
      const byDay = {};
      for (const c of data) {
        const dayStart = getForexDayStart(c.time);
        const key = dayStart.toISOString();
        if (!byDay[key]) byDay[key] = [];
        byDay[key].push(c);
      }
      const days = [];
      const pd = inst.includes('JPY') ? 0.01 : 0.0001;
      for (const dayStartISO of Object.keys(byDay).sort()) {
        const candles = byDay[dayStartISO];
        if (candles.length < 5) continue;
        const ydOpen = parseFloat(candles[0].open);
        const ydClose = parseFloat(candles[candles.length - 1].close);
        let ydHigh = -Infinity, ydLow = Infinity;
        for (const c of candles) {
          const h = parseFloat(c.high), l = parseFloat(c.low);
          if (h > ydHigh) ydHigh = h;
          if (l < ydLow) ydLow = l;
        }
        const ydRange = ydHigh - ydLow;
        if (ydRange < pd) continue;
        const ydBody = Math.abs(ydClose - ydOpen);
        days.push({
          dayStartISO,
          direction: ydClose > ydOpen ? 'BUY' : 'SELL',
          bodyPct: Math.round((ydBody / ydRange) * 100),
          rangePips: Math.round((ydRange / pd) * 10) / 10,
        });
      }
      byInst[inst] = days;
    }
  }

  return byInst;
}

// Look up the applicable daily direction for a signal at time t (uses the *previous* forex day)
function getDirectionForTime(directionMap, inst, t) {
  const days = directionMap[inst];
  if (!days || !days.length) return null;
  const dayStart = getForexDayStart(t);
  const prevStart = getPrevForexDayStart(dayStart).toISOString();
  return days.find(d => d.dayStartISO === prevStart) || null;
}

module.exports = {
  VALID_PAIRS,
  fetchDailyDirection,
  computeDailyDirectionFromCache,
  fetchDailyDirectionMap,
  getDirectionForTime,
  getForexDayStart,
  getPrevForexDayStart,
};
