-- Review G1: prevent two voters in the same election from registering the same
-- Poseidon commitment H(secret). Identical commitments produce byte-identical
-- Merkle leaves and a single shared nullifier H(secret, election_id), so on-chain
-- only ONE of them can ever vote; the other is silently disenfranchised (the
-- API rejects their submit with VOTE_ALREADY_CAST and there is no recovery once
-- registration has closed). The application now rejects a duplicate commitment
-- at registration time (routes/voters.rs); this partial UNIQUE index is the
-- defense-in-depth backstop.
--
-- Partial (WHERE ... IS NOT NULL) so the many allowlisted-but-not-yet-registered
-- voters, whose user_secret_commitment is NULL, do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS voters_election_commitment_uniq
    ON voters (election_id, user_secret_commitment)
    WHERE user_secret_commitment IS NOT NULL;
