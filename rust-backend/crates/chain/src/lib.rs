use thiserror::Error;

#[derive(Debug, Error)]
pub enum ChainError {
    #[error("chain client is not configured")]
    NotConfigured,
}

pub fn client_placeholder() -> Result<(), ChainError> {
    Err(ChainError::NotConfigured)
}
