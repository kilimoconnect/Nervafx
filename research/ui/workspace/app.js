/* NervaFX manual-decision workspace — isolated research UI (DEMO/SYNTHETIC).
 * Vanilla JS, no framework. Talks only to NFXAdapter. Every screen is labelled
 * DEMO/SYNTHETIC; no profitability, no confidence probability, no order path. */
(function () {
  'use strict';
  var A = window.NFXAdapter;
  var M15 = 15 * 60 * 1000;
  var S = { ws: null, pairId: null, frameIdx: 0, lookback: 96, view: 'market', error: null };
  var $ = function (id) { return document.getElementById(id); };
  var el = function (sel, root) { return (root || document).querySelector(sel); };

  // ---- helpers ----
  function stateBadge(s) { var c = 'b-mut'; if (/_UP$/.test(s)) c = 'b-up'; else if (/_DOWN$/.test(s)) c = 'b-dn'; else if (s === 'UNAVAILABLE' || s === 'CONFLICT') c = 'b-warn'; return '<span class="badge ' + c + '">' + String(s).replace(/_/g, ' ') + '</span>'; }
  function dirBadge(d) { var c = d === 'UP' ? 'b-up' : d === 'DOWN' ? 'b-dn' : 'b-mut'; return '<span class="badge ' + c + '">' + (d || '—') + '</span>'; }
  function num(x, p) { if (x == null) return '—'; if (Math.abs(x) < 1e-9) return '0'; return (+x).toFixed(p == null ? 5 : p); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function curPair() { return A.getPair(S.ws, S.pairId); }
  function curFrame() { var p = curPair(); if (!p || !p.frames.length) return null; return p.frames[Math.min(S.frameIdx, p.frames.length - 1)]; }

  // ---- time formatters (EAT = UTC+3) ----
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function eatParts(ms) { var d = new Date(ms + 3 * 3600000); return { mo: d.getUTCMonth() + 1, da: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() }; }
  function fmtEatTime(ms) { var e = eatParts(ms); return pad2(e.hh) + ':' + pad2(e.mm); }
  function fmtEatFull(ms) { var e = eatParts(ms); return pad2(e.mo) + '-' + pad2(e.da) + ' ' + pad2(e.hh) + ':' + pad2(e.mm); }

  // ---- canvas candlestick chart (price axis + EAT time axis + crosshair) ----
  function drawChart(canvas, candles, uptoIdx, lookback, events, cross) {
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 600, cssH = canvas.clientHeight || 320;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    var ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    var slice = candles.slice(0, uptoIdx + 1);
    var start = Math.max(0, slice.length - lookback);
    var vis = slice.slice(start);
    if (!vis.length) { ctx.fillStyle = '#94a3b8'; ctx.fillText('no candles', 10, 20); return; }
    var padL = 54, padR = 10, padT = 10, padB = 30;
    var w = cssW - padL - padR, h = cssH - padT - padB;
    var hi = -Infinity, lo = Infinity;
    vis.forEach(function (c) { hi = Math.max(hi, c.high); lo = Math.min(lo, c.low); });
    var rng = (hi - lo) || 1; hi += rng * 0.05; lo -= rng * 0.05; rng = hi - lo;
    var prec = vis[0].close < 20 ? 5 : 3;
    var x = function (i) { return padL + (vis.length === 1 ? w / 2 : i * w / (vis.length - 1)); };
    var y = function (v) { return padT + (hi - v) / rng * h; };
    // horizontal grid + price axis
    ctx.strokeStyle = '#1e2536'; ctx.font = '10px monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (var g = 0; g <= 4; g++) { var gv = hi - rng * g / 4, gy = y(gv); ctx.strokeStyle = '#1e2536'; ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(cssW - padR, gy); ctx.stroke(); ctx.fillStyle = '#94a3b8'; ctx.fillText(gv.toFixed(prec), 4, gy); }
    // x-axis time ticks (EAT)
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var nTicks = Math.min(6, vis.length);
    for (var k = 0; k < nTicks; k++) {
      var ti = nTicks === 1 ? 0 : Math.round(k * (vis.length - 1) / (nTicks - 1));
      var tx = x(ti);
      ctx.strokeStyle = '#1e2536'; ctx.beginPath(); ctx.moveTo(tx, padT + h); ctx.lineTo(tx, padT + h + 3); ctx.stroke();
      ctx.fillStyle = '#94a3b8'; ctx.fillText(fmtEatTime(vis[ti].openMs), tx, padT + h + 6);
    }
    ctx.textAlign = 'right'; ctx.fillStyle = '#64748b'; ctx.fillText('EAT', cssW - padR, padT + h + 6);
    // candles
    var cw = Math.max(1, Math.min(10, w / vis.length * 0.65));
    vis.forEach(function (c, i) {
      var up = c.close >= c.open, col = up ? '#16c784' : '#f6465d';
      ctx.strokeStyle = col; ctx.fillStyle = col;
      var cx = x(i);
      ctx.beginPath(); ctx.moveTo(cx, y(c.high)); ctx.lineTo(cx, y(c.low)); ctx.stroke();
      var oy = y(c.open), cyy = y(c.close); var top = Math.min(oy, cyy), bh = Math.max(1, Math.abs(cyy - oy));
      ctx.fillRect(cx - cw / 2, top, cw, bh);
    });
    // event markers — small glyphs at the TOP edge only (no full-height lines)
    (events || []).forEach(function (ev) {
      var idx = Math.round((ev.ms - M15 - candles[0].openMs) / M15);
      if (idx < start || idx > uptoIdx) return;
      var mcol = ev.type === 'REVERSAL' ? '#a5b4fc' : ev.type === 'REJECTION' ? '#ca8a04' : ev.type === 'DEPARTURE_ACCEPTED' ? '#3b82f6' : null;
      if (!mcol) return;
      var mx = x(idx - start);
      ctx.fillStyle = mcol; ctx.beginPath(); ctx.moveTo(mx, padT + 7); ctx.lineTo(mx - 3, padT + 1); ctx.lineTo(mx + 3, padT + 1); ctx.closePath(); ctx.fill();
    });
    // crosshair + readout
    if (cross) {
      var hx = Math.max(padL, Math.min(padL + w, cross.x));
      var hy = Math.max(padT, Math.min(padT + h, cross.y));
      var rel = w ? (hx - padL) / w : 0; var ci = Math.max(0, Math.min(vis.length - 1, Math.round(rel * (vis.length - 1))));
      var c2 = vis[ci]; var gx = x(ci);
      ctx.save();
      ctx.strokeStyle = 'rgba(148,163,184,0.55)'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(gx, padT); ctx.lineTo(gx, padT + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, hy); ctx.lineTo(padL + w, hy); ctx.stroke(); ctx.setLineDash([]);
      var price = hi - (hy - padT) / h * rng;
      ctx.fillStyle = '#3b82f6'; ctx.fillRect(0, hy - 8, padL - 2, 16); ctx.fillStyle = '#fff'; ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(price.toFixed(prec), 3, hy);
      var tl = fmtEatTime(c2.openMs); ctx.textAlign = 'center'; var tw = ctx.measureText(tl).width + 8;
      ctx.fillStyle = '#3b82f6'; ctx.fillRect(gx - tw / 2, padT + h + 1, tw, 13); ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'; ctx.fillText(tl, gx, padT + h + 3);
      var lines = [fmtEatFull(c2.openMs) + ' EAT', 'O ' + c2.open.toFixed(prec) + '  H ' + c2.high.toFixed(prec), 'L ' + c2.low.toFixed(prec) + '  C ' + c2.close.toFixed(prec)];
      ctx.font = '11px system-ui'; var bw = 0; lines.forEach(function (l) { bw = Math.max(bw, ctx.measureText(l).width); }); bw += 12; var bhh = lines.length * 14 + 8;
      var bx = (gx + 12 + bw > cssW - padR) ? gx - 12 - bw : gx + 12; if (bx < padL) bx = padL; var by = padT + 4;
      ctx.fillStyle = 'rgba(13,17,23,0.95)'; ctx.strokeStyle = '#2a3148'; ctx.fillRect(bx, by, bw, bhh); ctx.strokeRect(bx, by, bw, bhh);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach(function (l, k2) { ctx.fillStyle = k2 === 0 ? '#94a3b8' : '#e6edf6'; ctx.fillText(l, bx + 6, by + 5 + k2 * 14); });
      ctx.restore();
    }
  }

  // ---- window matrix (always shows ALL four windows, independent of chart lookback) ----
  function windowMatrix(f) {
    var str = f.strengthBoard ? '' : null;
    var rows = [['12h', f.priceStories.h12], ['24h', f.priceStories.h24], ['36h', f.priceStories.h36], ['48h', f.priceStories.h48]].map(function (r) {
      var s = r[1]; if (!s) return '<tr><td>' + r[0] + '</td><td class="mut">—</td><td>—</td><td>—</td><td>—</td></tr>';
      var cls = s.efficiency < 0 ? 'neg' : (s.efficiency > 0 ? 'pos' : '');
      return '<tr><td>' + r[0] + '</td><td>' + s.coveragePct + '% (' + s.actual + '/' + s.nominal + ')</td><td class="num ' + cls + '">' + num(s.efficiency, 2) + '</td><td>' + s.direction + '</td><td class="num">' + num(s.range) + '</td></tr>';
    }).join('');
    var sg = f.strengthBoard && f.otherPairConfirmation ? ('Strength (24h network): gap <b class="num">' + num(f.otherPairConfirmation.full) + '</b>, other-pair confirmation ' + (f.otherPairConfirmation.agrees ? '<span class="badge b-up">AGREES</span>' : '<span class="badge b-mut">no</span>')) : '<span class="mut">strength unavailable</span>';
    return '<table class="matrix"><thead><tr><th>Window</th><th>Coverage</th><th>Price eff</th><th>Dir</th><th>Range</th></tr></thead><tbody>' + rows + '</tbody></table><div class="mut" style="margin-top:6px;font-size:12px">' + sg + '</div>';
  }

  function strengthBoardHtml(f) {
    var sw = f.strengthByWindow || {};
    var order = f.strengthBoard ? f.strengthBoard.map(function (c) { return c.currency; })
      : (sw.h24 ? Object.keys(sw.h24) : (sw.h48 ? Object.keys(sw.h48) : (sw.h12 ? Object.keys(sw.h12) : [])));
    if (!order.length) return '<div class="mut">network unavailable</div>';
    var breadth = {}; (f.strengthBoard || []).forEach(function (c) { breadth[c.currency] = c.breadth; });
    var cell = function (k, c) { var v = sw[k] ? sw[k][c] : null; if (v == null) return '<td class="mut">—</td>'; var cl = v > 0 ? 'pos' : (v < 0 ? 'neg' : ''); return '<td class="num ' + cl + '">' + num(v) + '</td>'; };
    var rows = order.map(function (c) {
      return '<tr><td><b>' + c + '</b></td>' + cell('h12', c) + cell('h24', c) + cell('h36', c) + cell('h48', c) +
        '<td>' + (breadth[c] != null ? Math.round(breadth[c] * 100) + '%' : '—') + '</td></tr>';
    }).join('');
    return '<table class="matrix"><thead><tr><th>Ccy</th><th>12h</th><th>24h</th><th>36h</th><th>48h</th><th>Breadth</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="mut" style="margin-top:4px;font-size:11px">x = relative, zero-sum currency strength per window (ranked by 24h). Breadth = share of the currency’s pairs agreeing (24h).</div>';
  }

  function evidenceHtml(f) {
    var ff = (f.evidenceFor || []).map(function (t) { return '<div class="ev evF">+ ' + esc(t) + '</div>'; }).join('') || '<div class="mut ev">none</div>';
    var aa = (f.evidenceAgainst || []).map(function (t) { return '<div class="ev evA">− ' + esc(t) + '</div>'; }).join('') || '<div class="mut ev">none</div>';
    return '<div><b class="evF">Supporting</b>' + ff + '</div><div style="margin-top:6px"><b class="evA">Opposing</b>' + aa + '</div>';
  }

  function eventSeqHtml(f) {
    if (!f.events || !f.events.length) return '<div class="mut">no events at/ before this close</div>';
    return '<div class="evseq">' + f.events.map(function (e) { return '<div><span class="mut num">' + e.utc.slice(5, 16).replace('T', ' ') + '</span> · <b>' + e.type + '</b> — ' + esc(e.evidence) + '</div>'; }).join('') + '</div>';
  }

  function nextCondHtml(f) {
    var inval = f.invalidationReference ? (esc(f.invalidationReference) + (f.invalidationLevel != null ? ' <span class="mut">(ref level ' + num(f.invalidationLevel) + ')</span>' : '')) : '<span class="mut">—</span>';
    return '<div class="kv"><span>Next condition</span><b style="text-align:right;max-width:70%">' + esc(f.nextCondition) + '</b></div><div class="kv"><span>Invalidation reference</span><b style="text-align:right;max-width:70%">' + inval + '</b></div><div class="mut" style="margin-top:6px;font-size:11.5px">Structure clarity is not an entry trigger. Entry eligibility (sizing, costs, timing) is a separate, currently UNAVAILABLE contract — never read this as "trade now".</div>';
  }

  // ---- state banners ----
  function banners(f) {
    var out = '';
    if (S.error) return '<div class="state-banner sb-error" role="alert">ERROR — ' + esc(S.error) + ' · No data is fabricated in this state.</div>';
    if (!f) return '';
    if (!f.dataHealth.available) out += '<div class="state-banner sb-unavail" role="alert">UNAVAILABLE — ' + esc(f.dataHealth.reason) + '. No classification is shown; nothing is filled forward.</div>';
    if (f.dataHealth.closedMarket) out += '<div class="state-banner sb-closed">CLOSED MARKET — this close falls in the weekend window (Fri 21:00 → Sun 21:00 UTC). Not a current opportunity.</div>';
    if (f.dataHealth.stale) out += '<div class="state-banner sb-stale">STALE — a data gap precedes this close. Treat readings with caution.</div>';
    if (f.primaryState === 'CONFLICT') out += '<div class="state-banner sb-conflict">CONFLICT — price direction and other-pair strength disagree. No single read.</div>';
    if (f.extendedMove) out += '<div class="state-banner sb-extended">EXTENDED MOVE — a long one-way run; later entries carry more adverse-excursion risk (descriptive only).</div>';
    return out;
  }

  // ---- views ----
  function viewMarket(f) {
    var rows = S.ws.watchlist.map(function (w) {
      var lf = w.frames[w.frames.length - 1];
      var gap = lf.otherPairConfirmation ? num(lf.otherPairConfirmation.full) : '—';
      var sel = w.pair === S.pairId;
      return '<tr class="rowbtn" role="row" tabindex="0" aria-selected="' + sel + '" data-pair="' + w.pair + '"><td><b>' + w.pair.replace('_', '/') + '</b><div class="mut" style="font-size:11px">' + esc(w.label) + '</div></td><td>' + stateBadge(lf.primaryState) + '</td><td class="num">' + gap + '</td><td>' + (lf.dataHealth.available ? (lf.otherPairConfirmation && lf.otherPairConfirmation.agrees ? '<span class="badge b-up">conf</span>' : '<span class="badge b-mut">—</span>') : '<span class="badge b-warn">' + (lf.dataHealth.reason || 'n/a').split(' ')[0] + '</span>') + '</td></tr>';
    }).join('');
    var watch = '<div class="card"><h2>Watchlist (click a pair)</h2><table role="grid"><thead><tr><th>Pair</th><th>State</th><th>Strength gap</th><th>Other-pair</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    if (!f) return watch;
    var mid = '<div class="card"><h2>' + S.pairId.replace('_', '/') + ' — M15 (as of ' + f.asOfCloseUtc + ')</h2>' +
      '<div class="chartwrap"><canvas id="chart" aria-label="M15 candlestick chart for ' + S.pairId + '"></canvas></div>' +
      lookbackHtml() +
      '<div class="mut" style="font-size:11.5px">Markers: ▲ reversal (pivot), ▮ accepted departure, ▮ rejection. Chart lookback is visual only; window readings below are unaffected.</div></div>' +
      '<div class="card"><h2>Four-window price / strength matrix</h2>' + windowMatrix(f) + '</div>';
    var right = '<div class="card"><h2>State & next condition</h2><div class="verdict">' + stateBadge(f.primaryState) + '</div>' +
      '<div class="explain" style="margin:8px 0">' + esc(f.explanation) + '</div>' + nextCondHtml(f) + '</div>' +
      '<div class="card"><h2>Supporting / opposing evidence</h2>' + evidenceHtml(f) + '</div>' +
      '<div class="card"><h2>Currency strength by window (12/24/36/48h · 8-ccy network)</h2>' + strengthBoardHtml(f) +
      '<div class="mut" style="margin-top:6px;font-size:11.5px">Leave-one-pair-out is OTHER-PAIR confirmation (this pair excluded) — <b>not</b> statistical independence.</div></div>' +
      decisionFormHtml();
    return watch + '<div class="grid-main"><div>' + mid + '</div><div>' + right + '</div></div>';
  }

  function viewDetail(f) {
    if (!f) return '<div class="card mut">Select a pair.</div>';
    var cmp = f.compare12 ? ('<div class="kv"><span>Latest 12h</span>' + dirBadge(f.compare12.latestDir) + ' <span class="num">eff ' + num(f.compare12.latestEff, 2) + '</span></div><div class="kv"><span>Preceding 12h</span>' + dirBadge(f.compare12.previousDir) + ' <span class="num">eff ' + num(f.compare12.previousEff, 2) + '</span></div><div class="kv"><span>Δ efficiency</span><b class="num">' + num(f.compare12.deltaEff, 2) + '</b></div>') : '<span class="mut">—</span>';
    return '<div class="grid-main"><div>' +
      '<div class="card"><h2>' + S.pairId.replace('_', '/') + ' — M15 chart</h2><div class="chartwrap"><canvas id="chart" aria-label="M15 chart"></canvas></div>' + lookbackHtml() + '<div class="mut" style="font-size:11.5px">Changing the chart lookback does not change any window reading below.</div></div>' +
      '<div class="card"><h2>Four-window matrix (unaffected by chart lookback)</h2>' + windowMatrix(f) + '</div>' +
      '</div><div>' +
      '<div class="card"><h2>Latest vs preceding 12h</h2>' + cmp + '</div>' +
      '<div class="card"><h2>Currency strength by window (12/24/36/48h)</h2>' + strengthBoardHtml(f) + '</div>' +
      '<div class="card"><h2>Causal price-event chronology (as of ' + f.asOfCloseUtc + ')</h2>' + eventSeqHtml(f) + '</div>' +
      '</div></div>';
  }

  function viewReplay(f) {
    if (!f) return '<div class="card mut">Select a pair.</div>';
    return '<div class="card"><h2>Replay — stepping one completed candle at a time</h2><div class="mut" style="font-size:12px">All views below are synchronized to the selected close; events and swing confirmations after it are hidden. Use ◀ ▶ (or arrow keys) to step.</div></div>' +
      '<div class="grid-main"><div>' +
      '<div class="card"><h2>M15 (as of ' + f.asOfCloseUtc + ' · ' + f.asOfCloseEat + ')</h2><div class="chartwrap"><canvas id="chart" aria-label="M15 replay chart"></canvas></div>' + lookbackHtml() + '</div>' +
      '<div class="card"><h2>Four-window matrix</h2>' + windowMatrix(f) + '</div>' +
      '</div><div>' +
      '<div class="card"><h2>State</h2><div class="verdict">' + stateBadge(f.primaryState) + '</div><div class="mut" style="margin-top:4px">prev: ' + (f.previousState || '—') + ' · transition: ' + (f.transition && f.transition.changed ? f.transition.kind : 'none') + '</div><div class="explain" style="margin-top:8px">' + esc(f.explanation) + '</div></div>' +
      '<div class="card"><h2>Events revealed so far</h2>' + eventSeqHtml(f) + '</div>' +
      '</div></div>';
  }

  function viewJournal() {
    var items = readJournal();
    var list = items.length ? items.map(function (e, i) {
      return '<div class="card"><div class="kv"><span><b>' + esc(e.pair) + '</b> · ' + esc(e.state) + '</span><button class="btn sm" data-del="' + i + '">Delete</button></div>' +
        '<div class="mut" style="font-size:12px">Close ' + esc(e.closeUtc) + ' · classifier ' + esc(e.version) + ' · saved ' + esc(e.savedAt) + '</div>' +
        '<div style="margin-top:6px"><b>Bias note:</b> ' + (esc(e.note) || '<span class="mut">(none)</span>') + '</div>' +
        '<div class="mut" style="font-size:12px;margin-top:4px">Next: ' + esc(e.nextCondition) + '<br>Invalidation: ' + esc(e.invalidationReference || '—') + (e.invalidationLevel != null ? ' (ref ' + num(e.invalidationLevel) + ')' : '') + '</div>' +
        '<div style="margin-top:4px;font-size:12px"><b>Evidence snapshot (pre-outcome):</b><br>' + (e.evidenceFor || []).map(function (t) { return '<span class="evF">+ ' + esc(t) + '</span>'; }).join('<br>') + '</div>' +
        '</div>';
    }).join('') : '<div class="card mut">No saved decisions yet. Record one from Market Review.</div>';
    return '<div class="card"><h2>Decision journal</h2><div class="mut" style="font-size:12px">Each entry is a snapshot of the evidence <b>before any outcome</b> — no outcome or P&L is tracked or implied.</div>' + persistenceStatus() + '</div>' + list;
  }

  function viewHealth(f) {
    var m = S.ws.modelHealth;
    var ic = m.infocontent;
    var dh = f ? f.dataHealth : null;
    return '<div class="card"><h2>Model status</h2><div class="verdict" style="color:var(--yellow)">' + m.status + '</div>' +
      '<div class="mut" style="margin-top:6px">This classifier is a <b>description</b>, not a validated edge. No profitability, win-rate, or confidence probability is shown anywhere in this UI.</div></div>' +
      '<div class="card"><h2>Preserved research verdicts (immutable)</h2>' +
      '<div class="kv"><span>Stage 5 / 5A</span><b>' + m.stage5.decision + '</b></div>' +
      '<div class="kv"><span>Info-content H1 / H2 / H3</span><b>' + ic.verdicts.H1 + ' / ' + ic.verdicts.H2 + ' / ' + ic.verdicts.H3 + '</b></div>' +
      '<div class="kv"><span>Economics</span><b>' + ic.economics + '</b></div>' +
      '<div class="kv"><span>Pre-registration hash</span><b class="num" style="font-size:11px">' + ic.registrationHash.slice(0, 24) + '…</b></div>' +
      '<div class="mut" style="margin-top:6px;font-size:12px">' + esc(ic.note) + '</div></div>' +
      '<div class="card"><h2>Data health (selected pair / close)</h2>' + (dh ? (
        '<div class="kv"><span>Availability</span>' + (dh.available ? '<span class="badge b-up">AVAILABLE</span>' : '<span class="badge b-warn">UNAVAILABLE · ' + esc(dh.reason) + '</span>') + '</div>' +
        '<div class="kv"><span>28-pair coverage</span><b>' + dh.pairsPresent + '/' + dh.pairsExpected + (dh.aligned ? ' (aligned)' : '') + '</b></div>' +
        '<div class="kv"><span>Freshness</span>' + (dh.stale ? '<span class="badge b-warn">STALE</span>' : '<span class="badge b-up">fresh gap-free</span>') + '</div>' +
        '<div class="kv"><span>Market</span>' + (dh.closedMarket ? '<span class="badge b-mut">CLOSED</span>' : '<span class="badge b-up">open</span>') + '</div>'
      ) : '<span class="mut">—</span>') + '</div>';
  }

  function viewPlan() {
    return '<div class="card"><h2>Manual plan &amp; risk</h2>' +
      '<div class="state-banner sb-unavail" role="status">UNAVAILABLE — no plan/risk data contract.</div>' +
      '<p class="mut" style="font-size:13px">Position sizing, currency conversion, spread/commission costs and shared-currency exposure require an <b>account + instrument + live cost</b> contract that this isolated research UI does not have (candles here are mid-only, SYNTHETIC). Rather than fabricate numbers, this page stays unavailable.</p>' +
      '<p class="mut" style="font-size:13px">Confirmed price structure does <b>not</b> establish entry eligibility. Shared-currency exposure would be shown only when real plan/position inputs exist.</p>' +
      '</div>';
  }

  // ---- decision form + journal persistence ----
  function decisionFormHtml() {
    return '<div class="card"><h2>Record decision (pre-outcome snapshot)</h2>' +
      '<label class="sr-only" for="dnote">Bias note</label><textarea id="dnote" rows="2" placeholder="Your read / bias note (optional)"></textarea>' +
      '<div style="margin-top:8px"><button class="btn" id="recordBtn">Record decision to journal</button> <span class="mut" id="recordMsg" style="font-size:12px"></span></div>' +
      '<div class="mut" style="margin-top:6px;font-size:11.5px">Saves the current close timestamp, classifier version, state and evidence snapshot — before any outcome. No buy/sell is implied.</div></div>';
  }
  function readJournal() { try { return JSON.parse(localStorage.getItem('nfx_ws_journal') || '[]'); } catch (e) { return []; } }
  function writeJournal(items) { try { localStorage.setItem('nfx_ws_journal', JSON.stringify(items)); return true; } catch (e) { return false; } }
  function persistenceStatus() {
    var ok = false; try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); ok = true; } catch (e) { ok = false; }
    return '<div class="mut" style="font-size:12px;margin-top:4px">Persistence: ' + (ok ? 'saved in <b>this browser only</b> (localStorage) — not synced to any server; cleared if you clear site data.' : '<span class="neg">localStorage unavailable — entries will NOT persist.</span>') + '</div>';
  }
  function recordDecision() {
    var f = curFrame(); if (!f) return;
    var note = (($('dnote') || {}).value || '').trim();
    var entry = { pair: S.pairId, closeUtc: f.asOfCloseUtc, closeMs: f.asOfCloseMs, version: f.calibrationVersion || (S.ws.meta.classifier), state: f.primaryState, evidenceFor: f.evidenceFor, evidenceAgainst: f.evidenceAgainst, nextCondition: f.nextCondition, invalidationReference: f.invalidationReference, invalidationLevel: f.invalidationLevel, note: note, savedAt: new Date().toISOString(), provenance: 'SYNTHETIC' };
    var items = readJournal(); items.unshift(entry); var ok = writeJournal(items);
    var msg = $('recordMsg'); if (msg) msg.textContent = ok ? 'Saved locally ✓' : 'Could not save (storage unavailable)';
  }

  // ---- replay / lookback controls ----
  function lookbackHtml() {
    return '<div class="lookback"><span>Chart lookback:</span>' + [48, 96, 144, 192].map(function (n) { return '<button class="btn sm" data-lb="' + n + '" aria-pressed="' + (S.lookback === n) + '">' + (n / 4) + 'h</button>'; }).join('') + '</div>';
  }

  // ---- render ----
  function render() {
    var p = curPair(); var f = S.error ? null : curFrame();
    // header data
    var hdr = $('datahdr');
    if (S.error) hdr.innerHTML = '<span class="neg">Adapter error — see banner.</span>';
    else if (f) {
      var fresh = f.dataHealth.stale ? '<span class="badge b-warn">STALE</span>' : (f.dataHealth.closedMarket ? '<span class="badge b-mut">CLOSED</span>' : '<span class="badge b-up">OK</span>');
      hdr.innerHTML = 'Pair: <b>' + S.pairId.replace('_', '/') + '</b>' +
        ' · Close UTC: <b>' + f.asOfCloseUtc + '</b> · EAT: <b>' + f.asOfCloseEat + '</b>' +
        ' · Data: ' + fresh + ' · Coverage: <b>' + f.dataHealth.pairsPresent + '/' + f.dataHealth.pairsExpected + '</b>' +
        (S.frameIdx >= p.frames.length - 1 ? ' · <span class="pill">latest</span>' : ' · <span class="pill warn">replay</span>');
    } else hdr.innerHTML = '<span class="mut">no data</span>';

    $('banners').innerHTML = banners(f);

    // replay bar position
    if (p) { var sc = $('scrub'); sc.max = p.frames.length - 1; sc.value = S.frameIdx; $('pos').textContent = 'frame ' + (S.frameIdx + 1) + ' / ' + p.frames.length; }
    var psel2 = $('pairsel'); if (psel2 && psel2.value !== S.pairId) psel2.value = S.pairId;   // keep in sync with ↑↓ / clicks

    var host = $('viewhost');
    if (S.error) { host.innerHTML = '<div class="card">Nothing is shown while the adapter is in an error state (no fabricated fallback). Toggle the error off to continue.</div>'; }
    else if (S.view === 'market') host.innerHTML = viewMarket(f);
    else if (S.view === 'detail') host.innerHTML = viewDetail(f);
    else if (S.view === 'replay') host.innerHTML = viewReplay(f);
    else if (S.view === 'journal') host.innerHTML = viewJournal();
    else if (S.view === 'health') host.innerHTML = viewHealth(f);
    else if (S.view === 'plan') host.innerHTML = viewPlan();

    // post-render wiring
    var canvas = $('chart');
    if (canvas && p && f) {
      var redraw = function (cross) { drawChart(canvas, p.candles, f.candleIdx, S.lookback, f.events, cross); };
      redraw();
      var at = function (e) { var r = canvas.getBoundingClientRect(); var pt = (e.touches && e.touches[0]) || e; return { x: pt.clientX - r.left, y: pt.clientY - r.top }; };
      canvas.onmousemove = function (e) { redraw(at(e)); };
      canvas.onmouseleave = function () { redraw(); };
      canvas.ontouchstart = canvas.ontouchmove = function (e) { redraw(at(e)); };
      canvas.ontouchend = function () { redraw(); };
    }
    wireDynamic();
    // tab aria
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (b) { b.setAttribute('aria-selected', b.getAttribute('data-view') === S.view); });
  }

  function wireDynamic() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-pair]'), function (r) {
      r.onclick = function () { selectPair(r.getAttribute('data-pair')); };
      r.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPair(r.getAttribute('data-pair')); } };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-lb]'), function (b) { b.onclick = function () { S.lookback = +b.getAttribute('data-lb'); render(); }; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (b) { b.onclick = function () { var it = readJournal(); it.splice(+b.getAttribute('data-del'), 1); writeJournal(it); render(); }; });
    var rec = $('recordBtn'); if (rec) rec.onclick = recordDecision;
  }

  function selectPair(id) { S.pairId = id; var p = curPair(); S.frameIdx = p ? p.frames.length - 1 : 0; render(); }
  function setView(v) { S.view = v; render(); }
  function step(d) { var p = curPair(); if (!p) return; S.frameIdx = Math.max(0, Math.min(p.frames.length - 1, S.frameIdx + d)); render(); }

  // ---- init ----
  function init() {
    try { S.ws = A.getWorkspace(); }
    catch (e) { S.error = e.message; render(); return; }
    S.pairId = S.ws.watchlist[0].pair; var p = curPair(); S.frameIdx = p.frames.length - 1;
    $('metaver').textContent = S.ws.meta.version + ' · ' + S.ws.meta.classifier;
    // pair selector (always visible; works from any view)
    var psel = $('pairsel');
    if (psel) { psel.innerHTML = S.ws.watchlist.map(function (w) { return '<option value="' + w.pair + '">' + w.pair.replace('_', '/') + '</option>'; }).join(''); psel.value = S.pairId; psel.onchange = function () { selectPair(psel.value); }; }
    // tabs
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabs button'), function (b) { b.onclick = function () { setView(b.getAttribute('data-view')); }; });
    // replay controls
    $('first').onclick = function () { S.frameIdx = 0; render(); };
    $('prev').onclick = function () { step(-1); };
    $('next').onclick = function () { step(1); };
    $('last').onclick = function () { var pp = curPair(); S.frameIdx = pp.frames.length - 1; render(); };
    $('scrub').oninput = function () { S.frameIdx = +this.value; render(); };
    var et = $('errtoggle'); if (et) et.onclick = function () { A.setForceError(!A.getForceError()); try { S.ws = A.getWorkspace(); S.error = null; } catch (e) { S.error = e.message; } et.setAttribute('aria-pressed', A.getForceError()); render(); };
    var rf = $('refreshBtn'); if (rf) rf.onclick = function () { location.reload(); };
    // keyboard
    document.addEventListener('keydown', function (e) {
      if (/input|textarea/i.test((e.target.tagName || ''))) return;
      if (e.key === 'ArrowLeft') { step(-1); } else if (e.key === 'ArrowRight') { step(1); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { var ws = S.ws.watchlist, i = ws.findIndex(function (w) { return w.pair === S.pairId; }); i = (i + (e.key === 'ArrowUp' ? -1 : 1) + ws.length) % ws.length; selectPair(ws[i].pair); e.preventDefault(); }
      else if (/^[1-6]$/.test(e.key)) { setView(['market', 'detail', 'replay', 'journal', 'health', 'plan'][+e.key - 1]); }
    });
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
