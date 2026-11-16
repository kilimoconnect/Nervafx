'use strict';
/* NervaFX — Breakout Strength & Signals UI (v2, Evolution-based). Research, EAT-aligned, UNVALIDATED. Signals only. */
(function () {
  var S = window.NFX_BSS || { strat: 'daily', sec: 'strength', days: 60 };
  var host = document.getElementById('host'), datahdr = document.getElementById('datahdr'), banners = document.getElementById('banners');
  var drawer = document.getElementById('drawer'), drawerBody = document.getElementById('drawerBody');
  document.getElementById('drawerX').onclick = function () { drawer.classList.remove('open'); };

  var OV = null, cache = {};
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
  function sgn(x, d) { if (x == null) return '—'; var v = +x; return (v > 0 ? '+' : '') + v.toFixed(d == null ? 2 : d); }
  function digits(pair) { return (pair && pair.slice(-4) === '_JPY') ? 3 : 5; }
  function px(pair, v) { return v == null ? '—' : (+v).toFixed(digits(pair)); }
  function eat(ms) { if (ms == null) return '—'; var d = new Date(ms + 3 * 3600000), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); }
  function setURL() { history.replaceState(null, '', location.pathname + '?strat=' + S.strat + '&sec=' + S.sec + '&days=' + S.days); }
  function normDir(d) { if (d === 'BUY' || d === 'SELL') return d; if (typeof d === 'number') return d > 0 ? 'BUY' : (d < 0 ? 'SELL' : null); return null; }
  function dirBadge(dir) { var t = normDir(dir); return h('span', { class: 'bias ' + (t || 'no') }, [t || 'none']); }
  function clsTag(c) { return h('span', { class: 'clstag cls-' + (c || 'insufficient') }, [c || '—']); }
  function clsSpan(c) { return '<span class="clstag cls-' + (c || 'insufficient') + '">' + (c || '—') + '</span>'; }
  // movement direction → arrow + color class
  function mv(dir) { if (dir === 'strengthening') return ['▲', 'up']; if (dir === 'weakening') return ['▼', 'dn']; return ['–', 'mut']; }
  function mvCell(w) { if (!w || !w.available) return h('td', { class: 'mut' }, ['n/a']); var a = mv(w.direction); return h('td', { class: a[1] }, [a[0] + ' ' + sgn(w.M, 3) + (w.spansGap ? ' *' : '')]); }
  function effCell(w) { if (!w || !w.available || w.signedEff == null) return h('td', { class: 'mut' }, ['—']); var e = w.signedEff; return h('td', { class: e > 0 ? 'up' : (e < 0 ? 'dn' : 'mut') }, [sgn(e, 2)]); }
  function breadthStr(b) { if (!b) return '—'; return b.appreciated + '↑/' + b.depreciated + '↓' + (b.coverage && b.coverage.valid < 7 ? ' /' + b.coverage.valid : ''); }

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
  function windowsLabel(meta) { var w = meta.windows || {}; return 'fast ' + (w.fast || '?') + ' / slow ' + (w.slow || '?') + ' · period ' + (w.period || '?'); }

  // ── timezone helpers (wall-clock in an IANA zone ⇆ UTC ms) ──────────────────
  var LOCAL_TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
  function tzOffMs(utcMs, tz) { try { var m = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs)).forEach(function (p) { m[p.type] = p.value; }); return Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +(m.second || 0)) - utcMs; } catch (e) { return 0; } }
  function wallToUtc(y, mo, d, hh, mi, tz) { var g = Date.UTC(y, mo - 1, d, hh, mi); for (var i = 0; i < 2; i++) g = Date.UTC(y, mo - 1, d, hh, mi) - tzOffMs(g, tz); return g; }
  function utcToWall(ms, tz) { var m = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).forEach(function (p) { m[p.type] = p.value; }); return m.year + '-' + m.month + '-' + m.day + 'T' + m.hour + ':' + m.minute; }

  // ── Evolution index chart (8 currency % paths from the period baseline) ──────
  function drawEvolutionChart(el, legend, strat, asOf) {
    if (!window.LightweightCharts) { el.innerHTML = '<div class="mut">chart library unavailable</div>'; return; }
    fetch('/api/breakout-chart?view=evolution&strategy=' + strat + (asOf ? '&asOf=' + asOf : '')).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || j.available === false || !j.series) { el.innerHTML = '<div class="mut">no index data</div>'; return; }
      var chart = LightweightCharts.createChart(el, { height: 320, layout: { background: { color: 'transparent' }, textColor: '#9aa4b2' }, grid: { vertLines: { color: 'rgba(42,49,72,.4)' }, horzLines: { color: 'rgba(42,49,72,.4)' } }, rightPriceScale: { borderColor: '#2a3148' }, timeScale: { borderColor: '#2a3148', timeVisible: true } });
      if (legend) legend.innerHTML = '';
      j.series.forEach(function (s) {
        if (!s.ok || !s.points || !s.points.length) return;
        var ls = chart.addLineSeries({ color: COL[s.currency] || '#888', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: s.currency });
        ls.setData(s.points.map(function (p) { return { time: p.sec, value: p.pct }; }));
        if (legend) { var lg = h('span', {}, [h('i', { style: 'background:' + (COL[s.currency] || '#888') }), s.currency + ' ' + sgn(s.last, 2) + '%']); legend.appendChild(lg); }
      });
      chart.timeScale().fitContent();
    }).catch(function () { el.innerHTML = '<div class="mut">index chart failed</div>'; });
  }

  // ── currency condition ───────────────────────────────────────────────────────
  function renderStrength(o) {
    var wrap = h('div', {});
    var complete = (o.status && o.status.currenciesComplete) || 0;
    wrap.appendChild(h('div', { class: 'note mut', html: 'Each currency\'s <b>recent condition</b> from the zero-sum index, as of <b>' + eat(o.cutoffMs) + ' EAT</b>. Windows: <b>' + windowsLabel(o.meta) + '</b>. ' + complete + '/8 currencies have both windows available. A currency is <b>strong</b> when BOTH windows strengthen with breadth ≥ ' + (o.meta.params ? o.meta.params.breadthMin : 5) + '/7 and positive signed efficiency (weak = the mirror); otherwise <i>mixed</i>. Period position is context only. Click a currency for its window detail.' }));

    // Evolution chart
    var ch = h('div', { class: 'echart' }); var lg = h('div', { class: 'legend' });
    wrap.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Evolution — index % from the ' + (o.meta.windows ? o.meta.windows.period : 'period') + ' open (EAT)']), lg, ch]));

    // condition table
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Currency', 'Condition', 'Period %', 'Fast (' + (o.meta.windows ? o.meta.windows.fast : '') + ')', 'Fast eff', 'Fast breadth', 'Slow (' + (o.meta.windows ? o.meta.windows.slow : '') + ')', 'Pace'].map(function (x) { return h('th', {}, [x]); }))])]);
    var tb = h('tbody', {});
    (o.strength || []).forEach(function (c) {
      tb.appendChild(h('tr', { class: 'clk', onclick: function () { openCcyDetail(c, o); } }, [
        h('td', { html: '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + (COL[c.currency] || '#888') + ';margin-right:6px"></span>' + c.currency }),
        h('td', {}, [clsTag(c.classification)]),
        h('td', { class: c.periodPct > 0 ? 'up' : (c.periodPct < 0 ? 'dn' : 'mut') }, [sgn(c.periodPct, 3) + '%']),
        mvCell(c.fast), effCell(c.fast),
        h('td', { class: 'mut' }, [c.fast ? breadthStr(c.fast.breadth) : '—']),
        mvCell(c.slow),
        h('td', { class: 'mut' }, [c.paceChange ? c.paceChange.label : '—'])
      ]));
    });
    t.appendChild(tb); wrap.appendChild(t);
    wrap.appendChild(h('div', { class: 'note mut' }, ['* a window spanning a weekend/holiday closure (the index skips closed periods).']));
    setTimeout(function () { drawEvolutionChart(ch, lg, S.strat, o.mode === 'historical' ? o.cutoffMs : null); }, 0);
    return wrap;
  }

  function openCcyDetail(c, o) {
    drawer.classList.add('open'); drawerBody.innerHTML = '';
    drawerBody.appendChild(h('div', { html: '<div style="font-weight:800;font-size:17px"><span style="display:inline-block;width:11px;height:11px;border-radius:50%;background:' + (COL[c.currency] || '#888') + ';margin-right:7px"></span>' + c.currency + '</div>' }));
    drawerBody.appendChild(h('div', { style: 'margin:6px 0' }, [clsTag(c.classification), h('span', { class: 'mut', style: 'margin-left:8px;font-size:12px' }, [STRAT_LABEL[S.strat] + ' · condition from recent movement · ' + windowsLabel(o.meta)])]));
    drawerBody.appendChild(h('div', { class: 'note mut', style: 'margin:6px 0 10px' }, ['Period position (context): ' + sgn(c.periodPct, 3) + '% since the ' + (o.meta.windows ? o.meta.windows.period : 'period') + ' open · peak ' + sgn(c.periodPeak, 3) + '% / trough ' + sgn(c.periodTrough, 3) + '%.']));
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Window', 'Direction', 'Net move', 'Signed eff', 'Breadth', 'Spans gap'].map(function (x) { return h('th', {}, [x]); }))])]);
    var tb = h('tbody', {});
    [['Fast (' + (o.meta.windows ? o.meta.windows.fast : '') + ')', c.fast], ['Slow (' + (o.meta.windows ? o.meta.windows.slow : '') + ')', c.slow]].forEach(function (p) {
      var w = p[1] || {}; var a = mv(w.direction);
      tb.appendChild(h('tr', {}, [
        h('td', {}, [p[0]]),
        w.available ? h('td', { class: a[1] }, [a[0] + ' ' + w.direction]) : h('td', { class: 'mut' }, [w.reason || 'n/a']),
        h('td', { class: w.M > 0 ? 'up' : (w.M < 0 ? 'dn' : 'mut') }, [sgn(w.M, 3)]),
        h('td', { class: 'mut' }, [w.signedEff == null ? '—' : sgn(w.signedEff, 2)]),
        h('td', { class: 'mut' }, [breadthStr(w.breadth)]),
        h('td', { class: 'mut' }, [w.spansGap ? 'yes' : 'no'])
      ]));
    });
    t.appendChild(tb); drawerBody.appendChild(t);
    if (c.fast && c.fast.breadth && c.fast.breadth.per) {
      var bt = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Fast-window leg', 'Role', 'Oriented %', 'State'].map(function (x) { return h('th', {}, [x]); }))])]);
      var bb = h('tbody', {});
      c.fast.breadth.per.forEach(function (g) { bb.appendChild(h('tr', {}, [h('td', {}, [g.pair]), h('td', { class: 'mut' }, [g.role || '—']), h('td', { class: g.orientedReturnPct > 0 ? 'up' : (g.orientedReturnPct < 0 ? 'dn' : 'mut') }, [g.orientedReturnPct == null ? '—' : sgn(g.orientedReturnPct, 3)]), h('td', { class: g.classification === 'appreciated' ? 'up' : (g.classification === 'depreciated' ? 'dn' : 'mut') }, [g.classification])])); });
      bt.appendChild(bb); drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Fast-window breadth — the 7 legs']), bt]));
    }
  }

  // ── candidates (qualified pairs) ─────────────────────────────────────────────
  function renderQualified(o) {
    var wrap = h('div', {});
    var q = o.qualified || [], all = o.qualification || [];
    var te = byPair(o.triggerEvals), sigPairs = {}; (o.currentSignals || []).forEach(function (s) { sigPairs[s.pair] = s; });
    wrap.appendChild(h('div', { class: 'note mut', html: '<b>' + q.length + '</b> of 28 pairs qualify (strong vs weak, with a widening index spread) as of <b>' + eat(o.cutoffMs) + ' EAT</b>. A candidate is a <i>watch</i>, not a signal — a signal needs a fresh ' + o.meta.triggerTf + ' break in the qualified direction. All 28 are listed below.' }));
    if (!q.length) wrap.appendChild(h('div', { class: 'card mut' }, ['No pair qualifies right now: no strong currency is paired against a weak one with a widening spread.']));
    var grid = h('div', { class: 'qgrid' });
    q.forEach(function (r) {
      var ev = te[r.pair] || {}, dec = ev.decision || {}, statusEl, sig = sigPairs[r.pair];
      if (sig) statusEl = h('span', { class: 'st sig' }, ['● signal @ ' + eat(sig.triggerCloseMs)]);
      else if (ev.spreadOk === false) statusEl = h('span', { class: 'st wait' }, ['spread stopped widening at trigger']);
      else if (dec.reason === 'no-signal:no-breakout') statusEl = h('span', { class: 'st wait' }, ['waiting · no fresh break']);
      else if (dec.reason === 'no-signal:breakout-against-direction') statusEl = h('span', { class: 'st wait' }, ['break against direction']);
      else if (dec.reason === 'no-signal:qualification-lost') statusEl = h('span', { class: 'st wait' }, ['condition lost at trigger']);
      else if (dec.evaluable === false) statusEl = h('span', { class: 'st no' }, ['cannot evaluate yet']);
      else statusEl = h('span', { class: 'st no' }, [(dec.reason || 'waiting')]);
      var sp = r.spread || {};
      var card = h('div', { class: 'qcard', onclick: function () { openPairDetail(r.pair); } }, [
        h('div', { style: 'display:flex;align-items:center;gap:8px' }, [h('span', { class: 'pr' }, [r.pair]), dirBadge(r.direction)]),
        h('div', { style: 'margin-top:6px' }, [statusEl]),
        h('div', { class: 'qmeta', html:
          r.base + ' ' + clsSpan(r.baseClass) + ' · ' + r.quote + ' ' + clsSpan(r.quoteClass) + '<br>' +
          'Spread Δ: fast ' + sgn(sp.fast && sp.fast.M, 3) + ' · slow ' + sgn(sp.slow && sp.slow.M, 3) + '<br>' +
          'Trigger ' + o.meta.triggerTf + ': ' + (ev.triggerCloseMs ? 'last close ' + eat(ev.triggerCloseMs) : '—') + (ev.trigger && ev.trigger.break ? ' · broke ' + ev.trigger.boundary : '') })
      ]);
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    var det = h('details', { class: 'sec' }, [h('summary', { class: 'mut', html: 'Inspect all 28 pairs (qualification matrix)' })]);
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Pair', 'Direction', 'Base', 'Quote', 'Spread widening', 'Reason'].map(function (x) { return h('th', {}, [x]); }))])]);
    var tb = h('tbody', {});
    all.forEach(function (r) {
      var nd = normDir(r.direction), sp = r.spread || {};
      tb.appendChild(h('tr', { class: nd ? 'clk' : '', onclick: nd ? function () { openPairDetail(r.pair); } : null }, [
        h('td', {}, [r.pair + (nd && sp.expanding ? ' ★' : '')]),
        h('td', { class: nd === 'BUY' ? 'up' : (nd === 'SELL' ? 'dn' : 'mut') }, [nd || '—']),
        h('td', { html: clsSpan(r.baseClass) + ' ' + r.base }),
        h('td', { html: clsSpan(r.quoteClass) + ' ' + r.quote }),
        h('td', { class: sp.expanding ? 'up' : 'mut' }, [r.direction ? (sp.expanding ? 'yes' : 'no') : '—']),
        h('td', { class: 'mut' }, [r.reason])
      ]));
    });
    t.appendChild(tb); det.appendChild(t); wrap.appendChild(det);
    return wrap;
  }

  // ── signals ────────────────────────────────────────────────────────────────
  function renderSignals(o) {
    var wrap = h('div', {});
    var cur = o.currentSignals || [], rec = o.recentSignals || [];
    wrap.appendChild(h('div', { class: 'note mut', html: 'A <b>confirmed signal</b> = qualified pair (strong vs weak + widening spread) + a fresh ' + o.meta.triggerTf + ' break in the qualified direction, re-checked at that candle\'s close. The trigger close is a <b>reference price, not a fill</b>. No stops, targets or sizing.' }));
    wrap.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Signals at the latest trigger close (' + cur.length + ')'])]));
    if (!cur.length) wrap.appendChild(h('div', { class: 'card mut' }, ['No confirmed signal at the latest completed ' + o.meta.triggerTf + ' close.']));
    else wrap.appendChild(signalTable(cur));
    wrap.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Signal history · last ' + S.days + ' days (' + rec.length + ')']), h('div', { class: 'note mut' }, ['Every confirmed signal in the window, each judged at its own trigger close (newest first). Methodology: ' + (o.meta.methodology || 'Evolution-qualified breakout') + '.'])]));
    if (!rec.length) wrap.appendChild(h('div', { class: 'card mut' }, ['No signals recorded in this window.']));
    else wrap.appendChild(signalTable(rec.slice().reverse()));
    return wrap;
  }
  function condOf(sig, ccy) { var cs = sig.conditionSnapshot || {}; return cs[ccy] || {}; }
  function signalTable(rows) {
    var head = ['Pair', 'Dir', 'Trigger close (EAT)', 'Broke', 'Ref close', 'Base', 'Quote', 'Spread'];
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, head.map(function (x) { return h('th', {}, [x]); }))])]);
    var tb = h('tbody', {});
    rows.forEach(function (r) {
      var cb = condOf(r, r.base), cq = condOf(r, r.quote), sp = (r.candidateDetail && r.candidateDetail.spread) || {};
      tb.appendChild(h('tr', { class: 'clk', onclick: function () { openPairDetail(r.pair, r.triggerCloseMs); } }, [
        h('td', {}, [r.pair]),
        h('td', { class: r.direction === 'BUY' ? 'up' : 'dn' }, [r.direction]),
        h('td', {}, [eat(r.triggerCloseMs)]),
        h('td', { class: 'mut' }, [(r.brokenBoundary || '—') + (r.brokenLevel != null ? ' @ ' + px(r.pair, r.brokenLevel) : '')]),
        h('td', {}, [px(r.pair, r.referenceClose)]),
        h('td', { html: clsSpan(cb.classification) + ' ' + r.base }),
        h('td', { html: clsSpan(cq.classification) + ' ' + r.quote }),
        h('td', { class: sp.expanding ? 'up' : 'mut' }, [sp.expanding ? 'widening' : '—'])
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
    var condMap = {}; (j.strength || []).forEach(function (s) { condMap[s.currency] = s; });
    var base = qr.base || pair.split('_')[0], quote = qr.quote || pair.split('_')[1];
    drawerBody.innerHTML = '';
    var qd = normDir(qr.direction), sp = qr.spread || {};
    drawerBody.appendChild(h('div', { html: '<div style="font-weight:800;font-size:17px">' + pair + ' ' + (qd ? '<span class="' + (qd === 'BUY' ? 'up' : 'dn') + '">' + qd + '</span>' : '<span class="mut">not qualified</span>') + ' <span class="mut" style="font-size:12px">' + STRAT_LABEL[S.strat] + ' · ' + meta.triggerTf + ' trigger · ' + meta.version + '</span></div>' }));
    drawerBody.appendChild(h('div', { class: 'banner-note', html: 'As of <b>' + eat(j.cutoffMs) + ' EAT</b>. Evolution-qualified breakout (research). A trigger close is a reference price, not a fill. No order was placed.' }));

    var kv = h('div', { class: 'kv' });
    [
      [base + ' (base)', condLine(condMap[base], qr.baseClass)],
      [quote + ' (quote)', condLine(condMap[quote], qr.quoteClass)],
      ['Spread (base−quote)', sp.expanding == null ? '—' : ((sp.expanding ? '<span class="up">widening</span>' : '<span class="mut">not widening</span>') + ' · fast ' + sgn(sp.fast && sp.fast.M, 3) + ' · slow ' + sgn(sp.slow && sp.slow.M, 3))],
      ['Qualification', qd ? (qd + ' — ' + qr.reason) : ('excluded — ' + (qr.reason || 'not qualified'))],
      [meta.triggerTf + ' trigger', triggerLine(ev, dec, pair)],
      [meta.dirTf + ' structure (diag.)', ps.direction ? ((ps.direction > 0 ? 'bullish' : 'bearish') + ' break, ' + ps.brokenBoundary + ' @ ' + px(pair, ps.brokenLevel)) : ('no break — ' + (ps.reason || 'unknown'))]
    ].forEach(function (p) { kv.appendChild(h('span', { class: 'k' }, [p[0]])); kv.appendChild(h('span', { html: p[1] })); });
    drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Decision']), kv]));

    // charts: Evolution index (highlight base/quote) + trigger candles
    var cwrap = h('div', { class: 'cols' });
    var c1 = h('div', {}), c2 = h('div', {});
    c1.appendChild(h('div', { class: 'note mut' }, ['Evolution — index % from the ' + (meta.windows ? meta.windows.period : 'period') + ' open']));
    c2.appendChild(h('div', { class: 'note mut' }, [meta.triggerTf + ' — latest trigger candle']));
    var chart1 = h('div', { class: 'dchart' }), chart2 = h('div', { class: 'dchart' });
    c1.appendChild(chart1); c2.appendChild(chart2); cwrap.appendChild(c1); cwrap.appendChild(c2);
    drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Charts (EAT, completed only)']), cwrap]));

    // base & quote window metrics
    [base, quote].forEach(function (cc) {
      var sc = condMap[cc]; if (!sc) return;
      var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, [cc + ' window', 'Direction', 'Net', 'Signed eff', 'Breadth'].map(function (x) { return h('th', {}, [x]); }))])]);
      var tb = h('tbody', {});
      [['Fast', sc.fast], ['Slow', sc.slow]].forEach(function (p) { var w = p[1] || {}; var a = mv(w.direction); tb.appendChild(h('tr', {}, [h('td', {}, [p[0]]), w.available ? h('td', { class: a[1] }, [a[0] + ' ' + w.direction]) : h('td', { class: 'mut' }, ['n/a']), h('td', { class: w.M > 0 ? 'up' : (w.M < 0 ? 'dn' : 'mut') }, [sgn(w.M, 3)]), h('td', { class: 'mut' }, [w.signedEff == null ? '—' : sgn(w.signedEff, 2)]), h('td', { class: 'mut' }, [breadthStr(w.breadth)])])); });
      t.appendChild(tb);
      drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', { html: cc + ' condition — ' + (sc.classification || '—') }), t]));
    });

    drawEvolutionChart(chart1, null, S.strat, j.cutoffMs);
    drawBreakoutChart(chart2, pair, meta.triggerTf, j.cutoffMs, 'trigger');
  }
  function condLine(s, cls) {
    var c = cls || (s && s.classification) || 'insufficient';
    var period = s && s.periodPct != null ? ' · period ' + sgn(s.periodPct, 2) + '%' : '';
    var fast = s && s.fast && s.fast.available ? ' · fast ' + mv(s.fast.direction)[0] + ' ' + sgn(s.fast.M, 3) : '';
    return clsSpan(c) + period + fast;
  }
  function triggerLine(ev, dec, pair) {
    if (!ev || !ev.triggerCloseMs) return '<span class="mut">no completed trigger candle yet</span>';
    var brk = ev.trigger && ev.trigger.break ? (ev.trigger.break > 0 ? 'bullish' : 'bearish') + ' break ' + (ev.trigger.boundary || '') + ' @ ' + px(pair, ev.trigger.level) : 'no break';
    var sig = ev.fired ? '<span class="up">→ ' + dec.signal + ' signal</span>' : '<span class="mut">→ ' + (ev.spreadOk === false ? 'spread not widening' : (dec.reason || 'no signal')) + '</span>';
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
  var RP = { at: Date.now() - 3 * 86400000, tz: LOCAL_TZ, mode: 'historical', breadthMin: 5, stepMode: 'trigger', windowDays: 7, playing: false, speed: 1, timer: null, data: null };
  function stopPlay() { RP.playing = false; if (RP.timer) { clearTimeout(RP.timer); RP.timer = null; } }

  function replayApi(extra) {
    var p = { strategy: S.strat, at: RP.at, tz: RP.tz, mode: RP.mode, windowDays: RP.windowDays, stepMode: RP.stepMode };
    if (RP.mode === 'whatif') p.breadthMin = RP.breadthMin;
    for (var k in (extra || {})) p[k] = extra[k];
    var qs = Object.keys(p).filter(function (k) { return p[k] != null && p[k] !== ''; }).map(function (k) { return k + '=' + encodeURIComponent(p[k]); }).join('&');
    return fetch('/api/breakout-replay?' + qs).then(function (r) { return r.json(); });
  }

  function renderReplay() {
    var wrap = h('div', {});
    var out = h('div', { id: 'rpout' }, [h('div', { class: 'card mut' }, ['Pick a past moment and load the reconstructed state, or step (Evolution = M15 index closes, Trigger = trigger-candle closes).'])]);

    var atIn = h('input', { type: 'datetime-local', value: utcToWall(RP.at, RP.tz) });
    var tzSel = h('select', {}, [h('option', { value: LOCAL_TZ }, ['Local (' + LOCAL_TZ + ')']), h('option', { value: 'Africa/Nairobi' }, ['EAT (UTC+3)']), h('option', { value: 'UTC' }, ['UTC'])]); tzSel.value = RP.tz;
    var modeSel = h('select', {}, [h('option', { value: 'historical' }, ['Historical reconstruction']), h('option', { value: 'whatif' }, ['What-if (hypothetical)'])]); modeSel.value = RP.mode;
    var bmSel = h('select', {}, [4, 5, 6, 7].map(function (n) { return h('option', { value: n }, ['breadth ' + n + '/7']); })); bmSel.value = RP.breadthMin; bmSel.disabled = RP.mode !== 'whatif';
    var stepSel = h('select', {}, [h('option', { value: 'trigger' }, ['Step: trigger closes']), h('option', { value: 'evolution' }, ['Step: Evolution (M15)'])]); stepSel.value = RP.stepMode;
    var winIn = h('input', { type: 'number', min: 1, max: 60, value: RP.windowDays, style: 'width:70px' });
    var spdSel = h('select', {}, [[0.5, '0.5×'], [1, '1×'], [2, '2×'], [4, '4×']].map(function (s) { return h('option', { value: s[0] }, [s[1]]); })); spdSel.value = RP.speed;

    var tl = h('div', { class: 'note mut', style: 'margin-top:6px' });
    function syncTimeLabel() { tl.innerHTML = 'T = <b>' + eat(RP.at) + ' EAT</b> · ' + new Date(RP.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC · stepping by ' + (RP.stepMode === 'evolution' ? 'M15 index closes' : 'trigger closes'); }

    atIn.onchange = function () { var v = atIn.value; if (!v) return; var m = v.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+)/); if (m) { RP.at = Math.min(wallToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], RP.tz), Date.now()); syncTimeLabel(); } };
    tzSel.onchange = function () { RP.tz = tzSel.value; atIn.value = utcToWall(RP.at, RP.tz); syncTimeLabel(); };
    modeSel.onchange = function () { RP.mode = modeSel.value; bmSel.disabled = RP.mode !== 'whatif'; };
    bmSel.onchange = function () { RP.breadthMin = +bmSel.value; };
    stepSel.onchange = function () { RP.stepMode = stepSel.value; syncTimeLabel(); };
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
      h('div', { class: 'rrow' }, [field('Replay time', atIn), field('Timezone', tzSel), field('Window (days)', winIn), field('Mode', modeSel), field('What-if breadth', bmSel)]),
      h('div', { class: 'rrow' }, [loadBtn, field('Step mode', stepSel), prevBtn, nextBtn, playBtn, field('Speed', spdSel), liveBtn]),
      tl
    ]);
    syncTimeLabel();
    wrap.appendChild(h('div', { class: 'banner-warn', html: '<b>Replay is a deterministic as-of recompute</b> — not a filter of today\'s dashboard. It reruns the exact engine on the candles completed by the selected time. Two stepping modes: <b>Evolution</b> advances one M15 index close at a time (the condition updates every M15); <b>Trigger</b> advances to the next completed trigger candle (where a signal can fire). <b>What-if</b> applies chosen condition params to the whole period, clearly hypothetical, and never overwrites recorded signals.' }));
    wrap.appendChild(panel); wrap.appendChild(out);

    function setBusy(b) { loadBtn.disabled = prevBtn.disabled = nextBtn.disabled = b; }
    function load(extra) {
      setBusy(true); out.innerHTML = ''; out.appendChild(h('div', { class: 'card mut' }, ['Reconstructing…']));
      replayApi(extra).then(function (j) {
        setBusy(false);
        if (!j || j.ok === false) { out.innerHTML = ''; out.appendChild(h('div', { class: 'state-banner sb-error' }, ['ERROR — ' + ((j && j.error) || 'request failed')])); return; }
        if (j.available === false) { out.innerHTML = ''; out.appendChild(h('div', { class: 'card mut' }, ['No data for this strategy/time: ' + (j.reason || 'unavailable') + '.'])); return; }
        if (!j.replay) { out.insertBefore(h('div', { class: 'banner-note' }, [j.message || 'No adjacent close.']), out.firstChild); stopAndLabel(); return; }
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
          if (!j.replay) { out.insertBefore(h('div', { class: 'banner-note' }, [j.message || 'Reached the last completed close.']), out.firstChild); stopAndLabel(); return; }
          RP.data = j; RP.at = j.replay.atMs; atIn.value = utcToWall(RP.at, RP.tz); syncTimeLabel(); renderBlocks(out, j);
          RP.timer = setTimeout(tick, Math.max(120, 1000 / RP.speed));
        }).catch(function () { stopAndLabel(); });
      };
      tick();
    }
    return wrap;
  }

  function chip(cls, label) { var m = { strong: 's', weak: 'w', neutral: 'n', mixed: 'm', insufficient: 'i' }; return h('span', { class: 'chip ' + (m[cls] || 'n') }, [label]); }
  function renderBlocks(out, j) {
    out.innerHTML = '';
    var r = j.replay, m = j.meta;
    out.appendChild(h('div', { class: 'note mut', html: 'Reconstructed state at <b>' + eat(r.atMs) + ' EAT</b> · ' + m.configMode + ' · ' + windowsLabel(m) + ' · ' + m.version + (r.atBetweenCloses ? ' · <i>T falls between trigger closes; the latest completed close is ' + eat(r.latestTriggerCloseMs) + '</i>' : '') }));

    // BLOCK 1 — condition + qualification at T
    var b1 = h('div', { class: 'rblock b1' }, [h('span', { class: 'bl' }, ['① Condition & qualification at T'])]);
    var strip = h('div', { class: 'strip' });
    (r.qualificationAtT.strength || []).forEach(function (s) { strip.appendChild(chip(s.classification, s.currency + ' ' + (s.classification === 'strong' ? '▲' : (s.classification === 'weak' ? '▼' : '·')))); });
    b1.appendChild(strip);
    var ql = r.qualificationAtT.qualified || [];
    b1.appendChild(h('div', { class: 'note mut', style: 'margin-top:6px' }, [ql.length + ' of 28 pairs qualify at T (strong vs weak + widening spread).']));
    if (ql.length) {
      var t1 = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Pair', 'Dir', 'Base', 'Quote', 'Spread'].map(function (x) { return h('th', {}, [x]); }))])]);
      var tb1 = h('tbody', {});
      ql.forEach(function (p) { var nd = normDir(p.direction), sp = p.spread || {}; tb1.appendChild(h('tr', { class: 'clk', onclick: function () { openPairDetail(p.pair, RP.at); } }, [h('td', {}, [p.pair]), h('td', { class: nd === 'BUY' ? 'up' : 'dn' }, [nd]), h('td', { html: clsSpan(p.baseClass) + ' ' + p.base }), h('td', { html: clsSpan(p.quoteClass) + ' ' + p.quote }), h('td', { class: sp.expanding ? 'up' : 'mut' }, [sp.expanding ? 'widening' : '—'])])); });
      t1.appendChild(tb1); b1.appendChild(t1);
    }
    out.appendChild(b1);

    // BLOCK 2 — trigger evaluation at the latest completed trigger close ≤ T
    var b2 = h('div', { class: 'rblock b2' }, [h('span', { class: 'bl' }, ['② Trigger evaluation @ ' + (r.latestTriggerCloseMs ? eat(r.latestTriggerCloseMs) + ' EAT' : '—')])]);
    var sac = r.triggerEvaluation.signalsAtClose || [];
    b2.appendChild(h('div', { class: 'note mut' }, [sac.length ? (sac.length + ' confirmed signal(s) at this trigger close.') : 'No confirmed signal at this trigger close — a qualified pair needs a fresh ' + m.triggerTf + ' break in its direction with the spread still widening.']));
    if (sac.length) b2.appendChild(signalTable(sac));
    var evs = (r.triggerEvaluation.triggerEvals || []).filter(function (e) { return e.decision && e.decision.reason; });
    if (evs.length) {
      var det = h('details', {}, [h('summary', { class: 'mut', style: 'font-size:11px;margin-top:6px' }, ['Why each candidate did / didn\'t fire (' + evs.length + ')'])]);
      var t2 = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Pair', 'Cand', 'Trigger close', 'Break', 'Outcome'].map(function (x) { return h('th', {}, [x]); }))])]);
      var tb2 = h('tbody', {});
      evs.forEach(function (e) { var nd = normDir(e.candidateDir); var brk = e.trigger && e.trigger.break ? (e.trigger.break > 0 ? 'bull ' : 'bear ') + (e.trigger.boundary || '') : 'none'; var outcome = e.fired ? '→ ' + e.decision.signal : (e.spreadOk === false ? 'spread not widening' : e.decision.reason); tb2.appendChild(h('tr', { class: 'clk', onclick: function () { openPairDetail(e.pair, RP.at); } }, [h('td', {}, [e.pair]), h('td', { class: nd === 'BUY' ? 'up' : 'dn' }, [nd]), h('td', { class: 'mut' }, [e.triggerCloseMs ? eat(e.triggerCloseMs) : '—']), h('td', { class: 'mut' }, [brk]), h('td', { class: e.fired ? 'up' : 'mut' }, [outcome])])); });
      t2.appendChild(tb2); det.appendChild(t2); b2.appendChild(det);
    }
    out.appendChild(b2);

    // BLOCK 3 — signals generated earlier in the window
    var win = r.signalsInWindow || [];
    var b3 = h('div', { class: 'rblock b3' }, [h('span', { class: 'bl' }, ['③ Signals earlier in the ' + m.windowDays + '-day window'])]);
    b3.appendChild(h('div', { class: 'note mut' }, [win.length ? (win.length + ' signal(s) in (' + eat(r.atMs - m.windowDays * 86400000) + ' → T], each judged at its own trigger close.') : 'No signals earlier in the window.']));
    if (win.length) b3.appendChild(signalTable(win.slice().reverse()));
    out.appendChild(b3);
  }

  // ── HTF structure explorer (diagnostic; not the v2 direction source) ─────────
  function dirWord(ps) { if (ps.direction > 0) return ['bullish', 'up']; if (ps.direction < 0) return ['bearish', 'dn']; if (ps.reason === 'insufficient-history') return ['insufficient', 'mut']; return ['no break', 'mut']; }
  function renderPairs(o) {
    var wrap = h('div', {});
    wrap.appendChild(h('div', { class: 'note mut', html: '<b>Diagnostic:</b> each pair\'s latest ' + o.meta.dirTf + ' break of structure, as of <b>' + eat(o.cutoffMs) + ' EAT</b>. In v2 this is CONTEXT only — direction comes from the Evolution condition, not these breaks.' }));
    var f = { q: '', dir: '' };
    var bar = h('div', { class: 'filters' });
    var qin = h('input', { placeholder: 'filter pair e.g. EUR', oninput: function () { f.q = qin.value.toUpperCase(); draw(); } });
    var dsel = h('select', { onchange: function () { f.dir = dsel.value; draw(); } }, [['', 'all directions'], ['bull', 'bullish'], ['bear', 'bearish'], ['none', 'no break / insufficient']].map(function (o2) { return h('option', { value: o2[0] }, [o2[1]]); }));
    bar.appendChild(qin); bar.appendChild(dsel); wrap.appendChild(bar);
    var body = h('div', {}); wrap.appendChild(body);
    function draw() {
      body.innerHTML = '';
      var rows = (o.pairStates || []).filter(function (ps) {
        if (f.q && ps.pair.indexOf(f.q) < 0) return false;
        if (f.dir === 'bull') return ps.direction > 0; if (f.dir === 'bear') return ps.direction < 0; if (f.dir === 'none') return !ps.direction; return true;
      });
      var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Pair', o.meta.dirTf + ' direction', 'Broken', 'Break candle (EAT)', 'Age', 'Last evaluated (EAT)'].map(function (x) { return h('th', {}, [x]); }))])]);
      var tb = h('tbody', {});
      rows.forEach(function (ps) {
        var dw = dirWord(ps);
        tb.appendChild(h('tr', { class: 'clk', onclick: function () { openPairDetail(ps.pair); } }, [
          h('td', {}, [ps.pair]), h('td', { class: dw[1] }, [dw[0]]),
          h('td', { class: 'mut' }, [ps.brokenBoundary ? ps.brokenBoundary + ' @ ' + px(ps.pair, ps.brokenLevel) : '—']),
          h('td', { class: 'mut' }, [ps.breakOpenMs ? eat(ps.breakOpenMs) : '—']),
          h('td', { class: 'mut' }, [ps.ageCandles == null ? '—' : ps.ageCandles + 'c']),
          h('td', { class: 'mut' }, [ps.lastEvaluatedMs ? eat(ps.lastEvaluatedMs) : '—'])
        ]));
      });
      t.appendChild(tb); body.appendChild(h('div', { class: 'note mut' }, [rows.length + ' of 28 pairs'])); body.appendChild(t);
    }
    draw();
    return wrap;
  }

  // ── settings & operational status ──────────────────────────────────────────
  var ADMIN_UID = '140f3854-2c85-488c-8e0a-0f965d562654';
  function authUser() { try { return JSON.parse(localStorage.getItem('nfx_user') || '{}') || {}; } catch (e) { return {}; } }
  function tokenHeaders() { var t = localStorage.getItem('nfx_token'); return t ? { 'Authorization': 'Bearer ' + t } : {}; }

  function renderSettings(o) {
    var wrap = h('div', {});
    var st = o.status || {}, params = o.meta.params || {};
    var ops = h('div', { class: 'card' }, [h('h2', {}, ['Operational status — ' + STRAT_LABEL[S.strat]])]);
    var kv = h('div', { class: 'kv' });
    [
      ['Methodology', o.meta.methodology || 'Evolution-qualified breakout (v2)'],
      ['Windows', windowsLabel(o.meta)],
      ['Trigger timeframe', o.meta.triggerTf + ' (break of structure)'],
      ['Alignment', st.alignment || 'EAT (UTC+3, no DST)'],
      ['Index available', st.indexAvailable ? 'yes (zero-sum 1/8 M15)' : 'no'],
      ['Currencies complete', (st.currenciesComplete || 0) + ' / 8'],
      ['First candle', eat(st.firstDataUtc ? Date.parse(st.firstDataUtc) : null) + ' EAT'],
      ['Last candle (cutoff)', eat(o.cutoffMs) + ' EAT'],
      ['Active params', 'breadth ' + params.breadthMin + '/7 · dir deadband ' + params.dirDeadband + ' · eff deadband ' + params.effDeadband],
      ['Settings version', o.meta.version],
      ['Live processing', 'Vercel cron every 15 min (forward, idempotent) + on-demand recompute; polling, not push.']
    ].forEach(function (p) { kv.appendChild(h('span', { class: 'k' }, [p[0]])); kv.appendChild(h('span', { html: p[1] })); });
    ops.appendChild(kv); wrap.appendChild(ops);

    var panel = h('div', { class: 'card' }, [h('h2', {}, ['Condition configuration'])]);
    panel.appendChild(h('div', { class: 'note mut', html: 'The condition params are <b>configurable assumptions</b>. <b>breadthMin</b> (4–7) is how many of a currency\'s seven legs must agree inside the fast window. Changing it <b>versions forward</b> and never rewrites already-published signals. Movement deadbands default to 0.' }));
    var hist = h('div', {}, [h('div', { class: 'mut' }, ['Loading versions…'])]);
    panel.appendChild(hist);

    var admin = authUser().id === ADMIN_UID;
    var editRow = h('div', { class: 'filters', style: 'margin-top:10px' });
    var bmSel = h('select', {}, [4, 5, 6, 7].map(function (n) { return h('option', { value: n }, ['breadth ' + n + '/7']); }));
    var pubBtn = h('button', { class: 'btn', onclick: function () { publish(); } }, ['Publish new version']);
    var msg = h('span', { class: 'note', style: 'align-self:center' });
    if (admin) { editRow.appendChild(bmSel); editRow.appendChild(pubBtn); editRow.appendChild(msg); panel.appendChild(editRow); }
    else panel.appendChild(h('div', { class: 'note mut', style: 'margin-top:8px' }, ['Read-only — changing the condition params requires an admin sign-in.']));
    wrap.appendChild(panel);

    function loadHist() {
      fetch('/api/breakout-settings?strategy=' + S.strat).then(function (r) { return r.json(); }).then(function (j) {
        hist.innerHTML = '';
        if (!j || j.ok === false) { hist.appendChild(h('div', { class: 'mut' }, ['Could not read settings.'])); return; }
        bmSel.value = (j.params && j.params.breadthMin) || 5;
        hist.appendChild(h('div', { class: 'note mut' }, ['Active: breadth ' + (j.params && j.params.breadthMin) + '/7 (' + j.activeVersion + ').']));
        var rows = j.history || [];
        if (!rows.length) { hist.appendChild(h('div', { class: 'note mut' }, ['No stored version yet — the active params are the defaults until the first version is published or the cron runs.'])); return; }
        var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, ['Version', 'Breadth', 'Deadbands', 'Active', 'Created'].map(function (x) { return h('th', {}, [x]); }))])]);
        var tb = h('tbody', {});
        rows.forEach(function (r) { var pr = r.params || {}; tb.appendChild(h('tr', {}, [h('td', {}, [r.version]), h('td', {}, ['' + (pr.breadthMin == null ? '—' : pr.breadthMin)]), h('td', { class: 'mut' }, [(pr.dirDeadband == null ? 0 : pr.dirDeadband) + ' / ' + (pr.effDeadband == null ? 0 : pr.effDeadband)]), h('td', { class: r.active ? 'up' : 'mut' }, [r.active ? 'active' : '—']), h('td', { class: 'mut' }, [r.createdAt ? eat(Date.parse(r.createdAt)) : '—'])])); });
        t.appendChild(tb); hist.appendChild(t);
      }).catch(function () { hist.innerHTML = ''; hist.appendChild(h('div', { class: 'mut' }, ['Settings request failed.'])); });
    }
    function publish() {
      var bm = +bmSel.value; pubBtn.disabled = true; msg.textContent = 'Publishing…'; msg.className = 'note mut';
      fetch('/api/breakout-settings', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, tokenHeaders()), body: JSON.stringify({ strategy: S.strat, breadthMin: bm }) })
        .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (x) {
          pubBtn.disabled = false;
          if (x.j && x.j.ok) { msg.textContent = 'Published ' + x.j.activeVersion + '. Applies from the next trigger close.'; msg.className = 'note up'; delete cache[S.strat]; loadHist(); }
          else { msg.textContent = (x.s === 403 ? 'Admin only.' : x.s === 401 ? 'Sign in required.' : (x.j && x.j.error) || 'Failed.'); msg.className = 'note dn'; }
        }).catch(function (e) { pubBtn.disabled = false; msg.textContent = 'Failed: ' + (e.message || e); msg.className = 'note dn'; });
    }
    loadHist();
    return wrap;
  }

  // ── main render ────────────────────────────────────────────────────────────
  function render() {
    stopPlay();
    if (!OV) return;
    host.innerHTML = '';
    if (S.sec === 'replay') { host.appendChild(renderReplay()); return; }
    if (!OV.available) { host.appendChild(h('div', { class: 'card mut' }, ['This strategy has no usable data yet: ' + (OV.reason || 'unavailable') + '.'])); return; }
    if (S.sec === 'strength') host.appendChild(renderStrength(OV));
    else if (S.sec === 'qualified') host.appendChild(renderQualified(OV));
    else if (S.sec === 'signals') host.appendChild(renderSignals(OV));
    else if (S.sec === 'pairs') host.appendChild(renderPairs(OV));
    else if (S.sec === 'settings') host.appendChild(renderSettings(OV));
  }

  function statusHdr(o) {
    if (!o.available) return 'No data for ' + STRAT_LABEL[S.strat] + ': ' + (o.reason || 'unavailable') + '.';
    var st = o.status || {};
    return STRAT_LABEL[S.strat] + ' · ' + windowsLabel(o.meta) + ' → ' + o.meta.triggerTf + ' trigger · as of <b>' + eat(o.cutoffMs) + ' EAT</b> · ' +
      (st.currenciesComplete || 0) + '/8 currencies complete · breadth ' + (o.meta.params ? o.meta.params.breadthMin : 5) + '/7 · <span class="mut">Evolution-qualified, EAT-aligned, research, UNVALIDATED</span>';
  }

  function boot() {
    datahdr.innerHTML = 'Computing ' + STRAT_LABEL[S.strat] + ' Evolution condition from EAT candles…';
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
