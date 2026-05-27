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

  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, unsubscribed');

  const prefMap = {};
  for (const p of (prefs || [])) prefMap[p.user_id] = p;

  return allUsers.users.filter(u => {
    if (!u.email) return false;
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

  // Short event labels for mobile
  const evtLabel = t => t === 'CONTINUATION' ? 'Continue' : t === 'REVERSAL' ? 'Reversal' : t === 'NEW' ? 'New' : t === 'DROPPED' ? 'Dropped' : t;
  const evtColor = t => t === 'CONTINUATION' ? '#0ea5e9' : t === 'NEW' ? '#22c55e' : t === 'REVERSAL' ? '#f59e0b' : '#64748b';

  // Currency chips — stacked rows, mobile-friendly
  const ccyChips = currencies
    .filter(c => c.eventType && c.direction !== 'NEUTRAL')
    .map(c => {
      const isStrong = c.direction === 'STRONG';
      const color = isStrong ? '#22c55e' : '#ef4444';
      const arrow = isStrong ? '▲' : '▼';
      const ec = evtColor(c.eventType);
      const h3 = (c.smooth_3h * 10000).toFixed(1);
      const h6 = (c.smooth_6h * 10000).toFixed(1);
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #1e293b">
        <div>
          <span style="color:${color};font-weight:700;font-size:16px">${arrow} ${c.currency}</span>
          <span style="color:${color};font-size:13px;margin-left:6px">${c.direction}</span>
        </div>
        <div style="text-align:right">
          <span style="color:${ec};font-weight:600;font-size:12px;background:${ec}15;padding:2px 8px;border-radius:4px">${evtLabel(c.eventType)}</span>
          <div style="color:#64748b;font-size:11px;margin-top:3px">${h3} / ${h6}</div>
        </div>
      </div>`;
    }).join('');

  const droppedHtml = droppedCcys.length ? `
    <div style="padding:8px 12px;color:#64748b;font-size:12px">
      Dropped: ${droppedCcys.map(c => `<span style="text-decoration:line-through">${c.currency}</span>`).join(', ')} — now neutral
    </div>` : '';

  // Pair rows — 3-column max, short labels
  const pairChips = pairs.map(p => {
    const isBuy = p.dir === 'BUY';
    const dirColor = isBuy ? '#22c55e' : '#ef4444';
    const dirArrow = isBuy ? '▲' : '▼';
    const ec = evtColor(p.eventType);
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #1e293b">
      <div>
        <span style="color:#fff;font-weight:600;font-size:14px">${p.instrument.replace('_', '/')}</span>
        <span style="color:${dirColor};font-weight:600;font-size:13px;margin-left:6px">${dirArrow} ${p.dir}</span>
      </div>
      <div style="text-align:right">
        <span style="color:${ec};font-weight:600;font-size:12px">${evtLabel(p.eventType)}</span>
        <div style="color:#64748b;font-size:11px;margin-top:2px">${p.strong_ccy}↑ ${p.weak_ccy}↓</div>
      </div>
    </div>`;
  }).join('');

  const removedHtml = removedPairs?.length ? `
    <div style="padding:8px 12px;color:#64748b;font-size:12px">
      Removed: ${removedPairs.map(p => `<span style="text-decoration:line-through">${p.replace('_','/')}</span>`).join(', ')}
    </div>` : '';

  return {
    subject: `Energy Direction — ${strongCcys.map(c=>c.currency).join(',')} strong, ${weakCcys.map(c=>c.currency).join(',')} weak — NervaFX`,
    html: baseLayout(`
      <h2>Energy Direction Confirmed</h2>
      <p>Energy bar <strong style="color:#f59e0b">${Math.round(triggerEnergy)}</strong> crossed threshold during <strong>${sessionLabel}</strong>${timeStr ? ` at ${timeStr}` : ''}. Directions locked.</p>

      <div class="card">
        <div class="card-title">Currency Directions</div>
        ${ccyChips}
        ${droppedHtml}
      </div>

      <div class="card">
        <div class="card-title">Signal Pairs (${pairs.length})</div>
        ${pairChips}
        ${removedHtml}
      </div>

      <p style="font-size:13px;color:#94a3b8">Monitoring phase cycle: MONITORING → PULLBACK → COMPRESSION → READY → ENTRY. You'll be notified when a pair reaches ENTRY.</p>
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">View Dashboard</a></p>
      <p style="color:#94a3b8;font-size:12px">Energy directions are analytical observations, not trade recommendations.</p>
    `),
  };
}

function phaseAlertEmail(data) {
  const { pair, signal } = data;
  const isBuy = signal.signal === 'BUY';
  const dirColor = isBuy ? '#22c55e' : '#ef4444';
  const dirArrow = isBuy ? '▲' : '▼';
  const pairLabel = pair.instrument.replace('_', '/');

  return {
    subject: `${signal.signal} ${pairLabel} — Entry Signal — NervaFX`,
    html: baseLayout(`
      <h2>Entry Signal Confirmed</h2>
      <p><strong>${pairLabel}</strong> has reached the <strong>ENTRY</strong> phase with all gates passed.</p>

      <div style="background:#1e293b;border:2px solid ${dirColor};border-radius:12px;padding:20px;margin:16px 0;text-align:center">
        <div style="font-size:28px;color:${dirColor};font-weight:800;margin:0 0 8px">${dirArrow} ${signal.signal} ${pairLabel}</div>
        <div style="color:#94a3b8;font-size:14px">${pair.strong_ccy} ↑ Strong · ${pair.weak_ccy} ↓ Weak</div>
      </div>

      <div class="card">
        <div class="card-title">Trade Levels</div>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:8px 0;color:#94a3b8;font-size:13px">Entry</td>
            <td style="padding:8px 0;color:#fff;font-weight:600;text-align:right">${Number(signal.entry_price).toFixed(5)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#94a3b8;font-size:13px">Stop Loss</td>
            <td style="padding:8px 0;color:#ef4444;font-weight:600;text-align:right">${Number(signal.stop_loss).toFixed(5)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#94a3b8;font-size:13px">Take Profit</td>
            <td style="padding:8px 0;color:#22c55e;font-weight:600;text-align:right">${Number(signal.take_profit).toFixed(5)}</td>
          </tr>
          <tr style="border-top:1px solid #334155">
            <td style="padding:8px 0;color:#94a3b8;font-size:13px">Risk:Reward</td>
            <td style="padding:8px 0;color:#f59e0b;font-weight:600;text-align:right">1:${signal.risk_reward}</td>
          </tr>
        </table>
      </div>

      <div class="card">
        <div class="card-title">Confirmation Scores</div>
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:6px 0;color:#94a3b8;font-size:13px">DE Combined</td>
            <td style="padding:6px 0;color:#fff;text-align:right">${pair.de_combined || '—'}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#94a3b8;font-size:13px">Impulse</td>
            <td style="padding:6px 0;color:#fff;text-align:right">${pair.impulse_score || '—'} ${pair.impulse_aligned ? '✓ Aligned' : ''}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#94a3b8;font-size:13px">Energy Level</td>
            <td style="padding:6px 0;color:#f59e0b;text-align:right">${pair.energy_level || '—'}</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#94a3b8;font-size:13px">Phase Path</td>
            <td style="padding:6px 0;color:#94a3b8;text-align:right;font-size:12px">MONITORING → PULLBACK → COMPRESSION → READY → <strong style="color:#22c55e">ENTRY</strong></td>
          </tr>
        </table>
      </div>

      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">View Full Analysis →</a></p>
      <p style="color:#94a3b8;font-size:13px">This is a system-generated signal, not financial advice. Always apply your own risk management.</p>
    `),
  };
}

function dailyDigestEmail(data) {
  const { date, energyEvents, pairs, entryPairs, sessions } = data;

  const eventRows = (energyEvents || []).map(ev => `
    <div style="background:#0f172a;border-radius:6px;padding:10px 14px;margin:6px 0">
      <span style="color:#f59e0b;font-weight:600">${Math.round(ev.energy)}</span>
      <span style="color:#94a3b8"> @ ${ev.time ? new Date(ev.time).toISOString().slice(11, 16) : '?'} UTC</span>
      <span style="color:#64748b"> (${SESS_LABEL[ev.session] || ev.session})</span>
    </div>`
  ).join('');

  const pairSummary = (pairs || []).slice(0, 6).map(p => {
    const isBuy = p.dir === 'BUY';
    const color = isBuy ? '#22c55e' : '#ef4444';
    return `<tr>
      <td style="padding:6px 8px;color:#fff">${p.instrument.replace('_','/')}</td>
      <td style="padding:6px 8px;color:${color};font-weight:600">${p.dir}</td>
      <td style="padding:6px 8px;color:#94a3b8">${p.phase}</td>
      <td style="padding:6px 8px;color:#94a3b8">${Math.round(p.de_combined || 0)}</td>
    </tr>`;
  }).join('');

  const entryHtml = entryPairs?.length ? `
    <div class="card" style="border-color:rgba(34,197,94,0.4)">
      <div class="card-title" style="color:#22c55e">🎯 Entry Signals Fired</div>
      <p style="margin:0;color:#cbd5e1">${entryPairs.map(p => `<strong>${p.instrument.replace('_','/')}</strong> ${p.dir}`).join(', ')}</p>
    </div>` : '';

  const sessionCards = (sessions || []).map(s => {
    const energy = Math.round(parseFloat(s.market_energy) || 0);
    return `<span class="metric">${SESS_LABEL[s.session_name] || s.session_name}: <strong>${energy}</strong></span>`;
  }).join(' ');

  return {
    subject: `Daily Digest — ${date} — NervaFX`,
    html: baseLayout(`
      <h2>Daily Market Digest</h2>
      <p>Summary for <strong>${date}</strong></p>

      ${sessionCards ? `<div class="card"><div class="card-title">Session Energy</div><p style="margin:0">${sessionCards}</p></div>` : ''}

      ${eventRows ? `
      <div class="card">
        <div class="card-title">Energy Events</div>
        ${eventRows || '<p style="color:#94a3b8">No bars crossed threshold today.</p>'}
      </div>` : ''}

      ${entryHtml}

      ${pairSummary ? `
      <div class="card">
        <div class="card-title">Signal Pairs</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid #334155;color:#64748b;font-size:12px">
            <th style="padding:6px 8px;text-align:left">Pair</th>
            <th style="padding:6px 8px;text-align:left">Dir</th>
            <th style="padding:6px 8px;text-align:left">Phase</th>
            <th style="padding:6px 8px;text-align:left">DE</th>
          </tr></thead>
          <tbody>${pairSummary}</tbody>
        </table>
      </div>` : ''}

      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">Open Dashboard →</a></p>
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
