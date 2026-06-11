CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS elections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(trim(name)) > 0),
    state text NOT NULL DEFAULT 'draft' CHECK (
        state IN (
            'draft',
            'artifacts_ready',
            'contract_deployed',
            'registration_open',
            'finalizing',
            'voting_active',
            'voting_ended',
            'completed',
            'failed'
        )
    ),
    merkle_tree_depth integer NOT NULL CHECK (merkle_tree_depth > 0 AND merkle_tree_depth <= 20),
    num_candidates integer NOT NULL CHECK (num_candidates > 0),
    candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
    registration_start_time timestamptz NOT NULL,
    registration_end_time timestamptz NOT NULL CHECK (registration_end_time > registration_start_time),
    voting_start_time timestamptz,
    voting_end_time timestamptz,
    merkle_root numeric(78, 0),
    contract_address text,
    verifier_address text,
    completed boolean NOT NULL DEFAULT false,
    circuit_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (voting_start_time IS NULL AND voting_end_time IS NULL)
        OR (voting_start_time IS NOT NULL AND voting_end_time IS NOT NULL AND voting_end_time > voting_start_time)
    )
);

CREATE TABLE IF NOT EXISTS admins (
    id uuid PRIMARY KEY,
    email citext,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_invitations (
    email citext PRIMARY KEY,
    invited_by uuid REFERENCES admins(id),
    accepted_by uuid REFERENCES admins(id),
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS voters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    election_id uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    email citext NOT NULL,
    user_id uuid,
    name text,
    user_secret numeric(78, 0),
    user_secret_commitment numeric(78, 0),
    registered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (election_id, email),
    UNIQUE (election_id, user_id)
);

CREATE TABLE IF NOT EXISTS submission_tickets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    election_id uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    merkle_root numeric(78, 0) NOT NULL,
    nullifier_hash numeric(78, 0) NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE TABLE IF NOT EXISTS vote_submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    election_id uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    nullifier_hash numeric(78, 0) NOT NULL,
    tx_hash text,
    status text NOT NULL CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (election_id, nullifier_hash)
);

CREATE TABLE IF NOT EXISTS finalization_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    election_id uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    desired_merkle_root numeric(78, 0),
    status text NOT NULL CHECK (status IN ('pending', 'onchain_sent', 'onchain_confirmed', 'db_synced', 'failed')),
    tx_hash text,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zk_artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    circuit_id text NOT NULL,
    version text NOT NULL,
    backend text NOT NULL CHECK (backend IN ('circom', 'noir')),
    merkle_tree_depth integer NOT NULL CHECK (merkle_tree_depth > 0 AND merkle_tree_depth <= 20),
    num_candidates integer NOT NULL CHECK (num_candidates > 0),
    wasm_uri text,
    zkey_uri text,
    verification_key_uri text,
    solidity_verifier_uri text,
    sha256 text NOT NULL,
    manifest jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (circuit_id, version)
);

CREATE TABLE IF NOT EXISTS contract_deployments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    election_id uuid NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    zk_artifact_id uuid REFERENCES zk_artifacts(id),
    verifier_address text NOT NULL,
    voting_tally_address text NOT NULL,
    chain_id bigint NOT NULL,
    deploy_tx_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (election_id),
    UNIQUE (chain_id, voting_tally_address)
);

CREATE INDEX IF NOT EXISTS idx_elections_state ON elections(state);
CREATE INDEX IF NOT EXISTS idx_voters_election_id ON voters(election_id);
CREATE INDEX IF NOT EXISTS idx_submission_tickets_election_id ON submission_tickets(election_id);
CREATE INDEX IF NOT EXISTS idx_vote_submissions_election_id ON vote_submissions(election_id);
CREATE INDEX IF NOT EXISTS idx_finalization_jobs_election_id_status ON finalization_jobs(election_id, status);
