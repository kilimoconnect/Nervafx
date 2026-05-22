-- ============================================================
-- NervaFX: Create subscriptions table for Flutterwave billing
-- Run this in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS subscriptions (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  plan       TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','premium')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
  flw_tx_ref TEXT,
  flw_tx_id  BIGINT,
  amount     NUMERIC(10,2),
  currency   TEXT DEFAULT 'USD',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_flw  ON subscriptions(flw_tx_ref);

-- Allow authenticated users to read their own subscription
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own subscription"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Service role (API) can insert/update
CREATE POLICY "Service can manage subscriptions"
  ON subscriptions FOR ALL
  USING (true)
  WITH CHECK (true);
