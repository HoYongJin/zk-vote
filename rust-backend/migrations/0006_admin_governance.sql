-- GOV-1 (audit SECURITY_AUDIT_FINAL_2026-06): the flat admin super-role is split
-- into two tiers, gains a soft-delete revocation path, and records who promoted
-- whom. Runs as zkvote_migrator (DDL).
--
-- No db/roles.sql change is required: the new columns inherit the table-level
-- grants (zkvote_app already has SELECT/INSERT/UPDATE on admins), and revocation
-- is a soft UPDATE (revoked_at) — never a DELETE. admins stays append-only,
-- consistent with the DB-AUTH-1 fix.
--
-- NOTE: scripts/local/migrate.sh re-applies every migration on each run (no
-- tracking table), so every statement below is idempotent / re-run-safe.

-- Two-tier role. The high-blast-radius routes (addAdmins / supersede / setZkDeploy)
-- require is_superadmin; ordinary admins keep election-lifecycle ops only. New
-- (invited) admins default to ordinary via the column DEFAULT.
--
-- Grandfather already-bootstrapped admins to superadmin exactly once, when this
-- column is first introduced. scripts/local/migrate.sh re-applies migrations, so
-- this must not re-promote ordinary admins on later runs.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'admins'
           AND column_name = 'is_superadmin'
    ) THEN
        ALTER TABLE admins ADD COLUMN is_superadmin boolean NOT NULL DEFAULT false;
        UPDATE admins SET is_superadmin = true;
    END IF;
END $$;

-- Soft-delete revocation (GOV-1 / LOW-1): NULL = active. is_admin_or_promote and
-- the admin extractors treat a non-NULL revoked_at as not-an-admin, so a revoked
-- admin's still-valid JWT stops working (also mitigates LOW-5).
ALTER TABLE admins ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- Accountability: which admin's invitation promoted this admin. Best-effort —
-- legacy invitations carry a NULL invited_by, so this is nullable. Self-referential
-- FK like admin_invitations.invited_by/accepted_by.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES admins(id);
