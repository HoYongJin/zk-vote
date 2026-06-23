pub mod services;

use serde::{Deserialize, Serialize};
use std::fmt;

/// Lifecycle state persisted in `elections.state`. Written via `Display`; the
/// column is read back as a plain string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ElectionState {
    Draft,
    ArtifactsReady,
    ContractDeployed,
    RegistrationOpen,
    Finalizing,
    VotingActive,
    VotingEnded,
    Completed,
    Failed,
}

impl fmt::Display for ElectionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Draft => "draft",
            Self::ArtifactsReady => "artifacts_ready",
            Self::ContractDeployed => "contract_deployed",
            Self::RegistrationOpen => "registration_open",
            Self::Finalizing => "finalizing",
            Self::VotingActive => "voting_active",
            Self::VotingEnded => "voting_ended",
            Self::Completed => "completed",
            Self::Failed => "failed",
        };
        f.write_str(value)
    }
}
