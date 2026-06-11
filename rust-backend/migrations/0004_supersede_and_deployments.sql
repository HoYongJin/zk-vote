-- Phase 11: supersede marker (architecture review AR-M7).
-- A superseded election must never accept app-relayed votes, and clearing
-- its deployment binding (docs/RUNBOOK_SUPERSEDE.md) is only legal while
-- superseded_at is set. Idempotent.

ALTER TABLE elections ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_elections_superseded
    ON elections(superseded_at) WHERE superseded_at IS NOT NULL;
