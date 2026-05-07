// NervaFX Dashboard — app.js

const REFRESH_MS = 60000;
let strengthChart = null;
let activeTF = '6';
let strengthData = null;

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n, d = 5) { return n != null ? Number(n).toFixed(d) : '—'; }
function pair(s) { return s ? s.replace('_', '/') : s; }
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toUTCString().replace('GMT', 'UTC');
}
function pctColor(v) { return Number(v) >= 0 ? '#4ade80' : '#f87171'; }

// ─── Header ───────────────────────────────────────────────────────────────────

function updateHeader(risk) {
  if (!risk?.summary) return;
  const s = risk.summary;
  const bal = Number(s.balance) || 0;
  document.getElementById('stat-balance').textContent = `Balance: $${bal.toLocaleString()}`;
  document.getElementById('stat-risk').textContent = `Daily Risk: ${s.dailyRiskPct ?? '0.00'}% / ${s.maxDailyRiskPct ?? 2}%`;
  document.getElementById('stat-trades').textContent = `Open: ${s.openTrades ?? 0} / ${s.maxTrades ?? 3}`;

  const dot = document.getElementById('status-dot');
  dot.className = 'status-dot online';
  document.getElementById('last-update').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

// ─── Signal board ─────────────────────────────────────────────────────────────

function renderSignals(data) {
  if (!data?.signals) return;
  const sigs = data.signals;
  const active = sigs.filter(s => s.signal === 'BUY' || s.signal === 'SELL');
  const waiting = sigs.filter(s => s.signal === 'WAIT');
  const notrade = sigs.filter(s => s.signal === 'NO_TRADE');

  document.getElementById('signals-active').innerHTML =
    active.length ? active.map(signalCard).join('') : '<p class="empty-state">No active signals</p>';

  document.getElementById('signals-wait').innerHTML =
    waiting.length ? waiting.map(waitCard).join('') : '';

  document.getElementById('signals-notrade').innerHTML =
    `<div style="color:var(--text-muted);font-size:11px;margin-bottom:6px">NO TRADE &mdash; ${notrade.length} pairs</div>` +
    `<div style="display:flex;flex-wrap:wrap;gap:4px">` +
    notrade.map(s => `<span style="background:var(--card-bg);color:var(--text-muted);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:10px;font-family:monospace">${pair(s.instrument)}</span>`).join('') +
    `</div>`;
}

function signalCard(s) {
  const cls = s.signal.toLowerCase();
  const ep = fmt(s.entry_price);
  const sl = fmt(s.stop_loss);
  const tp = fmt(s.take_profit);
  const confPct = s.confidence;
  return `
    <div class="signal-card ${cls}">
      <div>
        <span class="signal-pair">${pair(s.instrument)}</span>
        <span class="signal-dir ${cls}">${s.signal}</span>
      </div>
      <div class="signal-prices">
        <div class="signal-price-item"><span>Entry</span>${ep}</div>
        <div class="signal-price-item"><span>Stop</span>${sl}</div>
        <div class="signal-price-item"><span>Target</span>${tp}</div>
      </div>
      <div class="signal-conf">Confidence ${confPct}%
        <div class="conf-bar"><div class="conf-fill" style="width:${confPct}%"></div></div>
      </div>
    </div>`;
}

function waitCard(s) {
  const dir = s.direction === 'LONG' ? 'buy' : 'sell';
  return `
    <div class="signal-card wait">
      <div>
        <span class="signal-pair">${pair(s.instrument)}</span>
        <span class="signal-dir ${dir}">${s.direction || 'WAIT'}</span>
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:6px">${s.reason || ''}</div>
      <div class="signal-conf">Confidence ${s.confidence}%
        <div class="conf-bar"><div class="conf-fill" style="width:${s.confidence}%;background:var(--yellow)"></div></div>
      </div>
    </div>`;
}

// ─── Currency strength chart ──────────────────────────────────────────────────

function buildChart(data, tf) {
  if (!data?.currencies) return;
  strengthData = data;
  document.getElementById('strength-time').textContent = 'As of ' + fmtTime(data.time);

  const currencies = [...data.currencies].sort((a, b) => {
    const av = parseFloat(a[`smooth_${tf}h`] ?? a[`normalized_${tf}h`] ?? 0);
    const bv = parseFloat(b[`smooth_${tf}h`] ?? b[`normalized_${tf}h`] ?? 0);
    return bv - av;
  });

  const labels = currencies.map(c => c.currency);
  const values = currencies.map(c => parseFloat(c[`smooth_${tf}h`] ?? c[`normalized_${tf}h`] ?? 0));
  const colors = values.map(v => v >= 0 ? 'rgba(22,163,74,0.85)' : 'rgba(220,38,38,0.85)');
  const borderColors = values.map(v => v >= 0 ? '#16a34a' : '#dc2626');

  if (strengthChart) strengthChart.destroy();

  const ctx = document.getElementById('strengthChart').getContext('2d');
  strengthChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: borderColors,
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: ctx => ' ' + ctx.raw.toFixed(6) }
      }},
      scales: {
        x: { ticks: { color: '#94a3b8', font: { family: 'monospace', size: 11 } }, grid: { color: '#1e2128' } },
        y: { ticks: { color: '#94a3b8', font: { family: 'monospace', size: 10 } }, grid: { color: '#1e2128' } },
      },
    },
  });
}

// TF toggle
document.querySelectorAll('.tf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTF = btn.dataset.tf;
    if (strengthData) buildChart(strengthData, activeTF);
  });
});

// ─── Market states ────────────────────────────────────────────────────────────

function renderStates(data) {
  if (!data?.states) return;
  const el = document.getElementById('states-table');
  el.innerHTML = data.states.map(s => {
    const s6cls = parseFloat(s.spread_6h) >= 0 ? 'pos' : 'neg';
    const s12cls = parseFloat(s.spread_12h) >= 0 ? 'pos' : 'neg';
    return `
      <div class="state-row">
        <span class="state-pair">${pair(s.instrument)}</span>
        <span class="state-badge ${s.state}">${s.state}</span>
        <span class="state-spread ${s6cls}">6H: ${fmt(s.spread_6h, 5)}</span>
        <span style="color:var(--text-muted);font-size:10px">${s.confidence}</span>
        <div class="state-conf-mini"><div class="state-conf-mini-fill" style="width:${s.confidence}%"></div></div>
      </div>`;
  }).join('');
}

// ─── Spread ranking ───────────────────────────────────────────────────────────

function renderSpreads(data) {
  if (!data?.spreads) return;
  const sorted = [...data.spreads].sort((a, b) =>
    Math.abs(parseFloat(b.spread_6h)) - Math.abs(parseFloat(a.spread_6h))
  );
  const max = Math.abs(parseFloat(sorted[0]?.spread_6h || 1));

  document.getElementById('spreads-list').innerHTML = sorted.map(s => {
    const v6 = parseFloat(s.spread_6h);
    const cls = v6 >= 0 ? 'buy' : 'sell';
    const pct = Math.round((Math.abs(v6) / max) * 100);
    return `
      <div class="spread-row">
        <div class="spread-accent ${cls}"></div>
        <span class="spread-pair">${pair(s.instrument)}</span>
        <span class="spread-bias ${cls}">${v6 >= 0 ? 'BUY' : 'SELL'}</span>
        <span class="spread-val">${fmt(v6, 5)}</span>
        <div class="spread-bar-wrap"><div class="spread-bar-fill ${cls}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');
}

// ─── Risk / approved trades ───────────────────────────────────────────────────

function renderRisk(data) {
  if (!data) return;
  const el = document.getElementById('risk-list');
  const approved = data.approved || [];

  if (approved.length === 0) {
    el.innerHTML = '<p class="empty-state">No approved trades today</p>';
    return;
  }

  el.innerHTML = approved.map(r => {
    const dir = parseFloat(r.stop_loss) < parseFloat(r.entry_price) ? 'buy' : 'sell';
    return `
      <div class="risk-row">
        <div class="risk-row-header">
          <span class="risk-pair">${pair(r.instrument)} <span class="signal-dir ${dir}" style="font-size:9px">${dir.toUpperCase()}</span></span>
          <span style="color:var(--text-muted);font-size:10px">$${Number(r.risk_amount).toFixed(2)} risk · ${r.position_size} lots</span>
        </div>
        <div class="risk-prices">
          <div class="risk-price-item"><span>Entry</span>${fmt(r.entry_price)}</div>
          <div class="risk-price-item"><span>SL</span><span style="color:#f87171">${fmt(r.stop_loss)}</span></div>
          <div class="risk-price-item"><span>TP</span><span style="color:#4ade80">${fmt(r.take_profit)}</span></div>
          <div class="risk-price-item"><span>RR</span>1:${r.risk_reward || 2}</div>
        </div>
      </div>`;
  }).join('');
}

// ─── Actions log ──────────────────────────────────────────────────────────────

function renderActions(actions) {
  const el = document.getElementById('actions-list');
  if (!actions?.length) {
    el.innerHTML = '<p class="empty-state">No actions yet</p>';
    return;
  }
  el.innerHTML = actions.map(a => `
    <div class="action-row">
      <span>${pair(a.instrument)}</span>
      <span class="action-status ${a.status}">${a.status}</span>
      <span style="color:var(--text-muted);font-size:10px">${a.action_type}</span>
      <span class="action-msg">${a.message?.split('\n')[1] || a.error_message || ''}</span>
    </div>`).join('');
}

// ─── Data quality ─────────────────────────────────────────────────────────────

function renderQuality(q) {
  const el = document.getElementById('quality-info');
  if (!q?.status) { el.innerHTML = '<p class="empty-state">No quality data</p>'; return; }
  const cls = q.status === 'CLEAN' ? 'ok' : 'bad';
  el.innerHTML = `
    <div class="quality-row"><span class="quality-label">Status</span><span class="quality-val ${cls}">${q.status}</span></div>
    <div class="quality-row"><span class="quality-label">Expected</span><span class="quality-val">${q.expected_candles}</span></div>
    <div class="quality-row"><span class="quality-label">Found</span><span class="quality-val">${q.found_candles}</span></div>
    <div class="quality-row"><span class="quality-label">Missing</span><span class="quality-val ${q.missing_candles > 0 ? 'bad' : 'ok'}">${q.missing_candles}</span></div>
    <div class="quality-row"><span class="quality-label">Checked</span><span class="quality-val" style="font-size:10px">${fmtTime(q.check_time)}</span></div>`;
}

// ─── Main refresh ─────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const [strength, signals, states, risk, actions, quality, spreads] = await Promise.all([
      api('/api/strength'),
      api('/api/signals'),
      api('/api/states'),
      api('/api/risk'),
      api('/api/actions'),
      api('/api/quality'),
      api('/api/spreads'),
    ]);

    updateHeader(risk);
    renderSignals(signals);
    buildChart(strength, activeTF);
    renderStates(states);
    renderSpreads(spreads);
    renderRisk(risk);
    renderActions(actions);
    renderQuality(quality);

    document.getElementById('status-dot').className = 'status-dot online';
  } catch (err) {
    console.error('Refresh error:', err);
    document.getElementById('status-dot').className = 'status-dot stale';
  }
}

// Boot
refresh();
setInterval(refresh, REFRESH_MS);
