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
  return new Date(iso).toUTCString().replace('GMT', 'UTC');
}
function timeAgo(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const hrs  = Math.floor(diff / 3600000);
  const mins = Math.floor(diff / 60000);
  if (hrs >= 24) return `${Math.floor(hrs / 24)}d ago`;
  if (hrs > 0)   return `${hrs}h ago`;
  if (mins > 0)  return `${mins}m ago`;
  return 'just now';
}

// ─── Pipeline HTML ────────────────────────────────────────────────────────────
// stage: 0=none 1=TREND 2=PULLBACK_STARTING 3=PULLBACK_ACTIVE 4=READY_TO_ENTER 5=ENTRY_ACTIVE
const PIPE_LABELS = ['TREND', 'PB START', 'PB ACTIVE', 'READY', 'ENTRY'];
function pipelineHtml(stage) {
  if (!stage || stage === 0) return '';
  return `<div class="pipeline">` +
    PIPE_LABELS.map((label, i) => {
      const s   = i + 1;
      const cls = s < stage ? 'done' : s === stage ? `active${stage === 5 ? ' s4' : ''}` : '';
      return `<span class="pipe-step ${cls}">${label}</span>` +
             (i < 4 ? `<span class="pipe-arrow">›</span>` : '');
    }).join('') +
  `</div>`;
}

function nextActionHtml(text) {
  if (!text || text === 'No setup forming') return '';
  const cls = text === 'ENTER NOW' ? 'enter'
            : text.startsWith('Wait') ? 'wait'
            : text.startsWith('3H') ? 'wait'
            : 'watch';
  const icon = text === 'ENTER NOW' ? '▶ ' : '→ ';
  return `<div class="next-action ${cls}">${icon}${text}</div>`;
}

// ─── Header ───────────────────────────────────────────────────────────────────

function updateHeader(risk) {
  if (!risk?.summary) return;
  const s = risk.summary;
  document.getElementById('stat-balance').textContent  = `Balance: $${(Number(s.balance) || 0).toLocaleString()}`;
  document.getElementById('stat-risk').textContent     = `Daily Risk: ${s.dailyRiskPct ?? '0.00'}% / ${s.maxDailyRiskPct ?? 2}%`;
  document.getElementById('stat-trades').textContent   = `Open: ${s.openTrades ?? 0} / ${s.maxTrades ?? 3}`;
  document.getElementById('status-dot').className      = 'status-dot online';
  document.getElementById('last-update').textContent   = 'Updated ' + new Date().toLocaleTimeString();
}

// ─── AI Analysis ─────────────────────────────────────────────────────────────

// Stores latest aiMap + sentiment so modal can access them
let _aiMap = {};
let _sentimentData = null;

function aiHtml(ai, instrument) {
  if (!ai) return '';
  const d    = ai.details || {};
  const sc   = d.scores   || {};
  const lp   = d.lifecycle_phase || '';
  const lc   = d.lifecycle_completion || 0;
  const sCls = (ai.structure_type || '').replace(/-/g,'_');
  const lpCls = lp.replace(/-/g,'_').toLowerCase();
  const cpLabel = d.counter_pressure  || '';
  const cpCls   = cpLabel.toLowerCase();
  const clLabel = d.cleanliness_label || '';
  const clCls   = clLabel.toLowerCase().replace(/ /g,'_');

  const scoreBar = (val, cls) =>
    `<div class="ai-mini-score ${cls}"><div class="ai-mini-fill" style="width:${val||0}%"></div></div>`;

  return `
    <div class="ai-block">
      <div class="ai-row">
        ${lp ? `<span class="ai-lp-badge ${lpCls}">${lp.replace(/_/g,' ')}</span>` : ''}
        <span class="ai-badge ai-struct ${sCls}">${(ai.structure_type||'').replace(/_/g,' ')}</span>
        <span class="ai-badge ai-quality ${(ai.market_quality||'').toLowerCase()}">${ai.market_quality||''}</span>
        ${cpLabel ? `<span class="ai-cp-badge cp-${cpCls}">⚡ ${cpLabel}</span>` : ''}
        ${clLabel ? `<span class="ai-cl-badge cl-${clCls}">${clLabel}</span>` : ''}
        <button class="ai-bulb-btn" title="Click for full AI structure analysis" onclick="openAiModal('${instrument}')">💡 <span class="ai-bulb-label">AI Analysis</span></button>
      </div>
      ${lp ? `<div class="ai-lc-bar-wrap"><div class="ai-lc-bar-fill ${lpCls}" style="width:${lc}%"></div><span class="ai-lc-pct">${lc}%</span></div>` : ''}
      <div class="ai-scores-row">
        <div class="ai-score-item"><span>Cont</span>${scoreBar(sc.continuation,'cont')}<b>${sc.continuation??'—'}%</b></div>
        <div class="ai-score-item"><span>Trend</span>${scoreBar(sc.trend_health,'trend')}<b>${sc.trend_health??'—'}%</b></div>
        <div class="ai-score-item"><span>PBQ</span>${scoreBar(sc.pullback_quality,'pbq')}<b>${sc.pullback_quality??'—'}%</b></div>
        <div class="ai-score-item"><span>Clean</span>${scoreBar(sc.cleanliness,'clean')}<b>${sc.cleanliness??'—'}%</b></div>
      </div>
      ${ai.summary  ? `<div class="ai-summary">${ai.summary}</div>` : ''}
      ${ai.warning  ? `<div class="ai-warning">⚠ ${ai.warning}</div>` : ''}
    </div>`;
}

// ─── AI Modal ─────────────────────────────────────────────────────────────────

function openAiModal(instrument) {
  const ai = _aiMap[instrument];
  if (!ai) return;

  const d    = ai.details || {};
  const sc   = d.scores  || {};
  const lp   = d.lifecycle_phase       || '';
  const lc   = d.lifecycle_completion  || 0;
  const sCls = (ai.structure_type || '').replace(/-/g,'_');
  const lpCls = lp.replace(/-/g,'_').toLowerCase();
  const cpLabel   = d.counter_pressure    || '';
  const cpCls     = cpLabel.toLowerCase();
  const clLabel   = d.cleanliness_label   || '';
  const clCls     = clLabel.toLowerCase().replace(/ /g,'_');
  const sessLabel = d.session_label       || '';
  const sessQCls  = (d.session_quality    || '').toLowerCase().replace(/_/g,'-');
  const partLabel = d.market_participation || '';
  const contSupp  = d.continuation_support;

  document.getElementById('ai-modal-pair').textContent = pair(instrument);
  document.getElementById('ai-modal-dir').innerHTML =
    `<span class="ai-badge ai-health ${(ai.trend_health||'').toLowerCase()}">${ai.trend_health||''}</span>`;
  document.getElementById('ai-modal-struct-badge').innerHTML =
    `<span class="ai-badge ai-struct ${sCls}">${(ai.structure_type||'').replace(/_/g,' ')}</span>`;

  const scoreBlock = (label, val, cls) => `
    <div class="ai-modal-score-block">
      <div class="ai-modal-score-label">${label}</div>
      <div class="ai-modal-score-num">${val ?? '—'}%</div>
      <div class="ai-modal-score-bar"><div class="ai-modal-score-fill ${cls}" style="width:${val??0}%"></div></div>
    </div>`;

  document.getElementById('ai-modal-body').innerHTML = `
    ${_sentimentData?.sentiment?.sentiment === 'NEUTRAL' ? `
    <div class="sent-neutral-warn" style="margin-bottom:10px">
      ⚠ Risk sentiment NEUTRAL — no clear money flow direction. No edge confirmed. High risk to trade.
    </div>` : ''}
    ${lp ? `
    <div class="ai-modal-lifecycle">
      <div class="ai-modal-lp-header">
        <span class="ai-lp-badge ${lpCls}">${lp.replace(/_/g,' ')}</span>
        <span class="ai-modal-lc-label">Phase completion</span>
        <span class="ai-modal-lc-pct">${lc}%</span>
      </div>
      <div class="ai-modal-lc-bar"><div class="ai-modal-lc-fill ${lpCls}" style="width:${lc}%"></div></div>
    </div>` : ''}

    ${(cpLabel || clLabel) ? `
    <div class="ai-modal-quality-row">
      ${cpLabel ? `
      <div class="ai-modal-quality-item">
        <div class="ai-modal-quality-label">Counter Pressure</div>
        <span class="ai-cp-badge cp-${cpCls} ai-modal-cp">${cpLabel}</span>
      </div>` : ''}
      ${clLabel ? `
      <div class="ai-modal-quality-item">
        <div class="ai-modal-quality-label">Market Quality</div>
        <span class="ai-cl-badge cl-${clCls} ai-modal-cl">${clLabel}</span>
      </div>` : ''}
    </div>` : ''}

    ${sessLabel ? `
    <div class="ai-modal-session-row">
      <span class="sess-card-badge sq-${sessQCls}" style="font-size:11px;padding:4px 10px">⏱ ${sessLabel}</span>
      ${partLabel ? `<span class="ai-modal-participation part-${partLabel.toLowerCase()}">${partLabel} PARTICIPATION</span>` : ''}
      ${contSupp != null ? `<span class="ai-modal-cont-support ${contSupp ? 'yes' : 'no'}">${contSupp ? '✓ CONTINUATION SUPPORTED' : '⚠ REDUCED CONDITIONS'}</span>` : ''}
    </div>
    ${d.session_context ? `<div class="ai-modal-session-text">${d.session_context}</div>` : ''}
    ` : ''}

    <div class="ai-modal-scores">
      ${scoreBlock('Continuation', sc.continuation, 'cont')}
      ${scoreBlock('Trend Health', sc.trend_health,  'trend')}
      ${scoreBlock('Pullback Quality', sc.pullback_quality, 'pbq')}
      ${scoreBlock('Cleanliness', sc.cleanliness, 'clean')}
    </div>

    ${ai.summary ? `<div class="ai-modal-summary">${ai.summary}</div>` : ''}

    ${d.flow_of_money ? (() => {
      const ma    = d.macro_alignment || 'NEUTRAL';
      const maCls = ma === 'ALIGNED' ? 'aligned' : ma === 'CONFLICTED' ? 'conflicted' : 'neutral';
      const maIcon = ma === 'ALIGNED' ? '✦' : ma === 'CONFLICTED' ? '✕' : '○';
      return `
    <div class="ai-modal-flow">
      <div class="ai-modal-flow-header">
        <span class="ai-modal-flow-title">💸 Flow of Money</span>
        <span class="ai-macro-badge ${maCls}">${maIcon} MACRO ${ma.replace(/_/g,' ')}</span>
      </div>
      <div class="ai-modal-flow-text">${d.flow_of_money}</div>
    </div>`;
    })() : ''}

    <div class="ai-modal-sections">
      ${d.structure_analysis ? `
        <div class="ai-modal-section">
          <div class="ai-modal-section-title">📊 Structure Analysis</div>
          <div class="ai-modal-section-text">${d.structure_analysis}</div>
        </div>` : ''}

      ${d.trend_assessment ? `
        <div class="ai-modal-section">
          <div class="ai-modal-section-title">📈 Trend Assessment</div>
          <div class="ai-modal-section-text">${d.trend_assessment}</div>
        </div>` : ''}

      ${d.pullback_quality_text ? `
        <div class="ai-modal-section">
          <div class="ai-modal-section-title">🔄 Pullback Quality</div>
          <div class="ai-modal-section-text">${d.pullback_quality_text}</div>
        </div>` : ''}

      ${d.momentum_shift ? `
        <div class="ai-modal-section">
          <div class="ai-modal-section-title">⚡ Momentum Shift</div>
          <div class="ai-modal-section-text">${d.momentum_shift}</div>
        </div>` : ''}

      <div class="ai-modal-factors-row">
        ${(d.support_factors||[]).length ? `
          <div class="ai-modal-factors">
            <div class="ai-modal-section-title">✅ Structure Support</div>
            ${d.support_factors.map(f=>`<div class="ai-factor support">+ ${f}</div>`).join('')}
          </div>` : ''}

        ${(d.risk_factors||[]).length ? `
          <div class="ai-modal-factors">
            <div class="ai-modal-section-title">⚠ Structure Risks</div>
            ${d.risk_factors.map(f=>`<div class="ai-factor risk">− ${f}</div>`).join('')}
          </div>` : ''}
      </div>
    </div>

    ${ai.warning ? `<div class="ai-modal-warning">⚠ ${ai.warning}</div>` : ''}
    <div class="ai-modal-footer">48H analysis · updated ${fmtTime(ai.time)} · gpt-4o-mini</div>
  `;

  document.getElementById('ai-modal-overlay').classList.add('open');
}

function closeAiModal() {
  document.getElementById('ai-modal-overlay').classList.remove('open');
}

// Close on Escape key
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAiModal(); });

// ─── Session badge helper ─────────────────────────────────────────────────────

function sessionBadgeHtml(s) {
  if (!s.session_label) return '';
  const qCls  = (s.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
  const delta = s.session_delta;
  const dStr  = delta != null ? (delta > 0 ? ` +${delta}` : ` ${delta}`) : '';
  return `<span class="sess-card-badge sq-${qCls}">⏱ ${s.session_label}${dStr}</span>`;
}

// ─── Live Opportunities ───────────────────────────────────────────────────────

function renderLiveOpportunities(states, aiMap = {}, sentimentData = null) {
  const el = document.getElementById('live-opportunities');
  if (!el) return;

  const sentNeutral = sentimentData?.sentiment?.sentiment === 'NEUTRAL';

  const live = (states || []).filter(s =>
    s.state === 'READY_TO_ENTER' && s.confidence >= 75 && !s.session_blocked
  );

  if (!live.length) {
    el.innerHTML = '<p class="empty-state" style="color:var(--text-muted)">No live opportunities right now — monitoring active setups</p>';
    // Hide the section header glow when no entries
    const sec = document.getElementById('section-live');
    if (sec) sec.style.borderColor = 'var(--border)';
    return;
  }

  // Make section glow green when live entries exist
  const sec = document.getElementById('section-live');
  if (sec) sec.style.borderColor = '#4ade80';

  el.innerHTML = live.map(s => {
    const dir = s.bias === 'BUY' ? 'buy' : 'sell';
    const ta  = s.tf_alignment || {};
    return `
      <div class="live-card ${dir}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div class="live-pair">${pair(s.instrument)}</div>
            <div class="live-signal ${dir}">${s.bias}</div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">
              <span class="phase-badge ENTRY_ACTIVE">ENTRY ACTIVE</span>
              ${s.pullback_depth ? `<span class="pb-depth ${s.pullback_depth}">${s.pullback_depth} PB</span>` : ''}
              ${sessionBadgeHtml(s)}
            </div>
          </div>
          <div style="text-align:right">
            <div class="live-conf-num">${s.confidence}%</div>
            <div class="conf-bar" style="width:60px;margin-left:auto"><div class="conf-fill" style="width:${s.confidence}%"></div></div>
          </div>
        </div>
        <div class="signal-tf-row">
          <span class="tf-item ${ta.h12}">12H ${ta.h12||'→'}</span>
          <span class="tf-item ${ta.h6}">6H ${ta.h6||'→'}</span>
          <span class="tf-item ${ta.h3}">3H ${ta.h3||'→'}</span>
          <span class="sb-behavior ${s.spread_behavior}">${(s.spread_behavior||'').replace(/_/g,' ')}</span>
        </div>
        <div class="live-reason">${s.spread_behavior_text}</div>
        ${sentNeutral ? `<div class="sent-neutral-warn">⚠ Risk sentiment is NEUTRAL — no clear money flow direction. No edge confirmed. High risk to trade.</div>` : ''}
        ${(s.confidence_breakdown||[]).length ? `<div class="conf-factors" style="align-items:flex-start;margin-top:6px">${s.confidence_breakdown.map(f=>`<span>+ ${f}</span>`).join('')}</div>` : ''}
        ${aiHtml(aiMap[s.instrument], s.instrument)}
      </div>`;
  }).join('');
}

// ─── Top Setups ───────────────────────────────────────────────────────────────

function computeTopSetups(states) {
  const priority = { READY: 3, PULLBACK: 2, TREND: 1 };
  return [...states]
    .filter(s => s.state !== 'NO_TRADE' && s.confidence > 0 && !s.session_blocked)
    .sort((a, b) => {
      const pa = priority[a.phase] || 0, pb = priority[b.phase] || 0;
      return pa !== pb ? pb - pa : b.confidence - a.confidence;
    })
    .slice(0, 3);
}

function renderTopSetups(states, aiMap = {}, sentimentData = null) {
  const el = document.getElementById('top-setups');
  if (!states?.length) { el.innerHTML = '<p class="empty-state">No setups forming</p>'; return; }

  const sentNeutral = sentimentData?.sentiment?.sentiment === 'NEUTRAL';

  const setups = computeTopSetups(states);
  if (!setups.length) { el.innerHTML = '<p class="empty-state">No setups forming</p>'; return; }

  const rankCls = ['hot', 'warm', 'cool'];
  el.innerHTML = setups.map((s, i) => {
    const dir   = s.bias === 'BUY' ? 'buy' : 'sell';
    const ta    = s.tf_alignment || {};
    const phCls = (s.phase || '').replace(' ', '_');
    const bd    = s.confidence_breakdown || [];
    return `
      <div class="top-card ${rankCls[i]}">
        <div class="top-rank">${i + 1}</div>
        <div class="top-body">
          <div class="top-header">
            <span class="top-pair">${pair(s.instrument)}</span>
            <span class="signal-dir ${dir}">${s.bias}</span>
            <span class="phase-badge ${phCls}">${(s.phase||'').replace(/_/g,' ')}</span>
            <span class="action-badge ${s.action}">${s.action}</span>
          </div>
          ${sessionBadgeHtml(s)}
          ${pipelineHtml(s.pipeline_stage)}
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <div class="top-entry-status entry-${s.entry_status}">${(s.entry_status || '').replace(/_/g, ' ')}</div>
            ${s.pullback_depth ? `<span class="pb-depth ${s.pullback_depth}">${s.pullback_depth} PULLBACK</span>` : ''}
          </div>
          <div class="top-tf">
            <span class="tf-item ${ta.h12}">12H ${ta.h12 || '→'}</span>
            <span class="tf-item ${ta.h6}">6H ${ta.h6 || '→'}</span>
            <span class="tf-item ${ta.h3}">3H ${ta.h3 || '→'}</span>
            <span class="sb-behavior ${s.spread_behavior}">${(s.spread_behavior||'').replace(/_/g,' ')}</span>
          </div>
          <div style="font-size:9px;color:var(--text-muted);margin-bottom:3px">${s.spread_behavior_text || ''}</div>
          ${nextActionHtml(s.next_action)}
          ${sentNeutral ? `<div class="sent-neutral-warn">⚠ Risk sentiment NEUTRAL — no clear money flow direction. No edge confirmed. High risk to trade.</div>` : ''}
          ${aiHtml(aiMap[s.instrument], s.instrument)}
        </div>
        <div class="top-conf">
          <div class="conf-num">${s.confidence}%</div>
          <div class="conf-bar" style="width:72px"><div class="conf-fill" style="width:${s.confidence}%"></div></div>
          ${bd.length ? `<div class="conf-factors">${bd.map(f => `<span>+ ${f}</span>`).join('')}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ─── Signal board ─────────────────────────────────────────────────────────────

function renderSignals(data, statesArr) {
  if (!data?.signals) return;
  const sigs    = data.signals;
  const active  = sigs.filter(s => s.signal === 'BUY' || s.signal === 'SELL');
  const waiting = sigs.filter(s => s.signal === 'WAIT');
  const notrade = sigs.filter(s => s.signal === 'NO_TRADE');

  const stateMap = {};
  (statesArr || []).forEach(st => { stateMap[st.instrument] = st; });

  document.getElementById('signals-active').innerHTML =
    active.length
      ? active.map(s => signalCard(s, stateMap[s.instrument])).join('')
      : '<p class="empty-state">No active signals</p>';

  document.getElementById('signals-wait').innerHTML =
    waiting.length ? waiting.map(s => waitCard(s, stateMap[s.instrument])).join('') : '';

  // Last signal time
  const ago = data.lastSignalTime ? timeAgo(data.lastSignalTime) : null;
  const lastBar = ago
    ? `<div class="last-signal-bar">Last signal: <b>${data.lastSignalInstrument?.replace('_','/')}</b> — ${ago}</div>`
    : '';

  // NO TRADE — cleaner label
  document.getElementById('signals-notrade').innerHTML =
    `<div style="color:var(--text-muted);font-size:10px;margin-bottom:6px">Filtered out: ${notrade.length} pairs (low quality / no alignment)</div>` +
    `<div style="display:flex;flex-wrap:wrap;gap:4px">` +
    notrade.map(s => `<span style="background:var(--bg-card);color:var(--text-muted);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:10px;font-family:monospace">${pair(s.instrument)}</span>`).join('') +
    `</div>` + lastBar;
}

function tfRow(ta, sb, sbText) {
  if (!ta) return '';
  return `<div class="signal-tf-row">
    <span class="tf-item ${ta.h12}">12H ${ta.h12 || '→'}</span>
    <span class="tf-item ${ta.h6}">6H ${ta.h6 || '→'}</span>
    <span class="tf-item ${ta.h3}">3H ${ta.h3 || '→'}</span>
    ${sb ? `<span class="sb-behavior ${sb}">${sb.replace(/_/g,' ')}</span>` : ''}
  </div>
  ${sbText ? `<div style="font-size:9px;color:var(--text-muted);margin-bottom:4px">${sbText}</div>` : ''}`;
}

function signalCard(s, st) {
  const cls   = s.signal.toLowerCase();
  const ta    = st?.tf_alignment;
  const phCls = (st?.phase || '').replace(' ', '_');
  const bd    = st?.confidence_breakdown || [];
  return `
    <div class="signal-card ${cls}">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span class="signal-pair">${pair(s.instrument)}</span>
        <span class="signal-dir ${cls}">${s.signal}</span>
        ${st?.phase ? `<span class="phase-badge ${phCls}">${(st.phase||'').replace(/_/g,' ')}</span>` : ''}
        ${st?.action === 'ENTER' ? `<span class="action-badge ENTER">ENTER</span>` : ''}
      </div>
      ${pipelineHtml(st?.pipeline_stage)}
      ${tfRow(ta, st?.spread_behavior, st?.spread_behavior_text)}
      <div class="signal-prices">
        <div class="signal-price-item"><span>Entry</span>${fmt(s.entry_price)}</div>
        <div class="signal-price-item"><span>Stop</span><span style="color:#f87171">${fmt(s.stop_loss)}</span></div>
        <div class="signal-price-item"><span>Target</span><span style="color:#4ade80">${fmt(s.take_profit)}</span></div>
      </div>
      <div class="signal-conf">Confidence ${s.confidence}%
        <div class="conf-bar"><div class="conf-fill" style="width:${s.confidence}%"></div></div>
      </div>
      ${bd.length ? `<div class="conf-factors" style="align-items:flex-start;margin-top:5px">${bd.map(f => `<span>+ ${f}</span>`).join('')}</div>` : ''}
      ${st?.session_label ? `<div class="sess-inline-badge sq-${(st.session_quality||'').toLowerCase().replace(/_/g,'-')}">${st.session_label}${st.session_delta != null ? ` <span class="sess-inline-delta">${st.session_delta > 0 ? '+' : ''}${st.session_delta}</span>` : ''}</div>` : ''}
      ${st?.next_action ? nextActionHtml(st.next_action) : ''}
    </div>`;
}

function waitCard(s, st) {
  const dir   = s.direction === 'LONG' ? 'buy' : 'sell';
  const ta    = st?.tf_alignment;
  const phCls = (st?.phase || 'PULLBACK').replace(' ', '_');
  return `
    <div class="signal-card wait">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <span class="signal-pair">${pair(s.instrument)}</span>
        <span class="signal-dir ${dir}">${s.direction || 'WAIT'}</span>
        <span class="phase-badge ${phCls}">${(st?.phase || 'WAIT').replace(/_/g,' ')}</span>
        <span class="action-badge WAIT">WAIT</span>
      </div>
      ${pipelineHtml(st?.pipeline_stage)}
      ${tfRow(ta, st?.spread_behavior, st?.spread_behavior_text)}
      <div class="signal-conf" style="margin-top:4px">Confidence ${s.confidence}%
        <div class="conf-bar"><div class="conf-fill" style="width:${s.confidence}%;background:var(--yellow)"></div></div>
      </div>
      ${st?.next_action ? nextActionHtml(st.next_action) : ''}
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

  const labels       = currencies.map(c => c.currency);
  const values       = currencies.map(c => parseFloat(c[`smooth_${tf}h`] ?? c[`normalized_${tf}h`] ?? 0));
  const colors       = values.map(v => v >= 0 ? 'rgba(22,163,74,0.85)' : 'rgba(220,38,38,0.85)');
  const borderColors = values.map(v => v >= 0 ? '#16a34a' : '#dc2626');

  if (strengthChart) strengthChart.destroy();
  const ctx = document.getElementById('strengthChart').getContext('2d');
  strengthChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: borderColors, borderWidth: 1, borderRadius: 4 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + ctx.raw.toFixed(6) } } },
      scales: {
        x: { ticks: { color: '#94a3b8', font: { family: 'monospace', size: 11 } }, grid: { color: '#1e2128' } },
        y: { ticks: { color: '#94a3b8', font: { family: 'monospace', size: 10 } }, grid: { color: '#1e2128' } },
      },
    },
  });

  renderMomentumStrip(data.currencies);
}

function renderMomentumStrip(currencies) {
  const el = document.getElementById('strength-momentum');
  if (!el || !currencies?.length) return;
  const sorted = [...currencies].sort((a, b) =>
    (parseFloat(b.smooth_6h) || 0) - (parseFloat(a.smooth_6h) || 0)
  );
  el.innerHTML = sorted.map(c => {
    const v    = parseFloat(c.smooth_6h) || 0;
    const cls  = v > 0.01 ? 'pos' : v < -0.01 ? 'neg' : 'neu';
    const acc  = c.accel_label === 'accelerating' ? ' ▲' : c.accel_label === 'decelerating' ? ' ▼' : '';
    return `<span class="mom-item ${cls}" title="${c.accel_label || ''}">${c.currency} ${c.momentum || '→'}${acc}</span>`;
  }).join('');
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
    const ta    = s.tf_alignment || {};
    const phCls = (s.phase || '').replace(' ', '_');
    if (s.state === 'NO_TRADE') return `
      <div class="state-row-v2" style="opacity:0.45">
        <div class="state-row-top">
          <span class="state-pair">${pair(s.instrument)}</span>
          <span class="phase-badge NO_TRADE">NO TRADE</span>
        </div>
      </div>`;
    return `
      <div class="state-row-v2">
        <div class="state-row-top">
          <span class="state-pair">${pair(s.instrument)}</span>
          <span class="phase-badge ${phCls}">${(s.phase || s.state || '').replace(/_/g,' ')}</span>
          <span class="action-badge ${s.action}">${s.action || '—'}</span>
          <div class="state-conf-mini" style="width:36px;margin-left:auto">
            <div class="state-conf-mini-fill" style="width:${s.confidence}%"></div>
          </div>
          <span style="font-size:10px;color:var(--text-muted)">${s.confidence}%</span>
        </div>
        <div class="state-row-bottom">
          <span class="tfa ${ta.h12}">12H${ta.h12||'→'}</span>
          <span class="tfa ${ta.h6}">6H${ta.h6||'→'}</span>
          <span class="tfa ${ta.h3}">3H${ta.h3||'→'}</span>
          <span class="sb-behavior ${s.spread_behavior}">${(s.spread_behavior||'').replace(/_/g,' ')}</span>
          ${s.pullback_depth ? `<span class="pb-depth ${s.pullback_depth}">${s.pullback_depth}</span>` : ''}
          ${s.next_action && s.next_action !== 'No setup forming' ? `<span style="font-size:9px;color:var(--text-muted)">→ ${s.next_action}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ─── Spread ranking ───────────────────────────────────────────────────────────

function renderSpreads(data) {
  if (!data?.spreads) return;
  // Use server-sorted order (weighted: 40% 12H + 35% 6H + 15% 3H + 10% accel)
  const sorted = data.spreads;
  const maxScore = Math.max(...sorted.map(s => s.weighted_score || 0), 0.0001);
  document.getElementById('spreads-list').innerHTML = sorted.map(s => {
    const v6  = parseFloat(s.spread_6h);
    const cls = v6 >= 0 ? 'buy' : 'sell';
    const pct = Math.round(((s.weighted_score || 0) / maxScore) * 100);
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

function renderRisk(data, sentimentData = null) {
  if (!data) return;
  const el       = document.getElementById('risk-list');
  const approved = data.approved || [];

  if (sentimentData?.sentiment?.sentiment === 'NEUTRAL') {
    el.innerHTML = `
      <div class="risk-neutral-block">
        <div class="risk-neutral-icon">⛔</div>
        <div class="risk-neutral-msg">
          <b>Trades not approved</b><br>
          Risk sentiment is <b>NEUTRAL</b> — markets show no clear money flow direction.<br>
          Wait for sentiment to confirm Risk On or Risk Off before taking trades.
        </div>
      </div>`;
    return;
  }

  if (approved.length === 0) { el.innerHTML = '<p class="empty-state">No approved trades today</p>'; return; }
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
  if (!actions?.length) { el.innerHTML = '<p class="empty-state">No actions yet</p>'; return; }
  el.innerHTML = actions.map(a => `
    <div class="action-row">
      <span>${pair(a.instrument)}</span>
      <span class="action-status ${a.status}">${a.status}</span>
      <span style="color:var(--text-muted);font-size:10px">${(a.action_type||'').replace(/_/g,' ')}</span>
      <span class="action-msg">${(a.message?.split('\n')[1] || a.error_message || '').replace(/([A-Z]{3})_([A-Z]{3})/g,'$1/$2')}</span>
    </div>`).join('');
}

// ─── Trading Session ──────────────────────────────────────────────────────────

const SESSION_TIMELINE = [
  { name: 'ASIA',        label: 'Asia',       hours: '00–06', quality: 'medium'    },
  { name: 'LONDON_OPEN', label: 'LDN Open',   hours: '07–10', quality: 'high'      },
  { name: 'LONDON',      label: 'London',     hours: '10–13', quality: 'high'      },
  { name: 'LONDON_NY',   label: 'LDN/NY',     hours: '13–17', quality: 'very_high' },
  { name: 'LATE_NY',     label: 'Late NY',    hours: '17–21', quality: 'low'       },
  { name: 'DEAD_HOURS',  label: 'Dead',       hours: '21–00', quality: 'blocked'   },
];

function renderSession(data) {
  const el = document.getElementById('session-display');
  if (!el) return;

  const s  = data?.session;
  const tl = data?.timeline || SESSION_TIMELINE;

  if (!s) {
    el.innerHTML = '<p class="empty-state">Session data unavailable</p>';
    return;
  }

  const qCls     = (s.quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
  const allowed  = s.trades_allowed;
  const activity = s.activity_index || 0;

  // Quality label display
  const qLabel = {
    VERY_HIGH: '✦ VERY HIGH',
    HIGH:      '▲ HIGH',
    MEDIUM:    '● MEDIUM',
    LOW:       '▼ LOW',
    BLOCKED:   '⛔ BLOCKED',
  }[s.quality] || s.quality;

  // Activity bar colour
  const actCls = activity >= 75 ? 'very-high'
               : activity >= 55 ? 'high'
               : activity >= 35 ? 'medium'
               : 'low';

  // UTC range display — null-safe, with DST badge when offsets differ from winter baseline
  const hFmt = h => h != null ? String(h).padStart(2, '0') + ':00' : '—';
  const utcRange = (s.start_hour != null && s.end_hour != null)
    ? `${hFmt(s.start_hour)} – ${hFmt(s.end_hour)} UTC`
    : '';
  const dstBadge = s.dst_active
    ? ' <span class="sess-dst-badge">DST adjusted</span>'
    : '';

  // Timeline — prefer dynamic data from API (DST-aware hours); fall back to static
  const tlSource = tl && tl.length ? tl : SESSION_TIMELINE;
  const timelineHtml = tlSource.map(t => {
    const isCurrent = t.name === s.session;
    // Dynamic hours when available (API), static hours string as fallback
    const hStr = (t.startHour != null && t.endHour != null)
      ? `${String(t.startHour).padStart(2,'0')}–${String(t.endHour).padStart(2,'0')}`
      : (t.hours || '');
    return `<div class="sess-tl-item ${t.quality}${isCurrent ? ' current' : ''}">
      <span class="sess-tl-label">${t.label}</span>
      <span class="sess-tl-hours">${hStr}</span>
    </div>`;
  }).join('<span class="sess-tl-arrow">›</span>');

  // Session delta text for status line
  const deltaStr = s.conf_delta > 0 ? `+${s.conf_delta}` : `${s.conf_delta}`;
  const deltaHtml = s.conf_delta !== null && s.conf_delta !== -999
    ? `<span class="sess-delta ${s.conf_delta >= 0 ? 'pos' : 'neg'}">${deltaStr} conf</span>`
    : '';

  el.innerHTML = `
    <div class="session-main">
      <div class="session-name-wrap">
        <div class="sess-name-badge sq-${qCls}">${s.label || s.session}</div>
        ${utcRange ? `<div class="sess-hours-utc">${utcRange}${dstBadge}</div>` : ''}
      </div>
      <div class="session-quality-wrap">
        <div class="sess-qlabel sq-${qCls}">${qLabel}</div>
        <div class="sess-qdesc">${s.quality_desc || ''}</div>
      </div>
      <div class="session-activity-wrap">
        <div class="sess-act-header">
          <span class="sess-act-label">Market Activity</span>
          <span class="sess-act-pct">${activity}%</span>
        </div>
        <div class="sess-act-bar-wrap">
          <div class="sess-act-bar-fill act-${actCls}" style="width:${activity}%"></div>
        </div>
      </div>
      <div class="session-status-wrap">
        ${allowed
          ? `<div class="sess-status allowed">✓ TRADING ACTIVE</div>${deltaHtml}`
          : `<div class="sess-status blocked">⛔ ${s.block_reason || 'TRADING BLOCKED'}</div>`
        }
      </div>
    </div>
    <div class="session-timeline">${timelineHtml}</div>`;
}

// ─── Sentiment donut chart (CSS conic-gradient) ───────────────────────────────

function sentimentDonutHtml(groups) {
  // groups: [{title, vals}] — same format used in renderSentiment
  const GAP = 2; // degrees gap between segments

  const data = groups.map(g => {
    const vals = g.vals.filter(v => v != null).map(Number);
    const sum  = vals.reduce((a, b) => a + b, 0);
    const color = sum > 5 ? '#4ade80' : sum < -5 ? '#f87171' : '#64748b';
    const shortTitle = g.title.split('/')[0].trim();
    return { title: shortTitle, sum, absSum: Math.abs(sum), color };
  });

  const total = data.reduce((a, b) => a + b.absSum, 0) || 1;

  // Build conic-gradient stops
  let angle = 0;
  const stops = [];
  data.forEach(d => {
    const deg = (d.absSum / total) * 360;
    if (deg < 0.5) { angle += deg; return; } // skip invisible slivers
    const end = angle + deg - GAP;
    stops.push(`${d.color} ${angle.toFixed(2)}deg ${end.toFixed(2)}deg`);
    stops.push(`#0a0c10 ${end.toFixed(2)}deg ${(angle + deg).toFixed(2)}deg`);
    angle += deg;
  });

  const gradient = stops.length
    ? `conic-gradient(${stops.join(', ')})`
    : 'conic-gradient(#1e2128 0deg 360deg)';

  return `
    <div class="sent-donut-wrap">
      <div class="sent-donut" style="background:${gradient}">
        <div class="sent-donut-hole"></div>
      </div>
      <div class="sent-donut-legend">
        ${data.map(d => `
          <div class="sent-legend-item">
            <span class="sent-legend-dot" style="background:${d.color}"></span>
            <span class="sent-legend-label">${d.title}</span>
            <span class="sent-legend-val" style="color:${d.color}">${d.sum > 0 ? '+' : ''}${d.sum.toFixed(0)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

// ─── Risk Sentiment ───────────────────────────────────────────────────────────

function renderSentiment(data) {
  const el = document.getElementById('sentiment-display');
  if (!el) return;

  const s = data?.sentiment;
  if (!s) {
    el.innerHTML = '<p class="empty-state">No sentiment data — runs on next hourly update</p>';
    return;
  }

  const sentCls = s.sentiment === 'RISK_ON'  ? 'risk-on'
               : s.sentiment === 'RISK_OFF' ? 'risk-off'
               : 'neutral';
  const sentLabel = (s.sentiment || 'NEUTRAL').replace(/_/g, ' ');

  const envCls = (s.environment || 'CALM').toLowerCase();
  const envLabel = s.environment || 'CALM';

  const confPct = s.confidence || 0;
  const accel   = Number(s.accel_composite || 0);
  const accelCls = accel > 10 ? 'risk-on' : accel < -10 ? 'risk-off' : 'neutral';
  const accelArrow = accel > 20 ? '↑↑' : accel > 5 ? '↑' : accel < -20 ? '↓↓' : accel < -5 ? '↓' : '→';

  // Components grouped for display — calculation unchanged
  // vals array is used for both group rows and the donut chart
  const groups = [
    { title: 'Growth / Risk Assets', vals: [s.equity_score, s.oil_score] },
    { title: 'Carry / Risk FX',      vals: [s.audjpy_score, s.nzdjpy_score] },
    { title: 'Safe Havens',          vals: [s.jpy_score, s.chf_score, s.gold_score] },
    { title: 'USD Liquidity',        vals: [s.usd_score] },
  ];

  el.innerHTML = `
    <div class="sentiment-main">
      <div class="sent-badge-row">
        <div class="sentiment-badge ${sentCls}">${sentLabel}</div>
        <div class="sent-env-badge ${envCls}">${envLabel}</div>
      </div>
      <div class="sentiment-meta">
        <span class="sent-conf-label">Confidence</span>
        <div class="sent-conf-bar-wrap">
          <div class="sent-conf-bar-fill ${sentCls}" style="width:${confPct}%"></div>
        </div>
        <span class="sent-conf-pct">${confPct}%</span>
      </div>
      <div class="sentiment-net">
        Net <span class="sent-net-val ${sentCls}">${Number(s.net_score || 0).toFixed(1)}</span>
        <span class="sent-accel ${accelCls}" title="Acceleration: how fast conditions are changing">${accelArrow} ${accel > 0 ? '+' : ''}${accel}</span>
      </div>
    </div>
    <div class="sent-groups-and-chart">
      <div class="sentiment-components">
        ${groups.map(g => {
          const vals   = g.vals.filter(v => v != null).map(Number);
          const allOn  = vals.length >= 2 && vals.every(v => v >= 5);
          const allOff = vals.length >= 2 && vals.every(v => v <= -5);
          const badge  = allOn  ? '<span class="sent-align-badge risk-on">↑ ALIGNED</span>'
                       : allOff ? '<span class="sent-align-badge risk-off">↓ ALIGNED</span>'
                       : vals.length === 1 ? ''
                       : '<span class="sent-align-badge not-aligned">✕ NOT ALIGNED</span>';
          const sum    = vals.reduce((a, b) => a + b, 0);
          const sumStr = (sum > 0 ? '+' : '') + sum.toFixed(0);
          const sumCls = sum > 5 ? 'risk-on' : sum < -5 ? 'risk-off' : 'neutral';
          return `
            <div class="sent-group-row">
              <div class="sent-group-header">${g.title}${badge}</div>
              <span class="sent-group-sum ${sumCls}">${sumStr}</span>
            </div>`;
        }).join('')}
      </div>
      ${sentimentDonutHtml(groups)}
    </div>
    <div class="sentiment-time">${fmtTime(s.time)}</div>`;
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

// ─── Journal sentiment groups (collapsed — no individual components) ──────────

function journalSentimentGroupsHtml(d) {
  if (!d) return '';
  const groups = [
    { title: 'Growth / Risk Assets', vals: [d.equity_score, d.oil_score] },
    { title: 'Carry / Risk FX',      vals: [d.audjpy_score, d.nzdjpy_score] },
    { title: 'Safe Havens',          vals: [d.jpy_score, d.chf_score, d.gold_score] },
    { title: 'USD Liquidity',        vals: [d.usd_score] },
  ];
  return `
    <div class="jrn-sent-groups">
      ${groups.map(g => {
        const vals   = g.vals.filter(v => v != null).map(Number);
        const allOn  = vals.length >= 2 && vals.every(v => v >= 5);
        const allOff = vals.length >= 2 && vals.every(v => v <= -5);
        const badge  = allOn  ? '<span class="sent-align-badge risk-on">↑ ALIGNED</span>'
                     : allOff ? '<span class="sent-align-badge risk-off">↓ ALIGNED</span>'
                     : vals.length === 1 ? ''
                     : '<span class="sent-align-badge not-aligned">✕ NOT ALIGNED</span>';
        const sum    = vals.reduce((a, b) => a + b, 0);
        const sumStr = (sum > 0 ? '+' : '') + sum.toFixed(0);
        const sumCls = sum > 5 ? 'risk-on' : sum < -5 ? 'risk-off' : 'neutral';
        return `
          <div class="sent-group-row">
            <div class="sent-group-header">${g.title}${badge}</div>
            <span class="sent-group-sum ${sumCls}">${sumStr}</span>
          </div>`;
      }).join('')}
    </div>`;
}

// ─── Market Journal ───────────────────────────────────────────────────────────

function renderJournal(data) {
  const el = document.getElementById('journal-list');
  if (!el) return;
  const entries = data?.entries || [];
  if (!entries.length) {
    el.innerHTML = '<p class="empty-state">No journal entries yet — runs after first hourly update</p>';
    return;
  }

  el.innerHTML = entries.map(e => {
    const sentCls  = e.risk_sentiment === 'RISK_ON'  ? 'risk-on'
                   : e.risk_sentiment === 'RISK_OFF' ? 'risk-off'
                   : 'neutral';
    const sessCls  = (e.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
    const topSetups = (e.top_setups || []).slice(0, 3);
    const signals   = e.signals_summary || {};
    const enteredCount = (signals.entered || []).length;

    // Outcome windows
    const outcomes = [
      { key: 'outcome_6h',  label: '6H',  data: e.outcome_6h  },
      { key: 'outcome_12h', label: '12H', data: e.outcome_12h },
      { key: 'outcome_24h', label: '24H', data: e.outcome_24h },
    ];

    const outcomeHtml = outcomes.map(o => {
      if (!o.data) return `<span class="jrn-outcome-pill pending" title="${o.label} outcome pending">⏳ ${o.label}</span>`;
      const score = o.data.accuracy_score;
      const scoreCls = score >= 70 ? 'good' : score >= 40 ? 'mid' : 'bad';
      const correct = o.data.correct_count ?? 0;
      const total   = o.data.total_setups  ?? 0;
      return `
        <span class="jrn-outcome-pill ${scoreCls}" title="${o.data.verdict || ''}" onclick="openJournalOutcome('${e.id}','${o.key}')">
          ${o.label} · ${correct}/${total} · ${score ?? '—'}%
        </span>`;
    }).join('');

    return `
      <div class="jrn-entry" id="jrn-${e.id}">
        <div class="jrn-header" onclick="toggleJournalEntry('${e.id}')">
          <span class="jrn-time">${fmtTime(e.time)}</span>
          <span class="sess-card-badge sq-${sessCls}" style="font-size:9px">${e.session_name || '—'}</span>
          <span class="jrn-sent sent-${sentCls}">${(e.risk_sentiment || '—').replace('_',' ')}</span>
          <span class="jrn-conf">${e.risk_confidence ?? '—'}%</span>
          <div class="jrn-counts">
            <span class="jrn-count trend" title="Trend">${e.trend_pairs}T</span>
            <span class="jrn-count pb"    title="Pullback">${e.pullback_pairs}PB</span>
            <span class="jrn-count ready" title="Ready">${e.ready_pairs}R</span>
            ${enteredCount ? `<span class="jrn-count sig" title="Signals">${enteredCount}✦</span>` : ''}
          </div>
          <div class="jrn-outcomes">${outcomeHtml}</div>
          <span class="jrn-chevron">›</span>
        </div>

        <div class="jrn-body" id="jrn-body-${e.id}" style="display:none">
          <div class="jrn-summary">${e.summary || ''}</div>
          ${journalSentimentGroupsHtml(e.risk_sentiment_details)}

          ${topSetups.length ? `
          <div class="jrn-setups">
            ${topSetups.map(s => {
              const dir = s.bias === 'BUY' ? 'buy' : 'sell';
              return `
                <div class="jrn-setup-row">
                  <span class="jrn-setup-pair">${pair(s.instrument)}</span>
                  <span class="signal-dir ${dir}" style="font-size:9px">${s.bias}</span>
                  <span class="jrn-setup-state">${(s.state||'').replace(/_/g,' ')}</span>
                  <span class="jrn-setup-conf">${s.confidence}%</span>
                </div>`;
            }).join('')}
          </div>` : ''}

          ${outcomes.filter(o => o.data).map(o => {
            const d = o.data;
            const scoreCls = (d.accuracy_score ?? 0) >= 70 ? 'good' : (d.accuracy_score ?? 0) >= 40 ? 'mid' : 'bad';
            return `
              <div class="jrn-outcome-block">
                <div class="jrn-outcome-header">
                  <span class="jrn-outcome-label">${o.label} Outcome</span>
                  <span class="jrn-outcome-score ${scoreCls}">${d.accuracy_score ?? '—'}%</span>
                  <span class="jrn-outcome-tally">${d.correct_count ?? 0} correct · ${d.incorrect_count ?? 0} wrong · ${d.flat_count ?? 0} flat</span>
                </div>
                ${d.verdict ? `<div class="jrn-verdict">${d.verdict}</div>` : ''}
                ${d.sentiment_assessment ? `<div class="jrn-sent-assess">Sentiment: ${d.sentiment_assessment}</div>` : ''}
                ${(d.setups || []).map(s => {
                  const oCls = s.outcome === 'CORRECT' ? 'correct' : s.outcome === 'INCORRECT' ? 'wrong' : 'flat';
                  const oIcon = s.outcome === 'CORRECT' ? '✓' : s.outcome === 'INCORRECT' ? '✕' : '→';
                  return `<div class="jrn-setup-outcome ${oCls}">
                    ${oIcon} ${pair(s.instrument)} ${s.bias} · ${(s.outcome||'').replace(/_/g,' ')}
                  </div>`;
                }).join('')}
              </div>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');
}

function toggleJournalEntry(id) {
  const body = document.getElementById(`jrn-body-${id}`);
  const entry = document.getElementById(`jrn-${id}`);
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  entry.classList.toggle('open', !open);
}

function openJournalOutcome(id, key) {
  // Stop propagation from pill click opening the full entry too
  event.stopPropagation();
  const body = document.getElementById(`jrn-body-${id}`);
  const entry = document.getElementById(`jrn-${id}`);
  if (body) { body.style.display = 'block'; entry.classList.add('open'); }
}

// ─── Main refresh ─────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const [strength, signals, states, risk, actions, quality, spreads, aiData, sentimentData, sessionData, journalData] = await Promise.all([
      api('/api/strength'),
      api('/api/signals'),
      api('/api/states'),
      api('/api/risk'),
      api('/api/actions'),
      api('/api/quality'),
      api('/api/spreads'),
      api('/api/ai').catch(() => ({ analyses: [] })),
      api('/api/sentiment').catch(() => ({ sentiment: null })),
      api('/api/session').catch(() => ({ session: null })),
      api('/api/journal').catch(() => ({ entries: [] })),
    ]);

    // Build AI map: instrument → analysis
    const aiMap = {};
    (aiData.analyses || []).forEach(a => { aiMap[a.instrument] = a; });
    _aiMap = aiMap;                 // store globally for modal access
    _sentimentData = sentimentData; // store for modal neutral check

    updateHeader(risk);
    renderSession(sessionData);
    renderSentiment(sentimentData);
    renderLiveOpportunities(states.states || [], aiMap, sentimentData);
    renderTopSetups(states.states || [], aiMap, sentimentData);
    renderSignals(signals, states.states || []);
    buildChart(strength, activeTF);
    renderStates(states);
    renderSpreads(spreads);
    renderRisk(risk, sentimentData);
    renderActions(actions);
    renderQuality(quality);
    renderJournal(journalData);

    document.getElementById('status-dot').className = 'status-dot online';
  } catch (err) {
    console.error('Refresh error:', err);
    document.getElementById('status-dot').className = 'status-dot stale';
  }
}

// Boot
refresh();
setInterval(refresh, REFRESH_MS);
