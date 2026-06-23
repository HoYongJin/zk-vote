mod auth;
mod config;
mod error;
mod leases;
mod middleware;
mod ratelimit;
mod routes;
mod state;
mod tickets;

use auth::AuthContext;
use config::AppConfig;
use redis::Client as RedisClient;
use state::AppState;
use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Arc::new(AppConfig::from_env()?);
    // Lazy pool: the process starts (and /healthz answers) even when Postgres
    // is briefly unavailable; /readyz keeps reporting the truth.
    let pg = zkvote_db::connect_lazy(&config.database_url)?;
    let redis = RedisClient::open(config.redis_url.as_str())?;
    let bind_addr = config.bind_addr;

    let auth = config.supabase_jwks_url.clone().map(|jwks_url| {
        Arc::new(AuthContext::new(
            jwks_url,
            config.supabase_issuer.clone(),
            config.supabase_audience.clone(),
        ))
    });
    if auth.is_none() {
        tracing::warn!(
            "SUPABASE_JWKS_URL is not set; authenticated routes will return SERVER_ERROR"
        );
    }

    let state = AppState {
        config: config.clone(),
        pg,
        redis,
        auth,
        relay_lock: Arc::new(tokio::sync::Mutex::new(())),
    };

    let (set_request_id, propagate_request_id) = middleware::request_id_layers();
    let app = routes::router(state)
        .layer(propagate_request_id)
        .layer(middleware::trace_layer())
        .layer(set_request_id)
        .layer(middleware::cors_layer(&config.cors_allowed_origins));

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!("zkvote-api listening on {bind_addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("zkvote-api shut down cleanly");
    Ok(())
}

/// Resolves on SIGINT (ctrl-c) or SIGTERM (Cloud Run / container stop), so
/// in-flight requests drain instead of being severed.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install ctrl-c handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use time::format_description::well_known::Rfc3339 as Rfc3339Fmt;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        test_state_with(
            "http://127.0.0.1:1/jwks",
            "postgres://localhost:1/unreachable",
        )
    }

    fn test_state_with(jwks_url: &str, database_url: &str) -> AppState {
        let jwks_url = jwks_url.to_string();
        let database_url = database_url.to_string();
        // Point at the repo's compiled contract artifacts so create_election's
        // L-depth1 shape check (and setZkDeploy bytecode reads) resolve.
        let artifacts_dir = format!("{}/../../../out", env!("CARGO_MANIFEST_DIR"));
        let config = Arc::new(
            AppConfig::from_lookup(move |name| match name {
                "DATABASE_URL" => Some(database_url.clone()),
                "REDIS_URL" => Some("redis://localhost:1".to_string()),
                "SUPABASE_JWKS_URL" => Some(jwks_url.clone()),
                "SUPABASE_JWT_ISSUER" => Some(auth::token::test_support::TEST_ISSUER.to_string()),
                "CONTRACT_ARTIFACTS_DIR" => Some(artifacts_dir.clone()),
                _ => None,
            })
            .unwrap(),
        );
        let auth = config.supabase_jwks_url.clone().map(|url| {
            Arc::new(AuthContext::new(
                url,
                config.supabase_issuer.clone(),
                config.supabase_audience.clone(),
            ))
        });
        AppState {
            config: config.clone(),
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open(config.redis_url.as_str()).unwrap(),
            auth,
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn test_state_with_artifact_dir(artifact_dir: &std::path::Path) -> AppState {
        let artifact_dir = artifact_dir.display().to_string();
        let config = Arc::new(
            AppConfig::from_lookup(move |name| match name {
                "DATABASE_URL" => Some("postgres://localhost:1/unreachable".to_string()),
                "REDIS_URL" => Some("redis://localhost:1".to_string()),
                "ARTIFACT_LOCAL_DIR" => Some(artifact_dir.clone()),
                _ => None,
            })
            .unwrap(),
        );
        AppState {
            config: config.clone(),
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open(config.redis_url.as_str()).unwrap(),
            auth: None,
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn test_state_with_gcs(gcs_base_url: &str) -> AppState {
        let gcs_base_url = gcs_base_url.to_string();
        let token_url = format!("{gcs_base_url}/token");
        let config = Arc::new(
            AppConfig::from_lookup(move |name| match name {
                "DATABASE_URL" => Some("postgres://localhost:1/unreachable".to_string()),
                "REDIS_URL" => Some("redis://localhost:1".to_string()),
                "ARTIFACT_STORE" => Some("gcs".to_string()),
                "ARTIFACT_BUCKET" => Some("zkvote-staging-artifacts".to_string()),
                "GCS_STORAGE_BASE_URL" => Some(gcs_base_url.clone()),
                "GCS_METADATA_TOKEN_URL" => Some(token_url.clone()),
                _ => None,
            })
            .unwrap(),
        );
        AppState {
            config: config.clone(),
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open(config.redis_url.as_str()).unwrap(),
            auth: None,
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// Serves the test JWKS document on an ephemeral local port.
    async fn spawn_jwks_server() -> String {
        let app = axum::Router::new().route(
            "/jwks",
            axum::routing::get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "application/json")],
                    auth::token::test_support::TEST_JWKS_JSON,
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}/jwks")
    }

    async fn spawn_fake_gcs_server() -> String {
        async fn token() -> axum::Json<serde_json::Value> {
            axum::Json(serde_json::json!({
                "access_token": "test-access-token",
                "expires_in": 3600,
                "token_type": "Bearer"
            }))
        }

        async fn artifact(
            axum::extract::Path((bucket, object)): axum::extract::Path<(String, String)>,
            headers: axum::http::HeaderMap,
        ) -> impl axum::response::IntoResponse {
            assert_eq!(bucket, "zkvote-staging-artifacts");
            assert_eq!(
                headers
                    .get(axum::http::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok()),
                Some("Bearer test-access-token")
            );
            assert_eq!(object, "circuits/votecheck/v1/circuit_final.zkey");
            (StatusCode::OK, "test-gcs-zkey")
        }

        let app = axum::Router::new()
            .route("/token", axum::routing::get(token))
            .route(
                "/storage/v1/b/:bucket/o/*object",
                axum::routing::get(artifact),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    async fn get_me(app: axum::Router, bearer: Option<&str>) -> (StatusCode, serde_json::Value) {
        let mut request = Request::get("/api/me");
        if let Some(token) = bearer {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    #[tokio::test]
    async fn healthz_works_without_live_dependencies() {
        let app = routes::router(test_state());
        let response = app
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], br#"{"status":"ok"}"#);
    }

    #[tokio::test]
    async fn responses_carry_a_request_id() {
        let (set, propagate) = middleware::request_id_layers();
        let app = routes::router(test_state()).layer(propagate).layer(set);
        let response = app
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let request_id = response
            .headers()
            .get(middleware::REQUEST_ID_HEADER)
            .expect("x-request-id header missing");
        assert!(uuid::Uuid::parse_str(request_id.to_str().unwrap()).is_ok());
    }

    #[tokio::test]
    async fn readyz_reports_unready_when_dependencies_are_down() {
        let app = routes::router(test_state());
        let response = app
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn zkp_files_route_serves_only_allowed_artifacts() {
        let root = std::env::temp_dir().join(format!("zkvote-artifacts-{}", uuid::Uuid::new_v4()));
        let build = root.join("build_4_5");
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("circuit_final.zkey"), b"test-zkey").unwrap();
        std::fs::write(build.join("VoteCheck.circom"), b"secret source").unwrap();

        let app = routes::router(test_state_with_artifact_dir(&root));
        let response = app
            .clone()
            .oneshot(
                Request::get("/api/zkp-files/build_4_5/circuit_final.zkey")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"test-zkey");

        let response = app
            .oneshot(
                Request::get("/api/zkp-files/build_4_5/VoteCheck.circom")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn zkp_files_route_streams_gcs_artifacts() {
        let gcs_base_url = spawn_fake_gcs_server().await;
        let app = routes::router(test_state_with_gcs(&gcs_base_url));
        let response = app
            .oneshot(
                Request::get("/api/zkp-files/circuits/votecheck/v1/circuit_final.zkey")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"test-gcs-zkey");
    }

    #[tokio::test]
    async fn me_requires_a_bearer_token() {
        let app = routes::router(test_state());
        let (status, json) = get_me(app, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "AUTHENTICATION_REQUIRED");
    }

    #[tokio::test]
    async fn me_rejects_a_malformed_token() {
        let jwks_url = spawn_jwks_server().await;
        let app = routes::router(test_state_with(&jwks_url, "postgres://localhost:1/x"));
        let (status, json) = get_me(app, Some("not-a-jwt")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "INVALID_TOKEN");
    }

    #[tokio::test]
    async fn me_rejects_an_expired_token() {
        use auth::token::test_support::*;
        let jwks_url = spawn_jwks_server().await;
        let app = routes::router(test_state_with(&jwks_url, "postgres://localhost:1/x"));
        let token = mint_token(
            "0b9f9bbd-6a55-4f2c-9d3e-111111111111",
            "v@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            -300,
        );
        let (status, json) = get_me(app, Some(&token)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "INVALID_TOKEN");
    }

    #[tokio::test]
    async fn me_rejects_a_wrong_audience_token() {
        use auth::token::test_support::*;
        let jwks_url = spawn_jwks_server().await;
        let app = routes::router(test_state_with(&jwks_url, "postgres://localhost:1/x"));
        let token = mint_token(
            "0b9f9bbd-6a55-4f2c-9d3e-111111111111",
            "v@example.com",
            "service_role",
            TEST_ISSUER,
            300,
        );
        let (status, json) = get_me(app, Some(&token)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "INVALID_TOKEN");
    }

    /// Full accept path + H5 promotion against the docker-compose Postgres.
    /// Run explicitly: `cargo test -p zkvote-api -- --ignored`
    #[tokio::test]
    #[ignore = "requires the docker-compose Postgres (scripts/local/smoke.sh)"]
    async fn me_reports_role_and_promotes_invited_admin() {
        use auth::token::test_support::*;
        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let state = test_state_with(&jwks_url, database_url);
        let pool = state.pg.clone();

        let user_id = uuid::Uuid::new_v4();
        let email = format!("invited-{user_id}@example.com");
        let token = mint_token(
            &user_id.to_string(),
            &email,
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        // Not allowlisted as admin: authenticated but is_admin = false, and
        // the admin-only route rejects with 403.
        let (status, json) = get_me(routes::router(state.clone()), Some(&token)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["is_admin"], false);
        assert_eq!(json["email"], email);
        let response = routes::router(state.clone())
            .oneshot(
                Request::get("/api/admin/ping")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        // Invite the e-mail, then the next role lookup must promote (H5) and
        // the admin-only route must open up.
        sqlx::query("INSERT INTO admin_invitations (email) VALUES ($1)")
            .bind(&email)
            .execute(&pool)
            .await
            .unwrap();
        let (status, json) = get_me(routes::router(state.clone()), Some(&token)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["is_admin"], true);
        let response = routes::router(state.clone())
            .oneshot(
                Request::get("/api/admin/ping")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // The invitation is consumed (accepted), not left pending.
        let pending: Option<String> = sqlx::query_scalar(
            "SELECT email::text FROM admin_invitations WHERE email = $1 AND accepted_at IS NULL",
        )
        .bind(&email)
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(pending.is_none());

        sqlx::query("DELETE FROM admin_invitations WHERE email = $1")
            .bind(&email)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admins WHERE id = $1")
            .bind(user_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    /// H5 race gate: invitation promotion must be claim-first. A request that
    /// loses the accepted_at race must not insert a different admin row for
    /// the same invited e-mail.
    #[tokio::test]
    #[ignore = "requires the docker-compose Postgres (scripts/local/smoke.sh)"]
    async fn concurrent_admin_invitation_claim_promotes_only_the_winner() {
        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let state = test_state_with("http://127.0.0.1:1/jwks", database_url);
        let pool = state.pg.clone();

        let email = format!("race-{}@example.com", uuid::Uuid::new_v4());
        let user_a = auth::CurrentUser {
            id: uuid::Uuid::new_v4(),
            email: Some(email.clone()),
        };
        let user_b = auth::CurrentUser {
            id: uuid::Uuid::new_v4(),
            email: Some(email.clone()),
        };

        sqlx::query("INSERT INTO admin_invitations (email) VALUES ($1)")
            .bind(&email)
            .execute(&pool)
            .await
            .unwrap();

        let (result_a, result_b) = tokio::join!(
            auth::is_admin_or_promote(&pool, &user_a),
            auth::is_admin_or_promote(&pool, &user_b),
        );
        let result_a = result_a.unwrap();
        let result_b = result_b.unwrap();
        assert_eq!(usize::from(result_a) + usize::from(result_b), 1);

        let admin_ids: Vec<uuid::Uuid> =
            sqlx::query_scalar("SELECT id FROM admins WHERE email = $1 ORDER BY id")
                .bind(&email)
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(admin_ids.len(), 1);
        if result_a {
            assert_eq!(admin_ids[0], user_a.id);
        } else {
            assert_eq!(admin_ids[0], user_b.id);
        }

        let accepted_by: Option<uuid::Uuid> =
            sqlx::query_scalar("SELECT accepted_by FROM admin_invitations WHERE email = $1")
                .bind(&email)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(accepted_by, Some(admin_ids[0]));

        sqlx::query("DELETE FROM admin_invitations WHERE email = $1")
            .bind(&email)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admins WHERE email = $1")
            .bind(&email)
            .execute(&pool)
            .await
            .unwrap();
    }

    async fn get_json(
        app: axum::Router,
        path: &str,
        bearer: &str,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .oneshot(
                Request::get(path)
                    .header("authorization", format!("Bearer {bearer}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    fn row_by_id<'a>(rows: &'a serde_json::Value, id: &str) -> Option<&'a serde_json::Value> {
        rows.as_array().unwrap().iter().find(|row| row["id"] == id)
    }

    /// The three read-only lists apply the correct visibility rules and
    /// response shapes against seeded DB state.
    /// Run explicitly: `cargo test -p zkvote-api -- --ignored`
    #[tokio::test]
    #[ignore = "requires the docker-compose Postgres (scripts/local/smoke.sh)"]
    async fn read_only_lists_match_node_visibility_rules() {
        use auth::token::test_support::*;
        use time::{Duration, OffsetDateTime};
        use zkvote_db::repos::{ElectionRepo, NewElection, VoterRepo};

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let state = test_state_with(&jwks_url, database_url);
        let pool = state.pg.clone();
        let now = OffsetDateTime::now_utc();

        let admin_id = uuid::Uuid::new_v4();
        let voter_id = uuid::Uuid::new_v4();
        let voter_email = format!("voter-{voter_id}@example.com");
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();

        let new = |name: &str| NewElection {
            name: format!("{name} {voter_id}"),
            merkle_tree_depth: 4,
            candidates: vec!["A".to_string(), "B".to_string()],
            registration_end_time: now + Duration::hours(1),
        };
        // A: registration open, voter allowlisted but unregistered.
        let a = ElectionRepo::create(&pool, &new("p7 reg-open"))
            .await
            .unwrap();
        VoterRepo::insert_allowlisted(&pool, a.id, &voter_email)
            .await
            .unwrap();
        // B: voting active, voter registered.
        let b = ElectionRepo::create(&pool, &new("p7 voting"))
            .await
            .unwrap();
        VoterRepo::insert_allowlisted(&pool, b.id, &voter_email)
            .await
            .unwrap();
        VoterRepo::bind_registration(&pool, b.id, &voter_email, voter_id, "Voter", "123")
            .await
            .unwrap();
        ElectionRepo::finalize_sync(
            &pool,
            b.id,
            "42",
            now + Duration::minutes(1),
            now,
            now + Duration::hours(1),
        )
        .await
        .unwrap();
        // C: completed, voter registered.
        let c = ElectionRepo::create(&pool, &new("p7 completed"))
            .await
            .unwrap();
        VoterRepo::insert_allowlisted(&pool, c.id, &voter_email)
            .await
            .unwrap();
        VoterRepo::bind_registration(&pool, c.id, &voter_email, voter_id, "Voter", "456")
            .await
            .unwrap();
        ElectionRepo::finalize_sync(
            &pool,
            c.id,
            "43",
            now + Duration::minutes(1),
            now - Duration::hours(2),
            now - Duration::hours(1),
        )
        .await
        .unwrap();
        ElectionRepo::mark_completed(&pool, c.id).await.unwrap();
        // D: registration open, voter NOT allowlisted (admin-only visibility).
        let d = ElectionRepo::create(&pool, &new("p7 hidden"))
            .await
            .unwrap();
        // E: registration starts in the future; it must not leak into either
        // registerable list even though its end time is still open.
        let e = ElectionRepo::create(&pool, &new("p7 future-registration"))
            .await
            .unwrap();
        VoterRepo::insert_allowlisted(&pool, e.id, &voter_email)
            .await
            .unwrap();
        sqlx::query("UPDATE elections SET registration_start_time = $2 WHERE id = $1")
            .bind(e.id)
            .bind(now + Duration::minutes(30))
            .execute(&pool)
            .await
            .unwrap();
        // F: finalized but voting starts in the future; it is not yet votable.
        let f = ElectionRepo::create(&pool, &new("p7 future-voting"))
            .await
            .unwrap();
        VoterRepo::insert_allowlisted(&pool, f.id, &voter_email)
            .await
            .unwrap();
        VoterRepo::bind_registration(&pool, f.id, &voter_email, voter_id, "Voter", "789")
            .await
            .unwrap();
        ElectionRepo::finalize_sync(
            &pool,
            f.id,
            "44",
            now + Duration::minutes(1),
            now + Duration::hours(1),
            now + Duration::hours(2),
        )
        .await
        .unwrap();
        // G: superseded registration-stage election; hidden from every
        // registerable list.
        let g = ElectionRepo::create(&pool, &new("p7 superseded-registration"))
            .await
            .unwrap();
        VoterRepo::insert_allowlisted(&pool, g.id, &voter_email)
            .await
            .unwrap();
        sqlx::query("UPDATE elections SET superseded_at = $2 WHERE id = $1")
            .bind(g.id)
            .bind(now)
            .execute(&pool)
            .await
            .unwrap();
        // H: superseded active voting election; hidden from finalized lists.
        let h = ElectionRepo::create(&pool, &new("p7 superseded-voting"))
            .await
            .unwrap();
        VoterRepo::insert_allowlisted(&pool, h.id, &voter_email)
            .await
            .unwrap();
        VoterRepo::bind_registration(&pool, h.id, &voter_email, voter_id, "Voter", "999")
            .await
            .unwrap();
        ElectionRepo::finalize_sync(
            &pool,
            h.id,
            "45",
            now + Duration::minutes(1),
            now - Duration::minutes(10),
            now + Duration::hours(1),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE elections SET superseded_at = $2 WHERE id = $1")
            .bind(h.id)
            .bind(now)
            .execute(&pool)
            .await
            .unwrap();
        // I: superseded completed election; hidden from completed lists.
        let i = ElectionRepo::create(&pool, &new("p7 superseded-completed"))
            .await
            .unwrap();
        VoterRepo::insert_allowlisted(&pool, i.id, &voter_email)
            .await
            .unwrap();
        VoterRepo::bind_registration(&pool, i.id, &voter_email, voter_id, "Voter", "1001")
            .await
            .unwrap();
        ElectionRepo::finalize_sync(
            &pool,
            i.id,
            "46",
            now + Duration::minutes(1),
            now - Duration::hours(2),
            now - Duration::hours(1),
        )
        .await
        .unwrap();
        ElectionRepo::mark_completed(&pool, i.id).await.unwrap();
        sqlx::query("UPDATE elections SET superseded_at = $2 WHERE id = $1")
            .bind(i.id)
            .bind(now)
            .execute(&pool)
            .await
            .unwrap();

        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let voter_token = mint_token(
            &voter_id.to_string(),
            &voter_email,
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let a_id = a.id.to_string();
        let b_id = b.id.to_string();
        let c_id = c.id.to_string();
        let d_id = d.id.to_string();
        let e_id = e.id.to_string();
        let f_id = f.id.to_string();
        let g_id = g.id.to_string();
        let h_id = h.id.to_string();
        let i_id = i.id.to_string();

        // /registerable — admin sees A and D without isRegistered.
        let (status, rows) = get_json(
            routes::router(state.clone()),
            "/api/elections/registerable",
            &admin_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let row_a = row_by_id(&rows, &a_id).expect("admin must see A");
        assert!(row_by_id(&rows, &d_id).is_some(), "admin must see D");
        assert!(
            row_by_id(&rows, &e_id).is_none(),
            "admin must NOT see future registration E"
        );
        assert!(
            row_by_id(&rows, &g_id).is_none(),
            "admin must NOT see superseded registration G"
        );
        assert!(row_a.get("isRegistered").is_none());
        assert!(row_a["registration_end_time"].as_str().is_some());

        // /registerable — voter sees only A, with isRegistered=false.
        let (status, rows) = get_json(
            routes::router(state.clone()),
            "/api/elections/registerable",
            &voter_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let row_a = row_by_id(&rows, &a_id).expect("voter must see allowlisted A");
        assert_eq!(row_a["isRegistered"], false);
        assert!(row_by_id(&rows, &d_id).is_none(), "voter must NOT see D");
        assert!(
            row_by_id(&rows, &e_id).is_none(),
            "voter must NOT see future registration E"
        );
        assert!(
            row_by_id(&rows, &g_id).is_none(),
            "voter must NOT see superseded registration G"
        );

        // /finalized — admin sees B with voter counts.
        let (status, rows) = get_json(
            routes::router(state.clone()),
            "/api/elections/finalized",
            &admin_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let row_b = row_by_id(&rows, &b_id).expect("admin must see voting B");
        assert_eq!(row_b["total_voters"], 1);
        assert_eq!(row_b["registered_voters"], 1);
        assert_eq!(row_b["num_candidates"], 2);
        assert!(
            row_by_id(&rows, &f_id).is_none(),
            "admin must NOT see future voting F"
        );
        assert!(
            row_by_id(&rows, &h_id).is_none(),
            "admin must NOT see superseded voting H"
        );

        // /finalized — voter sees B (registered) but the completed C is gone.
        let (status, rows) = get_json(
            routes::router(state.clone()),
            "/api/elections/finalized",
            &voter_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let row_b = row_by_id(&rows, &b_id).expect("voter must see voting B");
        assert!(
            row_b.get("total_voters").is_none(),
            "voter finalized rows must not include admin-only total_voters"
        );
        assert!(
            row_b.get("registered_voters").is_none(),
            "voter finalized rows must not include admin-only registered_voters"
        );
        assert!(row_by_id(&rows, &c_id).is_none());
        assert!(
            row_by_id(&rows, &f_id).is_none(),
            "voter must NOT see future voting F"
        );
        assert!(
            row_by_id(&rows, &h_id).is_none(),
            "voter must NOT see superseded voting H"
        );

        // /completed — both see C.
        for token in [&admin_token, &voter_token] {
            let (status, rows) = get_json(
                routes::router(state.clone()),
                "/api/elections/completed",
                token,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert!(row_by_id(&rows, &c_id).is_some());
            assert!(
                row_by_id(&rows, &i_id).is_none(),
                "completed list must NOT show superseded completed I"
            );
        }

        for id in [a.id, b.id, c.id, d.id, e.id, f.id, g.id, h.id, i.id] {
            sqlx::query("DELETE FROM elections WHERE id = $1")
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("DELETE FROM admins WHERE id = $1")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    async fn post_json(
        app: axum::Router,
        path: &str,
        bearer: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .oneshot(
                Request::post(path)
                    .header("authorization", format!("Bearer {bearer}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    /// G4: the supersede endpoint is admin-gated, lease-serialized against
    /// finalize, durably fail-closes the row, and is idempotent.
    #[tokio::test]
    #[ignore = "requires docker PG + Redis (scripts/local/smoke.sh)"]
    async fn supersede_endpoint_guards_and_fails_closed() {
        use auth::token::test_support::*;
        use zkvote_db::repos::{ElectionRepo, NewElection};

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let jwks = jwks_url.clone();
        let db = database_url.to_string();
        // Live Redis (the lease serialization is load-bearing here).
        let config = Arc::new(
            AppConfig::from_lookup(move |name| match name {
                "DATABASE_URL" => Some(db.clone()),
                "REDIS_URL" => Some("redis://localhost:6379".to_string()),
                "SUPABASE_JWKS_URL" => Some(jwks.clone()),
                "SUPABASE_JWT_ISSUER" => Some(TEST_ISSUER.to_string()),
                _ => None,
            })
            .unwrap(),
        );
        let auth = config.supabase_jwks_url.clone().map(|url| {
            Arc::new(AuthContext::new(
                url,
                config.supabase_issuer.clone(),
                config.supabase_audience.clone(),
            ))
        });
        let state = AppState {
            config: config.clone(),
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open("redis://localhost:6379").unwrap(),
            auth,
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        let pool = state.pg.clone();

        let admin_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let voter_token = mint_token(
            &uuid::Uuid::new_v4().to_string(),
            "rando@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        let election = ElectionRepo::create(
            &pool,
            &NewElection {
                name: format!("supersede election {admin_id}"),
                merkle_tree_depth: 4,
                candidates: vec!["A".to_string(), "B".to_string()],
                registration_end_time: time::OffsetDateTime::now_utc() + time::Duration::hours(1),
            },
        )
        .await
        .unwrap();
        let eid = election.id;
        let path = format!("/api/elections/{eid}/supersede");

        // Non-admin cannot supersede.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &path,
            &voter_token,
            serde_json::json!({"reason": "x"}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json["error"], "ADMIN_PRIVILEGES_REQUIRED");

        // Missing reason -> 400.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &path,
            &admin_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "VALIDATION_ERROR");

        // A held finalize lease blocks supersede (no half-state with finalize).
        let lease = leases::acquire(
            &state.redis,
            leases::finalize_lease_key(&eid),
            leases::FINALIZE_LEASE_SECONDS,
            "HELD",
            "held by test",
        )
        .await
        .unwrap();
        let (status, json) = post_json(
            routes::router(state.clone()),
            &path,
            &admin_token,
            serde_json::json!({"reason": "blocked"}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "FINALIZATION_IN_PROGRESS");
        leases::release(&state.redis, &lease).await.unwrap();

        // Admin supersede succeeds and durably fail-closes the row.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &path,
            &admin_token,
            serde_json::json!({"reason": "operator abandon"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "supersede failed: {json}");
        assert_eq!(json["state"], "failed");
        let row = ElectionRepo::find(&pool, eid).await.unwrap().unwrap();
        assert!(row.superseded_at.is_some());
        assert_eq!(row.state, "failed");

        // Idempotent: a second supersede is a 409.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &path,
            &admin_token,
            serde_json::json!({"reason": "again"}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "ALREADY_SUPERSEDED");

        // Downstream guard fails closed: deploy on a superseded election rejects.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{eid}/setZkDeploy"),
            &admin_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "ELECTION_SUPERSEDED");

        sqlx::query("DELETE FROM elections WHERE id = $1")
            .bind(eid)
            .execute(&pool)
            .await
            .unwrap();
    }

    /// G5: artifact registration writes a sha256-bearing manifest so
    /// /artifact-info serves a verified (integrity-checked) set, and rejects
    /// manifests missing the sha256 fields the browser fetch needs.
    #[tokio::test]
    #[ignore = "requires the docker-compose Postgres (scripts/local/smoke.sh)"]
    async fn zk_artifact_registration_and_verified_artifact_info() {
        use auth::token::test_support::*;
        use http_body_util::BodyExt;
        use zkvote_db::repos::{DeploymentRepo, ElectionRepo, NewElection};

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let state = test_state_with(&jwks_url, database_url);
        let pool = state.pg.clone();

        let admin_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        let wasm_sha = "11".repeat(32);
        let zkey_sha = "22".repeat(32);
        let vk_sha = "33".repeat(32);
        let version = format!("g5-{admin_id}");

        // Manifest missing sha256 -> 400 (fail closed at registration).
        let (status, json) = post_json(
            routes::router(state.clone()),
            "/api/admin/zk-artifacts",
            &admin_token,
            serde_json::json!({
                "circuitId": "votecheck", "version": format!("{version}-bad"),
                "merkleTreeDepth": 4, "numCandidates": 10,
                "manifest": { "publicSignalCount": 4 }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "VALIDATION_ERROR");

        // Valid registration -> 201.
        let (status, json) = post_json(
            routes::router(state.clone()),
            "/api/admin/zk-artifacts",
            &admin_token,
            serde_json::json!({
                "circuitId": "votecheck", "version": version,
                "merkleTreeDepth": 4, "numCandidates": 10,
                "wasmUri": "gs://b/VoteCheck.wasm", "zkeyUri": "gs://b/circuit_final.zkey",
                "manifest": {
                    "wasmSha256": wasm_sha, "zkeySha256": zkey_sha,
                    "verificationKeySha256": vk_sha, "publicSignalCount": 4,
                    "publicSignals": ["root", "candidateIndex", "nullifierHash", "election_id"]
                }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "register failed: {json}");
        let artifact_id: uuid::Uuid = json["artifactId"].as_str().unwrap().parse().unwrap();

        // Bind it to a (manually) deployed election so /artifact-info joins it.
        let election = ElectionRepo::create(
            &pool,
            &NewElection {
                name: format!("g5 election {admin_id}"),
                merkle_tree_depth: 4,
                candidates: vec!["A".into(), "B".into(), "C".into(), "D".into(), "E".into()],
                registration_end_time: time::OffsetDateTime::now_utc() + time::Duration::hours(1),
            },
        )
        .await
        .unwrap();
        assert!(DeploymentRepo::record_and_bind(
            &pool,
            election.id,
            Some(artifact_id),
            &format!("0xverifier-{admin_id}"),
            &format!("0xtally-{admin_id}"),
            31337,
            &format!("0xhash-{admin_id}"),
        )
        .await
        .unwrap());

        // /artifact-info returns the verified manifest (NOT a 409).
        let app = routes::router(state.clone());
        let req = Request::get(format!("/api/elections/{}/artifact-info", election.id))
            .header("authorization", format!("Bearer {admin_token}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let info: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(info["wasmSha256"], wasm_sha);
        assert_eq!(info["zkeySha256"], zkey_sha);
        assert_eq!(info["verificationKeySha256"], vk_sha);

        sqlx::query("DELETE FROM elections WHERE id = $1")
            .bind(election.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM zk_artifacts WHERE id = $1")
            .bind(artifact_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    /// L-proof-rl: the atomic limiter caps per key and is isolated across keys.
    #[tokio::test]
    #[ignore = "requires Redis (scripts/local/smoke.sh)"]
    async fn rate_limiter_caps_and_isolates_by_key() {
        let client = RedisClient::open("redis://localhost:6379").unwrap();
        let key = format!("test-rl:{}", uuid::Uuid::new_v4());
        // limit 2: the first two pass, the third is rejected with 429.
        ratelimit::check_rate(&client, &key, 2, 60).await.unwrap();
        ratelimit::check_rate(&client, &key, 2, 60).await.unwrap();
        let err = ratelimit::check_rate(&client, &key, 2, 60)
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            crate::error::ApiError::Coded { status: 429, .. }
        ));
        // a different key has its own budget.
        let other = format!("test-rl:{}", uuid::Uuid::new_v4());
        ratelimit::check_rate(&client, &other, 2, 60).await.unwrap();
    }

    /// L-ticket-burn: a consumed ticket can be restored (same payload, issued_at
    /// preserved) so a transient never-landed relay doesn't burn it.
    #[tokio::test]
    #[ignore = "requires Redis (scripts/local/smoke.sh)"]
    async fn ticket_restore_reinstates_consumed_ticket() {
        let client = RedisClient::open("redis://localhost:6379").unwrap();
        let payload = tickets::TicketPayload {
            election_id: uuid::Uuid::new_v4(),
            merkle_root: "123".to_string(),
            issued_at: Some("2026-06-23T00:00:00.000Z".to_string()),
        };
        let token = tickets::issue(&client, &payload).await.unwrap();
        assert!(tickets::consume(&client, &token).await.unwrap().is_some());
        assert!(tickets::read(&client, &token).await.unwrap().is_none());

        tickets::restore(&client, &token, &payload).await.unwrap();
        let restored = tickets::read(&client, &token).await.unwrap().unwrap();
        assert_eq!(restored.merkle_root, "123");
        assert_eq!(
            restored.issued_at.as_deref(),
            Some("2026-06-23T00:00:00.000Z")
        );
        let _ = tickets::consume(&client, &token).await;
    }

    /// Admin setup gates: creation validation (M4), invitation upsert
    /// idempotency, deploy guard. Run: `cargo test -p zkvote-api -- --ignored`
    #[tokio::test]
    #[ignore = "requires the docker-compose Postgres (scripts/local/smoke.sh)"]
    async fn admin_setup_routes_validate_and_guard() {
        use auth::token::test_support::*;

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let state = test_state_with(&jwks_url, database_url);
        let pool = state.pg.clone();

        let admin_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let voter_token = mint_token(
            &uuid::Uuid::new_v4().to_string(),
            "rando@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        let future = (time::OffsetDateTime::now_utc() + time::Duration::hours(1))
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        // Depth 6 is a supported padded bucket (Groth16Verifier_6_10 is built) AND
        // no deploy/E2E test registers a (6, 10) artifact, so the setZkDeploy
        // "no artifact" assertion below stays isolated. The real candidate count
        // (4) is independent of the width-10 circuit; VotingTally enforces the bound.
        let valid_body = serde_json::json!({
            "name": format!("p8 election {admin_id}"),
            "merkleTreeDepth": 6,
            "candidates": [" A ", "B", "C", "D"],
            "regEndTime": future,
        });

        // Non-admin cannot create elections.
        let (status, json) = post_json(
            routes::router(state.clone()),
            "/api/elections/set",
            &voter_token,
            valid_body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json["error"], "ADMIN_PRIVILEGES_REQUIRED");

        // Valid creation: 201 with the expected response shape + trimmed candidates.
        let (status, json) = post_json(
            routes::router(state.clone()),
            "/api/elections/set",
            &admin_token,
            valid_body,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "create failed: {json}");
        assert_eq!(json["success"], true);
        assert_eq!(json["election"]["num_candidates"], 4);
        assert_eq!(json["election"]["candidates"][0], "A");
        let election_id = json["election"]["id"].as_str().unwrap().to_string();

        // L-depth1: an UNSUPPORTED depth bucket (5 — no Groth16Verifier_5_10 is
        // built; the supported buckets are {4,6,8,10}) is rejected at CREATION,
        // not deferred to setZkDeploy. The candidate count is irrelevant (padded
        // width 10), so this exercises the depth-bucket gate specifically.
        let (status, json) = post_json(
            routes::router(state.clone()),
            "/api/elections/set",
            &admin_token,
            serde_json::json!({
                "name": format!("unbuilt {admin_id}"),
                "merkleTreeDepth": 5,
                "candidates": ["A", "B"],
                "regEndTime": future,
            }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "expected 422: {json}"
        );
        assert_eq!(json["error"], "ARTIFACT_SHAPE_UNSUPPORTED");

        // Malformed date is rejected.
        let (status, json) = post_json(
            routes::router(state.clone()),
            "/api/elections/set",
            &admin_token,
            serde_json::json!({
                "name": "bad", "merkleTreeDepth": 4,
                "candidates": ["A"], "regEndTime": "tomorrow-ish",
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "VALIDATION_ERROR");

        // Duplicate candidates are rejected (audit M4).
        let (status, _) = post_json(
            routes::router(state.clone()),
            "/api/elections/set",
            &admin_token,
            serde_json::json!({
                "name": "dup", "merkleTreeDepth": 4,
                "candidates": ["Alice", " alice"], "regEndTime": future,
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        // setZkDeploy: no registered artifact set -> blocked.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{election_id}/setZkDeploy"),
            &admin_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json["details"]
            .as_str()
            .unwrap()
            .contains("No registered ZK artifact set"));

        // addAdmins: idempotent invitation upsert.
        let invite_email = format!("invitee-{admin_id}@example.com");
        for _ in 0..2 {
            let (status, json) = post_json(
                routes::router(state.clone()),
                "/api/management/addAdmins",
                &admin_token,
                serde_json::json!({ "email": format!(" {} ", invite_email.to_uppercase()) }),
            )
            .await;
            assert_eq!(status, StatusCode::CREATED);
            assert_eq!(json["promotedExistingUser"], false);
        }
        assert!(
            zkvote_db::repos::AdminRepo::pending_invitation_exists(&pool, &invite_email)
                .await
                .unwrap()
        );

        sqlx::query("DELETE FROM elections WHERE id = $1::uuid")
            .bind(&election_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admin_invitations WHERE email = $1")
            .bind(&invite_email)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admins WHERE id = $1")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    /// Route gate: /setZkDeploy itself must deploy through the
    /// typed chain layer, bind the selected artifact, and persist metadata.
    /// Requires docker PG+Redis and a local anvil node:
    ///   bash scripts/local/smoke.sh && anvil
    /// Run: `cargo test -p zkvote-api -- --ignored set_zk_deploy_route --test-threads=1`
    #[tokio::test]
    #[ignore = "requires docker PG+Redis and a local anvil node"]
    async fn set_zk_deploy_route_deploys_and_records_metadata() {
        use auth::token::test_support::*;
        use time::{Duration, OffsetDateTime};
        use zkvote_db::repos::{ElectionRepo, NewElection};

        const RPC: &str = "http://127.0.0.1:8545";
        const RELAYER_KEY: &str =
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        const OWNER_KEY: &str =
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
        const OWNER_ADDR: &str = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let contract_artifacts_dir = format!("{}/../../../out", env!("CARGO_MANIFEST_DIR"));
        let jwks_url = spawn_jwks_server().await;
        let jwks = jwks_url.clone();
        let db = database_url.to_string();
        let artifacts_dir = contract_artifacts_dir.clone();
        let config = Arc::new(
            AppConfig::from_lookup(move |name| match name {
                "DATABASE_URL" => Some(db.clone()),
                "REDIS_URL" => Some("redis://localhost:6379".to_string()),
                "SUPABASE_JWKS_URL" => Some(jwks.clone()),
                "SUPABASE_JWT_ISSUER" => Some(TEST_ISSUER.to_string()),
                "SEPOLIA_RPC_URL" => Some(RPC.to_string()),
                "RELAYER_PRIVATE_KEY" => Some(RELAYER_KEY.to_string()),
                "OWNER_PRIVATE_KEY" => Some(OWNER_KEY.to_string()),
                "CHAIN_ID" => Some("31337".to_string()),
                "CONTRACT_ARTIFACTS_DIR" => Some(artifacts_dir.clone()),
                _ => None,
            })
            .unwrap(),
        );
        let auth_ctx = Some(Arc::new(AuthContext::new(
            jwks_url,
            config.supabase_issuer.clone(),
            config.supabase_audience.clone(),
        )));
        let state = AppState {
            config: config.clone(),
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open(config.redis_url.as_str()).unwrap(),
            auth: auth_ctx,
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        let pool = state.pg.clone();
        let now = OffsetDateTime::now_utc();

        let admin_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        let election = ElectionRepo::create(
            &pool,
            &NewElection {
                name: format!("p11 route deploy {admin_id}"),
                merkle_tree_depth: 4,
                candidates: vec![
                    "A".to_string(),
                    "B".to_string(),
                    "C".to_string(),
                    "D".to_string(),
                    "E".to_string(),
                ],
                registration_end_time: now + Duration::hours(1),
            },
        )
        .await
        .unwrap();

        let artifact_id: uuid::Uuid = sqlx::query_scalar(
            "INSERT INTO zk_artifacts \
                 (circuit_id, version, backend, merkle_tree_depth, num_candidates, \
                  wasm_uri, zkey_uri, verification_key_uri, solidity_verifier_uri, sha256, manifest) \
             VALUES ($1, $2, 'circom', 4, 10, $3, $4, $5, $6, $7, $8) RETURNING id",
        )
        .bind("votecheck")
        .bind(format!("route-deploy-{admin_id}"))
        .bind("gs://bucket/circuits/votecheck/v1/VoteCheck.wasm")
        .bind("gs://bucket/circuits/votecheck/v1/circuit_final.zkey")
        .bind("gs://bucket/circuits/votecheck/v1/verification_key.json")
        .bind("gs://bucket/circuits/votecheck/v1/Groth16Verifier_4_10.sol")
        .bind("0".repeat(64))
        .bind(serde_json::json!({
            "publicSignalCount": 4,
            "publicSignals": ["root", "candidateIndex", "nullifierHash", "election_id"]
        }))
        .fetch_one(&pool)
        .await
        .unwrap();

        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{}/setZkDeploy", election.id),
            &admin_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "setZkDeploy failed: {json}");
        assert_eq!(json["success"], true);
        let contract_address = json["contractAddress"].as_str().unwrap();
        let verifier_address = json["verifierAddress"].as_str().unwrap();
        assert!(contract_address.starts_with("0x"));
        assert!(verifier_address.starts_with("0x"));

        let row: (Option<String>, Option<String>, String) = sqlx::query_as(
            "SELECT contract_address, verifier_address, state FROM elections WHERE id = $1",
        )
        .bind(election.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0.as_deref(), Some(contract_address));
        assert_eq!(row.1.as_deref(), Some(verifier_address));
        assert_eq!(row.2, "contract_deployed");

        let deployment: (uuid::Uuid, i64, String) = sqlx::query_as(
            "SELECT zk_artifact_id, chain_id, deploy_tx_hash \
             FROM contract_deployments WHERE election_id = $1",
        )
        .bind(election.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(deployment.0, artifact_id);
        assert_eq!(deployment.1, 31337);
        assert!(deployment.2.starts_with("0x"));

        let chain_config = zkvote_chain::ChainConfig {
            rpc_url: RPC.to_string(),
            relayer_private_key: RELAYER_KEY.to_string(),
        };
        let onchain =
            zkvote_chain::connect_election(&chain_config, contract_address.parse().unwrap())
                .unwrap();
        assert_eq!(
            onchain.owner().await.unwrap(),
            OWNER_ADDR.parse::<alloy::primitives::Address>().unwrap()
        );

        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{}/setZkDeploy", election.id),
            &admin_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "CONFLICT");

        sqlx::query("DELETE FROM elections WHERE id = $1")
            .bind(election.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM zk_artifacts WHERE id = $1")
            .bind(artifact_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admins WHERE id = $1")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    /// Voter gates: allowlist capacity + dedup, registration lifecycle
    /// rejections, AR-H6 commitment re-binding.
    /// Run: `cargo test -p zkvote-api -- --ignored`
    #[tokio::test]
    #[ignore = "requires the docker-compose Postgres (scripts/local/smoke.sh)"]
    async fn voter_allowlist_and_registration_gates() {
        use auth::token::test_support::*;
        use time::{Duration, OffsetDateTime};

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let state = test_state_with(&jwks_url, database_url);
        let pool = state.pg.clone();
        let now = OffsetDateTime::now_utc();

        let admin_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let voter_id = uuid::Uuid::new_v4();
        let voter_email = format!("p9-voter-{voter_id}@example.com");
        let voter_token = mint_token(
            &voter_id.to_string(),
            &voter_email,
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        // depth 2 -> Merkle capacity 4 (AR-H2 gate material).
        let election = zkvote_db::repos::ElectionRepo::create(
            &pool,
            &zkvote_db::repos::NewElection {
                name: format!("p9 election {voter_id}"),
                merkle_tree_depth: 2,
                candidates: vec!["A".to_string(), "B".to_string()],
                registration_end_time: now + Duration::hours(1),
            },
        )
        .await
        .unwrap();
        let base = format!("/api/elections/{}", election.id);

        // Five emails exceed capacity 4 -> OVER_CAPACITY, nothing inserted.
        let many: Vec<String> = (0..5)
            .map(|i| format!("p9-{i}-{voter_id}@example.com"))
            .collect();
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("{base}/voters"),
            &admin_token,
            serde_json::json!({ "emails": many }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "expected OVER_CAPACITY: {json}"
        );
        assert_eq!(json["error"], "OVER_CAPACITY");

        // Three valid + one duplicate + one invalid -> summary counts.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("{base}/voters"),
            &admin_token,
            serde_json::json!({ "emails": [voter_email, voter_email.to_uppercase(), "not-an-email", format!("p9-x-{voter_id}@example.com")] }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "allowlist failed: {json}");
        assert_eq!(json["summary"]["newly_registered_count"], 2);
        assert_eq!(json["summary"]["duplicates_skipped_count"], 0);
        assert_eq!(json["summary"]["invalid_format_skipped_count"], 1);

        // Re-adding the same email reports a duplicate skip.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("{base}/voters"),
            &admin_token,
            serde_json::json!({ "emails": [voter_email] }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["summary"]["duplicates_skipped_count"], 1);

        // Registration: happy path stores the commitment.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("{base}/register"),
            &voter_token,
            serde_json::json!({ "name": "Alice", "secretCommitment": "123" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "register failed: {json}");

        // Another user on the same allowlist row -> ALREADY_REGISTERED.
        let other_token = mint_token(
            &uuid::Uuid::new_v4().to_string(),
            &voter_email,
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("{base}/register"),
            &other_token,
            serde_json::json!({ "name": "Mallory", "secretCommitment": "999" }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "ALREADY_REGISTERED");

        // AR-H6: the SAME user re-binds a fresh commitment before finalize.
        let (status, _) = post_json(
            routes::router(state.clone()),
            &format!("{base}/register"),
            &voter_token,
            serde_json::json!({ "name": "Alice", "secretCommitment": "0x1c8" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let stored: Option<String> = sqlx::query_scalar(
            "SELECT user_secret_commitment FROM voters WHERE election_id = $1 AND user_id = $2",
        )
        .bind(election.id)
        .bind(voter_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            stored.as_deref(),
            Some("456"),
            "0x1c8 == 456 must be re-bound"
        );

        // G1: a different allowlisted voter must NOT register a commitment that
        // another voter already holds (identical Merkle leaves share one
        // nullifier, silently disenfranchising the second voter on-chain). The
        // p9-x email was allowlisted above; voter_id now holds "456".
        let p9x_email = format!("p9-x-{voter_id}@example.com");
        let p9x_token = mint_token(
            &uuid::Uuid::new_v4().to_string(),
            &p9x_email,
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("{base}/register"),
            &p9x_token,
            serde_json::json!({ "name": "Bob", "secretCommitment": "456" }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "duplicate commitment must be rejected: {json}"
        );
        assert_eq!(json["error"], "COMMITMENT_ALREADY_USED");
        // A fresh, unused commitment for that same voter succeeds — the guard is
        // a uniqueness check, not a blanket block.
        let (status, _) = post_json(
            routes::router(state.clone()),
            &format!("{base}/register"),
            &p9x_token,
            serde_json::json!({ "name": "Bob", "secretCommitment": "789" }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        // Not on the allowlist -> 403.
        let stranger_token = mint_token(
            &uuid::Uuid::new_v4().to_string(),
            "stranger@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("{base}/register"),
            &stranger_token,
            serde_json::json!({ "name": "S", "secretCommitment": "1" }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json["error"], "NOT_ON_VOTER_LIST");

        // After finalization both surfaces fail closed.
        zkvote_db::repos::ElectionRepo::finalize_sync(
            &pool,
            election.id,
            "42",
            now + Duration::minutes(1),
            now,
            now + Duration::hours(1),
        )
        .await
        .unwrap();
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("{base}/register"),
            &voter_token,
            serde_json::json!({ "name": "Alice", "secretCommitment": "789" }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "ALREADY_FINALIZED");
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("{base}/voters"),
            &admin_token,
            serde_json::json!({ "emails": [format!("late-{voter_id}@example.com")] }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "ALREADY_FINALIZED");

        sqlx::query("DELETE FROM elections WHERE id = $1")
            .bind(election.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admins WHERE id = $1")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    #[ignore = "requires the docker-compose Postgres (scripts/local/smoke.sh)"]
    async fn finalize_rejects_superseded_elections_before_chain_side_effects() {
        use auth::token::test_support::*;
        use time::{Duration, OffsetDateTime};
        use zkvote_db::repos::{ElectionRepo, NewElection};

        const RELAYER_KEY: &str =
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        const OWNER_KEY: &str =
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let jwks = jwks_url.clone();
        let db = database_url.to_string();
        let config = Arc::new(
            AppConfig::from_lookup(move |name| match name {
                "DATABASE_URL" => Some(db.clone()),
                "REDIS_URL" => Some("redis://localhost:6379".to_string()),
                "SUPABASE_JWKS_URL" => Some(jwks.clone()),
                "SUPABASE_JWT_ISSUER" => Some(TEST_ISSUER.to_string()),
                "SEPOLIA_RPC_URL" => Some("http://127.0.0.1:1".to_string()),
                "RELAYER_PRIVATE_KEY" => Some(RELAYER_KEY.to_string()),
                "OWNER_PRIVATE_KEY" => Some(OWNER_KEY.to_string()),
                _ => None,
            })
            .unwrap(),
        );
        let state = AppState {
            config: config.clone(),
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open(config.redis_url.as_str()).unwrap(),
            auth: Some(Arc::new(AuthContext::new(
                jwks_url,
                config.supabase_issuer.clone(),
                config.supabase_audience.clone(),
            ))),
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        let pool = state.pg.clone();
        let now = OffsetDateTime::now_utc();

        let admin_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        let election = ElectionRepo::create(
            &pool,
            &NewElection {
                name: format!("p12 superseded {admin_id}"),
                merkle_tree_depth: 4,
                candidates: vec!["A".to_string(), "B".to_string()],
                registration_end_time: now + Duration::hours(1),
            },
        )
        .await
        .unwrap();
        sqlx::query("UPDATE elections SET contract_address = $2, superseded_at = $3 WHERE id = $1")
            .bind(election.id)
            .bind("0x0000000000000000000000000000000000000001")
            .bind(now)
            .execute(&pool)
            .await
            .unwrap();

        let vote_end = (now + Duration::hours(2)).format(&Rfc3339Fmt).unwrap();
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{}/finalize", election.id),
            &admin_token,
            serde_json::json!({ "voteEndTime": vote_end }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "ELECTION_SUPERSEDED");

        let job_count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM finalization_jobs WHERE election_id = $1")
                .bind(election.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(job_count, 0, "must reject before creating finalization job");

        let state_after: String = sqlx::query_scalar("SELECT state FROM elections WHERE id = $1")
            .bind(election.id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(state_after, "draft");

        sqlx::query("DELETE FROM elections WHERE id = $1")
            .bind(election.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admins WHERE id = $1")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    /// Durable + recoverable finalize against docker PG AND a
    /// local hardhat node. Start both first:
    ///   bash scripts/local/smoke.sh && anvil
    /// Run: `cargo test -p zkvote-api -- --ignored finalize`
    #[tokio::test]
    #[ignore = "requires docker PG and a local anvil node"]
    async fn finalize_configures_chain_and_syncs_db_once() {
        use auth::token::test_support::*;
        use time::{Duration, OffsetDateTime};
        use zkvote_db::repos::{ElectionRepo, NewElection, VoterRepo};

        const RPC: &str = "http://127.0.0.1:8545";
        const RELAYER_KEY: &str =
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        const OWNER_KEY: &str =
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
        const OWNER_ADDR: &str = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

        fn bytecode(rel: &str) -> Vec<u8> {
            let path = format!("{}/../../../{rel}", env!("CARGO_MANIFEST_DIR"));
            let raw = std::fs::read_to_string(&path).unwrap();
            let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
            // Hardhat: top-level string; Foundry (out/): nested {"object":"0x.."}.
            let hex = json["bytecode"]
                .as_str()
                .or_else(|| json["bytecode"]["object"].as_str())
                .unwrap()
                .trim_start_matches("0x");
            (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect()
        }

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let jwks = jwks_url.clone();
        let db = database_url.to_string();
        let config = Arc::new(
            AppConfig::from_lookup(move |name| match name {
                "DATABASE_URL" => Some(db.clone()),
                "REDIS_URL" => Some("redis://localhost:6379".to_string()),
                "SUPABASE_JWKS_URL" => Some(jwks.clone()),
                "SUPABASE_JWT_ISSUER" => Some(TEST_ISSUER.to_string()),
                "SEPOLIA_RPC_URL" => Some(RPC.to_string()),
                "PRIVATE_KEY" => Some(RELAYER_KEY.to_string()),
                "OWNER_PRIVATE_KEY" => Some(OWNER_KEY.to_string()),
                _ => None,
            })
            .unwrap(),
        );
        let auth_ctx = Some(Arc::new(AuthContext::new(
            jwks_url,
            config.supabase_issuer.clone(),
            config.supabase_audience.clone(),
        )));
        let state = AppState {
            config: config.clone(),
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open("redis://localhost:6379").unwrap(),
            auth: auth_ctx,
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        let pool = state.pg.clone();
        let now = OffsetDateTime::now_utc();

        let admin_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        // Election with two registered commitments (H(1), H(123) — the
        // AR-H7 vector values).
        let election = ElectionRepo::create(
            &pool,
            &NewElection {
                name: format!("p12 election {admin_id}"),
                merkle_tree_depth: 4,
                candidates: vec!["A".to_string(), "B".to_string()],
                registration_end_time: now + Duration::hours(1),
            },
        )
        .await
        .unwrap();
        for (i, secret) in ["1", "123"].iter().enumerate() {
            let email = format!("p12-{i}-{admin_id}@example.com");
            VoterRepo::insert_allowlisted(&pool, election.id, &email)
                .await
                .unwrap();
            VoterRepo::bind_registration(
                &pool,
                election.id,
                &email,
                uuid::Uuid::new_v4(),
                "V",
                &zkvote_zkp::poseidon::hash1(secret).unwrap(),
            )
            .await
            .unwrap();
        }

        // Deploy the contracts and bind the address (relayer deploys,
        // separate owner per AR-M4).
        let chain_config = zkvote_chain::ChainConfig {
            rpc_url: RPC.to_string(),
            relayer_private_key: RELAYER_KEY.to_string(),
        };
        let deployed = zkvote_chain::deploy_election(
            &chain_config,
            bytecode("out/Groth16Verifier_4_10.sol/Groth16Verifier_4_10.json"),
            bytecode("out/VotingTally.sol/VotingTally.json"),
            zkvote_domain::services::election_id_to_field(&election.id)
                .to_string()
                .parse()
                .unwrap(),
            alloy::primitives::U256::from(2u64),
            OWNER_ADDR.parse().unwrap(),
            31337, // anvil local node chain id (§0.5 gap #2)
        )
        .await
        .expect("deploy failed — is `anvil` running?");
        ElectionRepo::set_contract_address(
            &pool,
            election.id,
            &format!("{:#x}", deployed.voting_tally_address),
            &format!("{:#x}", deployed.verifier_address),
        )
        .await
        .unwrap();

        // AR-M7 duration gate (checked before any chain interaction).
        let too_long = (now + Duration::days(60)).format(&Rfc3339Fmt).unwrap();
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{}/finalize", election.id),
            &admin_token,
            serde_json::json!({ "voteEndTime": too_long }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "duration gate: {json}");
        assert_eq!(json["error"], "VOTING_DURATION_EXCEEDS_MAXIMUM");

        // Happy path.
        let vote_end = (now + Duration::hours(2)).format(&Rfc3339Fmt).unwrap();
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{}/finalize", election.id),
            &admin_token,
            serde_json::json!({ "voteEndTime": vote_end }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "finalize failed: {json}");
        let root = json["merkleRoot"].as_str().unwrap().to_string();

        // DB synced exactly once with the same root the chain holds.
        let db_root: Option<String> =
            sqlx::query_scalar("SELECT merkle_root FROM elections WHERE id = $1")
                .bind(election.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(db_root.as_deref(), Some(root.as_str()));
        let onchain =
            zkvote_chain::connect_election(&chain_config, deployed.voting_tally_address).unwrap();
        assert_eq!(
            onchain.merkle_root().await.unwrap().to_string(),
            root,
            "on-chain root must equal the DB root"
        );
        let job_status: String = sqlx::query_scalar(
            "SELECT status FROM finalization_jobs WHERE election_id = $1 ORDER BY created_at DESC LIMIT 1",
        )
        .bind(election.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(job_status, "db_synced");

        // Idempotence: a second finalize is rejected, root unchanged.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{}/finalize", election.id),
            &admin_token,
            serde_json::json!({ "voteEndTime": vote_end }),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "ALREADY_FINALIZED");

        sqlx::query("DELETE FROM elections WHERE id = $1")
            .bind(election.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admins WHERE id = $1")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    /// The full voting pipeline with a
    /// REAL Groth16 proof (committed fixture) against docker PG + docker
    /// Redis + a local anvil node:
    ///   bash scripts/local/smoke.sh && anvil
    /// Run: `cargo test -p zkvote-api -- --ignored vote_pipeline`
    #[tokio::test]
    #[ignore = "requires docker PG+Redis and a local anvil node"]
    async fn vote_pipeline_end_to_end_with_real_proof() {
        use auth::token::test_support::*;
        use time::{Duration, OffsetDateTime};
        use zkvote_db::repos::VoterRepo;

        const RPC: &str = "http://127.0.0.1:8545";
        const RELAYER_KEY: &str =
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        const OWNER_KEY: &str =
            "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
        const OWNER_ADDR: &str = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

        fn bytecode(rel: &str) -> Vec<u8> {
            let path = format!("{}/../../../{rel}", env!("CARGO_MANIFEST_DIR"));
            let raw = std::fs::read_to_string(&path).unwrap();
            let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
            // Hardhat: top-level string; Foundry (out/): nested {"object":"0x.."}.
            let hex = json["bytecode"]
                .as_str()
                .or_else(|| json["bytecode"]["object"].as_str())
                .unwrap()
                .trim_start_matches("0x");
            (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect()
        }

        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../testdata/proof_fixture.json")).unwrap();
        let election_id: uuid::Uuid = fixture["electionUuid"].as_str().unwrap().parse().unwrap();

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let jwks = jwks_url.clone();
        let db = database_url.to_string();
        let config = Arc::new(
            AppConfig::from_lookup(move |name| match name {
                "DATABASE_URL" => Some(db.clone()),
                "REDIS_URL" => Some("redis://localhost:6379".to_string()),
                "SUPABASE_JWKS_URL" => Some(jwks.clone()),
                "SUPABASE_JWT_ISSUER" => Some(TEST_ISSUER.to_string()),
                "SEPOLIA_RPC_URL" => Some(RPC.to_string()),
                "PRIVATE_KEY" => Some(RELAYER_KEY.to_string()),
                "OWNER_PRIVATE_KEY" => Some(OWNER_KEY.to_string()),
                _ => None,
            })
            .unwrap(),
        );
        let auth_ctx = Some(Arc::new(AuthContext::new(
            jwks_url,
            config.supabase_issuer.clone(),
            config.supabase_audience.clone(),
        )));
        let state = AppState {
            config: config.clone(),
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open("redis://localhost:6379").unwrap(),
            auth: auth_ctx,
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        let pool = state.pg.clone();
        let now = OffsetDateTime::now_utc();

        // The fixture binds the election UUID inside the proof: recreate
        // that exact election from scratch.
        sqlx::query("DELETE FROM elections WHERE id = $1")
            .bind(election_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO elections (id, name, merkle_tree_depth, num_candidates, candidates, \
                 registration_start_time, registration_end_time) \
             VALUES ($1, 'p13 fixture election', 4, 5, '[\"A\",\"B\",\"C\",\"D\",\"E\"]'::jsonb, now(), $2)",
        )
        .bind(election_id)
        .bind(now + Duration::hours(1))
        .execute(&pool)
        .await
        .unwrap();

        let admin_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        // Voter A holds secret "1" (fixture leaf 0); voter B holds "123".
        let voter_id = uuid::Uuid::new_v4();
        let voter_email = format!("p13-a-{admin_id}@example.com");
        let voter_token = mint_token(
            &voter_id.to_string(),
            &voter_email,
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let leaves: Vec<String> = fixture["leaves"]
            .as_array()
            .unwrap()
            .iter()
            .map(|leaf| leaf.as_str().unwrap().to_string())
            .collect();
        for (i, leaf) in leaves.iter().enumerate() {
            let email = if i == 0 {
                voter_email.clone()
            } else {
                format!("p13-b-{admin_id}@example.com")
            };
            let uid = if i == 0 {
                voter_id
            } else {
                uuid::Uuid::new_v4()
            };
            VoterRepo::insert_allowlisted(&pool, election_id, &email)
                .await
                .unwrap();
            VoterRepo::bind_registration(&pool, election_id, &email, uid, "V", leaf)
                .await
                .unwrap();
        }

        // finalize and /proof build the tree from `... ORDER BY id`. The voter
        // rows get gen_random_uuid ids, so without this the two leaves land in a
        // random order and the tree (Poseidon is not commutative) only matches
        // the fixture root ~half the time. Pin the ids so ORDER BY id yields the
        // fixture's leaf order [l0, l1] and the bound fixture proof is valid.
        for (i, leaf) in leaves.iter().enumerate() {
            // Election-scoped ordered id: the election uuid prefix + the leaf
            // index in the last byte, so the two rows sort as [l0, l1] yet never
            // collide with another election's rows (avoids cross-run PK clashes).
            let mut bytes = *election_id.as_bytes();
            bytes[15] = i as u8;
            let ordered_id = uuid::Uuid::from_bytes(bytes);
            sqlx::query(
                "UPDATE voters SET id = $1 WHERE election_id = $2 AND user_secret_commitment = $3",
            )
            .bind(ordered_id)
            .bind(election_id)
            .bind(leaf)
            .execute(&pool)
            .await
            .unwrap();
        }

        // Deploy with the REAL Groth16 verifier and finalize via the route.
        let chain_config = zkvote_chain::ChainConfig {
            rpc_url: RPC.to_string(),
            relayer_private_key: RELAYER_KEY.to_string(),
        };
        let deployed = zkvote_chain::deploy_election(
            &chain_config,
            bytecode("out/Groth16Verifier_4_10.sol/Groth16Verifier_4_10.json"),
            bytecode("out/VotingTally.sol/VotingTally.json"),
            alloy::primitives::U256::from(123u64),
            alloy::primitives::U256::from(5u64),
            OWNER_ADDR.parse().unwrap(),
            31337, // anvil local node chain id (§0.5 gap #2)
        )
        .await
        .expect("deploy failed — is `anvil` running?");
        zkvote_db::repos::ElectionRepo::set_contract_address(
            &pool,
            election_id,
            &format!("{:#x}", deployed.voting_tally_address),
            &format!("{:#x}", deployed.verifier_address),
        )
        .await
        .unwrap();

        let vote_end = (now + Duration::hours(2)).format(&Rfc3339Fmt).unwrap();
        let (status, json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{election_id}/finalize"),
            &admin_token,
            serde_json::json!({ "voteEndTime": vote_end }),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "finalize failed: {json}");
        assert_eq!(
            json["merkleRoot"].as_str().unwrap(),
            fixture["root"].as_str().unwrap(),
            "the live root must equal the fixture root (AR-H7)"
        );

        // /proof: ticket + path for voter A; path must satisfy the fixture.
        let (status, proof_json) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{election_id}/proof"),
            &voter_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "proof failed: {proof_json}");
        assert_eq!(
            proof_json["root"].as_str().unwrap(),
            fixture["root"].as_str().unwrap()
        );
        assert!(
            proof_json.get("user_secret").is_none(),
            "H2: no secret in /proof"
        );
        let ticket = proof_json["submissionTicket"].as_str().unwrap().to_string();

        // /submit with the real proof: relayed, mined, counted.
        let submit_body = serde_json::json!({
            "formattedProof": fixture["formattedProof"],
            "publicSignals": fixture["publicSignals"],
            "submissionTicket": ticket,
        });
        let response = routes::router(state.clone())
            .oneshot(
                Request::post(format!("/api/elections/{election_id}/submit"))
                    .header("content-type", "application/json")
                    .body(Body::from(submit_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(status, StatusCode::OK, "submit failed: {json}");
        assert!(json["transactionHash"].as_str().unwrap().starts_with("0x"));

        let onchain =
            zkvote_chain::connect_election(&chain_config, deployed.voting_tally_address).unwrap();
        assert_eq!(
            onchain
                .vote_count(alloy::primitives::U256::ZERO)
                .await
                .unwrap(),
            alloy::primitives::U256::from(1u64),
            "candidate 0 must hold exactly one vote"
        );

        // Replay with a fresh ticket: blocked by on-chain nullifier state.
        let (_, proof_json2) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{election_id}/proof"),
            &voter_token,
            serde_json::json!({}),
        )
        .await;
        let ticket2 = proof_json2["submissionTicket"]
            .as_str()
            .unwrap()
            .to_string();
        let replay_body = serde_json::json!({
            "formattedProof": fixture["formattedProof"],
            "publicSignals": fixture["publicSignals"],
            "submissionTicket": ticket2,
        });
        let response = routes::router(state.clone())
            .oneshot(
                Request::post(format!("/api/elections/{election_id}/submit"))
                    .header("content-type", "application/json")
                    .body(Body::from(replay_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            status,
            StatusCode::CONFLICT,
            "replay must be rejected: {json}"
        );
        assert_eq!(json["error"], "VOTE_ALREADY_CAST");

        // Tampered election binding rejected before any chain interaction.
        let mut tampered = fixture["publicSignals"].as_array().unwrap().clone();
        tampered[3] = serde_json::json!("999");
        let (_, proof_json3) = post_json(
            routes::router(state.clone()),
            &format!("/api/elections/{election_id}/proof"),
            &voter_token,
            serde_json::json!({}),
        )
        .await;
        let ticket3 = proof_json3["submissionTicket"]
            .as_str()
            .unwrap()
            .to_string();
        let tampered_body = serde_json::json!({
            "formattedProof": fixture["formattedProof"],
            "publicSignals": tampered,
            "submissionTicket": ticket3,
        });
        let response = routes::router(state.clone())
            .oneshot(
                Request::post(format!("/api/elections/{election_id}/submit"))
                    .header("content-type", "application/json")
                    .body(Body::from(tampered_body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "ELECTION_ID_MISMATCH");

        sqlx::query("DELETE FROM elections WHERE id = $1")
            .bind(election_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admins WHERE id = $1")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    /// Completion lifecycle gates. Run with docker PG.
    #[tokio::test]
    #[ignore = "requires the docker-compose Postgres (scripts/local/smoke.sh)"]
    async fn completion_rejects_early_and_is_idempotent() {
        use auth::token::test_support::*;
        use time::{Duration, OffsetDateTime};
        use zkvote_db::repos::{ElectionRepo, NewElection, VoterRepo};

        let database_url = "postgres://zkvote:zkvote_dev_password@localhost:5432/zkvote";
        let jwks_url = spawn_jwks_server().await;
        let state = test_state_with(&jwks_url, database_url);
        let pool = state.pg.clone();
        let now = OffsetDateTime::now_utc();

        let admin_id = uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO admins (id) VALUES ($1)")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
        let admin_token = mint_token(
            &admin_id.to_string(),
            "admin@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );

        let election = ElectionRepo::create(
            &pool,
            &NewElection {
                name: format!("p14 election {admin_id}"),
                merkle_tree_depth: 4,
                candidates: vec!["A".to_string(), "B".to_string()],
                registration_end_time: now + Duration::hours(1),
            },
        )
        .await
        .unwrap();
        VoterRepo::insert_allowlisted(&pool, election.id, &format!("p14-{admin_id}@example.com"))
            .await
            .unwrap();
        let path = format!("/api/elections/{}/complete", election.id);

        // No voting end time yet.
        let (status, json) = post_json(
            routes::router(state.clone()),
            &path,
            &admin_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "VOTING_NOT_STARTED");

        // Voting still active.
        ElectionRepo::finalize_sync(
            &pool,
            election.id,
            "42",
            now + Duration::minutes(1),
            now - Duration::hours(1),
            now + Duration::hours(1),
        )
        .await
        .unwrap();
        let state_after_finalize: String =
            sqlx::query_scalar("SELECT state FROM elections WHERE id = $1")
                .bind(election.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(state_after_finalize, "voting_active");
        let (status, json) = post_json(
            routes::router(state.clone()),
            &path,
            &admin_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json["error"], "VOTING_PERIOD_ACTIVE");

        // Voting ended -> completes once, then 409 on replay.
        sqlx::query("UPDATE elections SET voting_end_time = $2 WHERE id = $1")
            .bind(election.id)
            .bind(now - Duration::minutes(1))
            .execute(&pool)
            .await
            .unwrap();
        let (status, json) = post_json(
            routes::router(state.clone()),
            &path,
            &admin_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "complete failed: {json}");
        let (completed, state_after_complete): (bool, String) =
            sqlx::query_as("SELECT completed, state FROM elections WHERE id = $1")
                .bind(election.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(completed);
        assert_eq!(state_after_complete, "completed");
        let (status, json) = post_json(
            routes::router(state.clone()),
            &path,
            &admin_token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "ALREADY_COMPLETED");

        // The completed list now carries the row.
        let (status, rows) = get_json(
            routes::router(state.clone()),
            "/api/elections/completed",
            &admin_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(row_by_id(&rows, &election.id.to_string()).is_some());

        sqlx::query("DELETE FROM elections WHERE id = $1")
            .bind(election.id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM admins WHERE id = $1")
            .bind(admin_id)
            .execute(&pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn api_error_shape_matches_node_contract() {
        let response = axum::response::IntoResponse::into_response(error::ApiError::Validation(
            "bad field".to_string(),
        ));
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "VALIDATION_ERROR");
        assert_eq!(json["details"], "bad field");
    }
}
