use std::env;
use std::net::SocketAddr;

#[derive(Debug)]
pub struct AppConfig {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub redis_url: String,
    pub artifact_store: String,
    pub cors_allowed_origins: Vec<String>,
    /// Supabase JWKS endpoint; auth-protected routes require it.
    pub supabase_jwks_url: Option<String>,
    /// Expected token issuer. Defaults to `{SUPABASE_URL}/auth/v1` when
    /// SUPABASE_URL is set; None disables the issuer check.
    pub supabase_issuer: Option<String>,
    /// Expected token audience (Supabase default role audience).
    pub supabase_audience: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("{name} is invalid: {reason}")]
    Invalid { name: &'static str, reason: String },
}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| env::var(name).ok())
    }

    /// Core parsing, separated from process env so tests stay parallel-safe.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        // Cloud Run injects PORT and expects the server to bind 0.0.0.0:PORT;
        // it takes precedence over APP_BIND_ADDR when present.
        let bind_addr = if let Some(port) = get("PORT") {
            let port: u16 = port.parse().map_err(|err| ConfigError::Invalid {
                name: "PORT",
                reason: format!("{err}"),
            })?;
            SocketAddr::from(([0, 0, 0, 0], port))
        } else {
            get("APP_BIND_ADDR")
                .unwrap_or_else(|| "127.0.0.1:8080".to_string())
                .parse::<SocketAddr>()
                .map_err(|err| ConfigError::Invalid {
                    name: "APP_BIND_ADDR",
                    reason: format!("{err}"),
                })?
        };

        let cors_allowed_origins = get("CORS_ALLOWED_ORIGINS")
            .unwrap_or_else(|| "http://localhost:3000".to_string())
            .split(',')
            .map(|origin| origin.trim().to_string())
            .filter(|origin| !origin.is_empty())
            .collect();

        let supabase_issuer = get("SUPABASE_JWT_ISSUER").or_else(|| {
            get("SUPABASE_URL").map(|url| format!("{}/auth/v1", url.trim_end_matches('/')))
        });

        Ok(Self {
            bind_addr,
            database_url: get("DATABASE_URL").ok_or(ConfigError::Missing("DATABASE_URL"))?,
            redis_url: get("REDIS_URL").ok_or(ConfigError::Missing("REDIS_URL"))?,
            artifact_store: get("ARTIFACT_STORE").unwrap_or_else(|| "local".to_string()),
            cors_allowed_origins,
            supabase_jwks_url: get("SUPABASE_JWKS_URL"),
            supabase_issuer,
            supabase_audience: get("SUPABASE_JWT_AUDIENCE")
                .unwrap_or_else(|| "authenticated".to_string()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(name: &str) -> Option<String> {
        match name {
            "DATABASE_URL" => Some("postgres://example".to_string()),
            "REDIS_URL" => Some("redis://example".to_string()),
            _ => None,
        }
    }

    #[test]
    fn applies_defaults() {
        let config = AppConfig::from_lookup(base).unwrap();
        assert_eq!(config.bind_addr.to_string(), "127.0.0.1:8080");
        assert_eq!(config.artifact_store, "local");
        assert_eq!(config.cors_allowed_origins, vec!["http://localhost:3000"]);
    }

    #[test]
    fn missing_database_url_is_an_error() {
        let result = AppConfig::from_lookup(|name| match name {
            "REDIS_URL" => Some("redis://example".to_string()),
            _ => None,
        });
        assert!(matches!(result, Err(ConfigError::Missing("DATABASE_URL"))));
    }

    #[test]
    fn cloud_run_port_overrides_bind_addr() {
        let config = AppConfig::from_lookup(|name| match name {
            "PORT" => Some("9090".to_string()),
            "APP_BIND_ADDR" => Some("127.0.0.1:8080".to_string()),
            other => base(other),
        })
        .unwrap();
        assert_eq!(config.bind_addr.to_string(), "0.0.0.0:9090");
    }

    #[test]
    fn parses_multiple_cors_origins() {
        let config = AppConfig::from_lookup(|name| match name {
            "CORS_ALLOWED_ORIGINS" => {
                Some("http://localhost:3000, https://staging.example.com".to_string())
            }
            other => base(other),
        })
        .unwrap();
        assert_eq!(
            config.cors_allowed_origins,
            vec!["http://localhost:3000", "https://staging.example.com"]
        );
    }
}
