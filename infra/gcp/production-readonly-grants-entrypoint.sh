#!/bin/sh
# Fixed privilege repair for the readonly production verification role.
set -eu

export PGPASSWORD="${POSTGRES_PASSWORD:?missing POSTGRES_PASSWORD}"
psql "host=/cloudsql/${CLOUD_SQL_CONNECTION_NAME:?missing CLOUD_SQL_CONNECTION_NAME} user=postgres dbname=zkvote" \
  -X -v ON_ERROR_STOP=1 <<'SQL'
GRANT zkvote_migrator TO postgres;
GRANT USAGE ON SCHEMA public TO zkvote_readonly;
GRANT SELECT ON
    elections,
    app_users,
    auth_identities,
    admins,
    admin_invitations,
    voters,
    submission_tickets,
    vote_submissions,
    finalization_jobs,
    zk_artifacts,
    contract_deployments
TO zkvote_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE zkvote_migrator IN SCHEMA public
    GRANT SELECT ON TABLES TO zkvote_readonly;
SQL
