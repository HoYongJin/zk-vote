use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;
use utoipa::ToSchema;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub struct ElectionId(pub Uuid);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub struct MerkleRoot(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub struct NullifierHash(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub struct CandidateIndex(pub u32);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
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

#[derive(Debug, Error)]
pub enum DomainError {
    #[error("invalid election state transition from {from} to {to}")]
    InvalidElectionTransition {
        from: ElectionState,
        to: ElectionState,
    },
}

pub fn validate_transition(from: ElectionState, to: ElectionState) -> Result<(), DomainError> {
    let ok = matches!(
        (&from, &to),
        (ElectionState::Draft, ElectionState::ArtifactsReady)
            | (
                ElectionState::ArtifactsReady,
                ElectionState::ContractDeployed
            )
            | (
                ElectionState::ContractDeployed,
                ElectionState::RegistrationOpen
            )
            | (ElectionState::RegistrationOpen, ElectionState::Finalizing)
            | (ElectionState::Finalizing, ElectionState::VotingActive)
            | (ElectionState::VotingActive, ElectionState::VotingEnded)
            | (ElectionState::VotingEnded, ElectionState::Completed)
            | (_, ElectionState::Failed)
    );

    if ok {
        Ok(())
    } else {
        Err(DomainError::InvalidElectionTransition { from, to })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_expected_state_transition() {
        assert!(validate_transition(ElectionState::Draft, ElectionState::ArtifactsReady).is_ok());
    }

    #[test]
    fn rejects_skipped_state_transition() {
        assert!(validate_transition(ElectionState::Draft, ElectionState::VotingActive).is_err());
    }
}
