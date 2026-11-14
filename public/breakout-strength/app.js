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

  // ── timezone helpers (wall-clock in an IANA zone ⇆ UTC ms) ──────────────────
  var LOCAL_TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  function tzOffMs(utcMs, tz) { try { var m = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs)).forEach(function (p) { m[p.type] = p.value; }); return Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +(m.second || 0)) - utcMs; } catch (e) { return 0; } }
  function wallToUtc(y, mo, d, h, mi, tz) { var g = Date.UTC(y, mo - 1, d, h, mi); for (var i = 0; i < 2; i++) g = Date.UTC(y, mo - 1, d, h, mi) - tzOffMs(g, tz); return g; }
  function utcToWall(ms, tz) { var m = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).forEach(function (p) { m[p.type] = p.value; }); return m.year + '-' + m.month + '-' + m.day + 'T' + m.hour + ':' + m.minute; }

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
  function openPairDetail(pair, asOfMs) {
    drawer.classList.add('open'); drawerBody.innerHTML = '<div class="mut">Loading ' + pair + '…</div>';
    api({ view: 'detail', strategy: S.strat, pair: pair, days: S.days, asOf: asOfMs || null }).then(function (j) {
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

  // ── replay ─────────────────────────────────────────────────────────────────
  var RP = { at: Date.now() - 3 * 86400000, tz: LOCAL_TZ, mode: 'historical', threshold: 5, windowDays: 7, playing: false, speed: 1, timer: null, data: null };
  function stopPlay() { RP.playing = false; if (RP.timer) { clearTimeout(RP.timer); RP.timer = null; } }

  function replayApi(extra) {
    var p = { strategy: S.strat, at: RP.at, tz: RP.tz, mode: RP.mode, windowDays: RP.windowDays };
    if (RP.mode === 'whatif') p.threshold = RP.threshold;
    for (var k in (extra || {})) p[k] = extra[k];
    var qs = Object.keys(p).filter(function (k) { return p[k] != null && p[k] !== ''; }).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
    return fetch('/api/breakout-replay?' + qs).then(function (r) { return r.json(); });
  }

  function renderReplay() {
    var wrap = h('div', {});
    var out = h('div', { id: 'rpout' }, [h('div', { class: 'card mut' }, ['Pick a past moment and load the reconstructed state, or step candle-by-candle.'])]);

    // controls
    var atIn = h('input', { type: 'datetime-local', value: utcToWall(RP.at, RP.tz) });
    var tzSel = h('select', {}, [
      h('option', { value: LOCAL_TZ }, ['Local (' + LOCAL_TZ + ')']),
      h('option', { value: 'Africa/Nairobi' }, ['EAT (UTC+3)']),
      h('option', { value: 'UTC' }, ['UTC'])
    ]); tzSel.value = RP.tz;
    var modeSel = h('select', {}, [h('option', { value: 'historical' }, ['Historical reconstruction']), h('option', { value: 'whatif' }, ['What-if (hypothetical)'])]); modeSel.value = RP.mode;
    var thrSel = h('select', {}, [4, 5, 6, 7].map(function (n) { return h('option', { value: n }, ['threshold ' + n]); })); thrSel.value = RP.threshold; thrSel.disabled = RP.mode !== 'whatif';
    var winIn = h('input', { type: 'number', min: 1, max: 60, value: RP.windowDays, style: 'width:70px' });
    var spdSel = h('select', {}, [[0.5, '0.5×'], [1, '1×'], [2, '2×'], [4, '4×']].map(function (s) { return h('option', { value: s[0] }, [s[1]]); })); spdSel.value = RP.speed;

    function syncTimeLabel() { tl.innerHTML = 'T = <b>' + eat(RP.at) + ' EAT</b> · ' + new Date(RP.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
    var tl = h('div', { class: 'note mut', style: 'margin-top:6px' });

    atIn.onchange = function () { var v = atIn.value; if (!v) return; var m = v.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+)/); if (m) { RP.at = Math.min(wallToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], RP.tz), Date.now()); syncTimeLabel(); } };
    tzSel.onchange = function () { RP.tz = tzSel.value; atIn.value = utcToWall(RP.at, RP.tz); syncTimeLabel(); };
    modeSel.onchange = function () { RP.mode = modeSel.value; thrSel.disabled = RP.mode !== 'whatif'; };
    thrSel.onchange = function () { RP.threshold = +thrSel.value; };
    winIn.onchange = function () { RP.windowDays = Math.max(1, Math.min(60, +winIn.value || 7)); };
    spdSel.onchange = function () { RP.speed = +spdSel.value; };

    var playBtn;
    function field(lab, el) { return h('div', { class: 'rfield' }, [h('label', {}, [lab]), el]); }
    var loadBtn = h('button', { class: 'rbtn primary', onclick: function () { stopPlay(); load({}); } }, ['Load snapshot']);
    var prevBtn = h('button', { class: 'rbtn', onclick: function () { stopPlay(); step('prev'); } }, ['⏮ Prev']);
    var nextBtn = h('button', { class: 'rbtn', onclick: function () { stopPlay(); step('next'); } }, ['Next ⏭']);
    playBtn = h('button', { class: 'rbtn play', onclick: function () { RP.playing ? stopAndLabel() : play(); } }, ['▶ Play']);
    var liveBtn = h('button', { class: 'rbtn', onclick: function () { stopPlay(); S.sec = 'strength'; [].forEach.call(document.querySelectorAll('.subtabs [data-sec]'), function (x) { x.classList.toggle('active', x.getAttribute('data-sec') === 'strength'); }); setURL(); render(); } }, ['Return to live ⟲']);
    function stopAndLabel() { stopPlay(); playBtn.textContent = '▶ Play'; }

    var panel = h('div', { class: 'rpanel' }, [
      h('div', { class: 'rrow' }, [field('Replay time', atIn), field('Timezone', tzSel), field('Window (days)', winIn), field('Mode', modeSel), field('What-if', thrSel)]),
      h('div', { class: 'rrow' }, [loadBtn, prevBtn, nextBtn, playBtn, field('Speed', spdSel), liveBtn]),
      tl
    ]);
    syncTimeLabel();
    wrap.appendChild(h('div', { class: 'banner-warn', html: '<b>Replay is a deterministic as-of recompute</b> — not a filter of today\'s dashboard. It reruns the exact engine on the candles completed by the selected time. Periods before this module existed are a <b>historical reconstruction</b> from stored candles (it cannot prove what the live feed delivered then). <b>What-if</b> applies a chosen threshold to the whole period, clearly hypothetical, and never overwrites recorded signals.' }));
    wrap.appendChild(panel);
    wrap.appendChild(out);

    function setBusy(b) { loadBtn.disabled = prevBtn.disabled = nextBtn.disabled = b; }
    function load(extra) {
      setBusy(true); out.innerHTML = ''; out.appendChild(h('div', { class: 'card mut' }, ['Reconstructing…']));
      replayApi(extra).then(function (j) {
        setBusy(false);
        if (!j || j.ok === false) { out.innerHTML = ''; out.appendChild(h('div', { class: 'state-banner sb-error' }, ['ERROR — ' + ((j && j.error) || 'request failed')])); return; }
        if (j.available === false) { out.innerHTML = ''; out.appendChild(h('div', { class: 'card mut' }, ['No data for this strategy/time: ' + (j.reason || 'unavailable') + '.'])); return; }
        if (!j.replay) { // a step hit the end/start — keep current view, note it
          out.insertBefore(h('div', { class: 'banner-note' }, [j.message || 'No adjacent trigger candle.']), out.firstChild);
          stopAndLabel(); return;
        }
        RP.data = j; RP.at = j.replay.atMs; atIn.value = utcToWall(RP.at, RP.tz); syncTimeLabel();
        renderBlocks(out, j);
      }).catch(function (e) { setBusy(false); out.innerHTML = ''; out.appendChild(h('div', { class: 'state-banner sb-error' }, ['ERROR — ' + (e.message || e)])); });
    }
    function step(dir) { load({ step: dir, from: RP.at }); }
    function play() {
      RP.playing = true; playBtn.textContent = '⏸ Pause';
      var tick = function () {
        if (!RP.playing) return;
        replayApi({ step: 'next', from: RP.at }).then(function (j) {
          if (!RP.playing) return;
          if (!j || j.ok === false || j.available === false) { stopAndLabel(); return; }
          if (!j.replay) { out.insertBefore(h('div', { class: 'banner-note' }, [j.message || 'Reached the last completed trigger candle.']), out.firstChild); stopAndLabel(); return; }
          RP.data = j; RP.at = j.replay.atMs; atIn.value = utcToWall(RP.at, RP.tz); syncTimeLabel(); renderBlocks(out, j);
          RP.timer = setTimeout(tick, Math.max(120, 1000 / RP.speed));
        }).catch(function () { stopAndLabel(); });
      };
      tick();
    }
    return wrap;
  }

  function chip(cls, label) { var m = { strong: 's', weak: 'w', neutral: 'n', insufficient: 'i' }; return h('span', { class: 'chip ' + (m[cls] || 'n') }, [label]); }
  function renderBlocks(out, j) {
    out.innerHTML = '';
    var r = j.replay, m = j.meta;
    out.appendChild(h('div', { class: 'note mut', html: 'Reconstructed state at <b>' + eat(r.atMs) + ' EAT</b> · ' + m.configMode + ' · threshold ' + m.threshold + '/7 · ' + m.dirTf + '→' + m.triggerTf + ' · ' + m.version + (r.atBetweenCloses ? ' · <i>T falls between trigger closes; the latest completed close is ' + eat(r.latestTriggerCloseMs) + '</i>' : '') }));

    // BLOCK 1 — qualification at T
    var b1 = h('div', { class: 'rblock b1' }, [h('span', { class: 'bl' }, ['① Qualification at T'])]);
    var strip = h('div', { class: 'strip' });
    (r.qualificationAtT.strength || []).forEach(function (s) { strip.appendChild(chip(s.classification, s.currency + ' ' + (s.score == null ? '∅' : (s.score > 0 ? '+' : '') + s.score))); });
    b1.appendChild(strip);
    var ql = r.qualificationAtT.qualified || [];
    b1.appendChild(h('div', { class: 'note mut', style: 'margin-top:6px' }, [ql.length + ' of 28 pairs qualify at T (strong vs weak).']));
    if (ql.length) {
      var t1 = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Pair', 'Dir', 'Base', 'Quote'].map(function (x) { return h('th', {}, [x]); }))])]);
      var tb1 = h('tbody', {});
      ql.forEach(function (p) { var nd = normDir(p.direction); tb1.appendChild(h('tr', { class: 'clk', onclick: function () { openPairDetail(p.pair, RP.at); } }, [h('td', {}, [p.pair]), h('td', { class: nd === 'BUY' ? 'up' : 'dn' }, [nd]), h('td', { html: spanCls(p.baseClass, p.baseScore) + ' ' + p.base }), h('td', { html: spanCls(p.quoteClass, p.quoteScore) + ' ' + p.quote })])); });
      t1.appendChild(tb1); b1.appendChild(t1);
    }
    out.appendChild(b1);

    // BLOCK 2 — trigger evaluation at the latest completed trigger close ≤ T
    var b2 = h('div', { class: 'rblock b2' }, [h('span', { class: 'bl' }, ['② Trigger evaluation @ ' + (r.latestTriggerCloseMs ? eat(r.latestTriggerCloseMs) + ' EAT' : '—')])]);
    var sac = r.triggerEvaluation.signalsAtClose || [];
    b2.appendChild(h('div', { class: 'note mut' }, [sac.length ? (sac.length + ' confirmed signal(s) at this trigger close.') : 'No confirmed signal at this trigger close — a qualified pair needs a fresh ' + m.triggerTf + ' break in its direction.']));
    if (sac.length) b2.appendChild(signalTableRP(sac));
    var evs = (r.triggerEvaluation.triggerEvals || []).filter(function (e) { return e.decision && e.decision.reason; });
    if (evs.length) {
      var det = h('details', {}, [h('summary', { class: 'mut', style: 'font-size:11px;margin-top:6px' }, ['Why each qualified pair did / didn\'t fire (' + evs.length + ')'])]);
      var t2 = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Pair', 'Cand', 'Trigger close', 'Break', 'Outcome'].map(function (x) { return h('th', {}, [x]); }))])]);
      var tb2 = h('tbody', {});
      evs.forEach(function (e) { var nd = normDir(e.candidateDir); var brk = e.trigger && e.trigger.break ? (e.trigger.break > 0 ? 'bull ' : 'bear ') + (e.trigger.boundary || '') : 'none'; tb2.appendChild(h('tr', { class: 'clk', onclick: function () { openPairDetail(e.pair, RP.at); } }, [h('td', {}, [e.pair]), h('td', { class: nd === 'BUY' ? 'up' : 'dn' }, [nd]), h('td', { class: 'mut' }, [e.triggerCloseMs ? eat(e.triggerCloseMs) : '—']), h('td', { class: 'mut' }, [brk]), h('td', { class: e.decision.signal ? 'up' : 'mut' }, [e.decision.signal ? '→ ' + e.decision.signal : e.decision.reason])])); });
      t2.appendChild(tb2); det.appendChild(t2); b2.appendChild(det);
    }
    out.appendChild(b2);

    // BLOCK 3 — signals generated earlier in the window
    var win = r.signalsInWindow || [];
    var b3 = h('div', { class: 'rblock b3' }, [h('span', { class: 'bl' }, ['③ Signals earlier in the ' + m.windowDays + '-day window'])]);
    b3.appendChild(h('div', { class: 'note mut' }, [win.length ? (win.length + ' signal(s) in (' + eat(r.atMs - m.windowDays * 86400000) + ' → T], each judged at its own trigger close.') : 'No signals earlier in the window.']));
    if (win.length) b3.appendChild(signalTableRP(win.slice().reverse()));
    out.appendChild(b3);
  }
  function signalTableRP(rows) {
    var head = ['Pair', 'Dir', 'Trigger close (EAT)', 'Broke', 'Ref close', 'Base', 'Quote'];
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, head.map(function (x) { return h('th', {}, [x]); }))])]);
    var tb = h('tbody', {});
    rows.forEach(function (r) {
      tb.appendChild(h('tr', { class: 'clk', onclick: function () { openPairDetail(r.pair, r.triggerCloseMs); } }, [
        h('td', {}, [r.pair]), h('td', { class: r.direction === 'BUY' ? 'up' : 'dn' }, [r.direction]),
        h('td', {}, [eat(r.triggerCloseMs)]), h('td', { class: 'mut' }, [(r.brokenBoundary || '—') + (r.brokenLevel != null ? ' @ ' + px(r.pair, r.brokenLevel) : '')]),
        h('td', {}, [px(r.pair, r.referenceClose)]), h('td', { class: r.baseScore > 0 ? 'up' : 'dn' }, [r.base + ' ' + (r.baseScore > 0 ? '+' : '') + num(r.baseScore, 0)]), h('td', { class: r.quoteScore > 0 ? 'up' : 'dn' }, [r.quote + ' ' + (r.quoteScore > 0 ? '+' : '') + num(r.quoteScore, 0)])
      ]));
    });
    t.appendChild(tb); return t;
  }

  // ── main render ────────────────────────────────────────────────────────────
  function render() {
    stopPlay();
    if (!OV) return;
    host.innerHTML = '';
    if (S.sec === 'replay') { host.appendChild(renderReplay()); return; }
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
