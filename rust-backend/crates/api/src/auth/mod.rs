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

/// Everything needed to validate the IdP's OIDC access tokens. Built once at
/// startup when AUTH_JWKS_URL is configured.
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

/// Authenticated user (any role): 401 AUTHENTICATION_REQUIRED without a
/// bearer token, 401 INVALID_TOKEN when validation fails.
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

fn normalized_subject(subject: &str) -> Result<String, AuthError> {
    let subject = subject.trim();
    if subject.is_empty() {
        return Err(AuthError::InvalidToken(
            "token subject is empty".to_string(),
        ));
    }
    Ok(subject.to_string())
}

fn identity_issuer(
    claim_issuer: Option<&str>,
    configured_issuer: Option<&str>,
) -> Result<String, AuthError> {
    let issuer = claim_issuer
        .or(configured_issuer)
        .map(str::trim)
        .filter(|issuer| !issuer.is_empty())
        .ok_or_else(|| AuthError::InvalidToken("token issuer is missing".to_string()))?;
    Ok(issuer.to_string())
}

async fn update_app_user_seen(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    email: Option<&str>,
) -> Result<(), zkvote_db::DbError> {
    sqlx::query(
        "UPDATE app_users \
         SET email = CASE \
                 WHEN $2::citext IS NOT NULL \
                      AND (email IS NULL OR email = $2::citext) \
                      AND NOT EXISTS ( \
                          SELECT 1 FROM app_users other \
                          WHERE other.email = $2::citext AND other.id <> app_users.id \
                      ) \
                 THEN $2::citext \
                 ELSE email \
             END, \
             last_seen_at = now(), updated_at = now() \
         WHERE id = $1",
    )
    .bind(user_id)
    .bind(email)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn app_user_for_email(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    email: &str,
) -> Result<Uuid, zkvote_db::DbError> {
    Ok(sqlx::query_scalar(
        "INSERT INTO app_users (email, last_seen_at) VALUES ($1, now()) \
         ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE \
         SET last_seen_at = now(), updated_at = now() \
         RETURNING id",
    )
    .bind(email)
    .fetch_one(&mut **tx)
    .await?)
}

async fn app_user_for_uuid_subject(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    subject: &str,
    email: Option<&str>,
) -> Result<Option<Uuid>, zkvote_db::DbError> {
    let Ok(subject_uuid) = Uuid::parse_str(subject) else {
        return Ok(None);
    };
    let user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO app_users (id, last_seen_at) VALUES ($1, now()) \
         ON CONFLICT (id) DO UPDATE \
         SET last_seen_at = now(), updated_at = now() \
         RETURNING id",
    )
    .bind(subject_uuid)
    .fetch_one(&mut **tx)
    .await?;
    update_app_user_seen(tx, user_id, email).await?;
    Ok(Some(user_id))
}

async fn resolve_or_create_app_user(
    pool: &PgPool,
    issuer: &str,
    subject: &str,
    email: Option<&str>,
    email_verified: Option<bool>,
) -> Result<Uuid, ApiError> {
    let mut tx = pool.begin().await.map_err(zkvote_db::DbError::from)?;

    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM auth_identities WHERE issuer = $1 AND subject = $2",
    )
    .bind(issuer)
    .bind(subject)
    .fetch_optional(&mut *tx)
    .await
    .map_err(zkvote_db::DbError::from)?;
    if let Some(user_id) = existing {
        sqlx::query(
            "UPDATE auth_identities \
             SET email = $3, email_verified = $4, last_seen_at = now(), updated_at = now() \
             WHERE issuer = $1 AND subject = $2",
        )
        .bind(issuer)
        .bind(subject)
        .bind(email)
        .bind(email_verified)
        .execute(&mut *tx)
        .await
        .map_err(zkvote_db::DbError::from)?;
        update_app_user_seen(&mut tx, user_id, email).await?;
        tx.commit().await.map_err(zkvote_db::DbError::from)?;
        return Ok(user_id);
    }

    let user_id = if let Some(user_id) = app_user_for_uuid_subject(&mut tx, subject, email).await? {
        user_id
    } else if let Some(email) = email {
        app_user_for_email(&mut tx, email).await?
    } else {
        sqlx::query_scalar("INSERT INTO app_users (last_seen_at) VALUES (now()) RETURNING id")
            .fetch_one(&mut *tx)
            .await
            .map_err(zkvote_db::DbError::from)?
    };

    let identity_user_id: Uuid = sqlx::query_scalar(
        "INSERT INTO auth_identities \
             (user_id, issuer, subject, email, email_verified, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, now()) \
         ON CONFLICT (issuer, subject) DO UPDATE \
         SET email = EXCLUDED.email, \
             email_verified = EXCLUDED.email_verified, \
             last_seen_at = now(), updated_at = now() \
         RETURNING user_id",
    )
    .bind(user_id)
    .bind(issuer)
    .bind(subject)
    .bind(email)
    .bind(email_verified)
    .fetch_one(&mut *tx)
    .await
    .map_err(zkvote_db::DbError::from)?;
    update_app_user_seen(&mut tx, identity_user_id, email).await?;
    tx.commit().await.map_err(zkvote_db::DbError::from)?;
    Ok(identity_user_id)
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

        let issuer = identity_issuer(claims.iss.as_deref(), auth.issuer.as_deref())?;
        let subject = normalized_subject(&claims.sub)?;
        let email = claims
            .email
            .as_deref()
            .map(|email| email.trim().to_lowercase())
            .filter(|email| !email.is_empty());

        // RUST-AUTH-2: never trust an explicitly-unverified e-mail as an identity
        // join key. is_admin_or_promote and the voter allowlist match on this
        // e-mail, so an unverified claim must not be able to consume an admin
        // invitation or a voter slot for an inbox the caller does not control.
        let email = match email {
            Some(addr) if claims.email_explicitly_unverified() => {
                tracing::warn!(
                    issuer = %issuer,
                    subject = %subject,
                    "ignoring unverified e-mail claim; it will not match admin invitations or the voter allowlist (RUST-AUTH-2)"
                );
                let _ = addr;
                None
            }
            other => other,
        };

        let id = resolve_or_create_app_user(
            &state.pg,
            &issuer,
            &subject,
            email.as_deref(),
            claims.email_verified_claim(),
        )
        .await?;

        Ok(CurrentUser { id, email })
    }
}

/// Admin-authenticated user, including H5 invitation consumption: when the
/// user is not yet in `admins` but holds a pending invitation for their
/// normalized e-mail, they are promoted (and the invitation marked accepted)
/// on first use.
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

/// Superadmin-authenticated user (GOV-1 separation of duty): gates the
/// high-blast-radius routes (addAdmins / supersede / setZkDeploy / admin
/// revocation). Unlike `AdminUser` it never auto-promotes — superadmin is held
/// only by a bootstrapped or reinstated row, so a compromised ordinary-admin JWT
/// cannot mint admins, brick elections, or swap deploy artifacts.
#[derive(Debug, Clone)]
pub struct SuperAdminUser(pub CurrentUser);

#[axum::async_trait]
impl FromRequestParts<AppState> for SuperAdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = CurrentUser::from_request_parts(parts, state).await?;
        if is_superadmin(&state.pg, user.id).await? {
            Ok(SuperAdminUser(user))
        } else {
            Err(ApiError::SuperAdminRequired)
        }
    }
}

/// Returns whether the user is an admin, consuming a pending invitation if
/// one exists (audit H5). Used by AdminUser and by `GET /api/me`, so an
/// invited-then-signed-up user is promoted the first time their role is
/// looked up — no admin-only request required.
pub async fn is_admin_or_promote(pool: &PgPool, user: &CurrentUser) -> Result<bool, ApiError> {
    let existing: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM admins WHERE id = $1 AND revoked_at IS NULL")
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

    let mut tx = pool.begin().await.map_err(zkvote_db::DbError::from)?;
    // Speculative insert: the admin row must exist before the invitation UPDATE,
    // because admin_invitations.accepted_by FKs admins(id). If no invitation is
    // claimed below we roll the whole transaction back (see DB-AUTH-1 note).
    sqlx::query(
        "INSERT INTO admins (id, email) VALUES ($1, $2) \
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(user.id)
    .bind(email)
    .execute(&mut *tx)
    .await
    .map_err(zkvote_db::DbError::from)?;

    // Claim the pending invitation atomically (the WHERE accepted_at IS NULL row
    // lock is the single-winner serialization point under concurrent first-logins).
    // RETURNING invited_by carries the inviter through to the admin row (GOV-1).
    let claimed: Option<(String, Option<Uuid>)> = sqlx::query_as(
        "UPDATE admin_invitations SET accepted_by = $1, accepted_at = now() \
         WHERE email = $2 AND accepted_at IS NULL RETURNING email::text, invited_by",
    )
    .bind(user.id)
    .bind(email)
    .fetch_optional(&mut *tx)
    .await
    .map_err(zkvote_db::DbError::from)?;

    let Some((claimed_email, invited_by)) = claimed else {
        // No pending invitation to consume. Abandon the speculative INSERT by
        // rolling back the whole transaction (DB-AUTH-1): an explicit
        // `DELETE FROM admins` would need a privilege `zkvote_app` deliberately
        // lacks (db/roles.sql keeps `admins` append-only), which 500s every
        // ordinary voter's /api/me under the two-role production posture. A
        // concurrent first-login may still have promoted this user via its own
        // invitation, so re-check on the pool after the rollback.
        tx.rollback().await.map_err(zkvote_db::DbError::from)?;
        let existing: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM admins WHERE id = $1 AND revoked_at IS NULL")
                .bind(user.id)
                .fetch_optional(pool)
                .await
                .map_err(zkvote_db::DbError::from)?;
        return Ok(existing.is_some());
    };

    // Invitation claimed: make the admin row active + attributed. This also
    // reinstates a previously-revoked admin who is re-invited (GOV-1). The row is
    // keyed by id, so a concurrent revoke of the same admin serializes on its row
    // lock (last-writer-wins — an operational contradiction, not corruption).
    sqlx::query(
        "UPDATE admins SET email = $2, revoked_at = NULL, invited_by = $3, updated_at = now() \
         WHERE id = $1",
    )
    .bind(user.id)
    .bind(claimed_email)
    .bind(invited_by)
    .execute(&mut *tx)
    .await
    .map_err(zkvote_db::DbError::from)?;
    tx.commit().await.map_err(zkvote_db::DbError::from)?;

    tracing::info!(user_id = %user.id, email, "applied pending admin invitation (H5)");
    Ok(true)
}

/// Whether `id` is a current (non-revoked) **superadmin** — the second-tier role
/// gating the high-blast-radius routes (addAdmins / supersede / setZkDeploy).
/// Never auto-promotes: superadmin is granted only out-of-band (bootstrap) or by
/// reinstating a previously-superadmin row, never by accepting an invitation.
pub async fn is_superadmin(pool: &PgPool, id: Uuid) -> Result<bool, ApiError> {
    let found: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM admins WHERE id = $1 AND is_superadmin AND revoked_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(zkvote_db::DbError::from)?;
    Ok(found.is_some())
}
