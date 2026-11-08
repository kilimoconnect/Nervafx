'use strict';
/* NervaFX — Trade Signals UI. MODELLED research, estimated execution, UNVALIDATED. */
(function () {
  var S = window.NFX_TS || { strat: 'today', sec: 'shortlist', days: 90 };
  var host = document.getElementById('host'), datahdr = document.getElementById('datahdr'), banners = document.getElementById('banners');
  var drawer = document.getElementById('drawer'), drawerBody = document.getElementById('drawerBody');
  document.getElementById('drawerX').onclick = function () { drawer.classList.remove('open'); };

  var ALL = null;                 // view=all payload (cached)
  var cacheHist = {}, cachePerf = {}, cacheDetail = {};
  var STRAT_LABEL = { today: 'Today', week: 'Week', month: 'Month' };

  // ── helpers ──────────────────────────────────────────────────────────────
  function h(tag, attrs, kids) {
    var e = document.createElement(tag); attrs = attrs || {};
    for (var k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k === 'html') e.innerHTML = attrs[k]; else if (k.slice(0, 2) === 'on') e[k] = attrs[k]; else if (attrs[k] != null) e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c == null) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function api(params) {
    var qs = Object.keys(params).filter(function (k) { return params[k] != null && params[k] !== ''; }).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    return fetch('/api/trade-signals?' + qs).then(function (r) { return r.json(); });
  }
  function num(x, d) { return x == null ? '—' : (+x).toFixed(d == null ? 2 : d); }
  function pct(x) { return x == null ? '—' : (x > 0 ? '+' : '') + (+x).toFixed(2) + '%'; }
  function cls(x) { return x == null ? 'mut' : (x > 0 ? 'up' : (x < 0 ? 'dn' : 'mut')); }
  function eat(ms) { if (ms == null) return '—'; var d = new Date(ms + 3 * 3600000), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()); }
  function setURL() { history.replaceState(null, '', location.pathname + '?strat=' + S.strat + '&sec=' + S.sec + '&days=' + S.days); }
  function statusChip(st) {
    var map = { 'signal-published': ['pub', 'Published'], 'waiting-for-confirmation': ['wait', 'Waiting · confirm'], 'waiting-for-entry-trigger': ['wait', 'Waiting · trigger'], 'incomplete-data': ['', 'Incomplete data'], 'no-directional-bias': ['', 'No bias'] };
    var m = map[st] || ['', st]; return h('span', { class: 'st ' + m[0] }, [m[1]]);
  }

  // ── tab wiring ───────────────────────────────────────────────────────────
  function wireTabs() {
    [].forEach.call(document.querySelectorAll('.viewtabs [data-strat]'), function (b) {
      if (b.getAttribute('data-strat') === S.strat) b.classList.add('active');
      b.onclick = function () { S.strat = b.getAttribute('data-strat'); [].forEach.call(document.querySelectorAll('.viewtabs [data-strat]'), function (x) { x.classList.toggle('active', x === b); }); setURL(); render(); };
    });
    [].forEach.call(document.querySelectorAll('.subtabs [data-sec]'), function (b) {
      if (b.getAttribute('data-sec') === S.sec) b.classList.add('active');
      b.onclick = function () { S.sec = b.getAttribute('data-sec'); [].forEach.call(document.querySelectorAll('.subtabs [data-sec]'), function (x) { x.classList.toggle('active', x === b); }); setURL(); render(); };
    });
  }

  // ── sections ─────────────────────────────────────────────────────────────
  function renderShortlist(s) {
    var wrap = h('div', {});
    if (!s.ok || !s.board || !s.board.ok) { wrap.appendChild(h('div', { class: 'card mut' }, ['No ranking available for this window: ' + ((s.board && s.board.reason) || s.reason || 'insufficient data') + '.'])); return wrap; }
    wrap.appendChild(h('div', { class: 'note mut', html: 'Latest evaluation <b>' + eat(s.board.asOf) + ' EAT</b> · confirmation candle ' + eat(s.board.confirmInterval.startMs) + ' → ' + eat(s.board.confirmInterval.endMs) + '. The three selected pairs are shown; the full 28-pair ranking is below. Three shortlisted pairs are not three compulsory trades.' }));
    var grid = h('div', { class: 'slgrid' });
    s.board.shortlist.forEach(function (r) {
      var br = r.breadth || {}; var A = br.A, B = br.B;
      var card = h('div', { class: 'slcard', onclick: function () { if (r.status === 'signal-published') openDetailByBoard(r); } }, [
        h('span', { class: 'rk' }, ['#' + r.rank]),
        h('div', { class: 'pr' }, [r.pair]),
        h('span', { class: 'bias ' + r.bias }, [r.bias === 'none' ? 'no bias' : r.bias]),
        statusChip(r.status),
        h('div', { class: 'slmeta', html:
          'Period differential <b>' + num(r.differential, 5) + '</b><br>' +
          'Confirm: ' + (r.confirmPass == null ? '—' : (r.confirmPass ? '<span class="up">pass</span>' : '<span class="dn">fail</span>')) +
          (A ? ' · ' + r.pair.split('_')[0] + ' ' + A.up + '↑/' + A.down + '↓, ' + r.pair.split('_')[1] + ' ' + B.up + '↑/' + B.down + '↓ (of 7)' : '') + '<br>' +
          'Trigger: ' + (r.triggerPass == null ? '—' : (r.triggerPass ? '<span class="up">armed</span>' : 'not yet')) +
          (r.reasons && r.reasons.length ? '<br><span class="mut">' + r.reasons.slice(0, 2).join('; ') + '</span>' : '') })
      ]);
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    var det = h('details', { class: 'sec' }, [h('summary', { class: 'mut', html: 'Inspect all 28 ranked pairs' })]);
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, [h('th', {}, ['Pair']), h('th', {}, ['Rank']), h('th', {}, ['Bias']), h('th', {}, ['Differential'])])])]);
    var tb = h('tbody', {});
    s.board.ranking.forEach(function (r) {
      tb.appendChild(h('tr', { class: r.rank <= 3 ? 'clk' : '' }, [h('td', {}, [r.pair + (r.rank <= 3 ? ' ★' : '')]), h('td', {}, ['' + r.rank]), h('td', { class: r.bias === 'BUY' ? 'up' : (r.bias === 'SELL' ? 'dn' : 'mut') }, [r.bias]), h('td', {}, [num(r.differential, 5)])]));
    });
    t.appendChild(tb); det.appendChild(t); wrap.appendChild(det);
    return wrap;
  }

  function renderCurrent(s) {
    var wrap = h('div', {});
    wrap.appendChild(h('div', { class: 'note mut', html: 'Open modelled positions (unrealised) and signals just published at the latest candle. Expired or cancelled signals are shown in Historical and are never actionable.' }));
    var open = (s.current && s.current.open) || [];
    if (!open.length) wrap.appendChild(h('div', { class: 'card mut' }, ['No open modelled positions in this window.']));
    else wrap.appendChild(signalTable(open, true));
    var jp = (s.current && s.current.justPublished) || [];
    if (jp.length) wrap.appendChild(h('div', { class: 'note', html: '<b>Just published</b> (awaiting fill at the next candle open): ' + jp.join(', ') }));
    return wrap;
  }

  function signalTable(rows, withExit) {
    var head = ['Pair', 'Dir', 'Rank', 'Diff', 'Published (EAT)', 'Ref entry', 'Stop', 'Target', 'Fill', 'Status'];
    if (withExit) head = head.concat(['Exit', 'Reason', 'Net R', 'Mon']);
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, head.map(function (x) { return h('th', {}, [x]); }))])]);
    var tb = h('tbody', {});
    rows.forEach(function (r) {
      var tds = [
        h('td', {}, [r.pair]), h('td', { class: r.direction === 'BUY' ? 'up' : 'dn' }, [r.direction]),
        h('td', {}, ['' + r.rank]), h('td', {}, [num(r.differential, 5)]), h('td', {}, [eat(r.publishedAtMs)]),
        h('td', {}, [num(r.referenceEntry, 5)]), h('td', {}, [num(r.fixedStop, 5)]), h('td', {}, [num(r.indicativeTarget, 5)]),
        h('td', {}, [r.modelledFill == null ? '—' : num(r.modelledFill, 5)]), h('td', {}, [stShort(r.status)])
      ];
      if (withExit) tds = tds.concat([h('td', {}, [r.exitPrice == null ? '—' : num(r.exitPrice, 5)]), h('td', {}, [r.exitReason || '—']), h('td', { class: cls(r.netR) }, [r.netR == null ? '—' : num(r.netR, 2) + 'R']), h('td', {}, [r.monitorTf || '—'])]);
      tb.appendChild(h('tr', { class: 'clk', onclick: function () { openDetail(r.key); } }, tds));
    });
    t.appendChild(tb); return t;
  }
  function stShort(st) { return { 'CLOSED': 'closed', 'OPEN': 'open', 'EXPIRED': 'expired', 'CANCELLED': 'cancelled', 'UNRESOLVED': 'unresolved', 'PUBLISHED': 'published' }[st] || st; }

  function renderHistory(s) {
    var wrap = h('div', {});
    var f = { pair: '', direction: '', status: '', result: '', origin: '' };
    var bar = h('div', { class: 'filters' });
    function sel(name, opts) { var el = h('select', { onchange: function () { f[name] = el.value; load(); } }, [h('option', { value: '' }, [name])].concat(opts.map(function (o) { return h('option', { value: o }, [o]); }))); return el; }
    bar.appendChild(sel('direction', ['BUY', 'SELL']));
    bar.appendChild(sel('status', ['CLOSED', 'OPEN', 'EXPIRED', 'CANCELLED', 'UNRESOLVED']));
    bar.appendChild(sel('result', ['win', 'loss']));
    bar.appendChild(sel('origin', ['historical', 'forward']));
    var pin = h('input', { placeholder: 'pair e.g. EUR_USD', oninput: function () { f.pair = pin.value.toUpperCase(); } });
    var go = h('button', { class: 'btn2', onclick: load }, ['Filter']);
    var csv = h('button', { class: 'btn2', onclick: function () { exportCsv(); } }, ['CSV']);
    bar.appendChild(pin); bar.appendChild(go); bar.appendChild(csv);
    wrap.appendChild(bar);
    var body = h('div', { class: 'card mut' }, ['Loading…']); wrap.appendChild(body);
    var lastRows = [];
    function load() {
      body.innerHTML = 'Loading…';
      api({ view: 'history', strategy: S.strat, days: S.days, pair: f.pair, direction: f.direction, status: f.status, result: f.result, origin: f.origin }).then(function (j) {
        lastRows = j.history || [];
        body.innerHTML = '';
        body.className = '';
        body.appendChild(h('div', { class: 'note mut' }, [(j.count || 0) + ' signals · closed-trade stats attributed to exit period · modelled/estimated.']));
        if (!lastRows.length) body.appendChild(h('div', { class: 'card mut' }, ['No signals match.']));
        else body.appendChild(signalTable(lastRows, true));
      });
    }
    function exportCsv() {
      var cols = ['strategy', 'version', 'origin', 'pair', 'direction', 'rank', 'differential', 'publishedAtMs', 'referenceEntry', 'fixedStop', 'indicativeTarget', 'modelledFill', 'initialStop', 'target', 'initialRisk', 'exitPrice', 'exitReason', 'netR', 'status', 'monitorTf', 'ambiguity'];
      var lines = [cols.join(',')].concat(lastRows.map(function (r) { return cols.map(function (c) { return r[c] == null ? '' : r[c]; }).join(','); }));
      var blob = new Blob([lines.join('\n')], { type: 'text/csv' }); var a = h('a', { href: URL.createObjectURL(blob), download: 'nervafx-signals-' + S.strat + '.csv' }); document.body.appendChild(a); a.click(); a.remove();
    }
    load();
    return wrap;
  }

  function renderPerformance(s) {
    var wrap = h('div', {});
    var mode = { portfolio: 'indep' };
    var tgl = h('div', { class: 'toggle' }, [
      h('button', { class: 'on', onclick: function () { mode.portfolio = 'indep'; this.classList.add('on'); this.nextSibling.classList.remove('on'); load(); } }, ['Independent']),
      h('button', { onclick: function () { mode.portfolio = 'combined'; this.classList.add('on'); this.previousSibling.classList.remove('on'); load(); } }, ['Combined portfolio'])
    ]);
    wrap.appendChild(h('div', { class: 'filters' }, [tgl]));
    var body = h('div', {}, [h('div', { class: 'card mut' }, ['Loading…'])]); wrap.appendChild(body);
    function load() {
      body.innerHTML = 'Loading…';
      api({ view: 'performance', strategy: S.strat, days: S.days, portfolio: mode.portfolio }).then(function (j) {
        body.innerHTML = '';
        var st = j.stats || {}, pf = j.portfolio || {};
        if (mode.portfolio === 'combined') body.appendChild(h('div', { class: 'banner-strong', html: j.combinedNote || 'Combined portfolio applies shared risk limits + conflict rules across all three strategies. It is NOT the sum of the independent returns.' }));
        body.appendChild(tiles([
          ['Account return', pct(pf.accountReturnPct), cls(pf.accountReturnPct), (mode.portfolio === 'combined' ? 'combined' : S.strat) + ' · marked-to-market'],
          ['Max drawdown', pct(-Math.abs(pf.maxDrawdownPct || 0)), 'dn', 'equity peak-to-trough'],
          ['Win rate', st.winRate == null ? '—' : st.winRate + '%', null, (st.resolvedClosed || 0) + ' resolved closed'],
          ['Total net R', num(st.totalNetR, 2), cls(st.totalNetR), 'avg ' + num(st.avgNetR, 3) + 'R'],
          ['Profit factor', st.profitFactor == null ? (st.profitFactorNote || '—') : num(st.profitFactor, 2), null, 'win ' + num(st.avgWinR, 2) + ' / loss ' + num(st.avgLossR, 2)],
          ['Closed', '' + (st.closed || 0), null, (st.wins || 0) + 'W / ' + (st.losses || 0) + 'L / ' + (st.breakeven || 0) + 'BE'],
        ]));
        body.appendChild(h('div', { class: 'note mut', html: 'Open ' + (st.open || 0) + ' · expired ' + (st.expired || 0) + ' · cancelled ' + (st.cancelled || 0) + ' · unresolved ' + (st.unresolved || 0) + ' · ambiguous ' + (st.ambiguous || 0) + ' · monitored M5 ' + (st.monitoredM5 || 0) + ' / M15 ' + (st.monitoredM15 || 0) + '. Win rate excludes pending/open/expired/cancelled. Modelled/estimated; NOT real results.' }));
        // equity curve
        body.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Equity curve (model, start ' + (j.params ? j.params.initialEquity : 100000) + ')']), equitySvg(pf.equityCurve || [])]));
        // period tables + breakdowns
        var cols = h('div', { class: 'cols' });
        cols.appendChild(periodTable('Monthly (by exit)', (j.reports || {}).monthly || []));
        cols.appendChild(periodTable('Weekly (by exit)', (j.reports || {}).weekly || []));
        body.appendChild(cols);
        var cols2 = h('div', { class: 'cols' });
        cols2.appendChild(bdTable('By pair', j.byPair || []));
        cols2.appendChild(bdTable('By direction', j.byDirection || []));
        body.appendChild(cols2);
        var cols3 = h('div', { class: 'cols' });
        cols3.appendChild(bdTable('By shortlist rank', j.byRank || []));
        cols3.appendChild(bdTable('Historical vs forward', j.byOrigin || []));
        body.appendChild(cols3);
        if (pf.skipped && pf.skipped.length) body.appendChild(h('div', { class: 'note mut' }, [pf.skipped.length + ' portfolio-skipped signals (conflicts / risk limits) — their independent signal outcomes are preserved.']));
      });
    }
    load();
    return wrap;
  }

  function tiles(items) { var g = h('div', { class: 'tiles' }); items.forEach(function (it) { g.appendChild(h('div', { class: 'tile' }, [h('div', { class: 'lab' }, [it[0]]), h('div', { class: 'val ' + (it[2] || '') }, [it[1]]), h('div', { class: 'sub' }, [it[3] || ''])])); }); return g; }
  function periodTable(title, rows) {
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, [h('th', {}, [title]), h('th', {}, ['Closed']), h('th', {}, ['Win%']), h('th', {}, ['Net R'])])])]);
    var tb = h('tbody', {}); if (!rows.length) tb.appendChild(h('tr', {}, [h('td', { class: 'mut' }, ['No closed trades']), h('td', {}, ['']), h('td', {}, ['']), h('td', {}, [''])]));
    rows.forEach(function (r) { tb.appendChild(h('tr', {}, [h('td', {}, [r.period]), h('td', {}, ['' + r.closed]), h('td', {}, [r.winRate == null ? '—' : r.winRate + '%']), h('td', { class: cls(r.netR) }, [num(r.netR, 2)])])); });
    t.appendChild(tb); return t;
  }
  function bdTable(title, rows) {
    var t = h('table', { class: 'tbl' }, [h('thead', {}, [h('tr', {}, [h('th', {}, [title]), h('th', {}, ['Closed']), h('th', {}, ['Win%']), h('th', {}, ['Net R'])])])]);
    var tb = h('tbody', {}); if (!rows.length) tb.appendChild(h('tr', {}, [h('td', { class: 'mut' }, ['—']), h('td', {}, ['']), h('td', {}, ['']), h('td', {}, [''])]));
    rows.forEach(function (r) { tb.appendChild(h('tr', {}, [h('td', {}, [r.key]), h('td', {}, ['' + r.closed]), h('td', {}, [r.winRate == null ? '—' : r.winRate + '%']), h('td', { class: cls(r.netR) }, [num(r.netR, 2)])])); });
    t.appendChild(tb); return t;
  }
  function equitySvg(curve) {
    var W = 680, H = 160, pad = 24;
    if (!curve || curve.length < 2) return h('div', { class: 'eqwrap mut' }, ['No closed trades to chart.']);
    var xs = curve.map(function (p) { return p.ms; }), ys = curve.map(function (p) { return p.equity; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var sx = function (x) { return pad + (W - 2 * pad) * (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)); };
    var sy = function (y) { return H - pad - (H - 2 * pad) * (y1 === y0 ? 0.5 : (y - y0) / (y1 - y0)); };
    // drawdown-aware polyline
    var pts = curve.map(function (p) { return sx(p.ms) + ',' + sy(p.equity); }).join(' ');
    var peakLine = (function () { var pk = -Infinity; return curve.map(function (p) { pk = Math.max(pk, p.equity); return sx(p.ms) + ',' + sy(pk); }).join(' '); })();
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet">' +
      '<polyline points="' + peakLine + '" fill="none" stroke="rgba(148,163,184,.35)" stroke-width="1" stroke-dasharray="3 3"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="1.6"/>' +
      '<text x="' + pad + '" y="14" fill="var(--text-muted)" font-size="10">' + Math.round(y1).toLocaleString() + '</text>' +
      '<text x="' + pad + '" y="' + (H - 6) + '" fill="var(--text-muted)" font-size="10">' + Math.round(y0).toLocaleString() + '</text></svg>';
    return h('div', { class: 'eqwrap', html: svg });
  }

  // ── detail drawer ────────────────────────────────────────────────────────
  function openDetailByBoard(r) { /* board rows have no stored key; find in history */ openDetail(null, r.pair); }
  function openDetail(key, pairHint) {
    drawer.classList.add('open'); drawerBody.innerHTML = '<div class="mut">Loading signal…</div>';
    if (!key) { // find most recent signal for pair in history
      api({ view: 'history', strategy: S.strat, days: S.days, pair: pairHint }).then(function (j) { var r = (j.history || [])[0]; if (r) openDetail(r.key); else drawerBody.innerHTML = '<div class="mut">No signal record yet for ' + pairHint + ' in this window.</div>'; });
      return;
    }
    api({ view: 'detail', strategy: S.strat, days: S.days, key: key }).then(function (j) { if (!j.detail) { drawerBody.innerHTML = '<div class="mut">Not found.</div>'; return; } renderDetail(j.detail); });
  }
  function renderDetail(d) {
    drawerBody.innerHTML = '';
    drawerBody.appendChild(h('div', { html: '<div style="font-weight:800;font-size:16px">' + d.pair + ' <span class="' + (d.direction === 'BUY' ? 'up' : 'dn') + '">' + d.direction + '</span> <span class="mut" style="font-size:12px">' + d.strategy + ' · ' + d.version + ' · ' + (d.origin || 'historical') + '</span></div>' }));
    drawerBody.appendChild(h('div', { class: 'banner-strong', html: 'MODELLED signal · estimated execution (' + (d.monitorTf || 'M15') + ' monitoring). Not advice; no order was placed.' }));
    var chart = h('div', { class: 'dchart' }); drawerBody.appendChild(chart);
    // key/value plan
    var kv = h('div', { class: 'kv' });
    [['Rank', '#' + d.rank], ['Differential', num(d.differential, 6)], ['Published', eat(d.publishedAtMs) + ' EAT'], ['Reference entry', num(d.referenceEntry, 5)], ['Max deviation', num(d.maxDeviation, 5)], ['Modelled fill', d.modelledFill == null ? '—' : num(d.modelledFill, 5)], ['Initial stop', num(d.initialStop != null ? d.initialStop : d.fixedStop, 5)], ['Target', num(d.target != null ? d.target : d.indicativeTarget, 5)], ['Initial risk (R)', d.initialRisk == null ? '—' : num(d.initialRisk, 5)], ['ATR', num(d.atr, 5)], ['Exit', d.exitPrice == null ? '—' : num(d.exitPrice, 5) + ' (' + d.exitReason + ')'], ['Net R', d.netR == null ? '—' : num(d.netR, 3) + 'R'], ['Status', d.status]].forEach(function (p) { kv.appendChild(h('span', { class: 'k' }, [p[0]])); kv.appendChild(h('span', {}, [p[1]])); });
    drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Trade plan (frozen at publication)']), kv]));
    // confirmation
    if (d.confirmation) {
      var c = d.confirmation, cc = h('div', { class: 'kv' });
      var rd = c.readings || {}, bd = c.breadth || {};
      cc.appendChild(h('span', { class: 'k' }, ['Confirm result'])); cc.appendChild(h('span', { class: c.pass ? 'up' : 'dn' }, [c.pass ? 'pass' : 'fail']));
      if (rd.A) { cc.appendChild(h('span', { class: 'k' }, [rd.A.ccy + ' return'])); cc.appendChild(h('span', { class: cls(rd.A.ret) }, [num(100 * (Math.exp(rd.A.ret || 0) - 1), 3) + '%  ·  breadth ' + (bd.A ? bd.A.up + '↑/' + bd.A.down + '↓' : '')])); }
      if (rd.B) { cc.appendChild(h('span', { class: 'k' }, [rd.B.ccy + ' return'])); cc.appendChild(h('span', { class: cls(rd.B.ret) }, [num(100 * (Math.exp(rd.B.ret || 0) - 1), 3) + '%  ·  breadth ' + (bd.B ? bd.B.up + '↑/' + bd.B.down + '↓' : '')])); }
      drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Confirmation (' + eat(c.interval.startMs) + ' → ' + eat(c.interval.endMs) + ' EAT)']), cc, c.reasons && c.reasons.length ? h('div', { class: 'note mut' }, [c.reasons.join('; ')]) : null]));
    }
    // costs
    if (d.costs && d.costs.total != null) {
      drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Execution assumptions (estimated)']), h('div', { class: 'note mut', html: 'Spread ' + num(d.costs.spread, 6) + ' + slippage ' + num(d.costs.slippage, 6) + ' + financing ' + num(d.costs.swap, 6) + ' = <b>' + num(d.costs.total, 6) + '</b> price units (held ' + num(d.costs.daysHeld, 2) + 'd). Gross ' + num(d.costs.grossPrice, 6) + ' → net ' + num(d.costs.netPrice, 6) + '. Commission modelled within the spread assumption.' + (d.dataQuality && d.dataQuality.ambiguity ? ' <span class="dn">Ambiguous stop/target bar — resolved stop-first; target-first would have been ' + num(d.dataQuality.altNetR, 2) + 'R.</span>' : '') })]));
    }
    // lifecycle timeline
    if (d.events) {
      var ul = h('ul', { class: 'tl' });
      d.events.forEach(function (e) { ul.appendChild(h('li', { html: '<b>' + e.type + '</b> · ' + eat(e.atMs) + ' EAT' })); });
      drawerBody.appendChild(h('div', { class: 'sec' }, [h('h3', {}, ['Lifecycle']), ul]));
    }
    drawChart(chart, d);
  }
  function drawChart(el, d) {
    if (!window.LightweightCharts) { el.innerHTML = '<div class="mut">chart library unavailable</div>'; return; }
    var tf = { today: 'M15', week: 'H1', month: 'H4' }[d.strategy] || 'M15';
    var asOf = d.exitMs || d.fillMs || d.publishedAtMs;
    fetch('/api/currency-chart?instrument=' + d.pair + '&tf=' + tf + '&asOf=' + (asOf + 20 * 4 * 3600000)).then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.candles || !j.candles.length) { el.innerHTML = '<div class="mut">no chart data</div>'; return; }
      var chart = LightweightCharts.createChart(el, { height: 360, layout: { background: { color: 'transparent' }, textColor: '#9aa4b2' }, grid: { vertLines: { color: 'rgba(42,49,72,.4)' }, horzLines: { color: 'rgba(42,49,72,.4)' } }, rightPriceScale: { borderColor: '#2a3148' }, timeScale: { borderColor: '#2a3148', timeVisible: true } });
      var cs = chart.addCandlestickSeries({ upColor: '#16c784', downColor: '#f6465d', wickUpColor: '#16c784', wickDownColor: '#f6465d', borderVisible: false });
      cs.setData(j.candles.map(function (c) { return { time: c.time + 3 * 3600, open: c.open, high: c.high, low: c.low, close: c.close }; }));
      var stop = d.initialStop != null ? d.initialStop : d.fixedStop, tgt = d.target != null ? d.target : d.indicativeTarget;
      if (stop != null) cs.createPriceLine({ price: stop, color: '#f6465d', lineWidth: 1, lineStyle: 2, title: 'stop' });
      if (tgt != null) cs.createPriceLine({ price: tgt, color: '#16c784', lineWidth: 1, lineStyle: 2, title: 'target' });
      if (d.modelledFill != null) cs.createPriceLine({ price: d.modelledFill, color: '#3b82f6', lineWidth: 1, lineStyle: 0, title: 'fill' });
      var markers = [];
      if (d.entryCloseMs) markers.push({ time: Math.floor(d.entryCloseMs / 1000) + 3 * 3600, position: d.direction === 'BUY' ? 'belowBar' : 'aboveBar', color: '#3b82f6', shape: d.direction === 'BUY' ? 'arrowUp' : 'arrowDown', text: 'trigger' });
      if (d.exitMs) markers.push({ time: Math.floor(d.exitMs / 1000) + 3 * 3600, position: 'aboveBar', color: d.netR > 0 ? '#16c784' : '#f6465d', shape: 'circle', text: d.exitReason });
      cs.setMarkers(markers.sort(function (a, b) { return a.time - b.time; }));
      chart.timeScale().fitContent();
    }).catch(function () { el.innerHTML = '<div class="mut">chart failed to load</div>'; });
  }

  // ── main render ──────────────────────────────────────────────────────────
  function render() {
    if (!ALL) return;
    var s = ALL.strategies[S.strat];
    host.innerHTML = '';
    if (!s || !s.ok) { host.appendChild(h('div', { class: 'card mut' }, ['This strategy has no data in the current window: ' + ((s && s.reason) || 'unavailable') + '.'])); return; }
    if (S.sec === 'shortlist') host.appendChild(renderShortlist(s));
    else if (S.sec === 'current') host.appendChild(renderCurrent(s));
    else if (S.sec === 'history') host.appendChild(renderHistory(s));
    else if (S.sec === 'performance') host.appendChild(renderPerformance(s));
  }

  function boot() {
    wireTabs();
    datahdr.textContent = 'Reconstructing ' + S.days + ' days of modelled signals from candles… (first load can take ~30–60s; cached after)';
    api({ view: 'all', days: S.days }).then(function (j) {
      if (!j || j.ok === false) { banners.innerHTML = '<div class="state-banner sb-error">ERROR — ' + ((j && j.error) || 'request failed') + '</div>'; datahdr.textContent = ''; return; }
      ALL = j;
      var c = j.combined || {};
      datahdr.innerHTML = 'Window ' + S.days + 'd · generated ' + eat(j.generatedAt) + ' EAT · <b>Combined model portfolio</b>: return <span class="' + cls(c.accountReturnPct) + '">' + pct(c.accountReturnPct) + '</span>, max DD ' + num(c.maxDrawdownPct, 2) + '%, ' + (c.closed || 0) + ' closed, ' + (c.skipped ? c.skipped.length : 0) + ' skipped (conflicts/limits). <span class="mut">MODELLED · UNVALIDATED.</span>';
      render();
    }).catch(function (e) { banners.innerHTML = '<div class="state-banner sb-error">ERROR — ' + (e.message || e) + '</div>'; datahdr.textContent = ''; });
  }
  boot();
})();
