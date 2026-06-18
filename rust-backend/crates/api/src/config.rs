use std::env;
use std::net::SocketAddr;

#[derive(Debug)]
pub struct AppConfig {
    pub bind_addr: SocketAddr,
    pub database_url: String,
    pub redis_url: String,
    pub artifact_store: String,
    pub artifact_local_dir: String,
    pub contract_artifacts_dir: String,
    pub artifact_bucket: Option<String>,
    pub gcs_storage_base_url: String,
    pub gcs_metadata_token_url: String,
    pub cors_allowed_origins: Vec<String>,
    /// Supabase JWKS endpoint; auth-protected routes require it.
    pub supabase_jwks_url: Option<String>,
    /// Expected token issuer. Defaults to `{SUPABASE_URL}/auth/v1` when
    /// SUPABASE_URL is set; None disables the issuer check.
    pub supabase_issuer: Option<String>,
    /// Expected token audience (Supabase default role audience).
    pub supabase_audience: String,
    /// Ethereum RPC endpoint (finalize/submit relaying).
    pub rpc_url: Option<String>,
    /// Hot relayer key — deploys and relays, holds no owner rights (AR-M4).
    pub relayer_private_key: Option<String>,
    /// Contract-owner key, used only by finalize's configureElection.
    pub owner_private_key: Option<String>,
    /// Chain id recorded with deployment metadata. Sepolia by default.
    pub chain_id: i64,
    /// AR-M7: finalize rejects voting windows longer than this without an
    /// explicit confirmation field (the period is immutable on-chain).
    pub max_voting_duration_days: i64,
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

        let artifact_store = get("ARTIFACT_STORE")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "local".to_string());
        if !matches!(artifact_store.as_str(), "local" | "gcs") {
            return Err(ConfigError::Invalid {
                name: "ARTIFACT_STORE",
                reason: "must be either 'local' or 'gcs'".to_string(),
            });
        }

        let chain_id = parse_positive_i64(get("CHAIN_ID"), "CHAIN_ID", 11_155_111)?;
        let max_voting_duration_days = parse_positive_i64(
            get("MAX_VOTING_DURATION_DAYS"),
            "MAX_VOTING_DURATION_DAYS",
            30,
        )?;

        Ok(Self {
            bind_addr,
            database_url: get("DATABASE_URL").ok_or(ConfigError::Missing("DATABASE_URL"))?,
            redis_url: get("REDIS_URL").ok_or(ConfigError::Missing("REDIS_URL"))?,
            artifact_store,
            artifact_local_dir: get("ARTIFACT_LOCAL_DIR")
                .unwrap_or_else(|| ".data/zk-artifacts".to_string()),
            contract_artifacts_dir: get("CONTRACT_ARTIFACTS_DIR")
                .unwrap_or_else(|| "artifacts/contracts".to_string()),
            artifact_bucket: get("ARTIFACT_BUCKET")
                .map(|bucket| bucket.trim().to_string())
                .filter(|bucket| !bucket.is_empty()),
            gcs_storage_base_url: get("GCS_STORAGE_BASE_URL")
                .unwrap_or_else(|| "https://storage.googleapis.com".to_string()),
            gcs_metadata_token_url: get("GCS_METADATA_TOKEN_URL").unwrap_or_else(|| {
                "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
                    .to_string()
            }),
            cors_allowed_origins,
            supabase_jwks_url: get("SUPABASE_JWKS_URL"),
            supabase_issuer,
            supabase_audience: get("SUPABASE_JWT_AUDIENCE")
                .unwrap_or_else(|| "authenticated".to_string()),
            rpc_url: get("SEPOLIA_RPC_URL").or_else(|| get("RPC_URL")),
            relayer_private_key: get("RELAYER_PRIVATE_KEY").or_else(|| get("PRIVATE_KEY")),
            owner_private_key: get("OWNER_PRIVATE_KEY"),
            chain_id,
            max_voting_duration_days,
        })
    }
}

fn parse_positive_i64(
    value: Option<String>,
    name: &'static str,
    default: i64,
) -> Result<i64, ConfigError> {
    let Some(raw) = value else {
        return Ok(default);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(default);
    }
    let parsed = trimmed.parse::<i64>().map_err(|err| ConfigError::Invalid {
        name,
        reason: format!("must be a positive integer: {err}"),
    })?;
    if parsed <= 0 {
        return Err(ConfigError::Invalid {
            name,
            reason: "must be a positive integer".to_string(),
        });
    }
    Ok(parsed)
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
        assert_eq!(config.artifact_local_dir, ".data/zk-artifacts");
        assert_eq!(config.contract_artifacts_dir, "artifacts/contracts");
        assert_eq!(config.artifact_bucket, None);
        assert_eq!(config.chain_id, 11_155_111);
        assert_eq!(
            config.gcs_storage_base_url,
            "https://storage.googleapis.com"
        );
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
    fn parses_gcs_artifact_bucket() {
        let config = AppConfig::from_lookup(|name| match name {
            "ARTIFACT_STORE" => Some("gcs".to_string()),
            "ARTIFACT_BUCKET" => Some(" zkvote-staging-artifacts ".to_string()),
            "GCS_STORAGE_BASE_URL" => Some("http://127.0.0.1:9000".to_string()),
            "GCS_METADATA_TOKEN_URL" => Some("http://127.0.0.1:9000/token".to_string()),
            other => base(other),
        })
        .unwrap();

        assert_eq!(config.artifact_store, "gcs");
        assert_eq!(
            config.artifact_bucket.as_deref(),
            Some("zkvote-staging-artifacts")
        );
        assert_eq!(config.gcs_storage_base_url, "http://127.0.0.1:9000");
        assert_eq!(config.gcs_metadata_token_url, "http://127.0.0.1:9000/token");
    }

    #[test]
    fn rejects_invalid_chain_id_instead_of_defaulting() {
        let result = AppConfig::from_lookup(|name| match name {
            "CHAIN_ID" => Some("sepolia".to_string()),
            other => base(other),
        });

        assert!(matches!(
            result,
            Err(ConfigError::Invalid {
                name: "CHAIN_ID",
                ..
            })
        ));
    }

    #[test]
    fn rejects_invalid_max_voting_duration_instead_of_defaulting() {
        let result = AppConfig::from_lookup(|name| match name {
            "MAX_VOTING_DURATION_DAYS" => Some("0".to_string()),
            other => base(other),
        });

        assert!(matches!(
            result,
            Err(ConfigError::Invalid {
                name: "MAX_VOTING_DURATION_DAYS",
                ..
            })
        ));
    }

    #[test]
    fn rejects_unknown_artifact_store() {
        let result = AppConfig::from_lookup(|name| match name {
            "ARTIFACT_STORE" => Some("s3".to_string()),
            other => base(other),
        });

        assert!(matches!(
            result,
            Err(ConfigError::Invalid {
                name: "ARTIFACT_STORE",
                ..
            })
        ));
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
