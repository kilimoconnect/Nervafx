'use strict';
/* Today-so-far % EVOLUTION view (research, UNVALIDATED). Renders from window.NFX_EVO:
   - ranked current-% chips with ±threshold state,
   - an intraday multi-line % chart (8 currencies) with ±band "movement threshold" shading,
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

  // canonical 28 provider pairs (each economic pair once; first symbol = base) — for the hover "top pairs"
  var PAIRS28 = ['AUD_CAD', 'AUD_CHF', 'AUD_JPY', 'AUD_NZD', 'AUD_USD', 'CAD_CHF', 'CAD_JPY', 'CHF_JPY',
    'EUR_AUD', 'EUR_CAD', 'EUR_CHF', 'EUR_GBP', 'EUR_JPY', 'EUR_NZD', 'EUR_USD', 'GBP_AUD', 'GBP_CAD',
    'GBP_CHF', 'GBP_JPY', 'GBP_NZD', 'GBP_USD', 'NZD_CAD', 'NZD_CHF', 'NZD_JPY', 'NZD_USD', 'USD_CAD',
    'USD_CHF', 'USD_JPY'];
  // interpolate a currency's open-relative % at an arbitrary ms from its (ms-sorted) points
  function interpAt(points, ms) {
    if (!points || !points.length) return null;
    var n = points.length;
    if (ms <= points[0].ms) return points[0].pct;
    if (ms >= points[n - 1].ms) return points[n - 1].pct;
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (points[mid].ms <= ms) lo = mid; else hi = mid; }
    var a = points[lo], b = points[hi], f = (ms - a.ms) / ((b.ms - a.ms) || 1);
    return a.pct + (b.pct - a.pct) * f;
  }
  // open a currency's candlestick chart (reuses the table view's detail drawer), carrying any replay asOf
  function openCcyChart(ccy) {
    var u = location.pathname + '?view=todaySoFar&open=' + encodeURIComponent(ccy);
    if (J.mode === 'historical' && J.asOfUtc) u += '&asOf=' + Date.parse(J.asOfUtc);
    location.href = u;
  }

  var live = J.live || { rows: [] }, hist = J.history || { perCurrency: [], matrix: [] };
  var SP = live.spread || {};
  function minToHHMM(m) { if (m == null) return '—'; return p2(Math.floor(m / 60)) + ':' + p2(m % 60); }

  // period labels (day view by default; the H4/5m view supplies meta)
  var M = J.meta || {};
  var PNAME = M.periodName || 'Today so far', PWORD = M.periodWord || 'day';
  var OPENLBL = M.openLabel || '00:00 EAT day open', RES = M.resolution || 'M15';
  var HUNIT = M.historyUnit || 'EAT days', SUBDAY = !!M.subDay;
  function rowLabel(ms) { return SUBDAY ? eatDate(ms) + ' ' + eatHM(ms) : eatDate(ms); }

  // ── header ──
  document.getElementById('datahdr').innerHTML =
    PNAME + ' — % evolution (' + RES + ') through ' + eatHM(live.cutoffMs) + ' EAT · open ' + eatDate(live.startMs) + ' ' + eatHM(live.startMs) + ' EAT · '
    + '<b>movement threshold reached</b> = a currency crossing <b>+' + THR + '%</b> or <b>−' + THR + '%</b> from the open · history window ' + (J.windowDays || 120) + 'd · MODELLED / UNVALIDATED';

  document.getElementById('banners').innerHTML =
    '<div class="state-banner sb-unavail" style="border-color:rgba(59,130,246,.4)">Each line is a currency\'s zero-sum 1/8 index as a % from the <b>' + OPENLBL + '</b>. '
    + 'Crossing the shaded <b>±' + THR + '%</b> band is <b>movement threshold reached</b> — a relative-movement observation, <b>not</b> a trade signal or probability.</div>';

  // ── watch / dispersion state ──
  var WINS = SP.windows || [];
  var isWatch = SP.state === 'watching';
  // every spread episode across the day: start→end EAT (currencies spread apart, bunch, spread again…)
  var winTxt;
  if (!WINS.length) { winTxt = '<span class="mut">none yet — currencies still bunched</span>'; }
  else {
    winTxt = WINS.map(function (w, i) {
      var live2 = w.ongoing;
      return '<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;border-radius:999px;'
        + 'border:1px solid ' + (live2 ? 'var(--up)' : 'var(--border)') + ';'
        + (live2 ? 'background:rgba(34,197,94,.10);' : '') + 'font-size:12px;font-weight:700" '
        + 'title="peak ' + pct(w.peak) + ' @ ' + eatHM(w.peakMs) + (w.topCcy ? ' · ' + w.topCcy + ' vs ' + w.bottomCcy : '') + '">'
        + '#' + (i + 1) + ' ' + eatHM(w.startMs) + '–' + (live2 ? 'now' : eatHM(w.endMs)) + (live2 ? ' ●' : '') + '</span>';
    }).join('');
  }
  var firstTxt = SP.watchMs ? ('⏱ <b>' + eatHM(SP.watchMs) + ' EAT</b> <span class="mut">(' + minToHHMM(SP.watchMinutes) + ' in)</span>') : '<span class="mut">—</span>';
  var wbox = el('div', 'card'); wbox.style.cssText = 'margin:10px 0;border-color:' + (isWatch ? 'var(--up)' : 'var(--border)');
  wbox.innerHTML =
    '<div style="display:flex;flex-wrap:wrap;gap:18px;align-items:flex-end">'
    + '<div><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Dispersion (top−bottom)</div><div style="font-size:22px;font-weight:800">' + pct(SP.current) + '</div></div>'
    + '<div><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">State</div><div style="font-size:17px;font-weight:800;color:' + (isWatch ? 'var(--up)' : 'var(--text-muted)') + '">' + (isWatch ? '● WATCHING' : '○ bunched') + '</div></div>'
    + '<div><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Episodes this ' + PWORD + '</div><div style="font-size:17px;font-weight:800">' + (SP.episodes || 0) + '</div></div>'
    + '<div><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">First onset</div><div style="font-size:15px;font-weight:700">' + firstTxt + '</div></div>'
    + '<div><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Max spread</div><div style="font-size:15px;font-weight:700">' + pct(SP.max) + (SP.maxMs ? ' <span class="mut">@ ' + eatHM(SP.maxMs) + '</span>' : '') + '</div></div>'
    + '</div>'
    + '<div style="margin-top:10px"><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px">Spread windows (apart → back → apart …)</div><div>' + winTxt + '</div></div>'
    + '<div class="mut" style="font-size:11px;margin-top:8px">A <b>dispersion episode</b> is a genuine two-sided split: one currency at or above <b>+' + THR + '%</b> <b>AND</b> another at or below <b>−' + THR + '%</b> from the open — <b>not</b> a trade signal. A single currency pulling away while the others stay near the open does not count. Each window opens when both bands are crossed and closes when they aren’t; the ' + PWORD + ' can have several. Research only.</div>';
  host.appendChild(wbox);

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

  // ── evolution chart (SVG) + spread sub-chart ──
  var chartWrap = buildChart(live, THR, COL);
  host.appendChild(chartWrap);
  host.appendChild(buildSpreadChart(live, 2 * THR));   // reference = 2× band (min gap an episode implies)

  // ── movement-quality: analysis-window selector + sortable comparison table (D1 view only) ──
  if (J.movement) host.appendChild(buildMovementSection(J, COL, chartWrap));

  // ── M15 candle performance while dispersion > threshold (per watch window) ──
  host.appendChild(buildCandleWindows(live, THR, COL));

  // ── history: per-currency stats + heatmap ──
  var hsec = el('div', 'card'); hsec.style.marginTop = '14px';
  hsec.appendChild(el('div', null, '<div style="font-weight:700;margin-bottom:2px">Historical movement-threshold frequency</div>'
    + '<div class="mut" style="font-size:11px;margin-bottom:8px">Across ' + hist.daysScanned + ' ' + HUNIT + ': how often each currency reached ±' + THR + '% at any point in the ' + PWORD + '. MODELLED / UNVALIDATED.</div>'));

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

  // spread / watch-onset summary across history
  var ss = hist.spreadSummary || {};
  hsec.appendChild(el('div', null,
    '<div style="margin-top:14px;padding:10px;border:1px solid var(--border);border-radius:8px">'
    + '<div style="font-weight:700;margin-bottom:3px">Spread onset (time to start watching)</div>'
    + '<div class="mut" style="font-size:12px">Currencies spread apart (one ≥ +' + THR + '% <b>AND</b> another ≤ −' + THR + '%) on <b style="color:var(--text)">' + (ss.daysSpread || 0) + '/' + (ss.daysComplete || 0) + '</b> days (' + (ss.spreadPct == null ? '—' : ss.spreadPct + '%') + '). '
    + 'Typical first onset <b style="color:var(--text)">' + minToHHMM(ss.medianOnsetMin) + '</b> (median; earliest ' + minToHHMM(ss.earliestOnsetMin) + ', latest ' + minToHHMM(ss.latestOnsetMin) + ' into the ' + PWORD + '). '
    + (ss.avgEpisodesPerSpreadDay != null ? 'Currencies spread apart and bunch back <b style="color:var(--text)">' + ss.avgEpisodesPerSpreadDay + '×</b> per spread ' + PWORD + ' on average.' : '') + '</div>'
    + '</div>'));

  hsec.appendChild(el('div', null, '<div style="font-weight:700;margin:14px 0 6px">Recent ' + HUNIT + ' (↑ reached +' + THR + ', ↓ reached −' + THR + ', ⏱ = first onset · ×N = spread episodes)</div>'));
  hsec.appendChild(buildHeatmap(hist, THR, COL));
  host.appendChild(hsec);

  // ───────────────────────────────────────────────────────────────────────────
  function buildChart(live, thr, col) {
    var wrap = el('div', 'card'); wrap.style.padding = '10px';
    var t0 = live.startMs, t1 = live.cutoffMs;
    var any = live.rows.some(function (r) { return r.ok && r.points.length > 1; });
    if (!any || !(t1 > t0)) { wrap.innerHTML = '<div class="mut">The developing ' + PWORD + ' has just started — not enough ' + RES + ' points yet to plot. Check back after the next closes.</div>'; return wrap; }

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
    // analysis-window highlight band (moved by the Today/4h/1h selector; the lines are NOT rebased)
    s += '<rect class="evoWinHi" x="0" y="' + mT + '" width="0" height="' + (H - mT - mB) + '" fill="rgba(99,102,241,.10)" stroke="rgba(99,102,241,.6)" stroke-width="1" stroke-dasharray="4 3" style="display:none"/>';
    // y gridlines/labels at 0, ±thr
    [thr, 0, -thr].forEach(function (lv) {
      var yy = Y(lv), dash = lv === 0 ? '' : 'stroke-dasharray="4 4"';
      s += '<line x1="' + mL + '" y1="' + yy + '" x2="' + (W - mR) + '" y2="' + yy + '" stroke="var(--border)" ' + dash + '/>';
      s += '<text x="' + (mL - 6) + '" y="' + (yy + 3) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">' + (lv > 0 ? '+' : '') + lv.toFixed(2) + '%</text>';
    });
    // x ticks (EAT) — ~6
    for (var k = 0; k <= 6; k++) { var tm = t0 + (t1 - t0) * k / 6, xx = X(tm); s += '<text x="' + xx + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="var(--text-muted)">' + eatHM(tm) + '</text>'; }
    // spread episodes: shade each "watching" window (apart→back→apart…) + onset lines
    var sp = live.spread || {};
    var lblRows = [];   // placed onset labels per stagger row: [{x1}] so nearby labels drop to a free row
    (sp.windows || []).forEach(function (w, i) {
      var a = Math.max(t0, w.startMs), b = Math.min(t1, w.endMs);
      if (!(b >= a)) return;
      var xa = X(a), xb = X(b), ww = Math.max(1.5, xb - xa);
      s += '<rect x="' + xa + '" y="' + mT + '" width="' + ww + '" height="' + (H - mT - mB) + '" fill="rgba(234,179,8,.10)"/>';
      s += '<line x1="' + xa + '" y1="' + mT + '" x2="' + xa + '" y2="' + (H - mB) + '" stroke="#eab308" stroke-width="1.4" stroke-dasharray="5 3"/>';
      if (!w.ongoing) s += '<line x1="' + xb + '" y1="' + mT + '" x2="' + xb + '" y2="' + (H - mB) + '" stroke="rgba(234,179,8,.5)" stroke-width="1" stroke-dasharray="2 3"/>';
      // onset label — stagger down a row when it would overlap a nearby one, anchor-end near the right edge
      var txt = '⏱' + (i + 1) + ' ' + eatHM(w.startMs), lw = txt.length * 5.6 + 4;
      var anchor = 'start', lx = xa + 3;
      if (lx + lw > W - mR) { anchor = 'end'; lx = xa - 2; }          // flip to the left of the line near the right edge
      var lx0 = (anchor === 'end') ? (lx - lw) : lx;                   // left edge of the label box
      var lx1 = lx0 + lw;                                              // right edge of the label box
      var row = 0; while (lblRows[row] != null && lx0 < lblRows[row] + 4) row++;
      lblRows[row] = lx1;
      s += '<text x="' + lx + '" y="' + (mT + 11 + row * 11) + '" text-anchor="' + anchor + '" font-size="10" font-weight="700" fill="#eab308">' + txt + '</text>';
    });
    // lines
    live.rows.forEach(function (r) {
      if (!r.ok || r.points.length < 2) return;
      var d = r.points.map(function (p, i) { return (i ? 'L' : 'M') + X(p.ms).toFixed(1) + ' ' + Y(p.pct).toFixed(1); }).join(' ');
      var strong = r.reachedEither ? 2.4 : 1.3, opa = r.reachedEither ? 1 : 0.8;
      s += '<path class="evoLine" data-ccy="' + r.currency + '" d="' + d + '" fill="none" stroke="' + (col[r.currency] || '#888') + '" stroke-width="' + strong + '" opacity="' + opa + '"/>';
      var last = r.points[r.points.length - 1];
      s += '<circle cx="' + X(last.ms).toFixed(1) + '" cy="' + Y(last.pct).toFixed(1) + '" r="2.6" fill="' + (col[r.currency] || '#888') + '"/>';
      s += '<text class="evoEndLbl" data-ccy="' + r.currency + '" x="' + (W - mR + 4) + '" y="' + (Y(last.pct) + 3).toFixed(1) + '" font-size="10" font-weight="700" fill="' + (col[r.currency] || '#888') + '">' + r.currency + '</text>';
    });
    // hover layer: crosshair + one dot per currency (hidden until mousemove)
    s += '<line class="evoCross" x1="0" y1="' + mT + '" x2="0" y2="' + (H - mB) + '" stroke="rgba(148,163,184,.75)" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>';
    live.rows.forEach(function (r) {
      if (!r.ok || r.points.length < 2) return;
      s += '<circle class="evoDot" data-ccy="' + r.currency + '" r="3.4" fill="' + (col[r.currency] || '#888') + '" stroke="#0b1020" stroke-width="1" style="display:none"/>';
    });
    s += '</svg>';
    wrap.innerHTML = s;
    wrap.style.position = 'relative';
    var svgEl = wrap.querySelector('svg');

    // clickable end-labels → open that currency's candlestick chart
    Array.prototype.forEach.call(wrap.querySelectorAll('.evoEndLbl'), function (t) {
      t.style.cursor = 'pointer';
      t.onclick = function () { openCcyChart(t.getAttribute('data-ccy')); };
    });

    // clickable legend chips under the chart (ranked by current %)
    var leg = el('div', 'evo-legend');
    leg.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;align-items:center';
    leg.appendChild(el('span', 'mut', '<span style="font-size:11px">Open candlestick chart →</span>'));
    live.rows.filter(function (r) { return r.ok && r.points.length; })
      .slice().sort(function (a, b) { return b.points[b.points.length - 1].pct - a.points[a.points.length - 1].pct; })
      .forEach(function (r) {
        var chip = el('button', 'evo-chip');
        chip.type = 'button';
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--text);cursor:pointer;font-size:11px;font-weight:700';
        chip.innerHTML = '<span style="width:9px;height:9px;border-radius:50%;background:' + (col[r.currency] || '#888') + ';display:inline-block"></span>' + r.currency;
        chip.title = 'Open ' + r.currency + ' candlestick chart (M15 → Monthly) + 7 underlying pairs';
        chip.onmouseenter = function () { chip.style.borderColor = (col[r.currency] || '#888'); };
        chip.onmouseleave = function () { chip.style.borderColor = 'var(--border)'; };
        chip.onclick = function () { openCcyChart(r.currency); };
        leg.appendChild(chip);
      });
    wrap.appendChild(leg);

    // hover tooltip: time + the 5 strongest pairs (base vs quote) at the cursor
    var cross = wrap.querySelector('.evoCross');
    var dotMap = {};
    Array.prototype.forEach.call(wrap.querySelectorAll('.evoDot'), function (d) { dotMap[d.getAttribute('data-ccy')] = d; });
    var tip = el('div');
    tip.style.cssText = 'position:absolute;pointer-events:none;display:none;min-width:172px;max-width:210px;background:rgba(11,16,32,.97);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:11px;line-height:1.35;z-index:30;box-shadow:0 8px 22px rgba(0,0,0,.45)';
    wrap.appendChild(tip);

    function hover(clientX) {
      var rect = svgEl.getBoundingClientRect();
      if (!rect.width) return;
      var sx = (clientX - rect.left) / rect.width * W;
      sx = Math.max(mL, Math.min(W - mR, sx));
      var ms = t0 + (sx - mL) / (W - mL - mR) * (t1 - t0);
      var vals = {};
      live.rows.forEach(function (r) { if (r.ok && r.points && r.points.length) { var v = interpAt(r.points, ms); if (v != null) vals[r.currency] = v; } });
      cross.setAttribute('x1', sx.toFixed(1)); cross.setAttribute('x2', sx.toFixed(1)); cross.style.display = '';
      for (var c in dotMap) { if (vals[c] != null) { dotMap[c].setAttribute('cx', sx.toFixed(1)); dotMap[c].setAttribute('cy', Y(vals[c]).toFixed(1)); dotMap[c].style.display = ''; } else dotMap[c].style.display = 'none'; }
      var arr = [];
      // pair "currency %" = base currency % minus quote currency % (how far the two indices have
      // spread apart right now). This is the MAIN ranking; the biggest gaps lead.
      PAIRS28.forEach(function (p) { var ab = p.split('_'); if (vals[ab[0]] != null && vals[ab[1]] != null) arr.push({ b: ab[0], q: ab[1], d: vals[ab[0]] - vals[ab[1]] }); });
      arr.sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d); });
      var h = '<div style="font-weight:800;margin-bottom:2px">' + eatHM(ms) + ' EAT</div>'
        + '<div class="mut" style="font-size:10px;margin-bottom:5px">Top 5 pairs by currency-% spread — buyers vs sellers</div>';
      arr.slice(0, 5).forEach(function (o) {
        var up = o.d >= 0, cc = up ? 'var(--up)' : 'var(--dn)', ar = up ? '▲' : '▼', side = up ? 'buyers' : 'sellers';
        h += '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:1px 0">'
          + '<span><b style="color:' + (col[o.b] || '#ccc') + '">' + o.b + '</b><span class="mut">/</span><b style="color:' + (col[o.q] || '#ccc') + '">' + o.q + '</b></span>'
          + '<span style="color:' + cc + ';font-weight:700;white-space:nowrap">' + ar + ' ' + (o.d >= 0 ? '+' : '') + o.d.toFixed(2) + '% <span style="font-weight:600;font-size:10px;opacity:.85">' + side + '</span></span>'
          + '</div>';
      });
      // the rest — secondary tier, compact and de-emphasised
      var rest = arr.slice(5);
      if (rest.length) {
        h += '<div class="mut" style="font-size:9px;text-transform:uppercase;letter-spacing:.04em;margin:5px 0 3px;padding-top:4px;border-top:1px solid var(--border)">Others</div>'
          + '<div style="display:flex;flex-wrap:wrap;gap:2px 8px;max-width:232px">';
        rest.forEach(function (o) {
          var cc = o.d >= 0 ? 'var(--up)' : 'var(--dn)';
          h += '<span style="font-size:9.5px;white-space:nowrap;opacity:.9"><b style="color:' + (col[o.b] || '#ccc') + '">' + o.b + '</b><span class="mut">/</span><b style="color:' + (col[o.q] || '#ccc') + '">' + o.q + '</b> <span style="color:' + cc + ';font-weight:700">' + (o.d >= 0 ? '+' : '') + o.d.toFixed(2) + '</span></span>';
        });
        h += '</div>';
      }
      tip.innerHTML = h; tip.style.display = '';
      var wrect = wrap.getBoundingClientRect();
      var left = clientX - wrect.left + 14;
      if (left + tip.offsetWidth > wrect.width - 4) left = (clientX - wrect.left) - tip.offsetWidth - 10;
      if (left < 4) left = 4;
      tip.style.left = left + 'px'; tip.style.top = '8px';
    }
    function leave() { cross.style.display = 'none'; tip.style.display = 'none'; for (var k in dotMap) dotMap[k].style.display = 'none'; }
    svgEl.addEventListener('mousemove', function (ev) { hover(ev.clientX); });
    svgEl.addEventListener('mouseleave', leave);
    svgEl.addEventListener('touchmove', function (ev) { if (ev.touches && ev.touches[0]) hover(ev.touches[0].clientX); }, { passive: true });
    svgEl.addEventListener('touchend', leave);

    // analysis-window highlight: positioned by the movement-section selector (chart stays anchored)
    var winHi = wrap.querySelector('.evoWinHi');
    wrap._highlight = function (sMs, eMs) {
      if (sMs == null || eMs == null) { winHi.style.display = 'none'; return; }
      var xa = X(Math.max(t0, sMs)), xb = X(Math.min(t1, eMs));
      winHi.setAttribute('x', xa.toFixed(1)); winHi.setAttribute('width', Math.max(1, xb - xa).toFixed(1));
      winHi.style.display = '';
    };
    // emphasise one currency's line (dim the rest); null restores all.
    wrap._emphasize = function (ccy) {
      Array.prototype.forEach.call(wrap.querySelectorAll('.evoLine'), function (p) {
        if (!ccy) { p.style.opacity = ''; p.style.strokeWidth = ''; }
        else { var on = p.getAttribute('data-ccy') === ccy; p.style.opacity = on ? '1' : '0.1'; p.style.strokeWidth = on ? '3' : ''; }
      });
      Array.prototype.forEach.call(wrap.querySelectorAll('.evoEndLbl'), function (t) {
        t.style.opacity = !ccy ? '' : (t.getAttribute('data-ccy') === ccy ? '1' : '0.25');
      });
    };
    return wrap;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Movement-quality: Today / Last 4h / Last 1h selector + sortable comparison table.
  // All numbers are percentage points (pp) of the zero-sum index over the selected window —
  // descriptive close-to-close travel, NOT buy/sell volume, order flow, or a trade signal.
  function buildMovementSection(J, col, chartWrap) {
    var mv = J.movement, WINK = ['today', 'h4', 'h1'], W = mv.windows, disp = mv.dispersion || {};
    var ppTol = mv.tol;
    var sel = WINK.filter(function (k) { return W[k] && W[k].available; })[0] || 'today';
    var sortKey = 'dailyPerf', sortDir = -1;

    var ppN = function (x, d) { return x == null ? '—' : (x >= 0 ? '+' : '') + (+x).toFixed(d == null ? 2 : d); };
    var intN = function (x) { return x == null ? '—' : x.toFixed(0); };
    var opp = function (m) { if (!m || !m.ok) return null; return m.direction === 'strengthening' ? m.maxDrawdown : m.direction === 'weakening' ? m.maxRebound : Math.max(m.maxDrawdown, m.maxRebound); };
    var give = function (m) { if (!m || !m.ok) return null; return m.direction === 'strengthening' ? m.currentFromHigh : m.direction === 'weakening' ? m.currentFromLow : Math.max(m.currentFromHigh, m.currentFromLow); };
    var DPL = { 'up-pace-increasing': '↑ faster', 'up-pace-slowing': '↑ slowing', 'up-pace-steady': '↑ steady', 'down-pace-increasing': '↓ faster', 'down-pace-slowing': '↓ slowing', 'down-pace-steady': '↓ steady', 'direction-changed': '⇄ changed' };
    var dpaceTxt = function (m) { if (!m || !m.ok || !m.paceChange) return '<span class="mut">—</span>'; var p = m.paceChange; return '<span title="' + p.recentPace + ' vs ' + p.previousPace + ' pp/h">' + (DPL[p.label] || p.label) + '</span>'; };
    var brdTxt = function (m) { if (!m || !m.ok || !m.breadth) return '—'; var b = m.breadth, c = b.coverage; var inc = c.valid < 7 ? ' <span class="mut" title="incomplete coverage — ' + (c.missing || []).join(', ') + '">(' + c.valid + '/7)</span>' : ''; return '<span style="color:var(--up)">' + b.appreciated + '</span>/<span style="color:var(--dn)">' + b.depreciated + '</span>/' + b.unchanged + inc; };
    var covTxt = function (m) { if (!m) return '—'; if (!m.ok) return '<span class="mut">n/a</span>'; var c = m.coverage; return c.intervals + (c.incomplete ? ' <span style="color:#eab308" title="gap in window — withheld where it matters">⚠</span>' : ''); };
    var m0 = function (e) { return e[sel]; };   // selected-window metric object for a currency row

    // columns: label, tooltip, cell(e)->html, val(e)->sortable number|string, align
    var cols = [
      { k: 'currency', lab: 'Ccy', tip: 'Currency index', cell: function (e) { return '<span style="color:' + (col[e.currency] || '#888') + ';font-weight:700">' + e.currency + '</span>'; }, val: function (e) { return e.currency; }, al: 'left' },
      { k: 'dailyPerf', lab: 'Today %', tip: 'Midnight-anchored % (the chart value) — shown separately so a rolling window is never mistaken for it', cell: function (e) { return '<span style="color:' + (e.dailyPerf > 0 ? 'var(--up)' : e.dailyPerf < 0 ? 'var(--dn)' : 'var(--text-muted)') + '">' + ppN(e.dailyPerf) + '</span>'; }, val: function (e) { return e.dailyPerf == null ? -Infinity : e.dailyPerf; } },
      { k: 'M', lab: 'Net', tip: 'Net movement M = x[n]−x[0] over the selected window (pp)', cell: function (e) { var m = m0(e); return !m || !m.ok ? '—' : '<span style="color:' + (m.M > 0 ? 'var(--up)' : m.M < 0 ? 'var(--dn)' : 'var(--text-muted)') + '">' + ppN(m.M) + '</span>'; }, val: function (e) { var m = m0(e); return m && m.ok ? m.M : -Infinity; } },
      { k: 'efficiency', lab: 'Effic.', tip: 'Directional efficiency = 100·|M|/T (total travel). High = little opposition; a single jump then flat also reads high (close-to-close).', cell: function (e) { var m = m0(e); return !m || !m.ok ? '—' : (m.efficiency == null ? '<span class="mut">no move</span>' : m.efficiency.toFixed(0) + '%'); }, val: function (e) { var m = m0(e); return m && m.ok && m.efficiency != null ? m.efficiency : -Infinity; } },
      { k: 'balance', lab: 'Balance', tip: 'Directional balance = 100·(U−D)/T, −100..+100. Signed twin of efficiency (not an independent confirmation).', cell: function (e) { var m = m0(e); if (!m || !m.ok || m.balance == null) return '—'; return '<span style="color:' + (m.balance > 0 ? 'var(--up)' : m.balance < 0 ? 'var(--dn)' : 'var(--text-muted)') + '">' + (m.balance >= 0 ? '+' : '') + m.balance.toFixed(0) + '</span>'; }, val: function (e) { var m = m0(e); return m && m.ok && m.balance != null ? m.balance : -Infinity; } },
      { k: 'persist', lab: 'U/D/– %', tip: 'Persistence: share of intervals that rose / fell / were flat (frequency, not magnitude). Tolerance ' + ppTol + ' pp.', cell: function (e) { var m = m0(e); return !m || !m.ok ? '—' : '<span style="color:var(--up)">' + intN(m.upPct) + '</span>/<span style="color:var(--dn)">' + intN(m.downPct) + '</span>/' + intN(m.unchangedPct); }, val: function (e) { var m = m0(e); return m && m.ok ? m.upPct : -Infinity; } },
      { k: 'opp', lab: 'Max opp', tip: 'Largest opposing movement: drawdown off a running high (strengthening) or rebound off a running low (weakening), in pp.', cell: function (e) { var v = opp(m0(e)); return v == null ? '—' : v.toFixed(2); }, val: function (e) { var v = opp(m0(e)); return v == null ? -Infinity : v; } },
      { k: 'give', lab: 'Giveback', tip: 'Current give-back from the relevant extreme: distance below the high (strengthening) or above the low (weakening), in pp.', cell: function (e) { var v = give(m0(e)); return v == null ? '—' : v.toFixed(2); }, val: function (e) { var v = give(m0(e)); return v == null ? -Infinity : v; } },
      { k: 'pace', lab: 'Pace', tip: 'Net movement per hour over the window (pp/h).', cell: function (e) { var m = m0(e); return !m || !m.ok || m.pace == null ? '—' : '<span style="color:' + (m.pace > 0 ? 'var(--up)' : m.pace < 0 ? 'var(--dn)' : 'var(--text-muted)') + '">' + ppN(m.pace, 3) + '</span>'; }, val: function (e) { var m = m0(e); return m && m.ok && m.pace != null ? m.pace : -Infinity; } },
      { k: 'dpace', lab: 'Δ pace', tip: 'Change vs the immediately preceding equal-length window (4h/1h only). A slowdown is not a reversal.', cell: function (e) { return dpaceTxt(m0(e)); }, val: function (e) { var m = m0(e); return m && m.ok && m.paceChange ? m.paceChange.delta : -Infinity; } },
      { k: 'brd', lab: 'Breadth ▲/▼/=', tip: 'Underlying 7 pairs over the window, oriented to this currency (base keeps sign, quote flips). Interconnected — not 7 independent confirmations.', cell: function (e) { return brdTxt(m0(e)); }, val: function (e) { var m = m0(e); return m && m.ok && m.breadth ? m.breadth.appreciated : -Infinity; } },
      { k: 'cov', lab: 'n', tip: 'Completed M15 intervals in the window (⚠ = a gap, comparison withheld).', cell: function (e) { return covTxt(m0(e)); }, val: function (e) { var m = m0(e); return m && m.ok ? m.coverage.intervals : -Infinity; } },
    ];

    var card = el('div', 'card'); card.style.marginTop = '14px';
    var head = el('div');
    head.innerHTML = '<div style="font-weight:800;font-size:15px">Movement quality</div>'
      + '<div class="mut" style="font-size:11px;margin:3px 0 8px">Distinguishes a currency that merely moved far from one making consistent, low-opposition progress. '
      + 'Percentage points (pp) of the zero-sum index over the selected window — <b>descriptive</b> close-to-close travel, not buy/sell volume or a trade signal.</div>';
    card.appendChild(head);

    // window selector
    var selBar = el('div'); selBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px';
    var labels = { today: 'Today', h4: 'Last 4h', h1: 'Last 1h' };
    WINK.forEach(function (k) {
      var w = W[k], btn = el('button'); btn.type = 'button';
      var on = k === sel;
      btn.style.cssText = 'padding:4px 11px;border-radius:999px;border:1px solid ' + (on ? 'var(--accent,#6366f1)' : 'var(--border)') + ';background:' + (on ? 'rgba(99,102,241,.14)' : 'transparent') + ';color:var(--text);cursor:pointer;font-size:12px;font-weight:700';
      btn.innerHTML = labels[k] + (w && w.available ? ' <span class="mut" style="font-weight:500">· ' + w.intervals + ' M15</span>' : ' <span class="mut" style="font-weight:500">· n/a</span>');
      if (!w || !w.available) btn.disabled = false;   // still selectable → shows the insufficient-data note
      btn.onclick = function () { sel = k; render(); };
      btn.setAttribute('data-wk', k);
      selBar.appendChild(btn);
    });
    var shortNote = el('span', 'mut'); shortNote.style.cssText = 'font-size:11px;margin-left:4px';
    selBar.appendChild(shortNote);
    card.appendChild(selBar);

    // dispersion identity line
    var dispLine = el('div', 'mut'); dispLine.style.cssText = 'font-size:12px;margin-bottom:8px';
    card.appendChild(dispLine);

    var note = el('div'); card.appendChild(note);
    var tblWrap = el('div'); tblWrap.style.cssText = 'overflow-x:auto'; card.appendChild(tblWrap);
    var detailHost = el('div'); detailHost.style.marginTop = '10px'; card.appendChild(detailHost);
    var expanded = null;

    function ageTxt(ms) { if (ms == null) return '—'; var m = Math.round(ms / 60000); return m < 60 ? m + 'm ago' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago'; }
    function row(lbl, val, tip) { return '<div style="display:flex;justify-content:space-between;gap:12px;padding:1px 0"><span class="mut" title="' + esc(tip || '') + '">' + lbl + '</span><span style="text-align:right">' + val + '</span></div>'; }

    // Factual summary built ONLY from computed values (no confidence %, no thresholds).
    function summaryFor(e) {
      var parts = [], t = e.today, h4 = e.h4, h1 = e.h1;
      if (t && t.ok) parts.push((t.direction === 'strengthening' ? 'Up' : t.direction === 'weakening' ? 'Down' : 'Flat') + ' today ' + ppN(e.dailyPerf) + ' pp'
        + (t.efficiency == null ? '' : ' (efficiency ' + t.efficiency.toFixed(0) + '%)') + '.');
      if (h1 && h1.ok && h1.pace != null) {
        if (t && t.ok && t.M > 0 && h1.pace < 0) parts.push('Latest-hour pace has turned negative (' + ppN(h1.pace, 3) + ' pp/h).');
        else if (t && t.ok && t.M < 0 && h1.pace > 0) parts.push('Latest-hour pace has turned positive (' + ppN(h1.pace, 3) + ' pp/h).');
        else if (h1.paceChange && h1.paceChange.label === 'up-pace-slowing') parts.push('Upward pace is slowing (' + ppN(h1.pace, 3) + ' vs ' + ppN(h1.paceChange.previousPace, 3) + ' pp/h).');
        else if (h1.paceChange && h1.paceChange.label === 'down-pace-slowing') parts.push('Downward pace is easing (' + ppN(h1.pace, 3) + ' pp/h).');
      }
      if (h4 && h4.ok) {
        if (h4.direction === 'strengthening' && h4.currentFromHigh > ppTol) parts.push('Below its 4-hour high by ' + h4.currentFromHigh.toFixed(2) + ' pp.');
        if (h4.direction === 'weakening' && h4.currentFromLow > ppTol) parts.push('Above its 4-hour low by ' + h4.currentFromLow.toFixed(2) + ' pp.');
      }
      return parts.join(' ') || 'Insufficient data for a summary.';
    }

    function winDetailHtml(label, m) {
      if (!m || !m.ok) return '<div style="flex:1;min-width:190px"><div style="font-weight:700;border-bottom:1px solid var(--border);padding-bottom:3px;margin-bottom:4px">' + label + '</div><div class="mut" style="font-size:12px">Insufficient data — ' + esc((m && m.reason) || 'window unavailable') + '.</div></div>';
      var dirC = m.direction === 'strengthening' ? 'var(--up)' : m.direction === 'weakening' ? 'var(--dn)' : 'var(--text-muted)';
      var pc = m.paceChange;
      var h = '<div style="flex:1;min-width:190px;font-size:12px">'
        + '<div style="font-weight:700;border-bottom:1px solid var(--border);padding-bottom:3px;margin-bottom:4px">' + label + (m.coverage && m.coverage.incomplete ? ' <span style="color:#eab308" title="gap in window">⚠</span>' : '') + '</div>'
        + row('Net', '<b style="color:' + (m.M > 0 ? 'var(--up)' : m.M < 0 ? 'var(--dn)' : 'var(--text-muted)') + '">' + ppN(m.M) + ' pp</b>', 'M = x[n] − x[0]')
        + row('Direction', '<span style="color:' + dirC + '">' + m.direction + '</span>', 'Net change vs tolerance ' + ppTol + ' pp')
        + row('Efficiency', m.efficiency == null ? 'no move' : m.efficiency.toFixed(0) + '%', '100·|M|/T — close-to-close survival of travel')
        + row('Balance', m.balance == null ? '—' : (m.balance >= 0 ? '+' : '') + m.balance.toFixed(0), '100·(U−D)/T (signed twin of efficiency)')
        + row('Up / Down share', (m.upwardShare == null ? '—' : m.upwardShare.toFixed(0) + '% / ' + m.downwardShare.toFixed(0) + '%'), 'Shares of observed movement magnitude (not volume)')
        + row('Persistence', '<span style="color:var(--up)">' + m.upIntervals + '↑</span> / <span style="color:var(--dn)">' + m.downIntervals + '↓</span> / ' + m.flatIntervals + '– <span class="mut">(' + intN(m.upPct) + '/' + intN(m.downPct) + '/' + intN(m.unchangedPct) + '%)</span>', 'Interval counts (frequency, tolerance ' + ppTol + ' pp)')
        + row('Max opposing', 'DD ' + ppN(m.maxDrawdown) + ' · RB ' + ppN(m.maxRebound) + ' pp', 'Max give-back off a running high / rally off a running low')
        + row('Give-back now', (m.direction === 'weakening' ? ('+' + m.currentFromLow.toFixed(2) + ' off low') : (m.currentFromHigh.toFixed(2) + ' off high')) + ' pp'
          + (m.R > 0 ? ' <span class="mut">(' + (m.direction === 'weakening' ? m.normFromLow : m.normFromHigh) + '% of range)</span>' : ''), 'Current distance from the relevant extreme; normalised to the window range')
        + row('Range', ppN(m.R) + ' pp', 'high − low over the window')
        + row('High / Low', ppN(m.high) + ' <span class="mut">(' + ageTxt(m.highAgeMs) + ')</span> · ' + ppN(m.low) + ' <span class="mut">(' + ageTxt(m.lowAgeMs) + ')</span>', 'Elapsed since the window high / low — not a recovery time')
        + row('Pace', m.pace == null ? '—' : ppN(m.pace, 3) + ' pp/h', 'M / elapsed hours')
        + (pc ? row('Δ pace', (pc.label.replace(/-/g, ' ')) + ' <span class="mut">(' + ppN(pc.recentPace, 3) + ' vs ' + ppN(pc.previousPace, 3) + ')</span>', 'vs the preceding equal window') : '')
        + (m.breadth ? row('Breadth', '<span style="color:var(--up)">' + m.breadth.appreciated + '▲</span>/<span style="color:var(--dn)">' + m.breadth.depreciated + '▼</span>/' + m.breadth.unchanged + '=' + (m.breadth.coverage.valid < 7 ? ' <span class="mut">(' + m.breadth.coverage.valid + '/7)</span>' : ''), 'Oriented 7 underlying pairs — interconnected, not 7 independent confirmations') : '')
        + row('Intervals', '' + m.n, 'Completed M15 intervals in the window')
        + '</div>';
      return h;
    }

    function methodologyHtml() {
      return 'All values are percentage points (pp) of the zero-sum 1/8 index over the window, rebased to the window open (continuous across midnight). '
        + '<b>M</b>=x[n]−x[0]. <b>U/D</b>=sum of up/down interval moves, <b>T</b>=U+D. <b>Efficiency</b>=100·|M|/T (close-to-close; a single jump then flat reads high). '
        + '<b>Balance</b>=100·(U−D)/T is the signed twin of efficiency — not an independent confirmation. <b>Persistence</b> is interval frequency (tolerance ' + ppTol + ' pp), separate from magnitude. '
        + '<b>Opposing movement</b> is the max draw-down off a running high / rally off a running low; <b>give-back</b> is the current distance from the relevant extreme, also shown as % of the window range. '
        + '<b>Breadth</b> orients each currency\'s 7 underlying pairs (base keeps sign, quote flips) from actual pair returns. These are descriptive — not buy/sell volume, order flow, or validated predictions.';
    }

    function renderDetail(ccy) {
      var e = mv.perCurrency.filter(function (r) { return r.currency === ccy; })[0];
      if (!e) { detailHost.innerHTML = ''; return; }
      var cols3 = ['today', 'h4', 'h1'].map(function (k) { return winDetailHtml(labels[k], e[k]); }).join('');
      detailHost.innerHTML =
        '<div style="border:1px solid var(--accent,#6366f1);border-radius:10px;padding:10px;background:rgba(99,102,241,.04)">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
        + '<div style="font-weight:800"><span style="width:11px;height:11px;border-radius:50%;background:' + (col[ccy] || '#888') + ';display:inline-block;margin-right:6px"></span>' + ccy + ' — movement detail · all three windows</div>'
        + '<button type="button" class="mvDetClose" style="background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--text);cursor:pointer;font-size:11px;padding:2px 8px">✕ close</button>'
        + '</div>'
        + '<div style="font-size:12.5px;margin-bottom:8px">' + summaryFor(e) + '</div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:14px">' + cols3 + '</div>'
        + '<details style="margin-top:8px"><summary class="mut" style="font-size:11px;cursor:pointer">Formulas &amp; units</summary>'
        + '<div class="mut" style="font-size:11px;line-height:1.6;margin-top:4px">' + methodologyHtml() + '</div></details>'
        + '</div>';
      var cb = detailHost.querySelector('.mvDetClose');
      if (cb) cb.onclick = function () { expanded = null; detailHost.innerHTML = ''; if (chartWrap && chartWrap._emphasize) chartWrap._emphasize(null); render(); };
    }

    function render() {
      // selector styling
      Array.prototype.forEach.call(selBar.querySelectorAll('button[data-wk]'), function (b) {
        var on = b.getAttribute('data-wk') === sel;
        b.style.borderColor = on ? 'var(--accent,#6366f1)' : 'var(--border)';
        b.style.background = on ? 'rgba(99,102,241,.14)' : 'transparent';
      });
      var w = W[sel];
      shortNote.innerHTML = w && w.shortSample ? '⚠ short sample (4 intervals)' : '';
      if (chartWrap && chartWrap._highlight) chartWrap._highlight(w ? w.startMs : null, w ? w.endMs : null);

      // dispersion identity (strongest/weakest + change over the selected window)
      var ch = disp.change ? disp.change[sel] : null;
      dispLine.innerHTML = 'Dispersion now <b style="color:var(--text)">' + ppN(disp.current) + ' pp</b>'
        + (disp.strongest ? ' · strongest <b style="color:' + (col[disp.strongest] || '#888') + '">' + disp.strongest + '</b> vs weakest <b style="color:' + (col[disp.weakest] || '#888') + '">' + disp.weakest + '</b>' : '')
        + ' · max today ' + ppN(disp.maxToday) + ' pp' + (disp.maxMs ? ' @ ' + eatHM(disp.maxMs) : '')
        + (ch != null ? ' · change over ' + labels[sel] + ' <b style="color:' + (ch > 0 ? 'var(--up)' : ch < 0 ? 'var(--dn)' : 'var(--text-muted)') + '">' + ppN(ch) + ' pp</b>' : '')
        + ' <span title="Dispersion can change because the strongest or weakest currency changes identity, not only because the gap widens.">ⓘ</span>';

      note.innerHTML = (!w || !w.available)
        ? '<div class="state-banner sb-unavail" style="font-size:12px;margin:4px 0">' + labels[sel] + ' — <b>insufficient data</b> (' + ((w && w.reason) || 'needs a complete, contiguous window') + '). Today % is still shown; window metrics are withheld.</div>'
        : '';

      // sorted rows
      var rows = mv.perCurrency.slice().sort(function (a, b) {
        var cDef = cols.filter(function (c) { return c.k === sortKey; })[0] || cols[1];
        var va = cDef.val(a), vb = cDef.val(b);
        if (typeof va === 'string') return sortDir * va.localeCompare(vb);
        return sortDir * (va - vb);
      });

      var th = cols.map(function (c) {
        var active = c.k === sortKey;
        return '<th data-sk="' + c.k + '" title="' + esc(c.tip) + '" style="cursor:pointer;white-space:nowrap;' + (c.al === 'left' ? 'text-align:left;' : '') + (active ? 'color:var(--text)' : '') + '">' + c.lab + (active ? (sortDir < 0 ? ' ▼' : ' ▲') : '') + '</th>';
      }).join('');
      var body = rows.map(function (e) {
        return '<tr data-ccy="' + e.currency + '">' + cols.map(function (c) { return '<td style="' + (c.al === 'left' ? 'text-align:left;' : '') + 'white-space:nowrap">' + c.cell(e) + '</td>'; }).join('') + '</tr>';
      }).join('');
      var tbl = el('table', 'leg'); tbl.style.width = '100%';
      tbl.innerHTML = '<thead><tr>' + th + '</tr></thead><tbody>' + body + '</tbody>';
      Array.prototype.forEach.call(tbl.querySelectorAll('th[data-sk]'), function (h) {
        h.onclick = function () { var k = h.getAttribute('data-sk'); if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = (k === 'currency') ? 1 : -1; } render(); };
      });
      Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (tr) {
        tr.style.cursor = 'pointer';
        tr.title = 'Click to highlight on the chart and open all-window detail';
        if (tr.getAttribute('data-ccy') === expanded) tr.style.background = 'rgba(99,102,241,.08)';
        tr.onclick = function () {
          var ccy = tr.getAttribute('data-ccy');
          if (expanded === ccy) { expanded = null; detailHost.innerHTML = ''; if (chartWrap && chartWrap._emphasize) chartWrap._emphasize(null); }
          else { expanded = ccy; renderDetail(ccy); if (chartWrap && chartWrap._emphasize) chartWrap._emphasize(ccy); }
          Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (r2) { r2.style.background = r2.getAttribute('data-ccy') === expanded ? 'rgba(99,102,241,.08)' : ''; });
        };
      });
      tblWrap.innerHTML = ''; tblWrap.appendChild(tbl);
    }
    render();

    // ── optional two-currency index-spread ──
    var spreadWrap = el('div'); spreadWrap.style.cssText = 'margin-top:12px;border-top:1px solid var(--border);padding-top:10px';
    spreadWrap.innerHTML = '<div style="font-weight:700;font-size:13px;margin-bottom:3px">Two-currency index spread <span class="mut" style="font-weight:500">· optional</span></div>'
      + '<div class="mut" style="font-size:11px;margin-bottom:6px">spread(t) = index A − index B (pp). Movement quality of the <b>index spread</b> — <b>not</b> a tradable pair return, and no "largest winner vs largest loser" is suggested.</div>';
    var CURR = mv.perCurrency.map(function (e) { return e.currency; });
    function mkSel(val) { var s = el('select', 'btn sm'); CURR.forEach(function (c) { var o = el('option', null, c); o.value = c; if (c === val) o.selected = true; s.appendChild(o); }); return s; }
    var selElA = mkSel(disp.strongest || CURR[0]), selElB = mkSel(disp.weakest || CURR[1]);
    var goBtn = el('button', 'btn sm'); goBtn.type = 'button'; goBtn.textContent = 'Compare';
    var ctrl = el('div'); ctrl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center';
    ctrl.appendChild(selElA); ctrl.appendChild(el('span', 'mut', '−')); ctrl.appendChild(selElB); ctrl.appendChild(goBtn);
    spreadWrap.appendChild(ctrl);
    var spOut = el('div'); spOut.style.marginTop = '8px'; spreadWrap.appendChild(spOut);
    function renderSpread(cmp) {
      if (!cmp || !cmp.ok) { spOut.innerHTML = '<div class="mut" style="font-size:12px">' + esc((cmp && cmp.reason) || 'Pick two distinct currencies.') + '</div>'; return; }
      var cols3 = ['today', 'h4', 'h1'].map(function (k) { return winDetailHtml(labels[k], cmp.windows[k]); }).join('');
      spOut.innerHTML = '<div style="font-weight:700;margin-bottom:4px">' + esc(cmp.label) + ' <span class="mut" style="font-weight:500">· index spread analysis</span></div>'
        + '<div style="display:flex;flex-wrap:wrap;gap:14px">' + cols3 + '</div>';
    }
    goBtn.onclick = function () {
      var A = selElA.value, B = selElB.value;
      if (A === B) { spOut.innerHTML = '<div class="mut" style="font-size:12px">Pick two distinct currencies.</div>'; return; }
      spOut.innerHTML = '<div class="mut" style="font-size:12px">Computing ' + A + ' − ' + B + ' spread…</div>';
      var url = '/api/currency-evolution?days=' + (J.windowDays || 120) + (J.mode === 'historical' && J.asOfUtc ? '&asOf=' + Date.parse(J.asOfUtc) : '') + '&compare=' + A + ',' + B;
      fetch(url).then(function (r) { return r.json(); }).then(function (j) { renderSpread(j.movement && j.movement.compare); }).catch(function (e) { spOut.innerHTML = '<div class="mut" style="font-size:12px">Error — ' + esc(e.message || e) + '</div>'; });
    };
    card.appendChild(spreadWrap);
    if (mv.compare) renderSpread(mv.compare);   // initial ?compare=A,B payload

    var foot = el('div', 'mut'); foot.style.cssText = 'font-size:11px;margin-top:8px';
    foot.innerHTML = 'Click a column to sort (active column marked ▼/▲) — a ranking, <b>not</b> a "best trade". '
      + 'Efficiency & balance are two views of the same travel. Breadth\'s 7 pairs are interconnected. Descriptive only — predictive value is <b>not</b> validated.';
    card.appendChild(foot);
    return card;
  }

  function buildSpreadChart(live, sthr) {
    var wrap = el('div', 'card'); wrap.style.cssText = 'padding:10px;margin-top:10px';
    var sp = live.spread || {}, pts = sp.series || [];
    if (pts.length < 2) { wrap.innerHTML = '<div class="mut" style="font-size:12px">Spread (strongest − weakest) — not enough points yet.</div>'; return wrap; }
    var t0 = live.startMs, t1 = live.cutoffMs;
    var W = 920, H = 150, mL = 48, mR = 64, mT = 16, mB = 22;
    var yMax = sthr * 1.3; pts.forEach(function (p) { if (p.spread > yMax) yMax = p.spread; });
    yMax *= 1.08;
    var X = function (ms) { return mL + (ms - t0) / (t1 - t0) * (W - mL - mR); };
    var Y = function (v) { return mT + (yMax - v) / yMax * (H - mT - mB); };
    var s = '<div style="font-weight:700;font-size:12px;margin-bottom:4px">Dispersion over the ' + PWORD + ' — strongest − weakest (%)</div>'
      + '<div class="mut" style="font-size:10px;margin-bottom:4px">Shaded = two-sided episodes (one currency ≥ +' + (sthr / 2).toFixed(2) + '% <b>and</b> another ≤ −' + (sthr / 2).toFixed(2) + '%). Dashed line = ' + sthr.toFixed(2) + '%, the smallest gap such a split can have.</div>';
    s += '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;font-family:inherit">';
    // qualify threshold band (≥ sthr)
    s += '<rect x="' + mL + '" y="' + Y(yMax) + '" width="' + (W - mL - mR) + '" height="' + (Y(sthr) - Y(yMax)) + '" fill="rgba(234,179,8,.08)"/>';
    s += '<line x1="' + mL + '" y1="' + Y(sthr) + '" x2="' + (W - mR) + '" y2="' + Y(sthr) + '" stroke="#eab308" stroke-dasharray="4 4"/>';
    s += '<text x="' + (mL - 6) + '" y="' + (Y(sthr) + 3) + '" text-anchor="end" font-size="10" fill="#eab308">' + sthr.toFixed(2) + '%</text>';
    s += '<text x="' + (mL - 6) + '" y="' + (Y(0) + 3) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">0%</text>';
    // area/line, bright once qualified
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.ms).toFixed(1) + ' ' + Y(p.spread).toFixed(1); }).join(' ');
    s += '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="1.8"/>';
    // shade each qualifying window (apart→back→apart…)
    (sp.windows || []).forEach(function (w) {
      var a = Math.max(t0, w.startMs), b = Math.min(t1, w.endMs); if (!(b >= a)) return;
      var xa = X(a), ww = Math.max(1.5, X(b) - xa);
      s += '<rect x="' + xa + '" y="' + mT + '" width="' + ww + '" height="' + (H - mT - mB) + '" fill="rgba(234,179,8,.10)"/>';
      s += '<line x1="' + xa + '" y1="' + mT + '" x2="' + xa + '" y2="' + (H - mB) + '" stroke="#eab308" stroke-width="1.3" stroke-dasharray="5 3"/>';
    });
    // mark qualified points
    pts.forEach(function (p) { if (p.qual) s += '<circle cx="' + X(p.ms).toFixed(1) + '" cy="' + Y(p.spread).toFixed(1) + '" r="1.6" fill="#eab308"/>'; });
    for (var k = 0; k <= 6; k++) { var tm = t0 + (t1 - t0) * k / 6; s += '<text x="' + X(tm) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10" fill="var(--text-muted)">' + eatHM(tm) + '</text>'; }
    s += '</svg>';
    wrap.innerHTML = s;
    return wrap;
  }

  function buildHeatmap(hist, thr, col) {
    var box = el('div'); box.style.cssText = 'overflow-x:auto';
    var ccys = hist.currencies || [];
    var t = '<table class="leg" style="width:100%;min-width:560px"><thead><tr><th style="text-align:left">Day (EAT)</th><th>⏱ watch</th>';
    ccys.forEach(function (c) { t += '<th><span style="color:' + (col[c] || '#888') + '">' + c + '</span></th>'; });
    t += '</tr></thead><tbody>';
    (hist.matrix || []).forEach(function (row) {
      var wo = (row.watchMinutes != null) ? (minToHHMM(row.watchMinutes) + (row.episodes > 1 ? ' <span style="opacity:.8">×' + row.episodes + '</span>' : '')) : '—';
      t += '<tr><td style="text-align:left">' + rowLabel(row.dayMs) + '</td><td style="color:' + (row.watchMinutes != null ? '#eab308' : 'var(--text-muted)') + '">' + wo + '</td>';
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

  // Per-window CURRENCY STRENGTH OVER TIME: inside each dispersion window (>threshold), each currency's
  // 15m 10-EMA strength (% since the window opened) plotted across the window, plus a snapshot ranking.
  function buildCandleWindows(live, sthr, col) {
    var wrap = el('div', 'card'); wrap.style.marginTop = '14px';
    var wins = live.candleWindows || [];
    var active = wins.filter(function (w) { return w.lines && w.lines.length && w.nSteps > 1; });
    var per = (active[0] && active[0].emaPeriod) || 10;
    wrap.appendChild(el('div', null,
      '<div style="font-weight:700;margin-bottom:2px">Currency strength over time (' + RES + ' ' + per + '-EMA) — while a dispersion episode is open (one ≥ +' + sthr + '%, another ≤ −' + sthr + '%)</div>'
      + '<div class="mut" style="font-size:11px;margin-bottom:8px">Inside each watch window: each currency\'s strength = the ' + per
      + '-period EMA of its % move since the <b>' + OPENLBL + '</b>, on ' + RES + ' candles, tracked across the window (lines carry their real level, not reset to 0). Hollow dots mark each line\'s peak/trough. '
      + 'A <b>0.25% move</b> is flagged three ways: <b>↑/↓ open</b> (reached ±0.25% from the open), <b>⤵ off high</b> (fell 0.25% back from a running high) and <b>⤴ off low</b> (rose 0.25% off a running low) — all within the window. '
      + 'Only currencies whose EMA momentum confirms their side are shown: <b>rising while strong</b> (positive) or <b>falling while weak</b> (negative). Fading currencies (strong but no longer rising, or weak but recovering) are hidden. The reading is at the latest close. MODELLED / UNVALIDATED.</div>'));
    if (!active.length) { wrap.appendChild(el('div', null, '<div class="mut" style="font-size:12px">No two-sided dispersion episode with enough ' + RES + ' points yet.</div>')); return wrap; }

    active.forEach(function (w, wi) {
      var hdr = el('div'); hdr.style.cssText = 'margin:12px 0 6px;font-weight:700;font-size:13px';
      hdr.innerHTML = '⏱ Window #' + (wi + 1) + ' · ' + eatHM(w.startMs) + ' → ' + (w.ongoing ? '<span style="color:var(--up)">now ●</span>' : eatHM(w.endMs)) + ' · ' + w.nSteps + ' ' + RES + ' steps';
      wrap.appendChild(hdr);
      wrap.appendChild(buildStrengthChart(w, col));
      wrap.appendChild(el('div', null, '<div class="mut" style="font-size:11px;margin:8px 0 2px">Qualifying currencies at ' + eatHM(w.endMs) + ' EAT — ranked by momentum (EMA velocity), fastest move first</div>'));
      wrap.appendChild(buildStrengthBars(w, col));
    });
    return wrap;
  }

  // Multi-line SVG: each currency's 15m 10-EMA strength line across one window (strength over time).
  function buildStrengthChart(w, col) {
    var box = el('div', 'card'); box.style.padding = '10px';
    var times = w.times || [], lines = w.lines || [];
    var t0 = times[0], t1 = times[times.length - 1];
    if (!(t1 > t0)) { box.innerHTML = '<div class="mut" style="font-size:12px">Not enough points to plot.</div>'; return box; }
    var W = 920, H = 320, mL = 46, mR = 60, mT = 12, mB = 24;
    var yMax = 0.05, yMin = -0.05;
    lines.forEach(function (ln) { ln.ema.forEach(function (v) { if (v > yMax) yMax = v; if (v < yMin) yMin = v; }); });
    var pad = (yMax - yMin) * 0.08; yMax += pad; yMin -= pad;
    var X = function (ms) { return mL + (ms - t0) / (t1 - t0) * (W - mL - mR); };
    var Y = function (v) { return mT + (yMax - v) / (yMax - yMin) * (H - mT - mB); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;font-family:inherit">';
    [yMax, (yMax) / 2, 0, yMin / 2, yMin].forEach(function (lv) {
      var yy = Y(lv), dash = Math.abs(lv) < 1e-9 ? '' : 'stroke-dasharray="4 4"';
      s += '<line x1="' + mL + '" y1="' + yy + '" x2="' + (W - mR) + '" y2="' + yy + '" stroke="var(--border)" ' + dash + '/>';
      s += '<text x="' + (mL - 6) + '" y="' + (yy + 3) + '" text-anchor="end" font-size="10" fill="var(--text-muted)">' + (lv > 0 ? '+' : '') + lv.toFixed(2) + '%</text>';
    });
    for (var k = 0; k <= 6; k++) { var tm = t0 + (t1 - t0) * k / 6; s += '<text x="' + X(tm) + '" y="' + (H - 7) + '" text-anchor="middle" font-size="10" fill="var(--text-muted)">' + eatHM(tm) + '</text>'; }
    var strBy = {}; (w.strength || []).forEach(function (r) { strBy[r.currency] = r; });
    lines.forEach(function (ln) {
      var d = '';
      for (var i = 0; i < ln.ema.length; i++) { d += (i ? 'L' : 'M') + X(times[i]).toFixed(1) + ' ' + Y(ln.ema[i]).toFixed(1); }
      s += '<path d="' + d + '" fill="none" stroke="' + (col[ln.currency] || '#888') + '" stroke-width="2" opacity="0.95"/>';
      // peak / trough markers (the extremes the 0.25% pullback/bounce are measured from)
      var st = strBy[ln.currency];
      if (st) {
        if (st.peakMs) s += '<circle cx="' + X(st.peakMs).toFixed(1) + '" cy="' + Y(st.peak).toFixed(1) + '" r="2" fill="none" stroke="' + (col[ln.currency] || '#888') + '" stroke-width="1.2"/>';
        if (st.troughMs) s += '<circle cx="' + X(st.troughMs).toFixed(1) + '" cy="' + Y(st.trough).toFixed(1) + '" r="2" fill="none" stroke="' + (col[ln.currency] || '#888') + '" stroke-width="1.2"/>';
      }
      var lx = X(times[times.length - 1]), ly = Y(ln.last);
      s += '<circle cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" r="2.6" fill="' + (col[ln.currency] || '#888') + '"/>';
      s += '<text x="' + (W - mR + 4) + '" y="' + (ly + 3).toFixed(1) + '" font-size="10" fill="' + (col[ln.currency] || '#888') + '">' + ln.currency + '</text>';
    });
    s += '</svg>';
    box.innerHTML = s;
    return box;
  }

  // Diverging horizontal bars: currencies ranked by their 15m 10-EMA strength at the latest close,
  // with each currency's peak/trough and its 0.25% moves (from open, pullback off a high, bounce off a low).
  function buildStrengthBars(w, col) {
    var box = el('div', 'card'); box.style.padding = '12px';
    var thr = w.moveThreshold || 0.25;
    var S = (w.strength || []).filter(function (r) { return r.qualifies; });   // only momentum-confirmed currencies
    if (!S.length) { box.innerHTML = '<div class="mut" style="font-size:12px">No currency qualifies right now — none has EMA momentum confirming its side (rising while strong, or falling while weak).</div>'; return box; }
    // order by MOMENTUM, not absolute level: the fastest-moving currency (steepest EMA slope, either
    // direction) ranks first — so a sharp, fast move outranks a slow drift to the same level.
    S = S.slice().sort(function (a, b) { return Math.abs(b.slope) - Math.abs(a.slope); });
    var maxAbs = 1e-9; S.forEach(function (r) { if (Math.abs(r.strength) > maxAbs) maxAbs = Math.abs(r.strength); });
    var maxSlope = 1e-9; S.forEach(function (r) { if (Math.abs(r.slope) > maxSlope) maxSlope = Math.abs(r.slope); });
    function badge(txt, c, tip) { return '<span title="' + esc(tip) + '" style="display:inline-block;margin-left:5px;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:700;background:' + c + '22;color:' + c + ';border:1px solid ' + c + '55">' + txt + '</span>'; }
    var html = '';
    S.forEach(function (r, mi) {
      var pos = r.strength >= 0;
      var barW = (Math.min(1, Math.abs(r.strength) / maxAbs) * 50).toFixed(1);
      var velW = (Math.min(1, Math.abs(r.slope) / maxSlope) * 100).toFixed(0);
      var arrow = r.rising ? '<span style="color:var(--up)" title="EMA rising (slope ' + pct(r.slope) + ' over ~45m)">▲</span>'
        : '<span style="color:var(--dn)" title="EMA falling (slope ' + pct(r.slope) + ' over ~45m)">▼</span>';
      var qual = badge('✓ qualifies ' + (pos ? '↑ strong' : '↓ weak'), pos ? 'var(--up)' : 'var(--dn)', 'EMA ' + (pos ? 'rising while strong' : 'falling while weak') + ' — momentum confirms the side');
      var vel = badge('vel ' + (r.slope >= 0 ? '+' : '') + r.slope.toFixed(3) + '%/45m', pos ? 'var(--up)' : 'var(--dn)', 'EMA velocity over ~45 min — ranking is by this (fastest move first), not by level');
      var moves = '';
      if (r.reachedUp) moves += badge('↑' + thr + ' open', 'var(--up)', 'peak ' + pct(r.peak) + ' reached +' + thr + '% from the open');
      if (r.reachedDown) moves += badge('↓' + thr + ' open', 'var(--dn)', 'trough ' + pct(r.trough) + ' reached −' + thr + '% from the open');
      if (r.pulledBack) moves += badge('⤵' + r.pullback.toFixed(2) + ' off high', '#eab308', 'fell ' + r.pullback.toFixed(2) + '% from its running high (peak ' + pct(r.peak) + (r.pullbackMs ? ' → ' + eatHM(r.pullbackMs) : '') + ')');
      if (r.bounced) moves += badge('⤴' + r.bounce.toFixed(2) + ' off low', '#eab308', 'rose ' + r.bounce.toFixed(2) + '% from its running low (trough ' + pct(r.trough) + (r.bounceMs ? ' → ' + eatHM(r.bounceMs) : '') + ')');
      html +=
        '<div style="margin:6px 0">'
        + '<div style="display:flex;align-items:center;gap:10px;font-size:13px">'
        + '<div style="width:22px;text-align:right;color:var(--text);font-size:12px;font-weight:700" title="momentum rank (by EMA velocity); global strength rank #' + r.rank + '">' + (mi + 1) + '</div>'
        + '<div style="width:58px;font-weight:700"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + (col[r.currency] || '#888') + ';margin-right:6px"></span>' + r.currency + '</div>'
        + '<div style="flex:1;position:relative;height:18px;background:var(--bg);border-radius:4px;border:1px solid var(--border)" title="EMA velocity (~45m): ' + pct(r.slope) + '">'
        + '<div style="position:absolute;' + (pos ? 'left:0' : 'right:0') + ';top:2px;bottom:2px;width:' + velW + '%;background:' + (pos ? 'var(--up)' : 'var(--dn)') + ';opacity:.22;border-radius:3px"></div>'
        + '<div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--text-muted);opacity:.4"></div>'
        + '<div style="position:absolute;top:2px;bottom:2px;' + (pos ? 'left:50%' : 'right:50%') + ';width:' + barW + '%;background:' + (pos ? 'var(--up)' : 'var(--dn)') + ';border-radius:3px"></div>'
        + '</div>'
        + '<div style="width:80px;text-align:right;font-weight:800;color:' + (pos ? 'var(--up)' : 'var(--dn)') + '">' + arrow + ' ' + pct(r.strength) + '</div>'
        + '<div style="width:62px;text-align:right;color:var(--text-muted);font-size:11px" title="raw, unsmoothed % since the period open">raw ' + pct(r.raw) + '</div>'
        + '</div>'
        + '<div style="margin-left:90px;font-size:10px;color:var(--text-muted);margin-top:1px">' + qual + vel + ' <span style="margin-left:4px">pk <b style="color:var(--up)">' + pct(r.peak) + '</b> · tr <b style="color:var(--dn)">' + pct(r.trough) + '</b></span>' + moves + '</div>'
        + '</div>';
    });
    box.innerHTML = html;
    return box;
  }
})();
