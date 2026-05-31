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

async function wasAlreadySent(sb, alertKey) {
  try {
    const { data } = await sb
      .from('email_alert_log')
      .select('id')
      .eq('alert_type', alertKey)
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

  // Fetch email preferences (including notification_email override)
  const { data: prefs } = await sb
    .from('email_preferences')
    .select('user_id, signal_alerts, unsubscribed, notification_email');

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

    // Use notification_email if set, otherwise registered email
    u._sendTo = p?.notification_email || u.email;
    return true;
  });
}

async function sendToAll(sb, recipients, template, alertType, details) {
  let sent = 0;
  for (const u of recipients) {
    try {
      await sendEmail(u._sendTo || u.email, template);
      sent++;
    } catch (e) {
      console.error(`[EMAIL] ${alertType} failed for ${u._sendTo || u.email}:`, e.message);
    }
  }
  await logAlertSent(sb, alertType, details);
  console.log(`[EMAIL] ${alertType} sent to ${sent}/${recipients.length} users`);
  return sent;
}

// ── Email Templates ─────────────────────────────────────────────────────────

function directionAlertEmail(data) {
  const { marketFocusHtml, triggerEnergy, triggerSession, triggerHour, currencies, pairs, removedPairs } = data;
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

      ${marketFocusHtml || ''}

      <div class="card">
        <div class="card-hd">Currencies</div>
        <div class="card-bd">${ccyRows}${droppedHtml}</div>
      </div>

      <div class="card">
        <div class="card-hd">Signal Pairs (${pairs.length})</div>
        <div class="card-bd">${pairRows}${removedHtml}</div>
      </div>

      <div class="section">
        <p class="sm">Phase cycle: Monitoring &rarr; Pullback &rarr; Compression &rarr; Entry &rarr; Moving. You will be notified when a pair reaches Entry.</p>
      </div>

      <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com">Open Dashboard</a></p>
      <p class="sm" style="text-align:center">Analytical observations only — not trade recommendations.</p>
    `),
  };
}

function dailyDigestEmail(data) {
  const { marketFocusHtml, date, energyEvents, pairs, currencies, sessions } = data;

  // ── Currency Directions ──
  const strong = (currencies || []).filter(c => c.direction === 'STRONG');
  const weak   = (currencies || []).filter(c => c.direction === 'WEAK');

  const ccyRow = (c, cls) => {
    const h3 = (parseFloat(c.smooth_3h) || 0) * 10000;
    const h6 = (parseFloat(c.smooth_6h) || 0) * 10000;
    const evTag = c.energy_event_type
      ? `<span class="tag tag-${c.energy_event_type === 'CONTINUATION' ? 'blue' : c.energy_event_type === 'NEW' ? 'green' : 'amber'}">${c.energy_event_type}</span>`
      : '';
    return `<tr>
      <td style="padding:8px 14px"><span class="val">${c.currency}</span></td>
      <td style="padding:8px 14px;text-align:right">
        <span class="dim">${h3.toFixed(1)}</span>
        <span class="dim" style="margin-left:8px">${h6.toFixed(1)}</span>
        ${evTag}
      </td>
    </tr>`;
  };

  const directionsHtml = (strong.length || weak.length) ? `
    <div class="card">
      <div class="card-hd">Currency Directions</div>
      <div class="card-bd">
        ${strong.length ? `<table width="100%" cellpadding="0" cellspacing="0">
          <tr><td colspan="2" style="padding:10px 14px;color:#4ade80;font-weight:700;font-size:11px;text-transform:uppercase">Strong</td></tr>
          ${strong.map(c => ccyRow(c, 'strong')).join('')}
        </table>` : ''}
        ${weak.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="${strong.length ? 'border-top:1px solid rgba(30,41,59,0.6)' : ''}">
          <tr><td colspan="2" style="padding:10px 14px;color:#f87171;font-weight:700;font-size:11px;text-transform:uppercase">Weak</td></tr>
          ${weak.map(c => ccyRow(c, 'weak')).join('')}
        </table>` : ''}
      </div>
    </div>` : '';

  // ── Session Summary ──
  const sessionRows = (sessions || []).map(s => {
    const energy = Math.round(parseFloat(s.market_energy) || 0);
    const trad   = s.tradability_grade || '';
    const liq    = s.liquidity_grade || '';
    const state  = s.energy_cycle || '';
    return `<tr>
      <td style="padding:8px 14px"><span class="val">${SESS_LABEL[s.session_name] || s.session_name}</span></td>
      <td style="padding:8px 14px;text-align:center"><span style="color:#fbbf24;font-weight:700">${energy}</span></td>
      <td style="padding:8px 14px;text-align:center" class="dim">${trad}</td>
      <td style="padding:8px 14px;text-align:right"><span class="tag tag-gray">${state}</span></td>
    </tr>`;
  }).join('');

  const sessionsHtml = sessionRows ? `
    <div class="card">
      <div class="card-hd">Session Summary</div>
      <div class="card-bd">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 14px" class="sm dim">Session</td>
            <td style="padding:6px 14px;text-align:center" class="sm dim">Energy</td>
            <td style="padding:6px 14px;text-align:center" class="sm dim">Tradability</td>
            <td style="padding:6px 14px;text-align:right" class="sm dim">State</td>
          </tr>
          ${sessionRows}
        </table>
      </div>
    </div>` : '';

  // ── Energy Events (bars that crossed 50) ──
  const eventRows = (energyEvents || []).map(ev => `
    <tr>
      <td style="padding:8px 14px">
        <span class="val" style="color:#fbbf24">${Math.round(ev.energy)}</span>
        <span class="dim" style="margin-left:6px">${SESS_LABEL[ev.session] || ev.session}</span>
      </td>
      <td style="padding:8px 14px;text-align:right" class="sm">${ev.time ? new Date(ev.time).toISOString().slice(11, 16) : '?'} UTC</td>
    </tr>`
  ).join('');

  const eventsHtml = eventRows ? `
    <div class="card">
      <div class="card-hd">Energy Crosses</div>
      <div class="card-bd"><table width="100%" cellpadding="0" cellspacing="0">${eventRows}</table></div>
    </div>` : '';

  // ── Signal Pairs (top 8 by phase priority) ──
  const PHASE_ORDER = { ENTRY: 0, MOVING: 1, COMPRESSION: 2, PULLBACK: 3, MONITORING: 4 };
  const PHASE_COLOR = { ENTRY: '#22c55e', MOVING: '#fbbf24', COMPRESSION: '#a78bfa', PULLBACK: '#f59e0b', MONITORING: '#64748b' };
  const sorted = (pairs || []).sort((a, b) => (PHASE_ORDER[a.phase] ?? 9) - (PHASE_ORDER[b.phase] ?? 9));

  const pairRows = sorted.slice(0, 8).map(p => {
    const color = p.dir === 'BUY' ? '#4ade80' : '#f87171';
    const phColor = PHASE_COLOR[p.phase] || '#64748b';
    return `<tr>
      <td style="padding:8px 14px">
        <span class="val" style="font-size:13px">${p.instrument.replace('_','/')}</span>
        <span style="color:${color};font-weight:600;font-size:12px;margin-left:6px">${p.dir}</span>
      </td>
      <td style="padding:8px 14px;text-align:right">
        <span style="color:${phColor};font-weight:600;font-size:11px">${p.phase}</span>
        <span class="dim" style="margin-left:6px">DE ${Math.round(p.de_combined || 0)}%</span>
      </td>
    </tr>`;
  }).join('');

  const pairsHtml = pairRows ? `
    <div class="card">
      <div class="card-hd">Signal Pairs</div>
      <div class="card-bd"><table width="100%" cellpadding="0" cellspacing="0">${pairRows}</table></div>
    </div>` : '';

  // ── Phase Flow Summary ──
  const phases = {};
  for (const p of (pairs || [])) phases[p.phase] = (phases[p.phase] || 0) + 1;
  const phaseText = Object.entries(phases)
    .sort((a, b) => (PHASE_ORDER[a[0]] ?? 9) - (PHASE_ORDER[b[0]] ?? 9))
    .map(([ph, n]) => `${ph}(${n})`).join(' · ');

  return {
    subject: `NervaFX Daily Digest — ${date}`,
    html: baseLayout(`
      <h2>Daily Digest</h2>
      <p class="sub">${date}${phaseText ? ` · ${phaseText}` : ''}</p>

      ${marketFocusHtml || ''}
      ${directionsHtml}
      ${sessionsHtml}
      ${eventsHtml}
      ${pairsHtml}

      <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com/app">Open Dashboard</a></p>
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

  // ── M15 dominant currency — shared by all email types ─────────────────────
  // Derive per-currency M15 strength from m15_pair_spreads (smooth_45m)
  let m15CcyStrength = {};
  let dominantCcy = null, dominantVal = 0;
  try {
    const { data: m15Spreads } = await sb
      .from('m15_pair_spreads')
      .select('instrument, smooth_45m')
      .order('time', { ascending: false })
      .limit(28);

    if (m15Spreads?.length) {
      const sums = {}, counts = {};
      for (const s of m15Spreads) {
        const v = parseFloat(s.smooth_45m) || 0;
        const [base, quote] = s.instrument.split('_');
        sums[base]   = (sums[base]   || 0) + v;
        counts[base] = (counts[base] || 0) + 1;
        sums[quote]   = (sums[quote]   || 0) - v;
        counts[quote] = (counts[quote] || 0) + 1;
      }
      for (const ccy of Object.keys(sums)) {
        m15CcyStrength[ccy] = counts[ccy] > 0 ? sums[ccy] / counts[ccy] : 0;
      }
      // Find the single currency with highest absolute M15 strength
      for (const [ccy, val] of Object.entries(m15CcyStrength)) {
        if (Math.abs(val) > Math.abs(dominantVal)) { dominantCcy = ccy; dominantVal = val; }
      }
    }
  } catch (e) {
    console.warn('[EMAIL] M15 currency strength fetch failed:', e.message);
  }

  const dominantPips = dominantCcy ? (Math.abs(dominantVal) * 10000).toFixed(1) : '0';
  const dominantDir  = dominantVal > 0 ? 'strong' : 'weak';
  const dominantColor = dominantVal > 0 ? '#4ade80' : '#f87171';

  // Reusable HTML block for Market Focus card
  const marketFocusHtml = dominantCcy ? `
    <div class="card">
      <div class="card-hd">Market Focus</div>
      <div class="card-bd">
        <div style="padding:14px;text-align:center">
          <div style="font-size:20px;font-weight:800;color:${dominantColor};letter-spacing:-0.3px">${dominantCcy}</div>
          <div style="font-size:13px;font-weight:600;color:#e2e8f0;margin-top:4px">${dominantCcy} is ${dominantDir} (${dominantPips} pips) — focus on ${dominantCcy} pairs</div>
        </div>
      </div>
    </div>` : '';

  // ── 1. DIRECTION ALERT — check if energyDirection flagged a new event ─────
  // Check signal pairs for new_energy_event = true (set by the engine in the
  // current pipeline run). This is reliable because the flag is written at
  // pipeline time, not at the bar time which can be hours earlier.
  const { data: currStates } = await sb
    .from('energy_currency_state')
    .select('*')
    .order('currency', { ascending: true });

  // Direction alert triggers when active directions exist.
  // Dedup by triggered_at hour — one email per energy event.
  const hasActiveDirections = (currStates || []).some(s => s.active && s.direction !== 'NEUTRAL');
  const triggerTs = (currStates || []).find(s => s.triggered_at)?.triggered_at || '';
  const directionKey = `direction_${(triggerTs || '').slice(0, 13)}`; // YYYY-MM-DDTHH

  if (hasActiveDirections && triggerTs) {
    const dirAlreadySent = await wasAlreadySent(sb, directionKey);
    if (!dirAlreadySent) {
      // Fetch active pairs for the email
      const { data: activePairs } = await sb
        .from('energy_signal_pairs')
        .select('instrument, dir, strong_ccy, weak_ccy, phase, new_energy_event, energy_event_type')
        .eq('active', true);

      // Fetch recently deactivated pairs (removed in this event — updated within last 2h)
      const recentCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data: inactivePairs } = await sb
        .from('energy_signal_pairs')
        .select('instrument')
        .eq('active', false)
        .gte('last_updated', recentCutoff);

      const triggerState = (currStates || []).find(s => s.energy_at_trigger);
      const template = directionAlertEmail({
        marketFocusHtml,
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

      await sendToAll(sb, recipients, template, directionKey, {
        energy: triggerState?.energy_at_trigger,
        strong: (currStates || []).filter(c => c.direction === 'STRONG').map(c => c.currency),
        weak: (currStates || []).filter(c => c.direction === 'WEAK').map(c => c.currency),
        pairs: (activePairs || []).length,
      });
      emailsSent.push('direction');
    } else {
      console.log(`[EMAIL] Direction alert already sent for this event (${directionKey}) — skipping`);
    }
  }

  // ── 2. DAILY DIGEST — after NY session closes (21:00-23:59 UTC) ───────────
  const now = new Date();
  const utcHour = now.getUTCHours();
  if (utcHour >= 21 && utcHour <= 23) {
    const digestKey = `daily_digest_${now.toISOString().slice(0, 10)}`;
    if (await wasAlreadySent(sb, digestKey)) {
      console.log('[EMAIL] Daily digest already sent today — skipping');
    } else {
      const todayStr = now.toISOString().slice(0, 10);

      // Get today's sessions with summary data
      const { data: sessions } = await sb
        .from('market_energy_sessions')
        .select('session_name, market_energy, details, energy_cycle, tradability_grade, liquidity_grade')
        .eq('session_date', todayStr)
        .order('session_name');

      // Collect energy events (bars that crossed threshold)
      const energyEvents = [];
      for (const s of (sessions || [])) {
        for (const h of (s.details?.hourly || [])) {
          if ((parseFloat(h.market_energy) || 0) >= 50) {
            energyEvents.push({ energy: h.market_energy, time: h.time, session: s.session_name });
          }
        }
      }

      // Get currency directions
      const { data: digestCurrencies } = await sb
        .from('energy_currency_state')
        .select('currency, direction, smooth_3h, smooth_6h, energy_event_type, active')
        .eq('active', true)
        .order('currency');

      // Get active signal pairs
      const { data: allPairs } = await sb
        .from('energy_signal_pairs')
        .select('instrument, dir, phase, de_combined')
        .eq('active', true);

      const template = dailyDigestEmail({
        marketFocusHtml,
        date: todayStr,
        energyEvents,
        currencies: digestCurrencies || [],
        pairs: allPairs || [],
        sessions: sessions || [],
      });

      await sendToAll(sb, recipients, template, digestKey, { date: todayStr });
      emailsSent.push('digest');
    }
  }

  if (emailsSent.length) {
    console.log(`[EMAIL] Done — sent: ${emailsSent.join(', ')}`);
  } else {
    console.log('[EMAIL] Done — no alerts triggered');
  }
}

module.exports = { sendSignalAlerts };
