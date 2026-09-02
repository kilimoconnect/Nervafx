'use strict';

/**
 * SCS — history filters (pure). Filters stored signal/trade records. Strategy
 * versions are never mixed unless the caller explicitly selects several.
 */

const OUTCOME = { TARGET_HIT: 'TARGET_HIT', STOP_HIT: 'STOP_HIT' };

function toMs(v) { if (v == null) return null; return typeof v === 'number' ? v : new Date(v).getTime(); }

/**
 * @param {Array} signals records: {pair,time,direction,d1Direction,impulseOrigin,status,rejection,entryFilled,version,...}
 * @param {object} f filter criteria (all optional)
 * @returns {{ signals, versionsSelected, versionsAvailable }}
 */
function applyFilters(signals, f = {}) {
  const versionsAvailable = [...new Set(signals.map((s) => s.version))].sort();
  // Version isolation: explicit selection, else the single latest version.
  const versionsSelected = (Array.isArray(f.versions) && f.versions.length)
    ? f.versions
    : (versionsAvailable.length ? [versionsAvailable[versionsAvailable.length - 1]] : []);

  const from = toMs(f.dateFrom), to = toMs(f.dateTo);
  const origins = f.impulseOrigin ? (Array.isArray(f.impulseOrigin) ? f.impulseOrigin : [f.impulseOrigin]) : null;

  const out = signals.filter((s) => {
    if (!versionsSelected.includes(s.version)) return false;
    if (f.pair && s.pair !== f.pair) return false;
    if (from != null && toMs(s.time) < from) return false;
    if (to != null && toMs(s.time) > to) return false;
    if (f.direction && s.direction !== f.direction) return false;
    if (f.d1Direction && s.d1Direction !== f.d1Direction) return false;
    if (origins && !origins.includes(s.impulseOrigin)) return false;
    if (f.entry === 'TAKEN' && !s.entryFilled) return false;
    if (f.entry === 'MISSED' && s.entryFilled) return false;
    if (f.targetReached && s.status !== OUTCOME.TARGET_HIT) return false;
    if (f.stopReached && s.status !== OUTCOME.STOP_HIT) return false;
    if (f.invalidated && !(s.status === 'CANCELLED' || (s.rejection || '').includes('INVALIDATED'))) return false;
    if (f.rejected && s.status !== 'REJECTED') return false;
    if (f.rejectionReason && s.rejection !== f.rejectionReason) return false;
    return true;
  });

  return { signals: out, versionsSelected, versionsAvailable, versionMixed: versionsSelected.length > 1 };
}

module.exports = { applyFilters, OUTCOME };
