use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::collections::HashMap;

/// Claims the API relies on. The IdP's access tokens carry the external
/// subject in `sub` and the e-mail in `email`; GCIP's app-layer trust anchor is
/// the top-level `email_verified` claim.
#[derive(Debug, Deserialize)]
pub struct Claims {
    pub sub: String,
    #[serde(default)]
    pub iss: Option<String>,
    pub email: Option<String>,
    #[serde(default)]
    pub email_verified: Option<bool>,
    #[allow(dead_code)]
    pub exp: usize,
}

impl Claims {
    /// True only when the token explicitly proves the email is verified
    /// through the top-level GCIP `email_verified` claim. Absent verification
    /// and nested metadata are not enough for email-authority joins.
    pub fn email_is_verified(&self) -> bool {
        self.email_verified_claim() == Some(true)
    }

    /// True when the token explicitly marks the e-mail unverified.
    pub fn email_explicitly_unverified(&self) -> bool {
        self.email_verified == Some(false)
    }

    pub fn email_verified_claim(&self) -> Option<bool> {
        self.email_verified
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("No token provided.")]
    MissingToken,
    #[error("{0}")]
    InvalidToken(String),
    #[error("token signed with an unknown key id")]
    UnknownKeyId,
    #[error("JWKS endpoint error: {0}")]
    Jwks(String),
    #[error("authentication is not configured on this server")]
    NotConfigured,
}

/// Decoding keys parsed from a JWKS document, indexed by `kid`.
pub struct KeySet {
    keys: HashMap<String, (Algorithm, DecodingKey)>,
}

#[derive(Debug, Deserialize)]
struct JwksDocument {
    keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize)]
struct Jwk {
    kty: String,
    kid: Option<String>,
    alg: Option<String>,
    n: Option<String>,
    e: Option<String>,
    crv: Option<String>,
    x: Option<String>,
    y: Option<String>,
}

impl KeySet {
    pub fn from_jwks_json(raw: &str) -> Result<Self, AuthError> {
        let document: JwksDocument = serde_json::from_str(raw)
            .map_err(|err| AuthError::Jwks(format!("malformed JWKS document: {err}")))?;

        let mut keys = HashMap::new();
        for jwk in document.keys {
            let Some(kid) = jwk.kid.clone() else {
                continue;
            };
            match Self::decoding_key(&jwk) {
                Some(entry) => {
                    keys.insert(kid, entry);
                }
                None => {
                    tracing::warn!(kid, kty = jwk.kty, "skipping unsupported JWK");
                }
            }
        }

        if keys.is_empty() {
            return Err(AuthError::Jwks(
                "JWKS document contains no usable keys".to_string(),
            ));
        }
        Ok(Self { keys })
    }

    fn decoding_key(jwk: &Jwk) -> Option<(Algorithm, DecodingKey)> {
        match jwk.kty.as_str() {
            "RSA" => {
                let key =
                    DecodingKey::from_rsa_components(jwk.n.as_ref()?, jwk.e.as_ref()?).ok()?;
                let alg = match jwk.alg.as_deref() {
                    Some("RS384") => Algorithm::RS384,
                    Some("RS512") => Algorithm::RS512,
                    _ => Algorithm::RS256,
                };
                Some((alg, key))
            }
            "EC" if jwk.crv.as_deref() == Some("P-256") => {
                let key = DecodingKey::from_ec_components(jwk.x.as_ref()?, jwk.y.as_ref()?).ok()?;
                Some((Algorithm::ES256, key))
            }
            _ => None,
        }
    }

    pub fn get(&self, kid: &str) -> Option<&(Algorithm, DecodingKey)> {
        self.keys.get(kid)
    }
}

/// Pure token validation: signature (via JWKS key by `kid`), expiry,
/// audience, and — when configured — issuer. Returns the claims on success.
pub fn validate_token(
    token: &str,
    keyset: &KeySet,
    issuer: Option<&str>,
    audience: &str,
) -> Result<Claims, AuthError> {
    let header = decode_header(token)
        .map_err(|err| AuthError::InvalidToken(format!("malformed token: {err}")))?;
    let kid = header
        .kid
        .ok_or_else(|| AuthError::InvalidToken("token header has no key id".to_string()))?;
    let (algorithm, key) = keyset.get(&kid).ok_or(AuthError::UnknownKeyId)?;

    let mut validation = Validation::new(*algorithm);
    validation.set_audience(&[audience]);
    validation.set_required_spec_claims(&["exp", "aud", "sub"]);
    if let Some(issuer) = issuer {
        validation.set_issuer(&[issuer]);
    }

    let data = decode::<Claims>(token, key, &validation)
        .map_err(|err| AuthError::InvalidToken(err.to_string()))?;
    Ok(data.claims)
}

#[cfg(test)]
pub mod test_support {
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    /// Test-only RSA key pair. NEVER use outside tests.
    pub const TEST_PRIVATE_KEY_PEM: &str = include_str!("../../testdata/test_only_rsa_key.pem");
    pub const TEST_JWKS_JSON: &str = include_str!("../../testdata/test_only_jwks.json");
    pub const TEST_KID: &str = "test-key-1";
    pub const TEST_AUDIENCE: &str = "authenticated";
    pub const TEST_ISSUER: &str = "https://test.supabase.local/auth/v1";

    pub fn mint_token(
        sub: &str,
        email: &str,
        audience: &str,
        issuer: &str,
        exp_offset_secs: i64,
    ) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let claims = json!({
            "sub": sub,
            "email": email,
            "email_verified": true,
            "aud": audience,
            "iss": issuer,
            "exp": now + exp_offset_secs,
        });
        sign(claims)
    }

    pub fn mint_token_without_email_verification(
        sub: &str,
        email: &str,
        audience: &str,
        issuer: &str,
        exp_offset_secs: i64,
    ) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let claims = json!({
            "sub": sub,
            "email": email,
            "aud": audience,
            "iss": issuer,
            "exp": now + exp_offset_secs,
        });
        sign(claims)
    }

    /// Like `mint_token` but stamps `email_verified: false` (the email-change /
    /// pre-confirmation shape) for RUST-AUTH-2 tests.
    pub fn mint_token_unverified(sub: &str, email: &str) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        sign(json!({
            "sub": sub,
            "email": email,
            "email_verified": false,
            "aud": TEST_AUDIENCE,
            "iss": TEST_ISSUER,
            "exp": now + 300,
        }))
    }

    fn sign(claims: serde_json::Value) -> String {
        let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some(TEST_KID.to_string());
        encode(
            &header,
            &claims,
            &EncodingKey::from_rsa_pem(TEST_PRIVATE_KEY_PEM.as_bytes()).unwrap(),
        )
        .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    const SUB: &str = "0b9f9bbd-6a55-4f2c-9d3e-111111111111";

    fn keyset() -> KeySet {
        KeySet::from_jwks_json(TEST_JWKS_JSON).unwrap()
    }

    #[test]
    fn accepts_a_valid_token() {
        let token = mint_token(SUB, "Voter@Example.com", TEST_AUDIENCE, TEST_ISSUER, 300);
        let claims = validate_token(&token, &keyset(), Some(TEST_ISSUER), TEST_AUDIENCE).unwrap();
        assert_eq!(claims.sub, SUB);
        assert_eq!(claims.email.as_deref(), Some("Voter@Example.com"));
    }

    #[test]
    fn rejects_an_expired_token() {
        let token = mint_token(SUB, "v@example.com", TEST_AUDIENCE, TEST_ISSUER, -300);
        let err = validate_token(&token, &keyset(), Some(TEST_ISSUER), TEST_AUDIENCE).unwrap_err();
        assert!(matches!(err, AuthError::InvalidToken(message) if message.contains("Expired")));
    }

    #[test]
    fn rejects_a_wrong_audience() {
        let token = mint_token(SUB, "v@example.com", "service_role", TEST_ISSUER, 300);
        let err = validate_token(&token, &keyset(), Some(TEST_ISSUER), TEST_AUDIENCE).unwrap_err();
        assert!(
            matches!(err, AuthError::InvalidToken(message) if message.contains("InvalidAudience"))
        );
    }

    #[test]
    fn rejects_a_wrong_issuer() {
        let token = mint_token(
            SUB,
            "v@example.com",
            TEST_AUDIENCE,
            "https://evil.example",
            300,
        );
        let err = validate_token(&token, &keyset(), Some(TEST_ISSUER), TEST_AUDIENCE).unwrap_err();
        assert!(
            matches!(err, AuthError::InvalidToken(message) if message.contains("InvalidIssuer"))
        );
    }

    #[test]
    fn rejects_malformed_tokens() {
        let err =
            validate_token("not-a-jwt", &keyset(), Some(TEST_ISSUER), TEST_AUDIENCE).unwrap_err();
        assert!(matches!(err, AuthError::InvalidToken(_)));
    }

    #[test]
    fn only_explicitly_verified_email_is_authoritative() {
        // RUST-AUTH-2: an explicit email_verified:false token must be flagged...
        let unverified = mint_token_unverified(SUB, "v@example.com");
        let claims =
            validate_token(&unverified, &keyset(), Some(TEST_ISSUER), TEST_AUDIENCE).unwrap();
        assert!(claims.email_explicitly_unverified());
        assert!(!claims.email_is_verified());

        // Missing verification is unknown and must not authorize email joins.
        let missing = mint_token_without_email_verification(
            SUB,
            "v@example.com",
            TEST_AUDIENCE,
            TEST_ISSUER,
            300,
        );
        let claims = validate_token(&missing, &keyset(), Some(TEST_ISSUER), TEST_AUDIENCE).unwrap();
        assert!(!claims.email_explicitly_unverified());
        assert!(!claims.email_is_verified());

        let verified = mint_token(SUB, "v@example.com", TEST_AUDIENCE, TEST_ISSUER, 300);
        let claims =
            validate_token(&verified, &keyset(), Some(TEST_ISSUER), TEST_AUDIENCE).unwrap();
        assert!(claims.email_is_verified());
    }

    #[test]
    fn nested_user_metadata_email_verified_is_not_authoritative() {
        let claims: Claims = serde_json::from_value(serde_json::json!({
            "sub": SUB,
            "iss": TEST_ISSUER,
            "email": "v@example.com",
            "user_metadata": { "email_verified": true },
            "exp": 0
        }))
        .unwrap();

        assert_eq!(claims.email_verified_claim(), None);
        assert!(!claims.email_is_verified());
        assert!(!claims.email_explicitly_unverified());

        let claims: Claims = serde_json::from_value(serde_json::json!({
            "sub": SUB,
            "iss": TEST_ISSUER,
            "email": "v@example.com",
            "email_verified": false,
            "user_metadata": { "email_verified": true },
            "exp": 0
        }))
        .unwrap();

        assert_eq!(claims.email_verified_claim(), Some(false));
        assert!(!claims.email_is_verified());
        assert!(claims.email_explicitly_unverified());
    }

    #[test]
    fn reports_unknown_key_ids_distinctly() {
        // A token whose kid is absent from the JWKS must surface as
        // UnknownKeyId so the cache layer can force a refresh exactly once.
        let token = mint_token(SUB, "v@example.com", TEST_AUDIENCE, TEST_ISSUER, 300);
        let empty = KeySet::from_jwks_json(
            r#"{"keys":[{"kty":"RSA","kid":"other","n":"AQAB","e":"AQAB"}]}"#,
        )
        .unwrap();
        let err = validate_token(&token, &empty, Some(TEST_ISSUER), TEST_AUDIENCE).unwrap_err();
        assert!(matches!(err, AuthError::UnknownKeyId));
    }
}
