'use strict';

/**
 * PA_D1_H1_CONTINUATION wiring. Binds the shared, verified core (research/paw1h4/*)
 * to the Daily→H1 timeframe descriptor. No strategy logic lives here — only the
 * timeframe binding and this strategy's config, so results stay separate while the
 * rules/engine are identical and already tested.
 */

const { TF_D1H1, runStrategy, runTrendBaseline } = require('../paw1h4/pipeline');
const { buildFrame } = require('../paw1h4/frame');
const { CONFIG, PAIRS, pipSize } = require('./config');

function runStrat(h1, pair, cfg, mode) { return runStrategy(h1, pair, cfg || CONFIG, mode, TF_D1H1); }
function runBaseline(h1, pair, cfg) { return runTrendBaseline(h1, pair, cfg || CONFIG, TF_D1H1); }
function frame(h1, pair, asOfMs, cfg) { return buildFrame(h1, pair, asOfMs, cfg || CONFIG, TF_D1H1); }

module.exports = { CONFIG, PAIRS, pipSize, TF_D1H1, runStrat, runBaseline, frame };
