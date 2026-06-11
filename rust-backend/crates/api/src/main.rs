mod auth;
mod config;
mod error;
mod middleware;
mod routes;
mod state;

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
        let config = Arc::new(
            AppConfig::from_lookup(move |name| match name {
                "DATABASE_URL" => Some(database_url.clone()),
                "REDIS_URL" => Some("redis://localhost:1".to_string()),
                "SUPABASE_JWKS_URL" => Some(jwks_url.clone()),
                "SUPABASE_JWT_ISSUER" => Some(auth::token::test_support::TEST_ISSUER.to_string()),
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
        // the admin-only route rejects with 403 (Phase 5 gate).
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

    /// Phase 7 gate: the three read-only lists reproduce the Node visibility
    /// rules and response shapes against seeded DB state.
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

        // /finalized — voter sees B (registered) but the completed C is gone.
        let (status, rows) = get_json(
            routes::router(state.clone()),
            "/api/elections/finalized",
            &voter_token,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(row_by_id(&rows, &b_id).is_some());
        assert!(row_by_id(&rows, &c_id).is_none());

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
        }

        for id in [a.id, b.id, c.id, d.id] {
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

    /// Phase 8 gates: creation validation (M4), invitation upsert
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
        let valid_body = serde_json::json!({
            "name": format!("p8 election {admin_id}"),
            "merkleTreeDepth": 4,
            "candidates": [" A ", "B"],
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

        // Valid creation: 201 with Node response shape + trimmed candidates.
        let (status, json) = post_json(
            routes::router(state.clone()),
            "/api/elections/set",
            &admin_token,
            valid_body,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "create failed: {json}");
        assert_eq!(json["success"], true);
        assert_eq!(json["election"]["num_candidates"], 2);
        assert_eq!(json["election"]["candidates"][0], "A");
        let election_id = json["election"]["id"].as_str().unwrap().to_string();

        // Malformed date is rejected (Phase 8 gate).
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

        // setZkDeploy: no registered artifact set -> blocked (Phase 8 gate).
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
