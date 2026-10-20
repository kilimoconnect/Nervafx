(function () {
  'use strict';
  var J = window.NFX_W1H4;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function pretty(s) { return String(s == null ? '' : s).toLowerCase().replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function num(x, d) { return x == null || !isFinite(x) ? '—' : Number(x).toFixed(d == null ? 5 : d); }
  function fmt(iso) { return iso ? String(iso).replace('T', ' ').replace('.000Z', 'Z') : '—'; }

  // ---- header / selector ----
  $('ver').textContent = J.version;
  var psel = $('pairsel');
  psel.innerHTML = (J.pairs || [J.pair]).map(function (p) { return '<option value="' + p + '">' + p.replace('_', '/') + '</option>'; }).join('');
  psel.value = J.pair;
  psel.onchange = function () { var a = (location.search.match(/[?&]asOf=(\d+)/) || [])[1]; location.href = location.pathname + '?pair=' + psel.value + (a ? '&asOf=' + a : ''); };

  var ctx = J.context, bal = ctx.balance, loc = ctx.location, tr = ctx.trend;
  var biasBadge = { BULLISH: 'b-up', BEARISH: 'b-dn', NEUTRAL: 'b-mut', UNAVAILABLE: 'b-warn' };
  $('datahdr').innerHTML = '<b>' + J.pair.replace('_', '/') + '</b> · as of <b>' + fmt(J.asOfUtc) + '</b> (' + esc(J.asOfEat) + ') · mode ' + esc(J.mode) +
    ' · weekly <span class="badge ' + (biasBadge[tr.bias] || 'b-mut') + '">' + tr.bias + '</span>' +
    ' · ' + (bal && bal.confirmed ? 'balance ' + num(bal.lower) + '–' + num(bal.upper) : 'no established balance') +
    ' · location <b>' + esc(pretty(loc.zone)) + '</b>';

  // ---- state → sort group / colour ----
  var STATE_BADGE = { CONFIRMED: 'b-up', FORMING: 'b-warn', OBJECTIVE_UNAVAILABLE: 'b-mut', INELIGIBLE_ECONOMICS: 'b-mut', NO_SETUP: 'b-mut', CONTEXT_MISSING: 'b-mut', INVALIDATED: 'b-dn' };
  var APPROACH_NAME = { PULLBACK: 'Pullback continuation (legacy)', RANGE_REJECTION: 'Range-boundary rejection', ACCEPTED_BREAKOUT: 'Accepted breakout', FAILED_BREAKOUT: 'Failed breakout' };

  function econHtml(e) {
    if (!e) return '<span class="mut">—</span>';
    if (e.economicEligibility === 'ELIGIBLE') return '<span class="pos">R:R ' + e.rewardRisk + ':1</span> <span class="mut">(' + e.riskPips + 'p risk / ' + e.rewardPips + 'p reward)</span>';
    if (e.economicEligibility === 'UNAVAILABLE') return '<span class="mut">economics unavailable — ' + esc(e.reason || '') + '</span>';
    return '<span class="neg">ineligible — ' + esc(e.reason || '') + '</span>';
  }

  function candidateCard(c) {
    var dirB = c.dir === 'BUY' ? '<span class="badge b-up">BUY</span>' : c.dir === 'SELL' ? '<span class="badge b-dn">SELL</span>' : '<span class="badge b-mut">—</span>';
    var rows = '';
    if (c.reference) rows += '<div class="kv"><span>Reference</span><span>' + esc(c.reference.kind || c.reference.boundary || '') + (c.reference.price != null ? ' <b class="num">' + num(c.reference.price) + '</b>' : '') + '</span></div>';
    if (c.frozenExtreme != null) rows += '<div class="kv"><span>Frozen extreme</span><b class="num">' + num(c.frozenExtreme) + '</b></div>';
    if (c.invalidation != null) rows += '<div class="kv"><span>Structural invalidation</span><b class="num">' + num(c.invalidation) + '</b></div>';
    rows += '<div class="kv"><span>Objective</span><span>' + (c.objective != null ? '<b class="num">' + num(c.objective) + '</b> <span class="mut">' + esc(c.objectiveReason || '') + '</span>' : '<span class="mut">' + esc(c.objectiveReason || 'none') + '</span>') + '</span></div>';
    rows += '<div class="kv"><span>Economics (2:1 research gate)</span><span>' + econHtml(c.economics) + '</span></div>';
    if (c.label) rows += '<div class="mut" style="font-size:11px;margin-top:4px">' + esc(c.label) + '</div>';
    if (c.engineState) rows += '<div class="mut" style="font-size:11px">Engine state: ' + esc(pretty(c.engineState)) + '</div>';
    if (c.priorAccepted) rows += '<div class="mut" style="font-size:11px;color:var(--yellow)">Note: this departure was previously ACCEPTED, then failed (chronological transition).</div>';
    var reasons = (c.rejectionReasons || []).length ? '<div class="mut" style="font-size:11px;margin-top:4px">Why not further: ' + c.rejectionReasons.map(esc).join('; ') + '.</div>' : '';
    var ts = Object.keys(c.timestamps || {}).filter(function (k) { return c.timestamps[k]; }).map(function (k) { return k.replace('Utc', '') + ' ' + fmt(c.timestamps[k]); }).join(' · ');
    return '<div class="card"><h2>' + esc(APPROACH_NAME[c.approach] || c.approach) + '</h2>' +
      '<div style="margin-bottom:8px">' + dirB + ' <span class="badge ' + (STATE_BADGE[c.state] || 'b-mut') + '">' + esc(pretty(c.state)) + '</span> <span class="mut" style="font-size:10.5px">' + esc(c.version) + '</span></div>' +
      rows + reasons + (ts ? '<div class="mut" style="font-size:10.5px;margin-top:4px">' + esc(ts) + '</div>' : '') + '</div>';
  }

  // Best candidate per approach (candidates already globally sorted by group then recency).
  var order = ['PULLBACK', 'RANGE_REJECTION', 'ACCEPTED_BREAKOUT', 'FAILED_BREAKOUT'];
  var bestByApproach = {};
  J.candidates.forEach(function (c) { if (!bestByApproach[c.approach]) bestByApproach[c.approach] = c; });

  // ---- context + evidence card ----
  var ev = ctx.evidence || { supporting: [], conflicting: [], missing: [] };
  var evList = function (arr, cls) { return arr.length ? '<ul style="margin:4px 0 0;padding-left:18px">' + arr.map(function (x) { return '<li class="' + cls + '" style="font-size:12px">' + esc(x) + '</li>'; }).join('') + '</ul>' : '<span class="mut">—</span>'; };
  var locRows = '<div class="kv"><span>Weekly trend</span><span class="badge ' + (biasBadge[tr.bias] || 'b-mut') + '">' + tr.bias + '</span></div>';
  if (bal) locRows += '<div class="kv"><span>Weekly balance</span><span>' + (bal.confirmed ? '<span class="pos">established</span> ' : '<span class="mut">unconfirmed</span> ') + num(bal.lower) + '–' + num(bal.upper) + ' <span class="mut">(mid ' + num(bal.mid) + ', ' + bal.widthPips + 'p)</span></span></div>';
  else locRows += '<div class="kv"><span>Weekly balance</span><span class="mut">none (needs two confirmed swings oscillating)</span></div>';
  locRows += '<div class="kv"><span>H4 location</span><b>' + esc(pretty(loc.zone)) + '</b>' + (loc.distToUpperPips != null ? ' <span class="mut">↑' + loc.distToUpperPips + 'p / ↓' + loc.distToLowerPips + 'p</span>' : '') + '</div>';
  var contextCard = '<div class="card"><h2>Weekly market context</h2>' + locRows +
    '<div class="stmt"><div class="lbl">Supporting evidence</div>' + evList(ev.supporting, 'pos') + '</div>' +
    '<div class="stmt"><div class="lbl">Conflicting evidence</div>' + evList(ev.conflicting, 'neg') + '</div>' +
    '<div class="stmt"><div class="lbl">Missing information</div>' + evList(ev.missing, 'mut') + '</div></div>';

  // ---- ranked candidates summary (transparent sorting) ----
  var rankRows = J.candidates.filter(function (c) { return c.state === 'CONFIRMED' || c.state === 'FORMING' || c.state === 'OBJECTIVE_UNAVAILABLE'; })
    .map(function (c) { return '<tr><td>' + esc(APPROACH_NAME[c.approach] || c.approach) + '</td><td>' + (c.dir ? (c.dir === 'BUY' ? '<span class="badge b-up">BUY</span>' : '<span class="badge b-dn">SELL</span>') : '—') + '</td><td><span class="badge ' + (STATE_BADGE[c.state] || 'b-mut') + '">' + esc(pretty(c.state)) + '</span></td><td>' + (c.economics ? econHtml(c.economics) : '—') + '</td></tr>'; }).join('');
  var rankCard = '<div class="card"><h2>Ranked candidates — eligible, then forming, then needs-review</h2>' +
    (rankRows ? '<table><thead><tr><th>Approach</th><th>Dir</th><th>Stage</th><th>Economics</th></tr></thead><tbody>' + rankRows + '</tbody></table>' : '<div class="mut">No eligible or forming candidate at this close.</div>') +
    '<div class="mut" style="margin-top:6px;font-size:11px">Transparent sorting by lifecycle stage then recency — NOT "best trades", no win probabilities. Related candidates from the same event are not independent confirmation. UNVALIDATED research.</div></div>';

  // ---- charts ----
  $('viewhost').innerHTML =
    '<div id="scanhost"><div class="card mut">Scanning all 28 pairs…</div></div>' +
    '<div class="card"><h2>Weekly (W1) — references</h2><div class="chartwrap"><canvas id="cw"></canvas></div></div>' +
    '<div class="card"><h2>H4 — interaction with weekly references</h2><div class="chartwrap"><canvas id="ch"></canvas></div></div>' +
    '<div class="grid">' + contextCard + rankCard + '</div>' +
    '<div class="grid">' + order.map(function (a) { return bestByApproach[a] ? candidateCard(bestByApproach[a]) : ''; }).join('') + '</div>';

  function draw(canvasId, candles, levels, markers) {
    var cv = $(canvasId); if (!cv || !candles || !candles.length) return;
    var dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr;
    var g = cv.getContext('2d'); g.scale(dpr, dpr);
    var padL = 56, padR = 8, padT = 8, padB = 18, lo = Infinity, hi = -Infinity;
    candles.forEach(function (c) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; });
    (levels || []).forEach(function (L) { if (L.price != null && isFinite(L.price)) { if (L.price < lo) lo = L.price; if (L.price > hi) hi = L.price; } });
    if (!(hi > lo)) hi = lo + 1; var pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
    var X = function (i) { return padL + (w - padL - padR) * (i / Math.max(1, candles.length - 1)); };
    var Y = function (p) { return padT + (h - padT - padB) * (1 - (p - lo) / (hi - lo)); };
    g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(42,49,72,.6)'; g.fillStyle = '#94a3b8'; g.font = '10px Inter,sans-serif'; g.lineWidth = 1;
    for (var k = 0; k <= 4; k++) { var pr = lo + (hi - lo) * k / 4, y = Y(pr); g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke(); g.fillText(pr.toFixed(4), 4, y + 3); }
    var cw = Math.max(1.5, (w - padL - padR) / candles.length * 0.6);
    candles.forEach(function (c, i) { var x = X(i), up = c.c >= c.o, col = c.partial ? '#64748b' : (up ? '#16c784' : '#f6465d'); g.strokeStyle = col; g.fillStyle = col; g.beginPath(); g.moveTo(x, Y(c.h)); g.lineTo(x, Y(c.l)); g.stroke(); var yo = Y(c.o), yc = Y(c.c); g.fillRect(x - cw / 2, Math.min(yo, yc), cw, Math.max(1, Math.abs(yc - yo))); });
    (markers || []).forEach(function (m) { var idx = 0, best = Infinity; candles.forEach(function (c, i) { var d = Math.abs(c.t - m.atMs); if (d < best) { best = d; idx = i; } }); var x = X(idx), y = Y(m.extreme); g.fillStyle = m.kind === 'ACCEPTED' ? '#3b82f6' : m.kind === 'FAILED' ? '#ca8a04' : '#f6465d'; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); });
    (levels || []).forEach(function (L) { if (L.price == null || !isFinite(L.price)) return; g.strokeStyle = L.color; g.setLineDash([4, 3]); g.lineWidth = 1.2; var y = Y(L.price); g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke(); g.setLineDash([]); g.fillStyle = L.color; g.fillText(L.label, w - padR - 78, y - 3); });
  }
  function wLevels() { var L = []; if (bal) { L.push({ price: bal.upper, color: '#f6465d', label: 'upper' }); L.push({ price: bal.lower, color: '#16c784', label: 'lower' }); L.push({ price: bal.mid, color: '#94a3b8', label: 'mid' }); } return L; }
  function redraw() { draw('cw', J.w1candles, wLevels(), []); draw('ch', J.h4candles, wLevels(), J.markers); }
  redraw(); window.addEventListener('resize', redraw);

  // ---- 28-pair scanner (filled async) ----
  window.NFX_RENDER_SCAN = function (scan) {
    var host = $('scanhost'); if (!host) return;
    if (!scan || !scan.length) { host.innerHTML = '<div class="card mut">Scan unavailable.</div>'; return; }
    var cur = (location.search.match(/[?&]pair=([^&]+)/) || [])[1] || J.pair;
    var aArg = (location.search.match(/[?&]asOf=(\d+)/) || [])[1];
    var rows = scan.map(function (s) {
      var b = s.best, badge = biasBadge[s.bias] || 'b-mut';
      var typ = b ? esc(APPROACH_NAME[b.approach] || b.approach) + (b.dir ? ' <span class="badge ' + (b.dir === 'BUY' ? 'b-up' : 'b-dn') + '">' + b.dir + '</span>' : '') : '—';
      var stage = b ? '<span class="badge ' + (STATE_BADGE[b.state] || 'b-mut') + '">' + esc(pretty(b.state)) + '</span>' : '—';
      var econ = b && b.economics ? (b.economics.economicEligibility === 'ELIGIBLE' ? '<span class="pos">R:R ' + b.economics.rewardRisk + ':1</span>' : '<span class="mut">' + esc(b.economics.economicEligibility.toLowerCase()) + '</span>') : '—';
      var balTxt = s.balance ? (s.balance.confirmed ? '<span class="pos">balance</span>' : '<span class="mut">no bal</span>') : '<span class="mut">no bal</span>';
      var sel = s.pair === cur ? ' style="background:rgba(59,130,246,.12);cursor:pointer" ' : ' style="cursor:pointer" ';
      return '<tr class="scanrow" data-pair="' + s.pair + '"' + sel + '><td><b>' + s.pair.replace('_', '/') + '</b></td><td><span class="badge ' + badge + '">' + s.bias + '</span> ' + balTxt + '</td><td>' + esc(pretty(s.location || '')) + '</td><td>' + typ + '</td><td>' + stage + '</td><td>' + econ + '</td></tr>';
    }).join('');
    var nConf = scan.filter(function (s) { return s.best && s.best.state === 'CONFIRMED'; }).length;
    host.innerHTML = '<div class="card"><h2>Scanner — all ' + scan.length + ' pairs' + (nConf ? ' · <span class="pos">' + nConf + ' confirmed</span>' : '') + '</h2>' +
      '<table><thead><tr><th>Pair</th><th>Weekly context</th><th>Location</th><th>Opportunity</th><th>Stage</th><th>Economics</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="mut" style="margin-top:6px;font-size:11px">Grouped by lifecycle stage then recency. Not "best trades"; no win probabilities; related candidates are not independent confirmation. Click a pair for its context and all four approach cards. UNVALIDATED.</div></div>';
    Array.prototype.forEach.call(host.querySelectorAll('.scanrow'), function (tr) { tr.onclick = function () { location.href = location.pathname + '?pair=' + tr.getAttribute('data-pair') + (aArg ? '&asOf=' + aArg : ''); }; });
  };
})();
