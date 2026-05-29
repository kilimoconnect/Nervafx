// NervaFX Dashboard — app.js
// Libraries loaded via CDN: GSAP · Lucide Icons · CountUp.js · Notyf

// ─── Auth guard ───────────────────────────────────────────────────────────────
function _clearAuth() {
  // Clear ALL nfx_ cached data so next login starts completely fresh
  const keys = Object.keys(localStorage).filter(k => k.startsWith('nfx_'));
  keys.forEach(k => localStorage.removeItem(k));
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

// ─── Collapsible header panels ───────────────────────────────────────────────

function _syncHeaderHeight() {
  const h = document.querySelector('.header');
  if (h) document.documentElement.style.setProperty('--header-h', h.offsetHeight + 'px');
}

function toggleHdrPanel(name) {
  const panel = document.getElementById('hdr-panel-' + name);
  const btn   = document.getElementById('hdr-toggle-' + name);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  // Close all panels first
  document.querySelectorAll('.hdr-panel').forEach(p => { p.style.display = 'none'; });
  document.querySelectorAll('.hdr-icon-btn').forEach(b => { b.classList.remove('active'); });
  // Toggle the requested one
  if (!isOpen) {
    panel.style.display = '';
    if (btn) btn.classList.add('active');
  }
  _syncHeaderHeight();
}

// Update alert badge count (called when news/env/m15 bars become visible)
function _updateAlertBadge() {
  const panel = document.getElementById('hdr-panel-alerts');
  if (!panel) return;
  let count = 0;
  const bars = ['news-alert-bar', 'm15-impulse-bar'];
  for (const id of bars) {
    const el = document.getElementById(id);
    if (el && el.style.display !== 'none') count++;
  }
  const badge = document.getElementById('hdr-alert-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// Close panels when clicking outside header
document.addEventListener('click', function(e) {
  if (!e.target.closest('.header')) {
    document.querySelectorAll('.hdr-panel').forEach(p => { p.style.display = 'none'; });
    document.querySelectorAll('.hdr-icon-btn').forEach(b => { b.classList.remove('active'); });
    _syncHeaderHeight();
  }
});

// Sync header height on load + resize
window.addEventListener('load', _syncHeaderHeight);
window.addEventListener('resize', _syncHeaderHeight);

const REFRESH_MS = 60000;
let strengthChart = null;
let activeTF = '6';
let strengthData = null;
let _m15DataCache = null;   // Cached M15 spreads for flow ranking across components
let _volDataCache = {};     // Cached volume analysis: instrument → latest volume row
let _firstLoad = true;
// Currencies that currently meet the Currency Signals threshold (strong + weak combined).
// Set<string> — populated by renderCurrencySignals() before the section renderers run.
let _csigCurrencies = new Set();
// True once renderCurrencySignals() has processed real strength data.
// Distinguishes "still loading" (pass-through) from "loaded but nothing qualifies" (filter out).
let _csigDataLoaded = false;

// Helper: get grouping date for a hourly row (ASIA hour 23 → next day)
function _groupDate(r) {
  const date = r.time_utc.slice(0, 10);
  if (r.session_name === 'ASIA') {
    const h = new Date(r.time_utc).getUTCHours();
    if (h === 23) {
      const next = new Date(r.time_utc);
      next.setUTCDate(next.getUTCDate() + 1);
      return next.toISOString().slice(0, 10);
    }
  }
  return date;
}

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

// Derive strongest/weakest currencies from smoothed 3H strength data.
// Uses the global `strengthData` (from /api/strength) when available.
// Always returns top 2 strongest and top 2 weakest by smooth_3h value.
function getSmoothed3HFlow(currencies) {
  const list = currencies || strengthData?.currencies || [];
  if (!list.length) return { strong: [], weak: [] };
  const scored = list.map(c => {
    const v3 = parseFloat(c.smooth_3h ?? c.normalized_3h) || 0;
    return { cur: c.currency, v3 };
  }).sort((a, b) => b.v3 - a.v3);
  const strong = scored.slice(0, 2).map(c => c.cur);
  const weak   = scored.slice(-2).reverse().map(c => c.cur);
  return { strong, weak };
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

// ─── User plan (subscription) ─────────────────────────────────────────────────

let _userPlanReady = null; // resolved once plan is loaded

async function loadUserPlan() {
  // Instantly apply cached plan if it belongs to the current user.
  // Never flash "free" for a known premium/admin user — trust the cache
  // and let the API confirm or correct in the background.
  const cached     = localStorage.getItem('nfx_plan');
  const cachedUid  = localStorage.getItem('nfx_plan_uid');
  const currentUid = (JSON.parse(localStorage.getItem('nfx_user') || '{}') || {}).id;
  if (cached && cachedUid && cachedUid === currentUid && typeof applyPlan === 'function') {
    applyPlan(cached);
  }
  // If no valid cache, DON'T apply 'free' yet — wait for API

  try {
    const sub = await api('/api/subscription');
    const plan = sub.plan || 'free';
    localStorage.setItem('nfx_plan', plan);
    localStorage.setItem('nfx_plan_uid', currentUid || '');
    if (typeof applyPlan === 'function') applyPlan(plan);
  } catch (_) {
    // Only fall back to free if there's no valid cache
    if (!cached || cachedUid !== currentUid) {
      localStorage.setItem('nfx_plan', 'free');
      localStorage.setItem('nfx_plan_uid', currentUid || '');
      if (typeof applyPlan === 'function') applyPlan('free');
    }
  }
}

// Load plan as soon as possible; expose promise so refresh() can await it
_userPlanReady = loadUserPlan();

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
    startNewsAlertTimer();
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

// ─── News Alert Notification Bar ─────────────────────────────────────────────
// Shows upcoming HIGH/MEDIUM news in the header — 2h lookahead, countdown timer

let _newsAlertTimer = null;

function updateNewsAlertBar() {
  const bar = document.getElementById('news-alert-bar');
  if (!bar) return;

  const now = Date.now();
  const LOOKAHEAD_MS = 2 * 60 * 60 * 1000; // 2 hours

  // Collect all upcoming HIGH/MEDIUM events within lookahead
  const upcoming = [];
  for (const [cur, events] of Object.entries(_newsMap)) {
    for (const e of events) {
      const t = new Date(e.event_time).getTime();
      if (t > now && t <= now + LOOKAHEAD_MS && (e.impact === 'HIGH' || e.impact === 'MEDIUM')) {
        upcoming.push({ ...e, cur, ms: t - now });
      }
    }
  }

  if (!upcoming.length) {
    bar.style.display = 'none';
    _updateAlertBadge();
    return;
  }

  upcoming.sort((a, b) => a.ms - b.ms);

  const tz = (_userTz === 'auto')
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : (_userTz || 'UTC');

  // Show up to 3 chips
  const chips = upcoming.slice(0, 3).map(e => {
    const mins = Math.round(e.ms / 60000);
    const when = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60 ? ' ' + (mins % 60) + 'm' : ''}`;
    const impCls = e.impact === 'HIGH' ? 'nab-high' : 'nab-med';
    const timeStr = new Date(e.event_time).toLocaleTimeString('en-GB',
      { hour: '2-digit', minute: '2-digit', timeZone: tz, hour12: false });
    return `<span class="nab-chip ${impCls}" title="${e.event_name} at ${timeStr}">
      <span class="nab-imp">${e.impact === 'HIGH' ? '🔴' : '🟡'}</span>
      <span class="nab-cur">${e.cur}</span>
      <span class="nab-name">${e.event_name.length > 20 ? e.event_name.slice(0, 18) + '…' : e.event_name}</span>
      <span class="nab-when">${when}</span>
    </span>`;
  }).join('');

  const extraCount = upcoming.length - 3;
  const extraBadge = extraCount > 0 ? `<span class="nab-more">+${extraCount}</span>` : '';

  // Determine bar urgency: any HIGH within 30min = urgent, any within 1h = warning
  const hasUrgentHigh = upcoming.some(e => e.impact === 'HIGH' && e.ms < 30 * 60000);
  const hasWarningHigh = upcoming.some(e => e.impact === 'HIGH' && e.ms < 60 * 60000);
  bar.className = 'news-alert-bar' +
    (hasUrgentHigh ? ' nab--urgent' : hasWarningHigh ? ' nab--warning' : '');

  document.getElementById('nab-chips').innerHTML = chips + extraBadge;
  bar.style.display = '';
  _updateAlertBadge();
}

function startNewsAlertTimer() {
  // Update every 30 seconds for countdown accuracy
  if (_newsAlertTimer) clearInterval(_newsAlertTimer);
  updateNewsAlertBar();
  _newsAlertTimer = setInterval(updateNewsAlertBar, 30000);
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

// Energy direction phase rename: DB may still have old names
const _PHASE_RENAME = { READY: 'ENTRY', ENTRY: 'MOVING' };
function mapPhase(p) { return _PHASE_RENAME[p] || p; }

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
  const s = risk?.summary || {};

  // Profile values take precedence over risk.js defaults
  const balance = _profile.account_size       ?? Number(s.balance)          ?? 0;
  const maxPct  = _profile.max_daily_risk_pct ?? Number(s.maxDailyRiskPct)  ?? 2;
  const maxTr   = _profile.max_trades         ?? Number(s.maxTrades)        ?? 3;
  const open    = Number(s.openTrades ?? 0);

  // Recalculate daily risk % against the user's actual account size
  const dailyRisk = Number(s.dailyRisk ?? 0);
  const riskPct   = balance > 0 ? (dailyRisk / balance) * 100 : 0;

  document.getElementById('stat-balance').textContent = balance > 0 ? `Account Size: $${balance.toLocaleString()}` : 'Account Size: Set in Profile';
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

// ─── Data-driven setup analysis (based on 8,288 outcomes over 1 year) ─────────
// Generates a plain-English verdict for any market state shown on the dashboard.
// Thresholds from statistical analysis of actual price outcomes (4H horizon).

function _setupAnalysis(s) {
  const parts = [];
  const state = s.state || '';
  const conf  = s.confidence || 0;
  const sp6h  = Math.abs(parseFloat(s.spread_6h) || 0);
  const sess  = s.session_name || '';

  // Session classification — try session_name, fall back to session_label
  const sessRaw = sess || s.session_label || '';
  const sessLabel = sessRaw.includes('LONDON') ? 'LONDON'
    : sessRaw.includes('NEW_YORK') || sessRaw.includes('NY') || sessRaw.includes('New York') ? 'NEW_YORK'
    : sessRaw.includes('ASIA') || sessRaw.includes('Asia') ? 'ASIA' : '';

  // ── 1. State quality (from 8,288-sample backtest) ────────────────────
  const STATE_STATS = {
    PULLBACK_STARTING:  { wr: 55, net: 50.6, pf: 1.33, desc: 'Pullback just started — historically 55% WR, PF 1.33. Watch for completion.' },
    PULLBACK_ACTIVE:    { wr: 53, net: 55.1, pf: 1.42, desc: 'Active pullback — 53% WR with best profit factor (1.42). Patient entries here pay off.' },
    TREND:              { wr: 52, net: 16.0, pf: 1.05, desc: 'Trending — 52% WR but low profit factor. Wait for pullback entry, don\'t chase.' },
    BASE_FORMING:       { wr: 51, net: -13.6, pf: 0.87, desc: 'Base forming — 51% WR but negative expectancy. Needs strong confirmation to trade.' },
    READY_TO_ENTER:     { wr: 50, net: 0.1, pf: 1.10, desc: 'Entry signal — 50% WR overall. Quality depends on session + spread + confidence.' },
    REVERSAL_CONFIRMED: { wr: 36, net: 147.8, pf: 1.32, desc: 'Reversal confirmed — low 36% WR but large winners when correct. High risk.' },
    REVERSAL_RISK:      { wr: 0,  net: 0, pf: 0, desc: 'Structure weakening — historically 0% directional accuracy. Stand aside.' },
    REVERSAL_DEVELOPING:{ wr: 0,  net: 0, pf: 0, desc: 'Reversal developing — no directional edge. Wait for confirmation.' },
    NO_TRADE:           { wr: 33, net: 13.5, pf: 0.65, desc: 'No trade zone — 33% WR, negative expectancy.' },
  };
  const ss = STATE_STATS[state];
  if (ss) parts.push(ss.desc);

  // ── 2. Session edge (biggest factor in the data) ─────────────────────
  const SESS_EDGE = {
    PULLBACK_ACTIVE:  { LONDON: { wr: 66, net: 156.9 }, NEW_YORK: { wr: 52, net: 16.4 }, ASIA: { wr: 48, net: 37.4 } },
    PULLBACK_STARTING:{ LONDON: { wr: 55, net: 50.6 }, NEW_YORK: { wr: 55, net: 50.6 }, ASIA: { wr: 55, net: 50.6 } },
    TREND:            { LONDON: { wr: 63, net: 81.4 }, NEW_YORK: { wr: 47, net: -64.8 }, ASIA: { wr: 49, net: 34.7 } },
    BASE_FORMING:     { LONDON: { wr: 56, net: 15.6 }, NEW_YORK: { wr: 43, net: -69.4 }, ASIA: { wr: 58, net: 49.2 } },
    READY_TO_ENTER:   { LONDON: { wr: 55, net: 12.9 }, NEW_YORK: { wr: 41, net: -34.7 }, ASIA: { wr: 57, net: 36.1 } },
  };
  const sessEdge = SESS_EDGE[state]?.[sessLabel];
  if (sessEdge) {
    if (sessEdge.wr >= 60) parts.push(`${sessLabel} session boosts this to ${sessEdge.wr}% WR (+${Math.round(sessEdge.net)} pips avg) — best conditions.`);
    else if (sessEdge.wr >= 55) parts.push(`${sessLabel} session: ${sessEdge.wr}% WR, +${Math.round(sessEdge.net)} pips — above average.`);
    else if (sessEdge.wr <= 45) parts.push(`${sessLabel} session underperforms: ${sessEdge.wr}% WR, ${Math.round(sessEdge.net)} pips — reduce size or skip.`);
    else parts.push(`${sessLabel} session: ${sessEdge.wr}% WR — neutral.`);
  }

  // ── 3. Spread magnitude ──────────────────────────────────────────────
  if (sp6h >= 0.004)       parts.push(`6H spread strong (${(sp6h * 10000).toFixed(0)} pips) — 54% WR at this level, best quality setups.`);
  else if (sp6h >= 0.002)  parts.push(`6H spread decent (${(sp6h * 10000).toFixed(0)} pips) — 53% WR range.`);
  else if (sp6h > 0)       parts.push(`6H spread weak (${(sp6h * 10000).toFixed(0)} pips) — below 20 pips drops to 36% WR. Low conviction.`);

  // ── 4. Confidence level ──────────────────────────────────────────────
  if (conf >= 80)      parts.push(`Confidence ${conf}% — top tier. Historical: 52% WR, PF 1.46.`);
  else if (conf >= 65) parts.push(`Confidence ${conf}% — mid range. 52% WR for 60-69 band.`);
  else if (conf >= 55) parts.push(`Confidence ${conf}% — below 60 drops to 35% WR. Weak setup.`);
  else if (conf > 0)   parts.push(`Confidence ${conf}% — very low. Historically noise territory.`);

  // ── 5. Overall verdict ───────────────────────────────────────────────
  const isEntry = state === 'READY_TO_ENTER';
  const isPB    = state === 'PULLBACK_ACTIVE' || state === 'PULLBACK_STARTING';
  const isTrend = state === 'TREND';
  const isBase  = state === 'BASE_FORMING';
  const goodSess = sessEdge?.wr >= 55;
  const badSess  = sessEdge?.wr <= 45;
  const strongSpread = sp6h >= 0.004;
  const decentSpread = sp6h >= 0.002;
  const highConf = conf >= 80;

  if (isPB && sessLabel === 'LONDON' && decentSpread)
    parts.push('⟶ A+ SETUP — London pullback with decent spread is the highest-edge combo (66% WR, PF 1.42).');
  else if (isEntry && goodSess && strongSpread && highConf)
    parts.push('⟶ HIGH CONVICTION — strong spread, high confidence, good session. Take it.');
  else if (isEntry && goodSess && decentSpread)
    parts.push('⟶ GOOD SETUP — session and spread support this entry.');
  else if (isEntry && badSess)
    parts.push('⟶ WEAK — session historically underperforms. Reduce size or wait for next session.');
  else if (isEntry && !decentSpread)
    parts.push('⟶ LOW QUALITY — weak spread. Sub-20 pip spreads have 36% WR. Consider skipping.');
  else if (isPB && goodSess)
    parts.push('⟶ WATCH — pullback in a good session. Wait for completion → entry signal.');
  else if (isPB && !decentSpread)
    parts.push('⟶ WEAK PULLBACK — spread too small for reliable follow-through.');
  else if (isTrend && sessLabel === 'LONDON')
    parts.push('⟶ LONDON TREND — 63% WR. Don\'t chase, wait for pullback entry.');
  else if (isTrend && badSess)
    parts.push('⟶ AVOID — trending in a bad session (47% WR, negative pips). Wait.');
  else if (isBase && goodSess)
    parts.push('⟶ PATIENT — base forming with session support. Wait for 3H re-expansion.');
  else if (state === 'REVERSAL_CONFIRMED')
    parts.push('⟶ HIGH RISK — only 36% WR. If correct, moves are large. Tight stops required.');
  else if (state === 'REVERSAL_RISK' || state === 'REVERSAL_DEVELOPING' || state === 'NO_TRADE')
    parts.push('⟶ NO TRADE — no statistical edge. Stand aside.');
  else
    parts.push('⟶ MIXED — conditions don\'t clearly favour entry. Wait for better alignment.');

  return parts.join(' ');
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

  // Data-driven thresholds: 6H < 0.002 = 36% WR (dead zone), conf < 60 = 35% WR (noise)
  const live = (states || []).filter(s =>
    s.state === 'READY_TO_ENTER' &&
    hasCsigCurrency(s.instrument) &&
    Math.abs(parseFloat(s.spread_6h) || 0) >= 0.002 &&
    (s.confidence || 0) >= 60
  );

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
        <div class="fp-explain">${_setupAnalysis(s)}</div>
        ${newsWarnHtml(s.instrument)}
        ${s.session_blocked ? `<div class="sent-neutral-warn">⚠ ${s.next_action || 'Outside active session'}</div>` : ''}
        ${(s.confidence_breakdown||[]).length ? `<div class="conf-factors" style="align-items:flex-start;margin-top:6px">${s.confidence_breakdown.map(f=>`<span>+ ${f}</span>`).join('')}</div>` : ''}
      </div>`;
  }).join('');
}

// ─── Top Setups ───────────────────────────────────────────────────────────────

function computeTopSetups(states) {
  const priority = { READY: 3, PULLBACK: 2, TREND: 1 };
  // Data-driven: 6H < 0.002 = 36% WR, conf < 55 = noise
  return [...states]
    .filter(s => s.state !== 'NO_TRADE' && (s.confidence || 0) >= 55 && !s.session_blocked
      && Math.abs(parseFloat(s.spread_6h) || 0) >= 0.002)
    .sort((a, b) => {
      const pa = priority[a.phase] || 0, pb = priority[b.phase] || 0;
      return pa !== pb ? pb - pa : b.confidence - a.confidence;
    })
    .slice(0, 3);
}

function renderTopSetups(states) {
  const el = document.getElementById('top-setups');
  if (!el) return;
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
          <div class="fp-explain">${_setupAnalysis(s)}</div>
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
      <div class="fp-explain">${_setupAnalysis(s)}</div>
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
  // Data-driven: 6H < 0.002 = 36% WR (dead zone), filter out noise
  const watchlist = new Map();
  (statesArr || [])
    .filter(s => WATCHLIST_STATES.has(s.state) && Math.abs(parseFloat(s.spread_6h) || 0) >= 0.002)
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

  // Compute combined values + extract each TF for each currency
  const m15Str = _m15CurrencyStrength();
  const scored = currencies.map(c => {
    const v3  = parseFloat(c.smooth_3h  ?? c.normalized_3h)  || 0;
    const v6  = parseFloat(c.smooth_6h  ?? c.normalized_6h)  || 0;
    const v12 = parseFloat(c.smooth_12h ?? c.normalized_12h) || 0;
    const vm15 = m15Str[c.currency] || 0;
    return {
      cur: c.currency,
      combined: (vm15 + v3 + v6) / 3,  // M15+3H+6H
      c2: (vm15 + v3) / 2,             // M15+3H
      m15: vm15, h3: v3, h6: v6, h12: v12,
    };
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
          <span>CCY</span><span class="plan-pro-only">M15+3H</span><span class="plan-pro-only">M15+3H+6H</span><span class="plan-pro-only">M15</span><span>3H</span><span>6H</span><span>12H</span>
        </div>
        ${list.map(c => `
          <div class="cs-sig-row">
            <span class="cs-sig-cur">${c.cur}</span>
            <span class="cs-sig-combo plan-pro-only ${isStrong ? 'pos' : 'neg'}">${c.c2 >= 0 ? '+' : ''}${c.c2.toFixed(5)}</span>
            <span class="cs-sig-combo plan-pro-only ${isStrong ? 'pos' : 'neg'}">${c.combined >= 0 ? '+' : ''}${c.combined.toFixed(5)}</span>
            <span class="cs-sig-val plan-pro-only ${c.m15 >= 0 ? 'pos' : 'neg'}">${c.m15 >= 0 ? '+' : ''}${c.m15.toFixed(5)}</span>
            <span class="cs-sig-val ${c.h3  >= 0 ? 'pos' : 'neg'}">${c.h3  >= 0 ? '+' : ''}${c.h3.toFixed(5)}</span>
            <span class="cs-sig-val ${c.h6  >= 0 ? 'pos' : 'neg'}">${c.h6  >= 0 ? '+' : ''}${c.h6.toFixed(5)}</span>
            <span class="cs-sig-val ${c.h12 >= 0 ? 'pos' : 'neg'}">${c.h12 >= 0 ? '+' : ''}${c.h12.toFixed(5)}</span>
          </div>`).join('')}
      </div>`;
  }

  el.innerHTML = `<div class="cs-sig-grid">${col(strong, 'strong')}${col(weak, 'weak')}</div>`;
}

// ─── Currency strength chart ──────────────────────────────────────────────────

// Derive per-currency M15 strength from M15 pair spreads (smooth_45m).
// For each pair, base gets +spread, quote gets -spread, then average per currency.
function _m15CurrencyStrength() {
  const spreads = _m15DataCache?.spreads || [];
  if (!spreads.length) return {};
  const sums = {}, counts = {};
  for (const s of spreads) {
    const v = parseFloat(s.smooth_45m) || 0;
    const [base, quote] = s.instrument.split('_');
    sums[base]   = (sums[base]   || 0) + v;
    counts[base] = (counts[base] || 0) + 1;
    sums[quote]   = (sums[quote]   || 0) - v;
    counts[quote] = (counts[quote] || 0) + 1;
  }
  const result = {};
  for (const ccy of Object.keys(sums)) {
    result[ccy] = counts[ccy] > 0 ? sums[ccy] / counts[ccy] : 0;
  }
  return result;
}

function buildChart(data, tf) {
  if (!data?.currencies) return;
  strengthData = data;
  document.getElementById('strength-time').textContent = 'As of ' + fmtTime(data.time);

  // M15 currency strength — derived from M15 pair spreads
  const needsM15 = (tf === 'm15' || tf === 'c2' || tf === 'c3');
  const m15Strength = needsM15 ? _m15CurrencyStrength() : null;

  const getVal = (c, t) => {
    const vm15 = () => m15Strength?.[c.currency] || 0;
    const v3   = () => parseFloat(c.smooth_3h  ?? c.normalized_3h  ?? 0);
    const v6   = () => parseFloat(c.smooth_6h  ?? c.normalized_6h  ?? 0);
    if (t === 'm15') return vm15();
    if (t === 'c2')  return (vm15() + v3()) / 2;           // M15 + 3H
    if (t === 'c3')  return (vm15() + v3() + v6()) / 3;    // M15 + 3H + 6H
    if (t === 'combined') {
      const v12 = parseFloat(c.smooth_12h ?? c.normalized_12h ?? 0);
      return (v3() + v6() + v12) / 3;
    }
    return parseFloat(c[`smooth_${t}h`] ?? c[`normalized_${t}h`] ?? 0);
  };

  const currencies = [...data.currencies].sort((a, b) => getVal(b, tf) - getVal(a, tf));

  const labels       = currencies.map(c => c.currency);
  const values       = currencies.map(c => getVal(c, tf));
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
// Gated by currency signals — at least two currencies must qualify.

function renderStates(data, m15Data) {
  if (!data?.states) return;
  const el = document.getElementById('states-table');
  if (!el) return;

  // Currency signal gate — same as approved trades
  const noSignal = _csigDataLoaded && !_csigCurrencies.size;
  if (noSignal) {
    el.innerHTML = '<p class="empty-state">No currency signal — at least two currencies must qualify before scanner populates</p>';
    return;
  }

  // Build M15 impulse lookup
  const m15Map = {};
  if (m15Data?.spreads?.length) {
    for (const s of m15Data.spreads) m15Map[s.instrument] = s;
  }

  // Filter: CS currency gate + data-driven thresholds (no bad trades)
  // 6H < 0.002 = 36% WR dead zone, conf < 55 = noise, NO_TRADE/REVERSAL_RISK/DEVELOPING = 0% WR
  const BAD_STATES = new Set(['NO_TRADE', 'REVERSAL_RISK', 'REVERSAL_DEVELOPING']);
  const filtered = data.states.filter(s =>
    hasCsigCurrency(s.instrument) &&
    !BAD_STATES.has(s.state) &&
    s.bias && s.bias !== 'NONE' &&
    Math.abs(parseFloat(s.spread_6h) || 0) >= 0.002 &&
    (s.confidence || 0) >= 55
  );
  const sorted = [...filtered].sort((a, b) => {
    const pa = a.pipeline_stage || 0;
    const pb = b.pipeline_stage || 0;
    if (pb !== pa) return pb - pa;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  if (!sorted.length) {
    el.innerHTML = '<p class="empty-state">No pairs match current currency signals</p>';
    return;
  }

  el.innerHTML = sorted.map(s => {
    const ta       = s.tf_alignment || {};
    const dir      = s.bias === 'BUY' ? 'buy' : 'sell';
    const phCls    = (s.phase || s.state || '').replace(/ /g, '_');

    // M15 impulse data
    const m15 = m15Map[s.instrument];
    const imp = m15 ? (m15.impulse_score || 0) : 0;
    const impDir = m15 ? (m15.impulse_dir || 0) : 0;
    const flowSign = s.bias === 'BUY' ? 1 : -1;
    const impAligned = impDir === flowSign;
    const il = impulseLabel(imp);
    const impHtml = imp > 0
      ? `<span class="m15-imp-badge ${il.cls}" style="font-size:7px">${il.text} ${imp}</span>${impAligned ? '<span class="fp-imp-dir green" style="font-size:7px">▲</span>' : imp >= 30 ? '<span class="fp-imp-dir red" style="font-size:7px">▼</span>' : ''}`
      : '';

    return `<div class="scanner-row">
      <span class="scanner-pair">${pair(s.instrument)}</span>
      <span class="signal-dir ${dir}" style="font-size:8px;padding:1px 5px;margin:0">${s.bias}</span>
      <span class="phase-badge ${phCls}" style="font-size:8px;padding:1px 5px;white-space:nowrap">${clean(s.phase || s.state || '')}</span>
      <span class="action-badge ${s.action}" style="font-size:8px;padding:1px 5px;white-space:nowrap">${clean(s.action) || '—'}</span>
      <span class="scanner-conf">${s.confidence}%</span>
      ${impHtml}
      <span class="scanner-tf">
        <span class="tfa ${ta.h12}">12H${ta.h12||'→'}</span>
        <span class="tfa ${ta.h6}">6H${ta.h6||'→'}</span>
        <span class="tfa ${ta.h3}">3H${ta.h3||'→'}</span>
      </span>
      <span class="sb-behavior ${s.spread_behavior}" style="font-size:8px;white-space:nowrap">${clean(s.spread_behavior||'')}</span>
    </div>
    <div class="fp-explain scanner-explain">${_setupAnalysis(s)}</div>`;
  }).join('');
}

// ─── Spread ranking ───────────────────────────────────────────────────────────

function renderSpreads(data) {
  if (!data?.spreads) return;
  const el = document.getElementById('spreads-list');
  if (!el) return;
  // Use server-sorted order (weighted: 40% 12H + 35% 6H + 15% 3H + 10% accel)
  const sorted = data.spreads;
  const maxScore = Math.max(...sorted.map(s => s.weighted_score || 0), 0.0001);
  el.innerHTML = sorted.map(s => {
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

function renderRanking12H(spreadsData, strengthData) {
  const el = document.getElementById('ranking-12h-list');
  if (!el) return;

  let ranked = [];

  // Primary: use spreads data if available (Pro+ users)
  if (spreadsData?.spreads?.length) {
    ranked = [...spreadsData.spreads]
      .filter(s => s.spread_12h != null)
      .sort((a, b) => Math.abs(parseFloat(b.spread_12h)) - Math.abs(parseFloat(a.spread_12h)));
  }

  // Fallback: compute 12H pair spreads from free strength data
  if (!ranked.length && strengthData?.currencies?.length) {
    const ccys = strengthData.currencies;
    const valMap = {};
    ccys.forEach(c => { valMap[c.currency] = parseFloat(c.smooth_12h ?? c.normalized_12h) || 0; });
    const pairs = [
      'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
      'EUR_GBP','EUR_JPY','EUR_CHF','EUR_AUD','EUR_NZD','EUR_CAD',
      'GBP_JPY','GBP_CHF','GBP_AUD','GBP_NZD','GBP_CAD',
      'AUD_JPY','AUD_NZD','AUD_CHF','AUD_CAD',
      'NZD_JPY','NZD_CHF','NZD_CAD','CHF_JPY','CAD_JPY','CAD_CHF'
    ];
    ranked = pairs
      .filter(p => { const [b,q] = p.split('_'); return valMap[b] != null && valMap[q] != null; })
      .map(p => { const [b,q] = p.split('_'); return { instrument: p, spread_12h: valMap[b] - valMap[q] }; })
      .sort((a, b) => Math.abs(parseFloat(b.spread_12h)) - Math.abs(parseFloat(a.spread_12h)));
  }

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

// ─── Flow Performance (session strength pairs · M15 & 3H) ───────────────────

/**
 * Generate a plain-English explanation for a flow performance pair.
 * Tells the user what is happening and what it means for trading.
 */
function _fpExplain(fp) {
  const dirWord = fp.dir === 'BUY' ? 'buying' : 'selling';
  const baseWord = fp.dir === 'BUY' ? 'strengthening' : 'weakening';
  const quoteWord = fp.dir === 'BUY' ? 'weakening' : 'strengthening';
  const parts = [];

  // ── 1. Currency flow context ─────────────────────────────────────────
  parts.push(`${fp.base} ${baseWord}, ${fp.quote} ${quoteWord}.`);

  // ── 2. Timeframe alignment (status) ──────────────────────────────────
  switch (fp.status) {
    case 'STRONG':   parts.push(`All timeframes confirm ${dirWord} pressure.`); break;
    case 'ALIGNED':  parts.push(`M15 and one higher TF confirm ${dirWord}.`); break;
    case 'PARTIAL':  parts.push(`M15 confirms but higher TFs not aligned.`); break;
    case 'BUILDING': parts.push(`Higher TFs support but M15 hasn't confirmed — setup building.`); break;
    case 'AGAINST':  parts.push(`M15 moving against flow — wait for reversal.`); break;
    default:         parts.push(`Waiting for clearer signals.`);
  }

  // ── 3. Impulse quality (real M15 price action) ───────────────────────
  if (fp.impulseScore >= 60 && fp.impulseAligned)
    parts.push('Strong impulse aligned with flow — high conviction candles.');
  else if (fp.impulseScore >= 40 && fp.impulseAligned)
    parts.push('Trending impulse with flow — decent candle quality.');
  else if (fp.impulseScore >= 60 && !fp.impulseAligned)
    parts.push('Strong impulse AGAINST flow — don\'t fight this.');
  else if (fp.impulseScore >= 40 && !fp.impulseAligned)
    parts.push('Counter-trend impulse — price fighting the flow direction.');
  else if (fp.impulseScore >= 20)
    parts.push('Weak impulse — candles lack conviction.');

  // ── 4. Momentum ──────────────────────────────────────────────────────
  if (fp.momentum === 'Impulsive')        parts.push('Impulsive momentum — fast directional candles.');
  else if (fp.momentum === 'Accelerating') parts.push('Momentum accelerating — move is picking up speed.');
  else if (fp.momentum === 'Fading')       parts.push('Momentum fading — move may be exhausting.');
  else if (fp.momentum === 'Flat')         parts.push('Flat momentum — no directional drive.');

  // ── 5. M15 spread state ──────────────────────────────────────────────
  if (fp.state === 'EXPANDING')        parts.push('Spread expanding — divergence growing between currencies.');
  else if (fp.state === 'COMPRESSING') parts.push('Spread compressing — currencies converging, pressure easing.');
  else if (fp.state === 'REVERSING')   parts.push('Spread reversing — short-term direction flipping.');
  else if (fp.state === 'STEADY')      parts.push('Spread steady — stable pace, no acceleration.');

  // ── 6. Directional Efficiency (DE) ───────────────────────────────────
  if (fp.deCombined >= 30)      parts.push(`DE ${Math.round(fp.deCombined)}% — clean trending price action, moves are sustained.`);
  else if (fp.deCombined >= 20) parts.push(`DE ${Math.round(fp.deCombined)}% — directional but with some noise.`);
  else if (fp.deCombined >= 8)  parts.push(`DE ${Math.round(fp.deCombined)}% — mixed/choppy, expect whipsaws.`);
  else if (fp.deCombined > 0)   parts.push(`DE ${Math.round(fp.deCombined)}% — noisy, price going back and forth.`);

  // ── 7. Volume analysis ───────────────────────────────────────────────
  if (fp.volGrade) {
    // Grade (composite verdict)
    const gradeDesc = {
      INSTITUTIONAL: 'Institutional-grade volume — 24% strong-move rate, highest conviction.',
      STRONG:        'Strong volume participation — 12% strong-move rate, good conditions.',
      NORMAL:        'Normal volume — acceptable, needs other confirmations.',
      WEAK:          'Weak volume — present but not translating into price movement.',
      DEAD:          'Dead volume — no participation, nothing to trade.',
    };
    parts.push(gradeDesc[fp.volGrade] || `Volume: ${fp.volGrade}.`);

    // Efficiency (real data: median ~0.0002, p90 ~0.018, max ~0.06)
    const effBps = (fp.volEff * 10000).toFixed(1);
    if (fp.volEff >= 0.01)        parts.push(`Vol efficiency ${effBps} bps — institutional signature, volume driving price efficiently.`);
    else if (fp.volEff >= 0.001)  parts.push(`Vol efficiency ${effBps} bps — good, volume translating into price movement.`);
    else if (fp.volEff >= 0.0002) parts.push(`Vol efficiency ${effBps} bps — some movement but not conviction-level.`);
    else if (fp.volEff > 0)       parts.push(`Vol efficiency ${effBps} bps — low, volume mostly absorbed.`);
    else                          parts.push(`Vol efficiency near 0 — volume absorbed, ranging or accumulation.`);

    // RV (only mention at meaningful levels)
    if (fp.volRV >= 2.0)       parts.push(`RV ${fp.volRV.toFixed(1)}× — volume spike above session average.`);
    else if (fp.volRV >= 1.5)  parts.push(`RV ${fp.volRV.toFixed(1)}× — above average, but no proven edge below 2.0×.`);
    else if (fp.volRV < 0.5)   parts.push(`RV ${fp.volRV.toFixed(1)}× — very low volume, market quiet.`);

    // Persistence
    if (fp.volPers >= 3)       parts.push(`Volume sustained ${fp.volPers} candles — watch for exhaustion.`);
    else if (fp.volPers >= 1)  parts.push(`Volume elevated for ${fp.volPers} candle(s) — participation building.`);
  }

  // ── 8. Overall takeaway ──────────────────────────────────────────────
  const isAligned  = fp.status === 'STRONG' || fp.status === 'ALIGNED';
  const hasCleanDE = fp.deCombined >= 20;
  const hasGoodEff = fp.volEff >= 0.001;
  const hasInstVol = fp.volGrade === 'INSTITUTIONAL' || fp.volGrade === 'STRONG';
  const isDead     = fp.volGrade === 'DEAD' || fp.volRV < 0.5;
  const isWeak     = fp.volGrade === 'WEAK' || fp.volGrade === 'DEAD';

  if (isAligned && hasCleanDE && hasGoodEff)
    parts.push('⟶ HIGH CONVICTION — aligned flow, clean DE, efficient volume.');
  else if (isAligned && hasCleanDE && hasInstVol)
    parts.push('⟶ STRONG SETUP — aligned with good DE and volume participation.');
  else if (isAligned && hasCleanDE)
    parts.push('⟶ GOOD SETUP — aligned with clean price action. Volume ordinary — wait for efficiency.');
  else if (isAligned && hasGoodEff)
    parts.push('⟶ CAUTION — efficient volume but DE is choppy. Tighten stops.');
  else if (isAligned && isWeak)
    parts.push('⟶ LOW QUALITY — aligned but weak volume and choppy DE. Likely false breakout.');
  else if (isAligned)
    parts.push('⟶ MIXED — direction is right but conditions are noisy. Reduce size.');
  else if (fp.status === 'BUILDING' && hasCleanDE && hasGoodEff)
    parts.push('⟶ WATCH — building with good conditions. Wait for M15 to confirm.');
  else if (fp.status === 'BUILDING')
    parts.push('⟶ WAIT — setup building. Need M15 confirmation + volume.');
  else if (fp.status === 'AGAINST')
    parts.push('⟶ AVOID — counter-trend. Don\'t fight short-term momentum.');
  else if (isDead)
    parts.push('⟶ DEAD — no participation, nothing to trade.');
  else
    parts.push('⟶ NO EDGE — conditions mixed. Wait for alignment + efficiency.');

  return parts.join(' ');
}

// ─── Volume Analysis helpers ─────────────────────────────────────────────────

function _buildVolMap(volData) {
  const map = {};
  if (!volData?.rows?.length) return map;
  // Rows are sorted by time asc — last row per instrument is the latest
  for (const r of volData.rows) map[r.instrument] = r;
  return map;
}

function _volGradeBadge(grade) {
  if (!grade) return '';
  const VOL_GRADE_CLS = {
    INSTITUTIONAL: 'vol-institutional',
    STRONG: 'vol-strong',
    NORMAL: 'vol-normal',
    WEAK: 'vol-weak',
    DEAD: 'vol-dead',
  };
  const VOL_GRADE_SHORT = {
    INSTITUTIONAL: 'Inst',
    STRONG: 'Strong',
    NORMAL: 'Normal',
    WEAK: 'Weak',
    DEAD: 'Dead',
  };
  const cls = VOL_GRADE_CLS[grade] || 'vol-normal';
  const text = VOL_GRADE_SHORT[grade] || grade;
  return `<span class="vol-grade-badge ${cls}">${text}</span>`;
}

/**
 * Generate plain-English analysis for a Strength Flow pair.
 * Combines status, DE, and volume data into a verdict + bullet points.
 *
 * Thresholds based on 1-year backtest (709K rows, active sessions):
 *   Grade     Strong-move rate
 *   DEAD      0.0%  — never produces a strong move
 *   WEAK      5.4%  — low quality, volume without efficiency
 *   NORMAL   10.9%  — decent, needs confirmation
 *   STRONG   12.4%  — good conditions
 *   INST     23.6%  — high conviction
 *
 *   RV 2.0+  15.4%  — only RV level with real edge (below = noise)
 *   Eff ≥5%  49.7%  — strongest single predictor
 *   Eff ≥10% 74.0%  — institutional conviction
 *
 * @param {Object} p — { pair, dir, status, de, volGrade, volRV, volEff, volPers, volScore }
 * @returns {{ verdict: string, points: string[], cls: string }}
 */
function _flowPairAnalysis(p) {
  const points = [];
  const dir = p.dir === 'BUY' ? 'buying' : 'selling';
  const phase = (p.status || '').toUpperCase();

  // ── 1. Energy phase description ──────────────────────────────────────
  const PHASE_DESC = {
    MOVING:      'MOVING phase — energy confirmed, M15 aligned with flow, already in motion. Late entry — monitor for exhaustion.',
    ENTRY:       'ENTRY phase — compression complete, conditions aligned. Execute on next M15 confirmation candle into ' + dir + ' direction.',
    COMPRESSION: 'COMPRESSION phase — M15 range tightening after pullback. Energy building — breakout imminent if volume confirms.',
    PULLBACK:    'PULLBACK phase — M15 retracing against the ' + dir + ' flow. Normal behaviour — wait for pullback to complete before entry.',
    MONITORING:  'MONITORING phase — energy triggered ' + dir + ' direction but M15 hasn\'t started the sequence yet. Watch for initial pullback.',
  };
  points.push(PHASE_DESC[phase] || 'Phase: ' + phase);

  // ── 2. Directional Efficiency (DE) ───────────────────────────────────
  if (p.de > 0) {
    if (p.de >= 30)      points.push('Clean trending price action (DE ' + p.de + '%) — moves are directional and sustained.');
    else if (p.de >= 20) points.push('Directional price action (DE ' + p.de + '%) — decent quality with some noise.');
    else if (p.de >= 8)  points.push('Mixed price action (DE ' + p.de + '%) — choppy, expect false signals and whipsaws.');
    else                 points.push('Choppy price action (DE ' + p.de + '%) — movement is back-and-forth, not directional. High stop-out risk.');
  }

  // ── 3. Volume analysis (data-driven thresholds) ──────────────────────
  if (!p.volGrade) {
    points.push('No volume data available.');
  } else {
    // Volume Grade
    const GRADE_DESC = {
      INSTITUTIONAL: 'Institutional-grade volume — 24% strong-move rate. Highest conviction.',
      STRONG:        'Strong volume participation — 12% strong-move rate. Good conditions for directional trades.',
      NORMAL:        'Normal volume — 11% strong-move rate. Acceptable but needs phase + DE confirmation.',
      WEAK:          'Weak volume — only 5% produce strong moves. Volume present but not translating into price.',
      DEAD:          'Dead volume — 0% strong-move rate. No participation at this level.',
    };
    points.push(GRADE_DESC[p.volGrade] || 'Volume grade: ' + p.volGrade);

    // Volume Efficiency (real data range: median ~0.0002, p90 ~0.018, max ~0.06)
    const effBps = (p.volEff * 10000).toFixed(1); // basis points for readable display
    if (p.volEff >= 0.01)        points.push('Efficiency ' + effBps + ' bps — institutional signature. Volume driving price efficiently.');
    else if (p.volEff >= 0.001)  points.push('Efficiency ' + effBps + ' bps — good, volume translating into price movement.');
    else if (p.volEff >= 0.0002) points.push('Efficiency ' + effBps + ' bps — some directional movement, not yet conviction-level.');
    else if (p.volEff > 0)       points.push('Efficiency ' + effBps + ' bps — low, volume mostly absorbed without price progress.');
    else                          points.push('Efficiency near 0 — volume absorbed without price progress.');

    // Relative Volume
    if (p.volRV >= 2.0)       points.push('RV ' + p.volRV.toFixed(1) + '× — volume spike above session average.');
    else if (p.volRV >= 1.5)  points.push('RV ' + p.volRV.toFixed(1) + '× — above average volume.');
    else if (p.volRV < 0.5)   points.push('RV ' + p.volRV.toFixed(1) + '× — very low volume. Market is quiet.');

    // Persistence
    if (p.volPers >= 3)       points.push('Volume sustained ' + p.volPers + ' candles — watch for exhaustion.');
    else if (p.volPers >= 1)  points.push('Volume elevated for ' + p.volPers + ' candle(s) — participation building.');
  }

  // ── 4. Overall verdict (energy phase × DE × volume) ──────────────────
  let verdict, verdictCls;
  const hasCleanDE = p.de >= 20;
  const hasTrendDE = p.de >= 30;
  const hasGoodEff = p.volEff >= 0.001; // p75+ in real data (~top 20%)
  const hasInstVol = p.volGrade === 'INSTITUTIONAL' || p.volGrade === 'STRONG';
  const isDead     = p.volGrade === 'DEAD' || p.volRV < 0.5;
  const isWeak     = p.volGrade === 'WEAK' || p.volGrade === 'DEAD';

  if (phase === 'MOVING') {
    // MOVING = already in motion — late entry risk
    if (hasTrendDE && hasGoodEff) {
      verdict = 'MOVING with strong momentum — trending DE and efficient volume. Already running — late entry, watch for exhaustion.';
      verdictCls = 'sfa-caution';
    } else if (hasTrendDE && hasInstVol) {
      verdict = 'MOVING with institutional volume — clean trend but already in motion. Reduced R:R, tighten stops.';
      verdictCls = 'sfa-caution';
    } else if (hasTrendDE) {
      verdict = 'MOVING — trending DE, M15 confirmed but price already extended. Late entry — reduce size.';
      verdictCls = 'sfa-caution';
    } else if (hasCleanDE && hasGoodEff) {
      verdict = 'MOVING — directional DE with volume. Already running — only enter on pullback retest.';
      verdictCls = 'sfa-caution';
    } else if (hasCleanDE) {
      verdict = 'MOVING — directional DE but already extended. Wait for next cycle or pullback.';
      verdictCls = 'sfa-wait';
    } else if (isDead) {
      verdict = 'MOVING phase but dead volume and weak DE — momentum fading. Skip this cycle.';
      verdictCls = 'sfa-avoid';
    } else {
      verdict = 'MOVING phase but choppy DE — price running without clean structure. Avoid chasing.';
      verdictCls = 'sfa-avoid';
    }
  } else if (phase === 'ENTRY') {
    // ENTRY = trade now — best phase for execution
    if (hasTrendDE && hasGoodEff) {
      verdict = 'High conviction ENTRY — trending DE, efficient volume, conditions aligned. Best time to execute.';
      verdictCls = 'sfa-go';
    } else if (hasTrendDE && hasInstVol) {
      verdict = 'Strong ENTRY — clean trending DE with strong volume participation. Execute with confidence.';
      verdictCls = 'sfa-go';
    } else if (hasTrendDE) {
      verdict = 'Good ENTRY — trending DE, conditions aligned. Volume is ordinary — valid trade, standard size.';
      verdictCls = 'sfa-go';
    } else if (hasCleanDE && hasGoodEff) {
      verdict = 'Solid ENTRY — directional DE with efficient volume. Good setup, execute.';
      verdictCls = 'sfa-go';
    } else if (hasCleanDE) {
      verdict = 'Valid ENTRY — directional DE, M15 aligned. Volume is average — reduce size slightly.';
      verdictCls = 'sfa-good';
    } else if (isDead) {
      verdict = 'ENTRY phase but dead volume and weak DE — likely false signal. Skip or wait for next cycle.';
      verdictCls = 'sfa-avoid';
    } else {
      verdict = 'ENTRY phase but choppy DE — conditions aligned but price action is noisy. Tighten stops, reduce size.';
      verdictCls = 'sfa-caution';
    }
  } else if (phase === 'COMPRESSION') {
    // COMPRESSION = building energy
    if (hasCleanDE && hasInstVol) {
      verdict = 'COMPRESSION with strong volume and clean DE — energy building for breakout. Be ready.';
      verdictCls = 'sfa-wait';
    } else if (hasCleanDE) {
      verdict = 'COMPRESSION — M15 range tightening with directional DE. Breakout approaching, prepare entry.';
      verdictCls = 'sfa-wait';
    } else {
      verdict = 'COMPRESSION — price coiling but conditions aren\'t ideal yet. Wait for ENTRY phase.';
      verdictCls = 'sfa-wait';
    }
  } else if (phase === 'PULLBACK') {
    // PULLBACK = retracing, normal part of the sequence
    if (hasTrendDE) {
      verdict = 'PULLBACK in a trending market — healthy retracement. DE is clean, wait for pullback to complete then enter.';
      verdictCls = 'sfa-wait';
    } else if (hasCleanDE) {
      verdict = 'PULLBACK — M15 retracing against flow. Normal sequence, wait for compression or reversal candle.';
      verdictCls = 'sfa-wait';
    } else {
      verdict = 'PULLBACK with weak DE — could be a trend reversal rather than a pullback. Monitor closely.';
      verdictCls = 'sfa-caution';
    }
  } else {
    // MONITORING = initial state, waiting for sequence to begin
    if (isDead) {
      verdict = 'MONITORING — no M15 sequence started and volume is dead. Nothing to trade yet.';
      verdictCls = 'sfa-avoid';
    } else if (hasTrendDE && hasGoodEff) {
      verdict = 'MONITORING but strong conditions — trending DE and efficient volume. Watch for M15 pullback to start the sequence.';
      verdictCls = 'sfa-wait';
    } else if (hasCleanDE) {
      verdict = 'MONITORING — energy direction set, DE is directional. Wait for M15 to begin the pullback → entry sequence.';
      verdictCls = 'sfa-wait';
    } else {
      verdict = 'MONITORING — energy direction set but no M15 action yet. Wait for the sequence to develop.';
      verdictCls = 'sfa-wait';
    }
  }

  return { verdict, points, cls: verdictCls };
}

// ─── Build scored flow pairs from pre-computed API or client-side fallback ────

let _fpPrecomputed = null; // Pre-computed flow performance rows from API
let _energySignalsCache = null; // Cached energy signal pairs from API

function _buildFpScored(strengthArg, m15Data) {
  // Use passed strength data or fall back to global cache
  const sData = strengthArg || strengthData;

  // ── Primary: use pre-computed FP data (free plan — includes all metrics) ──
  if (_fpPrecomputed && _fpPrecomputed.length) {
    // Get latest hour's rows (they're sorted by time asc, so last group)
    const latestTime = _fpPrecomputed[_fpPrecomputed.length - 1].time;
    const latestHour = (latestTime || '').slice(0, 13); // YYYY-MM-DDTHH
    const latest = _fpPrecomputed.filter(r => (r.time || '').slice(0, 13) === latestHour);
    if (latest.length) {
      // Build currency strength maps for the explain function (base/quote display)
      const ccyMap3H = {};
      if (sData?.currencies?.length) {
        for (const c of sData.currencies) {
          ccyMap3H[c.currency] = parseFloat(c.smooth_3h ?? c.normalized_3h) || 0;
        }
      }

      // Build scored array with client-side ranking (same formula as Signal Pairs)
      const mapped = latest.map(r => {
        const [base, quote] = r.instrument.split('_');
        const flowSign = r.dir === 'BUY' ? 1 : -1;
        const v45 = parseFloat(r.v45) || 0;
        const v90 = parseFloat(r.v90) || 0;
        const spread3H = parseFloat(r.spread_3h) || 0;
        const spread6H = parseFloat(r.spread_6h) || 0;
        const deCombined = parseFloat(r.de_combined) || 0;
        const impulseScore = r.impulse_score || 0;
        const impulseAligned = !!r.impulse_aligned;
        const m15State = (r.state || 'FLAT').toUpperCase();

        // Derive alignment checks for dots + explain
        const M15_CONFIRM_MIN = 0.00008;
        const m15Confirms = Math.sign(v45) === flowSign && Math.abs(v45) >= M15_CONFIRM_MIN;
        const h3Confirms = Math.sign(spread3H) === flowSign;
        const h6Confirms = Math.sign(spread6H) === flowSign;
        const accel = v45 - v90;
        const accelSign = Math.sign(accel) === flowSign;

        // Compute perfScore — identical to Signal Pairs client-side formula
        let perfScore = 0;
        perfScore += (v45 * flowSign) * 10000 * 3;
        perfScore += (spread3H * flowSign) * 10000 * 2;
        perfScore += (spread6H * flowSign) * 10000 * 1;
        if (impulseAligned && impulseScore >= 40) perfScore += impulseScore * 0.5;
        else if (impulseAligned)                  perfScore += impulseScore * 0.25;
        else if (impulseScore >= 40)              perfScore -= impulseScore * 0.3;
        if (m15Confirms && impulseScore >= 40)    perfScore += 20;
        else if (m15Confirms)                     perfScore += 10;
        if (h3Confirms)  perfScore += 10;
        if (h6Confirms)  perfScore += 5;
        if (accelSign)   perfScore += 10;
        if (m15State === 'EXPANDING' && m15Confirms)                          perfScore += 15;
        if (m15State === 'EXPANDING' && impulseAligned && impulseScore >= 50) perfScore += 10;
        if (m15State === 'REVERSING')                                         perfScore -= 10;
        if (m15State === 'COMPRESSING' && !m15Confirms)                       perfScore -= 15;
        const finalScore = (0.75 * perfScore) + (0.25 * deCombined);

        const STATUS_CLS = { STRONG: 'fp-strong', ALIGNED: 'fp-aligned', PARTIAL: 'fp-partial', BUILDING: 'fp-building', AGAINST: 'fp-against', WAIT: 'fp-wait' };

        return {
          instrument: r.instrument, dir: r.dir, base, quote,
          v45, v90, v180: null,
          spread3H, spread6H,
          state: r.state || 'FLAT',
          status: r.status || 'WAIT',
          statusCls: STATUS_CLS[r.status] || 'fp-wait',
          momentum: r.momentum || 'No data',
          m15Confirms, h3Confirms, h6Confirms,
          accel, accelSign,
          perfScore, finalScore,
          deCombined,
          deLabel: deCombined >= 30 ? 'Institutional' : deCombined >= 20 ? 'Clean' : deCombined >= 8 ? 'Mixed' : 'Noisy',
          impulseScore, impulseAligned,
          volRV: parseFloat(r.vol_rv) || 0,
          volEff: parseFloat(r.vol_eff) || 0,
          volGrade: r.vol_grade || '',
          volPers: parseFloat(r.vol_pers) || 0,
          volAcc: 0, volScore: 0,
          h3Base: ccyMap3H[base] ?? null,
          h3Quote: ccyMap3H[quote] ?? null,
        };
      });
      mapped.sort((a, b) => b.finalScore - a.finalScore);
      return mapped;
    }
  }

  // ── Fallback: client-side computation (same as before for premium with live m15 data) ──
  const { strong, weak } = getSmoothed3HFlow(sData?.currencies);
  if (!strong.length || !weak.length) return null;

  const PAIRS = new Set([
    'EUR_USD','GBP_USD','AUD_USD','NZD_USD','USD_JPY','USD_CHF','USD_CAD',
    'EUR_GBP','EUR_JPY','EUR_CHF','EUR_CAD','EUR_AUD','EUR_NZD',
    'GBP_JPY','GBP_CHF','GBP_CAD','GBP_AUD','GBP_NZD',
    'AUD_JPY','AUD_CHF','AUD_CAD','AUD_NZD',
    'NZD_JPY','NZD_CHF','NZD_CAD','CAD_JPY','CAD_CHF','CHF_JPY',
  ]);

  const flowPairs = [];
  for (const st of strong) {
    for (const wk of weak) {
      if (st === wk) continue;
      const fwd = `${st}_${wk}`, rev = `${wk}_${st}`;
      if (PAIRS.has(fwd))      flowPairs.push({ instrument: fwd, dir: 'BUY' });
      else if (PAIRS.has(rev)) flowPairs.push({ instrument: rev, dir: 'SELL' });
    }
  }
  if (!flowPairs.length) return null;

  const m15Map = {};
  if (m15Data?.spreads?.length) { for (const s of m15Data.spreads) m15Map[s.instrument] = s; }
  const ccyMap3H = {}, ccyMap6H = {};
  if (sData?.currencies?.length) {
    for (const c of sData.currencies) {
      ccyMap3H[c.currency] = parseFloat(c.smooth_3h ?? c.normalized_3h) || 0;
      ccyMap6H[c.currency] = parseFloat(c.smooth_6h ?? c.normalized_6h) || 0;
    }
  }

  const scored = flowPairs.slice(0, 4).map(fp => {
    const [base, quote] = fp.instrument.split('_');
    const m15 = m15Map[fp.instrument];
    const v45  = m15 ? parseFloat(m15.smooth_45m) || 0 : null;
    const v90  = m15 ? parseFloat(m15.smooth_90m) || 0 : null;
    const impulseScore = m15 ? (m15.impulse_score || 0) : 0;
    const impulseDir   = m15 ? (m15.impulse_dir   || 0) : 0;
    const flowSign = fp.dir === 'BUY' ? 1 : -1;
    const impulseAligned = impulseDir === flowSign;
    let state = null;
    if (v45 != null && v90 != null) {
      const dir45 = v45 * flowSign, dir90 = v90 * flowSign;
      if (Math.abs(v45) < 0.00005)                state = 'FLAT';
      else if (dir45 < 0)                          state = 'REVERSING';
      else if (dir45 > dir90 * 1.1)                state = 'EXPANDING';
      else if (dir45 < dir90 * 0.85 && dir90 > 0)  state = 'COMPRESSING';
      else                                          state = 'STEADY';
    }
    const spread3H = (ccyMap3H[base] ?? 0) - (ccyMap3H[quote] ?? 0);
    const spread6H = (ccyMap6H[base] ?? 0) - (ccyMap6H[quote] ?? 0);
    const M15_CONFIRM_MIN = 0.00008;
    const m15Confirms = v45 != null ? (Math.sign(v45) === flowSign && Math.abs(v45) >= M15_CONFIRM_MIN) : null;
    const h3Confirms  = Math.sign(spread3H) === flowSign;
    const h6Confirms  = Math.sign(spread6H) === flowSign;
    const accel = (v45 != null && v90 != null) ? v45 - v90 : null;
    const accelSign = accel != null ? Math.sign(accel) === flowSign : null;
    let perfScore = 0;
    if (v45 != null)      perfScore += (v45 * flowSign) * 10000 * 3;
    perfScore += (spread3H * flowSign) * 10000 * 2;
    perfScore += (spread6H * flowSign) * 10000 * 1;
    if (impulseAligned && impulseScore >= 40) perfScore += impulseScore * 0.5;
    else if (impulseAligned)                  perfScore += impulseScore * 0.25;
    else if (impulseScore >= 40)              perfScore -= impulseScore * 0.3;
    if (m15Confirms && impulseScore >= 40) perfScore += 20;
    else if (m15Confirms)                  perfScore += 10;
    if (h3Confirms)  perfScore += 10;
    if (h6Confirms)  perfScore += 5;
    if (accelSign) perfScore += 10;
    if (state === 'EXPANDING' && m15Confirms) perfScore += 15;
    if (state === 'EXPANDING' && impulseAligned && impulseScore >= 50) perfScore += 10;
    if (state === 'REVERSING')                       perfScore -= 10;
    if (state === 'COMPRESSING' && !m15Confirms)     perfScore -= 15;
    const htfCount = [h3Confirms, h6Confirms].filter(x => x === true).length;
    let status, statusCls;
    if (m15Confirms && htfCount === 2)       { status = 'STRONG';   statusCls = 'fp-strong'; }
    else if (m15Confirms && htfCount === 1)  { status = 'ALIGNED';  statusCls = 'fp-aligned'; }
    else if (m15Confirms && htfCount === 0)  { status = 'PARTIAL';  statusCls = 'fp-partial'; }
    else if (!m15Confirms && htfCount >= 1)  { status = 'BUILDING'; statusCls = 'fp-building'; }
    else if (m15Confirms === false)          { status = 'AGAINST';  statusCls = 'fp-against'; }
    else                                     { status = 'WAIT';     statusCls = 'fp-wait'; }
    let momentum;
    if (impulseScore >= 50 && impulseAligned)         momentum = 'Impulsive';
    else if (accel != null && v45 != null) {
      if (accelSign && Math.abs(v45) > 0.0003)       momentum = 'Accelerating';
      else if (!accelSign && Math.abs(accel) > 0.0002) momentum = 'Fading';
      else if (Math.abs(v45) < 0.0002)               momentum = 'Flat';
      else                                            momentum = 'Steady';
    } else momentum = 'No data';
    const deCombined = m15 ? parseFloat(m15.de_combined) || 0 : 0;
    const deLabel = deCombined >= 30 ? 'Institutional' : deCombined >= 20 ? 'Clean' : deCombined >= 8 ? 'Mixed' : 'Noisy';
    const vol = _volDataCache[fp.instrument];
    return { ...fp, v45, v90, v180: null, spread3H, spread6H, state, accel, m15Confirms, h3Confirms, h6Confirms, accelSign, perfScore, status, statusCls, momentum, h3Base: ccyMap3H[base] ?? null, h3Quote: ccyMap3H[quote] ?? null, base, quote, deCombined, deLabel, impulseScore, impulseAligned,
      volRV: vol ? parseFloat(vol.relative_volume) || 0 : 0, volAcc: vol ? parseFloat(vol.volume_acceleration) || 0 : 0, volPers: vol ? parseFloat(vol.volume_persistence) || 0 : 0, volEff: vol ? parseFloat(vol.volume_efficiency) || 0 : 0, volScore: vol ? parseFloat(vol.participation_score) || 0 : 0, volGrade: vol?.participation_grade || '' };
  });
  scored.forEach(fp => { fp.finalScore = (0.75 * fp.perfScore) + (0.25 * fp.deCombined); });
  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

function renderFlowPerformance(strengthData, m15Data) {
  const el = document.getElementById('flow-perf-list');
  if (!el) return;

  // Use pre-computed flow performance data (includes DE, volume, impulse — no plan gate)
  let scored = _buildFpScored(strengthData, m15Data);
  if (!scored || !scored.length) {
    el.innerHTML = '<p class="empty-state">No strength data yet</p>';
    return;
  }

  // Use Signal Pairs ranking order — same pairs, same sort, FP details
  if (_energySignalsCache?.pairs?.length) {
    const activePairs = _energySignalsCache.pairs.filter(p => p.active);
    if (!activePairs.length) {
      el.innerHTML = '<p class="empty-state">No energy signal pairs matched</p>';
      return;
    }
    // Compute _finalScore on signal pairs (same formula as renderEnergySignals)
    activePairs.forEach(p => {
      const v45 = parseFloat(p.v45) || 0;
      const v90 = parseFloat(p.v90) || 0;
      const sp3 = parseFloat(p.spread_3h) || 0;
      const sp6 = parseFloat(p.spread_6h) || 0;
      const de  = parseFloat(p.de_combined) || 0;
      const imp = p.impulse_score || 0;
      const flowSign = p.dir === 'BUY' ? 1 : -1;
      const impulseAligned = !!p.impulse_aligned;
      const m15Confirms = Math.sign(v45) === flowSign && Math.abs(v45) >= 0.00008;
      const h3Confirms  = Math.sign(sp3) === flowSign;
      const h6Confirms  = Math.sign(sp6) === flowSign;
      const accelSign = Math.sign(v45 - v90) === flowSign;
      const m15State = (p.m15_state || 'FLAT').toUpperCase();
      let perfScore = 0;
      perfScore += (v45 * flowSign) * 10000 * 3;
      perfScore += (sp3 * flowSign) * 10000 * 2;
      perfScore += (sp6 * flowSign) * 10000 * 1;
      if (impulseAligned && imp >= 40) perfScore += imp * 0.5;
      else if (impulseAligned)         perfScore += imp * 0.25;
      else if (imp >= 40)              perfScore -= imp * 0.3;
      if (m15Confirms && imp >= 40)    perfScore += 20;
      else if (m15Confirms)            perfScore += 10;
      if (h3Confirms)  perfScore += 10;
      if (h6Confirms)  perfScore += 5;
      if (accelSign)   perfScore += 10;
      if (m15State === 'EXPANDING' && m15Confirms)                    perfScore += 15;
      if (m15State === 'EXPANDING' && impulseAligned && imp >= 50)    perfScore += 10;
      if (m15State === 'REVERSING')                                   perfScore -= 10;
      if (m15State === 'COMPRESSING' && !m15Confirms)                 perfScore -= 15;
      p._finalScore = (0.75 * perfScore) + (0.25 * de);
    });
    activePairs.sort((a, b) => b._finalScore - a._finalScore);

    // Reorder FP scored to match signal pairs order, keep FP details
    const fpMap = {};
    for (const fp of scored) fpMap[fp.instrument] = fp;
    scored = activePairs.map(p => fpMap[p.instrument]).filter(Boolean);
    if (!scored.length) {
      el.innerHTML = '<p class="empty-state">No energy signal pairs matched</p>';
      return;
    }
  }

  // Render ranked cards with detail rows
  const maxPerf = scored[0]?.finalScore || 1;

  const rows = scored.map((fp, idx) => {
    const cls = fp.dir === 'BUY' ? 'buy' : 'sell';
    const perfPct = Math.min(100, Math.max(0, Math.round((fp.finalScore / maxPerf) * 100)));

    // M15 state badge
    const stateLabel = fp.state ? fp.state.charAt(0) + fp.state.slice(1).toLowerCase() : '—';
    const STATE_CLS = { EXPANDING: 'fp-st-exp', COMPRESSING: 'fp-st-comp', REVERSING: 'fp-st-rev', STEADY: 'fp-st-stdy', FLAT: 'fp-st-flat' };
    const stateCls = STATE_CLS[fp.state] || 'fp-st-flat';

    // Timeframe alignment dots
    const dot = (confirms) => confirms === true ? '<span class="fp-dot green"></span>'
      : confirms === false ? '<span class="fp-dot red"></span>'
      : '<span class="fp-dot grey"></span>';

    // Build simple explanation for the user
    const explain = _fpExplain(fp);

    return `
      <div class="fp-card">
        <div class="fp-header">
          <span class="fp-rank">#${idx + 1}</span>
          <span class="spread-accent ${cls}"></span>
          <span class="spread-pair">${pair(fp.instrument)}</span>
          <span class="spread-bias ${cls}">${fp.dir}</span>
          <span class="fp-status ${fp.statusCls}">${fp.status}</span>
        </div>
        <div class="fp-bar-wrap"><div class="fp-bar-fill ${cls}" style="width:${perfPct}%"></div></div>
        <div class="fp-explain">${explain}</div>
        <div class="fp-details">
          <div class="fp-detail-row">
            <span class="fp-lbl">M15</span>
            <span class="fp-val ${fp.m15Confirms ? 'green' : fp.m15Confirms === false ? 'red' : ''}">${fp.v45 != null ? fmt(fp.v45, 5) : '—'}</span>
            <span class="fp-lbl">3H</span>
            <span class="fp-val ${fp.h3Confirms ? 'green' : fp.h3Confirms === false ? 'red' : ''}">${fp.spread3H != null ? fmt(fp.spread3H, 5) : '—'}</span>
            <span class="fp-lbl">6H</span>
            <span class="fp-val ${fp.h6Confirms ? 'green' : fp.h6Confirms === false ? 'red' : ''}">${fp.spread6H != null ? fmt(fp.spread6H, 5) : '—'}</span>
          </div>
          <div class="fp-detail-row">
            <span class="fp-lbl">State</span>
            <span class="fp-state-badge ${stateCls}">${stateLabel}</span>
            <span class="fp-lbl">Mom</span>
            <span class="fp-val ${fp.momentum === 'Impulsive' ? 'green' : ''}">${fp.momentum}</span>
            <span class="fp-lbl">Align</span>
            <span class="fp-dots">${dot(fp.m15Confirms)}${dot(fp.h3Confirms)}${dot(fp.h6Confirms)}</span>
            ${fp.deCombined > 0 ? `<span class="fp-lbl">Eff</span><span class="fp-val fp-de-${fp.deLabel.toLowerCase()}">${Math.round(fp.deCombined)}</span>` : ''}
          </div>
          ${fp.impulseScore > 0 ? `<div class="fp-detail-row fp-impulse-row">
            <span class="fp-lbl">Impulse</span>
            <span class="fp-imp-badge ${fp.impulseScore >= 60 ? 'imp-strong' : fp.impulseScore >= 40 ? 'imp-trend' : fp.impulseScore >= 20 ? 'imp-weak' : 'imp-flat'}">${fp.impulseScore >= 60 ? 'Strong' : fp.impulseScore >= 40 ? 'Trending' : fp.impulseScore >= 20 ? 'Weak' : 'Flat'} ${fp.impulseScore}</span>
            <span class="fp-imp-dir ${fp.impulseAligned ? 'green' : 'red'}">${fp.impulseAligned ? '▲ Aligned' : '▼ Counter'}</span>
          </div>` : ''}
          ${fp.volGrade ? `<div class="fp-detail-row fp-vol-row">
            <span class="fp-lbl">Vol</span>
            ${_volGradeBadge(fp.volGrade)}
            <span class="fp-lbl">RV</span>
            <span class="fp-val ${fp.volRV >= 1.5 ? 'vol-institutional' : fp.volRV >= 1.0 ? 'vol-strong' : 'vol-weak'}">${fp.volRV.toFixed(1)}x</span>
            <span class="fp-lbl">Pers</span>
            <span class="fp-val">${fp.volPers}/4</span>
            <span class="fp-lbl">Eff</span>
            <span class="fp-val ${fp.volEff >= 0.01 ? 'vol-strong' : fp.volEff >= 0.001 ? 'vol-normal' : 'vol-weak'}">${(fp.volEff * 10000).toFixed(1)} bps</span>
          </div>` : ''}
          <div class="fp-detail-row fp-ccy-row">
            <span class="fp-ccy-chip ${(fp.h3Base ?? 0) >= 0 ? 'strong' : 'weak'}">${fp.base} ${fmt(fp.h3Base ?? 0, 5)}</span>
            <span class="fp-ccy-vs">vs</span>
            <span class="fp-ccy-chip ${(fp.h3Quote ?? 0) <= 0 ? 'weak' : 'strong'}">${fp.quote} ${fmt(fp.h3Quote ?? 0, 5)}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = rows;
}

// ─── M15 Pair Ranking ─────────────────────────────────────────────────────────

// Energy pair set — built once per refresh from cached energy signal pairs
function _energyPairSet() {
  if (!_energySignalsCache?.pairs?.length) return null;
  return new Set(_energySignalsCache.pairs.filter(p => p.active).map(p => p.instrument));
}

// Map instrument → signal dir (BUY/SELL) from energy pairs
function _energyPairDirMap() {
  if (!_energySignalsCache?.pairs?.length) return {};
  const m = {};
  for (const p of _energySignalsCache.pairs) {
    if (p.active) m[p.instrument] = p.dir;
  }
  return m;
}

// Notification bar filter — only energy signal pairs with impulse_score ≥ 30
// AND all TFs same sign AND M15 direction matches signal flow. Sorted by impulse quality.
function getM15Impulses(data) {
  const epSet = _energyPairSet();
  const dirMap = _energyPairDirMap();
  return (data?.spreads || [])
    .filter(s => {
      if (epSet && !epSet.has(s.instrument)) return false; // must be an energy signal pair
      if (s.state === 'FLAT' || s.state === 'REVERSING') return false;
      const s45  = parseFloat(s.smooth_45m)  || 0;
      const s90  = parseFloat(s.smooth_90m)  || 0;
      const s180 = parseFloat(s.smooth_180m) || 0;
      if (Math.sign(s45) !== Math.sign(s90))  return false;
      if (Math.sign(s45) !== Math.sign(s180)) return false;
      if (Math.abs(s45) < CS_THRESHOLD) return false;
      if ((s.impulse_score || 0) < 30) return false;
      // M15 must move WITH the signal direction, not against it
      const signalDir = dirMap[s.instrument];
      if (signalDir) {
        const flowSign = signalDir === 'BUY' ? 1 : -1;
        if (Math.sign(s45) !== flowSign) return false;
      }
      return true;
    })
    .sort((a, b) => (b.impulse_score || 0) - (a.impulse_score || 0));
}

// Card filter — only energy signal pairs with active M15 states (not FLAT)
// Sorted by impulse_score (actual price action quality).
function getM15AllActive(data) {
  const epSet = _energyPairSet();
  return (data?.spreads || [])
    .filter(s => {
      if (epSet && !epSet.has(s.instrument)) return false;
      return s.state !== 'FLAT' && Math.abs(parseFloat(s.smooth_45m) || 0) >= CS_THRESHOLD;
    })
    .sort((a, b) => (b.impulse_score || 0) - (a.impulse_score || 0));
}

// Impulse quality label from impulse_score (0-100)
function impulseLabel(score) {
  if (score >= 60) return { text: 'Impulsive', cls: 'imp-strong' };
  if (score >= 40) return { text: 'Trending',  cls: 'imp-trend' };
  if (score >= 20) return { text: 'Weak',      cls: 'imp-weak' };
  return                   { text: 'Flat',      cls: 'imp-flat' };
}

/**
 * Generate plain-English analysis for an M15 Impulse Move.
 * Covers: spread pressure (45/90/180), state, impulse quality, velocity,
 * body ratio, consecutive run, and full volume analysis.
 */
function _m15ImpulseAnalysis(s, d) {
  const parts = [];
  const dirWord = d.bias === 'BUY' ? 'bullish' : 'bearish';
  const [base, quote] = s.instrument.split('_');

  // ── 1. Spread pressure across timeframes ─────────────────────────────
  const sign45  = Math.sign(d.v45);
  const sign90  = Math.sign(d.v90);
  const sign180 = Math.sign(d.v180);
  if (sign45 === sign90 && sign90 === sign180)
    parts.push(`All timeframes (45M/90M/180M) confirm ${dirWord} pressure — full alignment.`);
  else if (sign45 === sign90)
    parts.push(`45M and 90M aligned ${dirWord}, but 180M diverges — shorter-term move.`);
  else if (sign45 !== sign90)
    parts.push(`45M and 90M disagree — mixed pressure, be cautious.`);

  // ── 2. State ─────────────────────────────────────────────────────────
  const state = s.state || '';
  if (state === 'EXPANDING')        parts.push('Spread expanding — divergence growing, pressure building.');
  else if (state === 'COMPRESSING') parts.push('Spread compressing — currencies converging, move may be slowing.');
  else if (state === 'REVERSING')   parts.push('Spread reversing — short-term direction flipping.');
  else if (state === 'STEADY')      parts.push('Spread steady — stable pace, no acceleration or deceleration.');
  else if (state === 'FLAT')        parts.push('Spread flat — no meaningful movement.');

  // ── 3. Impulse quality ───────────────────────────────────────────────
  if (d.imp >= 60)      parts.push(`Strong impulse (${d.imp}/100) — high-conviction directional candles.`);
  else if (d.imp >= 40) parts.push(`Trending impulse (${d.imp}/100) — decent candle quality, moderate conviction.`);
  else if (d.imp >= 20) parts.push(`Weak impulse (${d.imp}/100) — candles lack conviction, move is fragile.`);
  else                  parts.push(`Flat impulse (${d.imp}/100) — no real directional drive in candles.`);

  // ── 4. Velocity ──────────────────────────────────────────────────────
  if (d.vel >= 2.0)      parts.push(`Velocity ${d.vel.toFixed(1)}× — current candle much larger than average. Fast move.`);
  else if (d.vel >= 1.2) parts.push(`Velocity ${d.vel.toFixed(1)}× — above-average candle size. Moderate pace.`);
  else if (d.vel >= 0.8) parts.push(`Velocity ${d.vel.toFixed(1)}× — normal candle size. Average pace.`);
  else                   parts.push(`Velocity ${d.vel.toFixed(1)}× — small candles. Slow, low-energy move.`);

  // ── 5. Body ratio ────────────────────────────────────────────────────
  const bodyPct = Math.round(d.body * 100);
  if (d.body >= 0.70)      parts.push(`Body ${bodyPct}% — candles are mostly body, very little wick. Clean directional.`);
  else if (d.body >= 0.50) parts.push(`Body ${bodyPct}% — more body than wick. Decent directional candles.`);
  else if (d.body >= 0.30) parts.push(`Body ${bodyPct}% — significant wicks. Indecision and rejection present.`);
  else                     parts.push(`Body ${bodyPct}% — mostly wicks. Price is being rejected, low conviction.`);

  // ── 6. Consecutive directional run ───────────────────────────────────
  if (d.cons >= 4)      parts.push(`${d.cons} consecutive candles in same direction — strong sustained run, watch for exhaustion.`);
  else if (d.cons >= 3) parts.push(`${d.cons} consecutive candles — good directional persistence.`);
  else if (d.cons >= 2) parts.push(`${d.cons} consecutive candles — early directional build.`);
  else                  parts.push(`Only ${d.cons} candle in direction — too early to confirm trend.`);

  // ── 7. Volume analysis ───────────────────────────────────────────────
  if (d.volGrade) {
    const gradeDesc = {
      INSTITUTIONAL: 'Institutional-grade volume — 24% strong-move rate, highest conviction.',
      STRONG:        'Strong volume — 12% strong-move rate, good participation.',
      NORMAL:        'Normal volume — acceptable, needs candle quality to confirm.',
      WEAK:          'Weak volume — present but not driving price.',
      DEAD:          'Dead volume — no participation behind this move.',
    };
    parts.push(gradeDesc[d.volGrade] || `Volume: ${d.volGrade}.`);

    const effBps = (d.volEff * 10000).toFixed(1);
    if (d.volEff >= 0.01)        parts.push(`Vol efficiency ${effBps} bps — institutional signature, volume driving price efficiently.`);
    else if (d.volEff >= 0.001)  parts.push(`Vol efficiency ${effBps} bps — good, volume converting to price movement.`);
    else if (d.volEff >= 0.0002) parts.push(`Vol efficiency ${effBps} bps — some conversion but not conviction-level.`);
    else if (d.volEff > 0)       parts.push(`Vol efficiency ${effBps} bps — low, volume mostly absorbed.`);
    else                          parts.push(`Vol efficiency near 0 — volume absorbed without price progress.`);

    if (d.rv >= 2.0)       parts.push(`RV ${d.rv.toFixed(1)}× — volume spike above session average.`);
    else if (d.rv >= 1.5)  parts.push(`RV ${d.rv.toFixed(1)}× — above average, no proven edge below 2.0×.`);
    else if (d.rv < 0.5)   parts.push(`RV ${d.rv.toFixed(1)}× — very low volume, market quiet.`);

    if (d.volPers >= 3)       parts.push(`Volume sustained ${d.volPers} candles — watch for exhaustion.`);
    else if (d.volPers >= 1)  parts.push(`Volume elevated ${d.volPers} candle(s) — participation building.`);
  }

  // ── 8. Overall verdict ───────────────────────────────────────────────
  const allAligned = sign45 === sign90 && sign90 === sign180;
  const strongImp  = d.imp >= 50;
  const cleanBody  = d.body >= 0.50;
  const goodVel    = d.vel >= 1.2;
  const goodEff    = d.volEff >= 0.001;
  const instVol    = d.volGrade === 'INSTITUTIONAL' || d.volGrade === 'STRONG';
  const deadVol    = d.volGrade === 'DEAD' || d.rv < 0.5;

  if (allAligned && strongImp && cleanBody && goodEff)
    parts.push('⟶ HIGH CONVICTION — aligned pressure, strong impulse, clean candles, efficient volume.');
  else if (allAligned && strongImp && cleanBody)
    parts.push('⟶ STRONG MOVE — aligned with good impulse and body ratio. Volume ordinary.');
  else if (allAligned && strongImp && instVol)
    parts.push('⟶ STRONG MOVE — aligned impulse backed by institutional volume.');
  else if (allAligned && strongImp)
    parts.push('⟶ GOOD IMPULSE — aligned pressure with decent impulse. Watch candle quality.');
  else if (allAligned && deadVol)
    parts.push('⟶ LOW QUALITY — aligned but dead volume. Move lacks participation.');
  else if (allAligned)
    parts.push('⟶ ALIGNED — all timeframes agree but impulse/candle quality is modest.');
  else if (strongImp && goodEff && state === 'EXPANDING')
    parts.push('⟶ EXPANDING — strong impulse with volume, but timeframes not fully aligned. Fast move.');
  else if (state === 'COMPRESSING')
    parts.push('⟶ FADING — pressure compressing. Move may be exhausting.');
  else if (state === 'REVERSING')
    parts.push('⟶ CAUTION — spread reversing. Wait for re-alignment.');
  else
    parts.push('⟶ MIXED — conditions don\'t fully confirm. Reduce size or wait.');

  return parts.join(' ');
}

function renderM15Spreads(data) {
  const el = document.getElementById('m15-spreads-list');
  const section = document.getElementById('section-m15-spreads');
  if (!el) return;

  // Only show the card when impulses qualify for the notification bar.
  // If nothing on the bar → hide the entire section.
  const impulses = getM15Impulses(data);
  if (!impulses.length) {
    if (section) section.style.display = 'none';
    return;
  }
  if (section) section.style.display = '';

  const spreads = impulses;

  const maxImp = spreads[0]?.impulse_score || 1;

  const dirMap = _energyPairDirMap();
  el.innerHTML = spreads.map(s => {
    const v45  = parseFloat(s.smooth_45m) || 0;
    const v90  = parseFloat(s.smooth_90m) || 0;
    const v180 = parseFloat(s.smooth_180m) || 0;
    // Use signal pair direction, fall back to v45 sign
    const signalDir = dirMap[s.instrument];
    const bias = signalDir || (v45 >= 0 ? 'BUY' : 'SELL');
    const cls  = bias === 'BUY' ? 'buy' : 'sell';
    const imp  = s.impulse_score || 0;
    const pct  = Math.round((imp / maxImp) * 100);
    const il   = impulseLabel(imp);
    const vel  = s.velocity || 0;
    const body = s.body_ratio || 0;
    const cons = s.consec_dir || 0;
    // Volume analysis
    const vol = _volDataCache[s.instrument];
    const rv  = vol ? parseFloat(vol.relative_volume) || 0 : 0;
    const volGrade = vol?.participation_grade || '';
    const volScore = vol ? Math.round(parseFloat(vol.participation_score) || 0) : 0;
    const volEff   = vol ? parseFloat(vol.volume_efficiency) || 0 : 0;
    const volPers  = vol ? parseFloat(vol.volume_persistence) || 0 : 0;

    // Build analysis text
    const analysis = _m15ImpulseAnalysis(s, { v45, v90, v180, imp, vel, body, cons, rv, volGrade, volScore, volEff, volPers, bias, il });

    return `
      <div class="spread-row m15-row">
        <div class="spread-accent ${cls}"></div>
        <span class="spread-pair">${pair(s.instrument)}</span>
        <span class="spread-bias ${cls}">${bias}</span>
        <span class="sb-behavior ${s.state}">${clean(s.state || '')}</span>
        <span class="m15-imp-badge ${il.cls}">${il.text}</span>
        <div class="m15-val-bar">
          <span class="spread-val">${fmt(v45, 5)}</span>
          <div class="spread-bar-wrap"><div class="spread-bar-fill ${cls}" style="width:${pct}%"></div></div>
        </div>
      </div>
      <div class="m15-imp-detail">
        <span class="m15-imp-lbl">Vel</span><span class="m15-imp-val">${vel.toFixed(1)}×</span>
        <span class="m15-imp-lbl">Body</span><span class="m15-imp-val">${Math.round(body * 100)}%</span>
        <span class="m15-imp-lbl">Run</span><span class="m15-imp-val">${cons}/4</span>
        <span class="m15-imp-lbl">Score</span><span class="m15-imp-val ${il.cls}">${imp}</span>
        ${vol ? `<span class="m15-vol-sep">│</span>
        <span class="m15-imp-lbl">RV</span><span class="m15-imp-val ${rv >= 1.5 ? 'vol-institutional' : rv >= 1.0 ? 'vol-strong' : 'vol-weak'}">${rv.toFixed(1)}×</span>
        <span class="m15-imp-lbl">Eff</span><span class="m15-imp-val ${volEff >= 0.01 ? 'vol-strong' : volEff >= 0.001 ? 'vol-normal' : 'vol-weak'}">${(volEff * 10000).toFixed(1)} bps</span>
        ${_volGradeBadge(volGrade)}` : ''}
      </div>
      <div class="fp-explain m15-explain">${analysis}</div>`;
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

  // M15 bar only shows when Engine Confluence is active
  if (!_v2Confluence.fired) {
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

  const barDirMap = _energyPairDirMap();
  document.getElementById('m15-bar-chips').innerHTML = visible.map(s => {
    const v45  = parseFloat(s.smooth_45m) || 0;
    const signalDir = barDirMap[s.instrument];
    const bias = signalDir || (v45 >= 0 ? 'BUY' : 'SELL');
    const dir  = bias === 'BUY' ? 'buy' : 'sell';
    const imp  = s.impulse_score || 0;
    const il   = impulseLabel(imp);
    const stateLabel = s.state === 'COMPRESSING' ? ' ▾' : ' ▲';
    return `<span class="m15-bar-chip">
      <span class="chip-pair">${pair(s.instrument)}</span>
      <span class="chip-${dir}">${bias}${stateLabel}</span>
      <span class="m15-imp-badge ${il.cls}">${il.text} ${imp}</span>
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
  _updateAlertBadge();
}

// ─── V2 Environment Gate ─────────────────────────────────────────────────────
// Gate trades using 3 market environment classifications from the hourly data.
// Each environment type has favorable values that allow trading.

const V2_ENV_FAVORABLE = {
  energy_cycle:    new Set(['EXPANSION', 'EXPLOSIVE', 'ACTIVE_EXPANSION', 'CHAOTIC_EXPANSION', 'TRANSITION', 'EXHAUSTION']),
  volatility_type: new Set(['HEALTHY', 'NORMAL', 'EVENT']),
  momentum_type:   new Set(['IMPULSE', 'EXPANSION', 'TREND', 'STABLE', 'EXHAUSTION']),
};
// Hybrid override: LOW_PARTICIPATION passes cycle check when tradability ≥ this
const V2_LOWP_TRAD_THRESHOLD = 35;

const V2_ENV_LABELS = {
  energy_cycle:    'Cycle',
  volatility_type: 'VolTyp',
  momentum_type:   'MomTyp',
};

const V2_ENV_SHORT = {
  // Cycle
  EXPLOSIVE: 'Explo', EXPANSION: 'Expan', ACTIVE_EXPANSION: 'Expan', CHAOTIC_EXPANSION: 'Expan',
  TRANSITION: 'Trans', COMPRESSION: 'Compr', EXHAUSTION: 'Exhst', LOW_PARTICIPATION: 'LowP', DEAD: 'Dead',
  // VolTyp
  HEALTHY: 'Hlthy', NORMAL: 'Norm', CHAOTIC: 'Chaos', EVENT: 'Event',
  // MomTyp
  IMPULSE: 'Impls', TREND: 'Trend', STABLE: 'Stble', DECAY: 'Decay',
};

const V2_ENV_COLOR = {
  EXPLOSIVE: '#f59e0b', EXPANSION: '#22c55e', ACTIVE_EXPANSION: '#22c55e', CHAOTIC_EXPANSION: '#f97316',
  TRANSITION: '#0ea5e9', COMPRESSION: '#ef4444', EXHAUSTION: '#f97316', LOW_PARTICIPATION: '#64748b', DEAD: '#334155',
  HEALTHY: '#22c55e', NORMAL: '#94a3b8', CHAOTIC: '#ef4444', EVENT: '#f59e0b',
  IMPULSE: '#f59e0b', TREND: '#0ea5e9', STABLE: '#64748b', DECAY: '#f97316',
};

// Environment quality scores — higher = better conditions
const V2_ENV_SCORE = {
  // Cycle
  EXPLOSIVE: 3, ACTIVE_EXPANSION: 3, CHAOTIC_EXPANSION: 3,
  EXPANSION: 2,
  TRANSITION: 1,
  EXHAUSTION: 1,
  LOW_PARTICIPATION: 1, // only when tradability override fires
  // VolTyp
  HEALTHY: 3,
  EVENT: 2,
  NORMAL: 1,
  // MomTyp
  IMPULSE: 3,
  EXPANSION: 2,
  TREND: 1,
  STABLE: 1,
  // EXHAUSTION (momentum) — scored 1 (still high movement, just decelerating)
};

// Total 3–9: 7–9 = Prime, 5–6 = Good, 3–4 = Acceptable
const V2_ENV_GRADES = [
  { min: 7, label: 'Prime',      icon: '🟢', color: '#22c55e', desc: 'Optimal conditions — highest conviction setups' },
  { min: 5, label: 'Good',       icon: '🟡', color: '#eab308', desc: 'Solid conditions — good for directional trades' },
  { min: 0, label: 'Acceptable', icon: '🟠', color: '#f97316', desc: 'Marginal conditions — be selective, smaller size' },
];

function getEnvGrade(score) {
  return V2_ENV_GRADES.find(g => score >= g.min) || V2_ENV_GRADES[V2_ENV_GRADES.length - 1];
}

// Global confluence state — drives section gating
let _v2Confluence = { fired: false, passed: 0, total: 3, pct: 0, results: [], score: 0, grade: null };

// Sections gated behind Engine Confluence
const V2_GATED_SECTIONS = [
  'section-states',       // Full Market Scanner
  'section-risk',         // Approved Trades
  'section-m15-spreads',  // M15 Impulse Detection
  'section-live',         // Live Opportunities
  'section-top',          // Top Setups
  'section-signals',      // Trade Watchlist
];

function applyV2Gate() {
  const active = _v2Confluence.fired;
  for (const id of V2_GATED_SECTIONS) {
    const section = document.getElementById(id);
    if (!section) continue;

    let overlay = section.querySelector('.v2-gate-overlay');
    if (!active) {
      // Build environment chips HTML
      const chipsHtml = _v2Confluence.results.map(r => {
        const color = V2_ENV_COLOR[r.value] || '#64748b';
        const cls = r.pass ? 'v2g-chip v2g-pass' : 'v2g-chip v2g-fail';
        return `<span class="${cls}"><span class="v2g-lbl">${r.label}</span> <span style="color:${color}">${r.short}</span></span>`;
      }).join('');

      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'v2-gate-overlay';
        section.style.position = 'relative';
        section.appendChild(overlay);
      }
      overlay.innerHTML = `
        <span class="v2-gate-icon">⏸</span>
        <span class="v2-gate-title">Environment Not Favorable</span>
        <span class="v2-gate-desc">Market environment does not support high-probability trades right now. Waiting for favorable Cycle, Volatility & Momentum conditions.</span>
        <span class="v2-gate-chips">${chipsHtml}</span>`;
      overlay.classList.add('visible');
    } else {
      if (overlay) overlay.classList.remove('visible');
    }
  }
}

function evaluateV2Thresholds(hourlyRow) {
  if (!hourlyRow) return null;
  const results = [];
  let score = 0;

  for (const [field, favorable] of Object.entries(V2_ENV_FAVORABLE)) {
    const value = hourlyRow[field] || '';
    let pass = favorable.has(value);

    // Hybrid override: LOW_PARTICIPATION passes cycle check when tradability is decent
    if (!pass && field === 'energy_cycle' && value === 'LOW_PARTICIPATION') {
      const trad = parseFloat(hourlyRow.tradability_score) || 0;
      if (trad >= V2_LOWP_TRAD_THRESHOLD) pass = true;
    }

    const pts = pass ? (V2_ENV_SCORE[value] || 1) : 0;
    score += pts;
    results.push({
      key: field,
      label: V2_ENV_LABELS[field],
      value,
      short: V2_ENV_SHORT[value] || value.slice(0, 5) || '—',
      pass,
      score: pts,
    });
  }

  const passed = results.filter(r => r.pass).length;
  const total  = results.length;
  const pct    = total > 0 ? passed / total : 0;
  const fired  = passed === total;
  const grade  = fired ? getEnvGrade(score) : null;

  return { results, passed, total, pct, fired, score, grade };
}

function updateV2ThresholdBar(hourlyRows) {
  const bar = document.getElementById('v2-threshold-bar');

  // Evaluate latest hourly data for confluence state
  const SKIP = new Set(['LOW_LIQUIDITY', 'DEAD_HOURS']);
  const valid = (hourlyRows || []).filter(r => !SKIP.has(r.session_name));
  const latest = valid.length ? valid[valid.length - 1] : null;
  const eval_ = latest ? evaluateV2Thresholds(latest) : null;

  // Always update global confluence state (drives section gating)
  if (eval_) {
    _v2Confluence = eval_;
  } else {
    _v2Confluence = { fired: false, passed: 0, total: 3, pct: 0, results: [], score: 0, grade: null };
  }
  applyV2Gate();

  // Bar display — Pro+ only
  if (!bar) return;
  if (document.body.classList.contains('plan-free')) {
    bar.style.display = 'none';
    return;
  }

  if (!eval_ || !eval_.fired) {
    bar.style.display = 'none';
    return;
  }

  bar.className = 'v2-thresh-bar pro-only v2t--strong';

  // Score badge — show grade
  const grade = eval_.grade;
  const scoreEl = document.getElementById('v2t-score');
  if (scoreEl) scoreEl.innerHTML = `<span style="color:${grade.color}">${grade.icon} ${grade.label}</span> <span style="opacity:0.5;font-size:10px">${eval_.score}/9</span>`;

  // Chips — show environment classifications
  const chipsEl = document.getElementById('v2t-chips');
  if (chipsEl) {
    chipsEl.innerHTML = eval_.results.map(r => {
      const color = V2_ENV_COLOR[r.value] || '#64748b';
      return `<span class="v2t-chip v2tc-pass" title="${r.label}: ${r.value}">
        <span class="v2tc-name">${r.label}</span>
        <span class="v2tc-val" style="color:${color}">${r.short}</span>
      </span>`;
    }).join('');
  }

  // Time
  const timeEl = document.getElementById('v2t-time');
  if (timeEl && latest.time_utc) timeEl.textContent = fmtTime(latest.time_utc);

  bar.style.display = 'flex';
  _updateAlertBadge();
}

// ─── Risk / approved trades ───────────────────────────────────────────────────

function renderRisk(data) {
  if (!data) return;
  const el       = document.getElementById('risk-list');
  if (!el) return;
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

// ─── Energy Signals Tab ──────────────────────────────────────────────────────

// Background refresh for energy signals — retries on empty data + periodic updates
let _energyRefreshTimer = null;
let _energyRetryCount = 0;
const ENERGY_RETRY_MAX = 5;
const ENERGY_RETRY_MS = 5000;    // 5s between retries when data is empty
const ENERGY_POLL_MS  = 30000;   // 30s periodic background refresh

async function _energyRefreshTick() {
  try {
    const fresh = await api('/api/energy-signals').catch(() => null);
    if (!fresh) return;
    _energySignalsCache = fresh;
    renderEnergySignals(fresh);
    // Also re-render flow performance since it depends on energy pairs
    renderFlowPerformance(null, _m15DataCache);
    hydrateIcons();

    const hasData = (fresh.currencies?.length > 0) || (fresh.pairs?.length > 0) || (fresh.energy > 0);
    if (!hasData && _energyRetryCount < ENERGY_RETRY_MAX) {
      // Still empty — keep retrying at fast interval
      _energyRetryCount++;
      _energyRefreshTimer = setTimeout(_energyRefreshTick, ENERGY_RETRY_MS);
    } else {
      // Data arrived or retries exhausted — switch to periodic polling
      _energyRetryCount = 0;
      _energyRefreshTimer = setTimeout(_energyRefreshTick, ENERGY_POLL_MS);
    }
  } catch (_) {
    // On error, retry after poll interval
    _energyRefreshTimer = setTimeout(_energyRefreshTick, ENERGY_POLL_MS);
  }
}

function _scheduleEnergyRefresh(initialData) {
  // Clear any existing timer
  if (_energyRefreshTimer) { clearTimeout(_energyRefreshTimer); _energyRefreshTimer = null; }
  _energyRetryCount = 0;

  const hasData = (initialData?.currencies?.length > 0) || (initialData?.pairs?.length > 0) || (initialData?.energy > 0);
  if (!hasData) {
    // Empty on first load — start fast retries
    _energyRefreshTimer = setTimeout(_energyRefreshTick, ENERGY_RETRY_MS);
  } else {
    // Data present — just poll periodically to keep it fresh
    _energyRefreshTimer = setTimeout(_energyRefreshTick, ENERGY_POLL_MS);
  }
}

function renderEnergySignals(data) {
  if (!data) return;
  const { currencies, pairs, energy, thresholdMet } = data;

  // ── Banner ──
  const ringEl = document.getElementById('es-energy-ring');
  const numEl = document.getElementById('es-energy-num');
  const statusEl = document.getElementById('es-banner-status');
  const rightEl = document.getElementById('es-banner-right');

  if (ringEl && numEl) {
    const pct = Math.min(100, Math.max(0, energy));
    const col = energy >= 60 ? '#22c55e' : energy >= 50 ? '#3b82f6' : energy >= 35 ? '#f59e0b' : '#475569';
    ringEl.style.setProperty('--es-ring-color', col);
    ringEl.style.setProperty('--es-ring-pct', pct + '%');
    numEl.textContent = Math.round(energy);
    numEl.style.color = col;
  }

  if (statusEl) {
    if (thresholdMet) {
      statusEl.innerHTML = `<span style="color:#22c55e;font-weight:700">ACTIVE</span> — Directions confirmed.`;
    } else if (energy >= 35) {
      statusEl.innerHTML = `<span style="color:#f59e0b;font-weight:700">BUILDING</span> — Approaching threshold.`;
    } else {
      statusEl.innerHTML = `<span style="color:#94a3b8;font-weight:700">LOW</span> — Existing directions persist.`;
    }
  }

  // Event chips in banner
  if (rightEl) {
    const events = new Set();
    for (const p of (pairs || [])) {
      if (p.new_energy_event && p.energy_event_type) events.add(p.energy_event_type);
    }
    let chips = '';
    if (events.has('CONTINUATION')) chips += '<span class="es-event-chip continuation">Continuation</span>';
    if (events.has('REVERSAL'))     chips += '<span class="es-event-chip reversal">Reversal</span>';
    if (events.has('NEW'))          chips += '<span class="es-event-chip new-event">New Signal</span>';
    if (!thresholdMet && !pairs?.length) chips += '<span class="es-event-chip below">Below Threshold</span>';
    rightEl.innerHTML = chips;
  }

  // ── Currencies ──
  const ccyEl = document.getElementById('es-currencies');
  if (ccyEl) {
    const active = (currencies || []).filter(c => c.active && c.direction !== 'NEUTRAL');
    const strong = active.filter(c => c.direction === 'STRONG').sort((a,b) => (b.smooth_3h||0) - (a.smooth_3h||0));
    const weak   = active.filter(c => c.direction === 'WEAK').sort((a,b) => (a.smooth_3h||0) - (b.smooth_3h||0));

    if (!strong.length && !weak.length) {
      ccyEl.innerHTML = '<div class="es-no-data">No confirmed currency directions. Energy threshold not yet met or no aligned currencies.</div>';
    } else {
      const renderCol = (items, cls, title) => {
        if (!items.length) return '';
        const rows = items.map(c => {
          const h3 = parseFloat(c.smooth_3h) || 0;
          const h6 = parseFloat(c.smooth_6h) || 0;
          const h3Cls = h3 > 0 ? 'pos' : h3 < 0 ? 'neg' : '';
          const h6Cls = h6 > 0 ? 'pos' : h6 < 0 ? 'neg' : '';
          let eventHtml = '';
          if (c.energy_event_type) {
            const evCls = c.energy_event_type === 'CONTINUATION' ? 'continuation' : c.energy_event_type === 'REVERSAL' ? 'reversal' : c.energy_event_type === 'DROPPED' ? 'reversal' : 'new-event';
            eventHtml = `<span class="es-ccy-event ${evCls}">${c.energy_event_type}</span>`;
          }
          return `<div class="es-ccy-row">
            <span class="es-ccy-name">${c.currency}</span>
            <div class="es-ccy-vals">
              <span class="es-ccy-val ${h3Cls}" title="3H">${(h3*10000).toFixed(1)}</span>
              <span class="es-ccy-val ${h6Cls}" title="6H">${(h6*10000).toFixed(1)}</span>
              ${eventHtml}
            </div>
          </div>`;
        }).join('');
        return `<div class="es-ccy-col ${cls}">
          <div class="es-ccy-col-title">${title}</div>
          ${rows}
        </div>`;
      };
      ccyEl.innerHTML = renderCol(strong, 'strong', 'Strong') + renderCol(weak, 'weak', 'Weak');
    }
  }

  // ── Signal Pairs ──
  const pairsEl = document.getElementById('es-pairs');
  if (pairsEl) {
    const activePairs = (pairs || []).filter(p => p.active);

    if (!activePairs.length) {
      pairsEl.innerHTML = '<div class="es-no-data">No active signal pairs. Energy threshold must be met with aligned currencies.</div>';
    } else {
      // Sort using same scoring as Flow Performance:
      // perfScore = directional V45 × 3 + 3H × 2 + 6H × 1 + impulse + alignment bonuses
      // finalScore = 0.75 × perfScore + 0.25 × DE
      activePairs.forEach(p => {
        const v45 = parseFloat(p.v45) || 0;
        const v90 = parseFloat(p.v90) || 0;
        const sp3 = parseFloat(p.spread_3h) || 0;
        const sp6 = parseFloat(p.spread_6h) || 0;
        const de  = parseFloat(p.de_combined) || 0;
        const imp = p.impulse_score || 0;
        const flowSign = p.dir === 'BUY' ? 1 : -1;
        const impulseAligned = !!p.impulse_aligned;
        const m15Confirms = Math.sign(v45) === flowSign && Math.abs(v45) >= 0.00008;
        const h3Confirms  = Math.sign(sp3) === flowSign;
        const h6Confirms  = Math.sign(sp6) === flowSign;
        const accel = v45 - v90;
        const accelSign = Math.sign(accel) === flowSign;
        const m15State = (p.m15_state || 'FLAT').toUpperCase();

        let perfScore = 0;
        perfScore += (v45 * flowSign) * 10000 * 3;
        perfScore += (sp3 * flowSign) * 10000 * 2;
        perfScore += (sp6 * flowSign) * 10000 * 1;
        if (impulseAligned && imp >= 40) perfScore += imp * 0.5;
        else if (impulseAligned)         perfScore += imp * 0.25;
        else if (imp >= 40)              perfScore -= imp * 0.3;
        if (m15Confirms && imp >= 40)    perfScore += 20;
        else if (m15Confirms)            perfScore += 10;
        if (h3Confirms)  perfScore += 10;
        if (h6Confirms)  perfScore += 5;
        if (accelSign)   perfScore += 10;
        if (m15State === 'EXPANDING' && m15Confirms)                    perfScore += 15;
        if (m15State === 'EXPANDING' && impulseAligned && imp >= 50)    perfScore += 10;
        if (m15State === 'REVERSING')                                   perfScore -= 10;
        if (m15State === 'COMPRESSING' && !m15Confirms)                 perfScore -= 15;

        p._finalScore = (0.75 * perfScore) + (0.25 * de);
      });
      activePairs.sort((a, b) => b._finalScore - a._finalScore);

      pairsEl.innerHTML = activePairs.map(p => {
        const pairLabel = p.instrument.replace('_', '/');
        const dirCls = p.dir === 'BUY' ? 'buy' : 'sell';
        const rawPhase = mapPhase(p.phase || 'MONITORING');
        const phaseCls = rawPhase.toLowerCase();
        const v45 = parseFloat(p.v45) || 0;
        const v90 = parseFloat(p.v90) || 0;
        const de = parseFloat(p.de_combined) || 0;
        const imp = p.impulse_score || 0;
        const sp3 = parseFloat(p.spread_3h) || 0;
        const sp6 = parseFloat(p.spread_6h) || 0;
        const m15State = (p.m15_state || 'FLAT').toLowerCase();

        // Energy event badge
        let eventHtml = '';
        if (p.new_energy_event && p.energy_event_type) {
          const evCls = p.energy_event_type === 'CONTINUATION' ? 'continuation' : 'reversal';
          const evIcon = p.energy_event_type === 'CONTINUATION' ? '↗' : '↻';
          eventHtml = `<div class="es-pair-event ${evCls}">${evIcon} Energy ${p.energy_event_type}</div>`;
        }

        return `<div class="es-pair-card phase-${phaseCls}" onclick="openPairAnalysis('${p.instrument}')" style="cursor:pointer">
          <div class="es-pair-head">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="es-pair-name">${pairLabel}</span>
              <span class="es-pair-dir ${dirCls}">${p.dir}</span>
            </div>
            <span class="es-pair-phase ${phaseCls}">${rawPhase}</span>
          </div>
          <div class="es-pair-m15">
            <span class="es-m15-state ${m15State}">M15: ${(p.m15_state || 'FLAT')}</span>
            <span style="font-size:10px;color:var(--muted)">${p.strong_ccy} vs ${p.weak_ccy}</span>
          </div>
          <div class="es-pair-metrics">
            <div class="es-metric">
              <div class="es-metric-label">V45</div>
              <div class="es-metric-val" style="color:${v45 > 0 ? '#4ade80' : v45 < 0 ? '#f87171' : '#94a3b8'}">${(v45*10000).toFixed(1)}</div>
            </div>
            <div class="es-metric">
              <div class="es-metric-label">3H</div>
              <div class="es-metric-val" style="color:${sp3 > 0 ? '#4ade80' : sp3 < 0 ? '#f87171' : '#94a3b8'}">${(sp3*10000).toFixed(1)}</div>
            </div>
            <div class="es-metric">
              <div class="es-metric-label">DE</div>
              <div class="es-metric-val" style="color:${de >= 40 ? '#4ade80' : de >= 20 ? '#f59e0b' : '#94a3b8'}">${Math.round(de)}</div>
            </div>
            <div class="es-metric">
              <div class="es-metric-label">V90</div>
              <div class="es-metric-val" style="color:${v90 > 0 ? '#4ade80' : v90 < 0 ? '#f87171' : '#94a3b8'}">${(v90*10000).toFixed(1)}</div>
            </div>
            <div class="es-metric">
              <div class="es-metric-label">6H</div>
              <div class="es-metric-val" style="color:${sp6 > 0 ? '#4ade80' : sp6 < 0 ? '#f87171' : '#94a3b8'}">${(sp6*10000).toFixed(1)}</div>
            </div>
            <div class="es-metric">
              <div class="es-metric-label">Impulse</div>
              <div class="es-metric-val" style="color:${imp >= 50 ? '#4ade80' : imp >= 30 ? '#f59e0b' : '#94a3b8'}">${Math.round(imp)}${p.impulse_aligned ? '✓' : ''}</div>
            </div>
          </div>
          ${eventHtml}
          <div style="margin-top:8px;text-align:right" class="plan-premium-only"><span class="es-pair-open-btn">View Analysis →</span></div>
        </div>`;
      }).join('');
    }
  }

  hydrateIcons();
}

// ─── Pair Analysis Modal ─────────────────────────────────────────────────────

let _paChart = null; // candlestick chart instance

function closePairAnalysis() {
  document.getElementById('pair-analysis-overlay').style.display = 'none';
  if (_paChart) { _paChart.destroy(); _paChart = null; }
  if (_paVolChart) { _paVolChart.destroy(); _paVolChart = null; }
  window._paCandles = null;
}

// Close on overlay click (not inner card)
document.getElementById('pair-analysis-overlay')?.addEventListener('click', function(e) {
  if (e.target === this) closePairAnalysis();
});

async function openPairAnalysis(instrument) {
  // Premium only — don't open for free/pro
  const plan = localStorage.getItem('nfx_plan') || 'free';
  if (plan !== 'premium') return;

  const overlay = document.getElementById('pair-analysis-overlay');
  const body    = document.getElementById('pa-body');
  const hdr     = document.getElementById('pa-pair');
  const sub     = document.getElementById('pa-sub');
  if (!overlay || !body) return;

  // Find cached pair data
  const cachedPair = (_energySignalsCache?.pairs || []).find(p => p.instrument === instrument && p.active);
  const pairLabel = instrument.replace('_', '/');
  const dirCls = cachedPair?.dir === 'BUY' ? '#4ade80' : '#f87171';

  hdr.innerHTML = `<span style="color:${dirCls}">${cachedPair?.dir || ''}</span> ${pairLabel}`;
  sub.textContent = cachedPair ? `${cachedPair.strong_ccy} strong / ${cachedPair.weak_ccy} weak · Phase: ${mapPhase(cachedPair.phase || 'MONITORING')}` : '';
  body.innerHTML = '<div style="text-align:center;color:#64748b;padding:40px 0"><span class="spinner"></span> Loading analysis...</div>';
  overlay.style.display = 'block';

  try {
    const data = await api(`/api/pair-analysis?instrument=${instrument}`);
    renderPairAnalysis(data, body);
  } catch (e) {
    body.innerHTML = `<div style="text-align:center;color:#fca5a5;padding:40px 0">Failed to load analysis: ${e.message}</div>`;
  }
}

function renderPairAnalysis(data, container) {
  const { instrument, h1Candles, m15Candles, pair, tradeLevels, signalSent, priceStats } = data;
  const isJPY = instrument.includes('JPY');
  const dec = isJPY ? 3 : 5;
  const pipMul = isJPY ? 100 : 10000;
  const isBuy = pair?.dir === 'BUY';

  // ── Price Stats Card ──
  let statsHtml = '';
  if (priceStats) {
    const chgColor = priceStats.changeDir === 'UP' ? '#4ade80' : '#f87171';
    const chgArrow = priceStats.changeDir === 'UP' ? '▲' : '▼';
    statsHtml = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div class="pa-stat">
          <div class="pa-stat-label">Current Price</div>
          <div class="pa-stat-val">${priceStats.close.toFixed(dec)}</div>
        </div>
        <div class="pa-stat">
          <div class="pa-stat-label">48h Change</div>
          <div class="pa-stat-val" style="color:${chgColor}">${chgArrow} ${Math.abs(priceStats.changePips)} pips</div>
        </div>
        <div class="pa-stat">
          <div class="pa-stat-label">48h High</div>
          <div class="pa-stat-val" style="color:#4ade80">${priceStats.high48.toFixed(dec)}</div>
        </div>
        <div class="pa-stat">
          <div class="pa-stat-label">48h Low</div>
          <div class="pa-stat-val" style="color:#f87171">${priceStats.low48.toFixed(dec)}</div>
        </div>
        <div class="pa-stat">
          <div class="pa-stat-label">48h Range</div>
          <div class="pa-stat-val">${priceStats.rangePips.toFixed(1)} pips</div>
        </div>
        <div class="pa-stat">
          <div class="pa-stat-label">Avg Volume</div>
          <div class="pa-stat-val">${priceStats.avgVolume.toLocaleString()}</div>
        </div>
      </div>`;
  }

  // ── Trade Levels (personalized per user, only shown after signal email sent) ──
  let levelsHtml = '';
  if (tradeLevels) {
    const entry = Number(tradeLevels.entry_price);
    const sl    = Number(tradeLevels.stop_loss);
    const tp    = Number(tradeLevels.take_profit);
    const rr    = tradeLevels.risk_reward || '—';
    const lots  = tradeLevels.lot_size;
    const risk  = tradeLevels.risk_amount;
    levelsHtml = `
      <div style="margin-bottom:16px;padding:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:10px">Your Trade Levels</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center">
          <div><div class="pa-stat-label">Entry</div><div class="pa-stat-val">${entry.toFixed(dec)}</div></div>
          <div><div class="pa-stat-label">Stop Loss</div><div class="pa-stat-val" style="color:#f87171">${sl.toFixed(dec)}</div></div>
          <div><div class="pa-stat-label">Take Profit</div><div class="pa-stat-val" style="color:#4ade80">${tp.toFixed(dec)}</div></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.04)">
          <div><div class="pa-stat-label">Risk : Reward</div><div class="pa-stat-val" style="color:#fbbf24">1:${rr}</div></div>
          ${lots ? `<div><div class="pa-stat-label">Lot Size</div><div class="pa-stat-val" style="color:#60a5fa">${lots}</div></div>` : '<div></div>'}
          ${risk ? `<div><div class="pa-stat-label">Risk</div><div class="pa-stat-val">$${risk.toFixed(2)}</div></div>` : '<div></div>'}
        </div>
      </div>`;
  } else if (signalSent === false && pair && (pair.phase === 'ENTRY' || pair.phase === 'MOVING')) {
    levelsHtml = `
      <div style="margin-bottom:16px;padding:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px;text-align:center">
        <div style="font-size:11px;color:#64748b">Trade levels will appear here once the signal email is sent for this pair.</div>
      </div>`;
  }

  // ── Strength Metrics ──
  let metricsHtml = '';
  if (pair) {
    const v45 = parseFloat(pair.v45) || 0;
    const v90 = parseFloat(pair.v90) || 0;
    const sp3 = parseFloat(pair.spread_3h) || 0;
    const sp6 = parseFloat(pair.spread_6h) || 0;
    const de  = parseFloat(pair.de_combined) || 0;
    const imp = pair.impulse_score || 0;
    const flowSign = isBuy ? 1 : -1;
    const m15Aligned = Math.sign(v45) === flowSign && Math.abs(v45) >= 0.00008;
    const h3Aligned  = Math.sign(sp3) === flowSign;
    const h6Aligned  = Math.sign(sp6) === flowSign;
    const dot = ok => ok ? '<span style="color:#4ade80">●</span>' : '<span style="color:#f87171">●</span>';

    metricsHtml = `
      <div style="margin-bottom:16px;padding:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:10px">Timeframe Alignment</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;text-align:center">
          <div>
            <div class="pa-stat-label">M15 ${dot(m15Aligned)}</div>
            <div class="pa-stat-val" style="color:${v45 > 0 ? '#4ade80' : v45 < 0 ? '#f87171' : '#94a3b8'}">${(v45*10000).toFixed(1)}</div>
          </div>
          <div>
            <div class="pa-stat-label">3H ${dot(h3Aligned)}</div>
            <div class="pa-stat-val" style="color:${sp3 > 0 ? '#4ade80' : sp3 < 0 ? '#f87171' : '#94a3b8'}">${(sp3*10000).toFixed(1)}</div>
          </div>
          <div>
            <div class="pa-stat-label">6H ${dot(h6Aligned)}</div>
            <div class="pa-stat-val" style="color:${sp6 > 0 ? '#4ade80' : sp6 < 0 ? '#f87171' : '#94a3b8'}">${(sp6*10000).toFixed(1)}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;text-align:center;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.04)">
          <div><div class="pa-stat-label">DE</div><div class="pa-stat-val" style="color:${de >= 30 ? '#4ade80' : de >= 15 ? '#f59e0b' : '#94a3b8'}">${Math.round(de)}%</div></div>
          <div><div class="pa-stat-label">Impulse</div><div class="pa-stat-val" style="color:${imp >= 50 ? '#4ade80' : imp >= 30 ? '#f59e0b' : '#94a3b8'}">${Math.round(imp)}${pair.impulse_aligned ? '✓' : ''}</div></div>
          <div><div class="pa-stat-label">M15 State</div><div class="pa-stat-val">${(pair.m15_state || 'FLAT')}</div></div>
        </div>
      </div>`;
  }

  // ── Narrative Analysis ──
  let narrativeHtml = '';
  if (pair && priceStats) {
    const parts = [];
    const dirWord = isBuy ? 'bullish' : 'bearish';
    const v45 = parseFloat(pair.v45) || 0;
    const sp3 = parseFloat(pair.spread_3h) || 0;
    const sp6 = parseFloat(pair.spread_6h) || 0;
    const flowSign = isBuy ? 1 : -1;

    // Price context
    if (priceStats.changeDir === (isBuy ? 'UP' : 'DOWN')) {
      parts.push(`Price has moved ${Math.abs(priceStats.changePips)} pips ${dirWord} over 48 hours, confirming the signal direction.`);
    } else {
      parts.push(`Price moved ${Math.abs(priceStats.changePips)} pips against the signal over 48 hours — entry may catch a reversal.`);
    }

    // Timeframe alignment
    const aligned = [v45 * flowSign > 0, sp3 * flowSign > 0, sp6 * flowSign > 0].filter(Boolean).length;
    if (aligned === 3) parts.push(`All timeframes (M15, 3H, 6H) confirm ${dirWord} pressure — full alignment.`);
    else if (aligned === 2) parts.push(`Two of three timeframes aligned ${dirWord} — partial confirmation.`);
    else if (aligned === 1) parts.push(`Only one timeframe aligned — weak confirmation, higher risk.`);
    else parts.push(`No timeframes aligned with signal — conditions are mixed.`);

    // M15 state
    const state = (pair.m15_state || 'FLAT').toUpperCase();
    if (state === 'EXPANDING') parts.push('M15 spread is expanding — momentum is building in the signal direction.');
    else if (state === 'COMPRESSING') parts.push('M15 spread is compressing — momentum is fading, watch for re-expansion.');
    else if (state === 'REVERSING') parts.push('M15 spread is reversing — short-term pressure is against the signal.');
    else if (state === 'STEADY') parts.push('M15 spread is steady — holding direction at a consistent pace.');

    // DE quality
    const de = parseFloat(pair.de_combined) || 0;
    if (de >= 30) parts.push(`Directional efficiency is high (${Math.round(de)}%) — clean, institutional-quality movement.`);
    else if (de >= 15) parts.push(`Directional efficiency is moderate (${Math.round(de)}%) — decent but not exceptional.`);
    else parts.push(`Directional efficiency is low (${Math.round(de)}%) — choppy, mixed price action.`);

    // Range context
    if (priceStats.rangePips > 0) {
      const currentPos = ((priceStats.close - priceStats.low48) / priceStats.range48) * 100;
      if (isBuy && currentPos > 80) parts.push(`Price is near the 48h high (${Math.round(currentPos)}% of range) — extended, potential for pullback.`);
      else if (!isBuy && currentPos < 20) parts.push(`Price is near the 48h low (${Math.round(currentPos)}% of range) — extended, potential for bounce.`);
      else if (isBuy && currentPos < 40) parts.push(`Price is in the lower half of the 48h range — good entry zone for longs.`);
      else if (!isBuy && currentPos > 60) parts.push(`Price is in the upper half of the 48h range — good entry zone for shorts.`);
    }

    narrativeHtml = `
      <div style="margin-bottom:16px;padding:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b;margin-bottom:10px">Analysis</div>
        <div style="font-size:12px;color:#cbd5e1;line-height:1.7">${parts.join(' ')}</div>
      </div>`;
  }

  // ── Chart with TF toggle + Volume ──
  // Store candle data globally so TF toggle can switch without re-fetching
  window._paCandles = { h1: h1Candles, m15: m15Candles, tradeLevels, isJPY };

  container.innerHTML = `
    ${statsHtml}
    <div style="margin-bottom:16px;padding:14px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06);border-radius:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#64748b">Price</div>
        <div style="display:flex;gap:4px">
          <button class="pa-tf-btn active" data-patf="h1" onclick="_paSwitchTF('h1')">H1 · 48h</button>
          <button class="pa-tf-btn" data-patf="m15" onclick="_paSwitchTF('m15')">M15 · 6h</button>
        </div>
      </div>
      <div style="height:260px"><canvas id="pa-chart"></canvas></div>
      <div style="height:80px;margin-top:4px"><canvas id="pa-vol-chart"></canvas></div>
    </div>
    ${levelsHtml}
    ${metricsHtml}
    ${narrativeHtml}
  `;

  // Default: H1 view
  _paRenderCharts(h1Candles, tradeLevels, isJPY);
}

function _paSwitchTF(tf) {
  const d = window._paCandles;
  if (!d) return;
  document.querySelectorAll('.pa-tf-btn').forEach(b => b.classList.toggle('active', b.dataset.patf === tf));
  const candles = tf === 'm15' ? d.m15 : d.h1;
  _paRenderCharts(candles, d.tradeLevels, d.isJPY);
}

function _paRenderCharts(candles, tradeLevels, isJPY) {
  if (!candles || candles.length < 2) return;
  const ctx    = document.getElementById('pa-chart')?.getContext('2d');
  const volCtx = document.getElementById('pa-vol-chart')?.getContext('2d');
  if (ctx) _renderCandlestickChart(ctx, candles, tradeLevels, isJPY);
  if (volCtx) _renderVolumeChart(volCtx, candles);
}

let _paVolChart = null;

function _renderVolumeChart(ctx, candles) {
  if (_paVolChart) _paVolChart.destroy();

  const tz = (_userTz === 'auto')
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : (_userTz || 'UTC');
  const labels = candles.map(c => {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(c.time));
  });
  const volumes = candles.map(c => c.volume || 0);
  const avgVol  = volumes.reduce((s, v) => s + v, 0) / (volumes.length || 1);
  const colors  = candles.map((c, i) => {
    const bull = c.close >= c.open;
    const high = volumes[i] > avgVol * 1.5;
    if (bull && high) return 'rgba(34,197,94,0.7)';
    if (bull)         return 'rgba(34,197,94,0.35)';
    if (high)         return 'rgba(239,68,68,0.7)';
    return 'rgba(239,68,68,0.35)';
  });

  _paVolChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: volumes,
        backgroundColor: colors,
        borderWidth: 0,
        borderRadius: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `Vol: ${c.raw.toLocaleString()}` } },
      },
      scales: {
        x: {
          display: false,
        },
        y: {
          ticks: { color: '#475569', font: { size: 9 }, callback: v => v >= 1000 ? (v/1000).toFixed(0) + 'k' : v },
          grid: { color: 'rgba(255,255,255,0.03)' },
        },
      },
    },
  });
}

function _renderCandlestickChart(ctx, candles, levels, isJPY) {
  if (_paChart) _paChart.destroy();

  const dec = isJPY ? 3 : 5;
  const tz = (_userTz === 'auto')
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : (_userTz || 'UTC');
  const labels = candles.map(c => {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(c.time));
  });

  // Line chart with high/low band + colored close line
  const closeData = candles.map(c => c.close);
  const highData  = candles.map(c => c.high);
  const lowData   = candles.map(c => c.low);
  const pointColors = candles.map(c => c.close >= c.open ? '#22c55e' : '#ef4444');

  const datasets = [
    {
      label: 'High', data: highData, borderColor: 'transparent',
      backgroundColor: 'rgba(148,163,184,0.06)', pointRadius: 0,
      fill: '+1', tension: 0.1,
    },
    {
      label: 'Low', data: lowData, borderColor: 'transparent',
      backgroundColor: 'transparent', pointRadius: 0, fill: false, tension: 0.1,
    },
    {
      label: 'Close', data: closeData, borderColor: '#60a5fa', borderWidth: 2,
      pointRadius: 3, pointBackgroundColor: pointColors, pointBorderColor: pointColors,
      pointBorderWidth: 0, fill: false, tension: 0.15,
      segment: { borderColor: c2 => {
        const i = c2.p0DataIndex;
        return candles[i+1] && candles[i+1].close >= candles[i].close ? '#22c55e' : '#ef4444';
      }},
    },
  ];

  // SL/TP/Entry horizontal lines (only if trade levels available)
  if (levels?.entry_price) {
    datasets.push({ label: 'Entry', data: candles.map(() => +levels.entry_price), borderColor: '#60a5fa', borderWidth: 1, borderDash: [5, 3], pointRadius: 0, fill: false });
  }
  if (levels?.stop_loss) {
    datasets.push({ label: 'SL', data: candles.map(() => +levels.stop_loss), borderColor: '#f87171', borderWidth: 1, borderDash: [5, 3], pointRadius: 0, fill: false });
  }
  if (levels?.take_profit) {
    datasets.push({ label: 'TP', data: candles.map(() => +levels.take_profit), borderColor: '#4ade80', borderWidth: 1, borderDash: [5, 3], pointRadius: 0, fill: false });
  }

  // Y-axis bounds with padding
  let allVals = [...highData, ...lowData];
  if (levels?.entry_price) allVals.push(+levels.entry_price);
  if (levels?.stop_loss)   allVals.push(+levels.stop_loss);
  if (levels?.take_profit) allVals.push(+levels.take_profit);
  const yMin = Math.min(...allVals);
  const yMax = Math.max(...allVals);
  const yPad = (yMax - yMin) * 0.1 || 0.001;

  _paChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true, position: 'top',
          labels: {
            filter: item => ['Close', 'Entry', 'SL', 'TP'].includes(item.text),
            color: '#94a3b8', font: { size: 10 }, boxWidth: 12, padding: 8,
          },
        },
        tooltip: {
          callbacks: {
            label: function(c2) {
              if (c2.dataset.label === 'High' || c2.dataset.label === 'Low') return null;
              const c = candles[c2.dataIndex];
              if (c2.dataset.label === 'Close') {
                return `O:${c.open.toFixed(dec)} H:${c.high.toFixed(dec)} L:${c.low.toFixed(dec)} C:${c.close.toFixed(dec)}`;
              }
              return `${c2.dataset.label}: ${c2.raw.toFixed(dec)}`;
            }
          }
        },
      },
      scales: {
        x: {
          ticks: { color: '#64748b', font: { size: 9 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 12 },
          grid: { color: 'rgba(255,255,255,0.03)' },
        },
        y: {
          min: yMin - yPad, max: yMax + yPad,
          ticks: { color: '#64748b', font: { size: 10 }, callback: v => v.toFixed(isJPY ? 2 : 4) },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
      },
    },
  });
}

// ─── Trading Session ──────────────────────────────────────────────────────────

const SESSION_TIMELINE = [
  { name: 'ASIA',        label: 'Asia',       hours: '23–06', quality: 'medium'    },
  { name: 'LONDON_OPEN', label: 'LDN Open',   hours: '07–10', quality: 'high'      },
  { name: 'LONDON',      label: 'London',     hours: '10–13', quality: 'high'      },
  { name: 'LONDON_NY',   label: 'LDN/NY',     hours: '13–17', quality: 'very_high' },
  { name: 'LATE_NY',     label: 'Late NY',    hours: '17–21', quality: 'low'       },
  { name: 'DEAD_HOURS',  label: 'Low Liq.',   hours: '21–23', quality: 'blocked'   },
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

  // Market Activity = average of Movement, Momentum, Agreement, Volatility from Market Energy
  const me = (_meSessSnapshot || []).find(m => m.session_name === s.session);
  const activity = me
    ? Math.round(((me.movement_score || 0) + (me.breadth_score || 0) + (me.agreement_score || 0) + (me.volatility_score || 0)) / 4)
    : 0;

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

function _meSessionExplain(s, label, status) {
  if (!s) return { explainHtml: '', flowHtml: '' };
  const mov = Math.round(parseFloat(s.movement_score) || 0);
  const brd = Math.round(parseFloat(s.breadth_score) || 0);
  const agr = Math.round(parseFloat(s.agreement_score) || 0);
  const vol = Math.round(parseFloat(s.volatility_score) || 0);
  const energy = Math.round(parseFloat(s.market_energy) || 0);
  const bull = Math.round(parseFloat(s.bullish_breadth) || 0);
  const bear = Math.round(parseFloat(s.bearish_breadth) || 0);
  const activePct = Math.min(100, Math.round((parseFloat(s.active_pairs) || 0) / 28 * 100));
  const dirCtrl = Math.round(parseFloat(s.directional_control) || 0);
  const tradScore = Math.round(parseFloat(s.tradability_score) || 0);
  const tradGrade = s.tradability_grade || 'AVOID';
  const volType = s.volatility_type || 'NORMAL';
  const chaosVal = Math.round(parseFloat(s.chaos_score) || 0);
  // Use Flow Performance calculation for active session only
  // Completed sessions use their own stored snapshot from that session's time
  let strong, weak;
  if (status === 'ACTIVE' && strengthData?.currencies?.length) {
    const flow = getSmoothed3HFlow(strengthData.currencies);
    strong = flow.strong[0] || null;
    weak   = flow.weak[0]   || null;
  } else {
    strong = (s.strongest_ccy || '').split(',')[0] || null;
    weak   = (s.weakest_ccy   || '').split(',')[0] || null;
  }

  const lines = [];

  // Tradability verdict (the key output)
  const TRAD_DESC = {
    STRONG_TREND: `Strong institutional trend (${tradScore}/100) — high conviction, favour trend-following.`,
    TRADABLE: `Tradable environment (${tradScore}/100) — good conditions for directional trades.`,
    SELECTIVE: `Selective conditions (${tradScore}/100) — be picky, only take the best setups.`,
    DANGEROUS: `Low-quality conditions (${tradScore}/100) — high risk of false signals, reduce size.`,
    AVOID: `Avoid trading (${tradScore}/100) — conditions are unfavourable for directional trades.`,
  };
  lines.push(TRAD_DESC[tradGrade] || `Tradability: ${tradScore}/100`);

  // Movement
  if (mov >= 60) lines.push(`Strong price movement (${mov}) — high pip activity across pairs.`);
  else if (mov >= 35) lines.push(`Moderate movement (${mov}) — some pairs are active.`);
  else lines.push(`Low movement (${mov}) — most pairs are quiet.`);

  // Breadth / participation
  if (brd >= 60) lines.push(`Wide breadth (${brd}) — ${activePct}% of pairs participating.`);
  else if (brd >= 35) lines.push(`Moderate breadth (${brd}) — ${activePct}% of pairs active.`);
  else lines.push(`Narrow breadth (${brd}) — only ${activePct}% of pairs active.`);

  // Directional control
  if (dirCtrl >= 50) {
    const dominant = bull > bear ? 'Buyers' : 'Sellers';
    lines.push(`${dominant} in control (${dirCtrl}%) — strong one-sided pressure.`);
  } else if (dirCtrl >= 25) {
    lines.push(`Mild directional lean (${dirCtrl}%) — not a clean one-sided move.`);
  } else {
    lines.push(`No directional control (${dirCtrl}%) — bulls and bears evenly matched.`);
  }

  // Volatility quality
  const VOL_DESC = {
    HEALTHY: `Healthy volatility (${vol}) — organized moves with good agreement.`,
    NORMAL: `Normal volatility (${vol}) — standard market conditions.`,
    CHAOTIC: `Chaotic volatility (${vol}) — high movement but disorganized, chaos score ${chaosVal}.`,
    EVENT: `Event-driven volatility (${vol}) — likely news impact, wait for stability.`,
    DEAD: `Dead volatility (${vol}) — tight ranges, no activity.`,
  };
  lines.push(VOL_DESC[volType] || `Volatility: ${vol}`);

  // Agreement
  if (agr >= 50) lines.push(`High agreement (${agr}) — currencies and pairs aligned, trends are consistent.`);
  else if (agr >= 25) lines.push(`Mixed agreement (${agr}) — partial alignment, some conflict.`);
  else lines.push(`Low agreement (${agr}) — currencies giving conflicting signals.`);

  // Currency leadership — best 4 moving pairs from energy signal pairs
  // ACTIVE session: use live energy signal pairs sorted by movement
  // COMPLETED session: use stored flow_performance from session details
  let rankedPairs = null;

  if (status === 'ACTIVE' && _energySignalsCache?.pairs?.length) {
    // Use same ranking as Flow Performance: perfScore + DE → finalScore
    const scored = [..._energySignalsCache.pairs].filter(p => p.active).map(p => {
      const flowSign = p.dir === 'BUY' ? 1 : -1;
      const v45 = parseFloat(p.v45) || 0;
      const v90 = parseFloat(p.v90) || 0;
      const sp3 = parseFloat(p.spread_3h) || 0;
      const sp6 = parseFloat(p.spread_6h) || 0;
      const de  = parseFloat(p.de_combined) || 0;
      const imp = p.impulse_score || 0;
      const impulseAligned = !!p.impulse_aligned;
      const m15State = (p.m15_state || 'FLAT').toUpperCase();
      const m15Confirms = (v45 * flowSign) > 0;
      const h3Confirms  = (sp3 * flowSign) > 0;
      const h6Confirms  = (sp6 * flowSign) > 0;
      const accelSign   = Math.sign(v45 - v90) === flowSign;

      let perfScore = 0;
      perfScore += (v45 * flowSign) * 10000 * 3;
      perfScore += (sp3 * flowSign) * 10000 * 2;
      perfScore += (sp6 * flowSign) * 10000 * 1;
      if (impulseAligned && imp >= 40) perfScore += imp * 0.5;
      else if (impulseAligned)         perfScore += imp * 0.25;
      else if (imp >= 40)              perfScore -= imp * 0.3;
      if (m15Confirms && imp >= 40)    perfScore += 20;
      else if (m15Confirms)            perfScore += 10;
      if (h3Confirms)  perfScore += 10;
      if (h6Confirms)  perfScore += 5;
      if (accelSign)   perfScore += 10;
      if (m15State === 'EXPANDING' && m15Confirms)                 perfScore += 15;
      if (m15State === 'EXPANDING' && impulseAligned && imp >= 50) perfScore += 10;
      if (m15State === 'REVERSING')                                perfScore -= 10;
      if (m15State === 'COMPRESSING' && !m15Confirms)              perfScore -= 15;

      const finalScore = (0.75 * perfScore) + (0.25 * de);
      const vol = _volDataCache[p.instrument];
      return {
        pair: p.instrument.replace('_', '/'), dir: p.dir,
        status: mapPhase(p.phase || 'MONITORING'),
        finalScore, de: Math.round(de * 10) / 10,
        volGrade: vol?.participation_grade || '',
        volRV:  vol ? parseFloat(vol.relative_volume) || 0 : 0,
        volEff: vol ? parseFloat(vol.volume_efficiency) || 0 : 0,
        volPers: vol ? parseFloat(vol.volume_persistence) || 0 : 0,
        volScore: 0,
      };
    });
    scored.sort((a, b) => b.finalScore - a.finalScore);
    if (scored.length) rankedPairs = scored.slice(0, 4);
  }

  // COMPLETED sessions: use stored flow_performance from session details
  // Now reads pre-computed data from flow_performance table (includes final_score, vol, impulse)
  if (!rankedPairs || !rankedPairs.length) {
    const storedFP = s.details?.flow_performance;
    if (storedFP && storedFP.length) {
      rankedPairs = storedFP.map(fp => {
        const deCombined = fp.de || 0;
        // Use pre-computed final_score if available, otherwise recalculate
        let finalScore = fp.final_score;
        if (finalScore == null) {
          const flowSign = fp.dir === 'BUY' ? 1 : -1;
          let perfScore = 0;
          if (fp.m15 != null) perfScore += (fp.m15 * flowSign) * 10000 * 3;
          if (fp.h3  != null) perfScore += (fp.h3  * flowSign) * 10000 * 2;
          if (fp.h6  != null) perfScore += (fp.h6  * flowSign) * 10000 * 1;
          finalScore = (0.75 * perfScore) + (0.25 * deCombined);
        }
        return {
          pair: fp.pair.replace('_', '/'), dir: fp.dir, status: mapPhase(fp.status || 'WAIT'),
          finalScore, de: Math.round(deCombined * 10) / 10,
          volGrade: fp.vol_grade || '', volRV: fp.vol_rv || 0,
          volEff: 0, volPers: 0, volScore: 0,
        };
      }).sort((a, b) => b.finalScore - a.finalScore).slice(0, 4);
    }
  }

  // Strength flow — rendered as highlighted block, not inline text
  let flowHtml = '';
  if (rankedPairs && rankedPairs.length) {
    const deLabel = v => {
      if (v >= 30) return { text: 'Trending',    color: '#22c55e' };
      if (v >= 20) return { text: 'Directional', color: '#0ea5e9' };
      if (v >= 8)  return { text: 'Mixed',       color: '#f59e0b' };
      return              { text: 'Choppy',       color: '#ef4444' };
    };
    const VOL_GRADE_COLOR = { INSTITUTIONAL: '#22c55e', STRONG: '#0ea5e9', NORMAL: '#94a3b8', WEAK: '#f59e0b', DEAD: '#64748b' };
    const VOL_GRADE_SHORT = { INSTITUTIONAL: 'Inst', STRONG: 'Strng', NORMAL: 'Norm', WEAK: 'Weak', DEAD: 'Dead' };
    const pairRows = rankedPairs.map((p, i) => {
      const dirCls = p.dir === 'BUY' ? 'buy' : 'sell';
      const statusColor = p.status === 'MOVING' ? '#f59e0b' : p.status === 'ENTRY' ? '#22c55e' : p.status === 'PULLBACK' ? '#f59e0b' : p.status === 'COMPRESSION' ? '#a78bfa' : p.status === 'STRONG' ? '#22c55e' : p.status === 'ALIGNED' ? '#0ea5e9' : p.status === 'PARTIAL' ? '#a855f7' : p.status === 'BUILDING' ? '#f59e0b' : p.status === 'AGAINST' ? '#ef4444' : '#64748b';
      const dl = deLabel(p.de);
      const deHtml = `<span class="me-flow-de" style="color:${dl.color}">DE ${p.de}% ${dl.text}</span>`;
      const volColor = VOL_GRADE_COLOR[p.volGrade] || '#64748b';
      const volShort = VOL_GRADE_SHORT[p.volGrade] || '';
      const volHtml = p.volGrade ? `<span class="me-flow-vol" style="color:${volColor}">${p.volRV.toFixed(1)}× ${volShort}</span>` : '';
      const analysis = _flowPairAnalysis(p);
      const uid = 'sfa-' + s.session_name + '-' + i;
      return `<div class="me-flow-pair-block">
        <div class="me-flow-row">
          <span class="me-flow-rank">#${i + 1}</span>
          <span class="me-flow-dir ${dirCls}">${p.dir}</span>
          <span class="me-flow-pair">${p.pair}</span>
          <span class="me-flow-status" style="color:${statusColor}">${p.status}</span>
          ${deHtml}
          ${volHtml}
          <button class="sfa-toggle" onclick="var el=document.getElementById('${uid}');el.style.display=el.style.display==='none'?'':'none';this.textContent=el.style.display==='none'?'▸':'▾'" title="Show analysis">▸</button>
        </div>
        <div class="sfa-panel" id="${uid}" style="display:none">
          <div class="sfa-verdict ${analysis.cls}">${analysis.verdict}</div>
          <ul class="sfa-points">${analysis.points.map(pt => `<li>${pt}</li>`).join('')}</ul>
        </div>
      </div>`;
    }).join('');
    const hasChoppy = rankedPairs.some(p => p.de > 0 && p.de < 20);
    const deWarn = hasChoppy ? ' Choppy/Mixed DE — expect noise, tighten stops.' : '';
    const actionHint = status === 'ACTIVE'
      ? `<div class="me-flow-hint">Wait for pullback on top-ranked pairs, then confirm entry on M15.${deWarn}</div>`
      : '';
    flowHtml = `<div class="me-flow-block">
      <div class="me-flow-title">Strength Flow</div>
      ${pairRows}
      ${actionHint}
    </div>`;
  }

  // Overall energy
  if (energy >= 60) lines.push(`High energy (${energy}) — market is active and directional.`);
  else if (energy >= 35) lines.push(`Moderate energy (${energy}) — conditions building, wait for confirmation.`);
  else lines.push(`Low energy (${energy}) — range-bound, avoid forcing trades.`);

  return { explainHtml: `<div class="me-explain">
    <div class="me-explain-title">What this means</div>
    <ul class="me-explain-list">${lines.map(l => `<li>${l}</li>`).join('')}</ul>
  </div>`, flowHtml };
}

function _meHourlyTrend(hourlyRows) {
  if (!hourlyRows || hourlyRows.length === 0) return '';

  // ── Score metrics (numeric rows with delta badges) ──
  const scoreMetrics = [
    { key: 'market_energy',       label: 'Energy' },
    { key: 'tradability_score',   label: 'Trad' },
    { key: 'movement_score',      label: 'Mov' },
    { key: 'breadth_score',       label: 'Brd' },
    { key: 'agreement_score',     label: 'Agr' },
    { key: 'directional_control', label: 'Dir' },
    { key: 'volatility_quality',  label: 'VolQ' },
    { key: 'volatility_score',    label: 'Vol' },
    { key: 'momentum_score',      label: 'Mom', isMomentum: true },
  ];

  // ── Classification labels (badge rows) ──
  const VOL_TYPE_COLOR = { HEALTHY: '#22c55e', NORMAL: '#94a3b8', CHAOTIC: '#ef4444', EVENT: '#f59e0b', DEAD: '#64748b' };
  const VOL_TYPE_SHORT = { HEALTHY: 'Hlthy', NORMAL: 'Norm', CHAOTIC: 'Chaos', EVENT: 'Event', DEAD: 'Dead' };
  const MOM_TYPE_COLOR = { IMPULSE: '#f59e0b', EXPANSION: '#22c55e', TREND: '#0ea5e9', EXHAUSTION: '#ef4444', DECAY: '#f97316', STABLE: '#64748b' };
  const MOM_TYPE_SHORT = { IMPULSE: 'Impls', EXPANSION: 'Expan', TREND: 'Trend', EXHAUSTION: 'Exhst', DECAY: 'Decay', STABLE: 'Stbl' };
  const CYCLE_COLOR = { EXPLOSIVE: '#f59e0b', EXPANSION: '#22c55e', TRANSITION: '#0ea5e9', COMPRESSION: '#ef4444', EXHAUSTION: '#f97316', LOW_PARTICIPATION: '#64748b', DEAD: '#334155' };
  const CYCLE_SHORT = { EXPLOSIVE: 'Explo', EXPANSION: 'Expan', TRANSITION: 'Trans', COMPRESSION: 'Compr', EXHAUSTION: 'Exhst', LOW_PARTICIPATION: 'LowP', DEAD: 'Dead' };

  // Time headers
  const tz = (_userTz === 'auto') ? Intl.DateTimeFormat().resolvedOptions().timeZone : (_userTz || 'UTC');
  const timeHeaders = hourlyRows.map(h => {
    const d = new Date(h.time_utc);
    return d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  });

  function changeBadge(vals, idx) {
    if (idx === 0) return '';
    const diff = vals[idx] - vals[idx - 1];
    if (diff === 0) return '';
    const sign = diff > 0 ? '+' : '';
    const cls = diff > 0 ? 'me-ht-chg-up' : 'me-ht-chg-dn';
    return `<span class="${cls}">${sign}${diff}</span>`;
  }

  function valColor(v) {
    if (v >= 60) return '#22c55e';
    if (v >= 35) return '#eab308';
    if (v >= 15) return '#94a3b8';
    return '#64748b';
  }

  function momColor(v) {
    if (v > 5) return '#22c55e';
    if (v > 0) return '#94a3b8';
    if (v < -5) return '#ef4444';
    if (v < 0) return '#f97316';
    return '#64748b';
  }

  const headerCells = timeHeaders.map(t => `<th class="me-ht-th">${t}</th>`).join('');

  // Score rows
  const scoreRows = scoreMetrics.map(m => {
    const vals = hourlyRows.map(h => Math.round(parseFloat(h[m.key]) || 0));
    const cells = vals.map((v, i) => {
      if (m.isMomentum) {
        const display = v > 0 ? `+${v}` : `${v}`;
        return `<td class="me-ht-td"><span class="me-ht-val" style="color:${momColor(v)}">${display}</span>${changeBadge(vals, i)}</td>`;
      }
      return `<td class="me-ht-td"><span class="me-ht-val" style="color:${valColor(v)}">${v}</span>${changeBadge(vals, i)}</td>`;
    }).join('');
    return `<tr><td class="me-ht-label">${m.label}</td>${cells}</tr>`;
  }).join('');

  // Classification badge rows
  function badgeRow(label, hourlyRows, field, colorMap, shortMap) {
    const cells = hourlyRows.map(h => {
      const type = h[field] || '';
      const color = colorMap[type] || '#64748b';
      const short = shortMap[type] || type.slice(0, 5);
      return `<td class="me-ht-td"><span class="me-ht-badge" style="color:${color}">${short}</span></td>`;
    }).join('');
    return `<tr><td class="me-ht-label">${label}</td>${cells}</tr>`;
  }

  const classRows = [
    badgeRow('Cycle', hourlyRows, 'energy_cycle', CYCLE_COLOR, CYCLE_SHORT),
    badgeRow('VolTyp', hourlyRows, 'volatility_type', VOL_TYPE_COLOR, VOL_TYPE_SHORT),
    badgeRow('MomTyp', hourlyRows, 'momentum_type', MOM_TYPE_COLOR, MOM_TYPE_SHORT),
  ].join('');

  return `<div class="me-hourly-trend">
    <div class="me-ht-title">Hourly Breakdown</div>
    <table class="me-ht-table">
      <thead><tr><th class="me-ht-label"></th>${headerCells}</tr></thead>
      <tbody>
        ${scoreRows}
        <tr class="me-ht-sep"><td colspan="${hourlyRows.length + 1}"></td></tr>
        ${classRows}
      </tbody>
    </table>
  </div>`;
}

function _meSessionCard(name, s, status, hourlyRows) {
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

  if (!s && status === 'ACTIVE') {
    return `<div class="me-card me-card--active">
      <div class="me-card-head">
        <span class="me-card-sess" style="color:${sessColor}">${label}</span>
        <span class="me-status-badge me-status-active">Live</span>
      </div>
      <div class="me-card-comps me-card-empty">Session just started — data populates on the next hourly cycle</div>
    </div>`;
  }

  if (!s && status === 'UPCOMING') {
    return `<div class="me-card me-card--dim">
      <div class="me-card-head">
        <span class="me-card-sess" style="color:${sessColor}">${label}</span>
        <span class="me-card-cycle" style="--bc:#475569">Upcoming</span>
      </div>
      <div class="me-card-comps me-card-empty">Session hasn't started yet today</div>
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

  // Free plan: hide active/live session card — show upgrade prompt instead
  if (status === 'ACTIVE' && document.body.classList.contains('plan-free')) {
    return `<div class="me-card me-card--active me-card--locked">
      <div class="me-card-head">
        <span class="me-card-sess" style="color:${sessColor}">${label}</span>
        <span class="me-status-badge me-status-active">Live</span>
      </div>
      <div class="me-lock-body">
        <span class="me-lock-icon">🔒</span>
        <span class="me-lock-title">Live Session</span>
        <span class="me-lock-desc">Upgrade to Pro to see real-time energy, tradability, directional flow, and hourly breakdown for the current session.</span>
        <a href="#" class="me-lock-btn" onclick="event.preventDefault();startUpgrade('pro')">Upgrade to Pro →</a>
      </div>
    </div>`;
  }

  const cycle      = s.energy_cycle || 'BALANCED';
  const cycleColor = ME_CYCLE_COLOR[cycle] || '#64748b';
  const cycleLabel = ME_CYCLE_LABEL[cycle] || cycle;

  const comps = [
    { label: 'Movement',   val: s.movement_score,   norm: s.norm_movement,   prev: s.prev_movement   },
    { label: 'Breadth',    val: s.breadth_score,     norm: s.norm_breadth,    prev: s.prev_breadth    },
    { label: 'Agreement',  val: s.agreement_score,   norm: s.norm_agreement,  prev: s.prev_agreement  },
    { label: 'Volatility', val: s.volatility_score,  norm: s.norm_volatility, prev: null              },
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
  // Use Flow Performance calculation (smooth_3h) for active session to stay in sync with live card
  // Completed/upcoming sessions use their own stored snapshot from that session's time
  let strongCcys, weakCcys;
  if (status === 'ACTIVE' && strengthData?.currencies?.length) {
    const flow = getSmoothed3HFlow(strengthData.currencies);
    strongCcys = flow.strong;
    weakCcys   = flow.weak;
  } else {
    strongCcys = (s.strongest_ccy || '').split(',').filter(Boolean);
    weakCcys   = (s.weakest_ccy   || '').split(',').filter(Boolean);
  }
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

  // V2 metrics
  const tradScore = Math.round(parseFloat(s.tradability_score) || 0);
  const tradGrade = s.tradability_grade || 'AVOID';
  const tradColor = tradScore >= 65 ? '#22c55e' : tradScore >= 50 ? '#0ea5e9' : tradScore >= 35 ? '#f59e0b' : '#64748b';
  const momScore  = Math.round(parseFloat(s.momentum_score) || 0);
  const volType   = s.volatility_type || 'NORMAL';
  const volQual   = Math.round(parseFloat(s.volatility_quality) || 0);
  const dirCtrl   = Math.round(parseFloat(s.directional_control) || 0);
  const chaosVal  = Math.round(parseFloat(s.chaos_score) || 0);
  const TRAD_LABELS = { STRONG_TREND: 'Strong', TRADABLE: 'Tradable', SELECTIVE: 'Selective', DANGEROUS: 'Dangerous', AVOID: 'Avoid' };
  const VOL_TYPE_LABELS = { HEALTHY: 'Healthy', NORMAL: 'Normal', CHAOTIC: 'Chaotic', EVENT: 'Event', DEAD: 'Dead' };
  const VOL_TYPE_COLORS = { HEALTHY: '#22c55e', NORMAL: '#94a3b8', CHAOTIC: '#ef4444', EVENT: '#f59e0b', DEAD: '#64748b' };

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

  // Tradability bar
  const tradBar = `<div class="me-dir-sep"></div>
    <div class="me-dir-header">Tradability</div>
    <div class="me-comp-row">
      <span class="me-comp-label" style="color:${tradColor}">${TRAD_LABELS[tradGrade] || tradGrade}</span>
      ${_meCompBar(tradScore)}
      <div class="me-comp-right">
        <span class="me-comp-val" style="color:${tradColor}">${tradScore}</span>
      </div>
    </div>
    <div class="me-comp-row">
      <span class="me-comp-label" style="color:var(--text-dim)">Dir Control</span>
      ${_meDirBar(dirCtrl, '#a855f7')}
      <span class="me-comp-val">${dirCtrl}%</span>
    </div>
    <div class="me-comp-row">
      <span class="me-comp-label" style="color:${VOL_TYPE_COLORS[volType] || '#94a3b8'}">Vol: ${VOL_TYPE_LABELS[volType] || volType}</span>
      ${_meDirBar(volQual, VOL_TYPE_COLORS[volType] || '#94a3b8')}
      <span class="me-comp-val">${volQual}</span>
    </div>
    `;

  const { explainHtml, flowHtml: flowBlock } = _meSessionExplain(s, label, status) || { explainHtml: '', flowHtml: '' };

  return `<div class="me-card${status === 'ACTIVE' ? ' me-card--active' : status === 'UPCOMING' ? ' me-card--upcoming' : ''}">
    <div class="me-card-head">
      <span class="me-card-sess" style="color:${sessColor}">${label}</span>
      <span class="me-card-cycle" style="--bc:${cycleColor}">${cycleLabel}</span>
      ${momentumHtml}
      ${statusHtml}
    </div>
    ${flowBlock}
    <div class="me-card-comps"><div class="me-avg-note">Session averages</div>${compRows}${tradBar}${dirRows}</div>
    <div class="me-card-foot">
      <div class="me-foot-energy">
        <span class="me-foot-item">Energy <strong>${energy}</strong></span>
      </div>
      <span class="me-foot-item" style="color:${tradColor}">Tradability <strong>${tradScore}</strong></span>
      <span class="me-foot-item" style="color:${liqColor}">Liquidity <strong>${liqScore}</strong></span>
    </div>
    ${status === 'ACTIVE' ? _meHourlyTrend(hourlyRows) : ''}
    ${explainHtml}
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

  // Refresh Market Activity bar in the trading session card now that _meSessSnapshot is available
  _updateMarketActivityBar();

  try {
    const data = await api('/api/market-energy-narrative');
    _meNarrative = data;
    const modal = document.getElementById('me-analysis-modal');
    if (modal) _renderMeAnalysisModal();
  } catch (_) {}
}

// Update the Market Activity % bar in the session card without re-fetching session data
function _updateMarketActivityBar() {
  const sessEl = document.querySelector('.session-main');
  if (!sessEl) return;
  const sessName = document.querySelector('.sess-name-badge');
  if (!sessName) return;
  // Match session name from badge text to _meSessSnapshot
  const SESS_MAP = { 'Asia': 'ASIA', 'LDN Open': 'LONDON_OPEN', 'London': 'LONDON', 'LDN/NY': 'LONDON_NY', 'New York': 'NEW_YORK', 'Low Liquidity': 'LOW_LIQUIDITY' };
  const currentLabel = sessName.textContent.trim();
  const sessKey = SESS_MAP[currentLabel] || currentLabel;
  const me = (_meSessSnapshot || []).find(m => m.session_name === sessKey);
  if (!me) return;

  const activity = Math.round(((me.movement_score || 0) + (me.breadth_score || 0) + (me.agreement_score || 0) + (me.volatility_score || 0)) / 4);
  const actCls = activity >= 75 ? 'very-high' : activity >= 55 ? 'high' : activity >= 35 ? 'medium' : 'low';

  const pctEl = document.querySelector('.sess-act-pct');
  const fillEl = document.querySelector('.sess-act-bar-fill');
  if (pctEl) pctEl.textContent = `${activity}%`;
  if (fillEl) {
    fillEl.style.width = `${activity}%`;
    fillEl.className = `sess-act-bar-fill act-${actCls}`;
  }
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
      <div class="me-modal-title"><span class="me-modal-title-label">Hourly Session Breadth</span><span style="font-size:10px;color:var(--text-muted);margin-left:8px">${_bcTzLabel}</span><a href="/archive.html" style="font-size:10px;color:var(--accent);margin-left:auto;text-decoration:none">Full Archive →</a></div>
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
    const date = _groupDate(r);
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

    // Per-day explanation
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

    // Session-level summaries
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
    </div></div>`;
  }

  html += '</div>';

  // Guide box
  html += `<div class="bc-guide">
    <div class="bc-guide-title">How to read this chart</div>
    <ul class="bc-guide-list">
      <li><strong>Breadth</strong> measures what percentage of 28 pairs are actively moving each hour (above session-calibrated threshold). Higher = broader participation.</li>
      <li><strong>Rising bars</strong> mean more pairs are engaging — the market is gaining strength and trends are more likely to continue.</li>
      <li><strong>Falling bars</strong> mean participation is fading — fewer pairs are active, reversals or ranging conditions may follow.</li>
      <li><strong>Green bars</strong> highlight 3+ consecutive hourly increases (both &ge;10) — a continuation signal suggesting the move has broad support and is likely to persist.</li>
      <li><strong>Low breadth</strong> (under 15) means weak participation — avoid trading as moves lack conviction.</li>
      <li><strong>High breadth</strong> (above 50) with agreement means strong trending conditions — ideal for trend-following entries.</li>
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

// ─── Generic Metric Chart Modals ────────────────────────────────────────────

const METRIC_CHART_CONFIG = {
  movement: {
    field: 'movement_score', label: 'Movement Score', title: 'Hourly Session Movement',
    unit: '', decimals: 0, v2Threshold: 35,
    thresholds: [
      { min: 60, color: '#22c55e', label: 'Strong movement' },
      { min: 30, color: '#f59e0b', label: 'Moderate movement' },
      { min: 0,  color: '#ef4444', label: 'Weak movement' },
    ],
    guide: [
      '<strong>Movement</strong> measures average pair movement normalized by session-calibrated caps (Asia 0.12%, London 0.15%, NY 0.18%). Higher = bigger price action.',
      '<strong>Rising bars</strong> mean price action is accelerating — pairs are covering more ground and breakout conditions are more likely.',
      '<strong>Falling bars</strong> mean movement is contracting — pairs are slowing down, expect tighter ranges.',
      '<strong>Green bars</strong> indicate the value met the V2 engine threshold (≥35) — this engine is contributing to the Engine Confluence signal.',
      '<strong>Below 20</strong>: very quiet market — avoid entries, spreads may widen.',
      '<strong>Above 60</strong>: strong movement — ideal for breakout and trend strategies.',
    ],
  },
  agreement: {
    field: 'agreement_score', label: 'Agreement Score', title: 'Hourly Session Agreement',
    unit: '', decimals: 0, v2Threshold: 60,
    thresholds: [
      { min: 60, color: '#22c55e', label: 'Strong agreement' },
      { min: 35, color: '#f59e0b', label: 'Moderate agreement' },
      { min: 0,  color: '#ef4444', label: 'Weak/conflicting' },
    ],
    guide: [
      '<strong>Agreement</strong> = currency alignment x pair alignment x &radic;breadth. Measures whether pairs move consistently with currency strength AND hourly direction matches session trend.',
      '<strong>Rising bars</strong> mean currencies and pairs are aligning — institutional flow is becoming clear and consistent.',
      '<strong>Falling bars</strong> mean currencies are diverging — mixed signals, no clear theme.',
      '<strong>Green bars</strong> indicate the value met the V2 engine threshold (≥60) — this engine is contributing to the Engine Confluence signal.',
      '<strong>Below 25</strong>: conflicting signals — avoid directional trades, market is choppy.',
      '<strong>Above 50</strong>: strong consensus — trend-following setups are high-probability.',
    ],
  },
  volatility: {
    field: 'volatility_score', label: 'Volatility Score', title: 'Hourly Session Volatility (Raw)',
    unit: '', decimals: 0, v2Threshold: 40,
    thresholds: [
      { min: 60, color: '#ef4444', label: 'High volatility' },
      { min: 30, color: '#f59e0b', label: 'Moderate volatility' },
      { min: 0,  color: '#22c55e', label: 'Low volatility' },
    ],
    guide: [
      '<strong>Volatility</strong> measures raw hourly range normalized by session-calibrated caps. Does not distinguish organized vs chaotic — see Vol Quality for that.',
      '<strong>Rising bars</strong> mean the market is becoming more active — larger hourly ranges.',
      '<strong>Falling bars</strong> mean the market is calming down — tighter ranges, less movement.',
      '<strong>Green bars</strong> indicate the value met the V2 engine threshold (≥40) — this engine is contributing to the Engine Confluence signal.',
      '<strong>Below 25</strong>: calm market — standard position sizing and tighter stops work well.',
      '<strong>Above 55</strong>: high volatility — check Vol Quality to determine if it is healthy or chaotic.',
    ],
  },
  energy: {
    field: 'market_energy', label: 'Market Energy', title: 'Hourly Session Energy',
    unit: '', decimals: 0, v2Threshold: 50,
    thresholds: [
      { min: 60, color: '#22c55e', label: 'High energy' },
      { min: 30, color: '#f59e0b', label: 'Moderate energy' },
      { min: 0,  color: '#ef4444', label: 'Low energy' },
    ],
    guide: [
      '<strong>Market Energy</strong> = 30% movement + 25% breadth + 20% agreement + 15% directional control + 10% volatility quality, scaled by session quality multiplier.',
      '<strong>Rising bars</strong> mean the forex market is "waking up" — more pairs are active, moves are larger, and there is more to trade.',
      '<strong>Falling bars</strong> mean the market is winding down — fewer opportunities, lower conviction.',
      '<strong>Green bars</strong> indicate the value met the V2 engine threshold (≥50) — this engine is contributing to the Engine Confluence signal.',
      '<strong>Session quality</strong> scales the score: Healthy x1.10, Normal x0.90, Event x0.75, Chaotic x0.65, Dead x0.55.',
      '<strong>Above 50</strong>: energized market — conditions favor active trading with clear setups.',
    ],
  },
  tradability: {
    field: 'tradability_score', label: 'Tradability Score', title: 'Hourly Session Tradability',
    unit: '', decimals: 0, v2Threshold: 55,
    thresholds: [
      { min: 55, color: '#22c55e', label: 'Tradable / Strong' },
      { min: 40, color: '#0ea5e9', label: 'Selective' },
      { min: 25, color: '#f59e0b', label: 'Dangerous' },
      { min: 0,  color: '#ef4444', label: 'Avoid' },
    ],
    guide: [
      '<strong>Tradability</strong> = geometric mean of (energy, agreement, directional control, breadth) x volatility quality factor. ALL components must be strong — one weak link drags it down.',
      '<strong>70+</strong>: Strong Trend — high-conviction setups across multiple pairs. Full position sizing.',
      '<strong>55-69</strong>: Tradable — good conditions for selective entries with standard risk.',
      '<strong>40-54</strong>: Selective — only take A+ setups with reduced size. Some components are weak.',
      '<strong>25-39</strong>: Dangerous — poor conditions, high risk of getting stopped out. Avoid or scale down heavily.',
      '<strong>Below 25</strong>: Avoid — market is dead, chaotic, or structurally broken. No edge.',
      '<strong>Green bars</strong> indicate the value met the V2 engine threshold (≥55) — this engine is contributing to the Engine Confluence signal.',
    ],
  },
  dircontrol: {
    field: 'directional_control', label: 'Directional Control', title: 'Hourly Directional Control',
    unit: '%', decimals: 0, v2Threshold: 30,
    thresholds: [
      { min: 60, color: '#22c55e', label: 'Strong one-sided' },
      { min: 35, color: '#f59e0b', label: 'Moderate bias' },
      { min: 0,  color: '#ef4444', label: 'Split / no bias' },
    ],
    guide: [
      '<strong>Directional Control</strong> measures how one-sided market pressure is — 0% = evenly split bull/bear, 100% = fully one-directional.',
      '<strong>High control + high breadth</strong> = institutional conviction. Many pairs moving the same way with clear force.',
      '<strong>Low control</strong> means bulls and bears are evenly matched — choppy, range-bound conditions.',
      '<strong>Green bars</strong> indicate the value met the V2 engine threshold (≥30) — this engine is contributing to the Engine Confluence signal.',
      '<strong>Below 20%</strong>: split market — avoid directional trades, use range strategies.',
      '<strong>Above 60%</strong>: strong bias — trend trades and momentum entries have the best edge.',
    ],
  },
  volquality: {
    field: 'volatility_quality', label: 'Volatility Quality', title: 'Hourly Volatility Quality',
    unit: '', decimals: 0, v2Threshold: 30,
    thresholds: [
      { min: 40, color: '#22c55e', label: 'Healthy volatility' },
      { min: 20, color: '#f59e0b', label: 'Moderate quality' },
      { min: 0,  color: '#ef4444', label: 'Poor quality' },
    ],
    guide: [
      '<strong>Volatility Quality</strong> = raw volatility x quality multiplier. Healthy x1.0, Normal x0.75, Event x0.50, Chaotic x0.30, Dead x0.20.',
      '<strong>Healthy volatility</strong> (high vol + high agreement + good directional control) = organized moves you can trade.',
      '<strong>Chaotic volatility</strong> (high vol + low agreement + low control) = erratic whipsaw — dangerous.',
      '<strong>Event volatility</strong> = sudden spike vs previous hour. Often news-driven, unpredictable.',
      '<strong>Below 15</strong>: dead or chaotic — volatility is either absent or harmful. Avoid.',
      '<strong>Above 40</strong>: quality environment — price action is organized and tradable.',
      '<strong>Green bars</strong> indicate the value met the V2 engine threshold (≥30) — this engine is contributing to the Engine Confluence signal.',
    ],
  },
  liquidity: {
    field: null, label: 'Liquidity Score', title: 'Session Liquidity Overview',
    unit: '', decimals: 0, sessionLevel: true,
    thresholds: [
      { min: 60, color: '#22c55e', label: 'High liquidity' },
      { min: 30, color: '#f59e0b', label: 'Moderate liquidity' },
      { min: 0,  color: '#ef4444', label: 'Low liquidity' },
    ],
    guide: [
      '<strong>Liquidity</strong> is a derived proxy based on energy magnitude, breadth coherence, directional bias, and flow persistence.',
      '<strong>Asia session</strong> typically has lower liquidity — wider spreads on EUR/USD, GBP pairs.',
      '<strong>London session</strong> has peak liquidity — the best time for most major pairs.',
      '<strong>New York session</strong> has strong liquidity, especially during the London-NY overlap.',
      '<strong>Below 30</strong>: thin market — spreads widen, slippage risk increases. Use limit orders.',
      '<strong>Above 60</strong>: deep market — tight spreads, reliable fills. Ideal for larger positions.',
    ],
  },
  breadth: {
    field: 'breadth_score', label: 'Breadth Score', title: 'Hourly Session Breadth',
    unit: '', decimals: 0, v2Threshold: 65,
    thresholds: [
      { min: 50, color: '#22c55e', label: 'Strong breadth' },
      { min: 25, color: '#f59e0b', label: 'Moderate breadth' },
      { min: 0,  color: '#ef4444', label: 'Low breadth' },
    ],
    guide: [
      '<strong>Breadth</strong> measures what percentage of 28 pairs are actively moving each hour (above session-calibrated threshold). Higher = broader participation.',
      '<strong>Rising bars</strong> mean more pairs are engaging — the market is gaining strength and trends are more likely to continue.',
      '<strong>Falling bars</strong> mean participation is fading — fewer pairs are active, reversals or ranging conditions may follow.',
      '<strong>Green bars</strong> indicate the value met the V2 engine threshold (≥65) — this engine is contributing to the Engine Confluence signal.',
      '<strong>Low breadth</strong> (under 15) means weak participation — avoid trading as moves lack conviction.',
      '<strong>High breadth</strong> (above 50) with agreement means strong trending conditions — ideal for trend-following entries.',
    ],
  },
  momentum: {
    field: 'momentum_score', label: 'Momentum Score', title: 'Hourly Session Momentum',
    unit: '', decimals: 0, v2Threshold: 30,
    thresholds: [
      { min: 50, color: '#22c55e', label: 'Strong momentum' },
      { min: 25, color: '#f59e0b', label: 'Moderate momentum' },
      { min: 0,  color: '#ef4444', label: 'Low momentum' },
    ],
    guide: [
      '<strong>Momentum</strong> measures the magnitude and persistence of directional price moves across currency pairs. Positive = bullish bias, negative = bearish bias.',
      '<strong>Rising bars</strong> mean directional pressure is intensifying — moves are gaining follow-through.',
      '<strong>Falling bars</strong> mean momentum is fading — potential exhaustion or reversal.',
      '<strong>Green bars</strong> indicate the value met the V2 engine threshold (≥30) — this engine is contributing to the Engine Confluence signal.',
      '<strong>Below 15</strong>: weak momentum — no clear directional bias, avoid momentum strategies.',
      '<strong>Above 50</strong>: strong momentum — high conviction directional moves, trend trades are favored.',
    ],
  },
  chaos: {
    field: 'chaos_score', label: 'Chaos Score', title: 'Hourly Session Chaos',
    unit: '', decimals: 0, v2Threshold: 35, inverted: true,
    thresholds: [
      { max: 35, color: '#22c55e', label: 'Low chaos (orderly)' },
      { max: 50, color: '#f59e0b', label: 'Moderate chaos' },
      { max: Infinity, color: '#ef4444', label: 'High chaos (erratic)' },
    ],
    guide: [
      '<strong>Chaos</strong> measures erratic, unpredictable market behavior — high chaos = whipsaw, random noise, and false signals.',
      '<strong>Low values are good</strong> — orderly markets with clean price action are easier to trade.',
      '<strong>Rising bars</strong> mean conditions are deteriorating — more noise, more false breakouts.',
      '<strong>Green bars</strong> indicate the value is at or below the V2 engine threshold (≤35) — this engine is contributing to the Engine Confluence signal.',
      '<strong>Below 35</strong>: orderly market — price action is clean and tradable.',
      '<strong>Above 50</strong>: dangerous chaos — erratic moves, avoid or reduce position size significantly.',
    ],
  },
  fbr: {
    field: 'false_breakout_risk', label: 'False Breakout Risk', title: 'Hourly False Breakout Risk',
    unit: '', decimals: 0, v2Threshold: 15, inverted: true,
    thresholds: [
      { max: 15, color: '#22c55e', label: 'Low FBR (safe)' },
      { max: 30, color: '#f59e0b', label: 'Moderate FBR' },
      { max: Infinity, color: '#ef4444', label: 'High FBR (dangerous)' },
    ],
    guide: [
      '<strong>False Breakout Risk</strong> measures the likelihood that breakout moves will reverse — high FBR = traps and fakeouts.',
      '<strong>Low values are good</strong> — breakouts are more likely to follow through when FBR is low.',
      '<strong>Rising bars</strong> mean more pairs are experiencing failed breakouts — be cautious with breakout entries.',
      '<strong>Green bars</strong> indicate the value is at or below the V2 engine threshold (≤15) — this engine is contributing to the Engine Confluence signal.',
      '<strong>Below 15</strong>: breakouts are reliable — good conditions for breakout strategies.',
      '<strong>Above 30</strong>: high false breakout risk — avoid breakout entries, favor pullback and range strategies.',
    ],
  },
};

function openMetricChart(key) {
  const cfg = METRIC_CHART_CONFIG[key];
  if (!cfg) return;
  const modalId = `metric-chart-modal-${key}`;
  let modal = document.getElementById(modalId);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = modalId;
    modal.className = 'me-analysis-overlay';
    modal.addEventListener('click', e => { if (e.target === modal) closeMetricChart(key); });
    document.body.appendChild(modal);
  }
  const tz = (_userTz === 'auto') ? Intl.DateTimeFormat().resolvedOptions().timeZone : (_userTz || 'UTC');
  const tzLabel = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
  modal.innerHTML = `<div class="me-modal-panel">
    <div class="me-modal-header">
      <div class="me-modal-title"><span class="me-modal-title-label">${cfg.title}</span><span style="font-size:10px;color:var(--text-muted);margin-left:8px">${tzLabel}</span><a href="/archive.html" style="font-size:10px;color:var(--accent);margin-left:auto;text-decoration:none">Full Archive →</a></div>
      <button class="me-modal-close" onclick="closeMetricChart('${key}')">✕</button>
    </div>
    <div class="me-modal-body" style="padding:16px 20px">
      <div class="me-loading"><span class="spinner"></span> Loading ${cfg.label.toLowerCase()} data…</div>
    </div>
  </div>`;
  modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  if (cfg.sessionLevel) {
    _fetchAndRenderSessionMetric(modal, key);
  } else {
    _fetchAndRenderMetricChart(modal, key);
  }
}

function closeMetricChart(key) {
  const modal = document.getElementById(`metric-chart-modal-${key}`);
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

async function _fetchAndRenderMetricChart(modal, key) {
  const cfg = METRIC_CHART_CONFIG[key];
  try {
    const data = await api('/api/session-activity?type=hourly&days=9');
    const rows = data.hourly || [];
    if (!rows.length) {
      modal.querySelector('.me-modal-body').innerHTML = `<p class="me-empty">No hourly ${cfg.label.toLowerCase()} data available.</p>`;
      return;
    }
    _renderMetricBars(modal.querySelector('.me-modal-body'), rows, key);
  } catch (e) {
    modal.querySelector('.me-modal-body').innerHTML = `<p class="me-empty">Failed to load: ${e.message}</p>`;
  }
}

async function _fetchAndRenderSessionMetric(modal, key) {
  const cfg = METRIC_CHART_CONFIG[key];
  try {
    const data = await api('/api/market-energy-history?days=9');
    const rows = Array.isArray(data) ? data : (data.rows || []);
    if (!rows.length) {
      modal.querySelector('.me-modal-body').innerHTML = `<p class="me-empty">No session ${cfg.label.toLowerCase()} data available.</p>`;
      return;
    }
    _renderSessionLiquidityBars(modal.querySelector('.me-modal-body'), rows);
  } catch (e) {
    modal.querySelector('.me-modal-body').innerHTML = `<p class="me-empty">Failed to load: ${e.message}</p>`;
  }
}

function _renderMetricBars(container, rows, key) {
  const cfg = METRIC_CHART_CONFIG[key];
  const SESS_COLOR = { ASIA: '#f59e0b', LONDON: '#0ea5e9', NEW_YORK: '#a855f7', LOW_LIQUIDITY: '#475569' };
  const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York', LOW_LIQUIDITY: 'Low Liq.' };
  const tz = (_userTz === 'auto') ? Intl.DateTimeFormat().resolvedOptions().timeZone : (_userTz || 'UTC');
  const tzLabel = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
  const SKIP_SESSIONS = new Set(['LOW_LIQUIDITY', 'DEAD_HOURS']);

  const byDate = {};
  for (const r of rows) {
    if (SKIP_SESSIONS.has(r.session_name)) continue;
    const date = _groupDate(r);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push({
      time: r.time_utc,
      session: r.session_name,
      value: Math.round(parseFloat(r[cfg.field]) || 0),
    });
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const dates = Object.keys(byDate)
    .filter(d => {
      if (d === todayStr) return byDate[d].length >= 1;
      const sessions = new Set(byDate[d].map(b => b.session));
      return sessions.size >= 2;
    })
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 6);
  const maxVal = Math.max(80, ...rows.map(r => parseFloat(r[cfg.field]) || 0));

  let html = '<div class="bc-chart-wrap">';

  for (const date of dates) {
    const bars = byDate[date].sort((a, b) => a.time.localeCompare(b.time));
    const d = new Date(date + 'T12:00:00Z');
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });

    const values = bars.map(b => b.value);

    const sessGroups = [];
    let curGroup = null;
    for (const b of bars) {
      if (!curGroup || curGroup.session !== b.session) {
        curGroup = { session: b.session, count: 0 };
        sessGroups.push(curGroup);
      }
      curGroup.count++;
    }

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
      const pct = Math.round((b.value / maxVal) * 100);
      const localTime = new Date(b.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
      const localHour = localTime.slice(0, 2);
      const meetsThreshold = cfg.v2Threshold !== undefined
        ? (cfg.inverted ? b.value <= cfg.v2Threshold : b.value >= cfg.v2Threshold)
        : false;
      const barColor = meetsThreshold ? '#22c55e' : color;
      const cls = meetsThreshold ? 'bc-bar bc-bar-streak' : 'bc-bar';

      if (b.session !== prevSess && prevSess !== '') {
        html += '<div class="bc-sess-divider"></div>';
      }
      prevSess = b.session;

      html += `<div class="${cls}" title="${SESS_LABEL[b.session] || b.session}: ${b.value}${cfg.unit} at ${localTime} ${tzLabel}">
        <span class="bc-bar-val">${b.value}</span>
        <div class="bc-bar-inner">
          <div class="bc-bar-fill" style="height:${pct}%;background:${barColor}"></div>
        </div>
        <span class="bc-bar-hour">${localHour}</span>
      </div>`;
    }
    html += '</div>';

    // Per-day explanation
    const dayMax = Math.max(...values);
    const dayAvg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    const thresholdPasses = cfg.v2Threshold !== undefined
      ? values.filter(v => cfg.inverted ? v <= cfg.v2Threshold : v >= cfg.v2Threshold).length
      : 0;
    const peakBar = bars[values.indexOf(dayMax)];
    const peakTime = new Date(peakBar.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
    const peakSess = SESS_LABEL[peakBar.session] || peakBar.session;

    const dayLines = [];
    const t = cfg.thresholds;
    const thresholdOp = cfg.inverted ? '≤' : '≥';

    if (cfg.inverted) {
      if (dayAvg <= (t[0].max || 0)) dayLines.push(`${t[0].label} (avg ${dayAvg}${cfg.unit}) — favorable conditions throughout the day.`);
      else if (dayAvg <= (t[1].max || 0)) dayLines.push(`${t[1].label} (avg ${dayAvg}${cfg.unit}) — mixed conditions with some risk.`);
      else dayLines.push(`${t[2].label} (avg ${dayAvg}${cfg.unit}) — poor conditions for most of the day.`);
    } else {
      if (dayAvg >= t[0].min) dayLines.push(`Strong ${cfg.label.toLowerCase()} (avg ${dayAvg}${cfg.unit}) — ${t[0].label} throughout the day.`);
      else if (dayAvg >= t[1].min) dayLines.push(`Moderate ${cfg.label.toLowerCase()} (avg ${dayAvg}${cfg.unit}) — ${t[1].label} with mixed sessions.`);
      else dayLines.push(`Low ${cfg.label.toLowerCase()} (avg ${dayAvg}${cfg.unit}) — ${t[2].label} for most of the day.`);
    }

    dayLines.push(`Peak of ${dayMax}${cfg.unit} at ${peakTime} during ${peakSess}.`);

    if (cfg.v2Threshold !== undefined) {
      if (thresholdPasses > 0) dayLines.push(`${thresholdPasses}/${values.length} bars met V2 threshold (${thresholdOp}${cfg.v2Threshold}) — contributing to Engine Confluence.`);
      else dayLines.push(`No bars met V2 threshold (${thresholdOp}${cfg.v2Threshold}) — not contributing to Engine Confluence.`);
    }

    for (const g of sessGroups) {
      const sBars = bars.filter(b => b.session === g.session);
      const sAvg = Math.round(sBars.reduce((a, b) => a + b.value, 0) / sBars.length);
      const sMax = Math.max(...sBars.map(b => b.value));
      const sLabel = SESS_LABEL[g.session] || g.session;
      if (cfg.inverted) {
        if (sAvg <= (t[0].max || 0)) dayLines.push(`${sLabel}: ${t[0].label} (avg ${sAvg}${cfg.unit}, peak ${sMax}${cfg.unit}).`);
        else if (sAvg <= (t[1].max || 0)) dayLines.push(`${sLabel}: ${t[1].label} (avg ${sAvg}${cfg.unit}, peak ${sMax}${cfg.unit}).`);
        else dayLines.push(`${sLabel}: ${t[2].label} (avg ${sAvg}${cfg.unit}, peak ${sMax}${cfg.unit}).`);
      } else {
        if (sAvg >= t[0].min) dayLines.push(`${sLabel}: ${t[0].label} (avg ${sAvg}${cfg.unit}, peak ${sMax}${cfg.unit}).`);
        else if (sAvg >= t[1].min) dayLines.push(`${sLabel}: ${t[1].label} (avg ${sAvg}${cfg.unit}, peak ${sMax}${cfg.unit}).`);
        else dayLines.push(`${sLabel}: ${t[2].label} (avg ${sAvg}${cfg.unit}, peak ${sMax}${cfg.unit}).`);
      }
    }

    html += `<div class="bc-day-explain">
      <ul class="bc-explain-list">${dayLines.map(l => `<li>${l}</li>`).join('')}</ul>
    </div></div>`;
  }

  html += '</div>';

  // Guide
  html += `<div class="bc-guide">
    <div class="bc-guide-title">How to read this chart</div>
    <ul class="bc-guide-list">${cfg.guide.map(g => `<li>${g}</li>`).join('')}</ul>
  </div>`;

  const thresholdLabel = cfg.v2Threshold !== undefined
    ? `Met V2 threshold (${cfg.inverted ? '≤' : '≥'}${cfg.v2Threshold})`
    : 'Met threshold';
  html += `<div class="bc-legend">
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#f59e0b"></span> Asia</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#0ea5e9"></span> London</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#a855f7"></span> New York</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#22c55e"></span> ${thresholdLabel}</span>
  </div>`;

  container.innerHTML = html;
}

function _renderSessionLiquidityBars(container, rows) {
  const SESS_COLOR = { ASIA: '#f59e0b', LONDON: '#0ea5e9', NEW_YORK: '#a855f7', LOW_LIQUIDITY: '#475569' };
  const SESS_LABEL = { ASIA: 'Asia', LONDON: 'London', NEW_YORK: 'New York', LOW_LIQUIDITY: 'Low Liq.' };
  const tz = (_userTz === 'auto') ? Intl.DateTimeFormat().resolvedOptions().timeZone : (_userTz || 'UTC');
  const cfg = METRIC_CHART_CONFIG.liquidity;

  // Group by date, skip low_liquidity
  const byDate = {};
  for (const r of rows) {
    const sess = (r.session_name || '').toUpperCase();
    if (sess === 'LOW_LIQUIDITY' || sess === 'DEAD_HOURS') continue;
    const liq = Math.round(parseFloat(r.liquidity_score || r.session_energy_score) || 0);
    const date = (r.session_date || r.session_date_utc || r.date_utc || '').slice(0, 10);
    if (!date) continue;
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push({ session: sess, value: liq, label: SESS_LABEL[sess] || sess });
  }

  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a)).slice(0, 7);
  if (!dates.length) { container.innerHTML = '<p class="me-empty">No liquidity data available.</p>'; return; }

  const maxVal = Math.max(80, ...dates.flatMap(d => byDate[d].map(b => b.value)));

  let html = '<div class="bc-chart-wrap">';
  for (const date of dates) {
    const bars = byDate[date];
    const d = new Date(date + 'T12:00:00Z');
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });

    html += `<div class="bc-day-block">
      <div class="bc-date-header">${dayLabel}</div>
      <div class="bc-unified-chart" style="justify-content:center;gap:12px">`;

    for (const b of bars) {
      const color = SESS_COLOR[b.session] || '#64748b';
      const pct = Math.round((b.value / maxVal) * 100);
      const t = cfg.thresholds;
      const barColor = b.value >= t[0].min ? t[0].color : b.value >= t[1].min ? t[1].color : t[2].color;

      html += `<div class="bc-bar" title="${b.label}: ${b.value}" style="min-width:48px">
        <span class="bc-bar-val">${b.value}</span>
        <div class="bc-bar-inner">
          <div class="bc-bar-fill" style="height:${pct}%;background:${barColor}"></div>
        </div>
        <span class="bc-bar-hour" style="font-size:9px;white-space:nowrap;color:${color}">${b.label}</span>
      </div>`;
    }

    html += '</div>';

    // Day explanation
    const dayAvg = Math.round(bars.reduce((a, b) => a + b.value, 0) / bars.length);
    const best = bars.reduce((a, b) => b.value > a.value ? b : a, bars[0]);
    const worst = bars.reduce((a, b) => b.value < a.value ? b : a, bars[0]);
    const dayLines = [];
    if (dayAvg >= 60) dayLines.push(`Strong liquidity day (avg ${dayAvg}) — tight spreads and reliable fills across sessions.`);
    else if (dayAvg >= 30) dayLines.push(`Moderate liquidity day (avg ${dayAvg}) — some sessions offered better conditions than others.`);
    else dayLines.push(`Low liquidity day (avg ${dayAvg}) — thin market, watch for wider spreads and slippage.`);
    dayLines.push(`Best: ${best.label} (${best.value}) — deepest market for this day.`);
    if (worst.session !== best.session) dayLines.push(`Weakest: ${worst.label} (${worst.value}) — thinnest conditions.`);

    html += `<div class="bc-day-explain">
      <ul class="bc-explain-list">${dayLines.map(l => `<li>${l}</li>`).join('')}</ul>
    </div></div>`;
  }

  html += '</div>';

  html += `<div class="bc-guide">
    <div class="bc-guide-title">How to read this chart</div>
    <ul class="bc-guide-list">${cfg.guide.map(g => `<li>${g}</li>`).join('')}</ul>
  </div>`;

  html += `<div class="bc-legend">
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#f59e0b"></span> Asia</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#0ea5e9"></span> London</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#a855f7"></span> New York</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#22c55e"></span> High (60+)</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#f59e0b"></span> Moderate (30-59)</span>
    <span class="bc-legend-item"><span class="bc-legend-dot" style="background:#ef4444"></span> Low (&lt;30)</span>
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
        <div class="me-modal-metric"><span>Brd</span><strong>${Math.round(s.breadth_score||0)}</strong>${pct(s.norm_breadth)}</div>
        <div class="me-modal-metric"><span>Agr</span><strong>${Math.round(s.agreement_score||0)}</strong>${pct(s.norm_agreement)}</div>
        <div class="me-modal-metric"><span>Vol</span><strong>${Math.round(s.volatility_score||0)}</strong>${pct(s.norm_volatility)}</div>
        <div class="me-modal-metric"><span>Energy</span><strong>${Math.round(s.market_energy||0)}</strong>${pct(s.norm_energy)}</div>
        <div class="me-modal-metric"><span>Trad</span><strong>${Math.round(s.tradability_score||0)}</strong></div>
        <div class="me-modal-metric"><span>Dir</span><strong>${Math.round(s.directional_control||0)}</strong></div>
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

function _meMarketCycleBanner(cycle, latestHourly) {
  const color = cycle ? (ME_MARKET_CYCLE_COLOR[cycle] || '#64748b') : '#64748b';
  const label = cycle ? (ME_MARKET_CYCLE_LABEL[cycle]  || cycle.replace(/_/g, ' ')) : '—';

  // Check which engines meet their V2 threshold in the latest hourly bar
  function engineBtn(key, displayLabel) {
    const cfg = METRIC_CHART_CONFIG[key];
    if (!cfg || !latestHourly || cfg.sessionLevel) {
      return `<button class="me-ai-toggle me-btn-metric premium-only" onclick="openMetricChart('${key}')">${displayLabel}</button>`;
    }
    const val = parseFloat(latestHourly[cfg.field]) || 0;
    const meets = cfg.v2Threshold !== undefined
      ? (cfg.inverted ? val <= cfg.v2Threshold : val >= cfg.v2Threshold)
      : false;
    const style = meets ? ' style="background:#22c55e;color:#fff;border-color:#22c55e"' : '';
    return `<button class="me-ai-toggle me-btn-metric premium-only"${style} onclick="openMetricChart('${key}')">${displayLabel}</button>`;
  }

  return `<div class="me-cycle-banner">
    <span class="me-cycle-banner-label">Market Cycle</span>
    <span class="me-cycle-banner-val" style="--bc:${color}">${label}</span>
    ${engineBtn('energy', 'Energy')}
    ${engineBtn('tradability', 'Tradability')}
    ${engineBtn('movement', 'Movement')}
    ${engineBtn('breadth', 'Breadth')}
    ${engineBtn('agreement', 'Agreement')}
    ${engineBtn('dircontrol', 'Dir Control')}
    ${engineBtn('volquality', 'Vol Quality')}
    ${engineBtn('volatility', 'Volatility')}
    ${engineBtn('momentum', 'Momentum')}
    ${engineBtn('chaos', 'Chaos')}
    ${engineBtn('fbr', 'FB Risk')}
    ${engineBtn('liquidity', 'Liquidity')}
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
    <div class="sh-col-metric">Trad</div>
    <div class="sh-col-metric">Dir</div>
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
      const trad  = Math.round(r.tradability_score || 0);
      const tradColor = trad >= 65 ? '#22c55e' : trad >= 50 ? '#0ea5e9' : trad >= 35 ? '#f59e0b' : '#64748b';
      const dirCtrl = Math.round(r.directional_control || 0);
      const dirColor = dirCtrl >= 60 ? '#22c55e' : dirCtrl >= 35 ? '#eab308' : '#64748b';
      const bullPct = Math.round(r.bullish_breadth || 0);
      const bearPct = Math.round(r.bearish_breadth || 0);

      return `<div class="sh-row sh-data-row">
        ${dateCell}
        <div class="sh-col-sess" style="color:${SESS_COLOR[key]}">${SESS_LABEL[key]}</div>
        <div class="sh-col-cycle"><span class="sh-dot" style="background:${dot}"></span>${cycle}</div>
        <div class="sh-col-metric">${eng}</div>
        <div class="sh-col-metric" style="color:${tradColor};font-weight:600">${trad}</div>
        <div class="sh-col-metric" style="color:${dirColor}">${dirCtrl}</div>
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

function renderMarketEnergy(sessions, expansionPressure, marketCycle, currentSession, historyRows, hourlyRows) {
  const el = document.getElementById('market-activity-display');
  if (!el) return;

  if (!sessions || !sessions.length) {
    el.innerHTML = '<p class="me-empty">No energy data — run pipeline to populate.</p>';
    return;
  }

  // Live cards: use whatever sessions the API returned (today or yesterday fallback)
  const byName = Object.fromEntries(sessions.map(s => [s.session_name, s]));

  // Last 3 hourly candles (across all sessions) for the active session card
  const allHourly = (hourlyRows || [])
    .filter(h => h.session_name && h.session_name !== 'LOW_LIQUIDITY' && h.session_name !== 'DEAD_HOURS')
    .sort((a, b) => a.time_utc.localeCompare(b.time_utc));
  const lastThreeHourly = allHourly.slice(-3);

  const ORDER  = ['ASIA', 'LONDON', 'NEW_YORK'];
  // Sort: current (ACTIVE) top-left, then previous (most recent COMPLETED) top-right,
  // then older completed, then upcoming — reverse chronological within each group
  const STATUS_PRIORITY = { ACTIVE: 0, COMPLETED: 1, UPCOMING: 2 };
  const sorted = ORDER
    .map(name => ({ name, status: _meSessionStatus(name, currentSession), idx: ORDER.indexOf(name) }))
    .sort((a, b) => {
      const sp = (STATUS_PRIORITY[a.status] ?? 3) - (STATUS_PRIORITY[b.status] ?? 3);
      if (sp !== 0) return sp;
      // Within COMPLETED: most recent session first (higher index = more recent)
      if (a.status === 'COMPLETED') return b.idx - a.idx;
      return a.idx - b.idx;
    });

  // Latest hourly row for button coloring (last non-LOW_LIQUIDITY bar)
  const latestHourlyRow = allHourly.length ? allHourly[allHourly.length - 1] : null;

  el.innerHTML = `
    ${_meMarketCycleBanner(marketCycle, latestHourlyRow)}
    <div class="me-card-grid">
      ${sorted.map(({ name }) => _meSessionCard(name, byName[name] || null, _meSessionStatus(name, currentSession), lastThreeHourly)).join('')}
    </div>
    ${_meExpansionPressurePanel(expansionPressure)}
    ${_meHistoryPanel(historyRows, sessions)}`;

  fetchMarketEnergyNarrative(sessions, expansionPressure, marketCycle);
}

async function fetchMarketActivity() {
  try {
    const [data, historyRows, hourlyData] = await Promise.all([
      api('/api/market-energy').catch(() => ({ sessions: [] })),
      api('/api/market-energy-history').catch(e => { console.warn('[ME-HISTORY]', e.message); return []; }),
      api('/api/session-activity?type=hourly&days=1').catch(e => { console.warn('[ME-HOURLY]', e.message); return { hourly: [] }; }),
    ]);
    console.log('[ME-HISTORY] rows:', historyRows?.length, historyRows?.[0]);
    renderMarketEnergy(
      data.sessions       || [],
      data.expansionPressure || null,
      data.marketCycle    || null,
      data.currentSession || null,
      historyRows,
      (hourlyData.hourly || []),
    );
    updateV2ThresholdBar(hourlyData.hourly || []);
    // Re-render M15 bar + card now that _v2Confluence is set
    // (on first load, updateM15Bar ran before this async resolved → bar was hidden)
    if (_m15DataCache) {
      updateM15Bar(_m15DataCache);
      renderM15Spreads(_m15DataCache);
    }
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
        <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Flow</span><span class="jrn-sess-val">${(() => { const cs = e.currency_strength; const ccys = Array.isArray(cs) ? cs : (cs?.currencies || []); const fl = getSmoothed3HFlow(ccys.length ? ccys : null); return fl.strong.map(c => `<span style="color:#22c55e">${c}↑</span>`).join(' ') + ' ' + fl.weak.map(c => `<span style="color:#ef4444">${c}↓</span>`).join(' ') || '—'; })()}</span></div>
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

// ─── Journal: Market Environment section ─────────────────────────────────────

function renderJrnConfluenceSection(hourlyRow) {
  if (!hourlyRow) {
    return _jrnSection('⚙️ Market Environment', '<p class="jrn-empty">No hourly engine data for this snapshot.</p>');
  }

  const eval_ = evaluateV2Thresholds(hourlyRow);
  if (!eval_) {
    return _jrnSection('⚙️ Market Environment', '<p class="jrn-empty">Unable to evaluate environment.</p>');
  }

  const statusCls = eval_.fired ? 'jrn-conf-active' : 'jrn-conf-inactive';
  const grade = eval_.grade;
  const statusLabel = eval_.fired
    ? `${grade.icon} ${grade.label.toUpperCase()} (${eval_.score}/9) — ${grade.desc}`
    : '🔴 NOT FAVORABLE — Environment does not support trades';

  const explanation = eval_.fired
    ? `All ${eval_.total} environment checks passing. ${grade.desc}`
    : `${eval_.passed} of ${eval_.total} environment checks passing. Trading sections are gated until all conditions are favorable.`;

  const chipHtml = (r) => {
    const cls = r.pass ? 'jrn-conf-chip pass' : 'jrn-conf-chip fail';
    const color = V2_ENV_COLOR[r.value] || '#64748b';
    const icon = r.pass ? '✓' : '✗';
    return `<span class="${cls}" title="${r.label}: ${r.value}">
      <span class="jrn-conf-name">${r.label}</span>
      <span class="jrn-conf-val" style="color:${color}">${r.short}</span>
      <span class="jrn-conf-icon">${icon}</span>
    </span>`;
  };

  const fails = eval_.results.filter(r => !r.pass);
  const failReasons = fails.map(r => {
    return `<div class="jrn-conf-reason">✗ <strong>${r.label}</strong>: ${r.short} — not a favorable environment</div>`;
  }).join('');

  return _jrnSection('⚙️ Market Environment', `
    <div class="${statusCls}">
      <div class="jrn-conf-status">${statusLabel}</div>
      <div class="jrn-conf-score">${eval_.passed}/${eval_.total} checks · Score ${eval_.score}/9${grade ? ` · ${grade.icon} ${grade.label}` : ''}</div>
      <div class="jrn-conf-explain">${explanation}</div>
      <div class="jrn-conf-chips">
        ${eval_.results.map(chipHtml).join('')}
      </div>
      ${fails.length ? `<div class="jrn-conf-reasons"><div class="jrn-conf-reasons-title">Unfavorable:</div>${failReasons}</div>` : ''}
    </div>`);
}

// ─── Journal modal open/close ─────────────────────────────────────────────────

let _jrnCachedEnergy = null;

async function openJournalModal(id) {
  const e = _journalEntries[id];
  if (!e) return;

  // Open immediately with data we already have — no waiting
  _renderJournalModal(e, null, null, null, null);

  // Compute session context from already-loaded entries (no extra API call)
  const all = Object.values(_journalEntries).sort((a, b) => a.time.localeCompare(b.time));
  const sessionEntries = all.filter(x => x.session_name === e.session_name && x.time <= e.time);
  const prevEntry = [...all].reverse().find(x => x.time < e.time) || null; // immediately preceding entry (any session)

  // Fetch market energy + news + hourly V2 data in parallel
  let newsEvents = [];
  let hourlyMatch = null;
  try {
    const [newsR, energyR, hourlyR] = await Promise.all([
      api(`/api/news?date=${e.time.slice(0, 10)}`).catch(() => ({})),
      api('/api/market-energy').catch(() => null),
      api(`/api/session-activity?type=hourly&days=${Math.min(30, Math.ceil((Date.now() - new Date(e.time).getTime()) / 86400000) + 2)}`).catch(() => ({ hourly: [] })),
    ]);
    newsEvents = newsR.events || [];
    _jrnCachedEnergy = energyR;

    // Match hourly row to entry time (same UTC hour)
    // Normalise formats: Supabase may return "2026-05-21 14:00" or "2026-05-21T14:00"
    const entryDt = new Date(e.time);
    const entryUtcH = Date.UTC(entryDt.getUTCFullYear(), entryDt.getUTCMonth(), entryDt.getUTCDate(), entryDt.getUTCHours());
    const rows = hourlyR.hourly || [];
    hourlyMatch = rows.find(r => {
      const rd = new Date(r.time_utc);
      return Date.UTC(rd.getUTCFullYear(), rd.getUTCMonth(), rd.getUTCDate(), rd.getUTCHours()) === entryUtcH;
    }) || null;
    // Fallback: if no exact hour match, use closest row within 2 hours
    if (!hourlyMatch && rows.length) {
      const entryMs = entryDt.getTime();
      let best = null, bestDiff = Infinity;
      for (const r of rows) {
        const diff = Math.abs(new Date(r.time_utc).getTime() - entryMs);
        if (diff < bestDiff && diff <= 2 * 3600000) { bestDiff = diff; best = r; }
      }
      hourlyMatch = best;
    }
  } catch {}

  _renderJournalModal(e, newsEvents, sessionEntries, prevEntry, hourlyMatch);
}

function _renderJournalModal(e, newsEvents, sessionEntries, prevEntry, hourlyRow) {
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

  // Body — sections in order (Market Environment at top — it's the master gate)
  document.getElementById('jrn-modal-body').innerHTML = [
    renderJrnConfluenceSection(hourlyRow !== undefined ? hourlyRow : null),
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
    // Wait for plan to load first (prevents 403 cascade on cold start)
    if (_userPlanReady) await _userPlanReady;

    const [strength, signals, states, risk, actions, quality, spreads, m15Data, sessionData, journalData, profileData, volData, fpData, energySignals] = await Promise.all([
      api('/api/strength').catch(() => ({ currencies: [] })),
      api('/api/signals').catch(() => ({ signals: [] })),
      api('/api/states').catch(() => ({ states: [] })),
      api('/api/risk').catch(() => ({})),
      api('/api/actions').catch(() => ({ actions: [] })),
      api('/api/quality').catch(() => ({})),
      api('/api/spreads').catch(() => ({ spreads: [] })),
      api('/api/m15-spreads').catch(() => ({ spreads: [] })),
      api('/api/session').catch(() => ({ session: null })),
      api('/api/journal?limit=5').catch(() => ({ entries: [] })),
      api('/api/profile').catch(() => ({})),
      api('/api/volume-analysis?days=2').catch(() => ({ rows: [] })),
      api('/api/flow-performance?days=1').catch(() => ({ rows: [] })),
      api('/api/energy-signals').catch(() => ({ currencies: [], pairs: [], energy: 0, thresholdMet: false })),
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
    applyV2Gate(); // Gate sections before render — will update once fetchMarketActivity resolves
    fetchMarketActivity(); // non-blocking — separate fetch, renders independently + updates V2 gate
    // fetchMomentumSignal(); // disabled — momentum bar removed from header
    buildChart(strength, activeTF);
    renderCurrencySignals(strength);          // must run first — populates _csigCurrencies
    renderLiveOpportunities(states.states || []);
    renderTopSetups(states.states || []);
    renderSignals(signals, states.states || [], journalData?.entries || []);
    _m15DataCache = m15Data;   // Cache for ME card flow ranking + scanner
    _volDataCache = _buildVolMap(volData);  // Cache volume analysis: instrument → latest row
    _fpPrecomputed = fpData?.rows || [];    // Pre-computed flow performance (free plan — all metrics baked in)
    _energySignalsCache = energySignals;    // Energy signal pairs for Strength Flow
    _scheduleEnergyRefresh(energySignals);  // Auto-retry if empty, periodic background refresh
    renderStates(states, m15Data);
    renderSpreads(spreads);
    renderRanking12H(spreads, strength);
    renderFlowPerformance(strength, m15Data);
    renderM15Spreads(m15Data);
    updateM15Bar(m15Data);
    renderRisk(risk);
    renderActions(actions);
    renderQuality(quality);
    renderJournal(journalData);
    renderEnergySignals(energySignals);

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
    'flow-perf-list':      4,
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

// ─── Backtesting Tab ─────────────────────────────────────────────────────────

let _btEquityChart = null;

// ─── Engine Definitions ─────────────────────────────────────────────────────

const BT_ENGINES = [
  { id: 'component_thresholds', name: 'Component Thresholds', icon: 'sliders-horizontal',
    desc: 'Every indicator analyzed individually — find exact thresholds for movement, momentum, agreement, volatility, energy, pressure, liquidity, readiness, CS, and confidence.' },
  { id: 'conditional_edge', name: 'Conditional Edge', icon: 'layers',
    desc: 'Multi-factor stacking — discover how combining CS Diff + Energy + Agreement + Session + State compounds your win rate from baseline to 80%+.' },
  { id: 'heatmaps', name: 'Cross-Component Heatmaps', icon: 'grid-3x3',
    desc: 'Win rate at every intersection of two indicators. Reveals non-linear edge clusters that single-factor analysis misses entirely.' },
  { id: 'regime_thresholds', name: 'Regime Thresholds', icon: 'repeat',
    desc: 'Optimal thresholds per market regime (Dead, Compression, Breakout, Expansion, Exhaustion). The same indicator needs different thresholds per regime.' },
  { id: 'session_thresholds', name: 'Session Thresholds', icon: 'clock',
    desc: 'Per-session optimal filters — Asia needs higher agreement, London tolerates volatility, NY rewards dominance. Unique thresholds per window.' },
  { id: 'transitions', name: 'Transition Discovery', icon: 'arrow-right-left',
    desc: 'What happens when the market regime shifts. Compression→Expansion breakouts, Trend→Exhaustion danger — where the biggest moves and risks live.' },
  { id: 'edge_stability', name: 'Edge Stability', icon: 'shield-check',
    desc: 'Are discovered edges stable or decaying? Monthly win rate tracking, variance, decay detection, and stability scores to prevent overfitting.' },
  { id: 'probability_curves', name: 'Probability Curves', icon: 'trending-up',
    desc: 'Progressive probability — see exactly how continuation probability rises with each indicator value. No hard thresholds, just smooth probability gradients.' },
  { id: 'energy_thresholds', name: 'Energy Deep Dive', icon: 'zap',
    desc: 'Detailed breakdown of each energy sub-component (movement, momentum, agreement, volatility) bucketed by range with continuation rates.' },
  { id: 'strength_thresholds', name: 'Strength Thresholds', icon: 'gauge',
    desc: 'Currency strength differential analysis — at what spread level does directional edge appear, and how does reward-to-risk scale with spread size.' },
  { id: 'state_outcomes', name: 'State Outcomes', icon: 'git-branch',
    desc: 'Win rate and pip performance for every market state (Trend, Pullback, Ready-to-Enter, Reversal, No Trade). Confirms which states to trade and avoid.' },
  { id: 'no_trade_zones', name: 'No-Trade Zones', icon: 'shield-off',
    desc: 'Conditions where trades consistently lose money — low energy + low agreement, thin markets, choppy volatility. Hard rules for when NOT to trade.' },
  { id: 'condition_combos', name: 'Condition Combos', icon: 'puzzle',
    desc: 'Best multi-condition setups: High Energy + Agreement + Ready-to-Enter, Strong Trends, Compression Breakouts. The highest-probability entry patterns.' },
  { id: 'move_distance', name: 'Move Distance', icon: 'ruler',
    desc: 'Expected pip distance at 1H, 4H, 8H, 12H, 24H horizons — broken by energy level. Calibrate TP targets and stop losses to actual market data.' },
  { id: 'session_performance', name: 'Session Performance', icon: 'bar-chart-3',
    desc: 'Which trading session produces the biggest and most reliable moves. Average energy, 4H and 8H pip ranges per session window.' },
];

let _btSelectedEngine = null;

function _btInit() {
  const to = new Date();
  const from = new Date();
  from.setUTCMonth(from.getUTCMonth() - 6);
  const el = (id) => document.getElementById(id);
  if (el('bt-from')) el('bt-from').value = from.toISOString().slice(0, 10);
  if (el('bt-to'))   el('bt-to').value   = to.toISOString().slice(0, 10);

  // Render engine selector grid
  const grid = el('bt-engine-grid');
  if (grid) {
    grid.innerHTML = BT_ENGINES.map(e => `
      <div class="bt-engine-card" data-engine="${e.id}" onclick="_btSelectEngine('${e.id}')">
        <div class="bt-engine-icon"><i data-lucide="${e.icon}" style="width:20px;height:20px"></i></div>
        <div class="bt-engine-info">
          <div class="bt-engine-name">${e.name}</div>
          <div class="bt-engine-desc">${e.desc}</div>
        </div>
      </div>
    `).join('');
    if (window.lucide) lucide.createIcons();
  }

  // _btLoadHistory(); // removed — no longer storing runs in Supabase
}

function _btSelectEngine(engineId) {
  _btSelectedEngine = engineId;
  const engine = BT_ENGINES.find(e => e.id === engineId);

  // Update selected state
  document.querySelectorAll('.bt-engine-card').forEach(c => {
    c.classList.toggle('bt-engine-selected', c.dataset.engine === engineId);
  });

  // Enable run button with engine name
  const btn = document.getElementById('bt-run-btn');
  const label = document.getElementById('bt-run-label');
  if (btn) btn.disabled = false;
  if (label) label.textContent = `Run ${engine?.name || 'Discovery'}`;

  // Hide previous results
  const resultSection = document.getElementById('section-bt-result');
  if (resultSection) resultSection.classList.add('bt-hidden');
}

async function runBacktest() {
  if (!_btSelectedEngine) return;

  const el = (id) => document.getElementById(id);
  const btn    = el('bt-run-btn');
  const status = el('bt-status');
  const from   = el('bt-from')?.value;
  const to     = el('bt-to')?.value;

  if (!from || !to) { status.textContent = 'Please select date range.'; return; }

  const engine = BT_ENGINES.find(e => e.id === _btSelectedEngine);
  btn.disabled = true;
  status.innerHTML = `<span class="bt-spinner"></span> Running ${engine?.name || 'analysis'} — this may take a few minutes...`;

  try {
    const data = await api('/api/backtest-run', {
      method: 'POST',
      body: JSON.stringify({ from, to, engine: _btSelectedEngine }),
    });

    status.textContent = `${engine?.name}: ${data.snapshots_analyzed} hourly snapshots analyzed in ${data.duration_sec}s`;

    // Render header
    const header = el('bt-result-header');
    if (header) {
      header.innerHTML = `<h2 class="card-title"><i data-lucide="${engine?.icon || 'flask-conical'}"></i> ${engine?.name || 'Results'}</h2>
        <p class="bt-section-subtitle">${engine?.desc || ''}</p>`;
    }

    // Render the single engine result into bt-result-body
    const body = el('bt-result-body');
    if (body) body.innerHTML = ''; // clear previous

    const a = data.analysis;
    const ins = data.insights || {};
    const key = _btSelectedEngine;

    // Each renderer now targets bt-result-body
    _btRenderEngine(key, a[key], ins[key], body);

    // Show result section
    const resultSection = el('section-bt-result');
    if (resultSection) resultSection.classList.remove('bt-hidden');

    // _btLoadHistory(); // removed — no longer storing runs in Supabase
    if (window.lucide) lucide.createIcons();

  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// Master dispatch — renders a single engine's data into a target container
function _btRenderEngine(key, data, insight, container) {
  if (!data || !container) return;

  // Create a temporary div, render into it, then append to container
  const wrap = document.createElement('div');
  wrap.id = `bt-${key.replace(/_/g, '-')}-result`;
  container.appendChild(wrap);

  // Map engine keys to renderer functions
  const renderers = {
    component_thresholds: () => { wrap.innerHTML = ''; _btRenderComponentThresholdsInto(data, insight, wrap); },
    conditional_edge:     () => { _btRenderConditionalEdgeInto(data, insight, wrap); },
    heatmaps:             () => { _btRenderHeatmapsInto(data, insight, wrap); },
    regime_thresholds:    () => { _btRenderRegimeThresholdsInto(data, insight, wrap); },
    session_thresholds:   () => { _btRenderSessionThresholdsInto(data, insight, wrap); },
    transitions:          () => { _btRenderTransitionsInto(data, insight, wrap); },
    edge_stability:       () => { _btRenderEdgeStabilityInto(data, insight, wrap); },
    probability_curves:   () => { _btRenderProbabilityCurvesInto(data, insight, wrap); },
    energy_thresholds:    () => { _btRenderEnergyThresholdsInto(data, insight, wrap); },
    strength_thresholds:  () => { _btRenderStrengthThresholdsInto(data, insight, wrap); },
    state_outcomes:       () => { _btRenderStateOutcomesInto(data, insight, wrap); },
    no_trade_zones:       () => { _btRenderNoTradeZonesInto(data, insight, wrap); },
    condition_combos:     () => { _btRenderConditionCombosInto(data, insight, wrap); },
    move_distance:        () => { _btRenderMoveDistanceInto(data, insight, wrap); },
    session_performance:  () => { _btRenderSessionPerfInto(data, insight, wrap); },
  };

  if (renderers[key]) renderers[key]();
}

// ═══════════════════════════════════════════════════════════════════════════
// *Into() renderers — ultra-detailed, explainable for every user
// ═══════════════════════════════════════════════════════════════════════════

// Shared helpers for rich presentation
function _btWhatIs(icon, title, description) {
  return `<div class="bt-what-is">
    <div class="bt-what-is-icon"><i data-lucide="${icon}" style="width:22px;height:22px"></i></div>
    <div class="bt-what-is-text"><h4>${title}</h4><p>${description}</p></div>
  </div>`;
}

function _btFindings(cards) {
  if (!cards.length) return '';
  return `<div class="bt-findings">
    <div class="bt-findings-title"><i data-lucide="target" style="width:15px;height:15px"></i> Key Findings</div>
    <div class="bt-findings-grid">${cards.map(c => `<div class="bt-finding bt-finding-${c.type || 'info'}">
      <div class="bt-finding-label">${c.label}</div>
      <div class="bt-finding-value">${c.value}</div>
      <div class="bt-finding-desc">${c.desc}</div>
    </div>`).join('')}</div>
  </div>`;
}

function _btGuide(lines) {
  return `<div class="bt-guide">
    <div class="bt-guide-title"><i data-lucide="info" style="width:12px;height:12px"></i> How To Read This</div>
    <ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>
  </div>`;
}

function _btActionBox(actions) {
  return `<div class="bt-action-box">
    <div class="bt-action-title"><i data-lucide="check-circle" style="width:14px;height:14px"></i> Trading Actions</div>
    <ul>${actions.map(a => `<li>${a}</li>`).join('')}</ul>
  </div>`;
}

function _btHmLegend() {
  return `<div class="bt-legend">
    <span style="font-weight:600">Win Rate Scale:</span>
    <div class="bt-legend-item"><div class="bt-legend-swatch" style="background:#ef4444"></div>&lt;48% Avoid</div>
    <div class="bt-legend-item"><div class="bt-legend-swatch" style="background:#f97316"></div>48–52% Weak</div>
    <div class="bt-legend-item"><div class="bt-legend-swatch" style="background:rgba(255,255,255,.15)"></div>52–56% Neutral</div>
    <div class="bt-legend-item"><div class="bt-legend-swatch" style="background:#22c55e"></div>56–62% Good</div>
    <div class="bt-legend-item"><div class="bt-legend-swatch" style="background:#10b981"></div>62%+ Excellent</div>
  </div>`;
}

// ─── 1. Component Thresholds ────────────────────────────────────────────────

function _btRenderComponentThresholdsInto(components, insights, wrap) {
  if (!components || !components.length) { wrap.innerHTML = '<div style="color:var(--text-muted)">No component data</div>'; return; }

  let html = _btWhatIs('sliders-horizontal', 'What This Analysis Shows',
    'Every individual indicator in the NervaFX system has been tested independently across your entire date range. For each indicator (movement, momentum, agreement, volatility, energy, bull/bear pressure, dominance, liquidity, readiness, CS diff, confidence, etc.), we bucketed the data into ranges and measured: <strong>how often price moved in the expected direction (win rate)</strong>, how far it moved favorably, and how far it moved against you. This tells you the exact threshold where each indicator starts giving you a real trading edge.');

  // Build summary findings
  const bestComp = [...components].sort((a, b) => (b.best_win_rate || 0) - (a.best_win_rate || 0))[0];
  const worstComp = [...components].filter(c => c.worst_win_rate != null).sort((a, b) => (a.worst_win_rate || 100) - (b.worst_win_rate || 100))[0];
  const edgeComps = components.filter(c => c.min_edge_threshold != null);

  const findings = [];
  if (bestComp?.best_win_rate) findings.push({ type: 'good', label: 'Strongest indicator', value: `${bestComp.best_win_rate}% WR`, desc: `${bestComp.name} at ${bestComp.best_range}${bestComp.unit} produces the highest win rate of any single indicator.` });
  findings.push({ type: 'info', label: 'Indicators tested', value: `${components.length}`, desc: `Each indicator independently analyzed across all hourly snapshots in your date range.` });
  if (edgeComps.length) findings.push({ type: 'warn', label: 'With clear edge thresholds', value: `${edgeComps.length} of ${components.length}`, desc: `These indicators have a provable minimum value where your edge begins — below it, you have no advantage.` });
  if (worstComp?.worst_win_rate < 45) findings.push({ type: 'bad', label: 'Danger zone found', value: `${worstComp.worst_win_rate}% WR`, desc: `${worstComp.name} at ${worstComp.worst_range}${worstComp.unit} actively loses money. Avoid trading when this indicator is in this range.` });

  html += _btFindings(findings);
  html += _btInsightBox(insights && insights.summary ? insights : null);

  html += _btGuide([
    '<strong>★ Sweet Spot</strong> = the range where this indicator produces the highest win rate. Trade here.',
    '<strong>Min Edge</strong> = the minimum value needed before this indicator gives you ANY advantage over random.',
    '<strong>⚠ Danger</strong> = ranges where win rate drops below 48%. These conditions actively lose money.',
    '<strong>Win Rate</strong> = % of times price moved in the favorable direction within the next few hours.',
    '<strong>Avg Fav / Adv</strong> = average pips that moved in your favor vs. against you. Higher fav and lower adv = better.',
    'Click any component card to expand and see the full data table with every range bucket.',
  ]);

  // Group components
  const groups = {};
  for (const comp of components) {
    if (!groups[comp.group]) groups[comp.group] = [];
    groups[comp.group].push(comp);
  }
  const insightMap = {};
  if (insights && insights.length) for (const ins of insights) insightMap[ins.id] = ins;

  const groupIcons = { 'Market Energy': 'zap', 'Directional Pressure': 'arrow-up-down', 'Market Structure': 'git-branch', 'Currency Strength': 'gauge', 'Quality Metrics': 'shield-check' };
  const groupDescs = {
    'Market Energy': 'How much the market is moving and how strong that movement is. Higher energy = bigger potential trades, but also more risk.',
    'Directional Pressure': 'Whether bulls or bears are in control. Measures the one-sided dominance of the market — the more one side dominates, the clearer the direction.',
    'Market Structure': 'The underlying market condition — is it trending, pulling back, ready for entry, or in no-trade territory?',
    'Currency Strength': 'How strong or weak each individual currency is. A large spread between the two currencies in a pair = strong directional bias.',
    'Quality Metrics': 'Confidence and reliability scores that tell you how trustworthy the current signal is.',
  };

  for (const [groupName, comps] of Object.entries(groups)) {
    const icon = groupIcons[groupName] || 'bar-chart-3';
    html += `<div class="bt-comp-group">
      <div class="bt-comp-group-header"><i data-lucide="${icon}" style="width:16px;height:16px"></i><span>${groupName}</span></div>
      <div class="bt-explain-row">${groupDescs[groupName] || ''}</div>`;

    for (const comp of comps) {
      const ins = insightMap[comp.id];
      const ranges = comp.ranges || {};
      const rangeKeys = Object.keys(ranges).sort((a, b) => (parseFloat(a.split('–')[0]) || 0) - (parseFloat(b.split('–')[0]) || 0));

      let badges = '';
      if (comp.best_range) badges += `<span class="bt-comp-badge bt-comp-badge-best">Sweet Spot: ${comp.best_range}${comp.unit} (${comp.best_win_rate}% WR)</span>`;
      if (comp.min_edge_threshold) badges += `<span class="bt-comp-badge bt-comp-badge-min">Min Edge: ≥${comp.min_edge_threshold}${comp.unit}</span>`;
      if (comp.worst_range && comp.worst_win_rate < 48) badges += `<span class="bt-comp-badge bt-comp-badge-danger">Danger: ${comp.worst_range}${comp.unit} (${comp.worst_win_rate}% WR)</span>`;

      let insightHtml = '';
      if (ins && (ins.summary || ins.bullets?.length)) {
        insightHtml = '<div class="bt-comp-insight">';
        if (ins.summary) insightHtml += `<div class="bt-comp-insight-summary">${ins.summary}</div>`;
        if (ins.bullets?.length) { insightHtml += '<ul class="bt-comp-insight-bullets">'; for (const b of ins.bullets) insightHtml += `<li>${b}</li>`; insightHtml += '</ul>'; }
        insightHtml += '</div>';
      }

      let tableHtml = '';
      if (rangeKeys.length) {
        tableHtml = '<div class="bt-explain-row" style="font-size:10px;margin-bottom:6px"><strong>Reading the table:</strong> Each row is a range of values for ' + comp.name + '. The ★ row is the sweet spot. Green = profitable range. Red = losing range.</div>';
        tableHtml += `<table class="bt-inst-table bt-comp-table">
          <thead><tr><th>${comp.name} Range</th><th>Hours Observed</th><th>Trade Samples</th><th>Win Rate</th><th>Avg Pips For You</th><th>Avg Pips Against</th><th>Net Pips</th></tr></thead><tbody>`;
        for (const key of rangeKeys) {
          const r = ranges[key];
          if (r.insufficient) { tableHtml += `<tr class="bt-comp-row-dim"><td>${key}</td><td>${r.hours}h</td><td>${r.trades}</td><td colspan="4" style="color:var(--text-muted);font-style:italic">Not enough trades to be reliable</td></tr>`; continue; }
          const isBest = key === comp.best_range, isWorst = key === comp.worst_range && comp.worst_win_rate < 48;
          const rowCls = isBest ? 'bt-comp-row-best' : isWorst ? 'bt-comp-row-worst' : '';
          const wrCls = r.win_rate >= 55 ? 'bt-win' : r.win_rate < 45 ? 'bt-loss' : '';
          tableHtml += `<tr class="${rowCls}"><td><strong>${key}</strong>${isBest ? ' ★' : ''}${isWorst ? ' ⚠' : ''}</td><td>${r.hours}h</td><td>${r.trades}</td><td class="${wrCls}"><strong>${r.win_rate}%</strong></td><td class="bt-win">+${r.avg_fav}p</td><td class="bt-loss">-${r.avg_adv}p</td><td>${r.avg_move}p</td></tr>`;
        }
        tableHtml += '</tbody></table>';
      }

      html += `<div class="bt-comp-card" id="bt-comp-${comp.id}">
        <div class="bt-comp-header" onclick="this.parentElement.classList.toggle('bt-comp-expanded')">
          <div class="bt-comp-title-row"><span class="bt-comp-expand-icon">▶</span><span class="bt-comp-name">${comp.name}</span><span class="bt-comp-desc">${comp.description}</span></div>
          <div class="bt-comp-badges">${badges}</div>
        </div>
        <div class="bt-comp-body">${insightHtml}${tableHtml}</div>
      </div>`;
    }
    html += '</div>';
  }

  html += _btActionBox([
    '<strong>Build your filter checklist:</strong> For every indicator, note the "Min Edge" threshold. Only take trades when each indicator is above its minimum.',
    '<strong>Target the sweet spots:</strong> The ★ ranges give you the highest probability. When multiple indicators are all in their sweet spots simultaneously, your edge compounds.',
    '<strong>Hard-avoid danger zones:</strong> If any indicator shows ⚠ Danger, that single condition is enough to skip the trade — even if everything else looks perfect.',
    '<strong>Focus on high-impact indicators:</strong> Indicators with the biggest spread between best and worst win rates matter most. A component where best=65% and worst=35% is far more important than one where best=53% and worst=49%.',
  ]);

  wrap.innerHTML = html;
}

// ─── 2. Conditional Edge ─────────────────────────────────────────────────────

function _btRenderConditionalEdgeInto(data, insight, wrap) {
  if (!data?.chains) { wrap.innerHTML = '<div style="color:var(--text-muted)">No data</div>'; return; }

  let html = _btWhatIs('layers', 'What This Analysis Shows',
    'This is the most powerful analysis in NervaFX. Instead of looking at indicators one at a time, we <strong>stack multiple filters together</strong> and measure how your win rate improves with each additional condition. Think of it like a checklist — the more boxes you tick, the higher your probability. Each "chain" starts from a baseline (all trades) and progressively adds filters: first currency strength, then energy, then agreement, then session timing, etc. You can see exactly how much each additional filter improves your odds.');

  // Extract best chain stats
  const validChains = data.chains.filter(c => c.steps?.length >= 2);
  let bestFinalWR = 0, bestChainName = '', totalLift = 0, bestStart = 0;
  for (const chain of validChains) {
    const last = chain.steps[chain.steps.length - 1];
    const first = chain.steps[0];
    if (last?.win_rate > bestFinalWR) {
      bestFinalWR = last.win_rate;
      bestChainName = chain.name;
      bestStart = first?.win_rate || 0;
      totalLift = bestFinalWR - bestStart;
    }
  }

  html += _btFindings([
    { type: 'good', label: 'Best stacked win rate', value: `${bestFinalWR}%`, desc: `The "${bestChainName}" chain reaches ${bestFinalWR}% when all filters are applied simultaneously.` },
    { type: 'info', label: 'Total lift achieved', value: `+${totalLift}pp`, desc: `From ${bestStart}% baseline to ${bestFinalWR}% — that is ${totalLift} percentage points of edge created by stacking conditions.` },
    { type: 'info', label: 'Filter chains tested', value: `${validChains.length}`, desc: `Each chain stacks 3-5 conditions in different orders to find the optimal combination path.` },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    'Each chain reads <strong>top to bottom</strong>. The first bar is the baseline (no filters). Each subsequent bar adds one more condition.',
    'The <strong>+number</strong> next to each bar shows how many percentage points that single filter added to your win rate.',
    '<strong>Bar colors:</strong> Red = below 50% (losing), Grey = 50-55% (breakeven), Yellow = 55-65% (profitable), Green = 65%+ (strong edge).',
    'The <strong>samples count</strong> decreases as you add filters — this is normal. Fewer but higher-quality trades is the goal.',
    'Look for chains where the final step has <strong>at least 100+ trades</strong> — below that, the result may not be reliable.',
  ]);

  for (const chain of validChains) {
    html += `<div class="bt-chain"><div class="bt-chain-name">${chain.name}</div><div class="bt-chain-desc">${chain.desc}</div><div class="bt-chain-steps">`;

    for (let i = 0; i < chain.steps.length; i++) {
      const s = chain.steps[i];
      if (!s.win_rate) continue;
      const lift = i > 0 ? s.win_rate - chain.steps[i - 1].win_rate : 0;
      const barW = Math.max(8, Math.min(100, s.win_rate));
      const barCls = s.win_rate >= 65 ? 'bt-bar-hot' : s.win_rate >= 55 ? 'bt-bar-warm' : s.win_rate >= 50 ? 'bt-bar-neutral' : 'bt-bar-cold';
      const stepExplain = i === 0 ? '(Starting point — all trades, no filter)' : `(Added this filter: ${lift > 0 ? '+' + lift + ' percentage points' : 'no improvement'})`;

      html += `<div class="bt-chain-step">
        <div class="bt-chain-label">${s.label} <span style="font-weight:400;color:var(--text-muted);font-size:10px">${stepExplain}</span></div>
        <div class="bt-chain-bar-wrap"><div class="bt-chain-bar ${barCls}" style="width:${barW}%"></div><span class="bt-chain-wr">${s.win_rate}%</span>${lift > 0 ? `<span class="bt-chain-lift">+${lift}</span>` : ''}</div>
        <div class="bt-chain-meta">${s.samples} trades · avg +${s.avg_fav}p in your favor · avg -${s.avg_adv}p against you · net ${(s.avg_fav - s.avg_adv).toFixed(1)}p per trade</div>
      </div>`;
    }
    html += '</div></div>';
  }

  html += _btActionBox([
    '<strong>Use the best chain as your trading checklist.</strong> Before entering any trade, verify that each condition in the chain is met.',
    '<strong>More filters = higher win rate but fewer trades.</strong> Decide your trade-off: the 3rd filter alone might get you 60% WR with plenty of opportunities, while the 5th gets 75% but only a few trades per week.',
    '<strong>The biggest single lift tells you the most important filter.</strong> If adding "Energy > 40" adds +8pp but "Agreement > 60" adds +3pp, energy is far more critical to check.',
    '<strong>Minimum 50+ samples on the final step</strong> for the result to be tradeable. Below that, it could be noise.',
  ]);

  wrap.innerHTML = html;
}

// ─── 3. Heatmaps ─────────────────────────────────────────────────────────────

function _btRenderHeatmapsInto(data, insight, wrap) {
  if (!data?.length) { wrap.innerHTML = '<div style="color:var(--text-muted)">No heatmap data</div>'; return; }

  let html = _btWhatIs('grid-3x3', 'What This Analysis Shows',
    'Heatmaps reveal what happens when <strong>two indicators combine</strong>. Each cell shows the win rate for trades where both the X-axis indicator AND the Y-axis indicator were in that specific range at the same time. Bright green cells = high probability zones. Red cells = danger zones. This exposes non-linear patterns that single-indicator analysis completely misses — sometimes two mediocre indicators create an incredible edge together.');

  // Find best and worst cells across all heatmaps
  let bestCell = { wr: 0 }, worstCell = { wr: 100 };
  for (const hm of data) {
    for (let y = 0; y < hm.y_labels.length; y++) {
      for (let x = 0; x < hm.x_labels.length; x++) {
        const c = hm.cells[y][x];
        if (c.wr != null && c.samples >= 20) {
          if (c.wr > bestCell.wr) bestCell = { wr: c.wr, x: hm.x_labels[x], y: hm.y_labels[y], name: hm.name, samples: c.samples };
          if (c.wr < worstCell.wr) worstCell = { wr: c.wr, x: hm.x_labels[x], y: hm.y_labels[y], name: hm.name, samples: c.samples };
        }
      }
    }
  }

  html += _btFindings([
    { type: 'good', label: 'Best combination', value: `${bestCell.wr}% WR`, desc: `${bestCell.name}: ${bestCell.x} × ${bestCell.y} (${bestCell.samples} trades). This is the highest probability intersection found.` },
    { type: 'bad', label: 'Worst combination', value: `${worstCell.wr}% WR`, desc: `${worstCell.name}: ${worstCell.x} × ${worstCell.y} (${worstCell.samples} trades). Avoid this combination.` },
    { type: 'info', label: 'Heatmaps analyzed', value: `${data.length}`, desc: `Each heatmap tests a different pair of indicators against each other to find hidden edge clusters.` },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    'Each heatmap is a grid. <strong>Rows = one indicator, Columns = another indicator.</strong>',
    'Find the <strong>brightest green cluster</strong> — that is where both indicators align to create the strongest edge.',
    '<strong>Hover or tap any cell</strong> to see the exact trade count and average pip gain.',
    'Cells marked "—" had too few trades to be statistically meaningful.',
    'Look for <strong>diagonal patterns</strong> — these suggest the two indicators amplify each other as they both increase.',
  ]);

  html += _btHmLegend();

  for (const hm of data) {
    html += `<div class="bt-heatmap"><div class="bt-heatmap-title">${hm.name}</div>
      <div class="bt-heatmap-labels"><span>Columns (X): ${hm.x_label}</span> <span>Rows (Y): ${hm.y_label}</span></div>
      <table class="bt-hm-table"><thead><tr><th>${hm.y_label} \\ ${hm.x_label}</th>${hm.x_labels.map(l => `<th>${l}</th>`).join('')}</tr></thead><tbody>`;
    for (let y = hm.y_labels.length - 1; y >= 0; y--) {
      html += `<tr><td class="bt-hm-rowlabel">${hm.y_labels[y]}</td>`;
      for (let x = 0; x < hm.x_labels.length; x++) {
        const c = hm.cells[y][x];
        if (c.wr == null) { html += '<td class="bt-hm-cell bt-hm-na">—</td>'; }
        else {
          const cls = c.wr >= 62 ? 'bt-hm-5' : c.wr >= 56 ? 'bt-hm-4' : c.wr >= 52 ? 'bt-hm-3' : c.wr >= 48 ? 'bt-hm-2' : 'bt-hm-1';
          html += `<td class="bt-hm-cell ${cls}" title="${c.samples} trades · +${c.avg_fav || 0}p avg favourable">${c.wr}%</td>`;
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  html += _btActionBox([
    '<strong>Memorize the green clusters.</strong> When you see both indicators in that range simultaneously on the live dashboard, it is a high-probability moment.',
    '<strong>Red zones are hard no-trade rules.</strong> Even if the signal looks good, if both indicators fall in a red cell, the historical data says you lose money.',
    '<strong>Combine with Component Thresholds.</strong> Use single-indicator sweet spots as your baseline filter, then use heatmaps to find the bonus combinations that push win rate even higher.',
  ]);

  wrap.innerHTML = html;
}

// ─── 4. Regime Thresholds ────────────────────────────────────────────────────

function _btRenderRegimeThresholdsInto(data, insight, wrap) {
  if (!data) { wrap.innerHTML = '<div style="color:var(--text-muted)">No regime data</div>'; return; }

  let html = _btWhatIs('repeat', 'What This Analysis Shows',
    'The market constantly shifts between different "regimes" — Dead (no movement), Compression (building energy), Breakout (starting to move), Expansion (strong trend), Exhaustion (trend ending), and Transition (changing). <strong>The same indicator threshold that works in Expansion will fail in Compression.</strong> This analysis finds the optimal threshold for each indicator within each specific regime, so you know exactly how to adjust your filters based on current market conditions.');

  const regimes = Object.entries(data).sort((a, b) => (b[1].baseline?.win_rate || 0) - (a[1].baseline?.win_rate || 0));
  const validRegimes = regimes.filter(([_, d]) => !d.insufficient);
  const bestRegime = validRegimes[0];
  const worstRegime = validRegimes[validRegimes.length - 1];

  const regimeExplains = {
    'DEAD': 'Market is barely moving. Very low energy and no clear direction. Usually worst for trading.',
    'COMPRESSION': 'Energy is building but hasnt released yet. Like a spring being compressed — breakout coming but timing uncertain.',
    'CHOPPY': 'Market is active but has no clear direction. Lots of movement, but it keeps reversing. Difficult to trade.',
    'BREAKOUT': 'Market just broke out of compression or range. Energy is surging. Can be the start of a big move.',
    'EXPANSION': 'Strong directional trend underway. High energy, clear direction. Best conditions for trend-following.',
    'EXHAUSTION': 'Trend is running out of steam. Still moving but losing momentum. Reversal risk is high.',
    'TRANSITION': 'Regime is changing. The market is shifting from one state to another. Unpredictable period.',
    'BUILDING': 'Momentum is increasing. Not yet a full breakout but conditions are aligning for a move.',
  };

  const findings = [];
  if (bestRegime) findings.push({ type: 'good', label: 'Best regime to trade', value: `${bestRegime[0]}`, desc: `Baseline win rate of ${bestRegime[1].baseline?.win_rate}% — even without any filters, this regime already favors continuation. With optimal thresholds, it gets even higher.` });
  if (worstRegime && worstRegime[1].baseline?.win_rate < 50) findings.push({ type: 'bad', label: 'Worst regime to trade', value: `${worstRegime[0]}`, desc: `Baseline only ${worstRegime[1].baseline?.win_rate}% — trading in this regime is nearly a coin flip even before filters.` });
  findings.push({ type: 'info', label: 'Regimes discovered', value: `${validRegimes.length}`, desc: 'Each regime has its own unique set of optimal indicator thresholds.' });

  html += _btFindings(findings);
  html += _btInsightBox(insight);

  html += _btGuide([
    'Each card is one market regime. The <strong>baseline</strong> is the win rate for ALL trades in that regime with no filters.',
    'The table shows which indicators have an <strong>optimal threshold</strong> for that specific regime.',
    '<strong>"Optimal Threshold"</strong> means: when this indicator is ≥ this value during this regime, your win rate jumps to the "Win Rate" column.',
    'If a regime says "No filter significantly improves baseline," it means the regime itself is already so strong (or so weak) that individual filters do not help much.',
  ]);

  for (const [regime, d] of regimes) {
    if (d.insufficient) {
      html += `<div class="bt-regime-card"><div class="bt-regime-name">${regime}</div><div class="bt-regime-insuff">${d.hours} hours · ${d.total_trades} trades — not enough data for reliable analysis</div></div>`;
      continue;
    }

    const optEntries = Object.entries(d.optimal || {}).filter(([_, v]) => v.threshold != null);
    const baseCls = d.baseline?.win_rate >= 55 ? 'good' : d.baseline?.win_rate >= 50 ? 'warn' : 'bad';

    html += `<div class="bt-regime-card">
      <div class="bt-regime-header">
        <span class="bt-regime-name">${regime}</span>
        <span class="bt-regime-base">Baseline: <strong>${d.baseline?.win_rate}%</strong> WR · ${d.total_trades} trades · ${d.hours} hours</span>
      </div>
      <div class="bt-explain-row">${regimeExplains[regime] || 'Market condition with unique characteristics.'}</div>`;

    if (optEntries.length) {
      html += '<div class="bt-explain-row" style="font-size:10px"><strong>Optimal filters for this regime:</strong> Apply these thresholds ONLY when the market is in ' + regime + ' state.</div>';
      html += '<table class="bt-inst-table"><thead><tr><th>Indicator</th><th>Use When ≥</th><th>Win Rate Achieved</th><th>Trade Samples</th><th>Avg Pips For You</th></tr></thead><tbody>';
      for (const [comp, v] of optEntries) {
        const cls = v.win_rate >= 60 ? 'bt-win' : v.win_rate >= 52 ? '' : 'bt-loss';
        const lift = v.win_rate - (d.baseline?.win_rate || 50);
        html += `<tr><td><strong>${comp}</strong></td><td>≥ ${v.threshold}</td><td class="${cls}"><strong>${v.win_rate}%</strong> <span style="font-size:10px;color:var(--text-muted)">(+${lift}pp vs baseline)</span></td><td>${v.samples}</td><td class="bt-win">+${v.avg_fav}p</td></tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<div style="color:var(--text-muted);font-size:11px;padding:4px 0">No individual filter significantly improves the baseline in this regime. Try combining multiple filters (see Conditional Edge engine).</div>';
    }
    html += '</div>';
  }

  html += _btActionBox([
    '<strong>First identify the current regime</strong> on the live dashboard (check Market Energy section), then apply ONLY the thresholds listed for that regime.',
    '<strong>Do NOT use Expansion thresholds during Compression</strong> — each regime needs its own playbook.',
    'If the best regime has a baseline > 55%, you can be more aggressive with entries during that regime.',
    'If a regime baseline is < 48%, consider <strong>not trading at all</strong> during that regime — no filter can fix a broken environment.',
  ]);

  wrap.innerHTML = html;
}

// ─── 5. Session Thresholds ───────────────────────────────────────────────────

function _btRenderSessionThresholdsInto(data, insight, wrap) {
  if (!data) { wrap.innerHTML = '<div style="color:var(--text-muted)">No session data</div>'; return; }

  let html = _btWhatIs('clock', 'What This Analysis Shows',
    'Forex sessions (Asia, London, New York, etc.) have dramatically different characteristics. Asia is thin and choppy. London has the most liquidity and biggest breakouts. New York often continues or reverses London moves. <strong>The same indicator at the same value performs very differently depending on which session you are in.</strong> This analysis finds the exact optimal threshold for each indicator, per session — so you never apply a London rule during Asia.');

  const sessions = Object.entries(data).sort((a, b) => (b[1].baseline?.win_rate || 0) - (a[1].baseline?.win_rate || 0));
  const validSess = sessions.filter(([_, d]) => !d.insufficient);

  const sessExplains = {
    'Asia': 'Tokyo/Sydney session (roughly 23:00–07:00 UTC). Lower liquidity, smaller moves, range-bound. Requires higher agreement thresholds.',
    'London': 'European session (roughly 07:00–16:00 UTC). Highest liquidity, biggest breakouts, strongest trends. Most tradeable session.',
    'New York': 'US session (roughly 12:00–21:00 UTC). Overlaps with London early, then goes solo. Often continues or reverses earlier moves.',
    'London_NY_Overlap': 'When London and New York are both open (roughly 12:00–16:00 UTC). Maximum liquidity and volatility. Biggest moves happen here.',
    'Late_NY': 'Late US session (roughly 17:00–21:00 UTC). Liquidity drops off, spreads widen. Often quieter.',
    'Pre_Asia': 'Between NY close and Asia open. Lowest liquidity. Usually not worth trading.',
  };

  const findings = [];
  if (validSess[0]) findings.push({ type: 'good', label: 'Best session', value: validSess[0][0].replace(/_/g, ' '), desc: `Baseline ${validSess[0][1].baseline?.win_rate}% win rate — this session naturally favors directional continuation.` });
  if (validSess.length > 1) {
    const worst = validSess[validSess.length - 1];
    findings.push({ type: worst[1].baseline?.win_rate < 48 ? 'bad' : 'warn', label: 'Weakest session', value: worst[0].replace(/_/g, ' '), desc: `Baseline only ${worst[1].baseline?.win_rate}% — be extra selective during this window or avoid entirely.` });
  }
  findings.push({ type: 'info', label: 'Sessions analyzed', value: `${validSess.length}`, desc: 'Each session has unique optimal thresholds tailored to its liquidity and volatility profile.' });

  html += _btFindings(findings);
  html += _btInsightBox(insight);

  html += _btGuide([
    'Each card represents one trading session (time window) with its baseline and optimal filters.',
    '<strong>Baseline</strong> = the win rate during this session with zero filters. This is your starting edge just from timing.',
    'The table shows which indicators need a <strong>higher or different threshold</strong> during this specific session.',
    '<strong>"+Xpp vs baseline"</strong> shows how much each filter improves your odds above the session default.',
  ]);

  for (const [session, d] of sessions) {
    if (d.insufficient) continue;
    const optEntries = Object.entries(d.optimal || {}).filter(([_, v]) => v.threshold != null);
    const sessName = session.replace(/_/g, ' ');

    html += `<div class="bt-regime-card">
      <div class="bt-regime-header"><span class="bt-regime-name">${sessName}</span><span class="bt-regime-base">Baseline: <strong>${d.baseline?.win_rate}%</strong> WR · ${d.total_trades} trades</span></div>
      <div class="bt-explain-row">${sessExplains[session] || 'Trading session with distinct market characteristics.'}</div>`;

    if (optEntries.length) {
      html += '<table class="bt-inst-table"><thead><tr><th>Indicator</th><th>Use When ≥</th><th>Win Rate</th><th>Lift</th><th>Samples</th><th>Avg Pips For You</th></tr></thead><tbody>';
      for (const [comp, v] of optEntries) {
        const cls = v.win_rate >= 60 ? 'bt-win' : '';
        const lift = v.win_rate - (d.baseline?.win_rate || 50);
        html += `<tr><td><strong>${comp}</strong></td><td>≥ ${v.threshold}</td><td class="${cls}"><strong>${v.win_rate}%</strong></td><td style="color:var(--green)">+${lift}pp</td><td>${v.samples}</td><td class="bt-win">+${v.avg_fav}p</td></tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<div style="color:var(--text-muted);font-size:11px;padding:6px 0">No individual filter significantly improves the baseline during this session.</div>';
    }
    html += '</div>';
  }

  html += _btActionBox([
    '<strong>Check the clock before applying thresholds.</strong> Switch your filter set based on the active session.',
    '<strong>Asia requires patience.</strong> Wait for higher agreement and confidence before entering.',
    '<strong>London is the power session.</strong> Be more aggressive here, but still respect minimum thresholds.',
    'If a session baseline is below 48%, consider <strong>sitting it out entirely</strong> — your time is better spent on profitable sessions.',
  ]);

  wrap.innerHTML = html;
}

// ─── 6. Transitions ──────────────────────────────────────────────────────────

function _btRenderTransitionsInto(data, insight, wrap) {
  if (!data) { wrap.innerHTML = '<div style="color:var(--text-muted)">No transition data</div>'; return; }
  if (!data.length) { wrap.innerHTML = _btInsightBox(insight) + '<div style="color:var(--text-muted)">Not enough transition data in the selected period</div>'; return; }

  let html = _btWhatIs('arrow-right-left', 'What This Analysis Shows',
    'When the market regime changes (e.g., from Compression to Expansion, or from Trend to Exhaustion), <strong>these transition moments create both the biggest opportunities and the biggest risks</strong>. This analysis measures what happens to trades taken during each type of regime shift. Some transitions (like Compression → Expansion) are explosive opportunities. Others (like Trend → Exhaustion) are traps where continuation fails.');

  const bestTrans = [...data].sort((a, b) => b.win_rate - a.win_rate)[0];
  const worstTrans = [...data].sort((a, b) => a.win_rate - b.win_rate)[0];
  const mostCommon = [...data].sort((a, b) => b.occurrences - a.occurrences)[0];

  html += _btFindings([
    { type: 'good', label: 'Best transition to trade', value: `${bestTrans.win_rate}% WR`, desc: `${bestTrans.from} → ${bestTrans.to}: ${bestTrans.trades} trades with +${bestTrans.avg_fav}p avg favorable.` },
    { type: 'bad', label: 'Most dangerous transition', value: `${worstTrans.win_rate}% WR`, desc: `${worstTrans.from} → ${worstTrans.to}: Trading during this shift historically loses money.` },
    { type: 'info', label: 'Most frequent shift', value: `${mostCommon.from} → ${mostCommon.to}`, desc: `Happened ${mostCommon.occurrences} times. This is the regime change you will encounter most often.` },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    '<strong>Transition</strong> = the market changed from one regime to another (e.g., "COMPRESSION → EXPANSION").',
    '<strong>Occurrences</strong> = how many times this regime shift happened in your date range.',
    '<strong>Win Rate</strong> = how often continuation trades succeeded during this transition.',
    '<strong>Avg Fav / Adv / Net</strong> = average pips in your favor, against you, and the net result per trade.',
    'Green rows = profitable transitions (trade aggressively). Red rows = dangerous (reduce size or skip).',
  ]);

  html += _btTable(
    ['Regime Shift', 'Times Occurred', 'Trades Taken', 'Win Rate', 'Avg For You', 'Avg Against', 'Net Per Trade'],
    data.map(t => {
      const cls = t.win_rate >= 58 ? 'bt-win' : t.win_rate < 45 ? 'bt-loss' : '';
      const verdict = t.win_rate >= 58 ? 'Trade it' : t.win_rate < 45 ? 'Avoid it' : 'Be cautious';
      const verdictCls = t.win_rate >= 58 ? 'bt-win' : t.win_rate < 45 ? 'bt-loss' : '';
      return `<tr><td><strong>${t.from}</strong> → <strong>${t.to}</strong></td><td>${t.occurrences}</td><td>${t.trades}</td><td class="${cls}"><strong>${t.win_rate}%</strong></td><td class="bt-win">+${t.avg_fav}p</td><td class="bt-loss">-${t.avg_adv}p</td><td>${t.avg_net}p <span class="${verdictCls}" style="font-size:10px;font-weight:600">${verdict}</span></td></tr>`;
    })
  );

  html += _btActionBox([
    '<strong>Watch for Compression → Expansion shifts.</strong> These breakouts typically produce the largest moves.',
    '<strong>Be wary of Trend → Exhaustion.</strong> This is where trend-followers get trapped — the move looks like it is continuing but it is actually ending.',
    '<strong>Reduce position size during unfamiliar transitions.</strong> If a transition has high variance (big fav AND big adv), the outcome is uncertain.',
    '<strong>The first 1-2 hours after a regime shift</strong> are the most volatile. Wait for confirmation before sizing up.',
  ]);

  wrap.innerHTML = html;
}

// ─── 7. Edge Stability ───────────────────────────────────────────────────────

function _btRenderEdgeStabilityInto(data, insight, wrap) {
  if (!data) { wrap.innerHTML = '<div style="color:var(--text-muted)">No stability data</div>'; return; }
  if (!data.length) { wrap.innerHTML = _btInsightBox(insight) + '<div style="color:var(--text-muted)">Not enough monthly data for stability analysis</div>'; return; }

  let html = _btWhatIs('shield-check', 'What This Analysis Shows',
    'An edge that worked 6 months ago but stopped working last month is useless. This analysis tracks <strong>whether your discovered edges are stable, improving, or decaying over time</strong>. Each condition is measured month-by-month to calculate variance (how much win rate jumps around) and detect decay trends. A high stability score means you can trust the edge. A "DECAYING" status means the edge is weakening and may not work going forward.');

  const stableEdges = data.filter(d => d.decay === 'STABLE');
  const improvingEdges = data.filter(d => d.decay === 'IMPROVING');
  const decayingEdges = data.filter(d => d.decay === 'DECAYING');
  const bestStability = [...data].sort((a, b) => b.stability_score - a.stability_score)[0];

  html += _btFindings([
    { type: 'good', label: 'Stable edges', value: `${stableEdges.length}`, desc: `These conditions produce consistent results month after month. They are the most trustworthy.` },
    { type: improvingEdges.length ? 'good' : 'info', label: 'Improving edges', value: `${improvingEdges.length}`, desc: `Recent performance is BETTER than historical — these edges are getting stronger.` },
    { type: decayingEdges.length ? 'bad' : 'info', label: 'Decaying edges', value: `${decayingEdges.length}`, desc: decayingEdges.length ? `These edges are weakening. Recent win rate is dropping — reduce reliance on them.` : 'No decaying edges detected. All discovered edges are holding up.' },
    { type: 'info', label: 'Most reliable condition', value: `${bestStability.stability_score}/100`, desc: `"${bestStability.condition}" has the highest stability score — lowest variance and no decay.` },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    '<strong>Stability Score (0-100):</strong> Higher = more reliable. 70+ is great, 50-70 is okay, below 50 is unreliable.',
    '<strong>Recent 3M vs Historical:</strong> Compares last 3 months to everything before. If Recent > Historical = improving.',
    '<strong>Variance (±Xpp):</strong> How much the win rate jumps around month to month. Lower = more predictable.',
    '<strong>Status:</strong> STABLE = consistent, IMPROVING = getting better, DECAYING = getting worse.',
    'The sparkline chart below shows month-by-month win rate — visually confirm the trend.',
  ]);

  html += _btTable(
    ['Condition', 'Total Samples', 'Overall Win Rate', 'Recent 3 Months', 'Older History', 'Monthly Variance', 'Stability Score', 'Trend Status'],
    data.map(d => {
      const decayCls = d.decay === 'DECAYING' ? 'bt-loss' : d.decay === 'IMPROVING' ? 'bt-win' : '';
      const stabCls = d.stability_score >= 70 ? 'bt-win' : d.stability_score < 50 ? 'bt-loss' : '';
      const trendArrow = d.decay === 'IMPROVING' ? ' ↑' : d.decay === 'DECAYING' ? ' ↓' : ' →';
      return `<tr><td><strong>${d.condition}</strong></td><td>${d.total_samples}</td><td>${d.overall_wr}%</td><td>${d.recent_3m_wr != null ? d.recent_3m_wr + '%' : '—'}</td><td>${d.older_wr != null ? d.older_wr + '%' : '—'}</td><td>±${d.variance}pp</td><td class="${stabCls}"><strong>${d.stability_score}/100</strong></td><td class="${decayCls}"><strong>${d.decay}${trendArrow}</strong></td></tr>`;
    })
  );

  // Monthly sparklines for top conditions
  for (const d of data.slice(0, 3)) {
    if (!d.monthly_wr?.length) continue;
    html += `<div class="bt-section-title" style="margin-top:14px">Monthly Win Rate — "${d.condition}" <span style="font-weight:400;color:var(--text-muted);font-size:11px">(${d.decay}, stability ${d.stability_score}/100)</span></div>`;
    html += '<div class="bt-monthly-spark">';
    for (const m of d.monthly_wr) {
      if (m.wr == null) { html += `<div class="bt-spark-bar bt-spark-na" title="${m.month}: insufficient data"><div style="height:3px"></div><span>${m.month.slice(5)}</span></div>`; continue; }
      const h = Math.max(4, Math.min(60, m.wr * 0.7));
      const cls = m.wr >= 58 ? 'bt-spark-hot' : m.wr >= 52 ? 'bt-spark-warm' : m.wr >= 48 ? 'bt-spark-neutral' : 'bt-spark-cold';
      html += `<div class="bt-spark-bar ${cls}" title="${m.month}: ${m.wr}% win rate (${m.samples} trades)"><div style="height:${h}px"></div><span>${m.month.slice(5)}</span></div>`;
    }
    html += '</div>';
  }

  html += _btActionBox([
    '<strong>Only trust edges with stability ≥ 60/100.</strong> Below that, the monthly variance is too high to rely on.',
    '<strong>IMPROVING edges deserve more capital.</strong> If recent performance exceeds history, the edge is getting stronger — lean into it.',
    '<strong>DECAYING edges need re-evaluation.</strong> Reduce position size or stop using them until you re-run discovery with fresh data.',
    '<strong>Re-run this analysis every 1-2 months</strong> to catch decay early before it costs you money.',
    '<strong>Low variance (±3pp or less) is the gold standard.</strong> This means the edge performs almost identically every month.',
  ]);

  wrap.innerHTML = html;
}

// ─── 8. Probability Curves ───────────────────────────────────────────────────

function _btRenderProbabilityCurvesInto(data, insight, wrap) {
  if (!data) { wrap.innerHTML = '<div style="color:var(--text-muted)">No probability data</div>'; return; }
  if (!data.length) { wrap.innerHTML = _btInsightBox(insight) + '<div style="color:var(--text-muted)">Not enough data for probability analysis</div>'; return; }

  let html = _btWhatIs('trending-up', 'What This Analysis Shows',
    'Instead of a binary threshold ("good if above X, bad if below"), probability curves show you the <strong>smooth gradient of how your win rate changes as each indicator increases</strong>. At value 10, you might have 45% probability. At 30, maybe 52%. At 60, perhaps 68%. The "edge threshold" is the exact inflection point where probability crosses from losing to winning. These curves let you make <strong>nuanced decisions</strong> rather than binary pass/fail choices.');

  const edgeComps = data.filter(c => c.edge_threshold != null);
  const bestCurve = [...data].filter(c => c.curve?.length).sort((a, b) => {
    const aMax = Math.max(...a.curve.filter(p => p.wr != null).map(p => p.wr));
    const bMax = Math.max(...b.curve.filter(p => p.wr != null).map(p => p.wr));
    return bMax - aMax;
  })[0];
  const bestMax = bestCurve ? Math.max(...bestCurve.curve.filter(p => p.wr != null).map(p => p.wr)) : 0;

  html += _btFindings([
    { type: 'info', label: 'Indicators with curves', value: `${data.length}`, desc: 'Each indicator has been broken into progressive thresholds to map probability from low to high values.' },
    { type: 'good', label: 'Highest probability reached', value: `${bestMax}%`, desc: bestCurve ? `${bestCurve.name} reaches ${bestMax}% win rate at its peak — this is where the indicator is most powerful.` : '' },
    { type: 'warn', label: 'Have edge thresholds', value: `${edgeComps.length} of ${data.length}`, desc: 'These indicators have a clear inflection point (marked with a blue dashed line) where edge begins.' },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    'Each chart shows one indicator. The <strong>horizontal axis</strong> is the indicator value (low to high). The <strong>vertical bars</strong> represent win rate.',
    '<strong>Taller bar = higher win rate</strong> at that indicator value.',
    'The <strong>blue dashed line</strong> marks the "edge threshold" — the point where probability shifts from losing to winning. Values to the right of this line give you an advantage.',
    '<strong>Bar colors:</strong> Red = below 48%, Orange = 48-52%, Grey = 52-56%, Green = 56-62%, Bright green = 62%+.',
    'The number below each bar is the <strong>sample count</strong>. More samples = more reliable. Be skeptical of high bars with < 30 samples.',
  ]);

  html += _btHmLegend();

  for (const comp of data) {
    const validPts = comp.curve.filter(p => p.wr != null);
    if (!validPts.length) continue;
    const maxWR = Math.max(...validPts.map(p => p.wr));
    const minWR = Math.min(...validPts.map(p => p.wr));

    html += `<div class="bt-prob-card">
      <div class="bt-prob-name">${comp.name}
        ${comp.edge_threshold != null ? `<span class="bt-comp-badge bt-comp-badge-min">Edge begins at ≥ ${comp.edge_threshold}</span>` : '<span class="bt-comp-badge" style="background:rgba(255,255,255,.06);color:var(--text-muted)">No clear edge threshold</span>'}
      </div>
      <div class="bt-explain-row" style="margin-bottom:6px">Range: ${minWR}% (lowest) → ${maxWR}% (highest). ${maxWR - minWR >= 15 ? '<strong style="color:var(--green)">Strong gradient — this indicator matters a lot.</strong>' : maxWR - minWR >= 8 ? 'Moderate gradient — useful but not dominant.' : '<span style="color:var(--text-muted)">Flat gradient — this indicator has limited impact on probability.</span>'}</div>
      <div class="bt-prob-curve">`;

    for (const pt of comp.curve) {
      if (pt.wr == null) { html += `<div class="bt-prob-point bt-prob-na"><div class="bt-prob-bar" style="height:3px"></div><span class="bt-prob-val">—</span><span class="bt-prob-th">${pt.threshold}</span></div>`; continue; }
      const h = Math.max(4, Math.min(80, (pt.wr - 30) * 1.6));
      const cls = pt.wr >= 62 ? 'bt-prob-5' : pt.wr >= 56 ? 'bt-prob-4' : pt.wr >= 52 ? 'bt-prob-3' : pt.wr >= 48 ? 'bt-prob-2' : 'bt-prob-1';
      const isEdge = pt.threshold === comp.edge_threshold;
      html += `<div class="bt-prob-point ${cls} ${isEdge ? 'bt-prob-edge' : ''}"><div class="bt-prob-bar" style="height:${h}px"></div><span class="bt-prob-val">${pt.wr}%</span><span class="bt-prob-th">${pt.threshold}</span><span class="bt-prob-n">${pt.samples}</span></div>`;
    }
    html += '</div></div>';
  }

  html += _btActionBox([
    '<strong>Indicators with a steep gradient (big difference between low and high) are your most powerful filters.</strong> Prioritize them in your trading checklist.',
    '<strong>The edge threshold is your minimum.</strong> Never take a trade when this indicator is below its edge threshold.',
    '<strong>Flat curves mean the indicator does not matter much</strong> on its own. It may still be valuable in combinations (see Heatmaps or Conditional Edge).',
    '<strong>High bars with low sample counts (< 30) are unreliable.</strong> The probability looks great but could be noise.',
    'Use these curves to <strong>size your positions:</strong> indicator near its edge threshold = smaller position, indicator deep in the green = full size.',
  ]);

  wrap.innerHTML = html;
}

// ─── 9. Energy Thresholds ────────────────────────────────────────────────────

function _btRenderEnergyThresholdsInto(data, insight, wrap) {
  if (!data?.by_component) { wrap.innerHTML = '<div style="color:var(--text-muted)">No energy data</div>'; return; }

  let html = _btWhatIs('zap', 'What This Analysis Shows',
    'Market Energy is made up of four sub-components: <strong>Movement</strong> (how much pairs are actually moving), <strong>Momentum/Breadth</strong> (how many pairs are moving together), <strong>Agreement</strong> (are pairs agreeing on direction), and <strong>Volatility</strong> (how erratic the movement is). This analysis breaks each sub-component into ranges and measures the <strong>actual continuation rate and pip movement</strong> at each level. You will learn exactly what energy level is needed for reliable trades.');

  const compEntries = Object.entries(data.by_component);
  const compExplains = {
    'movement': 'How much pairs are physically moving in pips. Higher movement = more opportunity but also more risk.',
    'momentum': 'How many currency pairs are moving in the same direction simultaneously. High breadth = the whole market agrees.',
    'agreement': 'How well the individual pair signals agree with each other. High agreement = clear direction, low = mixed signals.',
    'volatility': 'How erratic the price action is. Some volatility is good (movement), too much is bad (unpredictable whipsaws).',
  };

  // Find best continuation rates
  let bestRange = { rate: 0 };
  for (const [comp, ranges] of compEntries) {
    for (const [k, d] of Object.entries(ranges)) {
      if (d.continuation_rate > bestRange.rate && d.hours >= 10) bestRange = { rate: d.continuation_rate, range: k, comp, move: d.avg_move_pips };
    }
  }

  html += _btFindings([
    { type: 'good', label: 'Best energy sweet spot', value: `${bestRange.rate}%`, desc: `${bestRange.comp} at ${bestRange.range} gives ${bestRange.rate}% continuation with ${bestRange.move}p avg movement.` },
    { type: 'info', label: 'Sub-components analyzed', value: `${compEntries.length}`, desc: 'Each energy sub-component broken into ranges with measured outcomes.' },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    '<strong>Continuation %</strong> = how often price continued moving in the same direction after this energy reading. Higher = better.',
    '<strong>Avg Move</strong> = average pip distance moved. This helps calibrate your take-profit targets.',
    '<strong>Hours / Pairs</strong> = how much data was available for this range. More = more reliable.',
    'Look for the <strong>sweet spot</strong> where continuation is high AND avg move is large — that is your optimal trading zone.',
  ]);

  for (const [comp, ranges] of compEntries) {
    const label = comp.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
    const keys = Object.keys(ranges).sort();
    if (!keys.length) continue;

    html += `<div class="bt-section-title">${label}</div>`;
    html += `<div class="bt-explain-row">${compExplains[comp] || ''}</div>`;
    html += _btTable(['Range', 'Hours Observed', 'Pair Measurements', 'Avg Pip Move', 'Continuation Rate'], keys.map(k => {
      const d = ranges[k];
      const cls = d.continuation_rate >= 50 ? 'bt-win' : d.continuation_rate < 35 ? 'bt-loss' : '';
      const verdict = d.continuation_rate >= 55 ? 'Trade zone' : d.continuation_rate >= 45 ? 'Neutral' : 'Avoid zone';
      return `<tr><td><strong>${k}</strong></td><td>${d.hours}h</td><td>${d.pairs_measured}</td><td>${d.avg_move_pips}p</td><td class="${cls}"><strong>${d.continuation_rate}%</strong> <span style="font-size:10px;color:var(--text-muted)">${verdict}</span></td></tr>`;
    }));
  }

  html += _btActionBox([
    '<strong>Do not trade when ALL energy sub-components are in their lowest range.</strong> The market is dead — there is nothing to capture.',
    '<strong>High movement + high agreement = best combo.</strong> The market is moving AND it is moving together in one direction.',
    '<strong>High volatility + low agreement = danger zone.</strong> Lots of movement but no clear direction — you will get whipsawed.',
    '<strong>Use the continuation rates to set expectations.</strong> If continuation is only 40%, you need tighter stops and faster exits.',
  ]);

  wrap.innerHTML = html;
}

// ─── 10. Strength Thresholds ─────────────────────────────────────────────────

function _btRenderStrengthThresholdsInto(data, insight, wrap) {
  if (!data) { wrap.innerHTML = '<div style="color:var(--text-muted)">No strength data</div>'; return; }

  let html = _btWhatIs('gauge', 'What This Analysis Shows',
    'Currency Strength Spread is the difference between the strong currency and the weak currency in a pair. A small spread (e.g., 0.0002) means both currencies are similar — no clear direction. A large spread (e.g., 0.0015) means one currency is much stronger than the other — clear directional bias. <strong>This analysis measures exactly how much spread is needed before you have a real edge</strong>, and how the reward-to-risk ratio scales as the spread increases.');

  const keys = Object.keys(data).sort();
  const vals = keys.map(k => data[k]).filter(d => d.samples >= 20);
  const bestKey = keys.reduce((best, k) => data[k].continuation_rate > (data[best]?.continuation_rate || 0) ? k : best, keys[0]);
  const bestD = data[bestKey];

  // Find the approximate edge threshold
  let edgeKey = null;
  for (const k of keys) {
    if (data[k].continuation_rate >= 52 && data[k].samples >= 20) { edgeKey = k; break; }
  }

  html += _btFindings([
    { type: 'good', label: 'Best spread level', value: `${bestD.continuation_rate}%`, desc: `At spread diff ${bestKey}, continuation rate reaches ${bestD.continuation_rate}% with avg +${bestD.avg_favourable_pips}p favorable.` },
    { type: edgeKey ? 'warn' : 'info', label: 'Minimum edge spread', value: edgeKey || 'N/A', desc: edgeKey ? `Below ${edgeKey} spread difference, you have no statistical advantage. Do not trade.` : 'No clear edge threshold found — strength alone may not be sufficient.' },
    { type: 'info', label: 'Spread levels tested', value: `${keys.length}`, desc: 'Each row shows a different strength differential bucket with measured outcomes.' },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    '<strong>Spread Diff</strong> = the difference in strength between the two currencies in a pair. Bigger = stronger directional bias.',
    '<strong>Continuation %</strong> = how often the stronger currency kept getting stronger (and the pair kept moving in the expected direction).',
    '<strong>Avg Favourable</strong> = average pips that moved in your favor. This is your potential profit.',
    '<strong>Avg Adverse</strong> = average pips that moved against you before the trade resolved. This is your drawdown risk.',
    '<strong>Avg Net</strong> = average net pip result per trade. Positive = profitable, negative = losing at this spread level.',
  ]);

  html += _btTable(
    ['Spread Difference', 'Trade Samples', 'Continuation Rate', 'Avg Pips For You', 'Avg Pips Against', 'Net Pips Per Trade'],
    keys.map(k => {
      const d = data[k];
      const cls = d.continuation_rate >= 55 ? 'bt-win' : d.continuation_rate < 45 ? 'bt-loss' : '';
      const netCls = d.avg_net_pips >= 0 ? 'bt-win' : 'bt-loss';
      return `<tr><td><strong>${k}</strong></td><td>${d.samples}</td><td class="${cls}"><strong>${d.continuation_rate}%</strong></td><td class="bt-win">+${d.avg_favourable_pips}p</td><td class="bt-loss">-${d.avg_adverse_pips}p</td><td class="${netCls}"><strong>${d.avg_net_pips}p</strong></td></tr>`;
    })
  );

  html += _btActionBox([
    '<strong>Set a minimum spread threshold.</strong> Do not enter any trade where the currency strength spread is below the edge threshold.',
    '<strong>Scale position size with spread.</strong> Larger spread = higher conviction = larger position. Small spread = small position or skip.',
    '<strong>Spread is your primary directional signal.</strong> If the spread is small, other indicators need to be extra strong to compensate.',
    '<strong>Watch for spread convergence.</strong> If the spread was large but is now shrinking, the move may be ending — tighten your stop.',
  ]);

  wrap.innerHTML = html;
}

// ─── 11. State Outcomes ──────────────────────────────────────────────────────

function _btRenderStateOutcomesInto(data, insight, wrap) {
  if (!data) { wrap.innerHTML = '<div style="color:var(--text-muted)">No state data</div>'; return; }

  const stateExplains = {
    'Trend': 'Strong directional move in progress. Strength spread is wide, energy is high, and the pair is consistently moving one way.',
    'Pullback': 'Temporary retracement within a larger trend. Price pulled back against the dominant direction — a potential re-entry point.',
    'Ready-to-Enter': 'Conditions have aligned for a new entry. Strength, energy, and agreement are all favorable. The system says "go."',
    'Reversal': 'The dominant direction may be changing. What was strong is weakening. Dangerous for continuation trades.',
    'No Trade': 'Conditions are not favorable for any directional trade. Too choppy, too weak, or mixed signals.',
    'Compression': 'Market is coiling — building energy but not yet releasing. Patience needed.',
    'Exhaustion': 'The current move has gone too far too fast. Risk of snapback is high.',
  };

  let html = _btWhatIs('git-branch', 'What This Analysis Shows',
    'NervaFX classifies the market into distinct states: Trend, Pullback, Ready-to-Enter, Reversal, No Trade, and others. <strong>This analysis measures the actual outcome when you take a continuation trade in each state</strong>. You will see exactly which states make money, which lose money, and which are coin flips. This is your go/no-go map for market conditions.');

  const states = Object.keys(data).sort((a, b) => data[b].win_rate - data[a].win_rate);
  const bestState = states[0], worstState = states[states.length - 1];

  html += _btFindings([
    { type: 'good', label: 'Best state to trade', value: `${data[bestState].win_rate}% WR`, desc: `"${bestState}" state: ${data[bestState].samples} trades with +${data[bestState].avg_favourable}p average favorable movement.` },
    { type: 'bad', label: 'Worst state', value: `${data[worstState].win_rate}% WR`, desc: `"${worstState}" state: Trading here actively loses money. Hard avoid.` },
    { type: 'info', label: 'States analyzed', value: `${states.length}`, desc: 'Each state independently tested for continuation trade outcomes.' },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    'Each row is a market state that NervaFX assigns on the live dashboard.',
    '<strong>Win Rate</strong> = how often a continuation trade succeeded in this state.',
    '<strong>Avg Favourable / Adverse</strong> = average pips for and against you.',
    '<strong>Avg Confidence</strong> = the average signal confidence when this state was active.',
    'Green states = actively profitable. Red states = avoid. Yellow = breakeven.',
  ]);

  html += _btTable(
    ['Market State', 'Trade Samples', 'Win Rate', 'Avg Pips For You', 'Avg Pips Against', 'Avg Confidence', 'Verdict'],
    states.map(s => {
      const d = data[s];
      const cls = d.win_rate >= 55 ? 'bt-win' : d.win_rate < 45 ? 'bt-loss' : '';
      const verdict = d.win_rate >= 58 ? 'TRADE' : d.win_rate >= 52 ? 'SELECTIVE' : d.win_rate >= 48 ? 'CAUTION' : 'AVOID';
      const vCls = d.win_rate >= 58 ? 'bt-win' : d.win_rate < 48 ? 'bt-loss' : '';
      return `<tr>
        <td><strong>${s}</strong><div style="font-size:10px;color:var(--text-muted);font-weight:400;white-space:normal">${stateExplains[s] || ''}</div></td>
        <td>${d.samples}</td><td class="${cls}"><strong>${d.win_rate}%</strong></td>
        <td class="bt-win">+${d.avg_favourable}p</td><td class="bt-loss">-${d.avg_adverse}p</td>
        <td>${d.avg_confidence}</td>
        <td class="${vCls}" style="font-weight:700">${verdict}</td>
      </tr>`;
    })
  );

  html += _btActionBox([
    '<strong>Only take trades when the dashboard shows a "TRADE" state.</strong> These are the only states where the historical data supports continuation.',
    '<strong>"SELECTIVE" states need extra confirmation.</strong> Check that energy AND agreement AND strength spread are also above their minimum thresholds.',
    '<strong>"AVOID" states are hard rules.</strong> No matter how good the signal looks, if the state says "No Trade" or "Reversal," stay out.',
    '<strong>Pullbacks can be tricky.</strong> They look like re-entry points, but the data will show you whether pullback-state entries actually work in your tested period.',
  ]);

  wrap.innerHTML = html;
}

// ─── 12. No-Trade Zones ──────────────────────────────────────────────────────

function _btRenderNoTradeZonesInto(zones, insight, wrap) {
  if (!zones) { wrap.innerHTML = '<div style="color:var(--text-muted)">No data</div>'; return; }
  if (!zones.length) { wrap.innerHTML = _btWhatIs('shield-off', 'What This Analysis Shows', 'This analysis searches for market conditions where continuation trades consistently lose money.') + '<div class="bt-verdict-banner good"><i data-lucide="check-circle" style="width:16px;height:16px"></i> No clear no-trade zones detected — the market did not show any reliably losing condition patterns in your date range.</div>'; return; }

  let html = _btWhatIs('shield-off', 'What This Analysis Shows',
    '<strong>These are the conditions where you should NEVER trade.</strong> This analysis finds specific market conditions (like low energy + low agreement, or thin liquidity + high volatility) where continuation trades consistently lose money. These are not marginal — they are statistically proven money-losing zones. Memorize them and build them into your "do not trade" checklist. Avoiding bad trades is just as important as finding good ones.');

  const avoidZones = zones.filter(z => z.verdict === 'AVOID');
  html += _btFindings([
    { type: 'bad', label: 'Hard no-trade zones', value: `${avoidZones.length}`, desc: 'These conditions CONSISTENTLY lose money. Every trade taken here hurts your account.' },
    { type: 'info', label: 'Total danger conditions', value: `${zones.length}`, desc: 'All conditions identified where continuation trades perform below acceptable levels.' },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    '<strong>AVOID</strong> = statistically proven losing condition. Do NOT trade when you see this combination.',
    '<strong>CAUTION</strong> = borderline condition. Win rate is near breakeven — not worth the risk.',
    '<strong>Win Rate</strong> = how often continuation trades succeeded under this condition.',
    '<strong>Avg Pips</strong> = the average net result per trade. Negative means you lose money on average.',
  ]);

  html += zones.map(z => {
    const cls = z.verdict === 'AVOID' ? 'bt-loss' : 'bt-be';
    const icon = z.verdict === 'AVOID' ? 'x-circle' : 'alert-triangle';
    return `<div class="bt-zone-card">
      <div class="bt-zone-verdict ${cls}"><i data-lucide="${icon}" style="width:14px;height:14px"></i> ${z.verdict}</div>
      <div class="bt-zone-condition">${z.condition}</div>
      <div class="bt-zone-stats">${z.samples} trade samples | Win rate: <span class="${cls}"><strong>${z.win_rate}%</strong></span> | Average result: <strong>${z.avg_pips}p per trade</strong></div>
      <div class="bt-explain-row">When these conditions appear on the live dashboard, <strong>close any open trades and wait</strong> for conditions to improve.</div>
    </div>`;
  }).join('');

  html += _btActionBox([
    '<strong>Print these rules and put them next to your screen.</strong> Before every trade, check that NONE of these conditions are active.',
    '<strong>These save more money than good entries make.</strong> A single avoided losing trade often saves more pips than a winning trade gains.',
    '<strong>No exceptions.</strong> Even if the signal looks perfect, if a no-trade zone condition is active, the historical data says you will lose.',
    '<strong>Set alerts if possible</strong> for when these conditions activate, so you are warned automatically.',
  ]);

  wrap.innerHTML = html;
}

// ─── 13. Condition Combos ────────────────────────────────────────────────────

function _btRenderConditionCombosInto(combos, insight, wrap) {
  if (!combos) { wrap.innerHTML = '<div style="color:var(--text-muted)">No data</div>'; return; }
  if (!combos.length) { wrap.innerHTML = _btInsightBox(insight) + '<div style="color:var(--text-muted)">Not enough data for combo analysis</div>'; return; }

  let html = _btWhatIs('puzzle', 'What This Analysis Shows',
    'This analysis tests <strong>pre-built condition combinations</strong> — specific multi-indicator setups that represent real trading scenarios. Examples: "High Energy + Agreement + Ready-to-Enter" (the perfect entry), "Strong Trend + High Confidence" (trend continuation), "Compression + Building Momentum" (pre-breakout). Each combo is measured for win rate, average move, and overall profitability.');

  const strongEntries = combos.filter(c => c.verdict === 'STRONG_ENTRY');
  const opportunities = combos.filter(c => c.verdict === 'OPPORTUNITY');
  const best = [...combos].sort((a, b) => b.win_rate - a.win_rate)[0];

  html += _btFindings([
    { type: 'good', label: 'Strong entry setups', value: `${strongEntries.length}`, desc: 'These combinations produce reliably profitable entries with high win rates and good pip yield.' },
    { type: best ? 'good' : 'info', label: 'Best combo win rate', value: best ? `${best.win_rate}%` : 'N/A', desc: best ? `"${best.name}" — ${best.samples} trades with ${best.avg_move}p average move. This is your highest-probability setup.` : '' },
    { type: 'info', label: 'Total combos tested', value: `${combos.length}`, desc: 'Each represents a specific multi-indicator scenario you might encounter while trading.' },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    '<strong>STRONG_ENTRY</strong> = high win rate + good pip yield. These are your A+ setups — trade them every time.',
    '<strong>OPPORTUNITY</strong> = decent win rate but may require additional confirmation.',
    '<strong>Condition</strong> = the specific combination of indicators that must ALL be true simultaneously.',
    '<strong>Avg Move</strong> = average pip distance the trade moved. Use this to set your take-profit target.',
  ]);

  html += combos.map(c => {
    const cls = c.verdict === 'STRONG_ENTRY' ? 'bt-win' : c.verdict === 'OPPORTUNITY' ? 'bt-be' : '';
    const icon = c.verdict === 'STRONG_ENTRY' ? 'check-circle' : 'target';
    return `<div class="bt-combo-card">
      <div class="bt-combo-name"><i data-lucide="${icon}" style="width:14px;height:14px"></i> ${c.name}</div>
      <div class="bt-combo-cond">${c.condition}</div>
      <div class="bt-combo-stats">
        <span><strong>${c.samples}</strong> trade samples</span>
        <span>Win rate: <strong class="${cls}">${c.win_rate}%</strong></span>
        <span>Avg move: <strong>${c.avg_move}p</strong></span>
        <span class="bt-combo-verdict ${cls}">${c.verdict.replace(/_/g, ' ')}</span>
      </div>
      <div class="bt-explain-row">When all these conditions are true on the live dashboard, this setup has historically ${c.win_rate >= 55 ? 'been profitable with ' + c.avg_move + 'p average movement' : 'shown a slight edge but requires careful trade management'}.</div>
    </div>`;
  }).join('');

  html += _btActionBox([
    '<strong>STRONG_ENTRY combos are your "A+ trade" checklist.</strong> When you see all conditions met, enter with conviction.',
    '<strong>Set your TP based on the avg move column.</strong> If a combo shows 25p avg move, set your TP near 20-25p for realistic targets.',
    '<strong>Combine combos with Session Thresholds.</strong> A STRONG_ENTRY combo during the best session is the ultimate setup.',
    '<strong>Do not force combos.</strong> Wait for all conditions to align naturally — forcing a trade by ignoring one condition defeats the purpose.',
  ]);

  wrap.innerHTML = html;
}

// ─── 14. Move Distance ──────────────────────────────────────────────────────

function _btRenderMoveDistanceInto(data, insight, wrap) {
  if (!data) { wrap.innerHTML = '<div style="color:var(--text-muted)">No distance data</div>'; return; }

  let html = _btWhatIs('ruler', 'What This Analysis Shows',
    'How far does price actually move over time? This analysis measures the <strong>expected pip distance at different time horizons</strong> (1 hour, 4 hours, 8 hours, 12 hours, 24 hours) and breaks it down by energy level. This is critical for <strong>setting realistic take-profit and stop-loss levels</strong>. If 4H average max move is only 15 pips during low energy, setting a 50-pip TP is unrealistic. This data calibrates your expectations to actual market behavior.');

  const horizons = Object.keys(data).sort();
  const h4 = data[horizons.find(h => data[h].horizon_hours === 4)] || data[horizons[1]];
  const h8 = data[horizons.find(h => data[h].horizon_hours === 8)] || data[horizons[2]];

  const findings = [];
  if (h4) findings.push({ type: 'info', label: '4H avg max move', value: `${h4.overall_avg_max}p`, desc: `Over 4 hours, price moves an average of ${h4.overall_avg_max} pips at its peak. Set 4H TP near or below this level.` });
  if (h8) findings.push({ type: 'info', label: '8H avg max move', value: `${h8.overall_avg_max}p`, desc: `Over 8 hours, average max movement is ${h8.overall_avg_max} pips. Swing trade targets should be within this range.` });
  if (h4) findings.push({ type: 'good', label: 'High energy 4H move', value: `${h4.high_energy.avg_max}p`, desc: `When energy is high, 4H moves reach ${h4.high_energy.avg_max}p — ${Math.round(h4.high_energy.avg_max / (h4.low_energy.avg_max || 1) * 10) / 10}x more than low energy.` });
  if (h4) findings.push({ type: 'bad', label: 'Low energy 4H move', value: `${h4.low_energy.avg_max}p`, desc: `Low energy = tiny moves. Not enough movement to cover spreads and commissions.` });

  html += _btFindings(findings);
  html += _btInsightBox(insight);

  html += _btGuide([
    '<strong>Horizon</strong> = how far ahead we measured (1H, 4H, 8H, etc.).',
    '<strong>Avg Max Move</strong> = the average furthest distance price traveled from the entry point. This is your maximum potential profit.',
    '<strong>Avg Net</strong> = where price ended up after the horizon period. This shows the average held position result.',
    '<strong>Low / Mid / High Energy</strong> columns show how the expected move changes based on current market energy.',
    '<strong>The gap between Low and High energy is the key insight.</strong> If high energy produces 3x the move, energy level should determine your TP.',
  ]);

  html += _btTable(
    ['Time Horizon', 'Samples', 'Avg Max Move', 'Where Price Ended', 'Low Energy Move', 'Mid Energy Move', 'High Energy Move'],
    horizons.map(h => {
      const d = data[h];
      const ratio = d.low_energy.avg_max > 0 ? (d.high_energy.avg_max / d.low_energy.avg_max).toFixed(1) : '—';
      return `<tr>
        <td><strong>${d.horizon_hours} Hours</strong></td><td>${d.total_samples}</td>
        <td><strong>${d.overall_avg_max}p</strong></td><td>${d.overall_avg_net}p</td>
        <td>${d.low_energy.avg_max}p <span style="opacity:.5;font-size:10px">(${d.low_energy.samples} trades)</span></td>
        <td>${d.mid_energy.avg_max}p <span style="opacity:.5;font-size:10px">(${d.mid_energy.samples} trades)</span></td>
        <td class="bt-win"><strong>${d.high_energy.avg_max}p</strong> <span style="opacity:.5;font-size:10px">(${d.high_energy.samples} trades) ${ratio}x low</span></td>
      </tr>`;
    })
  );

  html += _btActionBox([
    '<strong>Set TP at 60-80% of the "Avg Max Move" for your chosen horizon.</strong> Trying to capture 100% of the average move is unrealistic.',
    '<strong>Use the energy-based columns.</strong> During low energy, set tight TPs (use the low energy column). During high energy, widen TPs (use the high energy column).',
    '<strong>If Avg Net is much smaller than Avg Max</strong>, it means price reaches the target but then retraces. Use a trailing stop instead of a fixed TP.',
    '<strong>For scalping (1-2H):</strong> Use the 1H row. For intraday swing (4-8H): Use the 4H-8H rows. For overnight holds: Use 12-24H rows.',
    '<strong>Stop-loss hint:</strong> If Avg Max Move at 4H is 20p, a stop wider than 25p is probably too loose — you are giving back more than the expected move.',
  ]);

  wrap.innerHTML = html;
}

// ─── 15. Session Performance ─────────────────────────────────────────────────

function _btRenderSessionPerfInto(data, insight, wrap) {
  if (!data) { wrap.innerHTML = '<div style="color:var(--text-muted)">No session data</div>'; return; }

  let html = _btWhatIs('bar-chart-3', 'What This Analysis Shows',
    'Which trading session produces the most reliable and biggest moves? This analysis compares <strong>every session window</strong> (Asia, London, New York, overlaps) by their average energy level, and the actual pip movement achieved at 4-hour and 8-hour horizons. This tells you <strong>when to trade and when to sleep</strong> — literally. If London produces 3x the movement of Asia, your time is far better spent trading London.');

  const sessions = Object.keys(data).sort((a, b) => data[b].avg_energy - data[a].avg_energy);
  const bestSess = sessions[0], worstSess = sessions[sessions.length - 1];

  const sessTimings = {
    'Asia': '23:00 – 07:00 UTC (Tokyo/Sydney)',
    'London': '07:00 – 16:00 UTC (European)',
    'New_York': '12:00 – 21:00 UTC (US)',
    'London_NY_Overlap': '12:00 – 16:00 UTC (Both open)',
    'Late_NY': '17:00 – 21:00 UTC (US afternoon)',
    'Pre_Asia': '21:00 – 23:00 UTC (Quietest period)',
  };

  html += _btFindings([
    { type: 'good', label: 'Most active session', value: bestSess.replace(/_/g, ' '), desc: `Average energy: ${data[bestSess].avg_energy}. 4H move: ${data[bestSess].h4_avg_move}p, 8H move: ${data[bestSess].h8_avg_move}p. This is when the market gives you the most to work with.` },
    { type: 'bad', label: 'Least active session', value: worstSess.replace(/_/g, ' '), desc: `Average energy: ${data[worstSess].avg_energy}. 4H move: ${data[worstSess].h4_avg_move}p. Not enough movement to trade profitably.` },
    { type: 'info', label: 'Sessions compared', value: `${sessions.length}`, desc: 'Each session measured for energy, 4-hour movement, and 8-hour movement.' },
  ]);

  html += _btInsightBox(insight);

  html += _btGuide([
    '<strong>Avg Energy</strong> = average Market Energy reading during this session. Higher = more movement potential.',
    '<strong>4H / 8H Avg Move</strong> = average pip distance measured 4 and 8 hours into this session.',
    '<strong>Sessions are time windows in UTC.</strong> Adjust to your local timezone to know when to be at your screen.',
    'The session with the highest 4H avg move is where your intraday trades will perform best.',
  ]);

  html += _btTable(
    ['Session Window', 'Hours of Data', 'Avg Energy', '4H Avg Move (pips)', '4H Trades', '8H Avg Move (pips)', '8H Trades'],
    sessions.map((s, i) => {
      const d = data[s];
      const bestCls = i === 0 ? 'bt-comp-row-best' : i === sessions.length - 1 ? 'bt-comp-row-worst' : '';
      return `<tr class="${bestCls}">
        <td><strong>${s.replace(/_/g, ' ')}</strong>${i === 0 ? ' ★' : ''}${i === sessions.length - 1 ? ' ⚠' : ''}<div style="font-size:10px;color:var(--text-muted);font-weight:400">${sessTimings[s] || ''}</div></td>
        <td>${d.hours}h</td><td><strong>${d.avg_energy}</strong></td>
        <td${i === 0 ? ' class="bt-win"' : ''}><strong>${d.h4_avg_move}p</strong></td><td>${d.h4_samples}</td>
        <td${i === 0 ? ' class="bt-win"' : ''}><strong>${d.h8_avg_move}p</strong></td><td>${d.h8_samples}</td>
      </tr>`;
    })
  );

  html += _btActionBox([
    `<strong>Focus your trading on ${bestSess.replace(/_/g, ' ')}.</strong> This session produces the most movement and the best opportunities.`,
    `<strong>Avoid ${worstSess.replace(/_/g, ' ')}.</strong> The movement is too small to cover your spreads and risk.`,
    '<strong>Plan your day around sessions.</strong> Set alarms for session opens. Be at your screen during the best sessions, away during the worst.',
    '<strong>Combine with Session Thresholds.</strong> This engine tells you WHEN to trade, Session Thresholds tells you WHAT thresholds to use during each window.',
    '<strong>London-NY overlap is typically the highest-volume period.</strong> If it does not show up as the best here, market conditions in your test period were unusual.',
  ]);

  wrap.innerHTML = html;
}

function _btTable(headers, rows) {
  return `<table class="bt-inst-table">
    <thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>`;
}

function _btInsightBox(insight) {
  if (!insight || (!insight.summary && !insight.bullets?.length)) return '';
  let html = '<div class="bt-insight">';
  html += '<div class="bt-insight-header"><i data-lucide="brain" style="width:16px;height:16px"></i> AI Analysis</div>';
  if (insight.summary) html += `<div class="bt-insight-summary">${insight.summary}</div>`;
  if (insight.bullets?.length) {
    html += '<ul class="bt-insight-bullets">';
    for (const b of insight.bullets) html += `<li>${b}</li>`;
    html += '</ul>';
  }
  html += '</div>';
  return html;
}

function _btRenderComponentThresholds(components, insights) {
  const el = document.getElementById('bt-components');
  if (!el || !components || !components.length) return;

  // Group components by their group
  const groups = {};
  for (const comp of components) {
    if (!groups[comp.group]) groups[comp.group] = [];
    groups[comp.group].push(comp);
  }

  // Find matching insight for each component
  const insightMap = {};
  if (insights && insights.length) {
    for (const ins of insights) insightMap[ins.id] = ins;
  }

  const groupIcons = {
    'Market Energy': 'zap',
    'Directional Pressure': 'arrow-up-down',
    'Market Structure': 'git-branch',
    'Currency Strength': 'gauge',
    'Quality Metrics': 'shield-check',
  };

  let html = '';

  for (const [groupName, comps] of Object.entries(groups)) {
    const icon = groupIcons[groupName] || 'bar-chart-3';
    html += `<div class="bt-comp-group">
      <div class="bt-comp-group-header">
        <i data-lucide="${icon}" style="width:16px;height:16px"></i>
        <span>${groupName}</span>
      </div>`;

    for (const comp of comps) {
      const ins = insightMap[comp.id];
      const ranges = comp.ranges || {};
      const rangeKeys = Object.keys(ranges).sort((a, b) => {
        const aNum = parseFloat(a.split('–')[0]) || 0;
        const bNum = parseFloat(b.split('–')[0]) || 0;
        return aNum - bNum;
      });

      // Summary badges
      let badges = '';
      if (comp.best_range) badges += `<span class="bt-comp-badge bt-comp-badge-best">Sweet Spot: ${comp.best_range}${comp.unit} (${comp.best_win_rate}% WR)</span>`;
      if (comp.min_edge_threshold) badges += `<span class="bt-comp-badge bt-comp-badge-min">Min Edge: ${comp.min_edge_threshold}${comp.unit}</span>`;
      if (comp.worst_range && comp.worst_win_rate < 48) badges += `<span class="bt-comp-badge bt-comp-badge-danger">Danger: ${comp.worst_range}${comp.unit} (${comp.worst_win_rate}% WR)</span>`;

      // AI insight for this component
      let insightHtml = '';
      if (ins && (ins.summary || ins.bullets?.length)) {
        insightHtml = '<div class="bt-comp-insight">';
        if (ins.summary) insightHtml += `<div class="bt-comp-insight-summary">${ins.summary}</div>`;
        if (ins.bullets?.length) {
          insightHtml += '<ul class="bt-comp-insight-bullets">';
          for (const b of ins.bullets) insightHtml += `<li>${b}</li>`;
          insightHtml += '</ul>';
        }
        insightHtml += '</div>';
      }

      // Data table
      let tableHtml = '';
      if (rangeKeys.length) {
        tableHtml = `<table class="bt-inst-table bt-comp-table">
          <thead><tr><th>Range</th><th>Hours</th><th>Trades</th><th>Win Rate</th><th>Avg Fav</th><th>Avg Adv</th><th>Avg Move</th></tr></thead>
          <tbody>`;
        for (const key of rangeKeys) {
          const r = ranges[key];
          if (r.insufficient) {
            tableHtml += `<tr class="bt-comp-row-dim"><td>${key}</td><td>${r.hours}</td><td>${r.trades}</td><td colspan="4" style="color:var(--text-muted);font-style:italic">Insufficient data</td></tr>`;
            continue;
          }
          const isBest = key === comp.best_range;
          const isWorst = key === comp.worst_range && comp.worst_win_rate < 48;
          const rowCls = isBest ? 'bt-comp-row-best' : isWorst ? 'bt-comp-row-worst' : '';
          const wrCls = r.win_rate >= 55 ? 'bt-win' : r.win_rate < 45 ? 'bt-loss' : '';
          tableHtml += `<tr class="${rowCls}">
            <td><strong>${key}</strong>${isBest ? ' ★' : ''}${isWorst ? ' ⚠' : ''}</td>
            <td>${r.hours}</td><td>${r.trades}</td>
            <td class="${wrCls}"><strong>${r.win_rate}%</strong></td>
            <td class="bt-win">+${r.avg_fav}p</td>
            <td class="bt-loss">-${r.avg_adv}p</td>
            <td>${r.avg_move}p</td>
          </tr>`;
        }
        tableHtml += '</tbody></table>';
      }

      html += `<div class="bt-comp-card" id="bt-comp-${comp.id}">
        <div class="bt-comp-header" onclick="this.parentElement.classList.toggle('bt-comp-expanded')">
          <div class="bt-comp-title-row">
            <span class="bt-comp-expand-icon">▶</span>
            <span class="bt-comp-name">${comp.name}</span>
            <span class="bt-comp-desc">${comp.description}</span>
          </div>
          <div class="bt-comp-badges">${badges}</div>
        </div>
        <div class="bt-comp-body">
          ${insightHtml}
          ${tableHtml}
        </div>
      </div>`;
    }

    html += '</div>';
  }

  el.innerHTML = html;
}

// ─── Conditional Edge Renderer ──────────────────────────────────────────────

function _btRenderConditionalEdge(data, insight) {
  const el = document.getElementById('bt-conditional');
  if (!el || !data?.chains) return;

  let html = _btInsightBox(insight);

  for (const chain of data.chains) {
    if (!chain.steps || chain.steps.length < 2) continue;

    html += `<div class="bt-chain">
      <div class="bt-chain-name">${chain.name}</div>
      <div class="bt-chain-desc">${chain.desc}</div>
      <div class="bt-chain-steps">`;

    for (let i = 0; i < chain.steps.length; i++) {
      const s = chain.steps[i];
      if (!s.win_rate) continue;
      const lift = i > 0 ? s.win_rate - chain.steps[i - 1].win_rate : 0;
      const barW = Math.max(8, Math.min(100, s.win_rate));
      const barCls = s.win_rate >= 65 ? 'bt-bar-hot' : s.win_rate >= 55 ? 'bt-bar-warm' : s.win_rate >= 50 ? 'bt-bar-neutral' : 'bt-bar-cold';

      html += `<div class="bt-chain-step">
        <div class="bt-chain-label">${s.label}</div>
        <div class="bt-chain-bar-wrap">
          <div class="bt-chain-bar ${barCls}" style="width:${barW}%"></div>
          <span class="bt-chain-wr">${s.win_rate}%</span>
          ${lift > 0 ? `<span class="bt-chain-lift">+${lift}</span>` : ''}
        </div>
        <div class="bt-chain-meta">${s.samples} trades · +${s.avg_fav}p fav · -${s.avg_adv}p adv</div>
      </div>`;
    }

    html += '</div></div>';
  }

  el.innerHTML = html || '<div style="color:var(--text-muted)">No data</div>';
}

// ─── Heatmap Renderer ──────────────────────────────────────────────────────

function _btRenderHeatmaps(data, insight) {
  const el = document.getElementById('bt-heatmaps');
  if (!el || !data?.length) return;

  let html = _btInsightBox(insight);

  for (const hm of data) {
    html += `<div class="bt-heatmap">
      <div class="bt-heatmap-title">${hm.name}</div>
      <div class="bt-heatmap-labels">
        <span>X: ${hm.x_label}</span> <span>Y: ${hm.y_label}</span>
      </div>
      <table class="bt-hm-table">
        <thead><tr><th>${hm.y_label} \\ ${hm.x_label}</th>${hm.x_labels.map(l => `<th>${l}</th>`).join('')}</tr></thead>
        <tbody>`;

    for (let y = hm.y_labels.length - 1; y >= 0; y--) {
      html += `<tr><td class="bt-hm-rowlabel">${hm.y_labels[y]}</td>`;
      for (let x = 0; x < hm.x_labels.length; x++) {
        const c = hm.cells[y][x];
        if (c.wr == null) {
          html += '<td class="bt-hm-cell bt-hm-na">—</td>';
        } else {
          const cls = c.wr >= 62 ? 'bt-hm-5' : c.wr >= 56 ? 'bt-hm-4' : c.wr >= 52 ? 'bt-hm-3' : c.wr >= 48 ? 'bt-hm-2' : 'bt-hm-1';
          html += `<td class="bt-hm-cell ${cls}" title="${c.samples} trades, +${c.avg_fav || 0}p fav">${c.wr}%</td>`;
        }
      }
      html += '</tr>';
    }

    html += '</tbody></table></div>';
  }

  el.innerHTML = html;
}

// ─── Regime Thresholds Renderer ────────────────────────────────────────────

function _btRenderRegimeThresholds(data, insight) {
  const el = document.getElementById('bt-regimes');
  if (!el || !data) return;

  let html = _btInsightBox(insight);
  const regimes = Object.entries(data).sort((a, b) => (b[1].baseline?.win_rate || 0) - (a[1].baseline?.win_rate || 0));

  for (const [regime, d] of regimes) {
    if (d.insufficient) {
      html += `<div class="bt-regime-card"><div class="bt-regime-name">${regime}</div><div class="bt-regime-insuff">${d.hours} hours · ${d.total_trades} trades — insufficient data</div></div>`;
      continue;
    }

    const optEntries = Object.entries(d.optimal || {}).filter(([_, v]) => v.threshold != null);
    html += `<div class="bt-regime-card">
      <div class="bt-regime-header">
        <span class="bt-regime-name">${regime}</span>
        <span class="bt-regime-base">Baseline: <strong>${d.baseline?.win_rate}%</strong> WR · ${d.total_trades} trades · ${d.hours} hours</span>
      </div>`;

    if (optEntries.length) {
      html += '<table class="bt-inst-table"><thead><tr><th>Component</th><th>Optimal Threshold</th><th>Win Rate</th><th>Trades</th><th>Avg Fav</th></tr></thead><tbody>';
      for (const [comp, v] of optEntries) {
        const cls = v.win_rate >= 60 ? 'bt-win' : v.win_rate >= 52 ? '' : 'bt-loss';
        html += `<tr><td><strong>${comp}</strong></td><td>≥ ${v.threshold}</td><td class="${cls}">${v.win_rate}%</td><td>${v.samples}</td><td>+${v.avg_fav}p</td></tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<div style="color:var(--text-muted);font-size:11px;padding:4px 0">No filter significantly improves baseline in this regime</div>';
    }

    html += '</div>';
  }

  el.innerHTML = html;
}

// ─── Session Thresholds Renderer ───────────────────────────────────────────

function _btRenderSessionThresholds(data, insight) {
  const el = document.getElementById('bt-session-th');
  if (!el || !data) return;

  let html = _btInsightBox(insight);
  const sessions = Object.entries(data).sort((a, b) => (b[1].baseline?.win_rate || 0) - (a[1].baseline?.win_rate || 0));

  for (const [session, d] of sessions) {
    if (d.insufficient) continue;

    const optEntries = Object.entries(d.optimal || {}).filter(([_, v]) => v.threshold != null);
    html += `<div class="bt-regime-card">
      <div class="bt-regime-header">
        <span class="bt-regime-name">${session.replace('_', ' ')}</span>
        <span class="bt-regime-base">Baseline: <strong>${d.baseline?.win_rate}%</strong> WR · ${d.total_trades} trades</span>
      </div>`;

    if (optEntries.length) {
      html += '<table class="bt-inst-table"><thead><tr><th>Component</th><th>Optimal Threshold</th><th>Win Rate</th><th>Trades</th><th>Avg Fav</th></tr></thead><tbody>';
      for (const [comp, v] of optEntries) {
        const cls = v.win_rate >= 60 ? 'bt-win' : '';
        html += `<tr><td><strong>${comp}</strong></td><td>≥ ${v.threshold}</td><td class="${cls}">${v.win_rate}%</td><td>${v.samples}</td><td>+${v.avg_fav}p</td></tr>`;
      }
      html += '</tbody></table>';
    }

    html += '</div>';
  }

  el.innerHTML = html;
}

// ─── Transition Renderer ───────────────────────────────────────────────────

function _btRenderTransitions(data, insight) {
  const el = document.getElementById('bt-transitions');
  if (!el || !data) return;

  if (!data.length) {
    el.innerHTML = _btInsightBox(insight) + '<div style="color:var(--text-muted)">Not enough transition data</div>';
    return;
  }

  el.innerHTML = _btInsightBox(insight) + _btTable(
    ['Transition', 'Occurrences', 'Trades', 'Win Rate', 'Avg Fav', 'Avg Adv', 'Avg Net'],
    data.map(t => {
      const cls = t.win_rate >= 58 ? 'bt-win' : t.win_rate < 45 ? 'bt-loss' : '';
      return `<tr>
        <td><strong>${t.from}</strong> → <strong>${t.to}</strong></td>
        <td>${t.occurrences}</td><td>${t.trades}</td>
        <td class="${cls}"><strong>${t.win_rate}%</strong></td>
        <td class="bt-win">+${t.avg_fav}p</td><td class="bt-loss">-${t.avg_adv}p</td>
        <td>${t.avg_net}p</td>
      </tr>`;
    })
  );
}

// ─── Edge Stability Renderer ───────────────────────────────────────────────

function _btRenderEdgeStability(data, insight) {
  const el = document.getElementById('bt-stability');
  if (!el || !data) return;

  if (!data.length) {
    el.innerHTML = _btInsightBox(insight) + '<div style="color:var(--text-muted)">Not enough data for stability analysis</div>';
    return;
  }

  let html = _btInsightBox(insight);
  html += _btTable(
    ['Condition', 'Samples', 'Overall WR', 'Recent 3M', 'Historical', 'Variance', 'Stability', 'Status'],
    data.map(d => {
      const decayCls = d.decay === 'DECAYING' ? 'bt-loss' : d.decay === 'IMPROVING' ? 'bt-win' : '';
      const stabCls = d.stability_score >= 70 ? 'bt-win' : d.stability_score < 50 ? 'bt-loss' : '';
      return `<tr>
        <td><strong>${d.condition}</strong></td>
        <td>${d.total_samples}</td>
        <td>${d.overall_wr}%</td>
        <td>${d.recent_3m_wr != null ? d.recent_3m_wr + '%' : '—'}</td>
        <td>${d.older_wr != null ? d.older_wr + '%' : '—'}</td>
        <td>±${d.variance}pp</td>
        <td class="${stabCls}"><strong>${d.stability_score}/100</strong></td>
        <td class="${decayCls}"><strong>${d.decay}</strong></td>
      </tr>`;
    })
  );

  // Monthly sparkline for top condition
  if (data[0]?.monthly_wr?.length) {
    html += '<div class="bt-section-title" style="margin-top:14px">Monthly Win Rate — "' + data[0].condition + '"</div>';
    html += '<div class="bt-monthly-spark">';
    for (const m of data[0].monthly_wr) {
      if (m.wr == null) { html += `<div class="bt-spark-bar bt-spark-na" title="${m.month}: insufficient data"><div style="height:3px"></div><span>${m.month.slice(5)}</span></div>`; continue; }
      const h = Math.max(4, Math.min(60, m.wr * 0.7));
      const cls = m.wr >= 58 ? 'bt-spark-hot' : m.wr >= 52 ? 'bt-spark-warm' : m.wr >= 48 ? 'bt-spark-neutral' : 'bt-spark-cold';
      html += `<div class="bt-spark-bar ${cls}" title="${m.month}: ${m.wr}% (${m.samples} trades)"><div style="height:${h}px"></div><span>${m.month.slice(5)}</span></div>`;
    }
    html += '</div>';
  }

  el.innerHTML = html;
}

// ─── Probability Curves Renderer ───────────────────────────────────────────

function _btRenderProbabilityCurves(data, insight) {
  const el = document.getElementById('bt-probability');
  if (!el || !data) return;

  if (!data.length) {
    el.innerHTML = _btInsightBox(insight) + '<div style="color:var(--text-muted)">Not enough data for probability analysis</div>';
    return;
  }

  let html = _btInsightBox(insight);

  for (const comp of data) {
    const validPts = comp.curve.filter(p => p.wr != null);
    if (!validPts.length) continue;

    html += `<div class="bt-prob-card">
      <div class="bt-prob-name">${comp.name} ${comp.edge_threshold != null ? `<span class="bt-comp-badge bt-comp-badge-min">Edge at ≥ ${comp.edge_threshold}</span>` : ''}</div>
      <div class="bt-prob-curve">`;

    for (const pt of comp.curve) {
      if (pt.wr == null) {
        html += `<div class="bt-prob-point bt-prob-na"><div class="bt-prob-bar" style="height:3px"></div><span class="bt-prob-val">—</span><span class="bt-prob-th">${pt.threshold}</span></div>`;
        continue;
      }
      const h = Math.max(4, Math.min(80, (pt.wr - 30) * 1.6));
      const cls = pt.wr >= 62 ? 'bt-prob-5' : pt.wr >= 56 ? 'bt-prob-4' : pt.wr >= 52 ? 'bt-prob-3' : pt.wr >= 48 ? 'bt-prob-2' : 'bt-prob-1';
      const isEdge = pt.threshold === comp.edge_threshold;
      html += `<div class="bt-prob-point ${cls} ${isEdge ? 'bt-prob-edge' : ''}">
        <div class="bt-prob-bar" style="height:${h}px"></div>
        <span class="bt-prob-val">${pt.wr}%</span>
        <span class="bt-prob-th">${pt.threshold}</span>
        <span class="bt-prob-n">${pt.samples}</span>
      </div>`;
    }

    html += '</div></div>';
  }

  el.innerHTML = html;
}

function _btRenderEnergyThresholds(data, insight) {
  const el = document.getElementById('bt-energy');
  if (!el || !data?.by_component) return;

  let html = _btInsightBox(insight);
  for (const [comp, ranges] of Object.entries(data.by_component)) {
    const label = comp.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
    const keys = Object.keys(ranges).sort();
    if (!keys.length) continue;

    html += `<div class="bt-section-title">${label}</div>`;
    html += _btTable(['Range', 'Hours', 'Pairs', 'Avg Move', 'Continuation %'], keys.map(k => {
      const d = ranges[k];
      const cls = d.continuation_rate >= 50 ? 'bt-win' : d.continuation_rate < 35 ? 'bt-loss' : '';
      return `<tr><td><strong>${k}</strong></td><td>${d.hours}</td><td>${d.pairs_measured}</td>
        <td>${d.avg_move_pips}p</td><td class="${cls}">${d.continuation_rate}%</td></tr>`;
    }));
  }
  el.innerHTML = html || '<div style="color:var(--text-muted)">No data</div>';
}

function _btRenderStrengthThresholds(data, insight) {
  const el = document.getElementById('bt-strength');
  if (!el || !data) return;

  const keys = Object.keys(data).sort();
  el.innerHTML = _btInsightBox(insight) + _btTable(
    ['Spread Diff', 'Samples', 'Continuation %', 'Avg Favourable', 'Avg Adverse', 'Avg Net'],
    keys.map(k => {
      const d = data[k];
      const cls = d.continuation_rate >= 55 ? 'bt-win' : d.continuation_rate < 45 ? 'bt-loss' : '';
      return `<tr><td><strong>${k}</strong></td><td>${d.samples}</td>
        <td class="${cls}">${d.continuation_rate}%</td>
        <td class="bt-win">${d.avg_favourable_pips}p</td>
        <td class="bt-loss">${d.avg_adverse_pips}p</td>
        <td>${d.avg_net_pips}p</td></tr>`;
    })
  );
}

function _btRenderStateOutcomes(data, insight) {
  const el = document.getElementById('bt-states');
  if (!el || !data) return;

  const states = Object.keys(data).sort((a, b) => data[b].win_rate - data[a].win_rate);
  el.innerHTML = _btInsightBox(insight) + _btTable(
    ['Market State', 'Samples', 'Win Rate', 'Avg Favourable', 'Avg Adverse', 'Avg Confidence'],
    states.map(s => {
      const d = data[s];
      const cls = d.win_rate >= 55 ? 'bt-win' : d.win_rate < 45 ? 'bt-loss' : '';
      return `<tr><td><strong>${s}</strong></td><td>${d.samples}</td>
        <td class="${cls}">${d.win_rate}%</td>
        <td class="bt-win">${d.avg_favourable}p</td>
        <td class="bt-loss">${d.avg_adverse}p</td>
        <td>${d.avg_confidence}</td></tr>`;
    })
  );
}

function _btRenderNoTradeZones(zones, insight) {
  const el = document.getElementById('bt-notrade');
  if (!el || !zones) return;

  if (!zones.length) {
    el.innerHTML = _btInsightBox(insight) + '<div style="color:var(--text-muted)">No clear no-trade zones detected</div>';
    return;
  }

  el.innerHTML = _btInsightBox(insight) + zones.map(z => {
    const cls = z.verdict === 'AVOID' ? 'bt-loss' : 'bt-be';
    return `<div class="bt-zone-card">
      <div class="bt-zone-verdict ${cls}">${z.verdict}</div>
      <div class="bt-zone-condition">${z.condition}</div>
      <div class="bt-zone-stats">${z.samples} samples | Win rate: <span class="${cls}">${z.win_rate}%</span> | Avg: ${z.avg_pips}p</div>
    </div>`;
  }).join('');
}

function _btRenderConditionCombos(combos, insight) {
  const el = document.getElementById('bt-combos');
  if (!el || !combos) return;

  if (!combos.length) {
    el.innerHTML = _btInsightBox(insight) + '<div style="color:var(--text-muted)">Not enough data for combo analysis</div>';
    return;
  }

  el.innerHTML = _btInsightBox(insight) + combos.map(c => {
    const cls = c.verdict === 'STRONG_ENTRY' ? 'bt-win' : c.verdict === 'OPPORTUNITY' ? 'bt-be' : '';
    return `<div class="bt-combo-card">
      <div class="bt-combo-name">${c.name}</div>
      <div class="bt-combo-cond">${c.condition}</div>
      <div class="bt-combo-stats">
        <span>${c.samples} samples</span>
        <span>Win rate: <strong class="${cls}">${c.win_rate}%</strong></span>
        <span>Avg move: <strong>${c.avg_move}p</strong></span>
        <span class="bt-combo-verdict ${cls}">${c.verdict.replace('_', ' ')}</span>
      </div>
    </div>`;
  }).join('');
}

function _btRenderMoveDistance(data, insight) {
  const el = document.getElementById('bt-distance');
  if (!el || !data) return;

  const horizons = Object.keys(data).sort();
  el.innerHTML = _btInsightBox(insight) + _btTable(
    ['Horizon', 'Samples', 'Avg Max Move', 'Avg Net', 'Low Energy', 'Mid Energy', 'High Energy'],
    horizons.map(h => {
      const d = data[h];
      return `<tr><td><strong>${d.horizon_hours}H</strong></td><td>${d.total_samples}</td>
        <td>${d.overall_avg_max}p</td><td>${d.overall_avg_net}p</td>
        <td>${d.low_energy.avg_max}p <span style="opacity:.5">(${d.low_energy.samples})</span></td>
        <td>${d.mid_energy.avg_max}p <span style="opacity:.5">(${d.mid_energy.samples})</span></td>
        <td class="bt-win">${d.high_energy.avg_max}p <span style="opacity:.5">(${d.high_energy.samples})</span></td>
      </tr>`;
    })
  );
}

function _btRenderSessionPerf(data, insight) {
  const el = document.getElementById('bt-sessions');
  if (!el || !data) return;

  const sessions = Object.keys(data).sort((a, b) => data[b].avg_energy - data[a].avg_energy);
  el.innerHTML = _btInsightBox(insight) + _btTable(
    ['Session', 'Hours', 'Avg Energy', '4H Avg Move', '4H Samples', '8H Avg Move', '8H Samples'],
    sessions.map(s => {
      const d = data[s];
      return `<tr><td><strong>${s}</strong></td><td>${d.hours}</td><td>${d.avg_energy}</td>
        <td>${d.h4_avg_move}p</td><td>${d.h4_samples}</td>
        <td>${d.h8_avg_move}p</td><td>${d.h8_samples}</td></tr>`;
    })
  );
}

async function _btLoadHistory() {
  const el = document.getElementById('bt-history');
  if (!el) return;

  try {
    const data = await api('/api/backtest-results?limit=10');
    if (!data || !data.length) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px">No previous runs</div>';
      return;
    }

    el.innerHTML = _btTable(
      ['Date', 'Range', 'Snapshots', 'Duration'],
      data.map(r => `<tr>
        <td>${(r.run_date || '').slice(0, 16).replace('T',' ')}</td>
        <td>${(r.date_from || '').slice(0, 10)} → ${(r.date_to || '').slice(0, 10)}</td>
        <td>${r.bars_replayed}</td>
        <td>${r.duration_sec}s</td>
      </tr>`)
    );
  } catch (e) {
    el.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Could not load history</div>';
  }
}

// Initialize backtest defaults on load
setTimeout(_btInit, 500);

// Boot — wait for plan to load before first refresh to avoid cold-start 403 cascade
showSkeletons();
(async function boot() {
  if (_userPlanReady) await _userPlanReady;
  refresh();
  setInterval(refresh, REFRESH_MS);
})();
