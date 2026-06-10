'use strict';

/**
 * Email Alerts — Energy-driven notification system
 *
 * Three alert types aligned with the energy signal structure:
 *
 *   1. DIRECTION ALERT  — New energy bar ≥60 confirmed new/changed directions
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

const { sendEmail, baseLayout, flowSpreadAlertEmail, dailyDigestEmail } = require('./emailService');
const { getPipSize, pipValueUSD, calcPositionSize } = require('./risk');

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

  // Fetch email preferences (including notification_email override and per-type toggles)
  const { data: prefs } = await sb
    .from('email_preferences')
    .select('*');

  const prefMap = {};
  for (const p of (prefs || [])) prefMap[p.user_id] = p;

  // Fetch trading profiles (account_size, risk settings) for personalized emails
  const { data: profiles } = await sb
    .from('profiles')
    .select('id, account_size, max_daily_risk_pct, max_trades, min_rr');

  const profileMap = {};
  for (const p of (profiles || [])) profileMap[p.id] = p;

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
    // Legacy gate: if signal_alerts is explicitly false, skip all
    if (p?.signal_alerts === false) return false;

    // Use notification_email if set, otherwise registered email
    u._sendTo = p?.notification_email || u.email;
    // Attach prefs for per-type filtering downstream
    u._prefs = p || {};
    // Attach trading profile for personalized SL/TP/lot calculations
    u._profile = profileMap[u.id] || null;
    return true;
  });
}

async function sendToAll(sb, recipients, template, alertType, details, prefKey) {
  let sent = 0;
  const filtered = prefKey
    ? recipients.filter(u => u._prefs?.[prefKey] !== false)
    : recipients;
  for (const u of filtered) {
    try {
      await sendEmail(u._sendTo || u.email, template);
      sent++;
    } catch (e) {
      console.error(`[EMAIL] ${alertType} failed for ${u._sendTo || u.email}:`, e.message);
    }
  }
  await logAlertSent(sb, alertType, details);
  console.log(`[EMAIL] ${alertType} sent to ${sent}/${filtered.length} users${prefKey ? ` (pref: ${prefKey})` : ''}`);
  return sent;
}

// ── Email Templates ─────────────────────────────────────────────────────────

function directionAlertEmail(data) {
  const { marketFocusHtml, triggerEnergy, triggerSession, triggerHour, currencies, signalPairs, structureWatch, removedPairs, newsEvents } = data;
  const sessionLabel = SESS_LABEL[triggerSession] || triggerSession || 'Unknown';
  const timeStr = triggerHour ? new Date(triggerHour).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';

  const strongCcys = currencies.filter(c => c.direction === 'STRONG');
  const weakCcys = currencies.filter(c => c.direction === 'WEAK');
  const droppedCcys = currencies.filter(c => c.eventType === 'DROPPED');

  const evtLabel = t => t === 'CONTINUATION' ? 'Continue' : t === 'REVERSAL' ? 'Reversal' : t === 'NEW' ? 'New' : t === 'DROPPED' ? 'Dropped' : t;
  const evtTagClass = t => t === 'CONTINUATION' ? 'tag-blue' : t === 'NEW' ? 'tag-green' : t === 'REVERSAL' ? 'tag-amber' : 'tag-gray';
  const pipsFmt = v => (v * 10000).toFixed(1);
  const valColor = v => v > 0 ? '#4ade80' : v < 0 ? '#f87171' : '#94a3b8';

  // ── Currency Direction table (Strong / Weak with 3H + 6H) ──
  const ccyTableRow = (c) => {
    const h3 = pipsFmt(c.smooth_3h);
    const h6 = pipsFmt(c.smooth_6h);
    return `<tr style="border-bottom:1px solid rgba(30,41,59,0.4)">
      <td style="padding:8px 12px;font-weight:700;font-size:14px;color:#e2e8f0">${c.currency}</td>
      <td style="padding:8px 8px;text-align:right;font-size:12px;color:${valColor(c.smooth_3h)}">${h3}</td>
      <td style="padding:8px 8px;text-align:right;font-size:12px;color:${valColor(c.smooth_6h)}">${h6}</td>
      <td style="padding:8px 12px;text-align:right"><span class="${evtTagClass(c.eventType)} tag" style="font-size:10px">${evtLabel(c.eventType)}</span></td>
    </tr>`;
  };

  const ccyTableHeader = `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
    <td style="padding:6px 12px;font-size:10px;color:#64748b;font-weight:600"></td>
    <td style="padding:6px 8px;font-size:10px;color:#64748b;font-weight:600;text-align:right">3H</td>
    <td style="padding:6px 8px;font-size:10px;color:#64748b;font-weight:600;text-align:right">6H</td>
    <td style="padding:6px 12px;font-size:10px;color:#64748b;font-weight:600;text-align:right"></td>
  </tr>`;

  const strongRows = strongCcys.length ? `
    <tr><td colspan="4" style="padding:10px 12px 4px;font-size:11px;font-weight:700;color:#4ade80;text-transform:uppercase;letter-spacing:0.5px">Strong</td></tr>
    ${ccyTableHeader}
    ${strongCcys.map(ccyTableRow).join('')}` : '';

  const weakRows = weakCcys.length ? `
    <tr><td colspan="4" style="padding:10px 12px 4px;font-size:11px;font-weight:700;color:#f87171;text-transform:uppercase;letter-spacing:0.5px">Weak</td></tr>
    ${ccyTableHeader}
    ${weakCcys.map(ccyTableRow).join('')}` : '';

  const droppedHtml = droppedCcys.length ? `
    <div style="padding:8px 14px" class="dim">
      Dropped: ${droppedCcys.map(c => `<span style="text-decoration:line-through">${c.currency}</span>`).join(', ')}
    </div>` : '';

  // ── Signal Pairs (from energy_signal_pairs with full metrics) ──
  const phaseColor = p => p === 'ENTRY' ? '#22c55e' : p === 'MOVING' ? '#22c55e' : p === 'PULLBACK' ? '#f59e0b' : p === 'COMPRESSION' ? '#0ea5e9' : '#64748b';
  const phaseLabel = p => (p || 'MONITORING').replace(/_/g, ' ');
  const m15StateLabel = s => (s || '').replace(/_/g, ' ');
  const m15StateColor = s => s === 'EXPANDING' ? '#22c55e' : s === 'REVERSING' ? '#f59e0b' : s === 'COMPRESSING' ? '#0ea5e9' : '#64748b';

  const pairCards = (signalPairs || []).map(p => {
    const isBuy = p.dir === 'BUY';
    const dirColor = isBuy ? '#4ade80' : '#f87171';
    const v45Pips = (p.v45 * 10000).toFixed(1);
    const v90Pips = (p.v90 * 10000).toFixed(1);
    const h3Pips = (p.spread_3h * 10000).toFixed(1);
    const h6Pips = (p.spread_6h * 10000).toFixed(1);
    const de = Math.round(p.de_combined);
    const imp = p.impulse_score;
    const impCheck = p.impulse_aligned ? '✓' : '';
    const evtType = p.energy_event_type;

    return `<div class="card" style="margin-bottom:8px">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(30,41,59,0.4)">
        <tr>
          <td style="padding:12px 14px 4px">
            <span class="val" style="font-size:15px">${p.instrument.replace('_', '/')}</span>
            <span style="color:${dirColor};font-weight:700;font-size:12px;margin-left:8px">${p.dir}</span>
          </td>
        </tr>
        <tr>
          <td style="padding:0 14px 10px">
            <span style="color:${phaseColor(p.phase)};font-size:11px;font-weight:600">${phaseLabel(p.phase)}</span>
            ${p.m15_state ? `<span style="color:${m15StateColor(p.m15_state)};font-size:10px;margin-left:8px">M15: ${m15StateLabel(p.m15_state)}</span>` : ''}
          </td>
        </tr>
      </table>
      <div style="padding:10px 14px">
        <div class="dim" style="margin-bottom:6px;font-size:11px">${p.strong_ccy} vs ${p.weak_ccy}</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px">
          <tr>
            <td style="padding:3px 0;color:#64748b;width:40px">V45</td>
            <td style="padding:3px 0;color:${valColor(p.v45)};font-weight:600">${v45Pips}</td>
            <td style="padding:3px 0;color:#64748b;width:40px">3H</td>
            <td style="padding:3px 0;color:${valColor(p.spread_3h)};font-weight:600">${h3Pips}</td>
            <td style="padding:3px 0;color:#64748b;width:30px">DE</td>
            <td style="padding:3px 0;color:#e2e8f0;font-weight:600">${de}</td>
          </tr>
          <tr>
            <td style="padding:3px 0;color:#64748b">V90</td>
            <td style="padding:3px 0;color:${valColor(p.v90)};font-weight:600">${v90Pips}</td>
            <td style="padding:3px 0;color:#64748b">6H</td>
            <td style="padding:3px 0;color:${valColor(p.spread_6h)};font-weight:600">${h6Pips}</td>
            <td style="padding:3px 0;color:#64748b">Imp</td>
            <td style="padding:3px 0;color:#e2e8f0;font-weight:600">${imp}${impCheck}</td>
          </tr>
        </table>
        ${evtType ? `<div style="margin-top:6px;font-size:11px;color:#64748b">↗ Energy <span class="${evtTagClass(evtType)} tag" style="font-size:10px">${evtLabel(evtType)}</span></div>` : ''}
      </div>
    </div>`;
  }).join('');

  const removedHtml = removedPairs?.length ? `
    <div style="padding:8px 14px" class="dim">
      Removed: ${removedPairs.map(p => `<span style="text-decoration:line-through">${p.replace('_','/')}</span>`).join(', ')}
    </div>` : '';

  // ── Structure Watch (M15 compression breakout) ──
  const swReady = (structureWatch || []).filter(s => s.state === 'ENTRY_READY');
  const swFormed = (structureWatch || []).filter(s => s.state === 'STRUCTURE_FORMED');
  const swBuilding = (structureWatch || []).filter(s => s.state === 'PULLBACK_ACTIVE');
  const swTotal = swReady.length + swFormed.length + swBuilding.length;

  const fmtPrice = (v, instr) => {
    if (!v) return '—';
    const dec = (instr || '').includes('JPY') ? 3 : 5;
    return Number(v).toFixed(dec);
  };

  const swCards = swTotal > 0 ? (structureWatch || [])
    .filter(s => s.state !== 'INACTIVE' && s.state !== 'INVALIDATED')
    .map(s => {
      const isBuy = s.direction === 'BUY';
      const dirColor = isBuy ? '#4ade80' : '#f87171';
      const stateColor = s.state === 'ENTRY_READY' ? '#22c55e' : s.state === 'STRUCTURE_FORMED' ? '#0ea5e9' : '#f59e0b';
      const stateLabel = (s.state || '').replace(/_/g, ' ');
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(30,41,59,0.4);margin-bottom:4px">
        <tr>
          <td style="padding:10px 14px">
            <span class="val">${(s.instrument||'').replace('_','/')}</span>
            <span style="color:${dirColor};font-weight:600;font-size:12px;margin-left:6px">${s.direction}</span>
            <span style="color:${stateColor};font-size:11px;font-weight:600;margin-left:6px">${stateLabel}</span>
          </td>
        </tr>
        <tr><td style="padding:0 14px 10px">
          <table cellpadding="0" cellspacing="0" style="font-size:11px;color:#94a3b8">
            <tr>
              <td style="padding:2px 10px 2px 0">Imp High</td><td style="padding:2px 16px 2px 0;color:#e2e8f0;font-weight:600">${fmtPrice(s.impulse_high, s.instrument)}</td>
              <td style="padding:2px 10px 2px 0">PB High</td><td style="padding:2px 0;color:#e2e8f0;font-weight:600">${fmtPrice(s.pullback_high, s.instrument)}</td>
            </tr>
            <tr>
              <td style="padding:2px 10px 2px 0">Imp Low</td><td style="padding:2px 16px 2px 0;color:#e2e8f0;font-weight:600">${fmtPrice(s.impulse_low, s.instrument)}</td>
              <td style="padding:2px 10px 2px 0">PB Low</td><td style="padding:2px 0;color:#e2e8f0;font-weight:600">${fmtPrice(s.pullback_low, s.instrument)}</td>
            </tr>
            ${s.entry_price ? `<tr>
              <td style="padding:2px 10px 2px 0;color:#22c55e">Entry</td><td style="padding:2px 16px 2px 0;color:#22c55e;font-weight:600">${fmtPrice(s.entry_price, s.instrument)}</td>
              <td style="padding:2px 10px 2px 0;color:#ef4444">Invalid</td><td style="padding:2px 0;color:#ef4444;font-weight:600">${fmtPrice(s.invalidation_price, s.instrument)}</td>
            </tr>` : ''}
          </table>
        </td></tr>
      </table>`;
    }).join('') : '';

  const structureHtml = swTotal > 0 ? `
    <div class="card">
      <div class="card-hd">Structure Watch</div>
      <div class="card-bd">
        <div style="padding:8px 14px" class="dim">${swReady.length} ready &middot; ${swFormed.length} formed &middot; ${swBuilding.length} building</div>
        ${swCards}
      </div>
    </div>` : '';

  // ── News section ──
  const IMPACT_COLOR = { high: '#ef4444', medium: '#f59e0b' };
  const IMPACT_ICON = { high: '🔴', medium: '🟡' };
  const newsRows = (newsEvents || []).length ? `
    <div class="card">
      <div class="card-hd">Upcoming News (next 24h)</div>
      <div class="card-bd">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${newsEvents.map(n => {
            const t = new Date(n.event_time);
            const nTimeStr = t.toISOString().slice(11, 16) + ' UTC';
            const impColor = IMPACT_COLOR[n.impact] || '#94a3b8';
            const impIcon = IMPACT_ICON[n.impact] || '';
            return `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
              <td style="padding:8px 14px;width:55px" class="sm">${nTimeStr}</td>
              <td style="padding:8px 14px;width:35px"><span style="color:${impColor};font-weight:700;font-size:11px">${n.currency}</span></td>
              <td style="padding:8px 14px;font-size:12px;color:#cbd5e1">${impIcon} ${n.event_name}</td>
            </tr>`;
          }).join('')}
        </table>
      </div>
    </div>` : '';

  return {
    subject: `Direction Alert — ${strongCcys.map(c=>c.currency).join(',')} strong / ${weakCcys.map(c=>c.currency).join(',')} weak`,
    html: baseLayout(`
      <h2>Direction Alert</h2>
      <p class="sub">${sessionLabel} session &middot; Energy ${Math.round(triggerEnergy)}${timeStr ? ` &middot; ${timeStr}` : ''}</p>

      ${marketFocusHtml || ''}

      <div class="card">
        <div class="card-hd">Currency Direction</div>
        <div class="card-bd">
          <table width="100%" cellpadding="0" cellspacing="0">
            ${strongRows}${weakRows}
          </table>
          ${droppedHtml}
        </div>
      </div>

      <div class="card">
        <div class="card-hd">Signal Pairs (${(signalPairs || []).length})</div>
        <div class="card-bd">${pairCards}${removedHtml}</div>
      </div>

      ${structureHtml}

      ${newsRows}

      <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com">Open Dashboard</a></p>
      <p class="sm" style="text-align:center">Analytical observations only — not trade recommendations.</p>
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

  // ── M15 + 6H currency strength — shared by all email types ────────────────
  // M15 from m15_pair_spreads (smooth_45m), 6H from currency_strength (smooth_6h).
  // Combined = (M15 + 6H) / 2 — short-term momentum confirmed by the bigger flow.
  let m15CcyStrength = {};
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
    }
  } catch (e) {
    console.warn('[EMAIL] M15 currency strength fetch failed:', e.message);
  }

  // 6H strength per currency, then combine with M15
  try {
    const { data: h6Rows } = await sb
      .from('currency_strength')
      .select('currency, smooth_6h')
      .order('time', { ascending: false })
      .limit(8);
    const h6Map = {};
    for (const r of (h6Rows || [])) {
      if (h6Map[r.currency] == null) h6Map[r.currency] = parseFloat(r.smooth_6h) || 0;
    }
    const allCcys = new Set([...Object.keys(m15CcyStrength), ...Object.keys(h6Map)]);
    const combined = {};
    for (const ccy of allCcys) {
      combined[ccy] = ((m15CcyStrength[ccy] || 0) + (h6Map[ccy] || 0)) / 2;
    }
    m15CcyStrength = combined;
  } catch (e) {
    console.warn('[EMAIL] 6H currency strength fetch failed:', e.message);
  }

  // Reusable HTML block — M15 Currency Strength bar chart (all 8, ranked strong→weak)
  // Reusable HTML — M15 Currency Strength bars (all 8, ranked strong→weak)
  // Uses simple table rows with inline-width bars — no nested tables.
  let marketFocusHtml = '';
  {
    const ranked = Object.entries(m15CcyStrength)
      .map(([ccy, val]) => ({ ccy, val, pips: (val * 10000).toFixed(1) }))
      .sort((a, b) => b.val - a.val);

    if (ranked.length) {
      const maxAbs = Math.max(...ranked.map(r => Math.abs(r.val)), 0.0001);
      const MAX_BAR_PX = 180; // max bar width in pixels

      const rows = ranked.map(r => {
        const ratio = Math.abs(r.val) / maxAbs;
        const barPx = Math.max(Math.round(ratio * MAX_BAR_PX), 6);
        const color = r.val > 0 ? '#4ade80' : r.val < 0 ? '#f87171' : '#64748b';
        const pipStr = r.val >= 0 ? `+${r.pips}` : r.pips;
        return `<tr>
          <td style="padding:5px 10px 5px 14px;font-size:13px;font-weight:700;color:#e2e8f0;white-space:nowrap">${r.ccy}</td>
          <td style="padding:5px 0"><!--[if mso]><v:rect xmlns:v="urn:schemas-microsoft-com:vml" style="width:${barPx}px;height:14px" strokecolor="${color}" fillcolor="${color}"><v:fill type="tile"/><v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0"/></v:rect><![endif]--><!--[if !mso]><!--><div style="width:${barPx}px;height:14px;background:${color};border-radius:3px"></div><!--<![endif]--></td>
          <td style="padding:5px 14px 5px 10px;font-size:12px;color:${color};font-weight:600;white-space:nowrap;text-align:right">${pipStr}</td>
        </tr>`;
      }).join('');

      marketFocusHtml = `
        <div class="card">
          <div class="card-hd">Currency Strength (M15 + 6H)</div>
          <div class="card-bd" style="padding:6px 0">
            <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
          </div>
        </div>`;
    }
  }

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

  // Fetch upcoming medium/high impact news (next 24h)
  let upcomingNews = [];
  try {
    const now = new Date();
    const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const { data: newsRows } = await sb
      .from('forex_news')
      .select('event_time, currency, event_name, impact')
      .gte('event_time', now.toISOString())
      .lte('event_time', next24h.toISOString())
      .in('impact', ['medium', 'high'])
      .order('event_time', { ascending: true })
      .limit(15);
    upcomingNews = newsRows || [];
  } catch (_) {}

  if (hasActiveDirections && triggerTs) {
    const dirAlreadySent = await wasAlreadySent(sb, directionKey);
    if (!dirAlreadySent) {
      // Fetch active signal pairs with full detail (same as dashboard Energy Engine)
      const { data: activePairs } = await sb
        .from('energy_signal_pairs')
        .select('instrument, dir, strong_ccy, weak_ccy, phase, v45, v90, spread_3h, spread_6h, de_combined, impulse_score, impulse_aligned, m15_state, energy_event_type')
        .eq('active', true)
        .order('de_combined', { ascending: false });

      // Fetch recently deactivated pairs (removed in this event — updated within last 2h)
      const recentCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data: inactivePairs } = await sb
        .from('energy_signal_pairs')
        .select('instrument')
        .eq('active', false)
        .gte('last_updated', recentCutoff);

      // Fetch M15 structure watch for entry-ready / structure-formed pairs
      let structureWatch = [];
      try {
        const { data: swRows } = await sb
          .from('m15_structure_watch')
          .select('instrument, direction, state, impulse_high, impulse_low, pullback_high, pullback_low, entry_price, invalidation_price')
          .in('state', ['ENTRY_READY', 'STRUCTURE_FORMED', 'PULLBACK_ACTIVE']);
        structureWatch = swRows || [];
      } catch (_) {}

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
        signalPairs: (activePairs || []).map(p => ({
          instrument: p.instrument,
          dir: p.dir,
          strong_ccy: p.strong_ccy,
          weak_ccy: p.weak_ccy,
          phase: p.phase,
          v45: parseFloat(p.v45) || 0,
          v90: parseFloat(p.v90) || 0,
          spread_3h: parseFloat(p.spread_3h) || 0,
          spread_6h: parseFloat(p.spread_6h) || 0,
          de_combined: parseFloat(p.de_combined) || 0,
          impulse_score: parseInt(p.impulse_score) || 0,
          impulse_aligned: !!p.impulse_aligned,
          m15_state: p.m15_state || '',
          energy_event_type: p.energy_event_type || '',
        })),
        structureWatch,
        removedPairs: (inactivePairs || []).map(p => p.instrument),
        newsEvents: upcomingNews || [],
      });

      await sendToAll(sb, recipients, template, directionKey, {
        energy: triggerState?.energy_at_trigger,
        strong: (currStates || []).filter(c => c.direction === 'STRONG').map(c => c.currency),
        weak: (currStates || []).filter(c => c.direction === 'WEAK').map(c => c.currency),
        pairs: (activePairs || []).length,
      }, 'direction_alerts');
      emailsSent.push('direction');
    } else {
      console.log(`[EMAIL] Direction alert already sent for this event (${directionKey}) — skipping`);
    }
  }

  // ── 1b. CYCLE ALERT — EXPLOSIVE or (EXPANSION + IMPULSE/EXPANSION momentum) ─
  // Fires when the latest hourly bar has a high-energy cycle classification.
  try {
    const { data: latestHourly } = await sb
      .from('hourly_session_activity')
      .select('time_utc, session_name, market_energy, energy_cycle, momentum_type, momentum_score, tradability_score, movement_score, breadth_score, agreement_score')
      .order('time_utc', { ascending: false })
      .limit(1);

    if (latestHourly?.length) {
      const h = latestHourly[0];
      const cycle = (h.energy_cycle || '').toUpperCase();
      const momType = (h.momentum_type || '').toUpperCase();
      const isExplosive = cycle === 'EXPLOSIVE';
      const isExpansionImpulse = cycle === 'EXPANSION' && momType === 'IMPULSE';
      const isExpansionExpansion = cycle === 'EXPANSION' && momType === 'EXPANSION';

      if (isExplosive || isExpansionImpulse || isExpansionExpansion) {
        const cycleKey = `cycle_${(h.time_utc || '').slice(0, 13)}`;
        const cycleAlreadySent = await wasAlreadySent(sb, cycleKey);
        if (!cycleAlreadySent) {
          const cycleLabel = isExplosive ? 'EXPLOSIVE' : `EXPANSION + ${momType}`;
          const cycleColor = isExplosive ? '#ef4444' : '#22c55e';
          const energy = Math.round(parseFloat(h.market_energy) || 0);
          const trad = Math.round(parseFloat(h.tradability_score) || 0);
          const mov = Math.round(parseFloat(h.movement_score) || 0);
          const brd = Math.round(parseFloat(h.breadth_score) || 0);
          const agr = Math.round(parseFloat(h.agreement_score) || 0);
          const mom = Math.round(parseFloat(h.momentum_score) || 0);
          const sessLabel = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' }[h.session_name] || h.session_name;
          const timeStr = h.time_utc ? new Date(h.time_utc).toISOString().slice(11, 16) + ' UTC' : '';

          const template = {
            subject: `${cycleLabel} cycle detected — Energy ${energy}`,
            html: baseLayout(`
              ${marketFocusHtml}
              <div class="card">
                <div class="card-hd">Cycle Alert</div>
                <div class="card-bd" style="padding:16px 14px;text-align:center">
                  <div style="font-size:22px;font-weight:800;color:${cycleColor};letter-spacing:-0.3px">${cycleLabel}</div>
                  <div style="font-size:13px;color:#94a3b8;margin-top:6px">${sessLabel} session · ${timeStr}</div>
                </div>
              </div>
              <div class="card">
                <div class="card-hd">Session Metrics</div>
                <div class="card-bd" style="padding:10px 14px">
                  <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
                    <tr>
                      <td style="padding:4px 0;color:#64748b">Energy</td>
                      <td style="padding:4px 0;color:#f1f5f9;font-weight:700;text-align:right">${energy}</td>
                      <td style="padding:4px 0;color:#64748b;padding-left:16px">Tradability</td>
                      <td style="padding:4px 0;color:#f1f5f9;font-weight:700;text-align:right">${trad}</td>
                    </tr>
                    <tr>
                      <td style="padding:4px 0;color:#64748b">Movement</td>
                      <td style="padding:4px 0;color:#f1f5f9;font-weight:700;text-align:right">${mov}</td>
                      <td style="padding:4px 0;color:#64748b;padding-left:16px">Breadth</td>
                      <td style="padding:4px 0;color:#f1f5f9;font-weight:700;text-align:right">${brd}</td>
                    </tr>
                    <tr>
                      <td style="padding:4px 0;color:#64748b">Agreement</td>
                      <td style="padding:4px 0;color:#f1f5f9;font-weight:700;text-align:right">${agr}</td>
                      <td style="padding:4px 0;color:#64748b;padding-left:16px">Momentum</td>
                      <td style="padding:4px 0;color:#f1f5f9;font-weight:700;text-align:right">${mom} (${momType})</td>
                    </tr>
                  </table>
                </div>
              </div>
              <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com">Open Dashboard</a></p>
              <p class="sm" style="text-align:center">Analytical observations only — not trade recommendations.</p>
            `),
          };

          await sendToAll(sb, recipients, template, cycleKey, {
            cycle: cycleLabel,
            energy,
            session: h.session_name,
          }, 'cycle_alerts');
          emailsSent.push('cycle');
          console.log(`[EMAIL] Cycle alert sent: ${cycleLabel} — energy ${energy}, ${sessLabel} ${timeStr}`);
        } else {
          console.log(`[EMAIL] Cycle alert already sent for ${cycleKey} — skipping`);
        }
      }
    }
  } catch (e) {
    console.error('[EMAIL] Cycle alert error:', e.message);
  }

  // ── 2. BREAKOUT ENTRY ALERT — M15 structure break detected ─────────────────
  // Personalized per user: SL, TP, and lot size based on profile risk settings
  try {
    const { data: entryPairs } = await sb
      .from('m15_structure_watch')
      .select('instrument, direction, state, entry_price, impulse_high, impulse_low, pullback_high, pullback_low, invalidation_price')
      .eq('state', 'ENTRY_READY');

    if (entryPairs?.length) {
      const todayKey = new Date().toISOString().slice(0, 10);
      for (const ep of entryPairs) {
        const breakoutKey = `breakout_${ep.instrument}_${todayKey}`;
        if (await wasAlreadySent(sb, breakoutKey)) {
          console.log(`[EMAIL] Breakout for ${ep.instrument} already sent today — skipping`);
          continue;
        }

        const isBuy = ep.direction === 'BUY';
        const dirSign = isBuy ? 1 : -1;
        const dirColor = isBuy ? '#4ade80' : '#f87171';
        const dirBg = isBuy ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
        const dirBorder = isBuy ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)';
        const pairLabel = ep.instrument.replace('_', '/');
        const isJPY = ep.instrument.includes('JPY');
        const dec = isJPY ? 3 : 5;
        const pipSize = getPipSize(ep.instrument);

        // SL = invalidation price (already in structure data)
        const entryPrice = ep.entry_price || 0;
        const slPrice = ep.invalidation_price || 0;
        const stopDistance = entryPrice && slPrice ? Math.abs(entryPrice - slPrice) : 0;
        const slPips = stopDistance / pipSize;

        // Send personalized email to each eligible user
        const breakoutRecipients = recipients.filter(u => u._prefs?.breakout_alerts !== false);
        let sentCount = 0;
        for (const user of breakoutRecipients) {
          try {
            // User risk settings (defaults if no profile)
            const prof = user._profile || {};
            const accountSize = parseFloat(prof.account_size) || 10000;
            const maxDailyRisk = (parseFloat(prof.max_daily_risk_pct) || 2) / 100;
            const maxTrades = parseInt(prof.max_trades) || 3;
            const minRR = parseFloat(prof.min_rr) || 2;
            const riskPerTrade = maxDailyRisk / maxTrades;
            const riskAmount = accountSize * riskPerTrade;

            // TP = entry + (SL distance × RR) in trade direction
            const tpPrice = entryPrice && stopDistance
              ? entryPrice + (dirSign * stopDistance * minRR)
              : 0;
            const tpPips = tpPrice ? (Math.abs(tpPrice - entryPrice) / pipSize) : 0;

            // Lot size from risk
            const lotSize = entryPrice && stopDistance
              ? calcPositionSize(ep.instrument, riskAmount, stopDistance, entryPrice)
              : null;

            const riskStr = `$${riskAmount.toFixed(2)}`;
            const lotStr = lotSize ? lotSize.toFixed(2) : '—';
            const rrStr = minRR.toFixed(1);

            const template = {
              subject: `Breakout Entry — ${ep.direction} ${pairLabel}`,
              html: baseLayout(`
                <h2>Structure Breakout</h2>
                <p class="sub">${pairLabel} — M15 price structure break confirmed</p>

                <div style="background:${dirBg};border:1px solid ${dirBorder};border-radius:8px;padding:20px;margin:16px 0;text-align:center">
                  <div style="font-size:24px;color:${dirColor};font-weight:800">${ep.direction} ${pairLabel}</div>
                  <div class="dim" style="margin-top:6px">M15 Compression Breakout Entry</div>
                </div>

                ${marketFocusHtml || ''}

                <div class="card">
                  <div class="card-hd">Trade Setup</div>
                  <div class="card-bd">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                        <td style="padding:10px 14px" class="sm">Entry Price</td>
                        <td style="padding:10px 14px;text-align:right;color:#60a5fa;font-weight:700;font-size:14px">${entryPrice ? entryPrice.toFixed(dec) : '—'}</td>
                      </tr>
                      <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                        <td style="padding:10px 14px" class="sm">Stop Loss</td>
                        <td style="padding:10px 14px;text-align:right;color:#f87171;font-weight:700;font-size:14px">${slPrice ? slPrice.toFixed(dec) : '—'}<span style="font-size:11px;color:#94a3b8;font-weight:400"> (${slPips.toFixed(1)} pips)</span></td>
                      </tr>
                      <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                        <td style="padding:10px 14px" class="sm">Take Profit</td>
                        <td style="padding:10px 14px;text-align:right;color:#4ade80;font-weight:700;font-size:14px">${tpPrice ? tpPrice.toFixed(dec) : '—'}<span style="font-size:11px;color:#94a3b8;font-weight:400"> (${tpPips.toFixed(1)} pips)</span></td>
                      </tr>
                      <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                        <td style="padding:10px 14px" class="sm">Risk : Reward</td>
                        <td style="padding:10px 14px;text-align:right;color:#60a5fa;font-weight:700;font-size:14px">1 : ${rrStr}</td>
                      </tr>
                    </table>
                  </div>
                </div>

                <div class="card" style="margin-top:12px">
                  <div class="card-hd">Position Sizing</div>
                  <div class="card-bd">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                        <td style="padding:10px 14px" class="sm">Account Size</td>
                        <td style="padding:10px 14px;text-align:right" class="val">$${accountSize.toLocaleString()}</td>
                      </tr>
                      <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                        <td style="padding:10px 14px" class="sm">Risk per Trade</td>
                        <td style="padding:10px 14px;text-align:right" class="val">${(riskPerTrade * 100).toFixed(2)}% — ${riskStr}</td>
                      </tr>
                      <tr>
                        <td style="padding:10px 14px" class="sm">Lot Size</td>
                        <td style="padding:10px 14px;text-align:right;color:#60a5fa;font-weight:700;font-size:16px">${lotStr} lots</td>
                      </tr>
                    </table>
                  </div>
                </div>

                <div class="card" style="margin-top:12px">
                  <div class="card-hd">Structure Levels</div>
                  <div class="card-bd">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      ${ep.impulse_high ? `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                        <td style="padding:10px 14px" class="sm">Impulse High</td>
                        <td style="padding:10px 14px;text-align:right" class="val">${ep.impulse_high.toFixed(dec)}</td>
                      </tr>` : ''}
                      ${ep.impulse_low ? `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                        <td style="padding:10px 14px" class="sm">Impulse Low</td>
                        <td style="padding:10px 14px;text-align:right" class="val">${ep.impulse_low.toFixed(dec)}</td>
                      </tr>` : ''}
                      ${ep.pullback_high ? `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                        <td style="padding:10px 14px" class="sm">Pullback High</td>
                        <td style="padding:10px 14px;text-align:right" class="val">${ep.pullback_high.toFixed(dec)}</td>
                      </tr>` : ''}
                      ${ep.pullback_low ? `<tr>
                        <td style="padding:10px 14px" class="sm">Pullback Low</td>
                        <td style="padding:10px 14px;text-align:right" class="val">${ep.pullback_low.toFixed(dec)}</td>
                      </tr>` : ''}
                    </table>
                  </div>
                </div>

                <div class="section">
                  <p class="sm">M15 candle closed past the pullback level, confirming structure break. SL at invalidation ${slPrice ? slPrice.toFixed(dec) : '—'}, TP at ${rrStr}R = ${tpPrice ? tpPrice.toFixed(dec) : '—'}.</p>
                </div>

                <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com/app">View on Dashboard</a></p>
                <p class="sm" style="text-align:center">Analytical observation — not financial advice. Position sizing based on your profile settings.</p>
              `),
            };

            await sendEmail(user._sendTo || user.email, template);
            sentCount++;
          } catch (e) {
            console.error(`[EMAIL] Breakout for ${ep.instrument} failed for ${user._sendTo || user.email}:`, e.message);
          }
        }

        await logAlertSent(sb, breakoutKey, {
          instrument: ep.instrument,
          direction: ep.direction,
          entry: ep.entry_price,
        });
        console.log(`[EMAIL] ${breakoutKey} sent to ${sentCount}/${breakoutRecipients.length} users (personalized)`);
        emailsSent.push(`breakout:${ep.instrument}`);
      }
    }
  } catch (e) {
    console.error('[EMAIL] Breakout alert error:', e.message);
  }

  // ── 3. FLOW SPREAD ALERT — pairs with spread ≥ 30 pips (hourly, only on change) ──
  try {
    const SPREAD_THRESHOLD = 20;
    const VALID_PAIRS = new Set([
      'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
      'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
      'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
      'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
      'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
    ]);
    const CCYS = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];

    // Fetch latest 3H currency strength
    const { data: csRows } = await sb
      .from('currency_strength')
      .select('currency, smooth_3h')
      .order('time', { ascending: false })
      .limit(8);

    if (csRows?.length) {
      const valMap = {};
      for (const r of csRows) {
        if (!valMap[r.currency]) valMap[r.currency] = parseFloat(r.smooth_3h) || 0;
      }

      // Form pairs from all 28 — direction from 3H spread sign
      const spreadPairs = [];
      for (const inst of VALID_PAIRS) {
        const [base, quote] = inst.split('_');
        if (valMap[base] == null || valMap[quote] == null) continue;
        const spread3h = valMap[base] - valMap[quote];
        const spreadPips = Math.abs(spread3h) * 10000;
        if (spreadPips >= SPREAD_THRESHOLD) {
          const dir = spread3h >= 0 ? 'BUY' : 'SELL';
          const strong_ccy = spread3h >= 0 ? base : quote;
          const weak_ccy = spread3h >= 0 ? quote : base;
          spreadPairs.push({ instrument: inst, dir, strong_ccy, weak_ccy, spreadPips });
        }
      }
      spreadPairs.sort((a, b) => b.spreadPips - a.spreadPips);

      if (spreadPairs.length > 0) {
        // Dedup: create a hash from the sorted instrument list to detect changes
        const pairListHash = spreadPairs.map(p => `${p.instrument}_${p.dir}`).sort().join('|');
        const hourKey = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
        const flowSpreadKey = `flowspread_${hourKey}`;

        // Check if already sent this hour
        const flowAlreadySent = await wasAlreadySent(sb, flowSpreadKey);
        if (!flowAlreadySent) {
          // Check if the list changed compared to last sent
          let listChanged = true;
          try {
            const { data: lastLog } = await sb
              .from('email_alert_log')
              .select('details')
              .like('alert_type', 'flowspread_%')
              .order('sent_at', { ascending: false })
              .limit(1);
            if (lastLog?.length && lastLog[0].details?.pairListHash) {
              listChanged = lastLog[0].details.pairListHash !== pairListHash;
            }
          } catch (_) {}

          if (listChanged) {
            const template = flowSpreadAlertEmail(spreadPairs);
            await sendToAll(sb, recipients, template, flowSpreadKey, {
              pairListHash,
              pairs: spreadPairs.map(p => p.instrument),
              count: spreadPairs.length,
            }, 'flow_spread_alerts');
            emailsSent.push('flowspread');
          } else {
            console.log('[EMAIL] Flow spread pairs unchanged — skipping');
          }
        } else {
          console.log('[EMAIL] Flow spread alert already sent this hour — skipping');
        }
      } else {
        console.log('[EMAIL] No pairs meet 30p spread threshold — no flow spread email');
      }
    }
  } catch (e) {
    console.error('[EMAIL] Flow spread alert error:', e.message);
  }

  // ── 4. DAILY DIGEST — after NY session closes (21:00-23:59 UTC) ───────────
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
          if ((parseFloat(h.market_energy) || 0) >= 60) {
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

      // Get flow spread pairs (≥ 30p) — 3H spread logic
      let flowSpreadPairs = [];
      try {
        const { data: csData } = await sb
          .from('currency_strength')
          .select('currency, smooth_3h')
          .order('time', { ascending: false })
          .limit(8);
        if (csData?.length) {
          const vMap = {};
          for (const r of csData) {
            if (!vMap[r.currency]) vMap[r.currency] = parseFloat(r.smooth_3h) || 0;
          }
          const VALID_D = new Set(['EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD','EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD','GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD','AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD','NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY']);
          for (const inst of VALID_D) {
            const [b, q] = inst.split('_');
            if (vMap[b] == null || vMap[q] == null) continue;
            const spread3h = vMap[b] - vMap[q];
            const sp = Math.abs(spread3h) * 10000;
            if (sp >= 20) {
              const dir = spread3h >= 0 ? 'BUY' : 'SELL';
              const strong_ccy = spread3h >= 0 ? b : q;
              const weak_ccy = spread3h >= 0 ? q : b;
              flowSpreadPairs.push({ instrument: inst, dir, strong_ccy, weak_ccy, spreadPips: sp });
            }
          }
          flowSpreadPairs.sort((a, b) => b.spreadPips - a.spreadPips);
        }
      } catch (_) {}

      // Get latest hourly activity for dispersion/DE context
      let latestHourly = null;
      try {
        const { data: haRows } = await sb
          .from('hourly_session_activity')
          .select('market_energy, dispersion_score, tradability_score, de_score, energy_cycle, expansion_readiness')
          .order('time_utc', { ascending: false })
          .limit(1);
        if (haRows?.length) latestHourly = haRows[0];
      } catch (_) {}

      // Get latest M15 energy bar
      let m15Latest = null;
      try {
        const { data: m15Rows } = await sb
          .from('m15_energy_bars')
          .select('time, energy, session_name')
          .order('time', { ascending: false })
          .limit(1);
        if (m15Rows?.length) m15Latest = m15Rows[0];
      } catch (_) {}

      // Get latest 12H currency strength for digest
      let h12Map = {};
      try {
        const { data: csRows } = await sb
          .from('currency_strength')
          .select('currency, smooth_12h')
          .order('time', { ascending: false })
          .limit(8);
        for (const r of (csRows || [])) {
          if (!h12Map[r.currency]) h12Map[r.currency] = parseFloat(r.smooth_12h) || 0;
        }
      } catch (_) {}

      // Get flow performance (top pairs by final_score)
      let flowPerfPairs = [];
      try {
        const { data: fpRows } = await sb
          .from('flow_performance')
          .select('instrument, dir, status, state, de_combined, final_score, vol_grade, momentum')
          .order('time', { ascending: false })
          .limit(28);
        // Dedupe by instrument (keep latest)
        const seen = new Set();
        for (const r of (fpRows || [])) {
          if (!seen.has(r.instrument)) { seen.add(r.instrument); flowPerfPairs.push(r); }
        }
        flowPerfPairs.sort((a, b) => (b.final_score || 0) - (a.final_score || 0));
      } catch (_) {}

      const template = dailyDigestEmail({
        marketFocusHtml,
        date: todayStr,
        energyEvents,
        currencies: (digestCurrencies || []).map(c => ({
          ...c,
          smooth_12h: h12Map[c.currency] || 0,
        })),
        pairs: allPairs || [],
        sessions: sessions || [],
        flowSpreadPairs,
        latestHourly,
        m15Latest,
        flowPerfPairs,
        newsEvents: upcomingNews || [],
      });

      await sendToAll(sb, recipients, template, digestKey, { date: todayStr }, 'daily_digest');
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
