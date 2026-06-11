use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkerError {
    #[error("worker is not configured")]
    NotConfigured,
}
