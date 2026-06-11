# Runbook: Superseding a Mis-configured Election (AR-M7)

> Decision record (architecture review AR-M7, 2026-06-12): on-chain election
> parameters stay **immutable** after `configureElection` — there are no
> extend/cancel/pause functions, because an owner who can mutate a running
> election is a larger governance risk than immutability. The compensating
> control for "fat-fingered voteEndTime / wrong root" is this supersede
> procedure plus the finalize-time duration bound (Phase 12: default max 30
> days, explicit confirmation to exceed).

## When to use

- `configureElection` landed with a wrong `votingEndTime` (e.g. years out)
  or a wrong Merkle root, and the election cannot proceed.
- The deployed verifier/zkey pair is wrong for the circuit (artifact drift
  caught by `ARTIFACT_MISMATCH`).

The on-chain contract is NOT recovered — it is abandoned in place and a
replacement is deployed. Votes already accepted by the abandoned contract
stay on that contract; decide *before* superseding whether the election
restarts from registration (normal case) or is being voided entirely.

## Procedure

1. **Freeze the app surface.** Announce; confirm no finalize/submit calls
   are in flight (Redis locks drained).
2. **Mark the election superseded in the DB** (durable, auditable):
   - Cloud SQL (Rust schema): `UPDATE elections SET superseded_at = now(),
     state = 'failed' WHERE id = '<election_id>';`
   - Hosted Supabase (Node era): add/maintain a `superseded_at timestamptz`
     column on `Elections` (dashboard SQL editor); set it the same way.
   A superseded election MUST NOT accept app-relayed votes: the Rust submit
   path (Phase 13) rejects on `superseded_at IS NOT NULL`; on the Node era
   this freeze is operational (frontend hides the election once
   `voting_end_time` is corrected or the row is completed).
3. **Clear the deployment binding so a replacement can deploy without DB
   surgery beyond this step:**
   `UPDATE elections SET contract_address = NULL, verifier_address = NULL,
    merkle_root = NULL, voting_start_time = NULL, voting_end_time = NULL
    WHERE id = '<election_id>' AND superseded_at IS NOT NULL;`
   (The `superseded_at IS NOT NULL` guard is what "lifts" the
   ALREADY_DEPLOYED protection — never run this on a live election.)
4. **Remove the stale artifact binding** for the election from
   `server/zkp/artifact-manifest.json` (M5) if the artifacts themselves are
   being regenerated; otherwise leave it and reuse the same artifacts.
5. **Re-deploy** through the normal flow (`/setZkDeploy` → finalize). The
   deploy path's `contract_address IS NULL` guard now passes; a fresh
   `VotingTally` (with the correct explicit owner, AR-M4) is deployed and
   re-bound in the manifest.
6. **Record the incident**: old contract address, reason, tx hashes, and the
   new contract address, in the election's audit note.

## Invariants this runbook preserves

- No owner key ever gains the power to mutate a configured, live election.
- `ALREADY_DEPLOYED` stays absolute for non-superseded elections.
- The abandoned contract remains on-chain as an immutable audit record.
