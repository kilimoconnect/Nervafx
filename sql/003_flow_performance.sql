-- Flow Performance — pre-computed flow pair rankings per pipeline run
-- One row per instrument per pipeline cycle
CREATE TABLE IF NOT EXISTS flow_performance (
  id                BIGSERIAL PRIMARY KEY,
  time              TIMESTAMPTZ NOT NULL,
  instrument        TEXT NOT NULL,
  session           TEXT,              -- ASIA / LONDON / NEW_YORK / LOW_LIQUIDITY
  dir               TEXT,              -- BUY / SELL
  rank              SMALLINT,          -- 1-4 ranking
  status            TEXT,              -- STRONG / ALIGNED / PARTIAL / BUILDING / AGAINST / WAIT
  state             TEXT,              -- EXPANDING / COMPRESSING / REVERSING / STEADY / FLAT
  momentum          TEXT,              -- Impulsive / Accelerating / Fading / Flat / Steady
  perf_score        REAL,
  final_score       REAL,
  de_combined       REAL,
  spread_3h         REAL,
  spread_6h         REAL,
  v45               REAL,
  v90               REAL,
  vol_rv            REAL,
  vol_eff           REAL,
  vol_grade         TEXT,              -- INSTITUTIONAL / STRONG / NORMAL / WEAK / DEAD
  vol_pers          REAL,
  impulse_score     REAL,
  impulse_aligned   BOOLEAN,
  strong_currencies TEXT,              -- comma-separated e.g. 'USD,GBP'
  weak_currencies   TEXT,              -- comma-separated e.g. 'JPY,CHF'
  UNIQUE (time, instrument)
);

-- Index for time-range queries
CREATE INDEX IF NOT EXISTS idx_fp_time ON flow_performance (time);
-- Index for session filtering
CREATE INDEX IF NOT EXISTS idx_fp_session ON flow_performance (session, time);
