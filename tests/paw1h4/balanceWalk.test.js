'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { balanceWalk, latestEpisode } = require('../../research/paw1h4/balanceWalk');
const { H4_MS } = require('../../research/paw1h4/config');

const START = Date.UTC(2026, 0, 5, 0, 0, 0);
function bars(rows) { return rows.map((r, i) => { const o = START + i * H4_MS; return { openMs: o, closeMs: o + H4_MS, open: (r[0] + r[1]) / 2, high: r[0], low: r[1], close: r[2] }; }); }
const band = { lower: 1.1000, upper: 1.1200 };

test('wick below lower with close back inside → REJECTION at lower (no close beyond)', () => {
  const h4 = bars([[1.1150, 1.1050, 1.1100], [1.1120, 1.0950, 1.1050], [1.1150, 1.1080, 1.1120]]); // bar1 wicks to 1.0950, closes 1.1050 inside
  const w = balanceWalk(h4, band, { acceptN: 2 });
  const rej = latestEpisode(w, (e) => e.boundary === 'lower' && e.kind === 'REJECTION');
  assert.ok(rej, 'rejection episode at lower');
  assert.equal(rej.extreme, 1.0950);
});

test('two consecutive closes above upper → ACCEPTED departure (ongoing)', () => {
  const h4 = bars([[1.1180, 1.1100, 1.1150], [1.1260, 1.1180, 1.1250], [1.1300, 1.1200, 1.1280]]); // closes 1.1250, 1.1280 both > upper
  const w = balanceWalk(h4, band, { acceptN: 2 });
  assert.ok(w.ongoing && w.ongoing.boundary === 'upper' && w.ongoing.kind === 'ACCEPTED');
  assert.ok(w.ongoing.extreme >= 1.1300);
});

test('close below lower then reclaim inside → FAILED departure at lower', () => {
  const h4 = bars([[1.1120, 1.1050, 1.1100], [1.1050, 1.0900, 1.0950], [1.1150, 1.1000, 1.1120]]); // bar1 closes 1.0950 (<lower), bar2 closes 1.1120 inside
  const w = balanceWalk(h4, band, { acceptN: 2 });
  const failed = latestEpisode(w, (e) => e.boundary === 'lower' && e.kind === 'FAILED');
  assert.ok(failed, 'failed departure episode');
  assert.equal(failed.closesBeyond, 1);
  assert.equal(failed.accepted, false);
  assert.ok(failed.extreme <= 1.0900);
});

test('accepted departure that later reclaims → FAILED with accepted=true (chronological transition)', () => {
  const h4 = bars([[1.1180, 1.1100, 1.1150], [1.1260, 1.1180, 1.1250], [1.1300, 1.1220, 1.1280], [1.1250, 1.1150, 1.1190], [1.1180, 1.1100, 1.1150]]); // accept (2 closes>upper) then close back inside
  const w = balanceWalk(h4, band, { acceptN: 2 });
  const failed = latestEpisode(w, (e) => e.boundary === 'upper' && e.kind === 'FAILED');
  assert.ok(failed && failed.accepted === true, 'accepted-then-failed preserves the transition');
});
