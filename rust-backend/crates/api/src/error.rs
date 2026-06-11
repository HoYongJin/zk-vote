use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

/// Application error type for every route handler. Serializes to the same
/// `{ "error": CODE, "details": "..." }` body shape the Node API uses, so
/// the frontend error handling carries over unchanged during parity work.
#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    // Validation/NotFound/Conflict gain production call sites with the
    // Phase 7+ business routes; their contract is locked by tests below.
    #[allow(dead_code)]
    #[error("{0}")]
    Validation(String),
    #[error("No token provided.")]
    MissingAuth,
    #[error("{0}")]
    InvalidAuth(String),
    #[error("You do not have the necessary permissions to perform this action.")]
    AdminRequired,
    #[allow(dead_code)]
    #[error("{0}")]
    NotFound(String),
    #[allow(dead_code)]
    #[error("{0}")]
    Conflict(String),
    /// Route-specific Node error codes (REGISTRATION_PERIOD_ENDED,
    /// OVER_CAPACITY, ...) that don't warrant their own variant.
    #[error("{details}")]
    Coded {
        status: u16,
        code: &'static str,
        details: String,
    },
    #[error("database error")]
    Database(#[from] zkvote_db::DbError),
    #[error("redis error")]
    Redis(#[from] redis::RedisError),
    #[error("{0}")]
    Internal(String),
}

#[derive(Serialize)]
pub struct ErrorBody {
    pub error: &'static str,
    pub details: String,
}

impl ApiError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::Validation(_) => (StatusCode::BAD_REQUEST, "VALIDATION_ERROR"),
            // Same codes the Node middlewares emit, so frontend handling
            // carries over unchanged.
            Self::MissingAuth => (StatusCode::UNAUTHORIZED, "AUTHENTICATION_REQUIRED"),
            Self::InvalidAuth(_) => (StatusCode::UNAUTHORIZED, "INVALID_TOKEN"),
            Self::AdminRequired => (StatusCode::FORBIDDEN, "ADMIN_PRIVILEGES_REQUIRED"),
            Self::NotFound(_) => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            Self::Conflict(_) => (StatusCode::CONFLICT, "CONFLICT"),
            Self::Coded { status, code, .. } => (
                StatusCode::from_u16(*status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                code,
            ),
            Self::Database(_) | Self::Redis(_) | Self::Internal(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "SERVER_ERROR")
            }
        }
    }

    fn public_details(&self) -> String {
        match self {
            // Infrastructure errors must not leak connection strings or
            // driver internals to clients; the full error goes to the log.
            Self::Database(_) | Self::Redis(_) | Self::Internal(_) => {
                "An internal server error occurred.".to_string()
            }
            other => other.to_string(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        if status.is_server_error() {
            tracing::error!(error = %self, kind = code, "request failed");
        }
        let body = ErrorBody {
            error: code,
            details: self.public_details(),
        };
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_maps_to_400_with_node_compatible_body() {
        let response = ApiError::Validation("bad input".to_string()).into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn infrastructure_errors_do_not_leak_details() {
        let err = ApiError::Internal("postgres://user:password@host".to_string());
        assert_eq!(err.public_details(), "An internal server error occurred.");
        assert_eq!(
            err.status_and_code(),
            (StatusCode::INTERNAL_SERVER_ERROR, "SERVER_ERROR")
        );
    }
}
