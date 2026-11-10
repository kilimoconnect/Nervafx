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
  var SP = live.spread || {}, THRS = J.spreadThreshold || 0.30;
  function minToHHMM(m) { if (m == null) return '—'; return p2(Math.floor(m / 60)) + ':' + p2(m % 60); }

  // ── header ──
  document.getElementById('datahdr').innerHTML =
    'Today so far — % evolution through ' + eatHM(live.cutoffMs) + ' EAT · day open ' + eatDate(live.startMs) + ' 00:00 EAT · '
    + '<b>best movement</b> = a currency reaching <b>+' + THR + '%</b> or <b>−' + THR + '%</b> · history window ' + (J.windowDays || 120) + 'd · MODELLED / UNVALIDATED';

  document.getElementById('banners').innerHTML =
    '<div class="state-banner sb-unavail" style="border-color:rgba(59,130,246,.4)">Each line is a currency\'s zero-sum 1/8 index as a % from the <b>00:00 EAT</b> day open. '
    + 'Crossing the shaded <b>±' + THR + '%</b> band is a <b>best movement</b> — a relative-movement observation, <b>not</b> a trade signal or probability.</div>';

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
    + '<div><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Episodes today</div><div style="font-size:17px;font-weight:800">' + (SP.episodes || 0) + '</div></div>'
    + '<div><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">First onset</div><div style="font-size:15px;font-weight:700">' + firstTxt + '</div></div>'
    + '<div><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Max spread</div><div style="font-size:15px;font-weight:700">' + pct(SP.max) + (SP.maxMs ? ' <span class="mut">@ ' + eatHM(SP.maxMs) + '</span>' : '') + '</div></div>'
    + '</div>'
    + '<div style="margin-top:10px"><div class="mut" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px">Spread windows (apart → back → apart …)</div><div>' + winTxt + '</div></div>'
    + '<div class="mut" style="font-size:11px;margin-top:8px">“Spreading apart” qualifies when the strongest−weakest gap reaches <b>' + THRS + '%</b> AND at least one currency is beyond <b>±' + THR + '%</b> — a point to start watching trades. Each window opens when the gap qualifies and closes when currencies bunch back; the day can have several. Research only.</div>';
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
  host.appendChild(buildChart(live, THR, COL));
  host.appendChild(buildSpreadChart(live, THRS));

  // ── M15 candle performance while dispersion > threshold (per watch window) ──
  host.appendChild(buildCandleWindows(live, THRS, COL));

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

  // spread / watch-onset summary across history
  var ss = hist.spreadSummary || {};
  hsec.appendChild(el('div', null,
    '<div style="margin-top:14px;padding:10px;border:1px solid var(--border);border-radius:8px">'
    + '<div style="font-weight:700;margin-bottom:3px">Spread onset (time to start watching)</div>'
    + '<div class="mut" style="font-size:12px">Currencies spread apart (gap ≥ ' + THRS + '% with a leader beyond ±' + THR + '%) on <b style="color:var(--text)">' + (ss.daysSpread || 0) + '/' + (ss.daysComplete || 0) + '</b> days (' + (ss.spreadPct == null ? '—' : ss.spreadPct + '%') + '). '
    + 'Typical first onset <b style="color:var(--text)">' + minToHHMM(ss.medianOnsetMin) + ' EAT</b> (median; earliest ' + minToHHMM(ss.earliestOnsetMin) + ', latest ' + minToHHMM(ss.latestOnsetMin) + ' into the day). '
    + (ss.avgEpisodesPerSpreadDay != null ? 'Currencies spread apart and bunch back <b style="color:var(--text)">' + ss.avgEpisodesPerSpreadDay + '×</b> per spread day on average.' : '') + '</div>'
    + '</div>'));

  hsec.appendChild(el('div', null, '<div style="font-weight:700;margin:14px 0 6px">Recent days (↑ reached +' + THR + ', ↓ reached −' + THR + ', ⏱ = first onset EAT · ×N = spread episodes)</div>'));
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
    // spread episodes: shade each "watching" window (apart→back→apart…) + onset lines
    var sp = live.spread || {};
    (sp.windows || []).forEach(function (w, i) {
      var a = Math.max(t0, w.startMs), b = Math.min(t1, w.endMs);
      if (!(b >= a)) return;
      var xa = X(a), xb = X(b), ww = Math.max(1.5, xb - xa);
      s += '<rect x="' + xa + '" y="' + mT + '" width="' + ww + '" height="' + (H - mT - mB) + '" fill="rgba(234,179,8,.10)"/>';
      s += '<line x1="' + xa + '" y1="' + mT + '" x2="' + xa + '" y2="' + (H - mB) + '" stroke="#eab308" stroke-width="1.4" stroke-dasharray="5 3"/>';
      if (!w.ongoing) s += '<line x1="' + xb + '" y1="' + mT + '" x2="' + xb + '" y2="' + (H - mB) + '" stroke="rgba(234,179,8,.5)" stroke-width="1" stroke-dasharray="2 3"/>';
      s += '<text x="' + (xa + 3) + '" y="' + (mT + 11) + '" font-size="10" font-weight="700" fill="#eab308">⏱' + (i + 1) + ' ' + eatHM(w.startMs) + '</text>';
    });
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
    var s = '<div style="font-weight:700;font-size:12px;margin-bottom:4px">Dispersion over the day — strongest − weakest (%)</div>';
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
      t += '<tr><td style="text-align:left">' + eatDate(row.dayMs) + '</td><td style="color:' + (row.watchMinutes != null ? '#eab308' : 'var(--text-muted)') + '">' + wo + '</td>';
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

  // Per-window M15 candle evolution: for each dispersion window (>threshold), a time × currency grid
  // where the cell shows each currency's cumulative % since the window opened, tinted by that candle's
  // own move (green up / red down), with ★ on the candle's strongest mover.
  function buildCandleWindows(live, sthr, col) {
    var wrap = el('div', 'card'); wrap.style.marginTop = '14px';
    var wins = live.candleWindows || [];
    var active = wins.filter(function (w) { return w.candles && w.candles.length; });
    wrap.appendChild(el('div', null,
      '<div style="font-weight:700;margin-bottom:2px">H1 candle evolution — while dispersion ≥ ' + sthr + '%</div>'
      + '<div class="mut" style="font-size:11px;margin-bottom:8px">Inside each watch window: every H1 (hourly) candle\'s currency performance. '
      + 'Number = cumulative % since the window opened; tint = that hour\'s move (green up / red down); ★ = the hour\'s strongest mover. First/last rows may be partial hours. MODELLED / UNVALIDATED.</div>'));
    if (!active.length) { wrap.appendChild(el('div', null, '<div class="mut" style="font-size:12px">No window above ' + sthr + '% yet today — nothing to break down candle-by-candle.</div>')); return wrap; }

    active.forEach(function (w, wi) {
      var hdr = el('div'); hdr.style.cssText = 'margin:12px 0 6px;font-weight:700;font-size:13px';
      hdr.innerHTML = '⏱ Window #' + (wi + 1) + ' · ' + eatHM(w.startMs) + ' → ' + (w.ongoing ? '<span style="color:var(--up)">now ●</span>' : eatHM(w.endMs)) + ' · ' + w.nCandles + ' H1 candles';
      wrap.appendChild(hdr);

      // leaders strip (top 2 / bottom 2 by total move within the window)
      var L = w.leaders || [];
      if (L.length) {
        var top = L[0], bot = L[L.length - 1];
        var strip = el('div'); strip.style.cssText = 'display:flex;flex-wrap:wrap;gap:14px;margin-bottom:6px;font-size:12px';
        strip.innerHTML =
          '<div><span class="mut">Strongest</span> <b style="color:' + (col[top.currency] || '#888') + '">' + top.currency + '</b> ' + pct(top.totalMove) + ' <span class="mut">(led ' + top.candlesLed + '/' + w.nCandles + ')</span></div>'
          + '<div><span class="mut">Weakest</span> <b style="color:' + (col[bot.currency] || '#888') + '">' + bot.currency + '</b> ' + pct(bot.totalMove) + '</div>';
        wrap.appendChild(strip);
      }

      // scale candle tints by the window's largest single-candle move
      var maxAbs = 1e-9;
      w.candles.forEach(function (cd) { cd.rows.forEach(function (r) { if (Math.abs(r.ret) > maxAbs) maxAbs = Math.abs(r.ret); }); });

      var box = el('div'); box.style.cssText = 'overflow:auto;max-height:420px;border:1px solid var(--border);border-radius:8px';
      var ccys = (live.rows || []).map(function (r) { return r.currency; });
      if (!ccys.length && w.candles[0]) ccys = w.candles[0].rows.map(function (r) { return r.currency; });
      // stable column order = alphabetical currency set from the first candle
      ccys = w.candles[0].rows.map(function (r) { return r.currency; }).slice().sort();
      var t = '<table class="leg" style="width:100%;min-width:620px;font-variant-numeric:tabular-nums"><thead><tr><th style="text-align:left;position:sticky;left:0;background:var(--bg)">Candle (EAT)</th>';
      ccys.forEach(function (c) { t += '<th><span style="color:' + (col[c] || '#888') + '">' + c + '</span></th>'; });
      t += '</tr></thead><tbody>';
      w.candles.forEach(function (cd) {
        var byC = {}; cd.rows.forEach(function (r) { byC[r.currency] = r; });
        t += '<tr><td style="text-align:left;position:sticky;left:0;background:var(--bg)">' + eatHM(cd.ms) + '</td>';
        ccys.forEach(function (c) {
          var r = byC[c]; if (!r) { t += '<td class="mut">·</td>'; return; }
          var a = Math.min(0.6, Math.abs(r.ret) / maxAbs * 0.6) + (r.ret !== 0 ? 0.04 : 0);
          var bg = r.ret > 0 ? 'rgba(34,197,94,' + a.toFixed(3) + ')' : r.ret < 0 ? 'rgba(239,68,68,' + a.toFixed(3) + ')' : 'transparent';
          var star = (cd.leader === c) ? '★' : '';
          var tip = c + ' · candle ' + pct(r.ret) + ' · cum ' + pct(r.cum) + ' · rank #' + r.rank;
          t += '<td title="' + esc(tip) + '" style="background:' + bg + ';font-weight:' + (star ? '800' : '500') + '">' + star + (r.cum >= 0 ? '+' : '') + r.cum.toFixed(2) + '</td>';
        });
        t += '</tr>';
      });
      t += '</tbody></table>';
      box.innerHTML = t; wrap.appendChild(box);
    });
    return wrap;
  }
})();
