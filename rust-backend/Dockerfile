# zkvote-api container (PROJECT_PLAN Phase 16).
# Build locally:  docker build -t zkvote-api rust-backend/
# Cloud Run runtime contract: binds 0.0.0.0:$PORT (handled by config.rs).

FROM rust:1.96-slim-bookworm AS builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config && rm -rf /var/lib/apt/lists/*
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release -p zkvote-api

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 zkvote
USER zkvote
COPY --from=builder /build/target/release/zkvote-api /usr/local/bin/zkvote-api
ENV RUST_LOG=info
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/zkvote-api"]
