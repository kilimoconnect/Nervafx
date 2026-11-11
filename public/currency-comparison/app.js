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
    'Click a currency to open its candlestick chart (M15 → Monthly), 7 underlying pairs (click to chart each) and candle history.</div></div>';

  html += '<div class="card"><h2>Limitations</h2><ul class="mut" style="margin:0;padding-left:18px;font-size:12px;line-height:1.6">' +
    j.limitations.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></div>';

  host.innerHTML = html;

  // ---- Chart window (candles + timeframe + selectable indicators) ----------
  var TFS = ['M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN'];
  var asOfParam = (j.mode === 'historical' && j.asOfUtc) ? ('&asOf=' + Date.parse(j.asOfUtc)) : '';
  var CHART = { chart: null, series: null, inst: null, tf: 'H1', label: '', candles: [], hasVolume: false, prec: 5, indSeries: {}, on: { volume: 1 } };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
  // EAT = UTC+3 (no DST). Shift the UTC seconds into EAT wall-clock for display.
  var eatD = function (ts) { return new Date(ts * 1000 + 3 * 3600000); };
  function eatTick(ts, type) { var d = eatD(ts); return (type <= 2) ? (d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]) : (p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes())); }
  function eatFull(ts) { var d = eatD(ts); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ' EAT'; }

  // ---- indicator math (client-side, from the fetched candles) ----
  function sma(c, n) { var out = [], s = 0; for (var i = 0; i < c.length; i++) { s += c[i].close; if (i >= n) s -= c[i - n].close; if (i >= n - 1) out.push({ time: c[i].time, value: s / n }); } return out; }
  function ema(c, n) { if (c.length < n) return []; var k = 2 / (n + 1), out = [], prev; for (var i = 0; i < c.length; i++) { prev = (i === 0) ? c[0].close : (c[i].close * k + prev * (1 - k)); if (i >= n - 1) out.push({ time: c[i].time, value: prev }); } return out; }
  function bollinger(c, n, k) { var up = [], mid = [], lo = []; for (var i = n - 1; i < c.length; i++) { var m = 0, j; for (j = i - n + 1; j <= i; j++) m += c[j].close; m /= n; var v = 0; for (j = i - n + 1; j <= i; j++) { var dd = c[j].close - m; v += dd * dd; } var sd = Math.sqrt(v / n); mid.push({ time: c[i].time, value: m }); up.push({ time: c[i].time, value: m + k * sd }); lo.push({ time: c[i].time, value: m - k * sd }); } return { up: up, mid: mid, lo: lo }; }
  function rsiCalc(c, n) { if (c.length <= n) return []; var out = [], g = 0, l = 0, i; for (i = 1; i <= n; i++) { var d = c[i].close - c[i - 1].close; if (d >= 0) g += d; else l -= d; } g /= n; l /= n; out.push({ time: c[n].time, value: l === 0 ? 100 : 100 - 100 / (1 + g / l) }); for (i = n + 1; i < c.length; i++) { var d2 = c[i].close - c[i - 1].close, gg = d2 > 0 ? d2 : 0, ll = d2 < 0 ? -d2 : 0; g = (g * (n - 1) + gg) / n; l = (l * (n - 1) + ll) / n; out.push({ time: c[i].time, value: l === 0 ? 100 : 100 - 100 / (1 + g / l) }); } return out; }

  var INDICATORS = [
    { key: 'ema20', label: 'EMA 20', color: '#3b82f6' }, { key: 'ema50', label: 'EMA 50', color: '#eab308' },
    { key: 'ema200', label: 'EMA 200', color: '#a855f7' }, { key: 'sma20', label: 'SMA 20', color: '#22d3ee' },
    { key: 'sma50', label: 'SMA 50', color: '#f97316' }, { key: 'bb', label: 'Bollinger (20,2)', color: '#64748b' },
    { key: 'rsi', label: 'RSI (14)', color: '#e879f9' }, { key: 'volume', label: 'Volume', color: '' },
  ];

  function tfBarHtml() { return TFS.map(function (t) { return '<button class="tfb' + (t === CHART.tf ? ' on' : '') + '" data-tf="' + t + '">' + t + '</button>'; }).join(''); }
  function syncTfBar() { Array.prototype.forEach.call(document.querySelectorAll('#tfbar .tfb'), function (b) { b.classList.toggle('on', b.getAttribute('data-tf') === CHART.tf); }); }
  function indDropHtml() { return INDICATORS.map(function (d) { return '<label><input type="checkbox" data-ind="' + d.key + '"' + (CHART.on[d.key] ? ' checked' : '') + '>' + (d.color ? '<span class="sw" style="background:' + d.color + '"></span>' : '') + d.label + '</label>'; }).join(''); }
  function indCount() { var n = 0; for (var k in CHART.on) if (CHART.on[k]) n++; return n; }

  function buildChartShell() {
    var body = document.getElementById('drawerBody');
    body.innerHTML =
      '<div class="charthdr">' +
        '<div class="chrow"><span id="chTitle" class="chTitle">—</span><span id="chStats" class="chStats mut"></span></div>' +
        '<div class="ctrls"><span class="tfbar" id="tfbar">' + tfBarHtml() + '</span>' +
          '<span class="inddd"><button class="tfb" id="indBtn">Indicators (<span id="indN">' + indCount() + '</span>) ▾</button>' +
          '<div class="inddrop" id="indDrop">' + indDropHtml() + '</div></span>' +
        '</div>' +
      '</div>' +
      '<div id="chartbox" class="chartbox"></div>' +
      '<div id="chartnote" class="mut chartnote">—</div>' +
      '<div id="detailbox"></div>';
    Array.prototype.forEach.call(document.querySelectorAll('#tfbar .tfb'), function (b) {
      b.onclick = function () { CHART.tf = b.getAttribute('data-tf'); syncTfBar(); loadChart(); };
    });
    var indBtn = document.getElementById('indBtn'), indDrop = document.getElementById('indDrop');
    indBtn.onclick = function (e) { e.stopPropagation(); indDrop.classList.toggle('open'); };
    indDrop.onclick = function (e) { e.stopPropagation(); };
    document.addEventListener('click', function () { indDrop.classList.remove('open'); });
    Array.prototype.forEach.call(indDrop.querySelectorAll('input[data-ind]'), function (cb) {
      cb.onchange = function () { CHART.on[cb.getAttribute('data-ind')] = cb.checked ? 1 : 0; document.getElementById('indN').textContent = indCount(); applyIndicators(); };
    });

    if (CHART.chart) { try { CHART.chart.remove(); } catch (e) {} CHART.chart = null; CHART.series = null; CHART.indSeries = {}; }
    if (!window.LightweightCharts) { document.getElementById('chartnote').textContent = 'Chart library unavailable.'; return; }
    var el = document.getElementById('chartbox');
    CHART.chart = LightweightCharts.createChart(el, {
      width: el.clientWidth, height: el.clientHeight || 440,
      layout: { background: { color: 'transparent' }, textColor: '#94a3b8', fontFamily: 'Inter, sans-serif' },
      grid: { vertLines: { color: 'rgba(42,49,72,.5)' }, horzLines: { color: 'rgba(42,49,72,.5)' } },
      rightPriceScale: { borderColor: '#2a3148', scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: '#2a3148', timeVisible: true, secondsVisible: false, tickMarkFormatter: eatTick },
      localization: { timeFormatter: eatFull },
      crosshair: { mode: 0 },
    });
    CHART.series = CHART.chart.addCandlestickSeries({ upColor: '#16c784', downColor: '#f6465d', borderVisible: false, wickUpColor: '#16c784', wickDownColor: '#f6465d' });
    if (!CHART._resize) { CHART._resize = function () { if (CHART.chart) { var e2 = document.getElementById('chartbox'); if (e2) CHART.chart.applyOptions({ width: e2.clientWidth }); } }; window.addEventListener('resize', CHART._resize); }
  }

  function removeIndSeries() { for (var k in CHART.indSeries) { var s = CHART.indSeries[k]; (Array.isArray(s) ? s : [s]).forEach(function (x) { try { CHART.chart.removeSeries(x); } catch (e) {} }); } CHART.indSeries = {}; }
  function addLine(color, data, scaleId) { var o = { color: color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }; if (scaleId) o.priceScaleId = scaleId; var s = CHART.chart.addLineSeries(o); s.setData(data); return s; }

  function applyIndicators() {
    if (!CHART.chart || !CHART.series) return;
    removeIndSeries();
    var c = CHART.candles || [], on = CHART.on;
    var rsiOn = !!on.rsi, volOn = !!on.volume && CHART.hasVolume && c.length;
    CHART.series.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: rsiOn ? 0.40 : (volOn ? 0.20 : 0.06) } });
    if (!c.length) return;
    if (on.ema20) CHART.indSeries.ema20 = addLine('#3b82f6', ema(c, 20));
    if (on.ema50) CHART.indSeries.ema50 = addLine('#eab308', ema(c, 50));
    if (on.ema200) CHART.indSeries.ema200 = addLine('#a855f7', ema(c, 200));
    if (on.sma20) CHART.indSeries.sma20 = addLine('#22d3ee', sma(c, 20));
    if (on.sma50) CHART.indSeries.sma50 = addLine('#f97316', sma(c, 50));
    if (on.bb) { var bb = bollinger(c, 20, 2); CHART.indSeries.bb = [addLine('#64748b', bb.up), addLine('rgba(100,116,139,.6)', bb.mid), addLine('#64748b', bb.lo)]; }
    if (rsiOn) {
      var rs = addLine('#e879f9', rsiCalc(c, 14), 'rsi');
      CHART.chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 0.62, bottom: volOn ? 0.18 : 0.02 } });
      try { rs.createPriceLine({ price: 70, color: 'rgba(148,163,184,.4)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }); rs.createPriceLine({ price: 30, color: 'rgba(148,163,184,.4)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }); } catch (e) {}
      CHART.indSeries.rsi = rs;
    }
    if (volOn) {
      var vs = CHART.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false });
      vs.setData(c.map(function (b) { return { time: b.time, value: b.volume == null ? 0 : b.volume, color: b.close >= b.open ? 'rgba(22,199,132,.45)' : 'rgba(246,70,93,.45)' }; }));
      CHART.chart.priceScale('vol').applyOptions({ scaleMargins: { top: rsiOn ? 0.84 : 0.82, bottom: 0 } });
      CHART.indSeries.volume = vs;
    }
  }

  function statsHtml(c, prec) {
    if (!c.length) return '';
    var first = c[0], last = c[c.length - 1], chg = 100 * (last.close / first.open - 1);
    var hi = -Infinity, lo = Infinity; for (var i = 0; i < c.length; i++) { if (c[i].high > hi) hi = c[i].high; if (c[i].low < lo) lo = c[i].low; }
    var col = chg > 0 ? 'var(--up)' : (chg < 0 ? 'var(--dn)' : 'var(--text-muted)');
    return '<b style="color:' + col + '">' + last.close.toFixed(prec) + '</b> <span style="color:' + col + '">' + (chg > 0 ? '+' : '') + chg.toFixed(2) + '%</span>' +
      ' <span class="mut">· H ' + hi.toFixed(prec) + ' · L ' + lo.toFixed(prec) + ' · ' + c.length + ' ' + CHART.tf + '</span>';
  }

  function loadChart() {
    var note = document.getElementById('chartnote'); document.getElementById('chTitle').textContent = CHART.label + ' · ' + CHART.tf;
    document.getElementById('chStats').innerHTML = '';
    note.textContent = 'Loading ' + CHART.label + ' ' + CHART.tf + '… (aggregated from stored candles)';
    fetch('/api/currency-chart?instrument=' + encodeURIComponent(CHART.inst) + '&tf=' + CHART.tf + asOfParam)
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d || d.ok === false) throw new Error((d && d.error) || 'request failed');
        if (d.available === false || !d.candles || !d.candles.length) { CHART.candles = []; CHART.hasVolume = false; if (CHART.series) { CHART.series.setData([]); applyIndicators(); } note.textContent = 'UNAVAILABLE — ' + (d.reason || 'no candles') + '. No fabricated data shown.'; return; }
        CHART.candles = d.candles; CHART.hasVolume = !!d.hasVolume; CHART.prec = d.precision;
        if (CHART.series) {
          CHART.series.applyOptions({ priceFormat: { type: 'price', precision: d.precision, minMove: Math.pow(10, -d.precision) } });
          CHART.series.setData(d.candles);
          applyIndicators();
          CHART.chart.timeScale().fitContent();
        }
        document.getElementById('chStats').innerHTML = statsHtml(d.candles, d.precision);
        note.textContent = (d.volumeKind ? ('Volume: ' + d.volumeKind + '. ') : (d.kind === 'index' ? 'Volume N/A. ' : '')) +
          (d.firstUtc ? eatFull(Date.parse(d.firstUtc) / 1000).slice(0, 10) : '') + ' → ' + (d.lastUtc ? eatFull(Date.parse(d.lastUtc) / 1000) : '') + ' · ' + d.resolutionNote + ' Times in EAT (UTC+3).';
      }).catch(function (e) { note.textContent = 'ERROR — ' + (e.message || e); });
  }

  function setInstrument(inst, label) { CHART.inst = inst; CHART.label = label; document.getElementById('chTitle').textContent = label + ' · ' + CHART.tf; loadChart(); }

  // ---- Detail drawer: chart + 7 underlying legs + candle history -----------
  function openDetail(ccy) {
    var drawer = document.getElementById('drawer');
    drawer.classList.add('open');
    buildChartShell();
    setInstrument('IDX:' + ccy, ccy + ' index');
    var detailbox = document.getElementById('detailbox');
    detailbox.innerHTML = '<div class="mut">Loading ' + esc(ccy) + '…</div>';
    var q = '?view=' + encodeURIComponent(j.view) +
      (j.mode === 'historical' && j.asOfUtc ? '&asOf=' + Date.parse(j.asOfUtc) : '') + '&currency=' + encodeURIComponent(ccy);
    fetch('/api/currency-comparison' + q).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.detail) { detailbox.innerHTML = '<div class="state-banner sb-unavail">No detail available for ' + esc(ccy) + '.</div>'; return; }
      var det = d.detail, h = '<h2>' + esc(ccy) + ' — underlying & history <span class="mut" style="font-size:11px;text-transform:none;letter-spacing:0">(click a pair to chart it)</span></h2>';
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

      // 7 underlying legs (clickable → chart that pair)
      h += '<h2>Underlying 7 pairs</h2><table class="leg"><thead><tr><th>Pair</th><th>Role</th><th>' + esc(ccy) + ' return</th><th>Class</th></tr></thead><tbody>';
      det.pairs.forEach(function (lg) {
        var cl = lg.classification, c2 = cl === 'appreciated' ? 'var(--up)' : (cl === 'depreciated' ? 'var(--dn)' : 'var(--text-muted)');
        h += '<tr class="legrow" data-pair="' + esc(lg.pair) + '"><td class="lp">' + esc(lg.pair) + '</td><td>' + esc(lg.role || '—') + '</td>' +
          '<td style="color:' + c2 + '">' + (lg.orientedReturnPct == null ? 'N/A' : sign(lg.orientedReturnPct) + '%') + '</td>' +
          '<td style="color:' + c2 + '">' + esc(cl) + '</td></tr>';
      });
      h += '</tbody></table><div class="mut" style="font-size:11px;margin-top:8px">' + esc(det.note) +
        ' Coverage ' + det.coverage.valid + '/7' + (det.coverage.missing.length ? ' (missing: ' + esc(det.coverage.missing.join(', ')) + ')' : '') + '.</div>';
      detailbox.innerHTML = h;
      Array.prototype.forEach.call(detailbox.querySelectorAll('.legrow'), function (tr) {
        tr.onclick = function () { var p = tr.getAttribute('data-pair'); setInstrument(p, p); document.getElementById('chartbox').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
      });
      var backRow = document.createElement('div'); backRow.className = 'mut backidx'; backRow.innerHTML = '↩ <a href="#" id="backIdx">chart ' + esc(ccy) + ' index</a>';
      detailbox.appendChild(backRow);
      document.getElementById('backIdx').onclick = function (ev) { ev.preventDefault(); setInstrument('IDX:' + ccy, ccy + ' index'); };
    }).catch(function (e) { body.innerHTML = '<div class="state-banner sb-error">ERROR — ' + esc(e.message || e) + '</div>'; });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.ccard[data-ccy]'), function (el) {
    var ccy = el.getAttribute('data-ccy');
    el.onclick = function () { openDetail(ccy); };
    el.onkeydown = function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDetail(ccy); } };
  });

  // deep link from the % Evolution / H4 legend: ?open=<CCY> auto-opens that currency's chart drawer
  var openCcy = (location.search.match(/[?&]open=([^&]+)/) || [])[1];
  if (openCcy) {
    openCcy = decodeURIComponent(openCcy).toUpperCase();
    if (j.cards.some(function (c) { return c.currency === openCcy; })) {
      try { openDetail(openCcy); document.getElementById('drawer').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) {}
    }
  }
})();
