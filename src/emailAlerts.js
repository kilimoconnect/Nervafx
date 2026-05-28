'use strict';

/**
 * Email Alerts — Energy-driven notification system
 *
 * Three alert types aligned with the energy signal structure:
 *
 *   1. DIRECTION ALERT  — New energy bar ≥50 confirmed new/changed directions
 *      Trigger: isNewEnergyEvent = true in calculateEnergyDirection()
 *      Content: strong/weak currencies, per-currency event type, signal pairs
 *      Cooldown: 4 hours
 *
 *   2. PHASE ALERT — A signal pair reached ENTRY phase (trade ready)
 *      Trigger: any energy_signal_pair moves to ENTRY phase
 *      Content: BUY/SELL with entry/SL/TP, DE score, currency context
 *      Cooldown: 2 hours per pair
 *
 *   3. DAILY DIGEST — End-of-day summary
 *      Trigger: after NY session closes (21:00 UTC)
 *      Content: day's energy events, phase progression, outcomes
 *      Cooldown: 24 hours
 *
 * Runs at the end of each pipeline cycle via sendSignalAlerts(sb).
 */

const { sendEmail, baseLayout } = require('./emailService');

const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York', LOW_LIQUIDITY: 'Off-hours' };

// Admin — permanent premium, never expires
const ADMIN_UIDS = new Set([
  '140f3854-2c85-488c-8e0a-0f965d562654', // Henry Muleke
]);

// ── Deduplication ────────────────────────────────────────────────────────────

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
    console.warn('[EMAIL] Could not log alert');
  }
}

// ── Subscribers ─────────────────────────────────────────────────────────────

async function getSubscribedUsers(sb) {
  const { data: allUsers, error: userErr } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (userErr) {
    console.error('[EMAIL] listUsers error:', userErr.message);
    return [];
  }
  if (!allUsers?.users?.length) return [];

  // Fetch subscriptions to filter by plan (pro/premium only)
  const { data: subs } = await sb
    .from('subscriptions')
    .select('user_id, plan, status, expires_at');

  const subMap = {};
  for (const s of (subs || [])) subMap[s.user_id] = s;

  // Fetch email preferences
  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, unsubscribed');

  const prefMap = {};
  for (const p of (prefs || [])) prefMap[p.user_id] = p;

  return allUsers.users.filter(u => {
    if (!u.email) return false;

    // Plan gate — only pro, premium, or admin
    if (ADMIN_UIDS.has(u.id)) {
      // Admin always gets alerts
    } else {
      const sub = subMap[u.id];
      if (!sub || sub.plan === 'free') return false;
      // Skip expired paid plans
      if (sub.expires_at && new Date(sub.expires_at) < new Date()) return false;
    }

    // Email preferences
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  });
}

async function sendToAll(sb, recipients, template, alertType, details) {
  let sent = 0;
  for (const u of recipients) {
    try {
      await sendEmail(u.email, template);
      sent++;
    } catch (e) {
      console.error(`[EMAIL] ${alertType} failed for ${u.email}:`, e.message);
    }
  }
  await logAlertSent(sb, alertType, details);
  console.log(`[EMAIL] ${alertType} sent to ${sent}/${recipients.length} users`);
  return sent;
}

// ── Email Templates ─────────────────────────────────────────────────────────

function directionAlertEmail(data) {
  const { triggerEnergy, triggerSession, triggerHour, currencies, pairs, removedPairs } = data;
  const sessionLabel = SESS_LABEL[triggerSession] || triggerSession || 'Unknown';
  const timeStr = triggerHour ? new Date(triggerHour).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';

  const strongCcys = currencies.filter(c => c.direction === 'STRONG');
  const weakCcys = currencies.filter(c => c.direction === 'WEAK');
  const droppedCcys = currencies.filter(c => c.eventType === 'DROPPED');

  const evtLabel = t => t === 'CONTINUATION' ? 'Continue' : t === 'REVERSAL' ? 'Reversal' : t === 'NEW' ? 'New' : t === 'DROPPED' ? 'Dropped' : t;
  const evtTagClass = t => t === 'CONTINUATION' ? 'tag-blue' : t === 'NEW' ? 'tag-green' : t === 'REVERSAL' ? 'tag-amber' : 'tag-gray';
  const borderClass = dir => dir === 'STRONG' ? 'row-green' : 'row-red';

  // Currency rows — table-based for email client compatibility
  const ccyRows = currencies
    .filter(c => c.eventType && c.direction !== 'NEUTRAL')
    .map(c => {
      const isStrong = c.direction === 'STRONG';
      const color = isStrong ? '#4ade80' : '#f87171';
      const arrow = isStrong ? 'Strong' : 'Weak';
      const h3 = (c.smooth_3h * 10000).toFixed(1);
      const h6 = (c.smooth_6h * 10000).toFixed(1);
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(30,41,59,0.6)"><tr>
        <td style="padding:10px 14px">
          <span class="val" style="color:${color}">${c.currency}</span>
          <span class="dim" style="margin-left:6px">${arrow}</span>
        </td>
        <td style="padding:10px 14px;text-align:right">
          <span class="${evtTagClass(c.eventType)} tag">${evtLabel(c.eventType)}</span>
          <div class="dim" style="margin-top:3px">3H ${h3} / 6H ${h6}</div>
        </td>
      </tr></table>`;
    }).join('');

  const droppedHtml = droppedCcys.length ? `
    <div style="padding:8px 14px" class="dim">
      Dropped: ${droppedCcys.map(c => `<span style="text-decoration:line-through">${c.currency}</span>`).join(', ')}
    </div>` : '';

  // Pair rows — table-based
  const pairRows = pairs.map(p => {
    const isBuy = p.dir === 'BUY';
    const dirColor = isBuy ? '#4ade80' : '#f87171';
    const dirArrow = isBuy ? 'BUY' : 'SELL';
    return `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(30,41,59,0.6)"><tr>
      <td style="padding:10px 14px">
        <span class="val">${p.instrument.replace('_', '/')}</span>
        <span style="color:${dirColor};font-weight:600;font-size:12px;margin-left:6px">${dirArrow}</span>
      </td>
      <td style="padding:10px 14px;text-align:right">
        <span class="${evtTagClass(p.eventType)} tag">${evtLabel(p.eventType)}</span>
        <div class="dim" style="margin-top:3px">${p.strong_ccy} / ${p.weak_ccy}</div>
      </td>
    </tr></table>`;
  }).join('');

  const removedHtml = removedPairs?.length ? `
    <div style="padding:8px 14px" class="dim">
      Removed: ${removedPairs.map(p => `<span style="text-decoration:line-through">${p.replace('_','/')}</span>`).join(', ')}
    </div>` : '';

  return {
    subject: `Direction Alert — ${strongCcys.map(c=>c.currency).join(',')} strong / ${weakCcys.map(c=>c.currency).join(',')} weak`,
    html: baseLayout(`
      <h2>Direction Alert</h2>
      <p class="sub">${sessionLabel} session &middot; Energy ${Math.round(triggerEnergy)}${timeStr ? ` &middot; ${timeStr}` : ''}</p>

      <div class="card">
        <div class="card-hd">Currencies</div>
        <div class="card-bd">${ccyRows}${droppedHtml}</div>
      </div>

      <div class="card">
        <div class="card-hd">Signal Pairs (${pairs.length})</div>
        <div class="card-bd">${pairRows}${removedHtml}</div>
      </div>

      <div class="section">
        <p class="sm">Phase cycle: Monitoring &rarr; Pullback &rarr; Compression &rarr; Ready &rarr; Entry. You will be notified when a pair reaches Entry.</p>
      </div>

      <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com">Open Dashboard</a></p>
      <p class="sm" style="text-align:center">Analytical observations only — not trade recommendations.</p>
    `),
  };
}

function phaseAlertEmail(data) {
  const { pair, signal } = data;
  const isBuy = signal.signal === 'BUY';
  const dirColor = isBuy ? '#4ade80' : '#f87171';
  const dirBg = isBuy ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
  const dirBorder = isBuy ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)';
  const pairLabel = pair.instrument.replace('_', '/');

  return {
    subject: `Entry Signal — ${signal.signal} ${pairLabel}`,
    html: baseLayout(`
      <h2>Entry Signal</h2>
      <p class="sub">${pairLabel} reached the Entry phase — all gates passed</p>

      <div style="background:${dirBg};border:1px solid ${dirBorder};border-radius:8px;padding:20px;margin:16px 0;text-align:center">
        <div style="font-size:24px;color:${dirColor};font-weight:800;letter-spacing:-0.3px">${signal.signal} ${pairLabel}</div>
        <div class="dim" style="margin-top:6px">${pair.strong_ccy} strong / ${pair.weak_ccy} weak</div>
      </div>

      <div class="card">
        <div class="card-hd">Trade Levels</div>
        <div class="card-bd">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
              <td style="padding:10px 14px" class="sm">Entry</td>
              <td style="padding:10px 14px;text-align:right" class="val">${Number(signal.entry_price).toFixed(5)}</td>
            </tr>
            <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
              <td style="padding:10px 14px" class="sm">Stop Loss</td>
              <td style="padding:10px 14px;text-align:right;color:#f87171;font-weight:700;font-size:14px">${Number(signal.stop_loss).toFixed(5)}</td>
            </tr>
            <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
              <td style="padding:10px 14px" class="sm">Take Profit</td>
              <td style="padding:10px 14px;text-align:right;color:#4ade80;font-weight:700;font-size:14px">${Number(signal.take_profit).toFixed(5)}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;border-top:1px solid #1e293b" class="sm">Risk : Reward</td>
              <td style="padding:10px 14px;border-top:1px solid #1e293b;text-align:right;color:#fbbf24;font-weight:700;font-size:14px">1:${signal.risk_reward}</td>
            </tr>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-hd">Confirmation</div>
        <div class="card-bd">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
              <td style="padding:10px 14px" class="sm">DE Combined</td>
              <td style="padding:10px 14px;text-align:right" class="val">${pair.de_combined || '--'}</td>
            </tr>
            <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
              <td style="padding:10px 14px" class="sm">Impulse</td>
              <td style="padding:10px 14px;text-align:right" class="val">${pair.impulse_score || '--'}${pair.impulse_aligned ? ' <span class="tag tag-green">Aligned</span>' : ''}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px" class="sm">Energy Level</td>
              <td style="padding:10px 14px;text-align:right;color:#fbbf24;font-weight:700;font-size:14px">${pair.energy_level || '--'}</td>
            </tr>
          </table>
        </div>
      </div>

      <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com">View Analysis</a></p>
      <p class="sm" style="text-align:center">System-generated signal — not financial advice.</p>
    `),
  };
}

function dailyDigestEmail(data) {
  const { date, energyEvents, pairs, entryPairs, sessions } = data;

  const eventRows = (energyEvents || []).map(ev => `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(30,41,59,0.6)"><tr>
      <td style="padding:10px 14px">
        <span class="val" style="color:#fbbf24">${Math.round(ev.energy)}</span>
        <span class="dim" style="margin-left:6px">${SESS_LABEL[ev.session] || ev.session}</span>
      </td>
      <td style="padding:10px 14px;text-align:right" class="sm">${ev.time ? new Date(ev.time).toISOString().slice(11, 16) : '?'} UTC</td>
    </tr></table>`
  ).join('');

  const pairRows = (pairs || []).slice(0, 6).map(p => {
    const isBuy = p.dir === 'BUY';
    const color = isBuy ? '#4ade80' : '#f87171';
    return `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(30,41,59,0.6)"><tr>
      <td style="padding:10px 14px">
        <span class="val" style="font-size:13px">${p.instrument.replace('_','/')}</span>
        <span style="color:${color};font-weight:600;font-size:12px;margin-left:6px">${p.dir}</span>
      </td>
      <td style="padding:10px 14px;text-align:right">
        <span class="tag tag-gray">${p.phase}</span>
        <span class="dim" style="margin-left:6px">DE ${Math.round(p.de_combined || 0)}</span>
      </td>
    </tr></table>`;
  }).join('');

  const entryHtml = entryPairs?.length ? `
    <div class="card" style="border-color:rgba(34,197,94,0.3)">
      <div class="card-hd" style="color:#4ade80">Entry Signals</div>
      <div class="card-bd">
        ${entryPairs.map(p => `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(30,41,59,0.6)"><tr><td style="padding:10px 14px" class="val">${p.instrument.replace('_','/')}</td><td style="padding:10px 14px;text-align:right"><span class="tag tag-green">${p.signal || p.dir}</span></td></tr></table>`).join('')}
      </div>
    </div>` : '';

  const sessionMetrics = (sessions || []).map(s => {
    const energy = Math.round(parseFloat(s.market_energy) || 0);
    return `<span class="metric">${SESS_LABEL[s.session_name] || s.session_name}: <b>${energy}</b></span>`;
  }).join(' ');

  return {
    subject: `Daily Digest — ${date}`,
    html: baseLayout(`
      <h2>Daily Digest</h2>
      <p class="sub">${date}</p>

      ${sessionMetrics ? `
      <div class="card">
        <div class="card-hd">Session Energy</div>
        <div style="padding:12px 14px">${sessionMetrics}</div>
      </div>` : ''}

      ${eventRows ? `
      <div class="card">
        <div class="card-hd">Energy Events</div>
        <div class="card-bd">${eventRows}</div>
      </div>` : ''}

      ${entryHtml}

      ${pairRows ? `
      <div class="card">
        <div class="card-hd">Signal Pairs</div>
        <div class="card-bd">${pairRows}</div>
      </div>` : ''}

      <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com">Open Dashboard</a></p>
    `),
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

async function sendSignalAlerts(sb) {
  if (!process.env.BREVO_API_KEY) {
    console.log('[EMAIL] BREVO_API_KEY not set — skipping');
    return;
  }

  console.log('[EMAIL] Checking alert conditions...');

  // Get subscribers
  let recipients;
  try {
    recipients = await getSubscribedUsers(sb);
  } catch (e) {
    console.error('[EMAIL] Failed to get subscribers:', e.message);
    return;
  }
  if (!recipients.length) {
    console.log('[EMAIL] No subscribed users — skipping');
    return;
  }
  console.log(`[EMAIL] ${recipients.length} subscribed users`);

  const emailsSent = [];

  // ── 1. DIRECTION ALERT — check if energyDirection flagged a new event ─────
  // Read from energy_currency_state: if any currency has energy_event_type set
  // and was triggered recently (within last 2 hours), it's a new event
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: currStates } = await sb
    .from('energy_currency_state')
    .select('*')
    .order('currency', { ascending: true });

  const hasRecentTrigger = (currStates || []).some(s =>
    s.energy_event_type && s.triggered_at && s.triggered_at > twoHoursAgo
  );

  if (hasRecentTrigger) {
    const alreadySent = await wasRecentlySent(sb, 'direction', 240);
    if (!alreadySent) {
      // Fetch active pairs for the email
      const { data: activePairs } = await sb
        .from('energy_signal_pairs')
        .select('instrument, dir, strong_ccy, weak_ccy, phase, new_energy_event, energy_event_type')
        .eq('active', true);

      // Fetch recently deactivated pairs (removed in this event)
      const { data: inactivePairs } = await sb
        .from('energy_signal_pairs')
        .select('instrument')
        .eq('active', false)
        .gte('last_updated', twoHoursAgo);

      const triggerState = (currStates || []).find(s => s.energy_at_trigger);
      const template = directionAlertEmail({
        triggerEnergy: triggerState?.energy_at_trigger || 0,
        triggerSession: triggerState?.trigger_session || '',
        triggerHour: triggerState?.triggered_at || '',
        currencies: (currStates || []).map(c => ({
          currency: c.currency,
          direction: c.direction,
          eventType: c.energy_event_type,
          smooth_3h: parseFloat(c.smooth_3h) || 0,
          smooth_6h: parseFloat(c.smooth_6h) || 0,
        })),
        pairs: (activePairs || []).map(p => ({
          instrument: p.instrument,
          dir: p.dir,
          strong_ccy: p.strong_ccy,
          weak_ccy: p.weak_ccy,
          eventType: p.energy_event_type || 'NEW',
        })),
        removedPairs: (inactivePairs || []).map(p => p.instrument),
      });

      await sendToAll(sb, recipients, template, 'direction', {
        energy: triggerState?.energy_at_trigger,
        strong: (currStates || []).filter(c => c.direction === 'STRONG').map(c => c.currency),
        weak: (currStates || []).filter(c => c.direction === 'WEAK').map(c => c.currency),
        pairs: (activePairs || []).length,
      });
      emailsSent.push('direction');
    } else {
      console.log('[EMAIL] Direction alert already sent within 4h — skipping');
    }
  }

  // ── 2. PHASE ALERT — any pair in ENTRY phase with BUY/SELL signal ─────────
  const { data: entryPairs } = await sb
    .from('energy_signal_pairs')
    .select('*')
    .eq('active', true)
    .eq('phase', 'ENTRY');

  if (entryPairs?.length) {
    // Check for entry signals in trade_signals
    const { data: entrySignals } = await sb
      .from('trade_signals')
      .select('*')
      .in('signal', ['BUY', 'SELL'])
      .in('instrument', entryPairs.map(p => p.instrument))
      .order('time', { ascending: false })
      .limit(entryPairs.length);

    if (entrySignals?.length) {
      // Deduplicate: one alert per pair per cooldown
      for (const sig of entrySignals) {
        const alertKey = `phase_entry_${sig.instrument}`;
        const alreadySent = await wasRecentlySent(sb, alertKey, 120);
        if (alreadySent) {
          console.log(`[EMAIL] Phase alert for ${sig.instrument} already sent within 2h — skipping`);
          continue;
        }

        const pair = entryPairs.find(p => p.instrument === sig.instrument);
        if (!pair) continue;

        const template = phaseAlertEmail({ pair, signal: sig });
        await sendToAll(sb, recipients, template, alertKey, {
          instrument: sig.instrument,
          signal: sig.signal,
          entry: sig.entry_price,
        });
        emailsSent.push(`entry:${sig.instrument}`);
      }
    }
  }

  // ── 3. DAILY DIGEST — after NY session closes (21:00-23:59 UTC) ───────────
  const now = new Date();
  const utcHour = now.getUTCHours();
  if (utcHour >= 21 && utcHour <= 23) {
    const alreadySent = await wasRecentlySent(sb, 'daily_digest', 1440);
    if (!alreadySent) {
      const todayStr = now.toISOString().slice(0, 10);

      // Get today's sessions
      const { data: sessions } = await sb
        .from('market_energy_sessions')
        .select('session_name, market_energy, details')
        .eq('session_date', todayStr);

      // Collect energy events (bars that crossed threshold)
      const energyEvents = [];
      for (const s of (sessions || [])) {
        for (const h of (s.details?.hourly || [])) {
          if ((parseFloat(h.market_energy) || 0) >= 50) {
            energyEvents.push({ energy: h.market_energy, time: h.time, session: s.session_name });
          }
        }
      }

      // Get active pairs
      const { data: allPairs } = await sb
        .from('energy_signal_pairs')
        .select('instrument, dir, phase, de_combined')
        .eq('active', true)
        .order('de_combined', { ascending: false });

      // Get any entry signals from today
      const { data: todayEntries } = await sb
        .from('trade_signals')
        .select('instrument, signal')
        .in('signal', ['BUY', 'SELL'])
        .gte('time', todayStr)
        .order('time', { ascending: false });

      const template = dailyDigestEmail({
        date: todayStr,
        energyEvents,
        pairs: allPairs || [],
        entryPairs: todayEntries || [],
        sessions: sessions || [],
      });

      await sendToAll(sb, recipients, template, 'daily_digest', { date: todayStr });
      emailsSent.push('digest');
    } else {
      console.log('[EMAIL] Daily digest already sent today — skipping');
    }
  }

  if (emailsSent.length) {
    console.log(`[EMAIL] Done — sent: ${emailsSent.join(', ')}`);
  } else {
    console.log('[EMAIL] Done — no alerts triggered');
  }
}

module.exports = { sendSignalAlerts };
