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

const { sendEmail, baseLayout, flowSpreadAlertEmail, dailyDigestEmail } = require('./emailService');

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
  const { marketFocusHtml, triggerEnergy, triggerSession, triggerHour, currencies, pairs, removedPairs, newsEvents } = data;
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
      const m15 = (c.m15Strength * 10000).toFixed(1);
      const m15Color = c.m15Strength > 0 ? '#4ade80' : c.m15Strength < 0 ? '#f87171' : '#94a3b8';
      return `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(30,41,59,0.6)"><tr>
        <td style="padding:10px 14px">
          <span class="val" style="color:${color}">${c.currency}</span>
          <span class="dim" style="margin-left:6px">${arrow}</span>
        </td>
        <td style="padding:10px 14px;text-align:right">
          <span class="${evtTagClass(c.eventType)} tag">${evtLabel(c.eventType)}</span>
          <div style="margin-top:3px;font-size:12px"><span style="color:${m15Color};font-weight:600">M15 ${m15}p</span></div>
        </td>
      </tr></table>`;
    }).join('');

  const droppedHtml = droppedCcys.length ? `
    <div style="padding:8px 14px" class="dim">
      Dropped: ${droppedCcys.map(c => `<span style="text-decoration:line-through">${c.currency}</span>`).join(', ')}
    </div>` : '';

  // Pair rows — M15 ranked pairs with spread pips
  const pairRows = pairs.map((p, i) => {
    const isBuy = p.dir === 'BUY';
    const dirColor = isBuy ? '#4ade80' : '#f87171';
    const dirArrow = isBuy ? 'BUY' : 'SELL';
    const spreadLabel = p.spreadPips ? `${p.spreadPips.toFixed(1)}p` : '';
    return `<table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid rgba(30,41,59,0.6)"><tr>
      <td style="padding:10px 14px">
        <span style="color:#64748b;font-size:11px;margin-right:6px">#${i + 1}</span>
        <span class="val">${p.instrument.replace('_', '/')}</span>
        <span style="color:${dirColor};font-weight:600;font-size:12px;margin-left:6px">${dirArrow}</span>
      </td>
      <td style="padding:10px 14px;text-align:right">
        <span style="color:#e2e8f0;font-weight:600;font-size:13px">${spreadLabel}</span>
        <div class="dim" style="margin-top:3px">${p.strong_ccy} / ${p.weak_ccy}</div>
      </td>
    </tr></table>`;
  }).join('');

  const removedHtml = removedPairs?.length ? `
    <div style="padding:8px 14px" class="dim">
      Removed: ${removedPairs.map(p => `<span style="text-decoration:line-through">${p.replace('_','/')}</span>`).join(', ')}
    </div>` : '';

  // News section — upcoming medium/high impact
  const IMPACT_COLOR = { high: '#ef4444', medium: '#f59e0b' };
  const IMPACT_ICON = { high: '🔴', medium: '🟡' };
  const newsRows = (newsEvents || []).length ? `
    <div class="card">
      <div class="card-hd">Upcoming News (next 24h)</div>
      <div class="card-bd">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${newsEvents.map(n => {
            const t = new Date(n.event_time);
            const timeStr = t.toISOString().slice(11, 16) + ' UTC';
            const impColor = IMPACT_COLOR[n.impact] || '#94a3b8';
            const impIcon = IMPACT_ICON[n.impact] || '';
            return `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
              <td style="padding:8px 14px;width:55px" class="sm">${timeStr}</td>
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
        <div class="card-hd">Currencies</div>
        <div class="card-bd">${ccyRows}${droppedHtml}</div>
      </div>

      <div class="card">
        <div class="card-hd">Top M15 Pairs (${pairs.length})</div>
        <div class="card-bd">${pairRows}${removedHtml}</div>
      </div>

      ${newsRows}

      <div class="section">
        <p class="sm">Phase cycle: Monitoring &rarr; Pullback &rarr; Compression &rarr; Entry &rarr; Moving. You will be notified when a pair reaches Entry.</p>
      </div>

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

      // Fetch top 5 M15 pairs ranked by spread magnitude
      let m15TopPairs = [];
      try {
        const { data: m15Rows } = await sb
          .from('m15_pair_spreads')
          .select('instrument, smooth_45m')
          .order('time', { ascending: false })
          .limit(28);
        if (m15Rows?.length) {
          m15TopPairs = m15Rows
            .map(r => {
              const spread = parseFloat(r.smooth_45m) || 0;
              const [base, quote] = r.instrument.split('_');
              return {
                instrument: r.instrument,
                dir: spread >= 0 ? 'BUY' : 'SELL',
                strong_ccy: spread >= 0 ? base : quote,
                weak_ccy: spread >= 0 ? quote : base,
                spreadPips: Math.abs(spread) * 10000,
              };
            })
            .sort((a, b) => b.spreadPips - a.spreadPips)
            .slice(0, 5);
        }
      } catch (e) {
        console.warn('[EMAIL] M15 top pairs fetch failed:', e.message);
      }

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
          m15Strength: m15CcyStrength[c.currency] || 0,
        })),
        pairs: m15TopPairs,
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

  // ── 2. BREAKOUT ENTRY ALERT — M15 structure break detected ─────────────────
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
        const dirColor = isBuy ? '#4ade80' : '#f87171';
        const dirBg = isBuy ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
        const dirBorder = isBuy ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)';
        const pairLabel = ep.instrument.replace('_', '/');
        const isJPY = ep.instrument.includes('JPY');
        const d = isJPY ? 3 : 5;

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
              <div class="card-hd">Structure Levels</div>
              <div class="card-bd">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                    <td style="padding:10px 14px" class="sm">Entry Price</td>
                    <td style="padding:10px 14px;text-align:right;color:#60a5fa;font-weight:700;font-size:14px">${ep.entry_price ? ep.entry_price.toFixed(d) : '—'}</td>
                  </tr>
                  <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                    <td style="padding:10px 14px" class="sm">Invalidation</td>
                    <td style="padding:10px 14px;text-align:right;color:#f87171;font-weight:700;font-size:14px">${ep.invalidation_price ? ep.invalidation_price.toFixed(d) : '—'}</td>
                  </tr>
                  ${ep.impulse_high ? `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                    <td style="padding:10px 14px" class="sm">Impulse High</td>
                    <td style="padding:10px 14px;text-align:right" class="val">${ep.impulse_high.toFixed(d)}</td>
                  </tr>` : ''}
                  ${ep.impulse_low ? `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                    <td style="padding:10px 14px" class="sm">Impulse Low</td>
                    <td style="padding:10px 14px;text-align:right" class="val">${ep.impulse_low.toFixed(d)}</td>
                  </tr>` : ''}
                  ${ep.pullback_high ? `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
                    <td style="padding:10px 14px" class="sm">Pullback High</td>
                    <td style="padding:10px 14px;text-align:right" class="val">${ep.pullback_high.toFixed(d)}</td>
                  </tr>` : ''}
                  ${ep.pullback_low ? `<tr>
                    <td style="padding:10px 14px" class="sm">Pullback Low</td>
                    <td style="padding:10px 14px;text-align:right" class="val">${ep.pullback_low.toFixed(d)}</td>
                  </tr>` : ''}
                </table>
              </div>
            </div>

            <div class="section">
              <p class="sm">M15 candle closed past the pullback level, confirming structure break. Invalidation at ${ep.invalidation_price ? ep.invalidation_price.toFixed(d) : '—'}.</p>
            </div>

            <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com/app">View on Dashboard</a></p>
            <p class="sm" style="text-align:center">Analytical observation — not financial advice.</p>
          `),
        };

        await sendToAll(sb, recipients, template, breakoutKey, {
          instrument: ep.instrument,
          direction: ep.direction,
          entry: ep.entry_price,
        }, 'breakout_alerts');
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
