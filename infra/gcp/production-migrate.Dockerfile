FROM docker.io/library/postgres:16.14-alpine3.24@sha256:7a396fd264a2067788b6551122b50f162bf6136312c7fc9d74381cb92c648382

COPY rust-backend/migrations/ /opt/zkvote/migrations/
COPY rust-backend/db/roles.sql /opt/zkvote/roles.sql
COPY infra/gcp/production-migrate-entrypoint.sh /opt/zkvote/entrypoint.sh

RUN chmod 0555 /opt/zkvote/entrypoint.sh

ENTRYPOINT ["/opt/zkvote/entrypoint.sh"]
