# zkvote-api container (PROJECT_PLAN Phase 16).
# Build locally:  docker build -f rust-backend/Dockerfile -t zkvote-api .
# Cloud Run runtime contract: binds 0.0.0.0:$PORT (handled by config.rs).

FROM rust:1.96-slim-bookworm AS builder
WORKDIR /build/rust-backend
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config && rm -rf /var/lib/apt/lists/*
COPY rust-backend/Cargo.toml rust-backend/Cargo.lock ./
COPY rust-backend/crates ./crates
RUN cargo build --release -p zkvote-api

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 zkvote
USER zkvote
WORKDIR /app
COPY --from=builder /build/rust-backend/target/release/zkvote-api /usr/local/bin/zkvote-api
COPY artifacts/contracts /app/artifacts/contracts
ENV RUST_LOG=info
ENV CONTRACT_ARTIFACTS_DIR=/app/artifacts/contracts
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/zkvote-api"]
