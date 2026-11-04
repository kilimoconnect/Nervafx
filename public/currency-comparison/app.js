'use strict';

/* Currency Comparison renderer. Consumes window.NFX_CC (see /api/currency-comparison).
   Research / pair-selection only — renders relative index candles, never a trade signal.
   Missing/incomplete inputs are shown as N/A — zero is never substituted for missing data. */

(function () {
  var j = window.NFX_CC;
  var host = document.getElementById('viewhost'), hdr = document.getElementById('datahdr');
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
  var sign = function (n) { return (n > 0 ? '+' : '') + n.toFixed(2); };
  var utcEat = function (isoStr) { if (!isoStr) return '—'; var ms = Date.parse(isoStr); var e = new Date(ms + 3 * 3600000); var p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(e.getUTCHours()) + ':' + p(e.getUTCMinutes()) + ' EAT · ' + isoStr.slice(11, 16) + ' UTC'; };

  document.getElementById('ver').textContent = j.version || '—';

  // ---- Header: period, coverage, resolution, state flags --------------------
  var pi = j.periodInfo, qf = j.quality;
  var flags = [];
  if (j.mode === 'historical') flags.push('<span class="pill">REPLAY ' + esc(j.asOfUtc && j.asOfUtc.slice(0, 16)) + 'Z</span>');
  if (qf.stale) flags.push('<span class="pill warn">STALE DATA</span>');
  if (qf.provisionalBreadth) flags.push('<span class="pill warn">PROVISIONAL BREADTH</span>');
  if (qf.currenciesAvailable < qf.currenciesTotal) flags.push('<span class="pill warn">' + qf.currenciesAvailable + '/' + qf.currenciesTotal + ' CURRENCIES</span>');
  hdr.innerHTML =
    '<b>' + esc(pi.title) + '</b> · <span class="mut">' + esc(pi.sublabel) + '</span><br>' +
    '<span class="mut">Period ' + utcEat(pi.startUtc) + ' → ' + utcEat(pi.endUtc) + ' · resolution ' + esc(j.resolution) +
    ' · data ' + esc(j.firstDataUtc && j.firstDataUtc.slice(0, 10)) + ' → ' + esc(j.lastDataUtc && j.lastDataUtc.slice(0, 16)) + 'Z</span>' +
    (flags.length ? ' ' + flags.join(' ') : '') +
    '<br><span class="mut" style="font-size:11px">' + esc(pi.note) + ' ' + esc(j.resolutionNote) + '</span>';

  if (!j.available) { host.innerHTML = '<div class="state-banner sb-unavail">No currency has index data for this period. Nothing is shown rather than substituting zero.</div>'; return; }

  // ---- Shared % scale for the open-relative mini-charts ---------------------
  var sc = j.sharedScale, lo = Math.min(sc.minPct, 0), hi = Math.max(sc.maxPct, 0), span = (hi - lo) || 1;
  function miniSvg(points, up) {
    if (!points || points.length < 2) return '<div class="meta">mini-chart N/A — no closed observations</div>';
    var W = 180, H = 46, t0 = points[0].ms, t1 = points[points.length - 1].ms, dt = (t1 - t0) || 1;
    var x = function (ms) { return ((ms - t0) / dt) * W; }, y = function (p) { return H - ((p - lo) / span) * H; };
    var d = points.map(function (p, i) { return (i ? 'L' : 'M') + x(p.ms).toFixed(1) + ',' + y(p.pct).toFixed(1); }).join(' ');
    var zeroY = y(0).toFixed(1), col = up > 0 ? 'var(--up)' : (up < 0 ? 'var(--dn)' : 'var(--text-muted)');
    return '<svg class="mini" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<line x1="0" y1="' + zeroY + '" x2="' + W + '" y2="' + zeroY + '" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.6"/></svg>';
  }
  function breadthBar(b) {
    var cells = [];
    for (var k = 0; k < b.coverage.valid; k++) { cells.push(''); }
    return '<div class="brd meta">Breadth vs 7: <b>▲' + b.appreciated + '</b> · <i>▼' + b.depreciated + '</i> · =' + b.unchanged +
      (b.provisional ? ' <span class="mut">(' + b.coverage.valid + '/7)</span>' : '') + '</div>';
  }

  // ---- Cards (already ranked by signed return) -----------------------------
  var html = '<div class="grid">';
  j.cards.forEach(function (c) {
    if (!c.available) {
      html += '<div class="ccard na" data-ccy="' + c.currency + '"><div class="ccy">' + c.currency + '</div>' +
        '<div class="ret fl">N/A</div><div class="meta">No index data for this period.</div></div>';
      return;
    }
    var m = c.highlight.metrics, cls = m.direction === 'appreciation' ? 'up' : (m.direction === 'depreciation' ? 'dn' : 'fl');
    var updn = m.direction === 'appreciation' ? 1 : (m.direction === 'depreciation' ? -1 : 0);
    var loc = m.flat ? 'flat' : ('close ' + m.closeLocationPct + '% of range · body ' + m.bodyPct + '%');
    html += '<div class="ccard" data-ccy="' + c.currency + '" tabindex="0" role="button" aria-label="' + c.currency + ' detail">' +
      '<span class="rk">#' + (c.rank || '—') + '</span>' +
      '<div class="ccy">' + c.currency + '</div>' +
      '<div class="ret ' + cls + '">' + sign(m.returnPct) + '%</div>' +
      miniSvg(c.mini.points, updn) +
      '<div class="meta">' + esc(loc) + '</div>' +
      breadthBar(c.breadth) +
      '</div>';
  });
  html += '</div>';

  html += '<div class="card"><h2>Context</h2><div class="mut" style="font-size:12px">' +
    'Ranked by signed return of the ' + esc(pi.title.toLowerCase()) + ' index candle. Mini-charts are open-relative ' +
    '(each starts at 0%) on a shared scale of ' + sign(sc.minPct) + '% … ' + sign(sc.maxPct) + '%. ' +
    (j.contextPeriods.length ? 'Two prior periods are available in each currency’s detail. ' : '') +
    'Click a currency for its 7 underlying pairs and candle history.</div></div>';

  html += '<div class="card"><h2>Limitations</h2><ul class="mut" style="margin:0;padding-left:18px;font-size:12px;line-height:1.6">' +
    j.limitations.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></div>';

  host.innerHTML = html;

  // ---- Detail drawer: 7 underlying legs + candle history -------------------
  function openDetail(ccy) {
    var drawer = document.getElementById('drawer'), body = document.getElementById('drawerBody');
    body.innerHTML = '<div class="mut">Loading ' + esc(ccy) + '…</div>'; drawer.classList.add('open');
    var q = '?view=' + encodeURIComponent(j.view) + '&session=' + encodeURIComponent(j.session || 'london') +
      (j.mode === 'historical' && j.asOfUtc ? '&asOf=' + Date.parse(j.asOfUtc) : '') + '&currency=' + encodeURIComponent(ccy);
    fetch('/api/currency-comparison' + q).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.detail) { body.innerHTML = '<div class="state-banner sb-unavail">No detail available for ' + esc(ccy) + '.</div>'; return; }
      var det = d.detail, h = '<h2 style="margin-top:0">' + esc(ccy) + ' — underlying & history</h2>';
      if (!det.available) h += '<div class="state-banner sb-unavail">No index candle for this period.</div>';

      // candle history: context (faded) + highlight
      h += '<div class="ctx">';
      det.context.concat([det.highlight]).forEach(function (cd, i, arr) {
        var isHi = i === arr.length - 1;
        if (!cd.ok) { h += '<div class="mc' + (isHi ? ' hl' : '') + '">' + (isHi ? 'Highlight' : 'Prior') + '<br>N/A — ' + esc(cd.reason || 'no data') + '</div>'; return; }
        var o = cd.ohlc, mm = cd.metrics;
        h += '<div class="mc' + (isHi ? ' hl' : '') + '">' + (isHi ? '<b>' + esc(cd.status) + '</b>' : esc(cd.startUtc && cd.startUtc.slice(5, 10))) + '<br>' +
          'ret ' + sign(mm.returnPct) + '%<br>' +
          (mm.flat ? '<span class="mut">N/A — flat candle</span>' : ('body ' + mm.bodyPct + '%<br>up-wick ' + mm.upperWickPct + '% · lo-wick ' + mm.lowerWickPct + '%<br>close@' + mm.closeLocationPct + '%')) +
          '<br><span class="mut">O ' + o.open.toFixed(3) + ' H ' + o.high.toFixed(3) + ' L ' + o.low.toFixed(3) + ' C ' + o.close.toFixed(3) + '</span></div>';
      });
      h += '</div>';

      // 7 underlying legs
      h += '<h2>Underlying 7 pairs</h2><table class="leg"><thead><tr><th>Pair</th><th>Role</th><th>' + esc(ccy) + ' return</th><th>Class</th></tr></thead><tbody>';
      det.pairs.forEach(function (lg) {
        var cl = lg.classification, c2 = cl === 'appreciated' ? 'var(--up)' : (cl === 'depreciated' ? 'var(--dn)' : 'var(--text-muted)');
        h += '<tr><td>' + esc(lg.pair) + '</td><td>' + esc(lg.role || '—') + '</td>' +
          '<td style="color:' + c2 + '">' + (lg.orientedReturnPct == null ? 'N/A' : sign(lg.orientedReturnPct) + '%') + '</td>' +
          '<td style="color:' + c2 + '">' + esc(cl) + '</td></tr>';
      });
      h += '</tbody></table><div class="mut" style="font-size:11px;margin-top:8px">' + esc(det.note) +
        ' Coverage ' + det.coverage.valid + '/7' + (det.coverage.missing.length ? ' (missing: ' + esc(det.coverage.missing.join(', ')) + ')' : '') + '.</div>';
      body.innerHTML = h;
    }).catch(function (e) { body.innerHTML = '<div class="state-banner sb-error">ERROR — ' + esc(e.message || e) + '</div>'; });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.ccard[data-ccy]'), function (el) {
    var ccy = el.getAttribute('data-ccy');
    el.onclick = function () { openDetail(ccy); };
    el.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDetail(ccy); } };
  });
})();
