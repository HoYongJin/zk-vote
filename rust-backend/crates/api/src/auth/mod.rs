pub mod jwks;
pub mod token;

use crate::error::ApiError;
use crate::state::AppState;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use jwks::JwksCache;
use sqlx::PgPool;
use token::{validate_token, AuthError};
use uuid::Uuid;

/// Everything needed to validate Supabase access tokens. Built once at
/// startup when SUPABASE_JWKS_URL is configured.
pub struct AuthContext {
    pub jwks: JwksCache,
    pub issuer: Option<String>,
    pub audience: String,
}

impl AuthContext {
    pub fn new(jwks_url: String, issuer: Option<String>, audience: String) -> Self {
        Self {
            jwks: JwksCache::new(jwks_url),
            issuer,
            audience,
        }
    }
}

/// Authenticated Supabase user (any role). Mirrors the Node `auth`
/// middleware: 401 AUTHENTICATION_REQUIRED without a bearer token, 401
/// INVALID_TOKEN when validation fails.
#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub id: Uuid,
    /// Normalized (trimmed, lowercased) e-mail — the allowlist join key.
    pub email: Option<String>,
}

impl From<AuthError> for ApiError {
    fn from(err: AuthError) -> Self {
        match err {
            AuthError::MissingToken => ApiError::MissingAuth,
            AuthError::InvalidToken(details) => ApiError::InvalidAuth(details),
            AuthError::UnknownKeyId => {
                ApiError::InvalidAuth("token signed with an unknown key id".to_string())
            }
            AuthError::Jwks(details) => ApiError::Internal(format!("JWKS error: {details}")),
            AuthError::NotConfigured => {
                ApiError::Internal("authentication is not configured".to_string())
            }
        }
    }
}

fn bearer_token(parts: &Parts) -> Result<&str, AuthError> {
    let header = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(AuthError::MissingToken)?;
    header
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
        .ok_or(AuthError::MissingToken)
}

#[axum::async_trait]
impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth = state.auth.as_ref().ok_or(AuthError::NotConfigured)?;
        let token = bearer_token(parts)?;

        let keyset = auth.jwks.keyset(false).await?;
        let claims = match validate_token(token, &keyset, auth.issuer.as_deref(), &auth.audience) {
            Err(AuthError::UnknownKeyId) => {
                // Likely a key rotation: refresh the JWKS once and retry.
                let refreshed = auth.jwks.keyset(true).await?;
                validate_token(token, &refreshed, auth.issuer.as_deref(), &auth.audience)?
            }
            other => other?,
        };

        let id = Uuid::parse_str(&claims.sub).map_err(|_| {
            AuthError::InvalidToken("token subject is not a valid user id".to_string())
        })?;
        let email = claims
            .email
            .as_deref()
            .map(|email| email.trim().to_lowercase())
            .filter(|email| !email.is_empty());

        Ok(CurrentUser { id, email })
    }
}

/// Admin-authenticated user. Mirrors the Node `authAdmin` middleware,
/// including H5 invitation consumption: when the user is not yet in
/// `admins` but holds a pending invitation for their normalized e-mail,
/// they are promoted (and the invitation marked accepted) on first use.
#[derive(Debug, Clone)]
pub struct AdminUser(pub CurrentUser);

#[axum::async_trait]
impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        if is_admin_or_promote(&state.pg, &user).await? {
            Ok(AdminUser(user))
        } else {
            Err(ApiError::AdminRequired)
        }
    }
}

/// Returns whether the user is an admin, consuming a pending invitation if
/// one exists (audit H5). Used by AdminUser and by `GET /api/me`, so an
/// invited-then-signed-up user is promoted the first time their role is
/// looked up — no admin-only request required.
pub async fn is_admin_or_promote(pool: &PgPool, user: &CurrentUser) -> Result<bool, ApiError> {
    let existing: Option<Uuid> = sqlx::query_scalar("SELECT id FROM admins WHERE id = $1")
        .bind(user.id)
        .fetch_optional(pool)
        .await
        .map_err(zkvote_db::DbError::from)?;
    if existing.is_some() {
        return Ok(true);
    }

    let Some(email) = user.email.as_deref() else {
        return Ok(false);
    };

    let pending: Option<String> = sqlx::query_scalar(
        "SELECT email::text FROM admin_invitations WHERE email = $1 AND accepted_at IS NULL",
    )
    .bind(email)
    .fetch_optional(pool)
    .await
    .map_err(zkvote_db::DbError::from)?;
    if pending.is_none() {
        return Ok(false);
    }

    let mut tx = pool.begin().await.map_err(zkvote_db::DbError::from)?;
    sqlx::query("INSERT INTO admins (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING")
        .bind(user.id)
        .bind(email)
        .execute(&mut *tx)
        .await
        .map_err(zkvote_db::DbError::from)?;
    sqlx::query(
        "UPDATE admin_invitations SET accepted_by = $1, accepted_at = now() WHERE email = $2",
    )
    .bind(user.id)
    .bind(email)
    .execute(&mut *tx)
    .await
    .map_err(zkvote_db::DbError::from)?;
    tx.commit().await.map_err(zkvote_db::DbError::from)?;

    tracing::info!(user_id = %user.id, email, "applied pending admin invitation (H5)");
    Ok(true)
}
