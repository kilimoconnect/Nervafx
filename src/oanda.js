const { config } = require('./config');

const RATE_LIMIT_DELAY = 200;

async function fetchCandles(instrument, { count, from, to } = {}) {
  const params = new URLSearchParams({
    granularity: config.granularity,
    price: 'M',
  });

  if (count) params.set('count', String(count));
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const url = `${config.oanda.baseUrl}/v3/instruments/${instrument}/candles?${params}`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${config.oanda.apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OANDA ${res.status} for ${instrument}: ${body}`);
  }

  const data = await res.json();
  return data.candles || [];
}

function parseCandles(instrument, rawCandles) {
  return rawCandles
    .filter(c => c.complete === true)
    .map(c => ({
      instrument,
      timeframe: config.granularity,
      time: c.time,
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
      volume: c.volume,
      complete: true,
      source: 'OANDA',
    }));
}

async function fetchAndParseCandles(instrument, opts = {}) {
  const raw = await fetchCandles(instrument, opts);
  return parseCandles(instrument, raw);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { fetchCandles, parseCandles, fetchAndParseCandles, sleep, RATE_LIMIT_DELAY };
