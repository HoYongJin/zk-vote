FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates postgresql-client \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/verify/cloud-run-db-dump.sh /usr/local/bin/zkvote-db-dump
RUN chmod 0755 /usr/local/bin/zkvote-db-dump

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/zkvote-db-dump"]
