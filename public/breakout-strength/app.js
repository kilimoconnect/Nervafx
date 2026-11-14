'use strict';
/* NervaFX — Breakout Strength & Signals UI. Research, EAT-aligned, UNVALIDATED. Signals only. */
(function () {
  var S = window.NFX_BSS || { strat: 'daily', sec: 'strength', days: 60 };
  var host = document.getElementById('host'), datahdr = document.getElementById('datahdr'), banners = document.getElementById('banners');
  var drawer = document.getElementById('drawer'), drawerBody = document.getElementById('drawerBody');
  document.getElementById('drawerX').onclick = function () { drawer.classList.remove('open'); };

  var OV = null;            // overview payload for the active strategy (cached per strat)
  var cache = {};           // strat -> overview
  var STRAT_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  var COL = { USD: '#60a5fa', EUR: '#a78bfa', GBP: '#f472b6', JPY: '#f87171', CHF: '#fb923c', CAD: '#fbbf24', AUD: '#34d399', NZD: '#22d3ee' };

  // ── helpers ────────────────────────────────────────────────────────────────
  function h(tag, attrs, kids) {
    var e = document.createElement(tag); attrs = attrs || {};
    for (var k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k === 'html') e.innerHTML = attrs[k]; else if (k.slice(0, 2) === 'on') e[k] = attrs[k]; else if (attrs[k] != null) e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c == null) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function api(params) {
    var qs = Object.keys(params).filter(function (k) { return params[k] != null && params[k] !== ''; }).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch('/api/breakout-strength?' + qs).then(function (r) { return r.json(); });
  }
  function num(x, d) { return x == null ? '—' : (+x).toFixed(d == null ? 2 : d); }
  function digits(pair) { return (pair && pair.slice(-4) === '_JPY') ? 3 : 5; }
  function px(pair, v) { return v == null ? '—' : (+v).toFixed(digits(pair)); }
  function eat(ms) { if (ms == null) return '—'; var d = new Date(ms + 3 * 3600000), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); }
  function setURL() { history.replaceState(null, '', location.pathname + '?strat=' + S.strat + '&sec=' + S.sec + '&days=' + S.days); }
  function normDir(d) { if (d === 'BUY' || d === 'SELL') return d; if (typeof d === 'number') return d > 0 ? 'BUY' : (d < 0 ? 'SELL' : null); return null; }
  function dirBadge(dir) { var t = normDir(dir); return h('span', { class: 'bias ' + (t || 'no') }, [t || 'none']); }
  function clsTag(c) { return h('span', { class: 'clstag cls-' + c }, [c]); }

  // ── tab wiring ─────────────────────────────────────────────────────────────
  function wireTabs() {
    [].forEach.call(document.querySelectorAll('.viewtabs [data-strat]'), function (b) {
      if (b.getAttribute('data-strat') === S.strat) b.classList.add('active');
      b.onclick = function () { S.strat = b.getAttribute('data-strat'); [].forEach.call(document.querySelectorAll('.viewtabs [data-strat]'), function (x) { x.classList.toggle('active', x === b); }); setURL(); boot(); };
    });
    [].forEach.call(document.querySelectorAll('.subtabs [data-sec]'), function (b) {
      if (b.getAttribute('data-sec') === S.sec) b.classList.add('active');
      b.onclick = function () { S.sec = b.getAttribute('data-sec'); [].forEach.call(document.querySelectorAll('.subtabs [data-sec]'), function (x) { x.classList.toggle('active', x === b); }); setURL(); render(); };
    });
  }

  function byPair(arr) { var m = {}; (arr || []).forEach(function (r) { m[r.pair] = r; }); return m; }

  // ── currency strength ──────────────────────────────────────────────────────
  function renderStrength(o) {
    var wrap = h('div', {});
    var complete = (o.status && o.status.currenciesComplete) || 0;
    wrap.appendChild(h('div', { class: 'note mut', html: 'Scores from the ' + o.meta.dirTf + ' break of each pair, as of <b>' + eat(o.cutoffMs) + ' EAT</b>. ' + complete + '/8 currencies have all seven legs known' + (complete === 8 ? ' — the eight scores sum to zero.' : ' (an unknown leg makes a currency <i>insufficient</i>, not neutral).') + ' Threshold for strong/weak: <b>' + o.meta.threshold + '</b> of 7. Click a currency for its seven contributions.' }));
    var grid = h('div', { class: 'strengthgrid' });
    var ps = byPair(o.pairStates);
    (o.strength || []).forEach(function (c) {
      var bullW = (c.bull / 7 * 100), bearW = (c.bear / 7 * 100);
      var card = h('div', { class: 'ccard', onclick: function () { openStrengthDetail(c, ps, o); } }, [
        h('div', { class: 'top' }, [
          h('span', { class: 'dot', style: 'background:' + (COL[c.currency] || '#888') }),
          h('span', { class: 'ccy' }, [c.currency]),
          h('span', { class: 'score ' + (c.score > 0 ? 'up' : (c.score < 0 ? 'dn' : 'mut')) }, [c.score == null ? '—' : (c.score > 0 ? '+' : '') + c.score])
        ]),
        h('div', { style: 'margin-top:6px' }, [clsTag(c.classification)]),
        h('div', { class: 'breadth' }, [h('span', { class: 'b-bull', style: 'width:' + bullW + '%' }), h('span', { class: 'b-bear', style: 'width:' + bearW + '%' })]),
        h('div', { class: 'cnt' }, [c.complete ? (c.bull + ' bullish / ' + c.bear + ' bearish of 7 legs') : ((7 - c.contributions.filter(function (x) { return x.contribution != null; }).length) + ' of 7 legs unknown')])
      ]);
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function openStrengthDetail(c, ps, o) {
    drawer.classList.add('open'); drawerBody.innerHTML = '';
    drawerBody.appendChild(h('div', { html: '<div style="font-weight:800;font-size:17px"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:' + (COL[c.currency] || '#888') + ';margin-right:7px"></span>' + c.currency + ' <span class="' + (c.score > 0 ? 'up' : (c.score < 0 ? 'dn' : 'mut')) + '">' + (c.score == null ? 'insufficient' : (c.score > 0 ? '+' : '') + c.score) + '</span></div>' }));
    drawerBody.appendChild(h('div', { style: 'margin:6px 0' }, [clsTag(c.classification), h('span', { class: 'mut', style: 'margin-left:8px;font-size:12px' }, [STRAT_LABEL[S.strat] + ' · ' + o.meta.dirTf + ' structure · threshold ' + o.meta.threshold + '/7'])]));
    drawerBody.appendChild(h('div', { class: 'note mut', style: 'margin:6px 0 10px' }, [c.complete ? (c.bull + ' legs vote the currency up, ' + c.bear + ' vote it down (score = up − down).') : 'One or more legs are unknown, so this currency is excluded from qualification until its history fills in.']));
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Pair', 'Role', 'Break (' + o.meta.dirTf + ')', 'Boundary', 'Age', 'Vote'].map(function (x) { return h('th', {}, [x]); }))])]);
    var tb = h('tbody', {});
    (c.contributions || []).forEach(function (g) {
      var st = ps[g.pair] || {};
      var voteTxt = g.contribution == null ? 'unknown' : (g.contribution > 0 ? '+1 up' : '−1 down');
      var voteCls = g.contribution == null ? 'mut' : (g.contribution > 0 ? 'up' : 'dn');
      var dirTxt = st.direction == null ? '—' : (st.direction > 0 ? 'bull' : (st.direction < 0 ? 'bear' : (st.reason === 'insufficient-history' ? 'insuff.' : 'none')));
      tb.appendChild(h('tr', {}, [
        h('td', {}, [g.pair]),
        h('td', { class: 'mut' }, [g.sign > 0 ? 'base' : 'quote']),
        h('td', { class: st.direction > 0 ? 'up' : (st.direction < 0 ? 'dn' : 'mut') }, [dirTxt]),
        h('td', { class: 'mut' }, [st.brokenBoundary ? (st.brokenBoundary + ' @ ' + px(g.pair, st.brokenLevel)) : '—']),
        h('td', { class: 'mut' }, [st.ageCandles == null ? '—' : st.ageCandles + 'c']),
        h('td', { class: voteCls }, [voteTxt])
      ]));
    });
    t.appendChild(tb); drawerBody.appendChild(t);
  }

  // ── qualified pairs ────────────────────────────────────────────────────────
  function renderQualified(o) {
    var wrap = h('div', {});
    var q = o.qualified || [], all = o.qualification || [];
    var te = byPair(o.triggerEvals), sigPairs = {}; (o.currentSignals || []).forEach(function (s) { sigPairs[s.pair] = s; });
    wrap.appendChild(h('div', { class: 'note mut', html: '<b>' + q.length + '</b> of 28 pairs qualify (a strong currency against a weak one) as of <b>' + eat(o.cutoffMs) + ' EAT</b>. A qualified pair is a <i>watch</i>, not a signal — a signal needs a fresh ' + o.meta.triggerTf + ' break in the qualified direction. All 28 pairs are listed below; none is hidden or ranked away.' }));
    if (!q.length) wrap.appendChild(h('div', { class: 'card mut' }, ['No pair qualifies right now: no strong currency is currently paired against a weak one at threshold ' + o.meta.threshold + '.']));
    var grid = h('div', { class: 'qgrid' });
    q.forEach(function (r) {
      var ev = te[r.pair] || {}, dec = ev.decision || {};
      var statusEl, sig = sigPairs[r.pair];
      if (sig) statusEl = h('span', { class: 'st sig' }, ['● signal @ ' + eat(sig.triggerCloseMs)]);
      else if (dec.reason === 'no-signal:no-breakout') statusEl = h('span', { class: 'st wait' }, ['waiting · no fresh break']);
      else if (dec.reason === 'no-signal:breakout-against-direction') statusEl = h('span', { class: 'st wait' }, ['break against direction']);
      else if (dec.evaluable === false) statusEl = h('span', { class: 'st no' }, ['cannot evaluate yet']);
      else statusEl = h('span', { class: 'st no' }, [dec.reason || 'waiting']);
      var card = h('div', { class: 'qcard', onclick: function () { openPairDetail(r.pair); } }, [
        h('div', { style: 'display:flex;align-items:center;gap:8px' }, [h('span', { class: 'pr' }, [r.pair]), dirBadge(r.direction)]),
        h('div', { style: 'margin-top:6px' }, [statusEl]),
        h('div', { class: 'qmeta', html:
          r.base + ' ' + spanCls(r.baseClass, r.baseScore) + ' · ' + r.quote + ' ' + spanCls(r.quoteClass, r.quoteScore) + '<br>' +
          'Trigger ' + o.meta.triggerTf + ': ' + (ev.triggerCloseMs ? 'last close ' + eat(ev.triggerCloseMs) : '—') +
          (ev.trigger && ev.trigger.break ? ' · broke ' + ev.trigger.boundary : '') })
      ]);
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    // full 28 qualification table (show-all, no top-N)
    var det = h('details', { class: 'sec' }, [h('summary', { class: 'mut', html: 'Inspect all 28 pairs (qualification matrix)' })]);
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Pair', 'Direction', 'Base', 'Quote', 'Reason'].map(function (x) { return h('th', {}, [x]); }))])]);
    var tb = h('tbody', {});
    all.forEach(function (r) {
      var nd = normDir(r.direction);
      tb.appendChild(h('tr', { class: nd ? 'clk' : '', onclick: nd ? function () { openPairDetail(r.pair); } : null }, [
        h('td', {}, [r.pair + (nd ? ' ★' : '')]),
        h('td', { class: nd === 'BUY' ? 'up' : (nd === 'SELL' ? 'dn' : 'mut') }, [nd || '—']),
        h('td', { html: spanCls(r.baseClass, r.baseScore) + ' ' + r.base }),
        h('td', { html: spanCls(r.quoteClass, r.quoteScore) + ' ' + r.quote }),
        h('td', { class: 'mut' }, [r.reason])
      ]));
    });
    t.appendChild(tb); det.appendChild(t); wrap.appendChild(det);
    return wrap;
  }
  function spanCls(cls, score) { return '<span class="clstag cls-' + cls + '">' + cls.slice(0, 4) + (score == null ? '' : ' ' + (score > 0 ? '+' : '') + score) + '</span>'; }

  // ── signals ────────────────────────────────────────────────────────────────
  function renderSignals(o) {
    var wrap = h('div', {});
    var cur = o.currentSignals || [], rec = o.recentSignals || [];
    wrap.appendChild(h('div', { class: 'note mut', html: 'A <b>confirmed signal</b> = qualified pair + a fresh ' + o.meta.triggerTf + ' break in the qualified direction, re-checked at that candle\'s close. The trigger close is a <b>reference price, not a fill</b>. No stops, targets or sizing.' }));
    wrap.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Signals at the latest trigger close (' + cur.length + ')'])]));
    if (!cur.length) wrap.appendChild(h('div', { class: 'card mut' }, ['No confirmed signal at the latest completed ' + o.meta.triggerTf + ' close.']));
    else wrap.appendChild(signalTable(cur));
    wrap.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Signal history · last ' + S.days + ' days (' + rec.length + ')']), h('div', { class: 'note mut' }, ['Every confirmed signal in the window, each judged at its own trigger close (newest first).'])]));
    if (!rec.length) wrap.appendChild(h('div', { class: 'card mut' }, ['No signals recorded in this window.']));
    else wrap.appendChild(signalTable(rec.slice().reverse()));
    return wrap;
  }
  function signalTable(rows) {
    var head = ['Pair', 'Dir', 'Trigger close (EAT)', 'Broke', 'Ref close', 'Base', 'Quote'];
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, head.map(function (x) { return h('th', {}, [x]); }))])]);
    var tb = h('tbody', {});
    rows.forEach(function (r) {
      tb.appendChild(h('tr', { class: 'clk', onclick: function () { openPairDetail(r.pair); } }, [
        h('td', {}, [r.pair]),
        h('td', { class: r.direction === 'BUY' ? 'up' : 'dn' }, [r.direction]),
        h('td', {}, [eat(r.triggerCloseMs)]),
        h('td', { class: 'mut' }, [(r.brokenBoundary || '—') + (r.brokenLevel != null ? ' @ ' + px(r.pair, r.brokenLevel) : '')]),
        h('td', {}, [px(r.pair, r.referenceClose)]),
        h('td', { class: r.baseScore > 0 ? 'up' : 'dn' }, [r.base + ' ' + (r.baseScore > 0 ? '+' : '') + num(r.baseScore, 0)]),
        h('td', { class: r.quoteScore > 0 ? 'up' : 'dn' }, [r.quote + ' ' + (r.quoteScore > 0 ? '+' : '') + num(r.quoteScore, 0)])
      ]));
    });
    t.appendChild(tb); return t;
  }

  // ── pair detail drawer ─────────────────────────────────────────────────────
  function openPairDetail(pair) {
    drawer.classList.add('open'); drawerBody.innerHTML = '<div class="mut">Loading ' + pair + '…</div>';
    api({ view: 'detail', strategy: S.strat, pair: pair, days: S.days }).then(function (j) {
      if (!j || j.ok === false) { drawerBody.innerHTML = '<div class="mut">Error loading ' + pair + '.</div>'; return; }
      renderPairDetail(j, pair);
    }).catch(function () { drawerBody.innerHTML = '<div class="mut">Failed to load ' + pair + '.</div>'; });
  }
  function renderPairDetail(j, pair) {
    var meta = j.meta, ps = j.pairState || {}, qr = j.qualification || {}, ev = j.triggerEval || {}, dec = (ev && ev.decision) || {};
    var strengthMap = {}; (j.strength || []).forEach(function (s) { strengthMap[s.currency] = s; });
    var base = qr.base || pair.split('_')[0], quote = qr.quote || pair.split('_')[1];
    drawerBody.innerHTML = '';
    var qd = normDir(qr.direction);
    drawerBody.appendChild(h('div', { html: '<div style="font-weight:800;font-size:17px">' + pair + ' ' + (qd ? '<span class="' + (qd === 'BUY' ? 'up' : 'dn') + '">' + qd + '</span>' : '<span class="mut">not qualified</span>') + ' <span class="mut" style="font-size:12px">' + STRAT_LABEL[S.strat] + ' · ' + meta.dirTf + '→' + meta.triggerTf + ' · ' + meta.version + '</span></div>' }));
    drawerBody.appendChild(h('div', { class: 'banner-note', html: 'As of <b>' + eat(j.cutoffMs) + ' EAT</b>. Research signal; a trigger close is a reference price, not a fill. No order was placed.' }));

    // qualification + trigger explanation
    var kv = h('div', { class: 'kv' });
    var rows = [
      [base + ' (base)', clsLine(strengthMap[base], qr.baseClass, qr.baseScore)],
      [quote + ' (quote)', clsLine(strengthMap[quote], qr.quoteClass, qr.quoteScore)],
      ['Qualification', qd ? (qd + ' — ' + qr.reason) : ('excluded — ' + (qr.reason || 'not qualified'))],
      [meta.dirTf + ' structure', ps.direction ? ((ps.direction > 0 ? 'bullish' : 'bearish') + ' break, ' + ps.brokenBoundary + ' @ ' + px(pair, ps.brokenLevel) + ' (' + (ps.ageCandles == null ? '?' : ps.ageCandles) + ' candles ago)') : ('no break — ' + (ps.reason || 'unknown'))],
      [meta.triggerTf + ' trigger', triggerLine(ev, dec, pair)]
    ];
    rows.forEach(function (p) { kv.appendChild(h('span', { class: 'k' }, [p[0]])); kv.appendChild(h('span', { html: p[1] })); });
    drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Decision']), kv]));

    // charts
    var cwrap = h('div', { class: 'cols' });
    var c1 = h('div', {}), c2 = h('div', {});
    c1.appendChild(h('div', { class: 'note mut' }, [meta.dirTf + ' — latest break of structure (direction)']));
    c2.appendChild(h('div', { class: 'note mut' }, [meta.triggerTf + ' — latest trigger candle']));
    var chart1 = h('div', { class: 'dchart' }), chart2 = h('div', { class: 'dchart' });
    c1.appendChild(chart1); c2.appendChild(chart2); cwrap.appendChild(c1); cwrap.appendChild(c2);
    drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Charts (EAT candles, completed only)']), cwrap]));

    // contributions of base & quote
    [base, quote].forEach(function (cc) {
      var sc = strengthMap[cc]; if (!sc) return;
      var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, [cc + ' legs', 'Role', 'Vote'].map(function (x) { return h('th', {}, [x]); }))])]);
      var tb = h('tbody', {});
      (sc.contributions || []).forEach(function (g) { tb.appendChild(h('tr', {}, [h('td', {}, [g.pair]), h('td', { class: 'mut' }, [g.sign > 0 ? 'base' : 'quote']), h('td', { class: g.contribution == null ? 'mut' : (g.contribution > 0 ? 'up' : 'dn') }, [g.contribution == null ? 'unknown' : (g.contribution > 0 ? '+1' : '−1')])])); });
      t.appendChild(tb);
      drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', { html: cc + ' strength — ' + (sc.score == null ? 'insufficient' : (sc.score > 0 ? '+' : '') + sc.score + ' (' + sc.classification + ')') }), t]));
    });

    drawBreakoutChart(chart1, pair, meta.dirTf, j.cutoffMs, 'structure');
    drawBreakoutChart(chart2, pair, meta.triggerTf, j.cutoffMs, 'trigger');
  }
  function clsLine(s, cls, score) { return '<span class="clstag cls-' + (cls || (s && s.classification) || 'neutral') + '">' + (cls || (s && s.classification) || '—') + '</span> score ' + (score != null ? (score > 0 ? '+' : '') + score : (s && s.score != null ? (s.score > 0 ? '+' : '') + s.score : '—')); }
  function triggerLine(ev, dec, pair) {
    if (!ev || !ev.triggerCloseMs) return '<span class="mut">no completed trigger candle yet</span>';
    var brk = ev.trigger && ev.trigger.break ? (ev.trigger.break > 0 ? 'bullish' : 'bearish') + ' break ' + (ev.trigger.boundary || '') + ' @ ' + px(pair, ev.trigger.level) : 'no break';
    var sig = dec.signal ? '<span class="up">→ ' + dec.signal + ' signal</span>' : '<span class="mut">→ ' + (dec.reason || 'no signal') + '</span>';
    return 'close ' + eat(ev.triggerCloseMs) + ' · ' + brk + ' ' + sig;
  }

  function drawBreakoutChart(el, instrument, tf, asOf, kind) {
    if (!window.LightweightCharts) { el.innerHTML = '<div class="mut">chart library unavailable</div>'; return; }
    fetch('/api/breakout-chart?instrument=' + instrument + '&tf=' + tf + '&asOf=' + asOf + '&bars=160').then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.candles || !j.candles.length) { el.innerHTML = '<div class="mut">no chart data for ' + tf + '</div>'; return; }
      var chart = LightweightCharts.createChart(el, { height: 300, layout: { background: { color: 'transparent' }, textColor: '#9aa4b2' }, grid: { vertLines: { color: 'rgba(42,49,72,.4)' }, horzLines: { color: 'rgba(42,49,72,.4)' } }, rightPriceScale: { borderColor: '#2a3148' }, timeScale: { borderColor: '#2a3148', timeVisible: true } });
      var cs = chart.addCandlestickSeries({ upColor: '#16c784', downColor: '#f6465d', wickUpColor: '#16c784', wickDownColor: '#f6465d', borderVisible: false });
      cs.setData(j.candles.map(function (c) { return { time: c.time + 3 * 3600, open: c.open, high: c.high, low: c.low, close: c.close }; }));
      var markers = [];
      if (kind === 'structure' && j.latestBreak && j.latestBreak.direction) {
        var lb = j.latestBreak;
        cs.createPriceLine({ price: lb.brokenLevel, color: lb.direction > 0 ? '#16c784' : '#f6465d', lineWidth: 1, lineStyle: 2, title: 'broken ' + lb.brokenBoundary });
        markers.push({ time: lb.breakOpenSec + 3 * 3600, position: lb.direction > 0 ? 'belowBar' : 'aboveBar', color: lb.direction > 0 ? '#16c784' : '#f6465d', shape: lb.direction > 0 ? 'arrowUp' : 'arrowDown', text: 'break' });
      }
      if (kind === 'trigger' && j.latestCandleBreak && j.latestCandleBreak.direction) {
        var tbk = j.latestCandleBreak;
        cs.createPriceLine({ price: tbk.level, color: tbk.direction > 0 ? '#16c784' : '#f6465d', lineWidth: 1, lineStyle: 2, title: 'broke ' + tbk.boundary });
        markers.push({ time: tbk.openSec + 3 * 3600, position: tbk.direction > 0 ? 'belowBar' : 'aboveBar', color: '#3b82f6', shape: tbk.direction > 0 ? 'arrowUp' : 'arrowDown', text: 'trigger' });
      }
      if (markers.length) cs.setMarkers(markers.sort(function (a, b) { return a.time - b.time; }));
      chart.timeScale().fitContent();
    }).catch(function () { el.innerHTML = '<div class="mut">chart failed to load</div>'; });
  }

  // ── main render ────────────────────────────────────────────────────────────
  function render() {
    if (!OV) return;
    host.innerHTML = '';
    if (!OV.available) { host.appendChild(h('div', { class: 'card mut' }, ['This strategy has no usable data yet: ' + (OV.reason || 'unavailable') + '. MN1 needs more history than D1/W1.'])); return; }
    if (S.sec === 'strength') host.appendChild(renderStrength(OV));
    else if (S.sec === 'qualified') host.appendChild(renderQualified(OV));
    else if (S.sec === 'signals') host.appendChild(renderSignals(OV));
  }

  function statusHdr(o) {
    if (!o.available) return 'No data for ' + STRAT_LABEL[S.strat] + ': ' + (o.reason || 'unavailable') + '.';
    var st = o.status || {};
    return STRAT_LABEL[S.strat] + ' · ' + o.meta.dirTf + '→' + o.meta.triggerTf + ' · as of <b>' + eat(o.cutoffMs) + ' EAT</b> · ' +
      (st.currenciesComplete || 0) + '/8 currencies complete · ' + (st.pairsWithDirection || 0) + '/28 pairs with direction' +
      (st.pairsInsufficientHistory ? ' · ' + st.pairsInsufficientHistory + ' insufficient-history' : '') +
      ' · threshold ' + o.meta.threshold + '/7 · <span class="mut">EAT-aligned, research, UNVALIDATED</span>';
  }

  function boot() {
    datahdr.innerHTML = 'Computing ' + STRAT_LABEL[S.strat] + ' breakout state from EAT candles…';
    host.innerHTML = '<div class="card mut">Loading…</div>';
    banners.innerHTML = '';
    if (cache[S.strat]) { OV = cache[S.strat]; datahdr.innerHTML = statusHdr(OV); render(); return; }
    api({ view: 'overview', strategy: S.strat, days: S.days }).then(function (j) {
      if (!j || j.ok === false) { banners.innerHTML = '<div class="state-banner sb-error">ERROR — ' + ((j && j.error) || 'request failed') + '</div>'; datahdr.textContent = ''; return; }
      cache[S.strat] = j; OV = j;
      datahdr.innerHTML = statusHdr(j);
      render();
    }).catch(function (e) { banners.innerHTML = '<div class="state-banner sb-error">ERROR — ' + (e.message || e) + '</div>'; datahdr.textContent = ''; });
  }

  wireTabs();
  boot();
})();
