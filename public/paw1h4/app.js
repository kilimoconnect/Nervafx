(function () {
  'use strict';
  var J = window.NFX_PAW;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function n(x, d) { return x == null || !isFinite(x) ? '—' : Number(x).toFixed(d == null ? 5 : d); }
  function fmt(iso) { return iso ? String(iso).replace('T', ' ').replace('.000Z', 'Z') : '—'; }

  // timeframe labels (W1/H4 or D1/H1) — one renderer serves both strategies
  var TL = J.trendLabel || 'W1', EL = J.entryLabel || 'H4';
  // ---- header / selector ----
  $('ver').textContent = J.version;
  var psel = $('pairsel');
  psel.innerHTML = (J.pairs || [J.pair]).map(function (p) { return '<option value="' + p + '">' + p.replace('_', '/') + '</option>'; }).join('');
  psel.value = J.pair;
  psel.onchange = function () { var a = (location.search.match(/[?&]asOf=(\d+)/) || [])[1]; location.href = location.pathname + '?pair=' + psel.value + (a ? '&asOf=' + a : ''); };
  $('datahdr').innerHTML = '<b>' + J.pair.replace('_', '/') + '</b> · as of <b>' + fmt(J.asOfUtc) + '</b> (' + esc(J.asOfEat) + ') · mode ' + esc(J.mode) +
    ' · ' + EL + ' ' + J.dataQuality.h4Count + ' · ' + TL + ' ' + J.dataQuality.w1Count + ' (confirmed pivots ' + J.dataQuality.w1Confirmed + ')' +
    (J.dataQuality.warning ? ' · <span class="neg">⚠ ' + esc(J.dataQuality.warning) + '</span>' : '');

  var biasBadge = { BULLISH: 'b-up', BEARISH: 'b-dn', NEUTRAL: 'b-mut', UNAVAILABLE: 'b-warn' };
  var STATE_TXT = {
    UNAVAILABLE: 'Not enough confirmed ' + TL + ' structure.',
    NEUTRAL: TL + ' structure is conflicting — no directional eligibility.',
    WAITING_FOR_PULLBACK: TL + ' trend eligible; waiting for an ' + EL + ' counter-trend pullback (two lower highs + lower lows, or the mirror).',
    PULLBACK_ACTIVE: EL + ' pullback formed; waiting for a completed ' + EL + ' close back through the frozen break level.',
    FIRST_BREAK: 'First break confirmed; waiting for retest structure.',
    WAITING_FOR_RETEST_STRUCTURE: 'After the break: waiting for a new swing in the trend direction, then a higher-low / lower-high above/below the pullback extreme.',
    ARMED: 'Trigger and stop frozen; waiting for a completed ' + EL + ' close beyond the trigger to signal entry.',
    TRIGGERED: 'Continuation close confirmed — a manual opportunity was emitted; entry simulated at the next ' + EL + ' open.',
    CANCELLED: 'Setup cancelled before entry.',
    EXPIRED: 'Setup expired (' + (J.expiryH4Bars || 30) + ' completed ' + EL + ' bars after the first break).',
  };

  function levelRows(arr) { return (arr || []).map(function (p) { return '<tr><td class="num">' + n(p.price) + '</td><td class="mut">' + fmt(p.extremeUtc) + '</td><td class="mut">' + fmt(p.confirmedUtc) + '</td></tr>'; }).join('') || '<tr><td class="mut" colspan="3">none confirmed</td></tr>'; }

  // Side-by-side with the other strategy (if the page supplied window.NFX_CMP for the same pair).
  function renderComparison() {
    var C = window.NFX_CMP; if (!C || C.available === false || !C.weekly) return '';
    var sttf = function (f) { return (f.h4.state || '—') + (f.h4.dir ? ' ' + f.h4.dir : ''); };
    var trf = function (f) { return f.suggestedTrade ? (f.suggestedTrade.dir + ' · R:R ' + f.suggestedTrade.rewardRisk + ':1') : (f.rejection ? ('no trade — ' + f.rejection.reason) : '—'); };
    return '<div class="card"><h2>Strategy comparison — same pair, same close</h2>' +
      '<table><thead><tr><th>Strategy</th><th>Trend bias</th><th>State</th><th>Suggested</th></tr></thead><tbody>' +
      '<tr><td><b>' + esc(J.strategyId) + '</b> <span class="mut">(' + TL + '→' + EL + ')</span></td><td>' + J.weekly.bias + '</td><td>' + esc(sttf(J)) + '</td><td>' + esc(trf(J)) + '</td></tr>' +
      '<tr><td><b>' + esc(C.strategyId) + '</b> <span class="mut">(' + (C.trendLabel || 'W1') + '→' + (C.entryLabel || 'H4') + ')</span></td><td>' + C.weekly.bias + '</td><td>' + esc(sttf(C)) + '</td><td>' + esc(trf(C)) + '</td></tr>' +
      '</tbody></table>' +
      '<div class="mut" style="margin-top:8px;font-size:11px">Both read the SAME ' + esc(J.pair.replace('_', '/')) + ' price (shared currencies ' + esc(J.pair.replace('_', ' & ')) + '), so concurrent signals are <b>not independent confirmation</b> and must not be pooled as if uncorrelated. Compare on the same period and cost assumptions — see the backtest report for separate vs naive-pooled results and overlapping exposure.</div></div>';
  }

  var wk = J.weekly, h4 = J.h4, tr = J.suggestedTrade, rej = J.rejection;
  var weeklyCard = '<div class="card"><h2>' + TL + ' structural trend</h2>' +
    '<div style="margin-bottom:8px"><span class="badge ' + (biasBadge[wk.bias] || 'b-mut') + '">' + wk.bias + '</span></div>' +
    '<div class="kv"><span>Eligibility began</span><span>' + fmt(wk.eligibilityStartUtc) + (wk.eligibilityStartEat ? ' <span class="mut">(' + esc(wk.eligibilityStartEat) + ')</span>' : '') + '</span></div>' +
    '<div class="kv"><span>Invalidation level</span><b class="num">' + n(wk.invalidationLevel) + '</b></div>' +
    '<div class="stmt"><div class="lbl">Last confirmed ' + TL + ' highs</div><table><thead><tr><th>Price</th><th>Extreme</th><th>Confirmed</th></tr></thead><tbody>' + levelRows(wk.lastHighs) + '</tbody></table></div>' +
    '<div class="stmt"><div class="lbl">Last confirmed ' + TL + ' lows</div><table><thead><tr><th>Price</th><th>Extreme</th><th>Confirmed</th></tr></thead><tbody>' + levelRows(wk.lastLows) + '</tbody></table></div>' +
    '</div>';

  var dirBadge = h4.dir === 'BUY' ? '<span class="badge b-up">BUY</span>' : h4.dir === 'SELL' ? '<span class="badge b-dn">SELL</span>' : '';
  var h4Card = '<div class="card"><h2>' + EL + ' continuation state</h2>' +
    '<div style="margin-bottom:8px"><span class="badge b-mut">' + h4.state + '</span> ' + dirBadge + '</div>' +
    '<div class="mut" style="font-size:12px;margin-bottom:8px">' + esc(STATE_TXT[h4.state] || '') + (h4.cancelReason ? ' <span class="neg">(' + esc(h4.cancelReason) + ')</span>' : '') + '</div>' +
    '<div class="kv"><span>Break level (frozen LH/HL)</span><b class="num">' + n(h4.breakLevel) + '</b></div>' +
    '<div class="kv"><span>Pullback extreme (frozen)</span><b class="num">' + n(h4.pullbackExtreme) + '</b></div>' +
    '<div class="kv"><span>First break</span><span>' + fmt(h4.firstBreakUtc) + '</span></div>' +
    '<div class="kv"><span>Continuation trigger</span><b class="num">' + n(h4.trigger) + '</b></div>' +
    '<div class="kv"><span>Stop reference</span><b class="num">' + n(h4.stopRef) + '</b></div>' +
    '<div class="kv"><span>Armed</span><span>' + fmt(h4.armedUtc) + '</span></div>' +
    '<div class="kv"><span>Expiry</span><span>' + J.expiryH4Bars + ' ' + EL + ' bars after first break</span></div>' +
    '</div>';

  var tradeCard = '<div class="card"><h2>Suggested trade (hypothetical, mid-only)</h2>' +
    (tr ? (
      '<div style="margin-bottom:8px">' + (tr.dir === 'BUY' ? '<span class="badge b-up">BUY</span>' : '<span class="badge b-dn">SELL</span>') + '</div>' +
      '<div class="kv"><span>Entry (fill est.)</span><b class="num">' + n(tr.entryFill) + '</b></div>' +
      '<div class="kv"><span>Stop (beyond structure + buffer)</span><b class="num">' + n(tr.stop) + '</b></div>' +
      '<div class="kv"><span>Target (nearest opposing weekly)</span><b class="num">' + n(tr.target) + '</b></div>' +
      '<div class="kv"><span>Risk / Reward</span><span class="num">' + tr.riskPips + 'p / ' + tr.rewardPips + 'p</span></div>' +
      '<div class="kv"><span>Reward : Risk</span><b class="num">' + tr.rewardRisk + ' : 1</b></div>' +
      '<div class="kv"><span>Simulated exit</span><span>' + (tr.exit ? esc(tr.exit.reason) + ' @ ' + fmt(tr.exit.utc) : '—') + (tr.ambiguous ? ' <span class="neg">(stop-first, ambiguous bar)</span>' : '') + '</span></div>' +
      '<div class="kv"><span>Result</span><b class="num ' + (tr.R > 0 ? 'pos' : 'neg') + '">' + n(tr.R, 2) + 'R</b></div>'
    ) : rej ? ('<div class="mut">No qualifying trade — <b>' + esc(rej.reason) + '</b>' + (rej.rewardRisk != null ? ' (R:R ' + rej.rewardRisk + ':1, below ' + 2 + ':1)' : '') + '.</div>')
      : '<div class="mut">No continuation opportunity at this close.</div>') +
    '<div class="mut" style="margin-top:8px;font-size:11px">Hypothetical, mid-only economics with modelled spread/slippage; no order path; UNVALIDATED — no profitability claim.</div></div>';

  var cmpCard = renderComparison();
  $('viewhost').innerHTML =
    '<div id="scanhost"><div class="card mut">Scanning all 28 pairs for the best setups…</div></div>' +
    '<div class="card"><h2>' + TL + ' — trend timeframe (UTC-anchored)</h2><div class="chartwrap"><canvas id="cw"></canvas></div></div>' +
    '<div class="card"><h2>' + EL + ' — entry timeframe · last ' + (J.h4candles || []).length + '</h2><div class="chartwrap"><canvas id="ch"></canvas></div></div>' +
    '<div class="grid">' + weeklyCard + h4Card + '</div>' + tradeCard + cmpCard;

  // ---- charts ----
  function draw(canvasId, candles, levels, pivots) {
    var cv = $(canvasId); if (!cv || !candles || !candles.length) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr;
    var g = cv.getContext('2d'); g.scale(dpr, dpr);
    var padL = 54, padR = 8, padT = 8, padB = 18;
    var lo = Infinity, hi = -Infinity;
    candles.forEach(function (c) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; });
    (levels || []).forEach(function (L) { if (L.price != null && isFinite(L.price)) { if (L.price < lo) lo = L.price; if (L.price > hi) hi = L.price; } });
    if (!(hi > lo)) { hi = lo + 1; }
    var pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    var X = function (i) { return padL + (w - padL - padR) * (i / Math.max(1, candles.length - 1)); };
    var Y = function (p) { return padT + (h - padT - padB) * (1 - (p - lo) / (hi - lo)); };
    g.clearRect(0, 0, w, h);
    // grid + price labels
    g.strokeStyle = 'rgba(42,49,72,.6)'; g.fillStyle = '#94a3b8'; g.font = '10px Inter,sans-serif'; g.lineWidth = 1;
    for (var k = 0; k <= 4; k++) { var pr = lo + (hi - lo) * k / 4, y = Y(pr); g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke(); g.fillText(pr.toFixed(4), 4, y + 3); }
    // candles
    var cw = Math.max(1.5, (w - padL - padR) / candles.length * 0.6);
    candles.forEach(function (c, i) {
      var x = X(i), up = c.c >= c.o, col = c.partial ? '#64748b' : (up ? '#16c784' : '#f6465d');
      g.strokeStyle = col; g.fillStyle = col; g.beginPath(); g.moveTo(x, Y(c.h)); g.lineTo(x, Y(c.l)); g.stroke();
      var yo = Y(c.o), yc = Y(c.c); g.fillRect(x - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo)));
    });
    // pivots
    (pivots || []).forEach(function (p) {
      // place marker at nearest candle by time
      var idx = 0, best = Infinity; candles.forEach(function (c, i) { var d = Math.abs(c.t - p.extremeMs); if (d < best) { best = d; idx = i; } });
      var x = X(idx), y = Y(p.price); g.fillStyle = p.type === 'HIGH' ? '#f6465d' : '#16c784';
      g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill();
    });
    // horizontal frozen levels
    (levels || []).forEach(function (L) {
      if (L.price == null || !isFinite(L.price)) return;
      g.strokeStyle = L.color; g.setLineDash([4, 3]); g.lineWidth = 1.2; var y = Y(L.price);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = L.color; g.fillText(L.label, w - padR - 70, y - 3);
    });
  }

  // ---- multi-pair scan watchlist (filled asynchronously by the page) ----
  function renderScan(scan) {
    var host = $('scanhost'); if (!host) return;
    if (!scan || !scan.length) { host.innerHTML = '<div class="card mut">Scan unavailable.</div>'; return; }
    var cur = (location.search.match(/[?&]pair=([^&]+)/) || [])[1] || J.pair;
    var aArg = (location.search.match(/[?&]asOf=(\d+)/) || [])[1];
    var rows = scan.map(function (s) {
      var badge = { BULLISH: 'b-up', BEARISH: 'b-dn' }[s.bias] || 'b-mut';
      var armed = s.prospect && s.prospect.ok;
      var rr = armed ? '<b class="pos">' + s.prospect.rr + ' : 1</b>' : (s.state === 'ARMED' ? '<span class="mut">no target</span>' : '—');
      var recent = s.last ? (s.last.accepted ? ('<span class="' + ((s.last.R || 0) > 0 ? 'pos' : 'neg') + '">' + (s.last.R != null ? s.last.R.toFixed(2) + 'R' : (s.last.rr + ':1')) + '</span>') : ('<span class="mut">' + esc(s.last.reason || '—') + '</span>')) : '—';
      var dirB = s.dir === 'BUY' ? '<span class="badge b-up">BUY</span>' : s.dir === 'SELL' ? '<span class="badge b-dn">SELL</span>' : '';
      var sel = s.pair === cur ? ' style="background:rgba(59,130,246,.12);cursor:pointer" ' : ' style="cursor:pointer" ';
      return '<tr class="scanrow" data-pair="' + s.pair + '"' + sel + '><td><b>' + s.pair.replace('_', '/') + '</b></td><td><span class="badge ' + badge + '">' + s.bias + '</span></td><td>' + esc(s.state) + (armed ? ' <span class="pos">★</span>' : '') + '</td><td>' + dirB + '</td><td class="num">' + rr + '</td><td class="num">' + recent + '</td></tr>';
    }).join('');
    var nArmed = scan.filter(function (s) { return s.prospect && s.prospect.ok; }).length;
    host.innerHTML = '<div class="card"><h2>Scan — all ' + scan.length + ' pairs · best setups first' + (nArmed ? ' · <span class="pos">' + nArmed + ' ready</span>' : '') + '</h2>' +
      '<table><thead><tr><th>Pair</th><th>' + TL + ' bias</th><th>State</th><th>Dir</th><th>Setup R:R</th><th>Recent</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="mut" style="margin-top:6px;font-size:11px"><span class="pos">★</span> = ARMED with a valid ≥2:1 forward trade (ranked highest). "Setup R:R" is the prospective trigger→target vs trigger→stop for ARMED pairs. "Recent" = the last emitted opportunity\'s result (R) or why it was rejected. Click a pair to open its detail below. UNVALIDATED — no profitability claim.</div></div>';
    Array.prototype.forEach.call(host.querySelectorAll('.scanrow'), function (tr) { tr.onclick = function () { location.href = location.pathname + '?pair=' + tr.getAttribute('data-pair') + (aArg ? '&asOf=' + aArg : ''); }; });
  }
  window.NFX_RENDER_SCAN = renderScan;

  draw('cw', J.w1candles, [{ price: wk.invalidationLevel, color: '#ca8a04', label: 'invalidation' }], J.w1pivots);
  draw('ch', J.h4candles, [
    { price: h4.breakLevel, color: '#3b82f6', label: 'break' },
    { price: h4.pullbackExtreme, color: '#94a3b8', label: 'pullback ext' },
    { price: h4.trigger, color: '#16c784', label: 'trigger' },
    { price: h4.stopRef, color: '#f6465d', label: 'stop ref' },
  ], J.h4pivots);
  window.addEventListener('resize', function () {
    draw('cw', J.w1candles, [{ price: wk.invalidationLevel, color: '#ca8a04', label: 'invalidation' }], J.w1pivots);
    draw('ch', J.h4candles, [{ price: h4.breakLevel, color: '#3b82f6', label: 'break' }, { price: h4.pullbackExtreme, color: '#94a3b8', label: 'pullback ext' }, { price: h4.trigger, color: '#16c784', label: 'trigger' }, { price: h4.stopRef, color: '#f6465d', label: 'stop ref' }], J.h4pivots);
  });
})();
