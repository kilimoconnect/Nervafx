'use strict';

/**
 * Approved-trade email alerts from the Structure Engine (Layer 8).
 *
 * Fires when a pair is newly approved this hour (structure > 70, trend valid,
 * not into a major level, M15 expansion/trend, currency aligned). Deduped
 * against the previous hour so a standing approval doesn't re-email.
 *
 * Reuses email_preferences.signal_alerts as the opt-in and notification_email
 * + user_profiles.timezone for delivery, matching the quality alerts.
 */

const { createClient } = require('@supabase/supabase-js');
const { sendBulk, baseLayout } = require('./emailService');

function getDB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const fmtP = p => p == null ? '—' : (Math.abs(p) >= 50 ? p.toFixed(2) : p.toFixed(5));

function approvedTradeEmail(pairs, hourIso, timezone) {
  const tz = timezone || 'UTC';
  const fmtTime = (iso) => {
    try {
      const d = new Date(iso);
      const f = d.toLocaleString('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz, hour12: false });
      const z = d.toLocaleString('en-US', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop();
      return `${f} ${z}`;
    } catch (_) { return iso; }
  };
  const dirColor = d => d === 'BULLISH' ? '#4ade80' : '#f87171';
  const dirLabel = d => d === 'BULLISH' ? 'BUY' : 'SELL';

  const rowHtml = (p) => {
    const sup = p.nearestSupport ? fmtP(p.nearestSupport.price) : '—';
    const res = p.nearestResistance ? fmtP(p.nearestResistance.price) : '—';
    const tgt = p.nextTarget != null ? fmtP(p.nextTarget) : '—';
    const inv = p.invalidation != null ? fmtP(p.invalidation) : '—';
    return `<tr>
      <td style="padding:12px 14px;border-bottom:1px solid #1e293b">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="padding:0">
            <span style="color:#f1f5f9;font-weight:800;font-size:16px;letter-spacing:-0.2px">${p.instrument.replace('_', '/')}</span>
            <span style="display:inline-block;margin-left:8px;background:${dirColor(p.trend)}20;color:${dirColor(p.trend)};font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px">${dirLabel(p.trend)}</span>
            <span style="display:inline-block;margin-left:6px;background:rgba(34,197,94,0.15);color:#4ade80;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px">✓ APPROVED</span>
          </td>
          <td style="padding:0;text-align:right">
            <span style="color:#60a5fa;font-weight:800;font-size:16px">${p.structureScore}</span>
            <span style="color:#64748b;font-size:11px;margin-left:4px">structure</span>
          </td>
        </tr></table>
        <table cellpadding="0" cellspacing="0" border="0" style="margin-top:8px"><tr>
          <td style="padding:0 14px 0 0"><span style="color:#64748b;font-size:11px">State </span><span style="color:#cbd5e1;font-size:11px;font-weight:700">${(p.state || '').replace('_', ' ')}</span></td>
          <td style="padding:0 14px 0 0"><span style="color:#64748b;font-size:11px">M15 </span><span style="color:#cbd5e1;font-size:11px;font-weight:700">${p.m15 ? p.m15.score + '% ' + p.m15.state : '—'}</span></td>
        </tr></table>
        <table cellpadding="0" cellspacing="0" border="0" style="margin-top:6px"><tr>
          <td style="padding:0 14px 0 0"><span style="color:#64748b;font-size:11px">Resistance </span><span style="color:#f1f5f9;font-size:11px;font-weight:700">${res}</span></td>
          <td style="padding:0 14px 0 0"><span style="color:#64748b;font-size:11px">Support </span><span style="color:#f1f5f9;font-size:11px;font-weight:700">${sup}</span></td>
          <td style="padding:0 14px 0 0"><span style="color:#64748b;font-size:11px">Target </span><span style="color:#4ade80;font-size:11px;font-weight:700">${tgt}</span></td>
          <td style="padding:0"><span style="color:#64748b;font-size:11px">Invalidation </span><span style="color:#f87171;font-size:11px;font-weight:700">${inv}</span></td>
        </tr></table>
      </td>
    </tr>`;
  };

  const names = pairs.map(p => p.instrument.replace('_', '/')).join(', ');
  return {
    subject: `${pairs.length} Approved Trade${pairs.length !== 1 ? 's' : ''} — ${names} — NervaFX`,
    html: baseLayout(`
      <h2 style="margin:0 0 4px">Approved Trade Setup${pairs.length !== 1 ? 's' : ''}</h2>
      <p class="sub" style="margin:0 0 4px">Structure Engine · ${fmtTime(hourIso)}</p>
      <p style="color:#94a3b8;font-size:12px;margin:0 0 16px">Passed all gates: structure &gt; 70, trend valid, clear of major level, M15 expansion/trend, currency aligned.</p>
      <div class="card" style="margin:8px 0">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          ${pairs.map(rowHtml).join('')}
        </table>
      </div>
      <div style="text-align:center;margin:24px 0">
        <a class="cta" href="https://nervafx.com/structure-engine" style="display:inline-block;padding:12px 32px;background:#22c55e;color:#0f172a;font-weight:700;text-decoration:none;border-radius:6px;font-size:14px">Open Structure Engine →</a>
      </div>
      <p style="color:#475569;font-size:11px;text-align:center;margin:16px 0 0">Approval reflects market structure quality, not a guarantee. Always manage risk and confirm your own entry.</p>
    `),
  };
}

async function sendApprovedTradeAlerts(sb, data) {
  if (!sb) sb = getDB();
  if (!data) {
    const eng = require('../api/structure-engine');
    data = await eng.computeStructure(sb);
  }

  const approved = (data.pairs || []).filter(p => p.approval && p.approval.approved);
  if (!approved.length) return { sent: 0, reason: 'no approved trades' };

  // Dedup against the previous hour — only alert on newly-approved pairs
  const bucket = (() => { const d = new Date(data.generatedAt || Date.now()); d.setUTCMinutes(0, 0, 0); return d; })();
  const prevIso = new Date(bucket.getTime() - 3600000).toISOString();
  const { data: prevRows } = await sb
    .from('structure_snapshots')
    .select('instrument')
    .eq('trade_approved', true)
    .gte('time_utc', prevIso)
    .lt('time_utc', bucket.toISOString());
  const prevSet = new Set((prevRows || []).map(r => r.instrument));
  const fresh = approved.filter(p => !prevSet.has(p.instrument));
  if (!fresh.length) return { sent: 0, reason: 'no new approvals' };

  // Subscribers (reuse signal_alerts preference + notification_email + timezone)
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 1000 });
  if (!users?.users?.length) return { sent: 0 };

  const [{ data: prefs }, { data: profiles }] = await Promise.all([
    sb.from('email_preferences').select('user_id, signal_alerts, unsubscribed, notification_email'),
    sb.from('user_profiles').select('id, timezone'),
  ]);
  const prefMap = {};
  for (const p of prefs || []) prefMap[p.user_id] = p;
  const tzMap = {};
  for (const p of profiles || []) tzMap[p.id] = p.timezone;

  const recipients = users.users.filter(u => {
    const p = prefMap[u.id];
    if (p?.unsubscribed) return false;
    if (p?.signal_alerts === false) return false;
    return true;
  }).map(u => ({ email: prefMap[u.id]?.notification_email || u.email, timezone: tzMap[u.id] || 'UTC' }));
  if (!recipients.length) return { sent: 0 };

  const byTz = {};
  for (const r of recipients) { (byTz[r.timezone] ||= []).push(r); }
  for (const [tz, group] of Object.entries(byTz)) {
    const template = approvedTradeEmail(fresh, bucket.toISOString(), tz);
    await sendBulk(group, template);
  }

  console.log(`[STRUCTURE-ALERTS] Approved: ${fresh.map(p => p.instrument).join(', ')} → ${recipients.length} users`);
  return { sent: recipients.length, approved: fresh.length };
}

module.exports = { sendApprovedTradeAlerts, approvedTradeEmail };
