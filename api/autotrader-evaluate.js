'use strict';

const JPY_PAIRS = new Set([
  'USDJPY','EURJPY','GBPJPY','AUDJPY','NZDJPY','CADJPY','CHFJPY',
]);

function oandaToMt5(instrument) {
  return instrument.replace('_', '');
}

function pipValue(mt5Symbol) {
  return JPY_PAIRS.has(mt5Symbol) ? 0.01 : 0.0001;
}

async function evaluateAutoTrader(sb) {
  const now = new Date();

  // Expire stale pending commands (> 5 min old)
  await sb
    .from('ea_commands')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('created_at', new Date(now.getTime() - 5 * 60000).toISOString());

  // Find users with auto trading enabled (include trade counter)
  const { data: enabledUsers, error: settingsErr } = await sb
    .from('ea_settings')
    .select('user_id, trades_since_reset')
    .eq('auto_trading_enabled', true);
  if (settingsErr) throw new Error(settingsErr.message);
  if (!enabledUsers?.length) return { evaluated: 0 };

  // Get active signal pairs (direction confirmation)
  const { data: signals } = await sb
    .from('energy_signal_pairs')
    .select('instrument, dir, phase, de_combined, spread_6h, energy_event_type, active')
    .eq('active', true);

  // Get structure breakout entries (M15 structure watch)
  const { data: structureEntries } = await sb
    .from('m15_structure_watch')
    .select('instrument, direction, state, entry_price, invalidation_price, impulse_high, impulse_low')
    .eq('state', 'ENTRY');

  if (!signals?.length && !structureEntries?.length) {
    return { evaluated: enabledUsers.length, commands: 0 };
  }

  const hasReversal = (signals || []).some(s => s.energy_event_type === 'REVERSAL');
  let totalCommands = 0;

  for (const user of enabledUsers) {
    // Check EA is connected (heartbeat within 60s)
    const { data: account } = await sb
      .from('ea_accounts')
      .select('balance, open_positions, last_heartbeat')
      .eq('user_id', user.user_id)
      .single();

    if (!account) continue;
    const hbAge = now.getTime() - new Date(account.last_heartbeat).getTime();
    if (hbAge > 60000) continue;
    if (!account.balance || account.balance <= 0) continue;

    // Load profile risk settings
    const { data: profile } = await sb
      .from('profiles')
      .select('max_trades, max_daily_risk_pct, min_rr')
      .eq('id', user.user_id)
      .single();

    const maxTrades = profile?.max_trades || 3;
    const riskPct   = profile?.max_daily_risk_pct || 2;
    const minRR     = profile?.min_rr || 2;

    let tradeCount = user.trades_since_reset || 0;
    const openPositions = account.open_positions || [];

    // Get pending commands for this user
    const { data: pendingCmds } = await sb
      .from('ea_commands')
      .select('instrument')
      .eq('user_id', user.user_id)
      .eq('status', 'pending');
    const pendingInstruments = new Set((pendingCmds || []).map(c => c.instrument));
    const openInstruments = new Map();
    for (const p of openPositions) {
      openInstruments.set(p.instrument, p);
    }

    // ── REVERSAL: close wrong-way trades and reset trade counter ──
    let didReset = false;
    for (const sig of (signals || [])) {
      if (sig.energy_event_type !== 'REVERSAL') continue;
      const mt5Symbol = oandaToMt5(sig.instrument);
      const pos = openInstruments.get(mt5Symbol);
      if (!pos) continue;
      if (pos.dir !== sig.dir) {
        const { error: cmdErr } = await sb
          .from('ea_commands')
          .insert({
            user_id:        user.user_id,
            instrument:     mt5Symbol,
            action:         'CLOSE',
            params:         { ticket: pos.ticket },
            status:         'pending',
            signal_pair_id: sig.instrument,
          });
        if (!cmdErr) {
          totalCommands++;
          pendingInstruments.add(mt5Symbol);
          didReset = true;
        }
      }
    }

    // Reset trade counter on any reversal
    if (didReset || hasReversal) {
      tradeCount = 0;
      await sb
        .from('ea_settings')
        .update({ trades_since_reset: 0, last_reset_at: now.toISOString() })
        .eq('user_id', user.user_id);
    }

    const slotsAvailable = maxTrades - tradeCount;
    if (slotsAvailable <= 0) continue;

    let filled = 0;

    // ── STRUCTURE BREAKOUT ENTRIES (priority — has precise SL/TP) ──
    for (const sw of (structureEntries || [])) {
      if (filled >= slotsAvailable) break;

      const mt5Symbol = oandaToMt5(sw.instrument);
      if (openInstruments.has(mt5Symbol)) continue;
      if (pendingInstruments.has(mt5Symbol)) continue;

      const dir = sw.direction;
      const entry = parseFloat(sw.entry_price);
      const sl = parseFloat(sw.invalidation_price);
      if (!entry || !sl || entry === sl) continue;

      const pip = pipValue(mt5Symbol);
      const slPips = Math.abs(entry - sl) / pip;
      if (slPips < 1) continue;

      const tpPips = slPips * minRR;
      const riskPerTrade = account.balance * (riskPct / 100) / maxTrades;
      const pipValuePerLot = pip * 100000;
      let lots = riskPerTrade / (slPips * pipValuePerLot);
      lots = Math.max(0.01, Math.round(lots * 100) / 100);

      const action = dir === 'BUY' ? 'OPEN_BUY' : 'OPEN_SELL';

      const { error: cmdErr } = await sb
        .from('ea_commands')
        .insert({
          user_id:        user.user_id,
          instrument:     mt5Symbol,
          action,
          params:         { lots, sl_pips: Math.round(slPips * 10) / 10, tp_pips: Math.round(tpPips * 10) / 10 },
          status:         'pending',
          signal_pair_id: sw.instrument,
        });
      if (cmdErr) {
        console.error(`[AUTOTRADER] Structure entry error for ${user.user_id}:`, cmdErr.message);
        continue;
      }

      filled++;
      totalCommands++;
      pendingInstruments.add(mt5Symbol);
      console.log(`[AUTOTRADER] Structure entry: ${mt5Symbol} ${action} ${lots} lots, SL ${slPips.toFixed(1)} pips, TP ${tpPips.toFixed(1)} pips`);
    }

    // Update the trade counter
    if (filled > 0) {
      await sb
        .from('ea_settings')
        .update({ trades_since_reset: tradeCount + filled })
        .eq('user_id', user.user_id);
    }
  }

  console.log(`[AUTOTRADER] Evaluated ${enabledUsers.length} users, queued ${totalCommands} commands`);
  return { evaluated: enabledUsers.length, commands: totalCommands };
}

module.exports = { evaluateAutoTrader };
