#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 2
fi

if [[ -z "${DB_PRIVATE_IP:-}" ]]; then
  echo "DB_PRIVATE_IP is required" >&2
  exit 2
fi

base_url="${DATABASE_URL%%\?*}"
tcp_url="${base_url/localhost/${DB_PRIVATE_IP}:5432}?sslmode=require"

psql "$tcp_url" --no-align --tuples-only --quiet --command "
SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
FROM (
    SELECT
        e.id::text AS id,
        e.name,
        e.num_candidates,
        e.contract_address,
        e.completed,
        COUNT(vs.*) FILTER (WHERE vs.status = 'confirmed')::text AS confirmed_votes,
        COALESCE(
            ARRAY_REMOVE(
                ARRAY_AGG(vs.nullifier_hash ORDER BY vs.created_at)
                    FILTER (WHERE vs.status = 'confirmed'),
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
) t;
"
