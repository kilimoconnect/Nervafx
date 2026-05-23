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
<style>
  body { margin:0; padding:0; background:#0b1120; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .wrap { max-width:600px; margin:0 auto; background:#111827; border-radius:12px; overflow:hidden; }
  .header { background:linear-gradient(135deg,#1e293b,#0f172a); padding:24px 32px; text-align:center; }
  .body { padding:28px 32px; color:#e2e8f0; font-size:15px; line-height:1.6; }
  .body h2 { color:#fff; font-size:20px; margin:0 0 12px; }
  .body p { margin:0 0 14px; }
  .cta { display:inline-block; padding:12px 28px; background:linear-gradient(135deg,#f59e0b,#d97706); color:#0f172a; font-weight:700; text-decoration:none; border-radius:8px; font-size:15px; }
  .card { background:#1e293b; border:1px solid #334155; border-radius:8px; padding:16px; margin:12px 0; }
  .card-title { color:#f59e0b; font-weight:700; font-size:14px; margin:0 0 8px; text-transform:uppercase; letter-spacing:0.5px; }
  .metric { display:inline-block; background:#0f172a; border:1px solid #334155; border-radius:6px; padding:6px 12px; margin:3px 4px; font-size:13px; color:#94a3b8; }
  .metric strong { color:#fff; }
  .signal-buy { color:#22c55e; font-weight:700; }
  .signal-sell { color:#ef4444; font-weight:700; }
  .badge { display:inline-block; padding:3px 10px; border-radius:4px; font-size:12px; font-weight:600; }
  .badge-green { background:rgba(34,197,94,0.15); color:#22c55e; }
  .badge-red { background:rgba(239,68,68,0.15); color:#ef4444; }
  .badge-amber { background:rgba(245,158,11,0.15); color:#f59e0b; }
  .footer { padding:20px 32px; text-align:center; color:#64748b; font-size:12px; border-top:1px solid #1e293b; }
  .footer a { color:#94a3b8; text-decoration:underline; }
  .divider { height:1px; background:#334155; margin:20px 0; }
</style></head>
<body><div style="padding:20px"><div class="wrap">
  <div class="header"><a href="https://nervafx.com" style="text-decoration:none"><img src="https://nervafx.com/nervafx-logo.png" alt="NervaFX" width="180" style="display:inline-block;max-width:180px;height:auto;border:0" /></a></div>
  <div class="body">${content}</div>
  <div class="footer">
    <p>NervaFX — Currency Strength & Market Energy Engine</p>
    <p><a href="{{unsubscribeUrl}}">Unsubscribe</a> · <a href="https://nervafx.com">nervafx.com</a></p>
  </div>
</div></div></body></html>`;
}

// ── Email templates ──────────────────────────────────────────────────────────

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
  const { date, sessions, topSetups, marketCycle, momentumSignal } = data;

  const sessionCards = (sessions || []).map(s => {
    const cycle = s.energy_cycle || 'N/A';
    const energy = Math.round(s.market_energy || 0);
    const mom = Math.round(s.breadth_score || 0);
    return `<div class="card">
      <div class="card-title">${s.session_name}</div>
      <span class="metric"><strong>${cycle}</strong></span>
      <span class="metric">Energy <strong>${energy}</strong></span>
      <span class="metric">Mom <strong>${mom}</strong></span>
      <span class="metric">▲${Math.round(s.bullish_breadth || 0)}% / ▼${Math.round(s.bearish_breadth || 0)}%</span>
    </div>`;
  }).join('');

  const setupRows = (topSetups || []).slice(0, 5).map(s => {
    const dir = s.direction === 'BUY'
      ? '<span class="signal-buy">BUY</span>'
      : '<span class="signal-sell">SELL</span>';
    return `<tr>
      <td style="padding:6px;color:#fff">${s.instrument.replace('_', '/')}</td>
      <td style="padding:6px">${dir}</td>
      <td style="padding:6px;color:#cbd5e1">${s.confidence}%</td>
    </tr>`;
  }).join('');

  const momHtml = momentumSignal ? `
    <div class="card" style="border-color:rgba(34,197,94,0.4)">
      <div class="card-title" style="color:#22c55e">🚀 Momentum Continuation</div>
      <p style="margin:0;color:#cbd5e1">${momentumSignal.streak} consecutive rises in ${momentumSignal.session} — continuation likely.</p>
    </div>` : '';

  return {
    subject: `Daily Market Digest — ${date}`,
    html: baseLayout(`
      <h2>Daily Market Digest</h2>
      <p>Here's your end-of-day summary for <strong>${date}</strong>.</p>
      ${marketCycle ? `<p>Market cycle: <span class="badge badge-amber">${marketCycle}</span></p>` : ''}
      ${momHtml}
      <div class="divider"></div>
      <h2 style="font-size:16px">Session Energy</h2>
      ${sessionCards || '<p style="color:#94a3b8">No session data available.</p>'}
      ${setupRows ? `
        <div class="divider"></div>
        <h2 style="font-size:16px">Top Setups</h2>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid #334155;color:#94a3b8;font-size:13px;text-align:left">
            <th style="padding:6px">Pair</th><th style="padding:6px">Direction</th><th style="padding:6px">Confidence</th>
          </tr></thead>
          <tbody>${setupRows}</tbody>
        </table>` : ''}
      <p style="text-align:center;margin:24px 0"><a class="cta" href="https://nervafx.com">Open Dashboard →</a></p>
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

module.exports = {
  sendEmail,
  sendBulk,
  confirmationEmail,
  welcomeEmail,
  signalAlertEmail,
  dailyDigestEmail,
  upgradePromptEmail,
  momentumAlertEmail,
  confluenceAlertEmail,
  approvedTradesEmail,
  impulseAlertEmail,
};
