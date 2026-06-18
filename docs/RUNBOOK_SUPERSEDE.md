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
   A superseded election MUST NOT accept app-relayed votes or be marked
   completed later: Rust rejects `superseded_at IS NOT NULL`, and the Node
   fallback hides it from read lists and rejects `/proof`, `/submit`, and
   `/complete` when the optional `superseded_at` column exists.
3. **Leave the abandoned deployment binding intact.** Do not clear
   `contract_address`, `verifier_address`, `merkle_root`, or voting times on
   the superseded row. Rust and Node fallback read lists hide it, and both
   backends reject `/proof`, `/submit`, and `/complete`, so reusing the same
   row would also block the replacement election.
4. **Create a replacement election row** through the normal creation flow,
   reusing the intended candidates/depth and allowlist as needed. If artifacts
   are being regenerated, remove only the replacement row's stale artifact
   binding from `server/zkp/artifact-manifest.json` (M5).
5. **Deploy the replacement** through the normal flow (`/setZkDeploy` →
   finalize). A fresh `VotingTally` (with the correct explicit owner, AR-M4)
   is deployed and bound to the replacement election.
6. **Record the incident**: old contract address, reason, tx hashes, and the
   new contract address, in the election's audit note.

## Invariants this runbook preserves

- No owner key ever gains the power to mutate a configured, live election.
- `ALREADY_DEPLOYED` stays absolute; replacements use a new election row.
- The abandoned contract remains on-chain as an immutable audit record.
