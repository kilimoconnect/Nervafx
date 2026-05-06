require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

app.use(express.static(path.join(__dirname, 'public')));

// ─── API helpers ──────────────────────────────────────────────────────────────

function latest28(table, columns, timeCol = 'time') {
  return supabase.from(table).select(columns).order(timeCol, { ascending: false }).limit(28);
}

async function getLatestTime(table) {
  const { data } = await supabase.from(table).select('time').order('time', { ascending: false }).limit(1);
  return data?.[0]?.time || null;
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

app.get('/api/strength', async (req, res) => {
  try {
    const t = await getLatestTime('currency_strength');
    if (!t) return res.json([]);
    const { data, error } = await supabase
      .from('currency_strength')
      .select('currency, normalized_3h, normalized_6h, normalized_12h, smooth_3h, smooth_6h, smooth_12h')
      .eq('time', t);
    if (error) throw error;
    res.json({ time: t, currencies: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/signals', async (req, res) => {
  try {
    const t = await getLatestTime('trade_signals');
    if (!t) return res.json([]);
    const { data, error } = await supabase
      .from('trade_signals')
      .select('*')
      .eq('time', t)
      .order('confidence', { ascending: false });
    if (error) throw error;
    res.json({ time: t, signals: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/states', async (req, res) => {
  try {
    const t = await getLatestTime('market_states');
    if (!t) return res.json([]);
    const { data, error } = await supabase
      .from('market_states')
      .select('instrument, bias, state, confidence, spread_3h, spread_6h, spread_12h, reason')
      .eq('time', t)
      .order('confidence', { ascending: false });
    if (error) throw error;
    res.json({ time: t, states: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/risk', async (req, res) => {
  try {
    const t = await getLatestTime('risk_checks');
    if (!t) return res.json({ approved: [], summary: {} });

    const today = new Date(t);
    const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();

    const { data, error } = await supabase
      .from('risk_checks')
      .select('*')
      .gte('time', dayStart)
      .order('time', { ascending: false });

    if (error) throw error;
    const approved = (data || []).filter(r => r.status === 'APPROVED');
    const totalRisk = approved.reduce((s, r) => s + parseFloat(r.risk_amount), 0);
    const balance = approved[0]?.account_balance || 1000;

    res.json({
      approved,
      rejected: (data || []).filter(r => r.status === 'REJECTED'),
      summary: {
        openTrades: approved.length,
        maxTrades: 3,
        dailyRisk: totalRisk,
        dailyRiskPct: ((totalRisk / balance) * 100).toFixed(2),
        maxDailyRiskPct: 2,
        balance,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/actions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('trade_actions')
      .select('*')
      .order('time', { ascending: false })
      .limit(20);
    if (error) throw error;
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/quality', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('data_quality_checks')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    res.json(data?.[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/spreads', async (req, res) => {
  try {
    const t = await getLatestTime('pair_strength_spreads');
    if (!t) return res.json([]);
    const { data, error } = await supabase
      .from('pair_strength_spreads')
      .select('instrument, base_currency, quote_currency, spread_3h, spread_6h, spread_12h')
      .eq('time', t)
      .order('spread_6h', { ascending: false });
    if (error) throw error;
    res.json({ time: t, spreads: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`NervaFX Dashboard running at http://localhost:${PORT}`);
});
