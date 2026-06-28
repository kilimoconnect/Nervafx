'use strict';

const https = require('https');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDER = {
  name:  process.env.BREVO_SENDER_NAME  || 'NervaFX',
  email: process.env.BREVO_SENDER_EMAIL || 'noreply@nervafx.com',
};

function send(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key':      apiKey,
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data || '{}'));
        } else {
          reject(new Error(`Brevo ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function baseLayout(content) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<!--[if mso]><style>table,td{font-family:Arial,sans-serif!important}</style><![endif]-->
<style>
  body{margin:0;padding:0;background:#0a0e1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .outer{max-width:600px;margin:0 auto;background:#111827}
  .accent{height:3px;background:linear-gradient(90deg,#f59e0b,#d97706,#f59e0b)}
  .hdr{padding:24px 24px 18px;text-align:center;border-bottom:1px solid #1e293b}
  .cnt{padding:32px 24px;color:#cbd5e1;font-size:14px;line-height:1.7}
  .cnt h2{color:#f1f5f9;font-size:18px;font-weight:700;margin:0 0 6px;letter-spacing:-0.2px}
  .cnt .sub{color:#94a3b8;font-size:13px;margin:0 0 20px}
  .cnt p{margin:0 0 14px}
  .section{margin:20px 0}
  .section-label{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1.2px;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid #1e293b}
  .row{display:block;padding:10px 14px;background:#0f172a;border-radius:6px;margin:6px 0}
  .row-bordered{border-left:3px solid #334155}
  .row-green{border-left-color:#22c55e}
  .row-red{border-left-color:#ef4444}
  .row-amber{border-left-color:#f59e0b}
  .tag{display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;line-height:18px}
  .tag-green{background:rgba(34,197,94,0.12);color:#4ade80}
  .tag-red{background:rgba(239,68,68,0.12);color:#f87171}
  .tag-amber{background:rgba(245,158,11,0.12);color:#fbbf24}
  .tag-blue{background:rgba(14,165,233,0.12);color:#38bdf8}
  .tag-gray{background:rgba(100,116,139,0.12);color:#94a3b8}
  .val{color:#f1f5f9;font-weight:700;font-size:14px}
  .dim{color:#64748b;font-size:12px}
  .sm{font-size:12px;color:#94a3b8}
  .cta{display:inline-block;padding:12px 32px;background:#f59e0b;color:#0f172a;font-weight:700;text-decoration:none;border-radius:6px;font-size:14px;letter-spacing:0.2px}
  .card{background:#0f172a;border:1px solid #1e293b;border-radius:8px;overflow:hidden;margin:16px 0}
  .card-hd{padding:12px 14px;border-bottom:1px solid #1e293b;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1.2px}
  .card-bd{padding:4px 0}
  .card-row{padding:0;border-bottom:1px solid rgba(30,41,59,0.6)}
  .card-row:last-child{border-bottom:none}
  .metric{display:inline-block;background:#0f172a;border:1px solid #1e293b;border-radius:4px;padding:5px 10px;margin:2px 3px;font-size:12px;color:#94a3b8}
  .metric b{color:#f1f5f9}
  .ftr{padding:24px;text-align:center;border-top:1px solid #1e293b}
  .ftr-brand{font-size:12px;font-weight:600;color:#475569;margin:0 0 6px}
  .ftr-links{font-size:11px;color:#475569;margin:0}
  .ftr-links a{color:#64748b;text-decoration:none;border-bottom:1px solid #334155}
  .signal-buy{color:#4ade80;font-weight:700}
  .signal-sell{color:#f87171;font-weight:700}
  .divider{height:1px;background:#1e293b;margin:20px 0}
  @media only screen and (max-width:480px){
    .cnt{padding:24px 16px}
    .hdr{padding:20px 16px 16px}
    .ftr{padding:20px 16px}
    .card-row{padding:9px 12px}
    .row{padding:9px 12px}
  }
</style></head>
<body><div style="padding:12px 8px"><div class="outer">
  <div class="accent"></div>
  <div class="hdr">
    <a href="https://nervafx.com" style="text-decoration:none"><img src="https://nervafx.com/nervafx-logo.png" alt="NervaFX" width="160" style="display:inline-block;max-width:160px;height:auto;border:0" /></a>
  </div>
  <div class="cnt">${content}</div>
  <div class="ftr">
    <p class="ftr-brand">NervaFX</p>
    <p class="ftr-links"><a href="https://nervafx.com">Dashboard</a></p>
  </div>
</div></div></body></html>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _fmtVal(v) {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(3) + '%';
}

function _fmtTime(iso) {
  const d = new Date(iso);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getUTCHours()).padStart(2,'0');
  const mm = String(d.getUTCMinutes()).padStart(2,'0');
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${mon[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}

function _tradeRow(t) {
  const isBuy = t.direction === 'BUY';
  const bgColor = isBuy ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)';
  const borderColor = isBuy ? '#22c55e' : '#ef4444';
  const dirColor = isBuy ? '#22c55e' : '#ef4444';
  const arrow = isBuy ? '▲' : '▼';
  const scoreHtml = t.score != null
    ? `<span style="color:#94a3b8;font-size:12px;margin-left:8px">Score: <strong style="color:#e2e8f0">${t.score}</strong></span>`
    : '';
  return `<div style="background:${bgColor};border-left:3px solid ${borderColor};border-radius:6px;padding:10px 14px;margin:6px 0">
    <span style="color:${dirColor};font-weight:700;font-size:14px">${arrow} ${t.direction}</span>
    <span style="color:#f1f5f9;font-weight:700;font-size:14px;margin-left:8px">${t.pair}</span>
    ${scoreHtml}
    <span style="color:#64748b;font-size:11px;margin-left:8px">vs ${t.vs} (#${t.vsRank})</span>
  </div>`;
}

// ── Email templates ──────────────────────────────────────────────────────────

function audnzdSignalEmail(signal) {
  const ccys = [];
  if (signal.aud?.signal) ccys.push({ ccy: 'AUD', ...signal.aud });
  if (signal.nzd?.signal) ccys.push({ ccy: 'NZD', ...signal.nzd });

  const ccyCards = ccys.map(c => {
    const isStrong = c.signal === 'STRONGEST';
    const color = isStrong ? '#22c55e' : '#ef4444';
    const icon = isStrong ? '▲' : '▼';
    const label = isStrong ? 'STRONGEST' : 'WEAKEST';
    const tagCls = isStrong ? 'tag-green' : 'tag-red';

    const tradesHtml = (c.trades || []).map(t => _tradeRow(t)).join('');

    return `<div class="card" style="border-color:${color}40">
      <div style="padding:16px 14px;border-bottom:1px solid #1e293b">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td><span style="color:${color};font-size:20px;font-weight:800">${icon} ${c.ccy} ${label}</span></td>
          <td style="text-align:right">
            <span class="tag ${tagCls}" style="font-size:13px;padding:4px 12px">Rank #${c.rank}</span>
          </td>
        </tr></table>
        <div style="margin-top:8px;font-size:15px;font-weight:700;color:${color}">${_fmtVal(c.value)}</div>
      </div>
      <div style="padding:12px 14px">
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Best Trade Pairs</div>
        ${tradesHtml}
      </div>
    </div>`;
  }).join('');

  // Scoreboard
  const ranking = signal.ranking || [];
  const maxAbs = Math.max(...ranking.map(r => Math.abs(r.value || 0)), 0.001);
  const scoreRows = ranking.map((r, i) => {
    const isAud = r.currency === 'AUD';
    const isNzd = r.currency === 'NZD';
    const nameColor = isAud ? '#60a5fa' : isNzd ? '#a78bfa' : '#e2e8f0';
    const nameWeight = (isAud || isNzd) ? '800' : '600';
    const valColor = r.value > 0.0001 ? '#4ade80' : r.value < -0.0001 ? '#f87171' : '#94a3b8';
    return `<tr style="border-bottom:1px solid rgba(30,41,59,0.4)">
      <td style="padding:6px 14px;width:30px;color:#64748b;font-size:11px">#${i + 1}</td>
      <td style="padding:6px 14px;color:${nameColor};font-weight:${nameWeight};font-size:13px">${r.currency}</td>
      <td style="padding:6px 14px;text-align:right;color:${valColor};font-weight:600;font-size:13px">${_fmtVal(r.value)}</td>
    </tr>`;
  }).join('');

  const scoreboardHtml = scoreRows ? `
    <div class="card">
      <div class="card-hd">Currency Scoreboard</div>
      <div class="card-bd"><table width="100%" cellpadding="0" cellspacing="0">${scoreRows}</table></div>
    </div>` : '';

  const subjectCcys = ccys.map(c => `${c.ccy} ${c.signal}`).join(' + ');

  return {
    subject: `${subjectCcys} — AUD/NZD M15 Signal`,
    html: baseLayout(`
      <h2>AUD/NZD Strength Signal</h2>
      <p class="sub">${_fmtTime(signal.time)} · M15 10-candle strength</p>
      ${ccyCards}
      ${scoreboardHtml}
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com/audnzd-strength">View Full Analysis →</a></p>
      <p class="sm" style="text-align:center">Market observation — not a trade recommendation. Always apply your own risk management.</p>
    `),
  };
}

function audnzdDirectionChangeEmail(change) {
  const { currency, from, to, signal, time } = change;
  const isNowStrong = to === 'STRONGEST';
  const color = isNowStrong ? '#22c55e' : '#ef4444';
  const icon = isNowStrong ? '▲' : '▼';
  const fromLabel = from === 'STRONGEST' ? 'Strongest (#1)' : from === 'WEAKEST' ? 'Weakest (#8)' : 'Neutral';
  const toLabel = to === 'STRONGEST' ? 'Strongest (#1)' : 'Weakest (#8)';

  const tradesHtml = (signal.trades || []).map(t => _tradeRow(t)).join('');

  return {
    subject: `${currency} Direction Change: ${fromLabel} → ${toLabel}`,
    html: baseLayout(`
      <h2>Direction Change Detected</h2>
      <p class="sub">${_fmtTime(time)} · M15 10-candle strength</p>

      <div class="card" style="border-color:${color}40">
        <div style="padding:20px 14px;text-align:center">
          <div style="font-size:13px;color:#94a3b8;margin-bottom:12px">
            <span class="tag tag-gray" style="font-size:12px;padding:4px 12px">${fromLabel}</span>
            <span style="color:#64748b;margin:0 10px;font-size:16px">→</span>
            <span class="tag ${isNowStrong ? 'tag-green' : 'tag-red'}" style="font-size:12px;padding:4px 12px">${toLabel}</span>
          </div>
          <div style="font-size:28px;font-weight:800;color:${color}">${icon} ${currency}</div>
          <div style="font-size:15px;font-weight:700;color:${color};margin-top:4px">${_fmtVal(signal.value)}</div>
        </div>
      </div>

      ${tradesHtml ? `
      <div style="margin-top:16px">
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Suggested Trades</div>
        ${tradesHtml}
      </div>` : ''}

      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com/audnzd-strength">View Dashboard →</a></p>
      <p class="sm" style="text-align:center">Market observation — not a trade recommendation.</p>
    `),
  };
}

function confirmationEmail(firstName, code) {
  const name = firstName || 'Trader';
  return {
    subject: `${code} — Verify your NervaFX account`,
    html: baseLayout(`
      <h2>Verify your email, ${name}</h2>
      <p>Thanks for signing up! Enter this code on the signup page to activate your account:</p>
      <div style="text-align:center;margin:28px 0">
        <div style="display:inline-block;background:#0f172a;border:2px solid #f59e0b;border-radius:12px;padding:18px 36px;letter-spacing:8px;font-size:32px;font-weight:800;color:#f59e0b;font-family:monospace">${code}</div>
      </div>
      <p style="color:#94a3b8;font-size:13px;text-align:center">This code expires in 15 minutes.</p>
      <p style="color:#64748b;font-size:12px">If you didn't create a NervaFX account, you can safely ignore this email.</p>
    `),
  };
}

function welcomeEmail(firstName) {
  const name = firstName || 'Trader';
  return {
    subject: `Welcome to NervaFX, ${name}`,
    html: baseLayout(`
      <h2>Welcome aboard, ${name}!</h2>
      <p>You've just joined the platform that tells you <strong>when to trade</strong> — and more importantly, <strong>when not to</strong>.</p>
      <div class="card">
        <div class="card-title">What you get</div>
        <p style="margin:0;color:#cbd5e1">
          ✓ Real-time currency strength across 3H, 6H & 12H<br>
          ✓ Market Energy Engine — momentum, movement & session analysis<br>
          ✓ Hourly market journal with session-by-session tracking<br>
          ✓ Trade signals with confidence scores & risk management
        </p>
      </div>
      <p>Your dashboard is ready. Log in and check the current market conditions:</p>
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">Open Dashboard →</a></p>
      <p style="color:#94a3b8;font-size:13px">Tip: Check the Market Energy section first — it tells you whether the market supports trading right now.</p>
    `),
  };
}

function signalAlertEmail(signals, sessionSummary) {
  const signalRows = signals.map(s => {
    const dir = s.direction === 'BUY'
      ? '<span class="signal-buy">▲ BUY</span>'
      : '<span class="signal-sell">▼ SELL</span>';
    return `<tr>
      <td style="padding:8px;color:#fff;font-weight:600">${s.instrument.replace('_', '/')}</td>
      <td style="padding:8px">${dir}</td>
      <td style="padding:8px;color:#cbd5e1">${s.confidence}%</td>
      <td style="padding:8px;color:#94a3b8;font-size:13px">${s.reason || ''}</td>
    </tr>`;
  }).join('');

  const sessionHtml = sessionSummary ? `
    <div class="card">
      <div class="card-title">Session Energy</div>
      <p style="margin:0;color:#cbd5e1">${sessionSummary}</p>
    </div>` : '';

  return {
    subject: `${signals.length} Signal${signals.length > 1 ? 's' : ''} Active — NervaFX`,
    html: baseLayout(`
      <h2>New Trade Signals Detected</h2>
      <p>The following signals have fired this hour:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <thead><tr style="border-bottom:1px solid #334155;color:#94a3b8;font-size:13px;text-align:left">
          <th style="padding:8px">Pair</th><th style="padding:8px">Signal</th>
          <th style="padding:8px">Confidence</th><th style="padding:8px">Reason</th>
        </tr></thead>
        <tbody>${signalRows}</tbody>
      </table>
      ${sessionHtml}
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">View Full Analysis →</a></p>
      <p style="color:#94a3b8;font-size:13px">Signals are not trade recommendations. Always apply your own risk management.</p>
    `),
  };
}

function dailyDigestEmail(data) {
  const {
    marketFocusHtml, date, energyEvents, currencies, pairs, sessions,
    flowSpreadPairs, latestHourly, m15Latest, flowPerfPairs, newsEvents,
  } = data;

  const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York', LOW_LIQUIDITY: 'Off-hours' };
  const PHASE_COLOR = { ENTRY: '#22c55e', MOVING: '#fbbf24', COMPRESSION: '#a78bfa', PULLBACK: '#f59e0b', MONITORING: '#64748b' };

  // ── Market Pulse (energy, dispersion, tradability, DE, cycle) ──
  const pulseHtml = latestHourly ? (() => {
    const e = Math.round(parseFloat(latestHourly.market_energy) || 0);
    const d = Math.round(parseFloat(latestHourly.dispersion_score) || 0);
    const t = Math.round(parseFloat(latestHourly.tradability_score) || 0);
    const de = Math.round(parseFloat(latestHourly.de_score) || 0);
    const exp = Math.round(parseFloat(latestHourly.expansion_readiness) || 0);
    const cycle = latestHourly.energy_cycle || '—';
    const eColor = e >= 60 ? '#4ade80' : e >= 40 ? '#fbbf24' : '#64748b';
    return `
    <div class="card">
      <div class="card-hd">Market Pulse</div>
      <div class="card-bd">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:12px 14px;text-align:center;width:33%">
              <div style="font-size:22px;font-weight:800;color:${eColor}">${e}</div>
              <div class="dim" style="font-size:11px;margin-top:2px">Energy</div>
            </td>
            <td style="padding:12px 14px;text-align:center;width:33%">
              <div style="font-size:22px;font-weight:800;color:#60a5fa">${d}</div>
              <div class="dim" style="font-size:11px;margin-top:2px">Dispersion</div>
            </td>
            <td style="padding:12px 14px;text-align:center;width:33%">
              <div style="font-size:22px;font-weight:800;color:#a78bfa">${de}</div>
              <div class="dim" style="font-size:11px;margin-top:2px">DE Score</div>
            </td>
          </tr>
          <tr style="border-top:1px solid rgba(30,41,59,0.6)">
            <td style="padding:10px 14px;text-align:center">
              <div style="font-size:14px;font-weight:700;color:#e2e8f0">${t}</div>
              <div class="dim" style="font-size:11px">Tradability</div>
            </td>
            <td style="padding:10px 14px;text-align:center">
              <div style="font-size:14px;font-weight:700;color:#e2e8f0">${exp}</div>
              <div class="dim" style="font-size:11px">Expansion</div>
            </td>
            <td style="padding:10px 14px;text-align:center">
              <span class="tag tag-blue">${cycle}</span>
            </td>
          </tr>
        </table>
      </div>
    </div>`;
  })() : '';



  // ── Session Summary ──
  const sessionRows = (sessions || []).map(s => {
    const energy = Math.round(parseFloat(s.market_energy) || 0);
    const trad = s.tradability_grade || '';
    const liq = s.liquidity_grade || '';
    const state = s.energy_cycle || '';
    const eColor = energy >= 55 ? '#4ade80' : energy >= 40 ? '#fbbf24' : '#64748b';
    return `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
      <td style="padding:10px 14px"><span class="val">${SESS_LABEL[s.session_name] || s.session_name}</span></td>
      <td style="padding:10px 14px;text-align:center"><span style="color:${eColor};font-weight:700">${energy}</span></td>
      <td style="padding:10px 14px;text-align:center" class="dim">${trad}</td>
      <td style="padding:10px 14px;text-align:right"><span class="tag tag-gray">${state}</span></td>
    </tr>`;
  }).join('');

  const sessionsHtml = sessionRows ? `
    <div class="card">
      <div class="card-hd">Sessions</div>
      <div class="card-bd">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 14px" class="sm dim">Session</td>
            <td style="padding:6px 14px;text-align:center" class="sm dim">Energy</td>
            <td style="padding:6px 14px;text-align:center" class="sm dim">Tradability</td>
            <td style="padding:6px 14px;text-align:right" class="sm dim">Cycle</td>
          </tr>
          ${sessionRows}
        </table>
      </div>
    </div>` : '';

  // ── Currency Directions ──
  const strong = (currencies || []).filter(c => c.direction === 'STRONG');
  const weak = (currencies || []).filter(c => c.direction === 'WEAK');

  const ccyRow = (c) => {
    const isStrong = c.direction === 'STRONG';
    const color = isStrong ? '#4ade80' : '#f87171';
    const h12 = ((parseFloat(c.smooth_12h) || 0) * 10000).toFixed(1);
    const h12Color = (parseFloat(c.smooth_12h) || 0) > 0 ? '#4ade80' : (parseFloat(c.smooth_12h) || 0) < 0 ? '#f87171' : '#94a3b8';
    const evTag = c.energy_event_type
      ? `<span class="tag tag-${c.energy_event_type === 'CONTINUATION' ? 'blue' : c.energy_event_type === 'NEW' ? 'green' : 'amber'}">${c.energy_event_type}</span>`
      : '';
    return `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
      <td style="padding:8px 14px"><span class="val" style="color:${color}">${c.currency}</span></td>
      <td style="padding:8px 14px;text-align:right">
        <span style="color:${h12Color};font-weight:600;font-size:12px">12H ${h12}p</span>
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
          ${strong.map(c => ccyRow(c)).join('')}
        </table>` : ''}
        ${weak.length ? `<table width="100%" cellpadding="0" cellspacing="0" style="${strong.length ? 'border-top:1px solid rgba(30,41,59,0.6)' : ''}">
          <tr><td colspan="2" style="padding:10px 14px;color:#f87171;font-weight:700;font-size:11px;text-transform:uppercase">Weak</td></tr>
          ${weak.map(c => ccyRow(c)).join('')}
        </table>` : ''}
      </div>
    </div>` : '';

  // ── Flow Spread Pairs (≥ 30p) ──
  const spreadHtml = (flowSpreadPairs || []).length ? (() => {
    const rows = flowSpreadPairs.slice(0, 8).map(p => {
      const isBuy = p.dir === 'BUY';
      const dirColor = isBuy ? '#4ade80' : '#f87171';
      return `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
        <td style="padding:8px 14px">
          <span class="val">${p.instrument.replace('_','/')}</span>
          <span style="color:${dirColor};font-weight:600;font-size:12px;margin-left:6px">${p.dir}</span>
        </td>
        <td style="padding:8px 14px;text-align:center" class="dim">${p.strong_ccy} ↑ ${p.weak_ccy} ↓</td>
        <td style="padding:8px 14px;text-align:right"><span style="color:#60a5fa;font-weight:700">${p.spreadPips.toFixed(1)}p</span></td>
      </tr>`;
    }).join('');
    return `
    <div class="card">
      <div class="card-hd">Flow Spread Pairs (≥30p)</div>
      <div class="card-bd">
        <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      </div>
    </div>`;
  })() : '';

  // ── Flow Performance (top active pairs with M15 enrichment) ──
  const flowPerfHtml = (flowPerfPairs || []).length ? (() => {
    const rows = flowPerfPairs.slice(0, 6).map(p => {
      const isBuy = p.dir === 'BUY';
      const dirColor = isBuy ? '#4ade80' : '#f87171';
      const stateColor = p.state === 'EXPANDING' ? '#4ade80' : p.state === 'HOLDING' ? '#fbbf24' : '#64748b';
      const de = Math.round(p.de_combined || 0);
      return `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
        <td style="padding:8px 14px">
          <span class="val" style="font-size:13px">${p.instrument.replace('_','/')}</span>
          <span style="color:${dirColor};font-weight:600;font-size:11px;margin-left:4px">${p.dir}</span>
        </td>
        <td style="padding:8px 14px;text-align:center"><span style="color:${stateColor};font-size:11px;font-weight:600">${p.state || '—'}</span></td>
        <td style="padding:8px 14px;text-align:center" class="dim">${p.vol_grade || '—'}</td>
        <td style="padding:8px 14px;text-align:right"><span class="dim">DE ${de}%</span></td>
      </tr>`;
    }).join('');
    return `
    <div class="card">
      <div class="card-hd">Flow Performance</div>
      <div class="card-bd">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="padding:6px 14px" class="sm dim">Pair</td>
            <td style="padding:6px 14px;text-align:center" class="sm dim">State</td>
            <td style="padding:6px 14px;text-align:center" class="sm dim">Vol</td>
            <td style="padding:6px 14px;text-align:right" class="sm dim">DE</td>
          </tr>
          ${rows}
        </table>
      </div>
    </div>`;
  })() : '';

  // ── Energy Events ──
  const eventRows = (energyEvents || []).map(ev => `
    <tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
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

  // ── M15 Energy ──
  const m15Html = m15Latest ? (() => {
    const e15 = Math.round(parseFloat(m15Latest.energy) || 0);
    const e15Color = e15 >= 60 ? '#4ade80' : e15 >= 40 ? '#fbbf24' : '#64748b';
    const sess = SESS_LABEL[m15Latest.session_name] || m15Latest.session_name || '';
    return `
    <div style="padding:10px 14px;border-bottom:1px solid rgba(30,41,59,0.6)">
      <span class="dim">Latest M15 Energy:</span>
      <span style="color:${e15Color};font-weight:700;margin-left:6px">${e15}</span>
      <span class="dim" style="margin-left:6px">(${sess})</span>
    </div>`;
  })() : '';

  // ── Signal Pairs ──
  const PHASE_ORDER = { ENTRY: 0, MOVING: 1, COMPRESSION: 2, PULLBACK: 3, MONITORING: 4 };
  const sorted = (pairs || []).sort((a, b) => (PHASE_ORDER[a.phase] ?? 9) - (PHASE_ORDER[b.phase] ?? 9));

  const pairRows = sorted.slice(0, 8).map(p => {
    const color = p.dir === 'BUY' ? '#4ade80' : '#f87171';
    const phColor = PHASE_COLOR[p.phase] || '#64748b';
    return `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
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
      <div class="card-hd">Signal Pairs (${pairs.length})</div>
      <div class="card-bd"><table width="100%" cellpadding="0" cellspacing="0">${pairRows}</table></div>
    </div>` : '';

  // ── News Outlook ──
  const newsHtml = (newsEvents || []).length ? (() => {
    const rows = newsEvents.slice(0, 10).map(n => {
      const t = new Date(n.event_time);
      const timeStr = t.toISOString().slice(11, 16) + ' UTC';
      const impColor = n.impact === 'high' ? '#ef4444' : '#f59e0b';
      const impIcon = n.impact === 'high' ? '🔴' : '🟡';
      return `<tr style="border-bottom:1px solid rgba(30,41,59,0.6)">
        <td style="padding:6px 14px;width:55px" class="sm">${timeStr}</td>
        <td style="padding:6px 14px;width:35px"><span style="color:${impColor};font-weight:700;font-size:11px">${n.currency}</span></td>
        <td style="padding:6px 14px;font-size:12px;color:#cbd5e1">${impIcon} ${n.event_name}</td>
      </tr>`;
    }).join('');
    return `
    <div class="card">
      <div class="card-hd">Upcoming News (24h)</div>
      <div class="card-bd"><table width="100%" cellpadding="0" cellspacing="0">${rows}</table></div>
    </div>`;
  })() : '';

  // ── Phase Summary line ──
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
      ${pulseHtml}
      ${sessionsHtml}
      ${m15Html}
      ${eventsHtml}
      ${directionsHtml}
      ${spreadHtml}
      ${flowPerfHtml}
      ${pairsHtml}
      ${newsHtml}

      <p style="text-align:center;margin:24px 0 16px"><a class="cta" href="https://nervafx.com">Open Dashboard</a></p>
      <p class="sm" style="text-align:center">Market observations — not trade recommendations.</p>
    `),
  };
}

function upgradePromptEmail(firstName) {
  const name = firstName || 'Trader';
  return {
    subject: `${name}, unlock the full NervaFX edge`,
    html: baseLayout(`
      <h2>You're missing the full picture, ${name}</h2>
      <p>You've been using NervaFX to track currency strength and market conditions — but there's more under the hood.</p>
      <div class="card">
        <div class="card-title">Premium unlocks</div>
        <p style="margin:0;color:#cbd5e1">
          ✓ Hourly momentum chart with continuation signals<br>
          ✓ Advanced AI market intelligence<br>
          ✓ Full historical journal & analytics<br>
          ✓ M15 impulse detection across all 28 pairs<br>
          ✓ Signal alerts & daily digest emails
        </p>
      </div>
      <p>The secret in forex isn't finding more trades — it's knowing when the market supports your next move. Premium gives you that clarity.</p>
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com/#pricing">Upgrade Now →</a></p>
    `),
  };
}

function momentumAlertEmail(momentum, impulses) {
  const momHtml = momentum ? `
    <div class="card" style="border-color:rgba(34,197,94,0.4)">
      <div class="card-title" style="color:#22c55e">Momentum Continuation</div>
      <p style="margin:0;color:#cbd5e1"><strong>${momentum.streak} consecutive rises in ${momentum.session}</strong> — sustained momentum buildup suggests the trend has structural support and is likely to persist. Peak value: ${momentum.peakVal}.</p>
    </div>` : '';

  const impulseRows = (impulses || []).map(imp => {
    const dir = imp.direction === 'BUY'
      ? '<span class="signal-buy">▲ Bullish</span>'
      : '<span class="signal-sell">▼ Bearish</span>';
    return `<tr>
      <td style="padding:8px;color:#fff;font-weight:600">${imp.instrument.replace('_', '/')}</td>
      <td style="padding:8px">${dir}</td>
      <td style="padding:8px;color:#cbd5e1">${imp.state || 'EXPANDING'}</td>
    </tr>`;
  }).join('');

  const impulseHtml = impulseRows ? `
    <div class="divider"></div>
    <h2 style="font-size:16px">M15 Impulse Moves</h2>
    <p style="color:#94a3b8;font-size:13px;margin-bottom:12px">These pairs show expanding momentum on the 15-minute timeframe — price is accelerating.</p>
    <table style="width:100%;border-collapse:collapse;margin:12px 0">
      <thead><tr style="border-bottom:1px solid #334155;color:#94a3b8;font-size:13px;text-align:left">
        <th style="padding:8px">Pair</th><th style="padding:8px">Direction</th><th style="padding:8px">State</th>
      </tr></thead>
      <tbody>${impulseRows}</tbody>
    </table>` : '';

  const subject = momentum && impulseRows
    ? `Momentum + ${impulses.length} Impulse Move${impulses.length > 1 ? 's' : ''} — NervaFX`
    : momentum
      ? `Momentum Continuation in ${momentum.session} — NervaFX`
      : `${impulses.length} M15 Impulse Move${impulses.length > 1 ? 's' : ''} — NervaFX`;

  return {
    subject,
    html: baseLayout(`
      <h2>Market Activity Alert</h2>
      ${momHtml}
      ${impulseHtml}
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">View Live Dashboard →</a></p>
      <p style="color:#94a3b8;font-size:13px">These are market observations, not trade recommendations. Always apply your own analysis.</p>
    `),
  };
}

function confluenceAlertEmail(confluenceData) {
  const { passed, total, pct, results, session } = confluenceData;
  const pctStr = Math.round(pct * 100);
  const strong = pct >= 0.80;

  const statusBadge = strong
    ? '<span class="badge badge-green">STRONG</span>'
    : '<span class="badge badge-amber">ACTIVE</span>';

  // Build a 2-column table grid for email compatibility
  const chipCells = results.map(r => {
    const bgColor = r.pass ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.10)';
    const borderColor = r.pass ? '#22c55e' : '#ef4444';
    const icon = r.pass ? '✓' : '✗';
    const iconColor = r.pass ? '#22c55e' : '#ef4444';
    const prefix = r.signed && r.value > 0 ? '+' : '';
    const dir = r.inverted ? '≤' : '≥';
    return `<td style="padding:4px;width:50%">
      <div style="background:${bgColor};border:1px solid ${borderColor};border-radius:6px;padding:8px 10px;font-size:13px;color:#e2e8f0">
        <span style="color:${iconColor};font-weight:700">${icon}</span> ${r.label}: <strong style="color:#fff">${prefix}${r.value}</strong> <span style="color:#64748b;font-size:11px">(${dir}${r.threshold})</span>
      </div>
    </td>`;
  });
  // Pair cells into 2-column rows
  const chipTableRows = [];
  for (let i = 0; i < chipCells.length; i += 2) {
    const cell1 = chipCells[i];
    const cell2 = chipCells[i + 1] || '<td style="padding:4px;width:50%"></td>';
    chipTableRows.push(`<tr>${cell1}${cell2}</tr>`);
  }

  const failList = results.filter(r => !r.pass);
  const failHtml = failList.length ? `
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid #334155">
      <p style="color:#94a3b8;font-size:13px;margin:0 0 6px"><strong>Failing engines:</strong></p>
      ${failList.map(r => {
        const prefix = r.signed && r.value > 0 ? '+' : '';
        const dir = r.inverted ? '≤' : '≥';
        return `<p style="color:#f87171;font-size:13px;margin:2px 0">✗ ${r.label}: ${prefix}${r.value} (need ${dir}${r.threshold})</p>`;
      }).join('')}
    </div>` : '';

  return {
    subject: `Engine Confluence ${strong ? 'STRONG' : 'Active'} (${passed}/${total}) — NervaFX`,
    html: baseLayout(`
      <h2>Engine Confluence ${statusBadge}</h2>
      <p>${passed} of ${total} engines are aligned (${pctStr}%).${session ? ` Current session: <strong>${session}</strong>.` : ''} Market conditions support high-probability setups.</p>
      <div class="card">
        <div class="card-title">Engine Status</div>
        <table style="width:100%;border-collapse:collapse;border-spacing:0">
          ${chipTableRows.join('\n          ')}
        </table>
        ${failHtml}
      </div>
      <p>Scanners, trade watchlist, and impulse detection are <strong>active</strong>. Check the dashboard for live opportunities.</p>
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">Open Dashboard →</a></p>
      <p style="color:#94a3b8;font-size:13px">Engine confluence is an analytical tool, not a trade recommendation. Always apply your own risk management.</p>
    `),
  };
}

function approvedTradesEmail(trades, confluenceData) {
  const { passed, total, pct } = confluenceData;
  const pctStr = Math.round(pct * 100);

  const tradeCards = trades.map(t => {
    const isBuy = (t.direction || t.signal) === 'BUY';
    const dir = isBuy
      ? '<span style="color:#22c55e;font-weight:700">▲ BUY</span>'
      : '<span style="color:#ef4444;font-weight:700">▼ SELL</span>';
    const borderColor = isBuy ? '#22c55e' : '#ef4444';
    const inst = (t.instrument || '').replace('_', '/');
    return `<div style="background:#1e293b;border:1px solid ${borderColor};border-radius:8px;padding:14px 16px;margin:8px 0">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="color:#fff;font-weight:700;font-size:16px;padding:0 0 8px">${inst}</td>
          <td style="text-align:right;padding:0 0 8px">${dir}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding:0">
            <table style="width:100%;border-collapse:collapse">
              <tr style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:0.5px">
                <td style="padding:4px 0">Confidence</td>
                <td style="padding:4px 0">Entry</td>
                <td style="padding:4px 0">Stop Loss</td>
                <td style="padding:4px 0">Take Profit</td>
              </tr>
              <tr style="font-size:14px">
                <td style="padding:2px 0;color:#f59e0b;font-weight:600">${t.confidence || '—'}%</td>
                <td style="padding:2px 0;color:#e2e8f0">${t.entry_price || '—'}</td>
                <td style="padding:2px 0;color:#ef4444">${t.stop_loss || '—'}</td>
                <td style="padding:2px 0;color:#22c55e">${t.take_profit || '—'}</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>`;
  }).join('');

  return {
    subject: `${trades.length} Approved Trade${trades.length > 1 ? 's' : ''} — Engine Confluence ${pctStr}%`,
    html: baseLayout(`
      <h2>Approved Trades</h2>
      <p>Engine Confluence is active (<strong>${passed}/${total}</strong> engines, ${pctStr}%). The following trades meet all approval criteria:</p>
      ${tradeCards}
      <div class="card" style="margin-top:16px">
        <div class="card-title">Engine Confluence</div>
        <p style="margin:0;color:#cbd5e1">${passed}/${total} engines aligned — conditions are favourable for these setups.</p>
      </div>
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">View Trade Details →</a></p>
      <p style="color:#94a3b8;font-size:13px">Approved trades are system-generated plans, not financial advice. Manage your own risk.</p>
    `),
  };
}

function impulseAlertEmail(impulses, confluenceData) {
  const { passed, total, pct } = confluenceData;

  const impulseCells = impulses.map(imp => {
    const isBuy = imp.direction === 'BUY';
    const borderColor = isBuy ? '#22c55e' : '#ef4444';
    const arrow = isBuy ? '▲' : '▼';
    const dirLabel = isBuy ? 'Bullish' : 'Bearish';
    const dirColor = isBuy ? '#22c55e' : '#ef4444';
    const inst = (imp.instrument || '').replace('_', '/');
    return `<td style="padding:4px;width:50%">
      <div style="background:#1e293b;border:1px solid ${borderColor};border-radius:8px;padding:12px 14px">
        <div style="color:#fff;font-weight:700;font-size:15px;margin:0 0 4px">${inst}</div>
        <div style="color:${dirColor};font-size:13px;font-weight:600">${arrow} ${dirLabel}</div>
        <div style="color:#64748b;font-size:11px;margin-top:2px">EXPANDING</div>
      </div>
    </td>`;
  });
  const impulseTableRows = [];
  for (let i = 0; i < impulseCells.length; i += 2) {
    const cell1 = impulseCells[i];
    const cell2 = impulseCells[i + 1] || '<td style="padding:4px;width:50%"></td>';
    impulseTableRows.push(`<tr>${cell1}${cell2}</tr>`);
  }

  return {
    subject: `${impulses.length} M15 Impulse${impulses.length > 1 ? 's' : ''} — Engine Active (${passed}/${total})`,
    html: baseLayout(`
      <h2>M15 Impulse Moves Detected</h2>
      <p>Engine Confluence is active (<strong>${passed}/${total}</strong>, ${Math.round(pct * 100)}%). These pairs are showing expanding momentum across 45M/90M/180M:</p>
      <table style="width:100%;border-collapse:collapse;border-spacing:0;margin:16px 0">
        ${impulseTableRows.join('\n        ')}
      </table>
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">View Live Dashboard →</a></p>
      <p style="color:#94a3b8;font-size:13px">Impulse detection is a market observation, not a trade recommendation.</p>
    `),
  };
}

function flowSpreadAlertEmail(pairs) {
  const pairCells = pairs.map(p => {
    const isBuy = p.dir === 'BUY';
    const borderColor = isBuy ? '#22c55e' : '#ef4444';
    const dirLabel = isBuy ? '▲ BUY' : '▼ SELL';
    const dirColor = isBuy ? '#22c55e' : '#ef4444';
    const inst = p.instrument.replace('_', '/');
    return `<td style="padding:4px;width:50%">
      <div style="background:#1e293b;border:1px solid ${borderColor};border-radius:8px;padding:12px 14px">
        <div style="color:#fff;font-weight:700;font-size:15px;margin:0 0 4px">${inst}</div>
        <div style="color:${dirColor};font-size:13px;font-weight:600">${dirLabel}</div>
        <div style="color:#94a3b8;font-size:11px;margin-top:4px">${p.strong_ccy} ↑ ${p.weak_ccy} ↓</div>
        <div style="color:#60a5fa;font-size:14px;font-weight:700;margin-top:4px">${p.spreadPips.toFixed(1)}p</div>
      </div>
    </td>`;
  });
  const tableRows = [];
  for (let i = 0; i < pairCells.length; i += 2) {
    const cell1 = pairCells[i];
    const cell2 = pairCells[i + 1] || '<td style="padding:4px;width:50%"></td>';
    tableRows.push(`<tr>${cell1}${cell2}</tr>`);
  }

  return {
    subject: `${pairs.length} Flow Spread Pair${pairs.length > 1 ? 's' : ''} Active (≥30p) — NervaFX`,
    html: baseLayout(`
      <h2>Flow Spread Alert</h2>
      <p>${pairs.length} pair${pairs.length > 1 ? 's' : ''} with currency spread <strong>≥ 30 pips</strong> detected. Direction derived from 3H + 6H aligned currency strength.</p>
      <table style="width:100%;border-collapse:collapse;border-spacing:0;margin:16px 0">
        ${tableRows.join('\n        ')}
      </table>
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com/flow-pairs.html">View All Pairs →</a></p>
      <p style="color:#94a3b8;font-size:13px">Flow spread pairs are market observations based on currency strength divergence, not trade recommendations.</p>
    `),
  };
}

// ── Send helpers ─────────────────────────────────────────────────────────────

async function sendEmail(to, template) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.warn('[email] BREVO_API_KEY not set — skipping'); return null; }

  const payload = {
    sender: SENDER,
    to: Array.isArray(to) ? to : [{ email: to }],
    subject: template.subject,
    htmlContent: template.html,
  };

  return send(apiKey, payload);
}

async function sendBulk(recipients, template) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.warn('[email] BREVO_API_KEY not set — skipping'); return null; }

  const batchSize = 50;
  const results = [];
  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize).map(r =>
      typeof r === 'string' ? { email: r } : r
    );
    const payload = {
      sender: SENDER,
      to: batch,
      subject: template.subject,
      htmlContent: template.html,
    };
    results.push(await send(apiKey, payload));
  }
  return results;
}

// ── H1 Structure Breaks email ───────────────────────────────────────────────

function h1BreaksEmail(data) {
  const { time, breaks, totalBreaks } = data;
  const timeStr = _fmtTime(time);

  // Summary stats
  const buyCount = breaks.filter(b => b.direction === 'BUY').length;
  const sellCount = breaks.filter(b => b.direction === 'SELL').length;
  const firstBreaks = breaks.filter(b => b._first).length;
  const avgScore = breaks.length ? Math.round(breaks.reduce((s, b) => s + b.score, 0) / breaks.length) : 0;

  // Summary metrics row
  const metricsHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0">
      <tr>
        <td style="width:25%;text-align:center;padding:12px 4px">
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:14px 8px">
            <div style="font-size:22px;font-weight:800;color:#f1f5f9">${breaks.length}</div>
            <div style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.8px;margin-top:4px">Qualified</div>
          </div>
        </td>
        <td style="width:25%;text-align:center;padding:12px 4px">
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:14px 8px">
            <div style="font-size:22px;font-weight:800;color:#4ade80">${buyCount}</div>
            <div style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.8px;margin-top:4px">Buys</div>
          </div>
        </td>
        <td style="width:25%;text-align:center;padding:12px 4px">
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:14px 8px">
            <div style="font-size:22px;font-weight:800;color:#f87171">${sellCount}</div>
            <div style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.8px;margin-top:4px">Sells</div>
          </div>
        </td>
        <td style="width:25%;text-align:center;padding:12px 4px">
          <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:14px 8px">
            <div style="font-size:22px;font-weight:800;color:#facc15">${firstBreaks}</div>
            <div style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.8px;margin-top:4px">1st Break</div>
          </div>
        </td>
      </tr>
    </table>`;

  // Break cards table
  const breakRows = breaks.map((b, i) => {
    const isBuy = b.direction === 'BUY';
    const dirColor = isBuy ? '#22c55e' : '#ef4444';
    const dirBg = isBuy ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)';
    const arrow = isBuy ? '▲' : '▼';
    const decimals = b.close > 10 ? 3 : 5;

    // Score bar (visual)
    const scoreWidth = Math.max(8, b.score);
    const scoreColor = b.score >= 70 ? '#22c55e' : b.score >= 45 ? '#f59e0b' : '#ef4444';
    const scoreBg = b.score >= 70 ? 'rgba(34,197,94,0.12)' : b.score >= 45 ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)';

    const firstBadge = b._first
      ? `<div style="display:inline-block;background:rgba(250,204,21,0.15);color:#facc15;font-size:9px;font-weight:800;padding:2px 8px;border-radius:3px;letter-spacing:0.5px;margin-left:8px">1ST BREAK</div>`
      : '';

    const breakDist = Math.abs(b.close - b.level);
    const pipsLabel = b.close > 10 ? (breakDist * 10).toFixed(1) : (breakDist * 10000).toFixed(1);

    return `
    <div style="background:#0f172a;border:1px solid #1e293b;border-left:3px solid ${dirColor};border-radius:8px;padding:0;margin:8px 0;overflow:hidden">
      <!-- Header row -->
      <div style="padding:14px 16px;border-bottom:1px solid rgba(30,41,59,0.6)">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td>
            <span style="background:${dirBg};color:${dirColor};font-size:11px;font-weight:800;padding:3px 10px;border-radius:4px;letter-spacing:0.3px">${arrow} ${b.direction}</span>
            <span style="color:#f1f5f9;font-size:16px;font-weight:800;margin-left:10px;letter-spacing:-0.2px">${b.pair}</span>
            ${firstBadge}
          </td>
          <td style="text-align:right">
            <span style="color:#64748b;font-size:11px;font-weight:600">#${i + 1}</span>
          </td>
        </tr></table>
      </div>

      <!-- Score bar -->
      <div style="padding:12px 16px;border-bottom:1px solid rgba(30,41,59,0.6)">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="width:50px;color:#94a3b8;font-size:11px;font-weight:600">Score</td>
          <td style="padding:0 12px">
            <div style="background:rgba(255,255,255,0.04);border-radius:4px;height:8px;overflow:hidden">
              <div style="width:${scoreWidth}%;height:100%;background:${scoreColor};border-radius:4px"></div>
            </div>
          </td>
          <td style="width:40px;text-align:right">
            <span style="background:${scoreBg};color:${scoreColor};font-size:13px;font-weight:800;padding:2px 8px;border-radius:4px">${b.score}</span>
          </td>
        </tr></table>
      </div>

      <!-- Metrics row -->
      <div style="padding:10px 16px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td style="text-align:center;padding:4px">
            <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Wick</div>
            <div style="font-size:13px;color:#e2e8f0;font-weight:700;margin-top:2px">${b.wickPct}%</div>
          </td>
          <td style="width:1px;background:#1e293b"></td>
          <td style="text-align:center;padding:4px">
            <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Level</div>
            <div style="font-size:13px;color:#e2e8f0;font-weight:700;margin-top:2px">${b.level.toFixed(decimals)}</div>
          </td>
          <td style="width:1px;background:#1e293b"></td>
          <td style="text-align:center;padding:4px">
            <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Close</div>
            <div style="font-size:13px;color:${dirColor};font-weight:700;margin-top:2px">${b.close.toFixed(decimals)}</div>
          </td>
          <td style="width:1px;background:#1e293b"></td>
          <td style="text-align:center;padding:4px">
            <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Pips</div>
            <div style="font-size:13px;color:${dirColor};font-weight:700;margin-top:2px">${pipsLabel}</div>
          </td>
        </tr></table>
      </div>
    </div>`;
  }).join('');

  const html = baseLayout(`
    <div style="text-align:center;margin-bottom:6px">
      <span style="display:inline-block;background:rgba(96,165,250,0.12);color:#60a5fa;font-size:10px;font-weight:700;padding:3px 12px;border-radius:10px;letter-spacing:0.8px;text-transform:uppercase">Structure Alert</span>
    </div>
    <h2 style="text-align:center">H1 Structure Breaks</h2>
    <p class="sub" style="text-align:center">${timeStr}</p>
    <p style="text-align:center;color:#94a3b8;font-size:13px;line-height:1.6;margin:0 0 4px">
      Price closed beyond the <strong style="color:#e2e8f0">10-hour high/low</strong> with
      <strong style="color:#e2e8f0">momentum confirmation</strong> and
      <strong style="color:#e2e8f0">clean wick structure</strong>.
    </p>
    <p style="text-align:center;color:#64748b;font-size:11px;margin:0 0 16px">
      ${totalBreaks} total break${totalBreaks !== 1 ? 's' : ''} detected &middot; Top ${breaks.length} shown
    </p>

    ${metricsHtml}

    <div class="section">
      <div class="section-label">Top Structure Breaks</div>
      ${breakRows}
    </div>

    <div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:16px;margin:20px 0">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="width:40px;vertical-align:top">
          <div style="background:rgba(96,165,250,0.12);width:32px;height:32px;border-radius:8px;text-align:center;line-height:32px;font-size:16px">&#9432;</div>
        </td>
        <td style="vertical-align:top;padding-left:8px">
          <div style="font-size:11px;font-weight:700;color:#60a5fa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">How to Read</div>
          <div style="font-size:12px;color:#94a3b8;line-height:1.6">
            <strong style="color:#e2e8f0">Score</strong> measures break quality — body size, wick cleanliness, and impulse strength.
            <strong style="color:#facc15">1ST BREAK</strong> marks the first time a pair breaks in that direction today.
            <strong style="color:#e2e8f0">Pips</strong> shows how far past the structure level price closed.
          </div>
        </td>
      </tr></table>
    </div>

    <div style="text-align:center;margin:28px 0 8px">
      <a href="https://www.nervafx.com/h1-breaks" class="cta" style="padding:14px 40px;font-size:15px">View All Breaks →</a>
    </div>

    <p class="sm" style="text-align:center;margin-top:20px">Market observation — not a trade recommendation. Always apply your own risk management.</p>
  `);

  // Clean subject line
  const topPair = breaks[0];
  const subjectDir = buyCount > sellCount ? 'Bullish' : sellCount > buyCount ? 'Bearish' : 'Mixed';
  return {
    subject: `⚡ H1 Break: ${topPair.pair} ${topPair.direction}${breaks.length > 1 ? ` +${breaks.length - 1} more` : ''} — ${subjectDir} Structure`,
    html,
  };
}

module.exports = {
  sendEmail,
  sendBulk,
  baseLayout,
  confirmationEmail,
  welcomeEmail,
  upgradePromptEmail,
  audnzdSignalEmail,
  audnzdDirectionChangeEmail,
  h1BreaksEmail,
};
