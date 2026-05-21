'use strict';

const {
  sendEmail,
  confluenceAlertEmail,
  approvedTradesEmail,
  impulseAlertEmail,
} = require('./emailService');

const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
const SKIP_SESSIONS = new Set(['LOW_LIQUIDITY', 'DEAD_HOURS']);

// ── V2 Engine Thresholds (must stay in sync with public/app.js) ──────────────
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

function evaluateConfluence(hourlyRow) {
  if (!hourlyRow) return null;
  const results = [];
  for (const t of V2_THRESHOLDS) {
    const val = parseFloat(hourlyRow[t.key]) || 0;
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

// ── Deduplication ────────────────────────────────────────────────────────────
// Uses a Supabase table `email_alert_log` to prevent sending the same alert
// type within a cooldown window. If the table doesn't exist, alerts send anyway.

async function wasRecentlySent(sb, alertType, cooldownMinutes = 120) {
  try {
    const since = new Date(Date.now() - cooldownMinutes * 60 * 1000).toISOString();
    const { data } = await sb
      .from('email_alert_log')
      .select('id')
      .eq('alert_type', alertType)
      .gte('sent_at', since)
      .limit(1);
    return data && data.length > 0;
  } catch (_) {
    // Table may not exist yet — allow sending
    return false;
  }
}

async function logAlertSent(sb, alertType, details) {
  try {
    await sb.from('email_alert_log').insert({
      alert_type: alertType,
      details: details || {},
      sent_at: new Date().toISOString(),
    });
  } catch (_) {
    console.warn('[email-alert] could not log alert (table may not exist)');
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getSubscribedUsers(sb) {
  const { data: allUsers } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!allUsers?.users?.length) return [];

  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, unsubscribed');

  const prefMap = {};
  for (const p of prefs || []) prefMap[p.user_id] = p;

  return allUsers.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  });
}

async function getLatestHourlyRow(sb) {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from('hourly_session_activity')
    .select('*')
    .gte('time_utc', twoHoursAgo)
    .order('time_utc', { ascending: false })
    .limit(5);
  if (!data?.length) return null;
  // Find latest non-LOW_LIQUIDITY row
  return data.find(r => !SKIP_SESSIONS.has(r.session_name)) || null;
}

async function getM15Impulses(sb) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from('m15_pair_spreads')
    .select('instrument, state, spread_45m')
    .gte('time', oneHourAgo)
    .eq('state', 'EXPANDING')
    .order('time', { ascending: false });
  if (!data?.length) return [];

  const seen = new Set();
  return data.filter(s => {
    if (seen.has(s.instrument)) return false;
    seen.add(s.instrument);
    return true;
  }).map(s => ({
    instrument: s.instrument,
    direction: parseFloat(s.spread_45m) > 0 ? 'BUY' : 'SELL',
    state: 'EXPANDING',
  }));
}

async function getApprovedTrades(sb) {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data } = await sb
    .from('risk_checks')
    .select('instrument, direction, confidence, entry_price, stop_loss, take_profit, signal')
    .eq('status', 'APPROVED')
    .gte('time', twoHoursAgo)
    .order('confidence', { ascending: false })
    .limit(10);
  return data || [];
}

// ── Main entry point ─────────────────────────────────────────────────────────

async function sendSignalAlerts(sb) {
  if (!process.env.BREVO_API_KEY) {
    console.log('[email-alert] BREVO_API_KEY not set — skipping');
    return;
  }

  console.log('[email-alert] checking conditions...');

  // 1. Get latest hourly V2 data and evaluate confluence
  const latestRow = await getLatestHourlyRow(sb);
  const confluence = evaluateConfluence(latestRow);
  const confluenceActive = confluence?.fired || false;
  const sessionName = latestRow?.session_name ? (SESS_LABEL[latestRow.session_name] || latestRow.session_name) : null;

  console.log(`[email-alert] confluence: ${confluenceActive ? 'ACTIVE' : 'NOT MET'} (${confluence?.passed || 0}/${confluence?.total || 11})`);

  // 2. Get M15 impulses and approved trades (only relevant if confluence is active)
  const [impulses, trades] = await Promise.all([
    getM15Impulses(sb),
    confluenceActive ? getApprovedTrades(sb) : Promise.resolve([]),
  ]);

  console.log(`[email-alert] impulses: ${impulses.length}, trades: ${trades.length}`);

  // Nothing to send?
  if (!confluenceActive && !impulses.length) {
    console.log('[email-alert] confluence not met and no impulses — nothing to send');
    return;
  }

  const recipients = await getSubscribedUsers(sb);
  console.log(`[email-alert] ${recipients.length} subscribed users`);
  if (!recipients.length) return;

  const emailsSent = [];

  // ── Engine Confluence alert (2h cooldown) ─────────────────────────────────
  if (confluenceActive) {
    const alreadySent = await wasRecentlySent(sb, 'confluence', 120);
    if (!alreadySent) {
      const confluenceData = {
        ...confluence,
        session: sessionName,
      };
      const template = confluenceAlertEmail(confluenceData);
      for (const u of recipients) {
        try { await sendEmail(u.email, template); } catch (e) {
          console.error(`[email-alert] confluence failed for ${u.email}:`, e.message);
        }
      }
      await logAlertSent(sb, 'confluence', { passed: confluence.passed, total: confluence.total });
      emailsSent.push('confluence');
      console.log(`[email-alert] confluence email sent to ${recipients.length} users`);
    } else {
      console.log('[email-alert] confluence already sent within 2h — skipping');
    }
  }

  // ── Approved Trades alert (2h cooldown, only when confluence active) ──────
  if (confluenceActive && trades.length > 0) {
    const alreadySent = await wasRecentlySent(sb, 'approved_trades', 120);
    if (!alreadySent) {
      const template = approvedTradesEmail(trades, confluence);
      for (const u of recipients) {
        try { await sendEmail(u.email, template); } catch (e) {
          console.error(`[email-alert] trades failed for ${u.email}:`, e.message);
        }
      }
      await logAlertSent(sb, 'approved_trades', { count: trades.length, pairs: trades.map(t => t.instrument) });
      emailsSent.push(`${trades.length} trades`);
      console.log(`[email-alert] approved trades email sent to ${recipients.length} users`);
    } else {
      console.log('[email-alert] approved trades already sent within 2h — skipping');
    }
  }

  // ── M15 Impulse alert (1h cooldown, only when confluence active) ──────────
  if (confluenceActive && impulses.length > 0) {
    const alreadySent = await wasRecentlySent(sb, 'impulse', 60);
    if (!alreadySent) {
      const template = impulseAlertEmail(impulses, confluence);
      for (const u of recipients) {
        try { await sendEmail(u.email, template); } catch (e) {
          console.error(`[email-alert] impulse failed for ${u.email}:`, e.message);
        }
      }
      await logAlertSent(sb, 'impulse', { count: impulses.length, pairs: impulses.map(i => i.instrument) });
      emailsSent.push(`${impulses.length} impulses`);
      console.log(`[email-alert] impulse email sent to ${recipients.length} users`);
    } else {
      console.log('[email-alert] impulse already sent within 1h — skipping');
    }
  }

  if (emailsSent.length) {
    console.log(`[email-alert] done — sent: ${emailsSent.join(', ')} to ${recipients.length} users`);
  } else {
    console.log('[email-alert] done — all alerts recently sent or no qualifying events');
  }
}

module.exports = { sendSignalAlerts };
