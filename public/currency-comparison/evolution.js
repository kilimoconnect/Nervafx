'use strict';
/* Today-so-far % EVOLUTION view (research, UNVALIDATED). Renders from window.NFX_EVO:
   - ranked current-% chips with ±threshold state,
   - an intraday multi-line % chart (8 currencies) with ±0.25% "best movement" bands,
   - a historical scan: per-currency reach frequency + a days×currencies heatmap.
   Relative-movement only — not a signal, probability, or profitability claim. */
(function () {
  var J = window.NFX_EVO; if (!J) return;
  var host = document.getElementById('viewhost'); host.innerHTML = '';
  var THR = J.threshold || 0.25;

  var COL = { USD: '#3b82f6', EUR: '#22c55e', GBP: '#a855f7', JPY: '#ef4444', CHF: '#14b8a6', CAD: '#f59e0b', AUD: '#ec4899', NZD: '#94a3b8' };
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function eatHM(ms) { var d = new Date(ms + 3 * 3600000); return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); }
  function eatDate(ms) { var d = new Date(ms + 3 * 3600000); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); }
  function pct(x) { return (x == null) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(2) + '%'; }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  var live = J.live || { rows: [] }, hist = J.history || { perCurrency: [], matrix: [] };

  // ── header ──
  document.getElementById('datahdr').innerHTML =
    'Today so far — % evolution through ' + eatHM(live.cutoffMs) + ' EAT · day open ' + eatDate(live.startMs) + ' 00:00 EAT · '
    + '<b>best movement</b> = a currency reaching <b>+' + THR + '%</b> or <b>−' + THR + '%</b> · history window ' + (J.windowDays || 120) + 'd · MODELLED / UNVALIDATED';

  document.getElementById('banners').innerHTML =
    '<div class="state-banner sb-unavail" style="border-color:rgba(59,130,246,.4)">Each line is a currency\'s zero-sum 1/8 index as a % from the <b>00:00 EAT</b> day open. '
    + 'Crossing the shaded <b>±' + THR + '%</b> band is a <b>best movement</b> — a relative-movement observation, <b>not</b> a trade signal or probability.</div>';

  // ── ranked chips ──
  var chips = el('div'); chips.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:10px 0';
  live.rows.forEach(function (r) {
    var c = el('div', 'ccard'); c.style.cursor = 'default';
    var badge = r.state === 'above' ? '<span style="color:var(--up);font-weight:700">▲ +' + THR + '%</span>'
      : r.state === 'below' ? '<span style="color:var(--dn);font-weight:700">▼ −' + THR + '%</span>'
      : '<span class="mut">within</span>';
    c.innerHTML =
      '<div class="rk">#' + (r.rank || '—') + '</div>'
      + '<div class="ccy" style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:50%;background:' + (COL[r.currency] || '#888') + ';display:inline-block"></span>' + r.currency + '</div>'
      + '<div class="ret ' + (r.current > 0 ? 'up' : r.current < 0 ? 'dn' : 'fl') + '">' + pct(r.current) + '</div>'
      + '<div class="meta">peak <b style="color:var(--up)">' + pct(r.peak) + '</b> · trough <b style="color:var(--dn)">' + pct(r.trough) + '</b><br>' + badge
      + (r.reachedUp ? ' · hit +' + THR + ' @ ' + eatHM(r.firstUpMs) : '') + (r.reachedDown ? ' · hit −' + THR + ' @ ' + eatHM(r.firstDownMs) : '') + '</div>';
    chips.appendChild(c);
  });
  host.appendChild(chips);

  // ── evolution chart (SVG) ──
  host.appendChild(buildChart(live, THR, COL));

  // ── history: per-currency stats + heatmap ──
  var hsec = el('div', 'card'); hsec.style.marginTop = '14px';
  hsec.appendChild(el('div', null, '<div style="font-weight:700;margin-bottom:2px">Historical best-movement frequency</div>'
    + '<div class="mut" style="font-size:11px;margin-bottom:8px">Across ' + hist.daysScanned + ' EAT days: how often each currency reached ±' + THR + '% at any point in the day. MODELLED / UNVALIDATED.</div>'));

  var tbl = el('table', 'leg'); tbl.style.width = '100%';
  tbl.innerHTML = '<thead><tr><th>Ccy</th><th>Days ±' + THR + '</th><th>%</th><th>↑ days</th><th>↓ days</th><th>max ↑</th><th>max ↓</th><th>avg peak |%|</th></tr></thead>';
  var tb = el('tbody');
  hist.perCurrency.slice().sort(function (a, b) { return b.eitherPct - a.eitherPct; }).forEach(function (r) {
    var tr = el('tr');
    tr.innerHTML = '<td style="text-align:left"><span style="color:' + (COL[r.currency] || '#888') + ';font-weight:700">' + r.currency + '</span></td>'
      + '<td>' + r.daysEither + '/' + r.daysComplete + '</td><td>' + r.eitherPct + '%</td>'
      + '<td style="color:var(--up)">' + r.daysUp + '</td><td style="color:var(--dn)">' + r.daysDown + '</td>'
      + '<td style="color:var(--up)">' + pct(r.maxUp) + '</td><td style="color:var(--dn)">' + pct(r.maxDown) + '</td><td>' + pct(r.avgPeakAbs) + '</td>';
    tb.appendChild(tr);
  });
  tbl.appendChild(tb); hsec.appendChild(tbl);

  hsec.appendChild(el('div', null, '<div style="font-weight:700;margin:14px 0 6px">Recent days (↑ reached +' + THR + ', ↓ reached −' + THR + ')</div>'));
  hsec.appendChild(buildHeatmap(hist, THR, COL));
  host.appendChild(hsec);

  // ───────────────────────────────────────────────────────────────────────────
  function buildChart(live, thr, col) {
    var wrap = el('div', 'card'); wrap.style.padding = '10px';
    var t0 = live.startMs, t1 = live.cutoffMs;
    var any = live.rows.some(function (r) { return r.ok && r.points.length > 1; });
    if (!any || !(t1 > t0)) { wrap.innerHTML = '<div class="mut">The developing day has just started — not enough M15 points yet to plot. Check back after the next closes.</div>'; return wrap; }

    var W = 920, H = 380, mL = 48, mR = 64, mT = 14, mB = 26;
    var yMax = thr * 1.2, yMin = -thr * 1.2;
    live.rows.forEach(function (r) { r.points.forEach(function (p) { if (p.pct > yMax) yMax = p.pct; if (p.pct < yMin) yMin = p.pct; }); });
    var pad = (yMax - yMin) * 0.08; yMax += pad; yMin -= pad;
    var X = function (ms) { return mL + (ms - t0) / (t1 - t0) * (W - mL - mR); };
    var Y = function (v) { return mT + (yMax - v) / (yMax - yMin) * (H - mT - mB); };

    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;font-family:inherit">';
    // threshold bands
    s += '<rect x="' + mL + '" y="' + Y(yMax) + '" width="' + (W - mL - mR) + '" height="' + (Y(thr) - Y(yMax)) + '" fill="rgba(34,197,94,.08)"/>';
    s += '<rect x="' + mL + '" y="' + Y(-thr) + '" width="' + (W - mL - mR) + '" height="' + (Y(yMin) - Y(-thr)) + '" fill="rgba(239,68,68,.08)"/>';
    // y gridlines/labels at 0, ±thr
    [thr, 0, -thr].forEach(function (lv) {
      var yy = Y(lv), dash = lv === 0 ? '' : 'stroke-dasharray="4 4"';
      s += '<line x1="' + mL + '" y1="' + yy + '" x2="' + (W - mR) + '" y2="' + yy + '" stroke="var(--border)" ' + dash + '/>';
      s += '<text x="' + (mL - 6) + '" y="' + (yy + 3) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">' + (lv > 0 ? '+' : '') + lv.toFixed(2) + '%</text>';
    });
    // x ticks (EAT) — ~6
    for (var k = 0; k <= 6; k++) { var tm = t0 + (t1 - t0) * k / 6, xx = X(tm); s += '<text x="' + xx + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="var(--text-muted)">' + eatHM(tm) + '</text>'; }
    // lines
    live.rows.forEach(function (r) {
      if (!r.ok || r.points.length < 2) return;
      var d = r.points.map(function (p, i) { return (i ? 'L' : 'M') + X(p.ms).toFixed(1) + ' ' + Y(p.pct).toFixed(1); }).join(' ');
      var strong = r.reachedEither ? 2.4 : 1.3, opa = r.reachedEither ? 1 : 0.8;
      s += '<path d="' + d + '" fill="none" stroke="' + (col[r.currency] || '#888') + '" stroke-width="' + strong + '" opacity="' + opa + '"/>';
      var last = r.points[r.points.length - 1];
      s += '<circle cx="' + X(last.ms).toFixed(1) + '" cy="' + Y(last.pct).toFixed(1) + '" r="2.6" fill="' + (col[r.currency] || '#888') + '"/>';
      s += '<text x="' + (W - mR + 4) + '" y="' + (Y(last.pct) + 3).toFixed(1) + '" font-size="10" fill="' + (col[r.currency] || '#888') + '">' + r.currency + '</text>';
    });
    s += '</svg>';
    wrap.innerHTML = s;
    return wrap;
  }

  function buildHeatmap(hist, thr, col) {
    var box = el('div'); box.style.cssText = 'overflow-x:auto';
    var ccys = hist.currencies || [];
    var t = '<table class="leg" style="width:100%;min-width:520px"><thead><tr><th style="text-align:left">Day (EAT)</th>';
    ccys.forEach(function (c) { t += '<th><span style="color:' + (col[c] || '#888') + '">' + c + '</span></th>'; });
    t += '</tr></thead><tbody>';
    (hist.matrix || []).forEach(function (row) {
      t += '<tr><td style="text-align:left">' + eatDate(row.dayMs) + '</td>';
      row.cells.forEach(function (cell) {
        if (!cell) { t += '<td class="mut">·</td>'; return; }
        var bg = cell.u && cell.d ? 'linear-gradient(135deg,rgba(34,197,94,.5) 50%,rgba(239,68,68,.5) 50%)'
          : cell.u ? 'rgba(34,197,94,.45)' : cell.d ? 'rgba(239,68,68,.45)' : 'transparent';
        var mark = cell.u && cell.d ? '↕' : cell.u ? '↑' : cell.d ? '↓' : '';
        var tip = 'peak ' + pct(cell.peak) + ' · trough ' + pct(cell.trough);
        t += '<td title="' + esc(tip) + '" style="background:' + bg + '">' + mark + '</td>';
      });
      t += '</tr>';
    });
    t += '</tbody></table>';
    box.innerHTML = t;
    return box;
  }
})();
