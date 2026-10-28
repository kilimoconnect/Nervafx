(function () {
  'use strict';
  var J = window.NFX_CM;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function pretty(s) { return String(s == null ? '' : s).toLowerCase().replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function fmtEat(iso) { if (!iso) return '—'; var ms = Date.parse(iso); if (isNaN(ms)) return '—'; var d = new Date(ms + 3 * 3600000), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); }
  function fmtUtc(iso) { return iso ? String(iso).replace('T', ' ').replace('.000Z', '') : '—'; }
  function num(x, d) { return x == null || !isFinite(x) ? '—' : Number(x).toFixed(d == null ? 2 : d); }

  var DIR = { STRENGTHENING: { c: 'b-up', g: '#16c784', t: 'Strengthening' }, WEAKENING: { c: 'b-dn', g: '#f6465d', t: 'Weakening' }, MIXED: { c: 'b-mut', g: '#94a3b8', t: 'Mixed' }, UNAVAILABLE: { c: 'b-warn', g: '#ca8a04', t: 'Unavailable' } };
  function dirBadge(d) { var x = DIR[d] || DIR.UNAVAILABLE; return '<span class="badge ' + x.c + '">' + x.t + '</span>'; }

  // ---- header / selector ----
  $('ver').textContent = J.version;
  var wsel = $('winsel');
  wsel.innerHTML = J.windows.map(function (w) { return '<option value="' + w.name + '">' + w.label + '</option>'; }).join('');
  wsel.value = J.windowName;
  wsel.onchange = function () { var a = (location.search.match(/[?&]asOf=(\d+)/) || [])[1]; location.href = location.pathname + '?window=' + wsel.value + (a ? '&asOf=' + a : ''); };
  var fr = J.freshness;
  $('datahdr').innerHTML = 'as of <b>' + fmtEat(J.asOfUtc) + ' EAT</b> <span class="mut">(' + fmtUtc(J.asOfUtc) + ' UTC)</span> · window <b>' + esc(J.windowLabel) + '</b> · mode ' + esc(J.mode) +
    ' · coverage <b>' + fr.pairsFresh + '/' + fr.pairsTotal + '</b> pairs' + (fr.pairsStale.length ? ' <span class="neg">(stale: ' + fr.pairsStale.map(function (p) { return p.replace('_', '/'); }).join(', ') + ')</span>' : '') +
    ' · tz ' + esc(J.timezone);

  // ---- main currency table ----
  function breadthTxt(b) { return '<span class="pos">' + b.strengthening + '</span>/<span class="neg">' + b.weakening + '</span>/<span class="mut">' + b.neutral + '</span>'; }
  function onsetTxt(o) { return o && o.detected ? ('<span>' + esc(pretty(o.direction)) + ' · age ' + o.ageBars + ' bars</span>') : '<span class="mut">—</span>'; }
  function extTxt(e) { if (!e || !e.available) return '<span class="mut">n/a</span>'; var cls = e.label === 'unusually extended' ? 'neg' : e.label === 'elevated' ? 'b-warn' : 'mut'; return '<span class="' + (cls === 'b-warn' ? 'num' : cls) + '">' + esc(e.label) + ' <span class="mut">(' + Math.round(e.magnitudePercentile * 100) + '%)</span></span>'; }
  function persistTxt(p) { return p && p.consecutive ? (p.consecutive + '× <span class="mut">' + esc(p.breadthTrend) + '</span>') : '<span class="mut">0</span>'; }
  function actionBadge(a) { var cls = a.key === 'INVESTIGATE' ? 'b-up' : a.key === 'EXTENDED' ? 'b-warn' : a.key === 'CONFLICTING' ? 'b-mut' : a.key === 'INSUFFICIENT' ? 'b-warn' : 'b-mut'; return '<span class="badge ' + cls + '">' + esc(a.label) + '</span>'; }

  var rows = J.table.slice().sort(function (a, b) { return (Math.abs(b.score || 0) - Math.abs(a.score || 0)); }).map(function (r) {
    return '<tr class="rowbtn" data-ccy="' + r.currency + '"><td><b>' + r.currency + '</b></td><td>' + dirBadge(r.direction) + '</td><td class="num ' + ((r.score || 0) > 0 ? 'pos' : (r.score || 0) < 0 ? 'neg' : '') + '">' + num(r.score) + '</td><td>' + breadthTxt(r.breadth) + '</td><td>' + persistTxt(r.persistence) + '</td><td>' + onsetTxt(r.onset) + '</td><td>' + extTxt(r.extension) + '</td><td>' + actionBadge(r.action) + '</td><td class="' + (r.provisional ? 'neg' : 'mut') + '">' + r.coverage.valid + '/7</td></tr>';
  }).join('');
  var tableCard = '<div class="card"><h2>Currency movement — ' + esc(J.windowLabel) + ' (click a currency)</h2>' +
    '<table role="grid"><thead><tr><th>Ccy</th><th>Direction</th><th>Score</th><th>Breadth (S/W/N)</th><th>Persistence</th><th>Detected onset</th><th>Extension</th><th>Research action</th><th>Coverage</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div class="mut" style="margin-top:6px;font-size:11px">' + esc(J.aggregation) + ' ' + esc(J.observationNote) + ' Sorted by |score|; NOT "best trades". Research action is evidence-based, never Buy/Sell.</div></div>';

  // ---- cross-window heatmap ----
  function cellStyle(cell) { var x = DIR[cell.direction] || DIR.UNAVAILABLE; var a = cell.score == null ? 0 : Math.min(1, Math.abs(cell.score) / 1.5); var bg = x.g; return 'style="background:' + bg + (a < 1 ? Math.round(16 + a * 60).toString(16).padStart(2, '0') : 'cc') + ';color:' + (a > 0.5 ? '#0a0e17' : 'var(--text)') + '" title="' + x.t + ' · score ' + num(cell.score) + ' · coverage ' + esc(cell.coverage || '') + (cell.breadth ? ' · breadth ' + cell.breadth.strengthening + '/' + cell.breadth.weakening + '/' + cell.breadth.neutral : '') + '"'; }
  var hmHead = '<tr><th>Ccy</th>' + J.heatmap.windows.map(function (w) { return '<th>' + w.label + '</th>'; }).join('') + '</tr>';
  var hmRows = J.heatmap.rows.map(function (r) { return '<tr><td style="text-align:left"><b>' + r.currency + '</b></td>' + r.cells.map(function (c) { return '<td class="cell" ' + cellStyle(c) + '>' + num(c.score, 1) + '</td>'; }).join('') + '</tr>'; }).join('');
  var hmCard = '<div class="card"><h2>Cross-window heatmap — direction &amp; score</h2><table class="hm"><thead>' + hmHead + '</thead><tbody>' + hmRows + '</tbody></table>' +
    '<div class="mut" style="margin-top:6px;font-size:11px">Green = strengthening, red = weakening, grey = mixed, amber = unavailable; intensity ∝ |score|. Conflicting horizons (e.g. 1h vs 5d) are visible. Hover a cell for breadth/coverage.</div></div>';

  $('viewhost').innerHTML = tableCard + hmCard;

  // ---- detail drawer ----
  function spark(canvas, hist) {
    if (!canvas || !hist || !hist.length) return; var dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight; canvas.width = w * dpr; canvas.height = h * dpr; var g = canvas.getContext('2d'); g.scale(dpr, dpr);
    var vals = hist.map(function (p) { return p.score == null ? 0 : p.score; }); var lo = Math.min.apply(null, vals.concat([-0.5])), hi = Math.max.apply(null, vals.concat([0.5])); if (hi === lo) hi = lo + 1;
    var X = function (i) { return 4 + (w - 8) * (i / Math.max(1, vals.length - 1)); }, Y = function (v) { return 4 + (h - 8) * (1 - (v - lo) / (hi - lo)); };
    g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(42,49,72,.8)'; g.beginPath(); g.moveTo(4, Y(0)); g.lineTo(w - 4, Y(0)); g.stroke();
    g.strokeStyle = '#3b82f6'; g.lineWidth = 1.5; g.beginPath(); vals.forEach(function (v, i) { var x = X(i), y = Y(v); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
  }
  function openDrawer(ccy) {
    var r = J.table.find(function (x) { return x.currency === ccy; }); if (!r) return;
    var contrib = (r.contributions || []).map(function (c) { return '<tr><td><b>' + c.pair.replace('_', '/') + '</b> <span class="mut">(' + c.role + ')</span></td><td class="num">' + (c.ret == null ? '—' : (c.ret * 100).toFixed(3) + '%') + '</td><td class="num">' + (c.normalized == null ? '<span class="mut">insuf.</span>' : num(c.normalized)) + '</td><td class="num ' + ((c.contribution || 0) > 0 ? 'pos' : (c.contribution || 0) < 0 ? 'neg' : '') + '">' + (c.contribution == null ? '—' : num(c.contribution)) + '</td></tr>'; }).join('');
    var lim = (r.limitations || []).map(function (l) { return '<li style="font-size:11px">' + esc(l) + '</li>'; }).join('');
    $('drawerBody').innerHTML = '<h2 style="margin-top:0">' + ccy + ' · ' + esc(J.windowLabel) + '</h2>' +
      '<div style="margin:6px 0">' + dirBadge(r.direction) + ' <b class="num">score ' + num(r.score) + '</b> · breadth ' + breadthTxt(r.breadth) + ' · coverage ' + r.coverage.valid + '/7' + (r.provisional ? ' <span class="neg">(provisional)</span>' : '') + '</div>' +
      '<div style="margin:6px 0">' + actionBadge(r.action) + '</div>' +
      '<div class="card" style="padding:10px"><div class="lbl mut" style="font-size:11px">Movement-score history (' + (r.history ? r.history.length : 0) + ' obs)</div><div class="sparkwrap"><canvas id="spark"></canvas></div></div>' +
      '<div class="stmt"><div class="lbl">Detected onset</div>' + (r.onset && r.onset.detected ? ('<div class="kv"><span>First observation</span><span>' + fmtEat(r.onset.firstUtc) + ' EAT</span></div><div class="kv"><span>Confirmed (rule met)</span><span>' + fmtEat(r.onset.confirmedUtc) + ' EAT</span></div><div class="kv"><span>Age</span><span>' + r.onset.ageBars + ' M15 bars</span></div><div class="mut" style="font-size:11px">' + esc(r.onset.note || '') + '</div>') : '<span class="mut">' + esc((r.onset && r.onset.reason) || 'no qualifying episode') + '</span>') + '</div>' +
      '<div class="stmt"><div class="lbl">Extension</div>' + (r.extension && r.extension.available ? ('<div class="kv"><span>' + esc(r.extension.label) + '</span><span class="num">' + Math.round(r.extension.magnitudePercentile * 100) + 'th pct</span></div><div class="mut" style="font-size:11px">' + esc(r.extension.basis) + '</div>') : '<span class="mut">unavailable</span>') + '</div>' +
      '<div class="stmt"><div class="lbl">Pair contributions (+base / −quote)</div><table><thead><tr><th>Pair</th><th>Return</th><th>Normalized</th><th>Contribution</th></tr></thead><tbody>' + contrib + '</tbody></table></div>' +
      '<div class="stmt"><div class="lbl">Limitations</div><ul style="margin:4px 0;padding-left:18px">' + lim + '</ul></div>' +
      '<div class="mut" style="font-size:11px">A strong-vs-weak comparison does not establish an entry. This is decision support, not a signal.</div>';
    $('drawer').classList.add('open');
    spark($('spark'), r.history);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.rowbtn'), function (tr) { tr.onclick = function () { openDrawer(tr.getAttribute('data-ccy')); }; });

  // open the detail drawer for a currency passed in the URL
  var urlC = (location.search.match(/[?&]currency=([A-Z]{3})/) || [])[1]; if (urlC) openDrawer(urlC);
})();
