#!/bin/sh
# Fixed-query entrypoint for zkvote-prod-db-readback. No caller SQL is accepted.
set -eu

run_psql() {
  psql "${DATABASE_URL}" -X -A -t -q -v ON_ERROR_STOP=1 "$@"
}

case "${READBACK_MODE:?missing READBACK_MODE}" in
  e2e)
    : "${READBACK_ELECTION_ID:?missing READBACK_ELECTION_ID}"
    printf '%s' "${READBACK_ELECTION_ID}" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' \
      || { echo "invalid READBACK_ELECTION_ID" >&2; exit 64; }
    result="$(run_psql -c "
SELECT json_build_object(
  'election', json_build_object(
    'id', e.id::text,
    'state', e.state,
    'completed', e.completed,
    'contractAddress', e.contract_address,
    'verifierAddress', e.verifier_address,
    'merkleRoot', e.merkle_root::text,
    'votingEndTime', e.voting_end_time
  ),
  'submission', json_build_object(
    'total', COUNT(vs.*),
    'confirmed', COUNT(vs.*) FILTER (WHERE vs.status = 'confirmed'),
    'transactionHashes', COALESCE(
      json_agg(vs.tx_hash ORDER BY vs.created_at) FILTER (WHERE vs.tx_hash IS NOT NULL),
      '[]'::json
    )
  )
)::text
FROM elections e
LEFT JOIN vote_submissions vs ON vs.election_id = e.id
WHERE e.id = '${READBACK_ELECTION_ID}'::uuid
GROUP BY e.id, e.state, e.completed, e.contract_address, e.verifier_address, e.merkle_root, e.voting_end_time;"
)"
    ;;
  deployment)
    : "${READBACK_ELECTION_ID:?missing READBACK_ELECTION_ID}"
    printf '%s' "${READBACK_ELECTION_ID}" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' \
      || { echo "invalid READBACK_ELECTION_ID" >&2; exit 64; }
    result="$(run_psql -c "
SELECT json_build_object(
  'id', e.id::text,
  'name', e.name,
  'merkle_tree_depth', e.merkle_tree_depth,
  'num_candidates', e.num_candidates,
  'contract_address', e.contract_address,
  'verifier_address', e.verifier_address,
  'deploy_tx_hash', cd.deploy_tx_hash,
  'chain_id', cd.chain_id::text,
  'zk_artifact_id', cd.zk_artifact_id::text,
  'verifier_num_candidates', za.num_candidates
)::text
FROM elections e
LEFT JOIN contract_deployments cd ON cd.election_id = e.id
LEFT JOIN zk_artifacts za ON za.id = cd.zk_artifact_id
WHERE e.id = '${READBACK_ELECTION_ID}'::uuid
  AND e.contract_address IS NOT NULL
  AND e.verifier_address IS NOT NULL
  AND e.superseded_at IS NULL
LIMIT 1;
")"
    ;;
  latest-deployment)
    result="$(run_psql -c "
SELECT json_build_object(
  'id', e.id::text,
  'name', e.name,
  'merkle_tree_depth', e.merkle_tree_depth,
  'num_candidates', e.num_candidates,
  'contract_address', e.contract_address,
  'verifier_address', e.verifier_address,
  'deploy_tx_hash', cd.deploy_tx_hash,
  'chain_id', cd.chain_id::text,
  'zk_artifact_id', cd.zk_artifact_id::text,
  'verifier_num_candidates', za.num_candidates
)::text
FROM elections e
LEFT JOIN contract_deployments cd ON cd.election_id = e.id
LEFT JOIN zk_artifacts za ON za.id = cd.zk_artifact_id
WHERE e.contract_address IS NOT NULL
  AND e.verifier_address IS NOT NULL
  AND e.superseded_at IS NULL
ORDER BY e.created_at DESC
LIMIT 1;
")"
    ;;
  reconcile)
    result="$(run_psql -c '
SELECT COALESCE(json_agg(row_to_json(election_rows)), '"'"'[]'"'"'::json)::text
FROM (
  SELECT
    e.id::text AS id,
    e.name,
    e.num_candidates,
    e.contract_address,
    e.completed,
    COUNT(vs.*) FILTER (WHERE vs.status = '"'"'confirmed'"'"')::text AS confirmed_votes,
    COALESCE(
      ARRAY_REMOVE(
        ARRAY_AGG(vs.nullifier_hash ORDER BY vs.created_at) FILTER (WHERE vs.status = '"'"'confirmed'"'"'),
        NULL
      ),
      ARRAY[]::text[]
    ) AS nullifiers
  FROM elections e
  LEFT JOIN vote_submissions vs ON vs.election_id = e.id
  WHERE e.contract_address IS NOT NULL
    AND e.superseded_at IS NULL
  GROUP BY e.id, e.name, e.num_candidates, e.contract_address, e.completed
  ORDER BY e.created_at DESC
) AS election_rows;'
)"
    ;;
  *)
    echo "unsupported READBACK_MODE" >&2
    exit 64
    ;;
esac

printf 'ZKVOTE_DB_READBACK=%s\n' "${result}"
