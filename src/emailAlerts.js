'use strict';

const { sendEmail, signalAlertEmail, momentumAlertEmail } = require('./emailService');

const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
const SKIP_SESSIONS = new Set(['LOW_LIQUIDITY', 'DEAD_HOURS']);

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

async function detectMomentum(sb) {
  const today = new Date().toISOString().split('T')[0];
  const { data: rows } = await sb
    .from('session_activity')
    .select('session_name, breadth_score, time_utc')
    .gte('time_utc', today + 'T00:00:00Z')
    .order('time_utc', { ascending: true });

  if (!rows?.length) return null;

  const valid = rows.filter(r => !SKIP_SESSIONS.has(r.session_name));
  const breadths = valid.map(r => Math.round(parseFloat(r.breadth_score) || 0));

  let bestStreak = 0, bestEnd = -1, streak = 0;
  for (let i = 1; i < breadths.length; i++) {
    if (breadths[i] >= breadths[i - 1] && breadths[i] >= 10 && breadths[i - 1] >= 10) {
      streak++;
      if (streak >= 2 && streak > bestStreak) {
        bestStreak = streak;
        bestEnd = i;
      }
    } else {
      streak = 0;
    }
  }

  if (bestStreak >= 2 && bestEnd >= 0) {
    const peakRow = valid[bestEnd];
    return {
      session: SESS_LABEL[peakRow.session_name] || peakRow.session_name,
      streak: bestStreak + 1,
      peakVal: breadths[bestEnd],
    };
  }
  return null;
}

async function detectImpulses(sb) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: spreads } = await sb
    .from('m15_pair_spreads')
    .select('instrument, state, spread_45m')
    .gte('time', oneHourAgo)
    .eq('state', 'EXPANDING')
    .order('time', { ascending: false });

  if (!spreads?.length) return [];

  const seen = new Set();
  return spreads.filter(s => {
    if (seen.has(s.instrument)) return false;
    seen.add(s.instrument);
    return true;
  }).map(s => ({
    instrument: s.instrument,
    direction: parseFloat(s.spread_45m) > 0 ? 'BUY' : 'SELL',
    state: 'EXPANDING',
  }));
}

async function sendSignalAlerts(sb) {
  if (!process.env.BREVO_API_KEY) {
    console.log('[email-alert] BREVO_API_KEY not set — skipping');
    return;
  }

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  console.log(`[email-alert] checking signals since ${twoHoursAgo}`);

  // Trade signals
  const { data: signals, error: sigErr } = await sb
    .from('trade_signals')
    .select('instrument, direction, confidence, reason')
    .gte('time', twoHoursAgo)
    .in('signal', ['BUY', 'SELL'])
    .gte('confidence', 65)
    .order('confidence', { ascending: false })
    .limit(10);

  if (sigErr) console.error('[email-alert] signal query error:', sigErr.message);
  console.log(`[email-alert] found ${signals?.length || 0} signals (conf>=65), ${signals?.map(s => s.instrument + ':' + s.confidence).join(', ') || 'none'}`);

  // Momentum + M15 impulse
  const [momentum, impulses] = await Promise.all([
    detectMomentum(sb),
    detectImpulses(sb),
  ]);

  const hasTradeSignals = signals?.length > 0;
  const hasMomentum = !!momentum;
  const hasImpulses = impulses?.length > 0;

  console.log(`[email-alert] signals:${hasTradeSignals} momentum:${hasMomentum} impulses:${hasImpulses}`);

  if (!hasTradeSignals && !hasMomentum && !hasImpulses) {
    console.log('[email-alert] nothing to send');
    return;
  }

  const recipients = await getSubscribedUsers(sb);
  console.log(`[email-alert] ${recipients.length} subscribed users`);
  if (!recipients.length) return;

  const emails = [];

  // Trade signal email
  if (hasTradeSignals) {
    const { data: sessions } = await sb
      .from('session_activity')
      .select('session_name, energy_cycle, market_energy')
      .order('time', { ascending: false })
      .limit(3);

    const sessionSummary = sessions?.map(s =>
      `${s.session_name}: ${s.energy_cycle} (E:${Math.round(s.market_energy || 0)})`
    ).join(' · ') || '';

    emails.push(signalAlertEmail(signals, sessionSummary));
  }

  // Momentum / impulse email (combined or momentum alone)
  if (hasMomentum || hasImpulses) {
    emails.push(momentumAlertEmail(momentum, hasImpulses ? impulses : []));
  }

  for (const template of emails) {
    for (const u of recipients) {
      try {
        await sendEmail(u.email, template);
      } catch (e) {
        console.error(`[email-alert] failed for ${u.email}:`, e.message);
      }
    }
  }

  const parts = [];
  if (hasTradeSignals) parts.push(`${signals.length} signals`);
  if (hasMomentum) parts.push('momentum');
  if (hasImpulses) parts.push(`${impulses.length} impulses`);
  console.log(`[email-alert] sent to ${recipients.length} users (${parts.join(', ')})`);
}

module.exports = { sendSignalAlerts };
