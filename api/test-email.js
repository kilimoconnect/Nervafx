'use strict';

/**
 * POST /api/test-email
 *
 * Sends test email alerts to the requesting admin user.
 * Fetches live engine data, evaluates confluence, and sends all applicable
 * email types (confluence, impulse, approved trades) to the admin's email.
 * Bypasses dedup cooldowns since this is a manual test.
 */

const { createClient } = require('@supabase/supabase-js');
const {
  sendEmail,
  confluenceAlertEmail,
  approvedTradesEmail,
  impulseAlertEmail,
} = require('../src/emailService');

const ADMIN_ID = '140f3854-2c85-488c-8e0a-0f965d562654';
const SKIP_SESSIONS = new Set(['LOW_LIQUIDITY', 'DEAD_HOURS']);
const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };

const V2_THRESHOLDS = [
  { key: 'market_energy',       label: 'Energy',  min: 50, optimal: 65 },
  { key: 'tradability_score',   label: 'Trad',    min: 55, optimal: 70 },
  { key: 'movement_score',      label: 'Mov',     min: 35, optimal: 70 },
  { key: 'breadth_score',       label: 'Brd',     min: 65, optimal: 80 },
  { key: 'agreement_score',     label: 'Agr',     min: 60, optimal: 75 },
  { key: 'directional_control', label: 'DirCtrl', min: 30, optimal: 45 },
  { key: 'volatility_quality',  label: 'VolQ',    min: 30, optimal: 60 },
  { key: 'volatility_score',    label: 'Vol',     min: 40, optimal: 70 },
  { key: 'momentum_score',      label: 'Mom',     min: 30, optimal: 60, signed: true },
  { key: 'chaos_score',         label: 'Chaos',   max: 35, warnAbove: 50 },
  { key: 'false_breakout_risk', label: 'FBRisk',  max: 15, warnAbove: 30 },
];
const V2_FIRE_PCT = 0.60;

function evaluateConfluence(row) {
  if (!row) return null;
  const results = [];
  for (const t of V2_THRESHOLDS) {
    const val = parseFloat(row[t.key]) || 0;
    const pass = t.max !== undefined ? val <= t.max : val >= t.min;
    results.push({
      key: t.key, label: t.label, value: Math.round(val),
      threshold: t.min !== undefined ? t.min : t.max,
      optimal: t.optimal, pass, inverted: t.max !== undefined, signed: t.signed,
    });
  }
  const passed = results.filter(r => r.pass).length;
  const total  = results.length;
  const pct    = total > 0 ? passed / total : 0;
  return { results, passed, total, pct, fired: pct >= V2_FIRE_PCT };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Auth — admin only
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!auth) return res.status(401).json({ error: 'Auth required' });

  let userEmail = null;
  try {
    const { data: { user } } = await sb.auth.getUser(auth);
    if (!user || user.id !== ADMIN_ID) return res.status(403).json({ error: 'Admin only' });
    userEmail = user.email;
  } catch (_) {
    return res.status(403).json({ error: 'Auth error' });
  }

  if (!process.env.BREVO_API_KEY) {
    return res.status(500).json({ error: 'BREVO_API_KEY not configured' });
  }

  try {
    // Get latest hourly V2 data
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { data: hourlyRows } = await sb
      .from('hourly_session_activity')
      .select('*')
      .gte('time_utc', twoHoursAgo)
      .order('time_utc', { ascending: false })
      .limit(5);

    const latestRow = (hourlyRows || []).find(r => !SKIP_SESSIONS.has(r.session_name)) || null;
    const confluence = evaluateConfluence(latestRow);
    const session = latestRow?.session_name ? (SESS_LABEL[latestRow.session_name] || latestRow.session_name) : 'N/A';

    // Get M15 impulses
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: impulseData } = await sb
      .from('m15_pair_spreads')
      .select('instrument, state, spread_45m')
      .gte('time', oneHourAgo)
      .eq('state', 'EXPANDING')
      .order('time', { ascending: false });

    const seen = new Set();
    const impulses = (impulseData || []).filter(s => {
      if (seen.has(s.instrument)) return false;
      seen.add(s.instrument);
      return true;
    }).map(s => ({
      instrument: s.instrument,
      direction: parseFloat(s.spread_45m) > 0 ? 'BUY' : 'SELL',
    }));

    // Get approved trades
    const { data: trades } = await sb
      .from('risk_checks')
      .select('instrument, direction, confidence, entry_price, stop_loss, take_profit, signal')
      .eq('status', 'APPROVED')
      .gte('time', twoHoursAgo)
      .order('confidence', { ascending: false })
      .limit(10);

    // Build confluence data (even if not fired, send it for testing)
    const confluenceData = confluence
      ? { ...confluence, session }
      : { results: [], passed: 0, total: 11, pct: 0, fired: false, session };

    const emailsSent = [];

    // Always send confluence email for test
    const confTemplate = confluenceAlertEmail(confluenceData);
    await sendEmail(userEmail, confTemplate);
    emailsSent.push('confluence');

    // Send impulse email if there are impulses
    if (impulses.length > 0) {
      const impTemplate = impulseAlertEmail(impulses, confluenceData);
      await sendEmail(userEmail, impTemplate);
      emailsSent.push('impulse');
    }

    // Send approved trades email if there are trades
    if (trades?.length > 0) {
      const tradeTemplate = approvedTradesEmail(trades, confluenceData);
      await sendEmail(userEmail, tradeTemplate);
      emailsSent.push('approved_trades');
    }

    return res.json({
      ok: true,
      sent: emailsSent.length,
      types: emailsSent,
      to: userEmail,
      confluence: {
        fired: confluence?.fired || false,
        passed: confluence?.passed || 0,
        total: confluence?.total || 11,
      },
      impulses: impulses.length,
      trades: trades?.length || 0,
    });

  } catch (e) {
    console.error('[test-email]', e);
    return res.status(500).json({ error: e.message });
  }
};
