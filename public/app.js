// NervaFX Dashboard — app.js
// Libraries loaded via CDN: GSAP · Lucide Icons · CountUp.js · Notyf

// ─── Auth guard ───────────────────────────────────────────────────────────────
function _clearAuth() {
  localStorage.removeItem('nfx_token');
  localStorage.removeItem('nfx_refresh_token');
  localStorage.removeItem('nfx_user');
}

async function _refreshToken() {
  const rt = localStorage.getItem('nfx_refresh_token');
  if (!rt) return false;
  try {
    const r = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    if (!d.token) return false;
    localStorage.setItem('nfx_token',         d.token);
    localStorage.setItem('nfx_refresh_token', d.refresh_token || rt);
    return true;
  } catch (_) { return false; }
}

function _scheduleRefresh(expMs) {
  // Refresh 5 minutes before the token actually expires
  const delay = Math.max(expMs - Date.now() - 5 * 60 * 1000, 10_000);
  setTimeout(async () => {
    const ok = await _refreshToken();
    if (ok) {
      // Schedule the next refresh based on the new token's expiry
      try {
        const tok = localStorage.getItem('nfx_token');
        const pay = JSON.parse(atob(tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
        _scheduleRefresh(pay.exp * 1000);
      } catch (_) {}
    }
    // If refresh failed we simply let the next API call handle the 401
  }, delay);
}

(async function guardAuth() {
  const token = localStorage.getItem('nfx_token');
  if (!token) return location.replace('/login.html');
  try {
    const pay = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

    if (pay.exp * 1000 < Date.now()) {
      // Access token expired — try a silent refresh before giving up
      const ok = await _refreshToken();
      if (!ok) { _clearAuth(); return location.replace('/login.html'); }
    }

    // Schedule proactive refresh so the token never expires while the tab is open
    try {
      const tok = localStorage.getItem('nfx_token');
      const p   = JSON.parse(atob(tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      _scheduleRefresh(p.exp * 1000);
    } catch (_) {}

    // If user just signed up and hasn't done setup, redirect them
    if (localStorage.getItem('nfx_needs_setup') === 'true') {
      return location.replace('/setup');
    }
    // Show logged-in user name (or email fallback) in header
    const user = JSON.parse(localStorage.getItem('nfx_user') || '{}');
    const el = document.getElementById('header-user');
    if (el) el.textContent = user.full_name || user.first_name || user.email || '';
  } catch (_) {
    _clearAuth();
    return location.replace('/login.html');
  }
})();

function logout() {
  _clearAuth();
  location.replace('/login.html');
}

const REFRESH_MS = 60000;
let strengthChart = null;
let activeTF = '6';
let strengthData = null;
let _firstLoad = true;
// Currencies that currently meet the Currency Signals threshold (strong + weak combined).
// Set<string> — populated by renderCurrencySignals() before the section renderers run.
let _csigCurrencies = new Set();
// True once renderCurrencySignals() has processed real strength data.
// Distinguishes "still loading" (pass-through) from "loaded but nothing qualifies" (filter out).
let _csigDataLoaded = false;

// Returns true if strength data isn't loaded yet (pass-through) OR if either the
// base or quote currency of `instrument` (e.g. "EUR_USD") is in the set.
// Returns false when data IS loaded but no currencies meet the threshold.
function hasCsigCurrency(instrument) {
  if (!_csigDataLoaded) return true;          // still loading → show everything
  if (!_csigCurrencies.size) return false;    // loaded, nothing qualifies → hide
  const base  = (instrument || '').slice(0, 3).toUpperCase();
  const quote = (instrument || '').slice(4, 7).toUpperCase();
  return _csigCurrencies.has(base) || _csigCurrencies.has(quote);
}

// Returns true if a journal entry snapshot contains at least one entered/
// waiting signal or top-setup whose base or quote currency is in the CS set.
function entryHasCsigPair(e) {
  if (!_csigCurrencies.size) return true;
  const instruments = [
    ...(e.signals_summary?.entered || []),
    ...(e.signals_summary?.waiting || []),
    ...(e.top_setups || []),
  ].map(s => s.instrument).filter(Boolean);
  return instruments.some(i => hasCsigCurrency(i));
}

// Compute strong/weak currencies FROM a journal entry's own stored
// currency_strength snapshot — historically accurate, no live data needed.
function computeEntryCsig(e) {
  const cs   = e.currency_strength;
  const list = Array.isArray(cs) ? cs : (cs?.currencies || []);
  const strong = [], weak = [];
  list.forEach(c => {
    const v3  = parseFloat(c.smooth_3h  ?? c.normalized_3h)  || 0;
    const v6  = parseFloat(c.smooth_6h  ?? c.normalized_6h)  || 0;
    const v12 = parseFloat(c.smooth_12h ?? c.normalized_12h) || 0;
    const combined = (v3 + v6 + v12) / 3;
    if (combined >  CS_THRESHOLD && v3 >  CS_THRESHOLD) strong.push(c.currency);
    else if (combined < -CS_THRESHOLD && v3 < -CS_THRESHOLD) weak.push(c.currency);
  });
  return { strong, weak };
}

// Score CS availability: +2 when 2+ currencies on dominant side (expansion likely),
// +1 for a single qualifying currency, -1 when none.
function _csigScore(strongLen, weakLen) {
  const dominant = Math.max(strongLen, weakLen);
  if (dominant >= 2) return 2;
  if (dominant >= 1) return 1;
  return -1;
}

function _csigPointHtml(score) {
  const cls   = score >= 2 ? 'exp' : score === 1 ? 'pos' : 'neg';
  const label = score >= 2 ? '+2' : score === 1 ? '+1' : '-1';
  return `<span class="jrn-csig-point ${cls}">${label}</span>`;
}

// Returns inline HTML badge row for a journal entry's historical CS currencies.
// Always rendered — shows scored point indicator + currency names (or "No CS" when empty).
function csigBadgeHtml(e) {
  const { strong, weak } = computeEntryCsig(e);
  const score = _csigScore(strong.length, weak.length);
  const pt    = _csigPointHtml(score);
  if (score === -1) return `<div class="jrn-csig-row">${pt}<span class="jrn-csig-tag no-cs">No CS</span></div>`;
  const parts = [];
  if (strong.length) parts.push(`<span class="jrn-csig-tag strong">💪 ${strong.join(' ')}</span>`);
  if (weak.length)   parts.push(`<span class="jrn-csig-tag weak">🔻 ${weak.join(' ')}</span>`);
  return `<div class="jrn-csig-row">${pt}${parts.join('')}</div>`;
}

// Full CS availability card for journal modal — shows qualifying currencies with values.
function renderJrnCsigSection(e) {
  const cs = e.currency_strength;
  const currencies = Array.isArray(cs) ? cs : (cs?.currencies || []);
  const asOf       = Array.isArray(cs) ? null : (cs?.as_of || null);

  const scored = currencies.map(c => {
    const v3  = parseFloat(c.smooth_3h  ?? c.normalized_3h)  || 0;
    const v6  = parseFloat(c.smooth_6h  ?? c.normalized_6h)  || 0;
    const v12 = parseFloat(c.smooth_12h ?? c.normalized_12h) || 0;
    return { cur: c.currency, combined: (v3 + v6 + v12) / 3, h3: v3, h6: v6, h12: v12 };
  });

  const strong = scored.filter(c => c.combined >  CS_THRESHOLD && c.h3 >  CS_THRESHOLD).sort((a, b) => b.combined - a.combined);
  const weak   = scored.filter(c => c.combined < -CS_THRESHOLD && c.h3 < -CS_THRESHOLD).sort((a, b) => a.combined - b.combined);
  const score  = _csigScore(strong.length, weak.length);

  const expansionNote = score >= 2
    ? `<span class="jrn-csig-exp-note">Expansion likely</span>`
    : '';

  function fv(n) { return (n >= 0 ? '+' : '') + n.toFixed(5); }

  function colHtml(list, side) {
    const isStrong = side === 'strong';
    const cls      = isStrong ? 'pos' : 'neg';
    if (!list.length) return `
      <div class="cs-sig-col ${side}">
        <div class="cs-sig-col-title">${isStrong ? '💪 Strong' : '🔻 Weak'}</div>
        <div class="cs-sig-empty">No confirmed ${isStrong ? 'bullish' : 'bearish'} signal</div>
      </div>`;
    return `
      <div class="cs-sig-col ${side}">
        <div class="cs-sig-col-title">${isStrong ? '💪 Strong' : '🔻 Weak'}</div>
        <div class="cs-sig-head"><span>CCY</span><span>Combined</span><span>3H</span><span>6H</span><span>12H</span></div>
        ${list.map(c => `
          <div class="cs-sig-row">
            <span class="cs-sig-cur">${c.cur}</span>
            <span class="cs-sig-combo ${cls}">${fv(c.combined)}</span>
            <span class="cs-sig-val ${cls}">${fv(c.h3)}</span>
            <span class="cs-sig-val ${cls}">${fv(c.h6)}</span>
            <span class="cs-sig-val ${cls}">${fv(c.h12)}</span>
          </div>`).join('')}
      </div>`;
  }

  const headerContent = `
    <div class="jrn-csig-avail-header">
      ${_csigPointHtml(score)}
      <span class="jrn-csig-criteria">combined > ±${CS_THRESHOLD.toFixed(5)} & 3H confirms</span>
      ${expansionNote}
      ${asOf ? `<span class="jrn-csig-as-of">${fmtTime(asOf)}</span>` : ''}
    </div>
    <div class="cs-sig-grid">
      ${colHtml(strong, 'strong')}
      ${colHtml(weak, 'weak')}
    </div>`;

  return _jrnSection('📶 Currency Signals', headerContent);
}

// ─── Notyf (toast notifications) ─────────────────────────────────────────────
const notyf = typeof Notyf !== 'undefined'
  ? new Notyf({
      duration: 3500,
      ripple: true,
      position: { x: 'right', y: 'top' },
      types: [
        { type: 'success', background: 'linear-gradient(135deg,#16a34a,#22c55e)', icon: false },
        { type: 'error',   background: 'linear-gradient(135deg,#dc2626,#ef4444)', icon: false },
        { type: 'warning', background: 'linear-gradient(135deg,#ca8a04,#eab308)', icon: false },
      ],
    })
  : { success: () => {}, error: () => {}, open: () => {} };

// ─── Lucide icon hydration ────────────────────────────────────────────────────
function hydrateIcons() {
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ─── CountUp helper ───────────────────────────────────────────────────────────
function countTo(elementId, value, options = {}) {
  if (typeof CountUp === 'undefined') return;
  const el = document.getElementById(elementId);
  if (!el) return;
  const cu = new CountUp.CountUp(elementId, value, {
    duration: 1.2,
    useEasing: true,
    useGrouping: true,
    ...options,
  });
  if (!cu.error) cu.start();
}

// ─── GSAP helpers ─────────────────────────────────────────────────────────────
function gsapCardEntrance() {
  if (typeof gsap === 'undefined') return;
  gsap.from('.tab-panel.active .card', {
    y: 16,
    opacity: 0,
    duration: 0.55,
    stagger: 0.045,
    ease: 'power2.out',
    clearProps: 'all',
  });
}

function gsapModalOpen(el) {
  if (typeof gsap === 'undefined') return;
  gsap.fromTo(el,
    { opacity: 0, scale: 0.95, y: 12 },
    { opacity: 1, scale: 1,    y: 0,  duration: 0.28, ease: 'power2.out' }
  );
}

function gsapModalClose(el, onComplete) {
  if (typeof gsap === 'undefined') { onComplete(); return; }
  gsap.to(el, {
    opacity: 0, scale: 0.97, y: 8,
    duration: 0.18, ease: 'power2.in',
    onComplete,
  });
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const tok = localStorage.getItem('nfx_token');
  const headers = { ...(tok ? { 'Authorization': 'Bearer ' + tok } : {}), ...(opts.headers || {}) };
  if (opts.method === 'POST' && opts.body == null) opts.body = '{}';
  if (opts.method === 'POST') headers['Content-Type'] = 'application/json';
  const r = await fetch(path, { ...opts, headers });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

// ─── News calendar ────────────────────────────────────────────────────────────

let _newsMap = {}; // { 'USD': [...events], 'EUR': [...events] }

async function fetchNews() {
  try {
    const d = await api('/api/news');
    const map = {};
    (d.events || []).forEach(e => {
      if (!map[e.currency]) map[e.currency] = [];
      map[e.currency].push(e);
    });
    _newsMap = map;
  } catch (_) {}
}

async function fetchTodayNews() {
  try {
    const tz = (_userTz === 'auto')
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : (_userTz || 'UTC');

    // Get today's date string in the user's local timezone
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD

    // Convert the user's local midnight → UTC so the API returns events that
    // fall within the actual local calendar day, not the UTC calendar day.
    // e.g. EAT (UTC+3): local midnight 00:00 = UTC 21:00 the previous day
    const offsetMs    = getTzOffsetMins(tz) * 60 * 1000;
    const dayStartUTC = new Date(new Date(today + 'T00:00:00Z').getTime() - offsetMs).toISOString();
    const dayEndUTC   = new Date(new Date(today + 'T23:59:59Z').getTime() - offsetMs).toISOString();

    const d = await api(`/api/news?from=${encodeURIComponent(dayStartUTC)}&to=${encodeURIComponent(dayEndUTC)}`);
    renderTodayNews(d.events || []);
  } catch (e) { console.warn('[today-news]', e.message); }
}

// ─── Today's News — preview + show more ───────────────────────────────────
const NEWS_PREVIEW = 4; // upcoming events shown by default
let _todayNewsCache = [];

function toggleNewsExpand() {
  const expanded = localStorage.getItem('nfx_news_expanded') === '1';
  localStorage.setItem('nfx_news_expanded', expanded ? '0' : '1');
  renderTodayNews(_todayNewsCache);
}

function renderTodayNews(events) {
  _todayNewsCache = events;
  const el = document.getElementById('today-news-list');
  const moreWrap = document.getElementById('news-more-row');
  if (!el) return;

  const tz = (_userTz === 'auto')
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : (_userTz || 'UTC');

  // Update date sub-label in user's timezone
  const dateEl = document.getElementById('today-news-date');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-GB', {
    weekday:'short', day:'2-digit', month:'short', year:'numeric', timeZone: tz
  });

  if (!events.length) {
    el.innerHTML = '<div class="today-news-empty">No news events scheduled for today</div>';
    const b = document.getElementById('today-news-next-badge');
    if (b) b.style.display = 'none';
    if (moreWrap) moreWrap.innerHTML = '';
    return;
  }

  const now = Date.now();
  events.sort((a, b) => new Date(a.event_time) - new Date(b.event_time));

  // Next upcoming event index
  const nextIdx = events.findIndex(e => new Date(e.event_time).getTime() > now);

  // "Next in Xm" badge
  const badge = document.getElementById('today-news-next-badge');
  if (badge) {
    if (nextIdx >= 0) {
      const ms   = new Date(events[nextIdx].event_time) - now;
      const mins = Math.round(ms / 60000);
      badge.textContent = mins < 60
        ? `Next in ${mins}m`
        : `Next in ${Math.floor(mins/60)}h ${mins%60}m`;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  // Decide which events to show
  const expanded   = localStorage.getItem('nfx_news_expanded') === '1';
  // Preview: upcoming events only (from nextIdx), capped at NEWS_PREVIEW
  const previewStart  = nextIdx >= 0 ? nextIdx : events.length;
  const previewEvents = events.slice(previewStart, previewStart + NEWS_PREVIEW);
  const displayEvents = expanded ? events : previewEvents;
  const hiddenCount   = expanded ? 0 : (events.length - previewEvents.length);

  const impCls = { HIGH:'tni-high', MEDIUM:'tni-med', LOW:'tni-low' };

  const renderRow = (e, i) => {
    const t       = new Date(e.event_time).getTime();
    const isPast  = t < now;
    const origIdx = events.indexOf(e);
    const isNext  = origIdx === nextIdx;
    const isSoon  = !isPast && (t - now) < 3600000;

    const rowCls  = isPast ? 'tnr past' : isNext ? 'tnr next-up' : isSoon ? 'tnr soon' : 'tnr';
    const timeStr = new Date(e.event_time).toLocaleTimeString('en-GB',
      { hour:'2-digit', minute:'2-digit', timeZone: tz });

    return `<div class="${rowCls}">
      <span class="tn-time">${timeStr}</span>
      <span class="tn-cur">${e.currency}</span>
      <span class="tn-name">${e.event_name}</span>
      <span class="tn-imp ${impCls[e.impact] || 'tni-low'}">${e.impact}</span>
      <span class="tn-fc h-fc">${e.forecast || '—'}</span>
      <span class="tn-prev h-prev">${e.previous || '—'}</span>
    </div>`;
  };

  el.innerHTML = displayEvents.length
    ? displayEvents.map(renderRow).join('')
    : '<div class="today-news-empty">No upcoming events — all done for today</div>';

  // Show more / Show less button
  if (moreWrap) {
    if (!expanded && hiddenCount > 0) {
      moreWrap.innerHTML = `<button class="news-show-more" onclick="toggleNewsExpand()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        Show ${hiddenCount} more event${hiddenCount !== 1 ? 's' : ''}
      </button>`;
    } else if (expanded) {
      moreWrap.innerHTML = `<button class="news-show-more" onclick="toggleNewsExpand()">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>
        Show less
      </button>`;
    } else {
      moreWrap.innerHTML = '';
    }
  }
}

function pairCurrencies(instrument) {
  const s = (instrument || '').replace('/', '').replace('_', '').toUpperCase();
  return [s.slice(0, 3), s.slice(3, 6)];
}

// Returns HTML warning strip for upcoming HIGH/MEDIUM news on this pair
function newsWarnHtml(instrument, hoursAhead = 4) {
  const [c1, c2] = pairCurrencies(instrument);
  const now     = Date.now();
  const cutoff  = now + hoursAhead * 60 * 60 * 1000;

  const hits = [];
  for (const cur of [c1, c2]) {
    (_newsMap[cur] || []).forEach(e => {
      const t = new Date(e.event_time).getTime();
      if (t >= now && t <= cutoff && (e.impact === 'HIGH' || e.impact === 'MEDIUM')) {
        hits.push({ ...e, cur });
      }
    });
  }
  if (!hits.length) return '';

  hits.sort((a, b) => new Date(a.event_time) - new Date(b.event_time));

  const badges = hits.map(h => {
    const mins = Math.round((new Date(h.event_time) - now) / 60000);
    const when = mins < 60 ? `in ${mins}m` : `in ${Math.round(mins / 60)}h`;
    const cls  = h.impact === 'HIGH' ? 'news-warn-high' : 'news-warn-med';
    return `<span class="news-warn-badge ${cls}">📰 ${h.cur}: ${h.event_name} ${when}</span>`;
  }).join('');

  return `<div class="news-warn-row">${badges}</div>`;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(n, d = 5) { return n != null ? Number(n).toFixed(d) : '—'; }
function pair(s) { return s ? s.replace('_', '/') : s; }
function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const tz = (_userTz === 'auto')
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : (_userTz || 'UTC');
    return new Intl.DateTimeFormat('en-GB', {
      timeZone:     tz,
      day:          '2-digit',
      month:        'short',
      year:         'numeric',
      hour:         '2-digit',
      minute:       '2-digit',
      hour12:       false,
      timeZoneName: 'short',
    }).format(new Date(iso));
  } catch (_) {
    return new Date(iso).toUTCString().replace('GMT', 'UTC');
  }
}

// Calendar form: "14:35 GMT+3" — time + TZ only, no date (used in calendar rows)
function fmtCalTime(iso) {
  if (!iso) return '—';
  try {
    const tz = (_userTz === 'auto')
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : (_userTz || 'UTC');
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit',
      hour12: false, timeZoneName: 'short',
    }).format(new Date(iso));
  } catch (_) {
    return new Date(iso).toUTCString().slice(17, 22) + ' UTC';
  }
}

// Short form: "10 May 14:35 EAT" — used in compact rows
function fmtShort(iso) {
  if (!iso) return '—';
  try {
    const tz = (_userTz === 'auto')
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : (_userTz || 'UTC');
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
    }).format(new Date(iso));
  } catch (_) {
    return new Date(iso).toUTCString().slice(5, 22).replace('GMT', 'UTC');
  }
}

// Replace underscores with spaces for display (e.g. READY_TO_ENTER → READY TO ENTER)
function clean(s) { return s ? s.replace(/_/g, ' ') : s; }

// ── Session-hour timezone helpers ─────────────────────────────────────────────

// Minutes the user's timezone is ahead of UTC right now (DST-aware)
function getTzOffsetMins(tz) {
  try {
    const effective = (tz === 'auto') ? Intl.DateTimeFormat().resolvedOptions().timeZone : (tz || 'UTC');
    const now = new Date();
    const fmt = zone => new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(now).split(':').map(Number);
    const [uh, um] = fmt('UTC');
    const [lh, lm] = fmt(effective);
    let d = (lh * 60 + lm) - (uh * 60 + um);
    if (d >  720) d -= 1440;
    if (d < -720) d += 1440;
    return d;
  } catch(_) { return 0; }
}

// Short timezone label, e.g. "EAT", "CET", "EST"
function getTzAbbr(tz) {
  try {
    const effective = (tz === 'auto') ? Intl.DateTimeFormat().resolvedOptions().timeZone : (tz || 'UTC');
    return new Intl.DateTimeFormat('en-GB', { timeZone: effective, timeZoneName: 'short' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || 'UTC';
  } catch(_) { return 'UTC'; }
}

// Shift a UTC integer hour by offsetMins → "HH" (whole hour) or "HH:MM" (fractional, e.g. IST)
function fmtSessH(utcH, offsetMins) {
  const total = ((utcH * 60 + offsetMins) % 1440 + 1440) % 1440;
  const h = Math.floor(total / 60), m = total % 60;
  return m === 0
    ? String(h).padStart(2, '0')
    : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Always returns "HH:MM" — used in the range label ("10:00 – 13:00 EAT")
function fmtSessHFull(utcH, offsetMins) {
  const total = ((utcH * 60 + offsetMins) % 1440 + 1440) % 1440;
  const h = Math.floor(total / 60), m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function fmtNow() {
  try {
    const tz = (_userTz === 'auto')
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : (_userTz || 'UTC');
    return new Intl.DateTimeFormat('en-GB', {
      timeZone:     tz,
      hour:         '2-digit',
      minute:       '2-digit',
      second:       '2-digit',
      hour12:       false,
      timeZoneName: 'short',
    }).format(new Date());
  } catch (_) {
    return new Date().toLocaleTimeString();
  }
}
function timeAgo(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const hrs  = Math.floor(diff / 3600000);
  const mins = Math.floor(diff / 60000);
  if (hrs >= 24) return `${Math.floor(hrs / 24)}d ago`;
  if (hrs > 0)   return `${hrs}h ago`;
  if (mins > 0)  return `${mins}m ago`;
  return 'just now';
}

// ─── Pipeline HTML ────────────────────────────────────────────────────────────
// stage: 0=none 1=TREND 2=PULLBACK_STARTING 3=PULLBACK_ACTIVE 4=READY_TO_ENTER 5=ENTRY_ACTIVE
const PIPE_LABELS = ['TREND', 'PB START', 'PB ACTIVE', 'READY', 'ENTRY'];
function pipelineHtml(stage) {
  if (!stage || stage === 0) return '';
  return `<div class="pipeline">` +
    PIPE_LABELS.map((label, i) => {
      const s   = i + 1;
      const cls = s < stage ? 'done' : s === stage ? `active${stage === 5 ? ' s4' : ''}` : '';
      return `<span class="pipe-step ${cls}">${label}</span>` +
             (i < 4 ? `<span class="pipe-arrow">›</span>` : '');
    }).join('') +
  `</div>`;
}

function nextActionHtml(text) {
  if (!text || text === 'No setup forming') return '';
  const cls = text === 'ENTER NOW' ? 'enter'
            : text.startsWith('Wait') ? 'wait'
            : text.startsWith('3H') ? 'wait'
            : 'watch';
  const icon = text === 'ENTER NOW' ? '▶ ' : '→ ';
  return `<div class="next-action ${cls}">${icon}${clean(text)}</div>`;
}

// ─── Header ───────────────────────────────────────────────────────────────────

function updateHeader(risk) {
  if (!risk?.summary) return;
  const s = risk.summary;

  // Profile values take precedence over risk.js defaults
  const balance = _profile.account_size       ?? Number(s.balance)          ?? 0;
  const maxPct  = _profile.max_daily_risk_pct ?? Number(s.maxDailyRiskPct)  ?? 2;
  const maxTr   = _profile.max_trades         ?? Number(s.maxTrades)        ?? 3;
  const open    = Number(s.openTrades ?? 0);

  // Recalculate daily risk % against the user's actual account size
  const dailyRisk = Number(s.dailyRisk ?? 0);
  const riskPct   = balance > 0 ? (dailyRisk / balance) * 100 : 0;

  document.getElementById('stat-balance').textContent = `Balance: $${balance.toLocaleString()}`;
  document.getElementById('stat-risk').textContent    = `Daily Risk: ${riskPct.toFixed(2)}% / ${maxPct}%`;
  document.getElementById('stat-trades').textContent  = `Open: ${open} / ${maxTr}`;
  document.getElementById('status-dot').className     = 'status-dot online';
  document.getElementById('last-update').textContent  = 'Updated ' + fmtNow();
}

let _profile = { account_size: null, max_daily_risk_pct: null, max_trades: null };
let _userTz = 'UTC'; // overridden from profile on every refresh

// ─── Session badge helper ─────────────────────────────────────────────────────

function sessionBadgeHtml(s) {
  if (!s.session_label) return '';
  const qCls  = (s.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
  const delta = s.session_delta;
  const dStr  = delta != null ? (delta > 0 ? ` +${delta}` : ` ${delta}`) : '';
  return `<span class="sess-card-badge sq-${qCls}">⏱ ${s.session_label}${dStr}</span>`;
}

// ─── Live Opportunities ───────────────────────────────────────────────────────

function renderLiveOpportunities(states) {
  const el = document.getElementById('live-opportunities');
  if (!el) return;

  const noSignal = _csigDataLoaded && !_csigCurrencies.size;
  if (noSignal) {
    el.innerHTML = '<p class="empty-state">No currency signal — at least two currencies must qualify before opportunities appear</p>';
    const sec = document.getElementById('section-live');
    if (sec) sec.style.borderColor = 'var(--border)';
    return;
  }

  const live = (states || []).filter(s => s.state === 'READY_TO_ENTER' && hasCsigCurrency(s.instrument));

  if (!live.length) {
    el.innerHTML = '<p class="empty-state" style="color:var(--text-muted)">No live opportunities right now — monitoring active setups</p>';
    const sec = document.getElementById('section-live');
    if (sec) sec.style.borderColor = 'var(--border)';
    return;
  }

  const sec = document.getElementById('section-live');
  if (sec) sec.style.borderColor = '#4ade80';

  el.innerHTML = live.map(s => {
    const dir     = s.bias === 'BUY' ? 'buy' : 'sell';
    const ta      = s.tf_alignment || {};
    const isEntry = s.phase === 'ENTRY_ACTIVE';
    return `
      <div class="live-card ${dir}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div class="live-pair">${pair(s.instrument)}</div>
            <div class="live-signal ${dir}">${s.bias}</div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px">
              <span class="phase-badge ${isEntry ? 'ENTRY_ACTIVE' : 'READY_TO_ENTER'}">${isEntry ? 'ENTRY ACTIVE' : 'READY TO ENTER'}</span>
              ${s.pullback_depth ? `<span class="pb-depth ${s.pullback_depth}">${s.pullback_depth} PB</span>` : ''}
              ${sessionBadgeHtml(s)}
            </div>
          </div>
          <div style="text-align:right">
            <div class="live-conf-num">${s.confidence}%</div>
            <div class="conf-bar" style="width:60px;margin-left:auto"><div class="conf-fill" style="width:${s.confidence}%"></div></div>
          </div>
        </div>
        <div class="signal-tf-row">
          <span class="tf-item ${ta.h12}">12H ${ta.h12||'→'}</span>
          <span class="tf-item ${ta.h6}">6H ${ta.h6||'→'}</span>
          <span class="tf-item ${ta.h3}">3H ${ta.h3||'→'}</span>
          <span class="sb-behavior ${s.spread_behavior}">${clean(s.spread_behavior||'')}</span>
        </div>
        <div class="live-reason">${s.spread_behavior_text}</div>
        ${newsWarnHtml(s.instrument)}
        ${s.session_blocked ? `<div class="sent-neutral-warn">⚠ ${s.next_action || 'Outside active session'}</div>` : ''}
        ${(s.confidence_breakdown||[]).length ? `<div class="conf-factors" style="align-items:flex-start;margin-top:6px">${s.confidence_breakdown.map(f=>`<span>+ ${f}</span>`).join('')}</div>` : ''}
      </div>`;
  }).join('');
}

// ─── Top Setups ───────────────────────────────────────────────────────────────

function computeTopSetups(states) {
  const priority = { READY: 3, PULLBACK: 2, TREND: 1 };
  return [...states]
    .filter(s => s.state !== 'NO_TRADE' && s.confidence > 0 && !s.session_blocked)
    .sort((a, b) => {
      const pa = priority[a.phase] || 0, pb = priority[b.phase] || 0;
      return pa !== pb ? pb - pa : b.confidence - a.confidence;
    })
    .slice(0, 3);
}

function renderTopSetups(states) {
  const el = document.getElementById('top-setups');
  const noSignal = _csigDataLoaded && !_csigCurrencies.size;
  if (noSignal) { el.innerHTML = '<p class="empty-state">No currency signal — at least two currencies must qualify before setups appear</p>'; return; }
  if (!states?.length) { el.innerHTML = '<p class="empty-state">No setups forming</p>'; return; }

  const setups = computeTopSetups(states).filter(s => hasCsigCurrency(s.instrument));
  if (!setups.length) { el.innerHTML = '<p class="empty-state">No setups forming</p>'; return; }

  const rankCls = ['hot', 'warm', 'cool'];
  el.innerHTML = setups.map((s, i) => {
    const dir   = s.bias === 'BUY' ? 'buy' : 'sell';
    const ta    = s.tf_alignment || {};
    const phCls = (s.phase || '').replace(' ', '_');
    const bd    = s.confidence_breakdown || [];
    return `
      <div class="top-card ${rankCls[i]}">
        <div class="top-rank">${i + 1}</div>
        <div class="top-body">
          <div class="top-header">
            <span class="top-pair">${pair(s.instrument)}</span>
            <span class="signal-dir ${dir}">${s.bias}</span>
            <span class="phase-badge ${phCls}">${clean(s.phase||'')}</span>
            <span class="action-badge ${s.action}">${clean(s.action)}</span>
          </div>
          ${sessionBadgeHtml(s)}
          ${pipelineHtml(s.pipeline_stage)}
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <div class="top-entry-status entry-${s.entry_status}">${clean(s.entry_status || '')}</div>
            ${s.pullback_depth ? `<span class="pb-depth ${s.pullback_depth}">${s.pullback_depth} PULLBACK</span>` : ''}
          </div>
          <div class="top-tf">
            <span class="tf-item ${ta.h12}">12H ${ta.h12 || '→'}</span>
            <span class="tf-item ${ta.h6}">6H ${ta.h6 || '→'}</span>
            <span class="tf-item ${ta.h3}">3H ${ta.h3 || '→'}</span>
            <span class="sb-behavior ${s.spread_behavior}">${clean(s.spread_behavior||'')}</span>
          </div>
          <div style="font-size:9px;color:var(--text-muted);margin-bottom:3px">${s.spread_behavior_text || ''}</div>
          ${nextActionHtml(s.next_action)}
          ${newsWarnHtml(s.instrument)}
        </div>
        <div class="top-conf">
          <div class="conf-num">${s.confidence}%</div>
          <div class="conf-bar" style="width:72px"><div class="conf-fill" style="width:${s.confidence}%"></div></div>
          ${bd.length ? `<div class="conf-factors">${bd.map(f => `<span>+ ${f}</span>`).join('')}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ─── Signal board ─────────────────────────────────────────────────────────────

// ─── Trade Watchlist ──────────────────────────────────────────────────────────
// Shows only actionable pairs: PULLBACK_STARTING, PULLBACK_ACTIVE, BASE_FORMING, READY_TO_ENTER, REVERSAL_CONFIRMED
// Sorted by pipeline priority then confidence. CS-filtered.

const WATCHLIST_STATES = new Set(['PULLBACK_STARTING', 'PULLBACK_ACTIVE', 'BASE_FORMING', 'READY_TO_ENTER', 'REVERSAL_CONFIRMED']);

function watchlistCard(s, sig) {
  const dir     = s.bias === 'BUY' ? 'buy' : s.bias === 'SELL' ? 'sell' : '';
  const ta      = s.tf_alignment || {};
  const phCls   = (s.phase || s.state || '').replace(/ /g, '_');
  const isEntry = s.phase === 'ENTRY_ACTIVE';
  const bd      = s.confidence_breakdown || [];

  const priceLine = sig?.entry_price
    ? `<div class="wl-prices">
        <span><span class="wl-lbl">Entry</span>${fmt(sig.entry_price)}</span>
        <span><span class="wl-lbl">SL</span><span class="wl-sl">${fmt(sig.stop_loss)}</span></span>
        <span><span class="wl-lbl">TP</span><span class="wl-tp">${fmt(sig.take_profit)}</span></span>
       </div>`
    : '';

  return `
    <div class="wl-card ${dir}${isEntry ? ' wl-entry' : ''}">
      <div class="wl-top">
        <span class="wl-pair">${pair(s.instrument)}</span>
        ${dir ? `<span class="signal-dir ${dir}">${s.bias}</span>` : ''}
        <span class="phase-badge ${phCls}">${clean(s.phase || s.state || '')}</span>
        <span class="action-badge ${s.action}">${clean(s.action) || '—'}</span>
        <span class="wl-conf">${s.confidence}%</span>
      </div>
      <div class="wl-tf">
        <span class="tfa ${ta.h12}">12H ${ta.h12||'→'}</span>
        <span class="tfa ${ta.h6}">6H ${ta.h6||'→'}</span>
        <span class="tfa ${ta.h3}">3H ${ta.h3||'→'}</span>
        <span class="sb-behavior ${s.spread_behavior}">${clean(s.spread_behavior||'')}</span>
        ${s.pullback_depth ? `<span class="pb-depth ${s.pullback_depth}">${s.pullback_depth}</span>` : ''}
      </div>
      <div class="wl-conf-bar"><div class="wl-conf-fill" style="width:${s.confidence}%"></div></div>
      ${bd.length ? `<div class="conf-factors" style="margin-top:3px">${bd.map(f => `<span>+ ${f}</span>`).join('')}</div>` : ''}
      ${priceLine}
      ${s.session_label ? `<div class="sess-inline-badge sq-${(s.session_quality||'').toLowerCase().replace(/_/g,'-')}">${s.session_label}${s.session_delta != null ? ` <span class="sess-inline-delta">${s.session_delta > 0 ? '+' : ''}${s.session_delta}</span>` : ''}</div>` : ''}
      ${nextActionHtml(s.next_action)}
      ${newsWarnHtml(s.instrument)}
    </div>`;
}

// States that a tracked pair must NOT be in to stay on the watchlist.
// REVERSAL_DEVELOPING = medium-term flip confirmed. NO_TRADE = spread too small to trade.
// REVERSAL_RISK is NOT here — 6H just going flat, might recover, keep pair visible.
const WATCHLIST_REMOVE = new Set(['REVERSAL_DEVELOPING', 'NO_TRADE']);

function renderSignals(data, statesArr, journalEntries) {
  const el = document.getElementById('watchlist-list');
  if (!el) return;

  const noSignal = _csigDataLoaded && !_csigCurrencies.size;
  if (noSignal) {
    el.innerHTML = '<p class="empty-state">No currency signal — at least two currencies must qualify before watchlist populates</p>';
    return;
  }

  // Signal map for entry/stop/target price lookup
  const sigMap = {};
  (data?.signals || []).forEach(s => { sigMap[s.instrument] = s; });

  // State map for fast lookup by instrument
  const stateMap = {};
  (statesArr || []).forEach(s => { stateMap[s.instrument] = s; });

  // Seed watchlist with pairs currently in an actionable state
  const watchlist = new Map();
  (statesArr || [])
    .filter(s => WATCHLIST_STATES.has(s.state))
    .forEach(s => watchlist.set(s.instrument, s));

  // Augment with pairs tracked by the journal (cross-session persistence).
  // The tracked set carries pairs from the last completed hourly cycle that
  // entered pullback and haven't reversed. Add any tracked pair not already
  // in the watchlist, provided its current state is still tradeable.
  const latestEntry = (journalEntries || [])[0];
  for (const t of (latestEntry?.tracked_pullback_pairs || [])) {
    if (watchlist.has(t.instrument)) continue;          // already shown
    const cur = stateMap[t.instrument];
    if (!cur) continue;
    if (WATCHLIST_REMOVE.has(cur.state)) continue;      // reversed or dead spread
    if (!cur.bias || cur.bias === 'NONE') continue;     // lost directional bias
    watchlist.set(t.instrument, cur);
  }

  const actionable = [...watchlist.values()]
    .filter(s => hasCsigCurrency(s.instrument))
    .sort((a, b) => {
      if ((b.pipeline_stage || 0) !== (a.pipeline_stage || 0))
        return (b.pipeline_stage || 0) - (a.pipeline_stage || 0);
      return (b.confidence || 0) - (a.confidence || 0);
    });

  el.innerHTML = actionable.length
    ? actionable.map(s => watchlistCard(s, sigMap[s.instrument])).join('')
    : '<p class="empty-state">No actionable setups — waiting for pullback or entry signal</p>';
}

// ─── Currency Signals (strong / weak filter) ──────────────────────────────────

const CS_THRESHOLD = 0.00100; // 0.00100 combined AND 3H must both exceed this

function renderCurrencySignals(data) {
  const el = document.getElementById('currency-signals-body');
  if (!el) return;

  const currencies = data?.currencies || [];
  if (!currencies.length) {
    _csigCurrencies = new Set();
    _csigDataLoaded = false; // no source data — keep pass-through
    el.innerHTML = '<p class="empty-state">No strength data</p>';
    return;
  }

  // Update timestamp
  const timeEl = document.getElementById('cs-sig-time');
  if (timeEl && data.time) timeEl.textContent = 'as of ' + fmtShort(data.time);

  // Compute combined (equal-weight avg 3H+6H+12H) + extract 3H for each currency
  const scored = currencies.map(c => {
    const v3  = parseFloat(c.smooth_3h  ?? c.normalized_3h)  || 0;
    const v6  = parseFloat(c.smooth_6h  ?? c.normalized_6h)  || 0;
    const v12 = parseFloat(c.smooth_12h ?? c.normalized_12h) || 0;
    return { cur: c.currency, combined: (v3 + v6 + v12) / 3, h3: v3, h6: v6, h12: v12 };
  });

  const strong = scored
    .filter(c => c.combined > CS_THRESHOLD && c.h3 > CS_THRESHOLD)
    .sort((a, b) => b.combined - a.combined);

  const weak = scored
    .filter(c => c.combined < -CS_THRESHOLD && c.h3 < -CS_THRESHOLD)
    .sort((a, b) => a.combined - b.combined);

  // Expose flagged currencies globally so section renderers can filter pairs.
  // At least 2 currencies must qualify for signals to be considered valid.
  const allQualified = [...strong.map(c => c.cur), ...weak.map(c => c.cur)];
  _csigCurrencies = allQualified.length >= 2 ? new Set(allQualified) : new Set();
  _csigDataLoaded = true; // strength data processed — empty set now means "no signals"

  function scoreBar(val, max) {
    const pct = Math.round((Math.abs(val) / max) * 100);
    return `<div class="cs-sig-bar-wrap"><div class="cs-sig-bar ${val >= 0 ? 'pos' : 'neg'}" style="width:${pct}%"></div></div>`;
  }

  function col(list, side) {
    const isStrong = side === 'strong';
    const maxAbs   = Math.max(...list.map(c => Math.abs(c.combined)), 0.0001);
    if (!list.length) return `
      <div class="cs-sig-col ${side}">
        <div class="cs-sig-col-title">${isStrong ? '💪 Strong' : '🔻 Weak'}</div>
        <div class="cs-sig-empty">No confirmed ${isStrong ? 'bullish' : 'bearish'} signal</div>
      </div>`;
    return `
      <div class="cs-sig-col ${side}">
        <div class="cs-sig-col-title">${isStrong ? '💪 Strong' : '🔻 Weak'}</div>
        <div class="cs-sig-head">
          <span>CCY</span><span>Combined</span><span>3H</span><span>6H</span><span>12H</span>
        </div>
        ${list.map(c => `
          <div class="cs-sig-row">
            <span class="cs-sig-cur">${c.cur}</span>
            <span class="cs-sig-combo ${isStrong ? 'pos' : 'neg'}">${c.combined >= 0 ? '+' : ''}${c.combined.toFixed(5)}</span>
            <span class="cs-sig-val ${c.h3  >= 0 ? 'pos' : 'neg'}">${c.h3  >= 0 ? '+' : ''}${c.h3.toFixed(5)}</span>
            <span class="cs-sig-val ${c.h6  >= 0 ? 'pos' : 'neg'}">${c.h6  >= 0 ? '+' : ''}${c.h6.toFixed(5)}</span>
            <span class="cs-sig-val ${c.h12 >= 0 ? 'pos' : 'neg'}">${c.h12 >= 0 ? '+' : ''}${c.h12.toFixed(5)}</span>
          </div>`).join('')}
      </div>`;
  }

  el.innerHTML = `<div class="cs-sig-grid">${col(strong, 'strong')}${col(weak, 'weak')}</div>`;
}

// ─── Currency strength chart ──────────────────────────────────────────────────

function buildChart(data, tf) {
  if (!data?.currencies) return;
  strengthData = data;
  document.getElementById('strength-time').textContent = 'As of ' + fmtTime(data.time);

  const currencies = [...data.currencies].sort((a, b) => {
    const av = parseFloat(a[`smooth_${tf}h`] ?? a[`normalized_${tf}h`] ?? 0);
    const bv = parseFloat(b[`smooth_${tf}h`] ?? b[`normalized_${tf}h`] ?? 0);
    return bv - av;
  });

  const labels       = currencies.map(c => c.currency);
  const values       = currencies.map(c => parseFloat(c[`smooth_${tf}h`] ?? c[`normalized_${tf}h`] ?? 0));
  const colors       = values.map(v => v >= 0 ? 'rgba(22,163,74,0.85)' : 'rgba(220,38,38,0.85)');
  const borderColors = values.map(v => v >= 0 ? '#16a34a' : '#dc2626');

  if (strengthChart) strengthChart.destroy();
  const ctx = document.getElementById('strengthChart').getContext('2d');
  strengthChart = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: borderColors, borderWidth: 1, borderRadius: 4 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + ctx.raw.toFixed(6) } } },
      scales: {
        x: { ticks: { color: '#94a3b8', font: { family: 'monospace', size: 11 } }, grid: { color: '#1e2128' } },
        y: { ticks: { color: '#94a3b8', font: { family: 'monospace', size: 10 } }, grid: { color: '#1e2128' } },
      },
    },
  });

  renderMomentumStrip(data.currencies);
}

function renderMomentumStrip(currencies) {
  const el = document.getElementById('strength-momentum');
  if (!el || !currencies?.length) return;
  const sorted = [...currencies].sort((a, b) =>
    (parseFloat(b.smooth_6h) || 0) - (parseFloat(a.smooth_6h) || 0)
  );
  el.innerHTML = sorted.map(c => {
    const v    = parseFloat(c.smooth_6h) || 0;
    const cls  = v > 0.01 ? 'pos' : v < -0.01 ? 'neg' : 'neu';
    const acc  = c.accel_label === 'accelerating' ? ' ▲' : c.accel_label === 'decelerating' ? ' ▼' : '';
    return `<span class="mom-item ${cls}" title="${c.accel_label || ''}">${c.currency} ${c.momentum || '→'}${acc}</span>`;
  }).join('');
}

// TF toggle
document.querySelectorAll('.tf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTF = btn.dataset.tf;
    if (strengthData) buildChart(strengthData, activeTF);
  });
});

// ─── Market states ────────────────────────────────────────────────────────────

// ─── Full Market Scanner ──────────────────────────────────────────────────────
// Compact single-line rows for all 28 pairs. Sorted: actionable first (by
// pipeline_stage desc), NO_TRADE at bottom. TF arrows show raw spread direction.

function renderStates(data) {
  if (!data?.states) return;
  const el = document.getElementById('states-table');
  if (!el) return;

  // Sort: pipeline_stage desc → confidence desc → NO_TRADE last
  const sorted = [...data.states].sort((a, b) => {
    const pa = (a.state === 'NO_TRADE' || !a.bias || a.bias === 'NONE') ? -1 : (a.pipeline_stage || 0);
    const pb = (b.state === 'NO_TRADE' || !b.bias || b.bias === 'NONE') ? -1 : (b.pipeline_stage || 0);
    if (pb !== pa) return pb - pa;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  el.innerHTML = sorted.map(s => {
    const ta       = s.tf_alignment || {};
    const dir      = s.bias === 'BUY' ? 'buy' : s.bias === 'SELL' ? 'sell' : '';
    const isNoTrade = s.state === 'NO_TRADE' || !s.bias || s.bias === 'NONE';
    const phCls    = (s.phase || s.state || '').replace(/ /g, '_');

    return `<div class="scanner-row${isNoTrade ? ' no-trade' : ''}">
      <span class="scanner-pair">${pair(s.instrument)}</span>
      ${dir
        ? `<span class="signal-dir ${dir}" style="font-size:8px;padding:1px 5px;margin:0">${s.bias}</span>`
        : `<span class="scanner-no-dir">—</span>`}
      <span class="phase-badge ${phCls}" style="font-size:8px;padding:1px 5px;white-space:nowrap">${clean(s.phase || s.state || '')}</span>
      <span class="action-badge ${s.action}" style="font-size:8px;padding:1px 5px;white-space:nowrap">${clean(s.action) || '—'}</span>
      <span class="scanner-conf">${s.confidence}%</span>
      <span class="scanner-tf">
        <span class="tfa ${ta.h12}">12H${ta.h12||'→'}</span>
        <span class="tfa ${ta.h6}">6H${ta.h6||'→'}</span>
        <span class="tfa ${ta.h3}">3H${ta.h3||'→'}</span>
      </span>
      <span class="sb-behavior ${s.spread_behavior}" style="font-size:8px;white-space:nowrap">${clean(s.spread_behavior||'')}</span>
    </div>`;
  }).join('');
}

// ─── Spread ranking ───────────────────────────────────────────────────────────

function renderSpreads(data) {
  if (!data?.spreads) return;
  // Use server-sorted order (weighted: 40% 12H + 35% 6H + 15% 3H + 10% accel)
  const sorted = data.spreads;
  const maxScore = Math.max(...sorted.map(s => s.weighted_score || 0), 0.0001);
  document.getElementById('spreads-list').innerHTML = sorted.map(s => {
    const v6  = parseFloat(s.spread_6h);
    const cls = v6 >= 0 ? 'buy' : 'sell';
    const pct = Math.round(((s.weighted_score || 0) / maxScore) * 100);
    return `
      <div class="spread-row">
        <div class="spread-accent ${cls}"></div>
        <span class="spread-pair">${pair(s.instrument)}</span>
        <span class="spread-bias ${cls}">${v6 >= 0 ? 'BUY' : 'SELL'}</span>
        <span class="spread-val">${fmt(v6, 5)}</span>
        <div class="spread-bar-wrap"><div class="spread-bar-fill ${cls}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');
}

// ─── 12H Pair Ranking ────────────────────────────────────────────────────────

function renderRanking12H(spreadsData) {
  const el = document.getElementById('ranking-12h-list');
  if (!el || !spreadsData?.spreads) return;

  // Sort purely by abs(spread_12h) — no weighted composite
  const ranked = [...spreadsData.spreads]
    .filter(s => s.spread_12h != null)
    .sort((a, b) => Math.abs(parseFloat(b.spread_12h)) - Math.abs(parseFloat(a.spread_12h)));

  if (!ranked.length) { el.innerHTML = '<p class="empty-state">No 12H data</p>'; return; }

  const maxVal = Math.abs(parseFloat(ranked[0].spread_12h)) || 0.0001;

  // Identical row structure to renderSpreads — reuses all .spread-* CSS
  el.innerHTML = ranked.map(s => {
    const v12 = parseFloat(s.spread_12h) || 0;
    const cls = v12 >= 0 ? 'buy' : 'sell';
    const pct = Math.round((Math.abs(v12) / maxVal) * 100);
    return `
      <div class="spread-row">
        <div class="spread-accent ${cls}"></div>
        <span class="spread-pair">${pair(s.instrument)}</span>
        <span class="spread-bias ${cls}">${v12 >= 0 ? 'BUY' : 'SELL'}</span>
        <span class="spread-val">${fmt(v12, 5)}</span>
        <div class="spread-bar-wrap"><div class="spread-bar-fill ${cls}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');
}

// ─── M15 Pair Ranking ─────────────────────────────────────────────────────────

// Notification bar filter — EXPANDING + COMPRESSING · all TFs same sign · |smooth_45m| >= CS_THRESHOLD
// Used by updateM15Bar() — shows active momentum (building or fading but still directional).
function getM15Impulses(data) {
  return (data?.spreads || [])
    .filter(s => {
      if (s.state !== 'EXPANDING' && s.state !== 'COMPRESSING' && s.state !== 'STEADY') return false;
      const s45  = parseFloat(s.smooth_45m)  || 0;
      const s90  = parseFloat(s.smooth_90m)  || 0;
      const s180 = parseFloat(s.smooth_180m) || 0;
      if (Math.sign(s45) !== Math.sign(s90))  return false;
      if (Math.sign(s45) !== Math.sign(s180)) return false;
      return Math.abs(s45) >= CS_THRESHOLD;
    })
    .sort((a, b) => Math.abs(parseFloat(b.smooth_45m)) - Math.abs(parseFloat(a.smooth_45m)));
}

// Card filter — all active states (not FLAT) · |smooth_45m| >= CS_THRESHOLD (±0.00100)
// Used by renderM15Spreads() — same threshold as bar, all states shown.
function getM15AllActive(data) {
  return (data?.spreads || [])
    .filter(s => s.state !== 'FLAT' && Math.abs(parseFloat(s.smooth_45m) || 0) >= CS_THRESHOLD)
    .sort((a, b) => Math.abs(parseFloat(b.smooth_45m)) - Math.abs(parseFloat(a.smooth_45m)));
}

function renderM15Spreads(data) {
  const el = document.getElementById('m15-spreads-list');
  if (!el) return;
  if (!data?.spreads?.length) {
    el.innerHTML = '<p class="empty-state">No M15 data yet</p>';
    return;
  }

  const spreads = getM15AllActive(data);

  if (!spreads.length) {
    el.innerHTML = '<p class="empty-state">No active M15 moves</p>';
    return;
  }

  const maxVal = Math.abs(parseFloat(spreads[0].smooth_45m)) || 0.0001;

  el.innerHTML = spreads.map(s => {
    const v45  = parseFloat(s.smooth_45m) || 0;
    const cls  = v45 >= 0 ? 'buy' : 'sell';
    const bias = cls === 'buy' ? 'BUY' : 'SELL';
    const pct  = Math.round((Math.abs(v45) / maxVal) * 100);
    return `
      <div class="spread-row m15-row">
        <div class="spread-accent ${cls}"></div>
        <span class="spread-pair">${pair(s.instrument)}</span>
        <span class="spread-bias ${cls}">${bias}</span>
        <span class="sb-behavior ${s.state}">${clean(s.state || '')}</span>
        <span class="spread-val">${fmt(v45, 5)}</span>
        <div class="spread-bar-wrap"><div class="spread-bar-fill ${cls}" style="width:${pct}%"></div></div>
      </div>`;
  }).join('');
}

// ─── M15 Impulse notification bar ─────────────────────────────────────────────

function updateM15Bar(data) {
  const bar = document.getElementById('m15-impulse-bar');
  if (!bar) return;

  // M15 impulse bar is a Pro+ feature — never show on free plan
  if (document.body.classList.contains('plan-free')) {
    bar.style.display = 'none';
    return;
  }

  const impulse = getM15Impulses(data);

  if (!impulse.length) {
    bar.style.display = 'none';
    return;
  }

  // Show max 2 chips; surface hidden count via +N badge
  const MAX_BAR_CHIPS = 2;
  const visible     = impulse.slice(0, MAX_BAR_CHIPS);
  const hiddenCount = impulse.length - visible.length;

  document.getElementById('m15-bar-chips').innerHTML = visible.map(s => {
    const v45  = parseFloat(s.smooth_45m) || 0;
    const bias = v45 >= 0 ? 'BUY' : 'SELL';
    const dir  = v45 >= 0 ? 'buy' : 'sell';
    const vStr = (v45 >= 0 ? '+' : '') + v45.toFixed(5);
    const stateLabel = s.state === 'COMPRESSING' ? ' ▾' : ' ▲';
    return `<span class="m15-bar-chip">
      <span class="chip-pair">${pair(s.instrument)}</span>
      <span class="chip-${dir}">${bias}${stateLabel}</span>
      <span class="chip-val">${vStr}</span>
    </span>`;
  }).join('');

  const moreEl = document.getElementById('m15-bar-more');
  const linkEl = document.getElementById('m15-bar-link');
  if (hiddenCount > 0) {
    if (moreEl) { moreEl.textContent = `+${hiddenCount} more`; moreEl.style.display = ''; }
    if (linkEl) linkEl.style.display = '';
  } else {
    if (moreEl) moreEl.style.display = 'none';
    if (linkEl) linkEl.style.display = 'none';
  }

  const timeEl = document.getElementById('m15-bar-time');
  if (timeEl && data.time) timeEl.textContent = fmtTime(data.time);

  bar.style.display = 'flex';
}

// ─── Risk / approved trades ───────────────────────────────────────────────────

function renderRisk(data) {
  if (!data) return;
  const el       = document.getElementById('risk-list');
  const noSignal = _csigDataLoaded && !_csigCurrencies.size;
  if (noSignal) { el.innerHTML = '<p class="empty-state">No currency signal — at least two currencies must qualify before trades are approved</p>'; return; }

  const approved = (data.approved || []).filter(r => hasCsigCurrency(r.instrument));

  if (approved.length === 0) { el.innerHTML = '<p class="empty-state">No approved trades today</p>'; return; }
  el.innerHTML = approved.map(r => {
    const dir = parseFloat(r.stop_loss) < parseFloat(r.entry_price) ? 'buy' : 'sell';
    return `
      <div class="risk-row">
        <div class="risk-row-header">
          <span class="risk-pair">${pair(r.instrument)} <span class="signal-dir ${dir}" style="font-size:9px">${dir.toUpperCase()}</span></span>
          <span style="color:var(--text-muted);font-size:10px">$${Number(r.risk_amount).toFixed(2)} risk · ${r.position_size} lots</span>
        </div>
        <div style="font-size:9px;color:var(--text-muted);opacity:0.6;margin-bottom:6px">${fmtShort(r.time)}</div>
        <div class="risk-prices">
          <div class="risk-price-item"><span>Entry</span>${fmt(r.entry_price)}</div>
          <div class="risk-price-item"><span>SL</span><span style="color:#f87171">${fmt(r.stop_loss)}</span></div>
          <div class="risk-price-item"><span>TP</span><span style="color:#4ade80">${fmt(r.take_profit)}</span></div>
          <div class="risk-price-item"><span>RR</span>1:${r.risk_reward || 2}</div>
        </div>
      </div>`;
  }).join('');
}

// ─── Actions log ──────────────────────────────────────────────────────────────

function renderActions(actions) {
  const el = document.getElementById('actions-list');
  if (!actions?.length) { el.innerHTML = '<p class="empty-state">No actions yet</p>'; return; }
  el.innerHTML = actions.map(a => `
    <div class="action-row">
      <span>${pair(a.instrument)}</span>
      <span class="action-status ${a.status}">${a.status}</span>
      <span style="color:var(--text-muted);font-size:10px">${clean(a.action_type||'')}</span>
      <span class="action-msg">${(a.message?.split('\n')[1] || a.error_message || '').replace(/([A-Z]{3})_([A-Z]{3})/g,'$1/$2')}</span>
      <span class="action-time">${fmtShort(a.time)}</span>
    </div>`).join('');
}

// ─── Trading Session ──────────────────────────────────────────────────────────

const SESSION_TIMELINE = [
  { name: 'ASIA',        label: 'Asia',       hours: '00–06', quality: 'medium'    },
  { name: 'LONDON_OPEN', label: 'LDN Open',   hours: '07–10', quality: 'high'      },
  { name: 'LONDON',      label: 'London',     hours: '10–13', quality: 'high'      },
  { name: 'LONDON_NY',   label: 'LDN/NY',     hours: '13–17', quality: 'very_high' },
  { name: 'LATE_NY',     label: 'Late NY',    hours: '17–21', quality: 'low'       },
  { name: 'DEAD_HOURS',  label: 'Low Liq.',   hours: '21–00', quality: 'blocked'   },
];

// Maps stored session_name keys (e.g. DEAD_HOURS) to human display labels.
// Falls back to clean() for any unknown key.
const SESSION_LABEL_MAP = {
  ASIA:        'Asia',
  LONDON_OPEN: 'LDN Open',
  LONDON:      'London',
  LONDON_NY:   'LDN/NY',
  LATE_NY:     'Late NY',
  DEAD_HOURS:  'Low Liquidity',
};
function sessionLabel(name) {
  if (!name) return '—';
  return SESSION_LABEL_MAP[name] || clean(name);
}

function renderSession(data) {
  const el = document.getElementById('session-display');
  if (!el) return;

  const s  = data?.session;
  const tl = data?.timeline || SESSION_TIMELINE;

  if (!s) {
    el.innerHTML = '<p class="empty-state">Session data unavailable</p>';
    return;
  }

  const qCls     = (s.quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
  const allowed  = s.trades_allowed;
  const activity = s.activity_index || 0;

  // Quality label display
  const qLabel = {
    VERY_HIGH: '✦ VERY HIGH',
    HIGH:      '▲ HIGH',
    MEDIUM:    '● MEDIUM',
    LOW:       '▼ LOW',
    BLOCKED:   '⛔ BLOCKED',
  }[s.quality] || s.quality;

  // Activity bar colour
  const actCls = activity >= 75 ? 'very-high'
               : activity >= 55 ? 'high'
               : activity >= 35 ? 'medium'
               : 'low';

  // Timezone-aware session hour display
  const offsetMins = getTzOffsetMins(_userTz);
  const tzLabel    = getTzAbbr(_userTz);
  const localRange = (s.start_hour != null && s.end_hour != null)
    ? `${fmtSessHFull(s.start_hour, offsetMins)} – ${fmtSessHFull(s.end_hour, offsetMins)} ${tzLabel}`
    : '';
  const dstBadge = s.dst_active
    ? ' <span class="sess-dst-badge">DST adjusted</span>'
    : '';

  // Timeline — prefer dynamic data from API (DST-aware hours); fall back to static
  const tlSource = tl && tl.length ? tl : SESSION_TIMELINE;
  const timelineHtml = tlSource.map(t => {
    const isCurrent = t.name === s.session;
    let hStr;
    if (t.startHour != null && t.endHour != null) {
      hStr = `${fmtSessH(t.startHour, offsetMins)}–${fmtSessH(t.endHour, offsetMins)}`;
    } else if (t.hours) {
      const [a, b] = t.hours.split(/[–\-]/).map(Number);
      hStr = `${fmtSessH(a, offsetMins)}–${fmtSessH(b, offsetMins)}`;
    } else {
      hStr = '';
    }
    return `<div class="sess-tl-item ${t.quality}${isCurrent ? ' current' : ''}">
      <span class="sess-tl-label">${t.label}</span>
      <span class="sess-tl-hours">${hStr}</span>
    </div>`;
  }).join('<span class="sess-tl-arrow">›</span>');

  // Session delta text for status line
  const deltaStr = s.conf_delta > 0 ? `+${s.conf_delta}` : `${s.conf_delta}`;
  const deltaHtml = s.conf_delta !== null && s.conf_delta !== -999
    ? `<span class="sess-delta ${s.conf_delta >= 0 ? 'pos' : 'neg'}">${deltaStr} conf</span>`
    : '';

  el.innerHTML = `
    <div class="session-main">
      <div class="session-name-wrap">
        <div class="sess-name-badge sq-${qCls}">${s.label || s.session}</div>
        ${localRange ? `<div class="sess-hours-utc">${localRange}${dstBadge}</div>` : ''}
      </div>
      <div class="session-quality-wrap">
        <div class="sess-qlabel sq-${qCls}">${qLabel}</div>
        <div class="sess-qdesc">${s.quality_desc || ''}</div>
      </div>
      <div class="session-activity-wrap">
        <div class="sess-act-header">
          <span class="sess-act-label">Market Activity</span>
          <span class="sess-act-pct">${activity}%</span>
        </div>
        <div class="sess-act-bar-wrap">
          <div class="sess-act-bar-fill act-${actCls}" style="width:${activity}%"></div>
        </div>
      </div>
      <div class="session-status-wrap">
        ${allowed
          ? `<div class="sess-status allowed">✓ TRADING ACTIVE</div>${deltaHtml}`
          : ''
        }
        ${!allowed ? (() => {
          try {
            const tz = (_userTz === 'auto') ? Intl.DateTimeFormat().resolvedOptions().timeZone : (_userTz || 'UTC');
            const localDay  = new Date().toLocaleDateString('en-GB', { weekday:'long',  timeZone: tz });
            const localTime = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone: tz });
            return `<div class="sess-local-time">🕐 Your time: ${localDay}, ${localTime}</div>`;
          } catch(_) { return ''; }
        })() : ''}
      </div>
    </div>
    <div class="session-timeline">${timelineHtml}</div>`;
}

// ─── Market Energy ────────────────────────────────────────────────────────────

const ME_SESSION_COLOR = { ASIA: '#10b981', LONDON: '#3b82f6', NEW_YORK: '#a855f7', LOW_LIQUIDITY: '#475569' };
const ME_SESSION_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York', LOW_LIQUIDITY: 'Low Liq.' };

// Top-level market cycle — the "brain" classification across sessions
const ME_MARKET_CYCLE_COLOR = {
  ACTIVE_EXPANSION:              '#22c55e',
  TRANSITION_BUILD_UP:           '#10b981',
  LOW_PARTICIPATION_COMPRESSION: '#7c3aed',
  DEEP_COMPRESSION:              '#4c1d95',
  POST_EXPANSION_RESET:          '#f59e0b',
  CYCLE_EXHAUSTION:              '#ef4444',
  MIXED_ACTIVITY:                '#0ea5e9',
};
const ME_MARKET_CYCLE_LABEL = {
  ACTIVE_EXPANSION:              'Active Expansion',
  TRANSITION_BUILD_UP:           'Transition Build-Up',
  LOW_PARTICIPATION_COMPRESSION: 'Low Participation Compression',
  DEEP_COMPRESSION:              'Deep Compression',
  POST_EXPANSION_RESET:          'Post-Expansion Reset',
  CYCLE_EXHAUSTION:              'Cycle Exhaustion',
  MIXED_ACTIVITY:                'Mixed Activity',
};
const ME_MOMENTUM_COLOR = { ACCELERATING: '#22c55e', DECELERATING: '#ef4444', STABLE: '#64748b' };
const ME_MOMENTUM_LABEL = { ACCELERATING: '↑ Accel', DECELERATING: '↓ Decel', STABLE: '— Stable' };

const ME_CYCLE_COLOR = {
  DEAD:              '#475569',
  LOW_PARTICIPATION: '#64748b',
  COMPRESSION:       '#7c3aed',
  TRANSITION:        '#10b981',
  EXPANSION:         '#22c55e',
  EXPLOSIVE:         '#fbbf24',
  EXHAUSTION:        '#ef4444',
  // legacy aliases for old DB rows
  PRESSURE_BUILDING: '#7c3aed',
  CONTROLLED_TREND:  '#06b6d4',
  QUIET_BALANCE:     '#64748b',
  ACTIVE_EXPANSION:  '#22c55e',
  CHAOTIC_EXPANSION: '#f97316',
  CONTROLLED:        '#06b6d4',
  BALANCED:          '#64748b',
};
const ME_CYCLE_LABEL = {
  DEAD:              'Dead',
  LOW_PARTICIPATION: 'Low Participation',
  COMPRESSION:       'Compression',
  TRANSITION:        'Transition',
  EXPANSION:         'Expansion',
  EXPLOSIVE:         'Explosive',
  EXHAUSTION:        'Exhaustion',
  // legacy
  PRESSURE_BUILDING: 'Compression',
  CONTROLLED_TREND:  'Expansion',
  QUIET_BALANCE:     'Low Participation',
  ACTIVE_EXPANSION:  'Expansion',
  CHAOTIC_EXPANSION: 'Expansion',
  CONTROLLED:        'Expansion',
  BALANCED:          'Low Participation',
};

function _meCompBar(value) {
  const v   = Math.min(100, Math.max(0, parseFloat(value) || 0));
  const col = v >= 60 ? '#22c55e' : v >= 40 ? '#0ea5e9' : v >= 20 ? '#f59e0b' : '#475569';
  return `<div class="me-comp-bar-track">
    <div class="me-comp-bar-fill" style="width:${v}%;background:${col}"></div>
  </div>`;
}

function _meDelta(val) {
  if (val == null) return '';
  const n = Math.round(parseFloat(val) || 0);
  if (n === 0) return '';
  const sign  = n > 0 ? '+' : '';
  const color = n > 0 ? '#22c55e' : '#ef4444';
  const arrow = n > 0 ? '↑' : '↓';
  return `<span class="me-delta" style="color:${color}">${sign}${n}${arrow}</span>`;
}

/** Color for a % deviation: green = above avg, amber = near, slate = below */
function _meRelColor(pct) {
  return pct >= 20 ? '#22c55e' : pct >= -10 ? '#f59e0b' : '#94a3b8';
}

/**
 * Compact inline norm · prev line — both % on one row.
 * Uses title attributes for full labels (hover to read).
 * norm = % vs historical session avg; prev = % vs previous same session.
 */
function _meRelLine(norm, prev) {
  if (norm == null && prev == null) return '';
  const parts = [];
  if (norm != null) {
    const sign = norm >= 0 ? '+' : '';
    parts.push(`<span class="me-comp-norm" style="color:${_meRelColor(norm)}" title="${sign}${norm}% vs historical avg">${sign}${norm}%</span>`);
  }
  if (prev != null && (norm == null || Math.abs(prev - norm) > 5)) {
    const sign  = prev >= 0 ? '+' : '';
    const color = prev >= 10 ? '#22c55e' : prev >= -10 ? '#f59e0b' : '#94a3b8';
    parts.push(`<span class="me-comp-prev" style="color:${color}" title="${sign}${prev}% vs prev session">${sign}${prev}%</span>`);
  }
  const inner = parts.length === 2
    ? parts[0] + '<span class="me-pct-sep">·</span>' + parts[1]
    : parts[0] || '';
  return inner ? `<div class="me-comp-pcts">${inner}</div>` : '';
}

function _meDirBar(pct, color) {
  const v = Math.min(100, Math.max(0, parseFloat(pct) || 0));
  return `<div class="me-comp-bar-track">
    <div class="me-comp-bar-fill" style="width:${v}%;background:${color}"></div>
  </div>`;
}

function _meSessionExplain(s, label) {
  if (!s) return '';
  const mov = Math.round(parseFloat(s.movement_score) || 0);
  const brd = Math.round(parseFloat(s.breadth_score) || 0);
  const agr = Math.round(parseFloat(s.agreement_score) || 0);
  const vol = Math.round(parseFloat(s.volatility_score) || 0);
  const energy = Math.round(parseFloat(s.market_energy) || 0);
  const bull = Math.round(parseFloat(s.bullish_breadth) || 0);
  const bear = Math.round(parseFloat(s.bearish_breadth) || 0);
  const activePct = Math.min(100, Math.round((parseFloat(s.active_pairs) || 0) / 28 * 100));
  const readiness = Math.round(parseFloat(s.expansion_readiness) || 0);
  const liq = Math.round(parseFloat(s.liquidity_score) || 0);
  const dom = Math.round(parseFloat(s.dominance_score) || 0);
  const strongCcys = (s.strongest_ccy || '').split(',').filter(Boolean);
  const weakCcys   = (s.weakest_ccy   || '').split(',').filter(Boolean);
  const strong = strongCcys[0] || null;
  const weak   = weakCcys[0]   || null;

  const lines = [];

  // Movement
  if (mov >= 60) lines.push(`Prices are moving strongly (${mov}/100) — high pip activity across pairs.`);
  else if (mov >= 35) lines.push(`Moderate price movement (${mov}/100) — some pairs are active.`);
  else lines.push(`Low price movement (${mov}/100) — most pairs are quiet.`);

  // Momentum
  if (brd >= 60) lines.push(`Wide momentum (${brd}/100) — strong directional conviction across the market.`);
  else if (brd >= 35) lines.push(`Moderate momentum (${brd}/100) — partial market participation, mixed conditions.`);
  else if (brd >= 20) lines.push(`Narrow momentum (${brd}/100) — moderate market participation, building conditions.`);
  else lines.push(`Narrow momentum (${brd}/100) — weak market participation, low conviction.`);

  // Agreement
  if (agr >= 60) lines.push(`High agreement (${agr}/100) — timeframes are aligned, trends are consistent.`);
  else if (agr >= 35) lines.push(`Mixed agreement (${agr}/100) — some timeframe conflict.`);
  else lines.push(`Low agreement (${agr}/100) — timeframes are giving conflicting signals.`);

  // Volatility
  if (vol >= 60) lines.push(`Volatility is elevated (${vol}/100) — expect larger candles and wider swings.`);
  else if (vol >= 35) lines.push(`Normal volatility (${vol}/100).`);
  else lines.push(`Low volatility (${vol}/100) — tight ranges, small candles.`);

  // Directional pressure
  const pressGap = Math.abs(bull - bear);
  const dominant = bull > bear ? 'buyers' : 'sellers';
  const dominantPct = bull > bear ? bull : bear;
  if (pressGap >= 20) {
    lines.push(`${dominant.charAt(0).toUpperCase() + dominant.slice(1)} dominate at ${dominantPct}% — strong directional bias.`);
  } else if (pressGap >= 8) {
    lines.push(`${dominant.charAt(0).toUpperCase() + dominant.slice(1)} have the edge at ${dominantPct}% vs ${100 - dominantPct}% — moderate directional lean.`);
  } else {
    lines.push(`Bulls (${bull}%) and bears (${bear}%) are evenly matched — no clear direction.`);
  }

  // Participation
  if (activePct >= 50) lines.push(`${activePct}% of pairs are actively moving — strong market participation.`);
  else if (activePct >= 25) lines.push(`${activePct}% of pairs active — moderate participation.`);
  else lines.push(`Only ${activePct}% of pairs are active — thin market.`);

  // Currency dominance
  if (strong && weak && strong !== weak && dom >= 15) {
    lines.push(`${strong} is the strongest currency and ${weak} is the weakest — ${strong}/${weak} pairs are likely trending.`);
  }

  // Overall energy verdict
  if (energy >= 60) lines.push(`Overall energy is high (${energy}) — conditions favour trend-following.`);
  else if (energy >= 35) lines.push(`Moderate energy (${energy}) — be selective, not all setups will follow through.`);
  else if (energy >= 25) lines.push(`Moderate energy (${energy}) — building conditions, wait for confirmation.`);
  else lines.push(`Low energy (${energy}) — range-bound conditions, avoid forcing trades.`);

  return `<div class="me-explain">
    <div class="me-explain-title">What this means</div>
    <ul class="me-explain-list">${lines.map(l => `<li>${l}</li>`).join('')}</ul>
  </div>`;
}

function _meSessionCard(name, s, status) {
  const sessColor  = ME_SESSION_COLOR[name];
  const label      = ME_SESSION_LABEL[name];

  // LOW_LIQUIDITY with no DB row: show structural DEAD card — no fake numbers
  if (!s && name === 'LOW_LIQUIDITY') {
    return `<div class="me-card me-card--dim">
      <div class="me-card-head">
        <span class="me-card-sess" style="color:${sessColor}">${label}</span>
        <span class="me-card-cycle" style="--bc:${ME_CYCLE_COLOR.DEAD}">Dead</span>
      </div>
      <div class="me-card-comps me-card-empty">Rollover zone · market closed</div>
    </div>`;
  }

  if (!s) {
    return `<div class="me-card me-card--dim">
      <div class="me-card-head">
        <span class="me-card-sess" style="color:${sessColor}">${label}</span>
        <span class="me-card-cycle" style="--bc:#475569">—</span>
      </div>
      <div class="me-card-comps me-card-empty">No data</div>
    </div>`;
  }

  const cycle      = s.energy_cycle || 'BALANCED';
  const cycleColor = ME_CYCLE_COLOR[cycle] || '#64748b';
  const cycleLabel = ME_CYCLE_LABEL[cycle] || cycle;

  const comps = [
    { label: 'Movement',   val: s.movement_score,   norm: s.norm_movement,   prev: s.prev_movement   },
    { label: 'Momentum',   val: s.breadth_score,    norm: s.norm_breadth,    prev: s.prev_breadth    },
    { label: 'Agreement',  val: s.agreement_score,  norm: s.norm_agreement,  prev: s.prev_agreement  },
    { label: 'Volatility', val: s.volatility_score, norm: s.norm_volatility, prev: null              },
  ];

  const compRows = comps.map(c => {
    const v = Math.round(parseFloat(c.val) || 0);
    return `<div class="me-comp-row">
      <span class="me-comp-label">${c.label}</span>
      ${_meCompBar(c.val)}
      <div class="me-comp-right">
        <span class="me-comp-val">${v}</span>
      </div>
    </div>`;
  }).join('');

  // Magnitude-weighted pressure (bullish_breadth/bearish_breadth now store pressure %)
  const bull     = Math.round(parseFloat(s.bullish_breadth) || 0);
  const bear     = Math.round(parseFloat(s.bearish_breadth) || 0);
  // Inactive = pairs not participating (derived from active_pairs count)
  const totalPairs = 28;
  const activePct  = Math.min(100, Math.round((parseFloat(s.active_pairs) || 0) / totalPairs * 100));
  const neutral    = Math.max(0, 100 - activePct);

  const domScore  = Math.round(parseFloat(s.dominance_score) || 0);
  const strongCcys = (s.strongest_ccy || '').split(',').filter(Boolean);
  const weakCcys   = (s.weakest_ccy   || '').split(',').filter(Boolean);
  const domLabel   = (strongCcys.length || weakCcys.length)
    ? strongCcys.map(c => `<span class="me-dom-strong">${c} ↑</span>`).join('') +
      weakCcys.map(c => `<span class="me-dom-weak">${c} ↓</span>`).join('')
    : '';

  const dirRows = `
    <div class="me-dir-sep"></div>
    <div class="me-dir-header">Directional Pressure</div>
    <div class="me-comp-row">
      <span class="me-comp-label me-comp-bull">Bull Press</span>
      ${_meDirBar(bull, '#22c55e')}
      <span class="me-comp-val">${bull}%</span>
    </div>
    <div class="me-comp-row">
      <span class="me-comp-label me-comp-bear">Bear Press</span>
      ${_meDirBar(bear, '#ef4444')}
      <span class="me-comp-val">${bear}%</span>
    </div>
    <div class="me-dir-sep"></div>
    <div class="me-dir-header">Participation</div>
    <div class="me-comp-row">
      <span class="me-comp-label" style="color:var(--text-muted)">Active</span>
      ${_meDirBar(activePct, '#0ea5e9')}
      <span class="me-comp-val">${activePct}%</span>
    </div>
    <div class="me-comp-row">
      <span class="me-comp-label" style="color:var(--text-dim)">Inactive</span>
      ${_meDirBar(neutral, '#1e293b')}
      <span class="me-comp-val" style="color:var(--text-dim)">${neutral}%</span>
    </div>
    <div class="me-dir-sep"></div>
    <div class="me-dom-row">
      <div class="me-dom-ccys">${domLabel}</div>
      <div class="me-comp-row me-dom-bar-row">
        <span class="me-comp-label" style="color:var(--text-dim)">Dominance</span>
        ${_meDirBar(domScore, '#a855f7')}
        <span class="me-comp-val">${domScore}%</span>
      </div>
    </div>`;

  const energy    = Math.round(parseFloat(s.market_energy) || 0);
  const readiness = Math.round(parseFloat(s.expansion_readiness) || 0);
  const liqScore  = Math.round(parseFloat(s.liquidity_score) || 0);
  const liqGrade  = s.liquidity_grade || '—';
  const liqColor  = liqScore >= 50 ? '#22c55e' : liqScore >= 30 ? '#eab308' : liqScore >= 15 ? '#f97316' : '#64748b';

  const momentum      = s.energy_momentum;
  const momColor      = ME_MOMENTUM_COLOR[momentum] || '#64748b';
  const momLabel      = ME_MOMENTUM_LABEL[momentum]  || '';
  const momentumHtml  = momentum
    ? `<span class="me-momentum" style="color:${momColor}">${momLabel}</span>`
    : '';

  const statusHtml = status === 'ACTIVE'
    ? '<span class="me-status-badge me-status-active">Live</span>'
    : status === 'COMPLETED'
    ? '<span class="me-status-badge me-status-done">Done</span>'
    : status === 'UPCOMING'
    ? '<span class="me-status-badge me-status-upcoming">Next</span>'
    : '';

  return `<div class="me-card${status === 'ACTIVE' ? ' me-card--active' : status === 'UPCOMING' ? ' me-card--upcoming' : ''}">
    <div class="me-card-head">
      <span class="me-card-sess" style="color:${sessColor}">${label}</span>
      <span class="me-card-cycle" style="--bc:${cycleColor}">${cycleLabel}</span>
      ${momentumHtml}
      ${statusHtml}
    </div>
    <div class="me-card-comps">${compRows}${dirRows}</div>
    <div class="me-card-foot">
      <div class="me-foot-energy">
        <span class="me-foot-item">Energy <strong>${energy}</strong></span>
      </div>
      <span class="me-foot-item">Readiness <strong>${readiness}</strong></span>
      <span class="me-foot-item" style="color:${liqColor}">Liquidity <strong>${liqScore}</strong></span>
    </div>
    ${_meSessionExplain(s, label)}
  </div>`;
}

function _meExpansionPressurePanel(ep) {
  const score  = ep?.score  || 0;
  if (score === 0) return '';

  const riskColor = ep?.risk === 'HIGH'     ? '#ef4444'
                  : ep?.risk === 'BUILDING' ? '#f59e0b'
                  : ep?.risk === 'LOW'      ? '#0ea5e9'
                  : '#475569';

  const streak = ep?.streak || 0;

  // Compression sequence block
  let compressionBlock;
  if (streak === 0) {
    compressionBlock = `<span class="me-press-none">No compression sequence — market is active or expanding.</span>`;
  } else {
    compressionBlock = `<span class="me-press-chain">${ep.chain.join(' → ')}</span>
       <span class="me-press-count">${streak} session${streak !== 1 ? 's' : ''}</span>
       <span class="me-press-score">Score ${score}</span>`;
  }

  // Compact energy chip chain (always shown)
  let flowChain = '';
  if (ep?.carryOver?.length > 1) {
    const chips = ep.carryOver.map(c => {
      const col = c.energy >= 60 ? '#22c55e' : c.energy >= 35 ? '#0ea5e9' : c.energy >= 15 ? '#f59e0b' : '#475569';
      return `<span class="me-flow-chip"><span class="me-flow-sess">${c.session}</span><span class="me-flow-val" style="color:${col}">${c.energy}</span></span>`;
    }).join('<span class="me-flow-arrow">→</span>');
    flowChain = `<div class="me-flow-row">${chips}</div>`;
  }

  // Rule-based flow narrative
  const narrative  = ep?.flowNarrative;
  const narrativeBlock = narrative
    ? `<p class="me-flow-narrative">${narrative}</p>`
    : '';

  return `<div class="me-pressure-panel">
    <div class="me-pressure-head">
      <span class="me-pressure-title">Expansion Pressure</span>
      <span class="me-pressure-badge" style="--bc:${riskColor}">${ep?.risk || 'NONE'}</span>
    </div>
    <div class="me-pressure-body">${compressionBlock}</div>
    ${flowChain}
    ${narrativeBlock}
  </div>`;
}

// ── Market energy AI analysis — modal state ──────────────────────────────────
let _meNarrative    = null; // latest AI response
let _meSessSnapshot = [];   // sessions at last fetch
let _meEpSnapshot   = null;
let _meMcSnapshot   = null;

async function fetchMarketEnergyNarrative(sessions, expansionPressure, marketCycle) {
  _meSessSnapshot = sessions;
  _meEpSnapshot   = expansionPressure;
  _meMcSnapshot   = marketCycle;
  try {
    const data = await api('/api/market-energy-narrative');
    _meNarrative = data;
    const modal = document.getElementById('me-analysis-modal');
    if (modal) _renderMeAnalysisModal();
  } catch (_) {}
}

function openMeAiAnalysis() {
  let modal = document.getElementById('me-analysis-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id        = 'me-analysis-modal';
    modal.className = 'me-analysis-overlay';
    modal.addEventListener('click', e => { if (e.target === modal) closeMeAiAnalysis(); });
    document.body.appendChild(modal);
  }
  _renderMeAnalysisModal();
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeMeAiAnalysis() {
  const modal = document.getElementById('me-analysis-modal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

// ─── Momentum Chart Modal ────────────────────────────────────────────────────

function openBreadthChart() {
  let modal = document.getElementById('breadth-chart-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'breadth-chart-modal';
    modal.className = 'me-analysis-overlay';
    modal.addEventListener('click', e => { if (e.target === modal) closeBreadthChart(); });
    document.body.appendChild(modal);
  }
  const _bcTz = (_userTz === 'auto') ? Intl.DateTimeFormat().resolvedOptions().timeZone : (_userTz || 'UTC');
  const _bcTzLabel = new Intl.DateTimeFormat('en-GB', { timeZone: _bcTz, timeZoneName: 'short' })
    .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
  modal.innerHTML = `<div class="me-modal-panel">
    <div class="me-modal-header">
      <div class="me-modal-title"><span class="me-modal-title-label">Hourly Session Momentum</span><span style="font-size:10px;color:var(--text-muted);margin-left:8px">${_bcTzLabel}</span><a href="/archive.html" class="premium-only" style="font-size:10px;color:var(--accent);margin-left:auto;text-decoration:none">Full Archive →</a></div>
      <button class="me-modal-close" onclick="closeBreadthChart()">✕</button>
    </div>
    <div class="me-modal-body" style="padding:16px 20px">
      <div class="me-loading"><span class="spinner"></span> Loading momentum data…</div>
    </div>
  </div>`;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  _fetchAndRenderBreadthChart(modal);
}

function closeBreadthChart() {
  const modal = document.getElementById('breadth-chart-modal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

async function _fetchAndRenderBreadthChart(modal) {
  try {
    const data = await api('/api/session-activity?type=hourly&days=9');
    const rows = data.hourly || [];
    if (!rows.length) {
      modal.querySelector('.me-modal-body').innerHTML = '<p class="me-empty">No hourly momentum data available.</p>';
      return;
    }
    _renderBreadthBars(modal.querySelector('.me-modal-body'), rows);
  } catch (e) {
    modal.querySelector('.me-modal-body').innerHTML = `<p class="me-empty">Failed to load: ${e.message}</p>`;
  }
}

function _renderBreadthBars(container, rows) {
  const SESS_COLOR = { ASIA: '#f59e0b', LONDON: '#0ea5e9', NEW_YORK: '#a855f7', LOW_LIQUIDITY: '#475569' };
  const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York', LOW_LIQUIDITY: 'Low Liq.' };
  const tz = (_userTz === 'auto') ? Intl.DateTimeFormat().resolvedOptions().timeZone : (_userTz || 'UTC');
  const tzLabel = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';

  const SKIP_SESSIONS = new Set(['LOW_LIQUIDITY', 'DEAD_HOURS']);

  // Group all rows by date (single timeline per day), skip off-hours sessions
  const byDate = {};
  for (const r of rows) {
    if (SKIP_SESSIONS.has(r.session_name)) continue;
    const date = r.time_utc.slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push({
      time: r.time_utc,
      session: r.session_name,
      breadth: Math.round(parseFloat(r.breadth_score) || 0),
    });
  }

  // Sort dates descending; show today + last 5 working days (6 total)
  const todayStr = new Date().toISOString().slice(0, 10);
  const dates = Object.keys(byDate)
    .filter(d => {
      if (d === todayStr) return byDate[d].length >= 1;
      const sessions = new Set(byDate[d].map(b => b.session));
      return sessions.size >= 2;
    })
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 6);
  const maxBreadth = Math.max(80, ...rows.map(r => parseFloat(r.breadth_score) || 0));

  let html = '<div class="bc-chart-wrap">';

  for (const date of dates) {
    const bars = byDate[date].sort((a, b) => a.time.localeCompare(b.time));
    const d = new Date(date + 'T12:00:00Z');
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });

    // Detect 3+ consecutive hourly increases or holds (both values ≥10)
    const breadths = bars.map(b => b.breadth);
    const streaks = new Set();
    let streak = 0;
    for (let i = 1; i < breadths.length; i++) {
      if (breadths[i] >= breadths[i - 1] && breadths[i] >= 10 && breadths[i - 1] >= 10) {
        streak++;
        if (streak >= 2) {
          for (let j = i - streak; j <= i; j++) streaks.add(j);
        }
      } else {
        streak = 0;
      }
    }

    // Build session groups to count spans for label row
    const sessGroups = [];
    let curGroup = null;
    for (const b of bars) {
      if (!curGroup || curGroup.session !== b.session) {
        curGroup = { session: b.session, count: 0 };
        sessGroups.push(curGroup);
      }
      curGroup.count++;
    }
    // Dividers between groups add 1 unit each (except before first)
    const totalCols = bars.length + Math.max(0, sessGroups.length - 1);

    // Session label row
    let labelRow = '<div class="bc-label-row">';
    sessGroups.forEach((g, gi) => {
      if (gi > 0) labelRow += '<div class="bc-label-spacer"></div>';
      const color = SESS_COLOR[g.session] || '#64748b';
      labelRow += `<div class="bc-label-span" style="flex:${g.count};color:${color}">${SESS_LABEL[g.session] || g.session}</div>`;
    });
    labelRow += '</div>';

    html += `<div class="bc-day-block">
      <div class="bc-date-header">${dayLabel}</div>
      ${labelRow}
      <div class="bc-unified-chart">`;

    let prevSess = '';
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const color = SESS_COLOR[b.session] || '#64748b';
      const pct = Math.round((b.breadth / maxBreadth) * 100);
      const localTime = new Date(b.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
      const localHour = localTime.slice(0, 2);
      const highlighted = streaks.has(i);
      const barColor = highlighted ? '#22c55e' : color;
      const cls = highlighted ? 'bc-bar bc-bar-streak' : 'bc-bar';

      if (b.session !== prevSess && prevSess !== '') {
        html += '<div class="bc-sess-divider"></div>';
      }
      prevSess = b.session;

      html += `<div class="${cls}" title="${SESS_LABEL[b.session] || b.session}: ${b.breadth}% at ${localTime} ${tzLabel}">
        <span class="bc-bar-val">${b.breadth}</span>
        <div class="bc-bar-inner">
          <div class="bc-bar-fill" style="height:${pct}%;background:${barColor}"></div>
        </div>
        <span class="bc-bar-hour">${localHour}</span>
      </div>`;
    }

    html += `</div>`;

    // Per-day explanation — only for today
    if (date === todayStr) {
      const dayMax = Math.max(...breadths);
      const dayAvg = Math.round(breadths.reduce((a, b) => a + b, 0) / breadths.length);
      const streakCount = streaks.size;
      const peakHour = bars[breadths.indexOf(dayMax)];
      const peakTime = new Date(peakHour.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
      const peakSess = SESS_LABEL[peakHour.session] || peakHour.session;

      const dayLines = [];
      if (dayAvg >= 40) dayLines.push(`Strong overall participation (avg ${dayAvg}) — broad market activity throughout the day.`);
      else if (dayAvg >= 20) dayLines.push(`Moderate participation (avg ${dayAvg}) — some sessions were active, others quiet.`);
      else dayLines.push(`Low participation (avg ${dayAvg}) — most of the day was quiet with low momentum.`);

      dayLines.push(`Peak momentum of ${dayMax} hit at ${peakTime} during ${peakSess} — this was when momentum peaked.`);

      if (streakCount >= 3) dayLines.push(`Continuation signal detected (${streakCount} bars in streak) — sustained momentum buildup during this day.`);
      else dayLines.push('No continuation signal — momentum did not sustain 3+ consecutive increases above 10.');

      for (const g of sessGroups) {
        const sBars = bars.filter(b => b.session === g.session);
        const sAvg = Math.round(sBars.reduce((a, b) => a + b.breadth, 0) / sBars.length);
        const sMax = Math.max(...sBars.map(b => b.breadth));
        const sLabel = SESS_LABEL[g.session] || g.session;
        if (sAvg >= 35) dayLines.push(`${sLabel}: active session (avg ${sAvg}, peak ${sMax}) — good trading conditions.`);
        else if (sAvg >= 15) dayLines.push(`${sLabel}: moderate activity (avg ${sAvg}, peak ${sMax}) — selective opportunities.`);
        else dayLines.push(`${sLabel}: quiet session (avg ${sAvg}, peak ${sMax}) — limited opportunities.`);
      }

      html += `<div class="bc-day-explain">
        <ul class="bc-explain-list">${dayLines.map(l => `<li>${l}</li>`).join('')}</ul>
      </div>`;
    }

    html += `</div>`;
  }

  html += '</div>';

  // Guide box
  html += `<div class="bc-guide">
    <div class="bc-guide-title">How to read this chart</div>
    <ul class="bc-guide-list">
      <li><strong>Momentum</strong> measures the strength and participation of market movement during each hour. Higher = stronger directional conviction.</li>
      <li><strong>Rising bars</strong> mean momentum is building — the market is gaining strength and trends are more likely to continue.</li>
      <li><strong>Falling bars</strong> mean momentum is fading — reversals or ranging conditions may follow.</li>
      <li><strong>Green bars</strong> highlight 3+ consecutive hourly increases (both ≥10) — a continuation signal suggesting the move has broad support and is likely to persist.</li>
      <li><strong>Low momentum</strong> (under 15) means weak market activity — avoid trading as moves lack conviction.</li>
      <li><strong>High momentum</strong> (above 50) with agreement means strong trending conditions — ideal for trend-following entries.</li>
    </ul>
  </div>`;

  html += `<div class="bc-legend">
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#f59e0b"></span> Asia</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#0ea5e9"></span> London</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#a855f7"></span> New York</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#22c55e"></span> 3+ rises = continuation</span>
  </div>`;

  container.innerHTML = html;
}

function _renderMeAnalysisModal() {
  const modal = document.getElementById('me-analysis-modal');
  if (!modal) return;

  const d        = _meNarrative;
  const sessions = _meSessSnapshot;
  const ep       = _meEpSnapshot;
  const mc       = _meMcSnapshot;

  const SESS_COLOR = { ASIA: '#f59e0b', LONDON: '#0ea5e9', NEW_YORK: '#a855f7' };
  const SESS_LABEL = { ASIA: 'Asia',    LONDON: 'London',  NEW_YORK: 'New York' };
  const BIAS_COLOR = { BULLISH: '#22c55e', BEARISH: '#ef4444', NEUTRAL: '#64748b', MIXED: '#f59e0b' };
  const byName     = Object.fromEntries(sessions.map(s => [s.session_name, s]));

  function pct(v) {
    if (v == null) return '';
    return `<em class="me-modal-pct" style="color:${v>=10?'#22c55e':v>=-10?'#f59e0b':'#94a3b8'}">${v>=0?'+':''}${v}%</em>`;
  }

  function biasBadge(bias) {
    if (!bias) return '';
    const color = BIAS_COLOR[bias] || '#64748b';
    return `<span class="me-di-bias" style="--bc:${color}">${bias}</span>`;
  }


  const loading = '<span class="me-ai-loading">Analyzing…</span>';

  // ── Cycle section ────────────────────────────────────────────────────────────
  const cycleHtml = d
    ? `<div class="me-di-cycle-row">
        ${biasBadge(d.cycle?.bias)}
        <span class="me-di-cycle-condition">${d.cycle?.condition || '—'}</span>
      </div>
      ${d.cycle?.narrative ? `<p class="me-di-narrative">${d.cycle.narrative}</p>` : ''}
      <div class="me-di-trigger-row">
        <span class="me-di-row-label">Trigger</span>
        <span class="me-di-trigger-text">${d.cycle?.trigger || '—'}</span>
      </div>`
    : loading;

  // ── Session cards ─────────────────────────────────────────────────────────────
  const sessCards = ['ASIA', 'LONDON', 'NEW_YORK'].map(key => {
    const s     = byName[key] || {};
    const ai    = d?.sessions?.[key] || null;
    const color = SESS_COLOR[key];
    const cycle = s.energy_cycle || '';
    const mom   = s.energy_momentum;

    const metrics = `
      <div class="me-modal-metrics">
        <div class="me-modal-metric"><span>Mov</span><strong>${Math.round(s.movement_score||0)}</strong>${pct(s.norm_movement)}</div>
        <div class="me-modal-metric"><span>Mom</span><strong>${Math.round(s.breadth_score||0)}</strong>${pct(s.norm_breadth)}</div>
        <div class="me-modal-metric"><span>Agr</span><strong>${Math.round(s.agreement_score||0)}</strong>${pct(s.norm_agreement)}</div>
        <div class="me-modal-metric"><span>Vol</span><strong>${Math.round(s.volatility_score||0)}</strong>${pct(s.norm_volatility)}</div>
        <div class="me-modal-metric"><span>Energy</span><strong>${Math.round(s.market_energy||0)}</strong>${pct(s.norm_energy)}</div>
        <div class="me-modal-metric"><span>Dom%</span><strong>${Math.round(s.dominance_score||0)}</strong></div>
      </div>`;

    const momHtml = mom
      ? `<span class="me-modal-momentum" style="color:${ME_MOMENTUM_COLOR[mom]||'#64748b'}">${ME_MOMENTUM_LABEL[mom]||''}</span>`
      : '';

    const sessAiHtml = ai
      ? `<div class="me-di-sess-ai">
          <div class="me-di-ai-row">
            <span class="me-di-row-label">Flow</span>
            <span class="me-di-flow-text">${ai.flow || '—'}</span>
          </div>
          ${ai.analysis ? `<p class="me-di-sess-analysis">${ai.analysis}</p>` : ''}
          <div class="me-di-ai-row me-di-signal-row">
            <span class="me-di-row-label">Signal</span>
            <span class="me-di-signal-text">${ai.signal || '—'}</span>
          </div>
          <div class="me-di-ai-row me-di-watch-row">
            <span class="me-di-row-label">Watch</span>
            <span class="me-di-watch-text">${ai.watch || '—'}</span>
          </div>
        </div>`
      : `<div class="me-di-sess-ai">${loading}</div>`;

    return `<div class="me-modal-sess-card">
      <div class="me-modal-sess-head">
        <span class="me-modal-sess-name" style="color:${color}">${SESS_LABEL[key]}</span>
        <span class="me-modal-cycle-badge" style="--bc:${ME_CYCLE_COLOR[cycle]||'#64748b'}">${ME_CYCLE_LABEL[cycle]||cycle}</span>
        ${momHtml}
      </div>
      ${metrics}
      ${sessAiHtml}
    </div>`;
  }).join('');

  // ── Currency leadership ───────────────────────────────────────────────────────
  const currencyHtml = d?.currencies
    ? `<div class="me-di-ccy-grid">
        <div class="me-di-ccy-card me-di-ccy-leader">
          <span class="me-di-ccy-label">Leader</span>
          <p class="me-di-ccy-text">${d.currencies.leader || '—'}</p>
        </div>
        <div class="me-di-ccy-card me-di-ccy-laggard">
          <span class="me-di-ccy-label">Laggard</span>
          <p class="me-di-ccy-text">${d.currencies.laggard || '—'}</p>
        </div>
        <div class="me-di-ccy-card me-di-ccy-theme">
          <span class="me-di-ccy-label">Theme</span>
          <p class="me-di-ccy-text">${d.currencies.theme || '—'}</p>
        </div>
      </div>`
    : loading;

  // ── Previous Sessions ──────────────────────────────────────────────────────────
  const PREV_SESS_COLOR = { ASIA: '#f59e0b', LONDON: '#0ea5e9', NEW_YORK: '#a855f7' };
  const PREV_SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
  const prevSessHtml = d?.previous_sessions?.length
    ? `<div class="me-di-prev-list">${d.previous_sessions.map(ps => {
        const color = PREV_SESS_COLOR[ps.session] || '#64748b';
        const label = PREV_SESS_LABEL[ps.session] || ps.session;
        return `<div class="me-di-prev-card">
          <div class="me-di-prev-head">
            <span class="me-di-prev-sess" style="color:${color}">${label}</span>
            <span class="me-di-prev-date">${ps.date || ''}</span>
          </div>
          <p class="me-di-prev-summary">${ps.summary || '—'}</p>
          <div class="me-di-ai-row"><span class="me-di-row-label">Impact</span><span class="me-di-prev-impact">${ps.impact || '—'}</span></div>
        </div>`;
      }).join('')}</div>`
    : '<p class="me-di-no-prev">No previous session data available.</p>';

  // ── Summary ───────────────────────────────────────────────────────────────────
  const summaryHtml = d?.summary
    ? `<div class="me-di-summary-head">
        ${biasBadge(d.summary.bias)}
        <span class="me-di-summary-label">Overall Bias</span>
      </div>
      ${d.summary.playbook ? `<p class="me-di-playbook">${d.summary.playbook}</p>` : ''}
      <div class="me-di-summary-rows">
        <div class="me-di-sum-row">
          <span class="me-di-row-label">Priority</span>
          <span class="me-di-sum-text me-di-priority-text">${d.summary.priority || '—'}</span>
        </div>
        <div class="me-di-sum-row">
          <span class="me-di-row-label">Risk</span>
          <span class="me-di-sum-text me-di-risk-text">${d.summary.risk || '—'}</span>
        </div>
        <div class="me-di-sum-row">
          <span class="me-di-row-label">Opportunity</span>
          <span class="me-di-sum-text me-di-opp-text">${d.summary.opportunity || '—'}</span>
        </div>
      </div>`
    : loading;

  const mcColor = ME_MARKET_CYCLE_COLOR[mc] || '#64748b';
  const mcLabel = ME_MARKET_CYCLE_LABEL[mc] || (mc||'—').replace(/_/g,' ');

  modal.innerHTML = `
    <div class="me-modal-panel" role="dialog" aria-modal="true">
      <div class="me-modal-header">
        <div class="me-modal-title">
          <span class="me-modal-title-label">Decision Intelligence</span>
          <span class="me-modal-cycle-pill" style="--bc:${mcColor}">${mcLabel}</span>
        </div>
        <button class="me-modal-close" onclick="closeMeAiAnalysis()" aria-label="Close">✕</button>
      </div>

      <div class="me-modal-body">
        <h3 class="me-di-group-heading">Live Analysis</h3>

        <section class="me-modal-section">
          <h3 class="me-modal-section-title">Market Cycle</h3>
          ${cycleHtml}
        </section>

        <section class="me-modal-section">
          <h3 class="me-modal-section-title">Session Conditions</h3>
          <div class="me-modal-sess-grid">${sessCards}</div>
        </section>

        <section class="me-modal-section">
          <h3 class="me-modal-section-title">Currency Leadership</h3>
          ${currencyHtml}
        </section>

        <section class="me-modal-section">
          <h3 class="me-modal-section-title">Summary & Playbook</h3>
          ${summaryHtml}
        </section>

        <h3 class="me-di-group-heading">Previous Session Analysis</h3>

        <section class="me-modal-section">
          ${prevSessHtml}
        </section>
      </div>
    </div>`;
}

function _meMarketCycleBanner(cycle) {
  const color = cycle ? (ME_MARKET_CYCLE_COLOR[cycle] || '#64748b') : '#64748b';
  const label = cycle ? (ME_MARKET_CYCLE_LABEL[cycle]  || cycle.replace(/_/g, ' ')) : '—';
  return `<div class="me-cycle-banner">
    <span class="me-cycle-banner-label">Market Cycle</span>
    <span class="me-cycle-banner-val" style="--bc:${color}">${label}</span>
    <button class="me-ai-toggle me-btn-breadth premium-only" onclick="openBreadthChart()">Momentum Chart</button>
    <button class="me-ai-toggle me-btn-ai premium-only" onclick="openMeAiAnalysis()">AI Analysis</button>
  </div>`;
}

// Session order for status calculation (trading sessions only, chronological)
const ME_SESSION_ORDER = ['ASIA', 'LONDON', 'NEW_YORK'];

function _meSessionStatus(sessionName, currentSession) {
  if (sessionName === 'LOW_LIQUIDITY') return null;
  if (sessionName === currentSession)  return 'ACTIVE';
  const curIdx  = ME_SESSION_ORDER.indexOf(currentSession);
  const sessIdx = ME_SESSION_ORDER.indexOf(sessionName);
  if (curIdx === -1) return 'COMPLETED'; // weekend / low liq active
  return sessIdx < curIdx ? 'COMPLETED' : 'UPCOMING';
}

function _meHistoryPanel(rows, liveSessions) {
  const now     = new Date();
  const utcDay  = now.getUTCDay();
  const utcHour = now.getUTCHours();

  const marketOpen = !(
    utcDay === 6 ||
    (utcDay === 0 && utcHour < 21) ||
    (utcDay === 5 && utcHour >= 21)
  );

  // Merge live today sessions with DB history; live rows override DB for same date+session
  const liveRows = (liveSessions || []).filter(s => s.session_name !== 'LOW_LIQUIDITY' && s.session_date);
  const liveKeys = new Set(liveRows.map(r => `${(r.session_date || '').slice(0, 10)}_${r.session_name}`));
  const dbRows   = (rows || []).filter(r => !liveKeys.has(`${(r.session_date || '').slice(0, 10)}_${r.session_name}`));
  const allRows  = [...liveRows, ...dbRows];

  if (!allRows.length) return '';

  const CYCLE_DOT = {
    EXPLOSIVE:       '#f59e0b', EXPANSION:       '#22c55e', TRANSITION:      '#0ea5e9',
    COMPRESSION:     '#ef4444', EXHAUSTION:      '#f97316', LOW_PARTICIPATION:'#64748b', DEAD: '#334155',
  };
  const SESS_COLOR = { ASIA: '#f59e0b', LONDON: '#0ea5e9', NEW_YORK: '#a855f7' };
  const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };

  const byDate = {};
  for (const r of allRows) {
    const key = (r.session_date || '').slice(0, 10);
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(r);
  }

  const days = Object.keys(byDate).sort().reverse();
  const lastMarketDate = days[0];

  // Table header
  let tableHead = `<div class="sh-row sh-header">
    <div class="sh-col-date">Date</div>
    <div class="sh-col-sess">Session</div>
    <div class="sh-col-cycle">Cycle</div>
    <div class="sh-col-metric">E</div>
    <div class="sh-col-metric">Mom</div>
    <div class="sh-col-metric">Liq</div>
    <div class="sh-col-flow">Flow</div>
    <div class="sh-col-ccy">Currencies</div>
  </div>`;

  const dayBlocks = days.map(date => {
    const dateLabel = (date === lastMarketDate && marketOpen)
      ? 'Today'
      : new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

    const sessOrder = ['ASIA', 'LONDON', 'NEW_YORK'];
    const sessMap   = Object.fromEntries(byDate[date].map(r => [r.session_name, r]));

    const sessRows = sessOrder.map((key, idx) => {
      const r = sessMap[key];
      const dateCell = idx === 0
        ? `<div class="sh-col-date sh-date-label">${dateLabel}</div>`
        : '<div class="sh-col-date"></div>';

      if (!r) {
        return `<div class="sh-row sh-data-row sh-empty">
          ${dateCell}
          <div class="sh-col-sess" style="color:${SESS_COLOR[key]}">${SESS_LABEL[key]}</div>
          <div class="sh-col-cycle"><span class="sh-na">—</span></div>
          <div class="sh-col-metric sh-na">—</div>
          <div class="sh-col-metric sh-na">—</div>
          <div class="sh-col-metric sh-na">—</div>
          <div class="sh-col-flow sh-na">—</div>
          <div class="sh-col-ccy sh-na">—</div>
        </div>`;
      }

      const dot   = CYCLE_DOT[r.energy_cycle] || '#64748b';
      const cycle = (ME_CYCLE_LABEL[r.energy_cycle] || r.energy_cycle || '—').replace(/_/g,' ');
      const eng   = Math.round(r.market_energy || 0);
      const brd   = Math.round(r.breadth_score || 0);
      const liq   = Math.round(r.liquidity_score || 0);
      const liqColor = liq >= 50 ? '#22c55e' : liq >= 30 ? '#eab308' : liq >= 15 ? '#f97316' : '#64748b';
      const bullPct = Math.round(r.bullish_breadth || 0);
      const bearPct = Math.round(r.bearish_breadth || 0);

      return `<div class="sh-row sh-data-row">
        ${dateCell}
        <div class="sh-col-sess" style="color:${SESS_COLOR[key]}">${SESS_LABEL[key]}</div>
        <div class="sh-col-cycle"><span class="sh-dot" style="background:${dot}"></span>${cycle}</div>
        <div class="sh-col-metric">${eng}</div>
        <div class="sh-col-metric">${brd}</div>
        <div class="sh-col-metric" style="color:${liqColor};font-weight:600">${liq}</div>
        <div class="sh-col-flow"><span class="sh-bull">▲${bullPct}%</span><span class="sh-bear">▼${bearPct}%</span></div>
        <div class="sh-col-ccy">${(r.strongest_ccy||'—').split(',').map(c => `<span class="sh-strong">${c} ↑</span>`).join('')}${(r.weakest_ccy||'—').split(',').map(c => `<span class="sh-weak">${c} ↓</span>`).join('')}</div>
      </div>`;
    }).join('');

    return `<div class="sh-day-group">${sessRows}</div>`;
  }).join('');

  return `<div class="sh-panel sh-collapsed">
    <div class="sh-controls">
      <button class="sh-toggle-btn" onclick="var p=this.closest('.sh-panel');p.classList.toggle('sh-collapsed');this.textContent=p.classList.contains('sh-collapsed')?'Show Session History':'Hide Session History'">Show Session History</button>
      <a href="/archive.html" class="sh-archive-link premium-only">View Full Archive →</a>
    </div>
    <div class="sh-table">
      ${tableHead}
      ${dayBlocks}
    </div>
  </div>`;
}

function renderMarketEnergy(sessions, expansionPressure, marketCycle, currentSession, historyRows) {
  const el = document.getElementById('market-activity-display');
  if (!el) return;

  if (!sessions || !sessions.length) {
    el.innerHTML = '<p class="me-empty">No energy data — run pipeline to populate.</p>';
    return;
  }

  // Live cards: only show today's sessions, blank if not yet active
  const todayStr = new Date().toISOString().slice(0, 10);
  const todaySessions = sessions.filter(s => (s.session_date || '').slice(0, 10) === todayStr);
  const byName = Object.fromEntries(todaySessions.map(s => [s.session_name, s]));

  const ORDER  = ['ASIA', 'LONDON', 'NEW_YORK', 'LOW_LIQUIDITY'];

  el.innerHTML = `
    ${_meMarketCycleBanner(marketCycle)}
    <div class="me-card-grid">
      ${ORDER.map(name => _meSessionCard(name, byName[name] || null, _meSessionStatus(name, currentSession))).join('')}
    </div>
    ${_meExpansionPressurePanel(expansionPressure)}
    ${_meHistoryPanel(historyRows, todaySessions)}`;

  fetchMarketEnergyNarrative(sessions, expansionPressure, marketCycle);
}

async function fetchMarketActivity() {
  try {
    const [data, historyRows] = await Promise.all([
      api('/api/market-energy'),
      api('/api/market-energy-history').catch(e => { console.warn('[ME-HISTORY]', e.message); return []; }),
    ]);
    console.log('[ME-HISTORY] rows:', historyRows?.length, historyRows?.[0]);
    renderMarketEnergy(
      data.sessions       || [],
      data.expansionPressure || null,
      data.marketCycle    || null,
      data.currentSession || null,
      historyRows,
    );
  } catch (_) {
    const el = document.getElementById('market-activity-display');
    if (el) el.innerHTML = '<p class="me-empty">Market Energy unavailable.</p>';
  }
}



// ─── Momentum Continuation Signal ────────────────────────────────────────────
// Detects 3+ consecutive hourly increases (both ≥10) in today's session data.

let _momentumSignal = null; // { session, streak, peakVal }

async function fetchMomentumSignal() {
  try {
    const data = await api('/api/session-activity?type=hourly&days=1');
    const rows = data.hourly || [];
    if (!rows.length) { _momentumSignal = null; updateMomentumBar(); return; }

    const SKIP = new Set(['LOW_LIQUIDITY', 'DEAD_HOURS']);
    const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York' };
    const valid = rows.filter(r => !SKIP.has(r.session_name))
      .sort((a, b) => a.time_utc.localeCompare(b.time_utc));

    // Check for 3+ consecutive increases (both ≥10) across today's bars
    const breadths = valid.map(r => Math.round(parseFloat(r.breadth_score) || 0));
    let bestStreak = 0, bestEnd = -1, streak = 0;
    for (let i = 1; i < breadths.length; i++) {
      if (breadths[i] > breadths[i - 1] && breadths[i] >= 10 && breadths[i - 1] >= 10) {
        streak++;
        if (streak >= 2 && streak > bestStreak) {
          bestStreak = streak;
          bestEnd = i;
        }
      } else {
        streak = 0;
      }
    }

    if (bestStreak >= 2 && bestEnd >= 0) {
      const peakRow = valid[bestEnd];
      _momentumSignal = {
        session: SESS_LABEL[peakRow.session_name] || peakRow.session_name,
        streak: bestStreak + 1,
        peakVal: breadths[bestEnd],
      };
    } else {
      _momentumSignal = null;
    }
    updateMomentumBar();
  } catch (_) {
    _momentumSignal = null;
    updateMomentumBar();
  }
}

function updateMomentumBar() {
  const bar = document.getElementById('momentum-signal-bar');
  if (!bar) return;

  if (document.body.classList.contains('plan-free')) {
    bar.style.display = 'none';
    return;
  }

  if (!_momentumSignal) {
    bar.style.display = 'none';
    return;
  }

  const text = document.getElementById('mom-bar-text');
  if (text) text.textContent = `${_momentumSignal.streak} consecutive rises in ${_momentumSignal.session} — continuation likely`;
  bar.style.display = 'flex';
}

function _renderJrnMomentumSignal() {
  if (!_momentumSignal) return '';
  return _jrnSection('🚀 Momentum Continuation', `
    <p style="margin:0;line-height:1.5"><strong>${_momentumSignal.streak} consecutive rises in ${_momentumSignal.session}</strong> — broad participation supports continuation. Peak value: ${_momentumSignal.peakVal}.</p>
    <p style="margin:6px 0 0;opacity:.75;font-size:.85em">Sustained momentum buildup suggests the trend has structural support and is likely to persist.</p>
  `);
}

// ─── Risk Sentiment ───────────────────────────────────────────────────────────

// ─── Data quality ─────────────────────────────────────────────────────────────

function renderQuality(q) {
  const el = document.getElementById('quality-info');
  if (!q?.status) { el.innerHTML = '<p class="empty-state">No quality data</p>'; return; }
  const cls = q.status === 'CLEAN' ? 'ok' : 'bad';
  el.innerHTML = `
    <div class="quality-row"><span class="quality-label">Status</span><span class="quality-val ${cls}">${q.status}</span></div>
    <div class="quality-row"><span class="quality-label">Expected</span><span class="quality-val">${q.expected_candles}</span></div>
    <div class="quality-row"><span class="quality-label">Found</span><span class="quality-val">${q.found_candles}</span></div>
    <div class="quality-row"><span class="quality-label">Missing</span><span class="quality-val ${q.missing_candles > 0 ? 'bad' : 'ok'}">${q.missing_candles}</span></div>
    <div class="quality-row"><span class="quality-label">Checked</span><span class="quality-val" style="font-size:10px">${fmtTime(q.check_time)}</span></div>`;
}

// ─── Journal Modal ────────────────────────────────────────────────────────────

let _journalEntries = {}; // id → entry, populated in renderJournal

function renderJrnStrengthSection(cs) {
  // Handle old (plain array) and new ({ as_of, currencies }) formats
  const currencies = Array.isArray(cs) ? cs : (cs?.currencies || null);
  const asOf       = Array.isArray(cs) ? null : (cs?.as_of || null);
  const asOfLabel  = asOf ? `<span class="jrn-as-of">as of ${fmtTime(asOf)}</span>` : '';
  const header     = `💹 Currency Strength ${asOfLabel}`;
  if (!cs || !currencies?.length)
    return `<div class="jrn-cs-section"><div class="jrn-cs-header">${header}</div><p class="jrn-cs-nodata">No strength data for this entry.</p></div>`;

  // Helper: pick the first non-zero value from a list of keys on a currency row
  function pickVal(c, keys) {
    for (const k of keys) { const v = parseFloat(c[k]); if (!isNaN(v) && v !== 0) return v; }
    for (const k of keys) { const v = parseFloat(c[k]); if (!isNaN(v)) return v; }
    return 0;
  }

  const tfs = [
    { label: '3H',  keys: ['smooth_3h',  'normalized_3h']  },
    { label: '6H',  keys: ['smooth_6h',  'normalized_6h']  },
    { label: '12H', keys: ['smooth_12h', 'normalized_12h'] },
  ];

  // Build combined (equal-weight average of 3H + 6H + 12H)
  const combinedVals = currencies.map(c => ({
    cur: c.currency,
    val: tfs.reduce((sum, tf) => sum + pickVal(c, tf.keys), 0) / tfs.length,
  })).sort((a, b) => b.val - a.val);
  const combinedMax = Math.max(...combinedVals.map(v => Math.abs(v.val)), 0.0001);

  const comboBlock = `
    <div class="jrn-cs-tf-block combined">
      <div class="jrn-cs-tf-label">Combined ∑</div>
      ${combinedVals.map(v => {
        const pct = Math.round((Math.abs(v.val) / combinedMax) * 100);
        const cls = v.val >= 0 ? 'combo-pos' : 'combo-neg';
        return `
          <div class="jrn-cs-row">
            <span class="jrn-cs-cur">${v.cur}</span>
            <div class="jrn-cs-bar-wrap"><div class="jrn-cs-bar ${cls}" style="width:${pct}%"></div></div>
            <span class="jrn-cs-num ${cls}">${v.val >= 0 ? '+' : ''}${v.val.toFixed(5)}</span>
          </div>`;
      }).join('')}
    </div>`;

  const tfBlocks = tfs.map(tf => {
    const vals = currencies.map(c => ({ cur: c.currency, val: pickVal(c, tf.keys) }))
      .sort((a, b) => b.val - a.val);
    const maxAbs = Math.max(...vals.map(v => Math.abs(v.val)), 0.0001);
    return `
      <div class="jrn-cs-tf-block">
        <div class="jrn-cs-tf-label">${tf.label} Strength</div>
        ${vals.map(v => {
          const pct = Math.round((Math.abs(v.val) / maxAbs) * 100);
          const cls = v.val >= 0 ? 'pos' : 'neg';
          return `
            <div class="jrn-cs-row">
              <span class="jrn-cs-cur">${v.cur}</span>
              <div class="jrn-cs-bar-wrap"><div class="jrn-cs-bar ${cls}" style="width:${pct}%"></div></div>
              <span class="jrn-cs-num ${cls}">${v.val >= 0 ? '+' : ''}${v.val.toFixed(5)}</span>
            </div>`;
        }).join('')}
      </div>`;
  }).join('');

  return `
    <div class="jrn-cs-section">
      <div class="jrn-cs-header">${header}</div>
      <div class="jrn-cs-grid">
        ${comboBlock}${tfBlocks}
      </div>
    </div>`;
}

// ─── Journal modal helpers ────────────────────────────────────────────────────

function _jrnSection(title, content) {
  return `<div class="jrn-section"><div class="jrn-section-title">${title}</div>${content}</div>`;
}

function renderJrnCalendarSection(events, entryTime) {
  const ts = new Date(entryTime).getTime();
  const nearby = (events || []).filter(ev => Math.abs(new Date(ev.event_time).getTime() - ts) <= 3 * 60 * 60 * 1000);
  if (!nearby.length) return _jrnSection('📅 Economic Calendar', '<p class="jrn-empty">No events in this window.</p>');
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const sorted = [...nearby].sort((a, b) =>
    (order[a.impact] ?? 2) - (order[b.impact] ?? 2) || a.event_time.localeCompare(b.event_time)
  );
  return _jrnSection('📅 Economic Calendar', `
    <div class="jrn-cal-list">
      ${sorted.map(ev => {
        const imp = (ev.impact || 'LOW').toUpperCase();
        const act = ev.actual   != null ? `<span class="jrn-cal-actual">${ev.actual}</span>` : '';
        const fct = ev.forecast != null ? `<span class="jrn-cal-fct">Est ${ev.forecast}</span>` : '';
        const prv = ev.previous != null ? `<span class="jrn-cal-prv">Prev ${ev.previous}</span>` : '';
        return `
          <div class="jrn-cal-row">
            <span class="jrn-cal-impact imp-${imp.toLowerCase()}">${imp}</span>
            <span class="jrn-cal-time">${fmtCalTime(ev.event_time)}</span>
            <span class="jrn-cal-cur">${ev.currency}</span>
            <span class="jrn-cal-name">${ev.event_name}</span>
            <span class="jrn-cal-vals">${act}${fct}${prv}</span>
          </div>`;
      }).join('')}
    </div>`);
}

function renderJrnSessionPerfSection(e, sessionEntries) {
  if (!sessionEntries || sessionEntries.length <= 1) {
    return _jrnSection(`📊 Session: ${sessionLabel(e.session_name)}`, '<p class="jrn-empty">First snapshot of this session.</p>');
  }

  const allSignals = sessionEntries.flatMap(x => (x.signals_summary?.entered || []));

  // Use market energy from the stored summary if available
  const me = _jrnCachedEnergy?.sessions?.find(s => s.session_name === e.session_name);
  if (me) {
    const cycle = (me.energy_cycle || '').replace(/_/g, ' ');
    const eng   = Math.round(me.market_energy || 0);
    const brd   = Math.round(me.breadth_score || 0);
    const liq   = Math.round(me.liquidity_score || 0);
    const bull  = Math.round(me.bullish_breadth || 0);
    const bear  = Math.round(me.bearish_breadth || 0);
    const liqColor = liq >= 40 ? '#22c55e' : liq >= 25 ? '#eab308' : liq >= 12 ? '#f97316' : '#64748b';
    const cycleColor = cycle.includes('EXPAN') || cycle.includes('EXPLOSIVE') ? '#22c55e'
                     : cycle.includes('TRANS') ? '#0ea5e9'
                     : cycle.includes('COMP') || cycle.includes('DEAD') ? '#f59e0b' : '#64748b';

    return _jrnSection(`📊 ${sessionLabel(e.session_name)} · ${cycle}`, `
      <div class="jrn-sess-stats">
        <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Energy</span><span class="jrn-sess-val" style="color:${cycleColor}">${eng}</span></div>
        <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Momentum</span><span class="jrn-sess-val">${brd}</span></div>
        <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Liquidity</span><span class="jrn-sess-val" style="color:${liqColor}">${liq}</span></div>
        <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Pressure</span><span class="jrn-sess-val">▲${bull}% ▼${bear}%</span></div>
        <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Flow</span><span class="jrn-sess-val">${(me.strongest_ccy||'—').split(',').map(c => `<span style="color:#22c55e">${c}↑</span>`).join(' ')} ${(me.weakest_ccy||'—').split(',').map(c => `<span style="color:#ef4444">${c}↓</span>`).join(' ')}</span></div>
        ${allSignals.length ? `<div class="jrn-sess-stat jrn-sess-full"><span class="jrn-sess-lbl">Signals</span><span class="jrn-sess-val">${allSignals.map(s => `${pair(s.instrument)} ${s.signal}`).join(', ')}</span></div>` : ''}
      </div>`);
  }

  // Fallback if no market energy data
  const first = sessionEntries[0];
  return _jrnSection(`📊 ${sessionLabel(e.session_name)} · ${sessionEntries.length}H`, `
    <div class="jrn-sess-stats">
      <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Duration</span><span class="jrn-sess-val">${sessionEntries.length}H</span></div>
      ${allSignals.length ? `<div class="jrn-sess-stat jrn-sess-full"><span class="jrn-sess-lbl">Signals</span><span class="jrn-sess-val">${allSignals.map(s => `${pair(s.instrument)} ${s.signal}`).join(', ')}</span></div>` : ''}
    </div>`);
}

function renderJrnPrevSessionSection(prevEntry) {
  if (!prevEntry) return _jrnSection('📋 Previous Journal', '<p class="jrn-empty">No previous entry in loaded history.</p>');
  const sessCls = (prevEntry.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
  const entered = (prevEntry.signals_summary?.entered || []);
  return _jrnSection('📋 Previous Journal', `
    <div class="jrn-prev-meta">
      <span class="jrn-prev-time">${fmtTime(prevEntry.time)}</span>
      <span class="sess-card-badge sq-${sessCls}" style="font-size:9px">${sessionLabel(prevEntry.session_name)}</span>
    </div>
    ${prevEntry.summary ? `<p class="jrn-prev-summary">${clean(prevEntry.summary)}</p>` : '<p class="jrn-empty">No summary recorded.</p>'}
    ${entered.length ? `<div class="jrn-prev-sigs">${entered.map(s => {
      const d = s.signal === 'BUY' ? 'buy' : 'sell';
      return `<span class="jrn-prev-sig signal-dir ${d}" style="font-size:9px">${pair(s.instrument)} ${s.signal}</span>`;
    }).join('')}</div>` : ''}`);
}

function renderJrnSetupsSection(topSetups, signals, csigFilter) {
  // csigFilter: entry-specific fn(instrument) → bool built from the entry's own CS snapshot.
  // Falls back to live hasCsigCurrency only when no per-entry filter is provided.
  const filter   = csigFilter || hasCsigCurrency;
  const entered  = (signals?.entered || []).filter(s => filter(s.instrument));
  const waiting  = (signals?.waiting || []).filter(s => filter(s.instrument));
  const setups   = (topSetups || []).filter(s => filter(s.instrument));
  if (!setups.length && !entered.length) return '';
  return _jrnSection('🎯 Top Setups & Signals', `
    ${entered.length ? `<div class="jrn-sig-entered">${entered.map(s => {
      const d = s.signal === 'BUY' ? 'buy' : 'sell';
      const levels = s.entry_price
        ? `<div class="jrn-sig-levels"><span><span class="wl-lbl">Entry</span>${fmt(s.entry_price)}</span><span><span class="wl-lbl">SL</span><span class="wl-sl">${fmt(s.stop_loss)}</span></span><span><span class="wl-lbl">TP</span><span class="wl-tp">${fmt(s.take_profit)}</span></span>${s.position_size ? `<span><span class="wl-lbl">Size</span>${s.position_size} lots</span>` : ''}</div>`
        : '';
      return `<div class="jrn-sig-row"><span class="signal-dir ${d}" style="font-size:10px;padding:2px 7px">${s.signal}</span><span class="jrn-sig-pair">${pair(s.instrument)}</span><span class="jrn-sig-conf">${s.confidence ?? '—'}%</span>${s.reason ? `<span class="jrn-sig-reason">${s.reason}</span>` : ''}${levels}</div>`;
    }).join('')}</div>` : ''}
    ${setups.length ? `<div class="jrn-setups">${setups.map(s => {
      const dir = s.bias === 'BUY' ? 'buy' : 'sell';
      return `<div class="jrn-setup-row"><span class="jrn-setup-pair">${pair(s.instrument)}</span><span class="signal-dir ${dir}" style="font-size:9px">${s.bias}</span><span class="jrn-setup-state">${clean(s.state||'')}</span><span class="jrn-setup-conf">${s.confidence}%</span></div>`;
    }).join('')}</div>` : ''}
    ${waiting.length ? `<p class="jrn-waiting">${waiting.length} pair${waiting.length>1?'s':''} waiting for confirmation</p>` : ''}`);
}

function renderJrnM15Section(impulses) {
  if (!impulses || !impulses.length) {
    return _jrnSection('⚡ M15 Impulse Moves', '<p class="jrn-empty">No active impulse moves at this hour.</p>');
  }
  const maxVal = Math.abs(impulses[0].smooth_45m) || 0.0001; // already sorted desc
  return _jrnSection('⚡ M15 Impulse Moves', `
    <div class="jrn-m15-list">
      ${impulses.map(r => {
        const cls  = r.bias === 'BUY' ? 'buy' : 'sell';
        const v    = r.smooth_45m;
        const pct  = Math.round((Math.abs(v) / maxVal) * 100);
        const vStr = (v >= 0 ? '+' : '') + Number(v).toFixed(5);
        return `
          <div class="jrn-m15-row">
            <span class="jrn-m15-pair">${pair(r.instrument)}</span>
            <span class="signal-dir ${cls}" style="font-size:9px;padding:2px 6px">${r.bias}</span>
            ${r.state ? `<span class="sb-behavior ${r.state}" style="font-size:8px">${clean(r.state)}</span>` : ''}
            <span class="jrn-m15-val">${vStr}</span>
            <div class="jrn-m15-bar-wrap"><div class="jrn-m15-bar-fill ${cls}" style="width:${pct}%"></div></div>
          </div>`;
      }).join('')}
    </div>`);
}

function renderJrnOutcomesSection(e) {
  const outcomes = [
    { label: '6H',  data: e.outcome_6h  },
    { label: '12H', data: e.outcome_12h },
    { label: '24H', data: e.outcome_24h },
  ];
  const blocks = outcomes.filter(o => o.data).map(o => {
    const d = o.data;
    const scoreCls = (d.accuracy_score ?? 0) >= 70 ? 'good' : (d.accuracy_score ?? 0) >= 40 ? 'mid' : 'bad';
    return `
      <div class="jrn-outcome-block">
        <div class="jrn-outcome-header">
          <span class="jrn-outcome-label">${o.label} Outcome</span>
          <span class="jrn-outcome-score ${scoreCls}">${d.accuracy_score ?? '—'}%</span>
          <span class="jrn-outcome-tally">${d.correct_count ?? 0} correct · ${d.incorrect_count ?? 0} wrong · ${d.flat_count ?? 0} flat</span>
        </div>
        ${d.verdict ? `<div class="jrn-verdict">${d.verdict}</div>` : ''}
        ${d.sentiment_assessment ? `<div class="jrn-sent-assess">Sentiment: ${d.sentiment_assessment}</div>` : ''}
        ${(d.setups || []).map(s => {
          const oCls  = s.outcome === 'CORRECT' ? 'correct' : s.outcome === 'INCORRECT' ? 'wrong' : 'flat';
          const oIcon = s.outcome === 'CORRECT' ? '✓' : s.outcome === 'INCORRECT' ? '✕' : '→';
          return `<div class="jrn-setup-outcome ${oCls}">${oIcon} ${pair(s.instrument)} ${s.bias} · ${clean(s.outcome||'')}</div>`;
        }).join('')}
      </div>`;
  }).join('');
  const pending = outcomes.filter(o => !o.data).map(o => `<span class="jrn-outcome-pill pending">⏳ ${o.label} pending</span>`).join('');
  if (!blocks && !pending) return '';
  return _jrnSection('📈 Outcomes', `${blocks}${pending ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${pending}</div>` : ''}`);
}

// ─── Journal modal open/close ─────────────────────────────────────────────────

let _jrnCachedEnergy = null;

async function openJournalModal(id) {
  const e = _journalEntries[id];
  if (!e) return;

  // Open immediately with data we already have — no waiting
  _renderJournalModal(e, null, null, null);

  // Compute session context from already-loaded entries (no extra API call)
  const all = Object.values(_journalEntries).sort((a, b) => a.time.localeCompare(b.time));
  const sessionEntries = all.filter(x => x.session_name === e.session_name && x.time <= e.time);
  const prevEntry = [...all].reverse().find(x => x.time < e.time) || null; // immediately preceding entry (any session)

  // Fetch market energy + news in parallel
  let newsEvents = [];
  try {
    const [newsR, energyR] = await Promise.all([
      api(`/api/news?date=${e.time.slice(0, 10)}`).catch(() => ({})),
      api('/api/market-energy').catch(() => null),
    ]);
    newsEvents = newsR.events || [];
    _jrnCachedEnergy = energyR;
  } catch {}

  _renderJournalModal(e, newsEvents, sessionEntries, prevEntry);
}

function _renderJournalModal(e, newsEvents, sessionEntries, prevEntry) {
  const sessCls = (e.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
  const signals  = e.signals_summary || {};
  const enteredCount = (signals.entered || []).length;

  // Build a per-entry CS filter from the entry's own stored snapshot.
  // If strong + weak are both empty → filter returns false for everything
  // → setups/signals/market-state sections show nothing for that hour.
  const { strong: _csStrong, weak: _csWeak } = computeEntryCsig(e);
  const _allEntryCsig = [..._csStrong, ..._csWeak];
  const _entryCsSet = _allEntryCsig.length >= 2 ? new Set(_allEntryCsig) : new Set();
  const entryCsigFilter = instr => {
    if (!_entryCsSet.size) return false;
    const base  = (instr || '').slice(0, 3).toUpperCase();
    const quote = (instr || '').slice(4, 7).toUpperCase();
    return _entryCsSet.has(base) || _entryCsSet.has(quote);
  };

  // Header
  document.getElementById('jrn-modal-time').textContent = fmtTime(e.time);
  document.getElementById('jrn-modal-badges').innerHTML = `
    <span class="sess-card-badge sq-${sessCls}" style="font-size:9px">${sessionLabel(e.session_name)}</span>
    ${enteredCount ? `<span class="jrn-count sig">${enteredCount}✦</span>` : ''}
    ${(({ strong, weak }) => {
      const parts = [];
      if (strong.length) parts.push(`<span class="jrn-csig-tag strong">💪 ${strong.join(' ')}</span>`);
      if (weak.length)   parts.push(`<span class="jrn-csig-tag weak">🔻 ${weak.join(' ')}</span>`);
      return parts.join('');
    })(computeEntryCsig(e))}`;

  // Body — sections in order
  document.getElementById('jrn-modal-body').innerHTML = [
    sessionEntries ? renderJrnSessionPerfSection(e, sessionEntries) : '',
    newsEvents !== null ? renderJrnCalendarSection(newsEvents, e.time) : _jrnSection('📅 Economic Calendar', '<p class="jrn-empty jrn-loading">Loading…</p>'),
    renderJrnCsigSection(e),
    renderJrnStrengthSection(e.currency_strength),
    _renderJrnMomentumSignal(),
    e.m15_impulses != null ? renderJrnM15Section(e.m15_impulses) : '',
    renderJrnSetupsSection(e.top_setups || [], signals, entryCsigFilter),
    prevEntry !== undefined ? renderJrnPrevSessionSection(prevEntry) : '',
  ].join('');

  const overlay = document.getElementById('jrn-modal-overlay');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  hydrateIcons();
}

function closeJournalModal() {
  document.getElementById('jrn-modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

// Close journal modal on Escape
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeJournalModal(); });

// ─── Market Journal ───────────────────────────────────────────────────────────

function renderJournal(data) {
  const el = document.getElementById('journal-list');
  if (!el) return;
  const entries = data?.entries || [];

  // Store all entries globally so modal access works
  _journalEntries = {};
  entries.forEach(e => { _journalEntries[e.id] = e; });

  if (!entries.length) {
    el.innerHTML = '<p class="empty-state">No journal entries yet — runs after first hourly update</p>';
    return;
  }

  const rows = entries.map(e => {
    const sessCls = (e.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
    const signals = e.signals_summary || {};
    const enteredCount = (signals.entered || []).length;

    return `
      <div class="jrn-entry" id="jrn-${e.id}" onclick="openJournalModal('${e.id}')">
        <div class="jrn-header">
          <div class="jrn-hdr-top">
            <span class="jrn-time">${fmtShort(e.time)}</span>
            <span class="sess-card-badge sq-${sessCls}" style="font-size:9px">${sessionLabel(e.session_name)}</span>
            ${enteredCount ? `<span class="jrn-count sig">${enteredCount}✦</span>` : ''}
          </div>
          <span class="jrn-chevron">›</span>
        </div>
        ${csigBadgeHtml(e)}
      </div>`;
  }).join('');

  el.innerHTML = rows + `
    <a href="/journal" class="jrn-view-all-btn">
      <i data-lucide="book-open" style="width:12px;height:12px"></i>
      View Full Journal
      <i data-lucide="arrow-right" style="width:12px;height:12px"></i>
    </a>`;

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ─── Main refresh ─────────────────────────────────────────────────────────────

async function refresh() {
  try {
    const [strength, signals, states, risk, actions, quality, spreads, m15Data, sessionData, journalData, profileData] = await Promise.all([
      api('/api/strength'),
      api('/api/signals'),
      api('/api/states'),
      api('/api/risk'),
      api('/api/actions'),
      api('/api/quality'),
      api('/api/spreads'),
      api('/api/m15-spreads').catch(() => ({ spreads: [] })),
      api('/api/session').catch(() => ({ session: null })),
      api('/api/journal?limit=5').catch(() => ({ entries: [] })),
      api('/api/profile').catch(() => ({})),
    ]);

    // Fetch news calendar (non-blocking) — must run AFTER _userTz is set
    fetchNews();

    // Cache profile — used by updateHeader and any section needing user settings
    if (profileData && !profileData.error) {
      _profile.account_size       = parseFloat(profileData.account_size)       || null;
      _profile.max_daily_risk_pct = parseFloat(profileData.max_daily_risk_pct) || null;
      _profile.max_trades         = parseInt(profileData.max_trades)            || null;
      // Timezone: 'auto' = browser local, anything else = IANA name, fallback = auto (browser)
      _userTz = profileData.timezone || 'auto';
    }

    // Today's news — called after _userTz is set so date is in user's timezone
    fetchTodayNews();

    updateHeader(risk);
    renderSession(sessionData);
    fetchMarketActivity(); // non-blocking — separate fetch, renders independently
    fetchMomentumSignal(); // non-blocking — checks for continuation signal
    buildChart(strength, activeTF);
    renderCurrencySignals(strength);          // must run first — populates _csigCurrencies
    renderLiveOpportunities(states.states || []);
    renderTopSetups(states.states || []);
    renderSignals(signals, states.states || [], journalData?.entries || []);
    renderStates(states);
    renderSpreads(spreads);
    renderRanking12H(spreads);
    renderM15Spreads(m15Data);
    updateM15Bar(m15Data);
    renderRisk(risk);
    renderActions(actions);
    renderQuality(quality);
    renderJournal(journalData);

    document.getElementById('status-dot').className = 'status-dot online';

    // First load: run GSAP entrance + hydrate icons
    if (_firstLoad) {
      _firstLoad = false;
      gsapCardEntrance();
    }
    hydrateIcons();

  } catch (err) {
    console.error('Refresh error:', err);
    document.getElementById('status-dot').className = 'status-dot stale';
    notyf.error('Data refresh failed — retrying next cycle');
  }
}

// ─── Skeleton loader — shown before first data arrives ────────────────────────

function showSkeletons() {
  const skels = {
    'live-opportunities':  3,
    'top-setups':          3,
    'watchlist-list':      2,
    'spreads-list':        6,
    'ranking-12h-list':    6,
    'm15-spreads-list':    6,
    'risk-list':           3,
    'actions-list':        4,
    'states-table':        8,
  };
  Object.entries(skels).forEach(([id, count]) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.loaded) return;
    el.innerHTML = Array(count).fill(0).map(() => `
      <div class="skeleton-card" style="margin-bottom:8px">
        <div class="skeleton skeleton-line w-60"></div>
        <div class="skeleton skeleton-line w-80"></div>
        <div class="skeleton skeleton-line w-40"></div>
      </div>`).join('');
  });
}

// Flash a stat pill when its value changes
function flashEl(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('data-updated');
  void el.offsetWidth; // reflow to restart animation
  el.classList.add('data-updated');
  setTimeout(() => el.classList.remove('data-updated'), 950);
}

// ─── Tab Navigation ──────────────────────────────────────────────────────────
(function initTabs() {
  const nav = document.getElementById('dash-tabs');
  if (!nav) return;
  const tabs = nav.querySelectorAll('.dash-tab');
  const panels = document.querySelectorAll('.tab-panel');

  const saved = localStorage.getItem('nfx_active_tab');
  if (saved && document.querySelector(`.dash-tab[data-tab="${saved}"]`)) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === saved));
    panels.forEach(p => p.classList.toggle('active', p.dataset.tab === saved));
  }

  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.dash-tab');
    if (!btn) return;
    const tab = btn.dataset.tab;
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    panels.forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
    localStorage.setItem('nfx_active_tab', tab);
    gsapCardEntrance();
  });
})();

// Boot
showSkeletons();
refresh();
setInterval(refresh, REFRESH_MS);
