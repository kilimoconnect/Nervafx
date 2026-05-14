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

// Returns inline HTML badge row for a journal entry's historical CS currencies.
// Empty string when neither strong nor weak.
function csigBadgeHtml(e) {
  const { strong, weak } = computeEntryCsig(e);
  if (!strong.length && !weak.length) return '';
  const parts = [];
  if (strong.length) parts.push(`<span class="jrn-csig-tag strong">💪 ${strong.join(' ')}</span>`);
  if (weak.length)   parts.push(`<span class="jrn-csig-tag weak">🔻 ${weak.join(' ')}</span>`);
  return `<div class="jrn-csig-row">${parts.join('')}</div>`;
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
  gsap.from('#main-grid .card', {
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

async function api(path) {
  const tok = localStorage.getItem('nfx_token');
  const headers = tok ? { 'Authorization': 'Bearer ' + tok } : {};
  const r = await fetch(path, { headers });
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

// ─── AI Analysis ─────────────────────────────────────────────────────────────

// Stores latest aiMap + sentiment so modal can access them
let _aiMap = {};
let _sentimentData = null;
let _profile = { account_size: null, max_daily_risk_pct: null, max_trades: null };
let _userTz = 'UTC'; // overridden from profile on every refresh

function aiHtml(ai, instrument) {
  if (!document.body.classList.contains('plan-premium')) return '';
  if (!ai) return '';
  const d    = ai.details || {};
  const sc   = d.scores   || {};
  const lp   = d.lifecycle_phase || '';
  const lc   = d.lifecycle_completion || 0;
  const sCls = (ai.structure_type || '').replace(/-/g,'_');
  const lpCls = lp.replace(/-/g,'_').toLowerCase();
  const cpLabel = d.counter_pressure  || '';
  const cpCls   = cpLabel.toLowerCase();
  const clLabel = d.cleanliness_label || '';
  const clCls   = clLabel.toLowerCase().replace(/ /g,'_');

  const scoreBar = (val, cls) =>
    `<div class="ai-mini-score ${cls}"><div class="ai-mini-fill" style="width:${val||0}%"></div></div>`;

  return `
    <div class="ai-block">
      <div class="ai-row">
        ${lp ? `<span class="ai-lp-badge ${lpCls}">${clean(lp)}</span>` : ''}
        <span class="ai-badge ai-struct ${sCls}">${clean(ai.structure_type||'')}</span>
        <span class="ai-badge ai-quality ${(ai.market_quality||'').toLowerCase()}">${ai.market_quality||''}</span>
        ${cpLabel ? `<span class="ai-cp-badge cp-${cpCls}">⚡ ${cpLabel}</span>` : ''}
        ${clLabel ? `<span class="ai-cl-badge cl-${clCls}">${clLabel}</span>` : ''}
        <button class="ai-bulb-btn" title="Click for full AI structure analysis" onclick="openAiModal('${instrument}')">💡 <span class="ai-bulb-label">AI Analysis</span></button>
      </div>
      ${lp ? `<div class="ai-lc-bar-wrap"><div class="ai-lc-bar-fill ${lpCls}" style="width:${lc}%"></div><span class="ai-lc-pct">${lc}%</span></div>` : ''}
      <div class="ai-scores-row">
        <div class="ai-score-item"><span>Cont</span>${scoreBar(sc.continuation,'cont')}<b>${sc.continuation??'—'}%</b></div>
        <div class="ai-score-item"><span>Trend</span>${scoreBar(sc.trend_health,'trend')}<b>${sc.trend_health??'—'}%</b></div>
        <div class="ai-score-item"><span>PBQ</span>${scoreBar(sc.pullback_quality,'pbq')}<b>${sc.pullback_quality??'—'}%</b></div>
        <div class="ai-score-item"><span>Clean</span>${scoreBar(sc.cleanliness,'clean')}<b>${sc.cleanliness??'—'}%</b></div>
      </div>
      ${ai.summary  ? `<div class="ai-summary">${ai.summary}</div>` : ''}
      ${ai.warning  ? `<div class="ai-warning">⚠ ${ai.warning}</div>` : ''}
    </div>`;
}

// ─── AI Modal ─────────────────────────────────────────────────────────────────

function openAiModal(instrument) {
  const ai = _aiMap[instrument];
  if (!ai) return;

  const d    = ai.details || {};
  const sc   = d.scores  || {};
  const lp   = d.lifecycle_phase       || '';
  const lc   = d.lifecycle_completion  || 0;
  const sCls = (ai.structure_type || '').replace(/-/g,'_');
  const lpCls = lp.replace(/-/g,'_').toLowerCase();
  const cpLabel   = d.counter_pressure    || '';
  const cpCls     = cpLabel.toLowerCase();
  const clLabel   = d.cleanliness_label   || '';
  const clCls     = clLabel.toLowerCase().replace(/ /g,'_');
  const sessLabel = d.session_label       || '';
  const sessQCls  = (d.session_quality    || '').toLowerCase().replace(/_/g,'-');
  const partLabel = d.market_participation || '';
  const contSupp  = d.continuation_support;

  document.getElementById('ai-modal-pair').textContent = pair(instrument);
  document.getElementById('ai-modal-dir').innerHTML =
    `<span class="ai-badge ai-health ${(ai.trend_health||'').toLowerCase()}">${ai.trend_health||''}</span>`;
  document.getElementById('ai-modal-struct-badge').innerHTML =
    `<span class="ai-badge ai-struct ${sCls}">${clean(ai.structure_type||'')}</span>`;

  const scoreBlock = (label, val, cls) => `
    <div class="ai-modal-score-block">
      <div class="ai-modal-score-label">${label}</div>
      <div class="ai-modal-score-num">${val ?? '—'}%</div>
      <div class="ai-modal-score-bar"><div class="ai-modal-score-fill ${cls}" style="width:${val??0}%"></div></div>
    </div>`;

  document.getElementById('ai-modal-body').innerHTML = `
    ${_sentimentData?.sentiment?.sentiment === 'NEUTRAL' ? `
    <div class="sent-neutral-warn" style="margin-bottom:10px">
      ⚠ Risk sentiment neutral — trade with caution.
    </div>` : ''}
    ${lp ? `
    <div class="ai-modal-lifecycle">
      <div class="ai-modal-lp-header">
        <span class="ai-lp-badge ${lpCls}">${clean(lp)}</span>
        <span class="ai-modal-lc-label">Phase completion</span>
        <span class="ai-modal-lc-pct">${lc}%</span>
      </div>
      <div class="ai-modal-lc-bar"><div class="ai-modal-lc-fill ${lpCls}" style="width:${lc}%"></div></div>
    </div>` : ''}

    ${(cpLabel || clLabel) ? `
    <div class="ai-modal-quality-row">
      ${cpLabel ? `
      <div class="ai-modal-quality-item">
        <div class="ai-modal-quality-label">Counter Pressure</div>
        <span class="ai-cp-badge cp-${cpCls} ai-modal-cp">${cpLabel}</span>
      </div>` : ''}
      ${clLabel ? `
      <div class="ai-modal-quality-item">
        <div class="ai-modal-quality-label">Market Quality</div>
        <span class="ai-cl-badge cl-${clCls} ai-modal-cl">${clLabel}</span>
      </div>` : ''}
    </div>` : ''}

    ${sessLabel ? `
    <div class="ai-modal-session-row">
      <span class="sess-card-badge sq-${sessQCls}" style="font-size:11px;padding:4px 10px">⏱ ${sessLabel}</span>
      ${partLabel ? `<span class="ai-modal-participation part-${partLabel.toLowerCase()}">${partLabel} PARTICIPATION</span>` : ''}
      ${contSupp != null ? `<span class="ai-modal-cont-support ${contSupp ? 'yes' : 'no'}">${contSupp ? '✓ CONTINUATION SUPPORTED' : '⚠ REDUCED CONDITIONS'}</span>` : ''}
    </div>
    ${d.session_context ? `<div class="ai-modal-session-text">${d.session_context}</div>` : ''}
    ` : ''}

    <div class="ai-modal-scores">
      ${scoreBlock('Continuation', sc.continuation, 'cont')}
      ${scoreBlock('Trend Health', sc.trend_health,  'trend')}
      ${scoreBlock('Pullback Quality', sc.pullback_quality, 'pbq')}
      ${scoreBlock('Cleanliness', sc.cleanliness, 'clean')}
    </div>

    ${ai.summary ? `<div class="ai-modal-summary">${ai.summary}</div>` : ''}

    ${d.flow_of_money ? (() => {
      const ma    = d.macro_alignment || 'NEUTRAL';
      const maCls = ma === 'ALIGNED' ? 'aligned' : ma === 'CONFLICTED' ? 'conflicted' : 'neutral';
      const maIcon = ma === 'ALIGNED' ? '✦' : ma === 'CONFLICTED' ? '✕' : '○';
      return `
    <div class="ai-modal-flow">
      <div class="ai-modal-flow-header">
        <span class="ai-modal-flow-title">💸 Flow of Money</span>
        <span class="ai-macro-badge ${maCls}">${maIcon} MACRO ${clean(ma)}</span>
      </div>
      <div class="ai-modal-flow-text">${d.flow_of_money}</div>
    </div>`;
    })() : ''}

    <div class="ai-modal-sections">
      ${d.structure_analysis ? `
        <div class="ai-modal-section">
          <div class="ai-modal-section-title">📊 Structure Analysis</div>
          <div class="ai-modal-section-text">${d.structure_analysis}</div>
        </div>` : ''}

      ${d.trend_assessment ? `
        <div class="ai-modal-section">
          <div class="ai-modal-section-title">📈 Trend Assessment</div>
          <div class="ai-modal-section-text">${d.trend_assessment}</div>
        </div>` : ''}

      ${d.pullback_quality_text ? `
        <div class="ai-modal-section">
          <div class="ai-modal-section-title">🔄 Pullback Quality</div>
          <div class="ai-modal-section-text">${d.pullback_quality_text}</div>
        </div>` : ''}

      ${d.momentum_shift ? `
        <div class="ai-modal-section">
          <div class="ai-modal-section-title">⚡ Momentum Shift</div>
          <div class="ai-modal-section-text">${d.momentum_shift}</div>
        </div>` : ''}

      <div class="ai-modal-factors-row">
        ${(d.support_factors||[]).length ? `
          <div class="ai-modal-factors">
            <div class="ai-modal-section-title">✅ Structure Support</div>
            ${d.support_factors.map(f=>`<div class="ai-factor support">+ ${f}</div>`).join('')}
          </div>` : ''}

        ${(d.risk_factors||[]).length ? `
          <div class="ai-modal-factors">
            <div class="ai-modal-section-title">⚠ Structure Risks</div>
            ${d.risk_factors.map(f=>`<div class="ai-factor risk">− ${f}</div>`).join('')}
          </div>` : ''}
      </div>
    </div>

    ${ai.warning ? `<div class="ai-modal-warning">⚠ ${ai.warning}</div>` : ''}
    <div class="ai-modal-footer">48H analysis · updated ${fmtTime(ai.time)} · gpt-4o-mini</div>
  `;

  const overlay = document.getElementById('ai-modal-overlay');
  const modal   = overlay.querySelector('.ai-modal');
  overlay.classList.add('open');
  gsapModalOpen(modal);
  hydrateIcons();
}

function closeAiModal() {
  const overlay = document.getElementById('ai-modal-overlay');
  const modal   = overlay.querySelector('.ai-modal');
  gsapModalClose(modal, () => overlay.classList.remove('open'));
}

// Close on Escape key
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAiModal(); });

// ─── Session badge helper ─────────────────────────────────────────────────────

function sessionBadgeHtml(s) {
  if (!s.session_label) return '';
  const qCls  = (s.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
  const delta = s.session_delta;
  const dStr  = delta != null ? (delta > 0 ? ` +${delta}` : ` ${delta}`) : '';
  return `<span class="sess-card-badge sq-${qCls}">⏱ ${s.session_label}${dStr}</span>`;
}

// ─── Live Opportunities ───────────────────────────────────────────────────────

function renderLiveOpportunities(states, aiMap = {}, sentimentData = null) {
  const el = document.getElementById('live-opportunities');
  if (!el) return;

  const sentNeutral = sentimentData?.sentiment?.sentiment === 'NEUTRAL';

  const live = (states || []).filter(s => s.state === 'READY_TO_ENTER');

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
        ${sentNeutral ? `<div class="sent-neutral-warn">⚠ Risk sentiment neutral — trade with caution.</div>` : ''}
        ${s.session_blocked ? `<div class="sent-neutral-warn">⚠ ${s.next_action || 'Outside active session'}</div>` : ''}
        ${(s.confidence_breakdown||[]).length ? `<div class="conf-factors" style="align-items:flex-start;margin-top:6px">${s.confidence_breakdown.map(f=>`<span>+ ${f}</span>`).join('')}</div>` : ''}
        ${aiHtml(aiMap[s.instrument], s.instrument)}
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

function renderTopSetups(states, aiMap = {}, sentimentData = null) {
  const el = document.getElementById('top-setups');
  if (!states?.length) { el.innerHTML = '<p class="empty-state">No setups forming</p>'; return; }

  const sentNeutral = sentimentData?.sentiment?.sentiment === 'NEUTRAL';

  const setups = computeTopSetups(states);
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
          ${sentNeutral ? `<div class="sent-neutral-warn">⚠ Risk sentiment neutral — trade with caution.</div>` : ''}
          ${aiHtml(aiMap[s.instrument], s.instrument)}
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

  // Expose flagged currencies globally so section renderers can filter pairs
  _csigCurrencies = new Set([...strong.map(c => c.cur), ...weak.map(c => c.cur)]);
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
      if (s.state !== 'EXPANDING' && s.state !== 'COMPRESSING') return false;
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

  // Snap top to actual header height so the bar sticks right underneath
  const header = document.querySelector('.header');
  if (header) bar.style.top = header.offsetHeight + 'px';

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

function renderRisk(data, sentimentData = null) {
  if (!data) return;
  const el       = document.getElementById('risk-list');
  const approved = data.approved || [];


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

// ─── Sentiment donut chart (CSS conic-gradient) ───────────────────────────────

function sentimentDonutHtml(groups) {
  // groups: [{title, vals}] — same format used in renderSentiment
  const GAP = 2; // degrees gap between segments

  const data = groups.map(g => {
    const vals = g.vals.filter(v => v != null).map(Number);
    const sum  = vals.reduce((a, b) => a + b, 0);
    const color = sum > 5 ? '#4ade80' : sum < -5 ? '#f87171' : '#64748b';
    const shortTitle = g.title.split('/')[0].trim();
    return { title: shortTitle, sum, absSum: Math.abs(sum), color };
  });

  const total = data.reduce((a, b) => a + b.absSum, 0) || 1;

  // Build conic-gradient stops
  let angle = 0;
  const stops = [];
  data.forEach(d => {
    const deg = (d.absSum / total) * 360;
    if (deg < 0.5) { angle += deg; return; } // skip invisible slivers
    const end = angle + deg - GAP;
    stops.push(`${d.color} ${angle.toFixed(2)}deg ${end.toFixed(2)}deg`);
    stops.push(`#0a0c10 ${end.toFixed(2)}deg ${(angle + deg).toFixed(2)}deg`);
    angle += deg;
  });

  const gradient = stops.length
    ? `conic-gradient(${stops.join(', ')})`
    : 'conic-gradient(#1e2128 0deg 360deg)';

  return `
    <div class="sent-donut-wrap">
      <div class="sent-donut" style="background:${gradient}">
        <div class="sent-donut-hole"></div>
      </div>
      <div class="sent-donut-legend">
        ${data.map(d => `
          <div class="sent-legend-item">
            <span class="sent-legend-dot" style="background:${d.color}"></span>
            <span class="sent-legend-label">${d.title}</span>
            <span class="sent-legend-val" style="color:${d.color}">${d.sum > 0 ? '+' : ''}${d.sum.toFixed(0)}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

// ─── Risk Sentiment ───────────────────────────────────────────────────────────

function renderSentiment(data) {
  const el = document.getElementById('sentiment-display');
  if (!el) return;

  const s = data?.sentiment;
  if (!s) {
    el.innerHTML = '<p class="empty-state">No sentiment data — runs on next hourly update</p>';
    return;
  }

  const sentCls = s.sentiment === 'RISK_ON'  ? 'risk-on'
               : s.sentiment === 'RISK_OFF' ? 'risk-off'
               : 'neutral';
  const sentLabel = clean(s.sentiment || 'NEUTRAL');

  const envCls = (s.environment || 'CALM').toLowerCase();
  const envLabel = s.environment || 'CALM';

  const confPct = s.confidence || 0;
  const accel   = Number(s.accel_composite || 0);
  const accelCls = accel > 10 ? 'risk-on' : accel < -10 ? 'risk-off' : 'neutral';
  const accelArrow = accel > 20 ? '↑↑' : accel > 5 ? '↑' : accel < -20 ? '↓↓' : accel < -5 ? '↓' : '→';

  // Components grouped for display — calculation unchanged
  // vals array is used for both group rows and the donut chart
  const groups = [
    { title: 'Growth / Risk Assets', vals: [s.equity_score, s.oil_score] },
    { title: 'Carry / Risk FX',      vals: [s.audjpy_score, s.nzdjpy_score] },
    { title: 'Safe Havens',          vals: [s.jpy_score, s.chf_score, s.gold_score] },
    { title: 'USD Liquidity',        vals: [s.usd_score] },
  ];

  el.innerHTML = `
    <div class="sentiment-main">
      <div class="sent-badge-row">
        <div class="sentiment-badge ${sentCls}">${sentLabel}</div>
        <div class="sent-env-badge ${envCls}">${envLabel}</div>
      </div>
      <div class="sentiment-meta">
        <span class="sent-conf-label">Confidence</span>
        <div class="sent-conf-bar-wrap">
          <div class="sent-conf-bar-fill ${sentCls}" style="width:${confPct}%"></div>
        </div>
        <span class="sent-conf-pct">${confPct}%</span>
      </div>
      <div class="sentiment-net">
        Net <span class="sent-net-val ${sentCls}">${Number(s.net_score || 0).toFixed(1)}</span>
        <span class="sent-accel ${accelCls}" title="Acceleration: how fast conditions are changing">${accelArrow} ${accel > 0 ? '+' : ''}${accel}</span>
      </div>
    </div>
    <div class="sent-groups-and-chart">
      <div class="sentiment-components">
        ${groups.map(g => {
          const vals   = g.vals.filter(v => v != null).map(Number);
          const allOn  = vals.length >= 2 && vals.every(v => v >= 5);
          const allOff = vals.length >= 2 && vals.every(v => v <= -5);
          const badge  = allOn  ? '<span class="sent-align-badge risk-on">↑ ALIGNED</span>'
                       : allOff ? '<span class="sent-align-badge risk-off">↓ ALIGNED</span>'
                       : vals.length === 1 ? ''
                       : '<span class="sent-align-badge not-aligned">✕ NOT ALIGNED</span>';
          const sum    = vals.reduce((a, b) => a + b, 0);
          const sumStr = (sum > 0 ? '+' : '') + sum.toFixed(0);
          const sumCls = sum > 5 ? 'risk-on' : sum < -5 ? 'risk-off' : 'neutral';
          return `
            <div class="sent-group-row">
              <div class="sent-group-header">${g.title}${badge}</div>
              <span class="sent-group-sum ${sumCls}">${sumStr}</span>
            </div>`;
        }).join('')}
      </div>
      ${sentimentDonutHtml(groups)}
    </div>
    <div class="sentiment-time">${fmtTime(s.time)}</div>`;
}

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

function renderJrnAiSection(marketStates, aiAnalysis) {
  // Handle both old (plain array) and new ({ as_of, pairs }) formats
  const states  = Array.isArray(marketStates) ? marketStates : (marketStates?.pairs || []);
  const asOf    = Array.isArray(marketStates) ? null : (marketStates?.as_of || null);
  const ai      = (aiAnalysis || []);
  if (!states.length && !ai.length) return '';

  // Map AI data by instrument for quick lookup
  const aiMap = {};
  for (const a of ai) aiMap[a.instrument] = a;

  // Sort: active states first (READY_TO_ENTER, PULLBACK_*, TREND), then NO_TRADE
  const ORDER = { READY_TO_ENTER: 0, PULLBACK_ACTIVE: 1, PULLBACK_STARTING: 2, TREND: 3, NO_TRADE: 99 };
  const sorted = [...states].sort((a, b) => {
    const oa = ORDER[a.state] ?? 50, ob = ORDER[b.state] ?? 50;
    return oa !== ob ? oa - ob : (b.confidence || 0) - (a.confidence || 0);
  });

  // AI warnings from the deep analysis
  const warnings = ai.filter(a => a.warning);

  const stateLabel = s => clean(s || '—');
  const stateCls   = s => s === 'TREND' ? 'trend' : s?.startsWith('PULLBACK') ? 'pb' : s === 'READY_TO_ENTER' ? 'ready' : 'notrade';
  const biasCls    = b => b === 'BUY' ? 'buy' : b === 'SELL' ? 'sell' : '';

  const asOfLabel = asOf ? `<span class="jrn-as-of">as of ${fmtTime(asOf)}</span>` : '';
  return _jrnSection(`📊 Market States ${asOfLabel}`, `
    ${warnings.length ? `<div class="jrn-ai-warnings">${warnings.map(a =>
      `<div class="jrn-ai-warn-row"><span class="jrn-ai-warn-pair">${pair(a.instrument)}</span><span class="jrn-ai-warn-text">⚠ ${a.warning}</span></div>`
    ).join('')}</div>` : ''}
    <div class="jrn-ai-grid">
      <div class="jrn-ai-head"><span>Pair</span><span>State</span><span>Bias</span><span>Conf</span><span>AI Structure</span></div>
      ${sorted.map(s => {
        const a = aiMap[s.instrument];
        const scls = (a?.structure_type || '').includes('EXPAND') ? 'expanding' : (a?.structure_type || '').includes('CONTRACT') ? 'contracting' : '';
        return `
          <div class="jrn-ai-row">
            <span class="jrn-ai-pair">${pair(s.instrument)}</span>
            <span class="jrn-ai-state ${stateCls(s.state)}">${stateLabel(s.state)}</span>
            <span class="signal-dir ${biasCls(s.bias)}" style="font-size:8px;padding:1px 5px">${s.bias || '—'}</span>
            <span class="jrn-ai-conf">${s.confidence ?? '—'}%</span>
            <span class="jrn-ai-struct ${scls}">${a ? clean(a.structure_type || '—') : '—'}</span>
          </div>`;
      }).join('')}
    </div>`);
}

function renderJrnSessionPerfSection(e, sessionEntries) {
  if (!sessionEntries || sessionEntries.length <= 1) {
    return _jrnSection(`📊 Session: ${sessionLabel(e.session_name)}`, '<p class="jrn-empty">First snapshot of this session.</p>');

  }
  const first = sessionEntries[0];
  const sentFlow = [...sessionEntries.reduce((m, x) => { m.set(x.risk_sentiment, 1); return m; }, new Map()).keys()]
    .map(s => clean(s)).join(' → ');
  const allSignals = sessionEntries.flatMap(x => (x.signals_summary?.entered || []));
  const trendDelta = e.trend_pairs - first.trend_pairs;
  const readyDelta = e.ready_pairs - first.ready_pairs;
  const delta = v => v > 0 ? `<span style="color:#4ade80">+${v}</span>` : v < 0 ? `<span style="color:#f87171">${v}</span>` : `<span style="color:var(--text-dim)">±0</span>`;
  return _jrnSection(`📊 Session: ${sessionLabel(e.session_name)} · ${sessionEntries.length} snapshots`, `
    <div class="jrn-sess-stats">
      <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Duration</span><span class="jrn-sess-val">${sessionEntries.length}H</span></div>
      <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Sentiment flow</span><span class="jrn-sess-val">${sentFlow}</span></div>
      <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Trend pairs</span><span class="jrn-sess-val">${first.trend_pairs} → ${e.trend_pairs} ${delta(trendDelta)}</span></div>
      <div class="jrn-sess-stat"><span class="jrn-sess-lbl">Ready pairs</span><span class="jrn-sess-val">${first.ready_pairs} → ${e.ready_pairs} ${delta(readyDelta)}</span></div>
      ${allSignals.length ? `<div class="jrn-sess-stat jrn-sess-full"><span class="jrn-sess-lbl">Signals</span><span class="jrn-sess-val">${allSignals.map(s => `${pair(s.instrument)} ${s.signal}`).join(', ')}</span></div>` : ''}
    </div>`);
}

function renderJrnPrevSessionSection(prevEntry) {
  if (!prevEntry) return _jrnSection('📋 Previous Journal', '<p class="jrn-empty">No previous entry in loaded history.</p>');
  const sentCls = prevEntry.risk_sentiment === 'RISK_ON' ? 'risk-on' : prevEntry.risk_sentiment === 'RISK_OFF' ? 'risk-off' : 'neutral';
  const sessCls = (prevEntry.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
  const entered = (prevEntry.signals_summary?.entered || []);
  return _jrnSection('📋 Previous Journal', `
    <div class="jrn-prev-meta">
      <span class="jrn-prev-time">${fmtTime(prevEntry.time)}</span>
      <span class="sess-card-badge sq-${sessCls}" style="font-size:9px">${sessionLabel(prevEntry.session_name)}</span>
      <span class="jrn-sent sent-${sentCls}">${clean(prevEntry.risk_sentiment || '—')}</span>
      <span class="jrn-conf">${prevEntry.risk_confidence ?? '—'}%</span>
      <span class="jrn-prev-pairs">${prevEntry.trend_pairs}T · ${prevEntry.pullback_pairs}PB · ${prevEntry.ready_pairs}R</span>
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

async function openJournalModal(id) {
  const e = _journalEntries[id];
  if (!e) return;

  // Open immediately with data we already have — no waiting
  _renderJournalModal(e, null, null, null);

  // Compute session context from already-loaded entries (no extra API call)
  const all = Object.values(_journalEntries).sort((a, b) => a.time.localeCompare(b.time));
  const sessionEntries = all.filter(x => x.session_name === e.session_name && x.time <= e.time);
  const prevEntry = [...all].reverse().find(x => x.time < e.time) || null; // immediately preceding entry (any session)

  // Fetch news events for this date async, then re-render
  let newsEvents = [];
  try {
    const r = await api(`/api/news?date=${e.time.slice(0, 10)}`);
    newsEvents = r.events || [];
  } catch {}

  _renderJournalModal(e, newsEvents, sessionEntries, prevEntry);
}

function _renderJournalModal(e, newsEvents, sessionEntries, prevEntry) {
  const sentCls = e.risk_sentiment === 'RISK_ON' ? 'risk-on' : e.risk_sentiment === 'RISK_OFF' ? 'risk-off' : 'neutral';
  const sessCls = (e.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
  const signals  = e.signals_summary || {};
  const enteredCount = (signals.entered || []).length;

  // Build a per-entry CS filter from the entry's own stored snapshot.
  // If strong + weak are both empty → filter returns false for everything
  // → setups/signals/market-state sections show nothing for that hour.
  const { strong: _csStrong, weak: _csWeak } = computeEntryCsig(e);
  const _entryCsSet = new Set([..._csStrong, ..._csWeak]);
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
    <span class="jrn-sent sent-${sentCls}">${clean(e.risk_sentiment || '—')}</span>
    <span class="jrn-conf">${e.risk_confidence ?? '—'}%</span>
    <div class="jrn-counts">
      <span class="jrn-count trend" title="Trend">${e.trend_pairs}T</span>
      <span class="jrn-count pb"    title="Pullback">${e.pullback_pairs}PB</span>
      <span class="jrn-count ready" title="Ready">${e.ready_pairs}R</span>
      ${enteredCount ? `<span class="jrn-count sig">${enteredCount}✦</span>` : ''}
    </div>
    ${(({ strong, weak }) => {
      const parts = [];
      if (strong.length) parts.push(`<span class="jrn-csig-tag strong">💪 ${strong.join(' ')}</span>`);
      if (weak.length)   parts.push(`<span class="jrn-csig-tag weak">🔻 ${weak.join(' ')}</span>`);
      return parts.join('');
    })(computeEntryCsig(e))}`;

  // Body — sections in order
  document.getElementById('jrn-modal-body').innerHTML = [
    e.summary ? `<div class="jrn-modal-summary">${clean(e.summary)}</div>` : '',
    newsEvents !== null ? renderJrnCalendarSection(newsEvents, e.time) : _jrnSection('📅 Economic Calendar', '<p class="jrn-empty jrn-loading">Loading…</p>'),
    e.risk_sentiment_details ? _jrnSection('🌍 Risk Sentiment', journalSentimentGroupsHtml(e.risk_sentiment_details)) : '',
    renderJrnStrengthSection(e.currency_strength),
    e.m15_impulses != null ? renderJrnM15Section(e.m15_impulses) : '',
    sessionEntries ? renderJrnSessionPerfSection(e, sessionEntries) : '',
    prevEntry !== undefined ? renderJrnPrevSessionSection(prevEntry) : '',
    renderJrnSetupsSection(e.top_setups || [], signals, entryCsigFilter),
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

// ─── Journal sentiment groups (collapsed — no individual components) ──────────

function journalSentimentGroupsHtml(d) {
  if (!d) return '';

  // Summary bar: Net Score, Confidence, Environment
  const netScore   = d.net_score   != null ? Number(d.net_score).toFixed(2) : '—';
  const netCls     = d.net_score   > 0 ? 'risk-on' : d.net_score < 0 ? 'risk-off' : 'neutral';
  const confidence = d.confidence  != null ? `${d.confidence}%` : '—';
  const env        = d.environment || '—';

  const meta = `
    <div class="jrn-sent-meta">
      <div class="jrn-sent-meta-item">Net Score <b class="${netCls}">${netScore}</b></div>
      <div class="jrn-sent-meta-item">Confidence <b>${confidence}</b></div>
      <div class="jrn-sent-meta-item">Environment <b>${env}</b></div>
    </div>`;

  const groups = [
    { title: 'Growth / Risk Assets', vals: [d.equity_score, d.oil_score] },
    { title: 'Carry / Risk FX',      vals: [d.audjpy_score, d.nzdjpy_score] },
    { title: 'Safe Havens',          vals: [d.jpy_score, d.chf_score, d.gold_score] },
    { title: 'USD Liquidity',        vals: [d.usd_score] },
  ];
  const groupsHtml = `
    <div class="jrn-sent-groups">
      ${groups.map(g => {
        const vals   = g.vals.filter(v => v != null).map(Number);
        const allOn  = vals.length >= 2 && vals.every(v => v >= 5);
        const allOff = vals.length >= 2 && vals.every(v => v <= -5);
        const badge  = allOn  ? '<span class="sent-align-badge risk-on">↑ ALIGNED</span>'
                     : allOff ? '<span class="sent-align-badge risk-off">↓ ALIGNED</span>'
                     : vals.length === 1 ? ''
                     : '<span class="sent-align-badge not-aligned">✕ NOT ALIGNED</span>';
        const sum    = vals.reduce((a, b) => a + b, 0);
        const sumStr = (sum > 0 ? '+' : '') + sum.toFixed(0);
        const sumCls = sum > 5 ? 'risk-on' : sum < -5 ? 'risk-off' : 'neutral';
        return `
          <div class="sent-group-row">
            <div class="sent-group-header">${g.title}${badge}</div>
            <span class="sent-group-sum ${sumCls}">${sumStr}</span>
          </div>`;
      }).join('')}
    </div>`;

  return meta + groupsHtml;
}

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
    const sentCls = e.risk_sentiment === 'RISK_ON'  ? 'risk-on'
                  : e.risk_sentiment === 'RISK_OFF' ? 'risk-off'
                  : 'neutral';
    const sessCls = (e.session_quality || 'BLOCKED').toLowerCase().replace(/_/g, '-');
    const signals = e.signals_summary || {};
    const enteredCount = (signals.entered || []).length;

    return `
      <div class="jrn-entry" id="jrn-${e.id}" onclick="openJournalModal('${e.id}')">
        <div class="jrn-header">
          <div class="jrn-hdr-top">
            <span class="jrn-time">${fmtShort(e.time)}</span>
            <span class="sess-card-badge sq-${sessCls}" style="font-size:9px">${sessionLabel(e.session_name)}</span>
          </div>
          <div class="jrn-hdr-bot">
            <span class="jrn-sent sent-${sentCls}">${clean(e.risk_sentiment || '—')}</span>
            <span class="jrn-conf">${e.risk_confidence ?? '—'}%</span>
            <div class="jrn-counts">
              <span class="jrn-count trend" title="Trend">${e.trend_pairs}T</span>
              <span class="jrn-count pb"    title="Pullback (tracked)">${e.pullback_pairs}PB</span>
              <span class="jrn-count ready" title="Ready to enter">${e.ready_pairs}R</span>
              ${e.new_pullback_pairs ? `<span class="jrn-count new-pb" title="New pullback pairs this cycle">+${e.new_pullback_pairs}</span>` : ''}
              ${enteredCount ? `<span class="jrn-count sig">${enteredCount}✦</span>` : ''}
            </div>
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
    const [strength, signals, states, risk, actions, quality, spreads, m15Data, aiData, sentimentData, sessionData, journalData, profileData] = await Promise.all([
      api('/api/strength'),
      api('/api/signals'),
      api('/api/states'),
      api('/api/risk'),
      api('/api/actions'),
      api('/api/quality'),
      api('/api/spreads'),
      api('/api/m15-spreads').catch(() => ({ spreads: [] })),
      api('/api/ai').catch(() => ({ analyses: [] })),
      api('/api/sentiment').catch(() => ({ sentiment: null })),
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

    // Build AI map: instrument → analysis
    const aiMap = {};
    (aiData.analyses || []).forEach(a => { aiMap[a.instrument] = a; });
    _aiMap = aiMap;                 // store globally for modal access
    _sentimentData = sentimentData; // store for modal neutral check

    updateHeader(risk);
    renderSession(sessionData);
    renderSentiment(sentimentData);
    buildChart(strength, activeTF);
    renderCurrencySignals(strength);          // must run first — populates _csigCurrencies
    renderLiveOpportunities(states.states || [], aiMap, sentimentData);
    renderTopSetups(states.states || [], aiMap, sentimentData);
    renderSignals(signals, states.states || [], journalData?.entries || []);
    renderStates(states);
    renderSpreads(spreads);
    renderRanking12H(spreads);
    renderM15Spreads(m15Data);
    updateM15Bar(m15Data);
    renderRisk(risk, sentimentData);
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

// Boot
showSkeletons();
refresh();
setInterval(refresh, REFRESH_MS);
