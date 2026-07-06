-- Cloud SQL / local privilege model (architecture review AR-M3).
--
-- Two roles, no RLS:
--   zkvote_migrator : owns DDL — the ONLY role migrations may run under.
--   zkvote_app      : runtime API role — per-table DML only, no DDL.
--
-- RLS is intentionally not used: PostgREST disappears with the hosted
-- Supabase data plane and every remaining access path goes through the
-- backend (the frontend's direct `Admins` read is replaced by /api/me,
-- AR-H4). The replaced hosted-Supabase posture is inventoried in
-- docs/DATA_MODEL.md so no anon-readable surface is lost silently.
--
-- Run as a superuser/owner connection:
--   psql -v migrator_password='...' -v app_password='...' -f roles.sql
-- (scripts/local/db-roles.sh wires this for the docker-compose instance.)

\set ON_ERROR_STOP on
\if :{?migrator_password}
SELECT set_config('zkvote.migrator_password', :'migrator_password', false) AS ignored
\gset
\endif
\if :{?app_password}
SELECT set_config('zkvote.app_password', :'app_password', false) AS ignored
\gset
\endif

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zkvote_migrator') THEN
        EXECUTE format('CREATE ROLE zkvote_migrator LOGIN PASSWORD %L', current_setting('zkvote.migrator_password'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zkvote_app') THEN
        EXECUTE format('CREATE ROLE zkvote_app LOGIN PASSWORD %L', current_setting('zkvote.app_password'));
    END IF;
END $$;

-- Schema ownership boundary: only the migrator may create objects.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM zkvote_app;
GRANT  USAGE  ON SCHEMA public TO zkvote_app;
GRANT  CREATE, USAGE ON SCHEMA public TO zkvote_migrator;

-- Runtime DML, least privilege per table. No DELETE except where the
-- application semantically deletes (consumed admin invitations, H5).
GRANT SELECT, INSERT, UPDATE         ON elections            TO zkvote_app;
GRANT SELECT, INSERT, UPDATE         ON admins               TO zkvote_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON admin_invitations    TO zkvote_app;
GRANT SELECT, INSERT, UPDATE         ON voters               TO zkvote_app;
GRANT SELECT, INSERT, UPDATE         ON submission_tickets   TO zkvote_app;
GRANT SELECT, INSERT, UPDATE         ON vote_submissions     TO zkvote_app;
GRANT SELECT, INSERT, UPDATE         ON finalization_jobs    TO zkvote_app;
GRANT SELECT, INSERT                 ON zk_artifacts         TO zkvote_app;
GRANT SELECT, INSERT                 ON contract_deployments TO zkvote_app;

-- Objects created by future migrations are APPEND-ONLY by default (SQL-1):
-- granting UPDATE here would silently undo the append-only intent that
-- zk_artifacts/contract_deployments are given (SELECT, INSERT only). A future
-- table that genuinely needs mutation must opt in with an explicit
-- `GRANT ... UPDATE` in roles.sql, exactly like the mutable tables above.
ALTER DEFAULT PRIVILEGES FOR ROLE zkvote_migrator IN SCHEMA public
    GRANT SELECT, INSERT ON TABLES TO zkvote_app;

-- Cloud SQL hardening (NO-OP on local docker Postgres). Verified live on
-- zkvote-staging: `gcloud sql users create` grants every new user membership in
-- the `cloudsqlsuperuser` role AND the CREATEDB/CREATEROLE attributes. That
-- silently defeats AR-M3 — the app inherits CREATE on schema public + role/DB
-- creation despite the explicit REVOKEs above. Where cloudsqlsuperuser exists,
-- strip both from the app and migrator roles. Idempotent.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cloudsqlsuperuser') THEN
        EXECUTE 'REVOKE cloudsqlsuperuser FROM zkvote_app';
        EXECUTE 'REVOKE cloudsqlsuperuser FROM zkvote_migrator';
        EXECUTE 'ALTER ROLE zkvote_app NOCREATEDB NOCREATEROLE';
        EXECUTE 'ALTER ROLE zkvote_migrator NOCREATEDB NOCREATEROLE';
    END IF;
END $$;
