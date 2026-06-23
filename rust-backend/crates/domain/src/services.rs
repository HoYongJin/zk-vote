//! Pure domain rules for registration, election creation, finalization, vote
//! submission, and completion. Every rule takes plain values so it can be
//! unit-tested without a database, and every rejection carries the error code
//! the route layer must emit.

use num_bigint::BigUint;
use time::OffsetDateTime;

// ---------------------------------------------------------------------------
// Field elements (decimal or 0x-hex strings at every API boundary)
// ---------------------------------------------------------------------------

/// BN254 SCALAR field Fr — the domain of public signals (root, nullifier, …).
pub const FIELD_ELEMENT_MODULUS_DEC: &str =
    "21888242871839275222246405745257275088548364400416034343698204186575808495617";

/// BN254 BASE field Fq — the domain of G1/G2 point coordinates, i.e. the Groth16
/// proof elements a/b/c. Fq > Fr, so validating proof coordinates against Fr
/// (SOL-VAL-3) spuriously rejects a valid proof whose coordinate falls in
/// [Fr, Fq). Proof points must be checked against Fq; only public SIGNALS are Fr.
pub const BASE_FIELD_MODULUS_DEC: &str =
    "21888242871839275222246405745257275088696311157297823662689037894645226208583";

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum FieldElementError {
    #[error("field element must be a non-negative decimal or 0x-hex integer")]
    Parse,
    #[error("field element is outside the BN254 scalar field")]
    OutOfRange,
}

fn field_modulus() -> BigUint {
    BigUint::parse_bytes(FIELD_ELEMENT_MODULUS_DEC.as_bytes(), 10)
        .expect("valid BN254 scalar field modulus")
}

fn base_field_modulus() -> BigUint {
    BigUint::parse_bytes(BASE_FIELD_MODULUS_DEC.as_bytes(), 10)
        .expect("valid BN254 base field modulus")
}

fn parse_integer(value: &str) -> Result<BigUint, FieldElementError> {
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        BigUint::parse_bytes(hex.as_bytes(), 16).ok_or(FieldElementError::Parse)
    } else {
        value
            .parse::<BigUint>()
            .map_err(|_| FieldElementError::Parse)
    }
}

/// Parse a public-SIGNAL field element (decimal or 0x-hex), bounded by the BN254
/// SCALAR field Fr.
pub fn parse_field_element(value: &str) -> Result<BigUint, FieldElementError> {
    let parsed = parse_integer(value)?;
    if parsed >= field_modulus() {
        return Err(FieldElementError::OutOfRange);
    }
    Ok(parsed)
}

/// Parse a Groth16 PROOF coordinate (a/b/c), bounded by the BN254 BASE field Fq.
pub fn parse_base_field_element(value: &str) -> Result<BigUint, FieldElementError> {
    let parsed = parse_integer(value)?;
    if parsed >= base_field_modulus() {
        return Err(FieldElementError::OutOfRange);
    }
    Ok(parsed)
}

/// `BigInt("0x" + uuid-without-dashes)` — the election identity inside the
/// circuit and the `VotingTally` constructor (must match the frontend's
/// `electionIdToBigInt`).
pub fn election_id_to_field(election_uuid: &uuid::Uuid) -> BigUint {
    BigUint::from_bytes_be(election_uuid.as_bytes())
}

// ---------------------------------------------------------------------------
// Registration eligibility (AR-H2 guard)
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum RegistrationRejection {
    #[error("REGISTRATION_PERIOD_ENDED")]
    PeriodEnded,
    #[error("ALREADY_FINALIZED")]
    AlreadyFinalized,
    #[error("NOT_ON_VOTER_LIST")]
    NotOnVoterList,
    #[error("ALREADY_REGISTERED")]
    AlreadyRegistered,
    #[error("OVER_CAPACITY")]
    OverCapacity,
}

pub struct RegistrationCheck {
    pub now: OffsetDateTime,
    pub registration_end: OffsetDateTime,
    /// merkle_root already set, or a durable finalizing/on-chain marker.
    pub finalized: bool,
    pub allowlisted: bool,
    pub already_registered: bool,
    pub registered_count: u64,
    pub merkle_depth: u32,
}

pub fn check_registration(check: &RegistrationCheck) -> Result<(), RegistrationRejection> {
    if check.finalized {
        return Err(RegistrationRejection::AlreadyFinalized);
    }
    if check.now > check.registration_end {
        return Err(RegistrationRejection::PeriodEnded);
    }
    if !check.allowlisted {
        return Err(RegistrationRejection::NotOnVoterList);
    }
    if check.already_registered {
        return Err(RegistrationRejection::AlreadyRegistered);
    }
    // AR-H2: a registration that would exceed 2^depth leaves would brick
    // finalize and /proof with `Tree is full`.
    if check.registered_count + 1 > capacity(check.merkle_depth) {
        return Err(RegistrationRejection::OverCapacity);
    }
    Ok(())
}

pub fn capacity(merkle_depth: u32) -> u64 {
    1u64 << merkle_depth.min(63)
}

/// AR-H2 allowlist guard: existing + new <= 2^depth.
pub fn check_allowlist_capacity(
    existing: u64,
    new: u64,
    merkle_depth: u32,
) -> Result<(), RegistrationRejection> {
    if existing + new > capacity(merkle_depth) {
        Err(RegistrationRejection::OverCapacity)
    } else {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Election creation input validation (audit M4)
// ---------------------------------------------------------------------------

pub const MAX_SUPPORTED_MERKLE_DEPTH: u32 = 5;
pub const MAX_SUPPORTED_CANDIDATES: usize = 5;

/// Validates and normalizes admin election-creation input. Returns the
/// trimmed name and trimmed candidate labels; every rejection is the
/// human-readable `details` string paired with VALIDATION_ERROR.
pub fn validate_election_input(
    name: &str,
    merkle_tree_depth: u32,
    candidates: &[String],
    registration_end: OffsetDateTime,
    now: OffsetDateTime,
) -> Result<(String, Vec<String>), String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("`name` must be a non-empty string.".to_string());
    }
    if merkle_tree_depth == 0 {
        return Err("`merkleTreeDepth` must be a positive integer.".to_string());
    }
    if merkle_tree_depth > MAX_SUPPORTED_MERKLE_DEPTH {
        return Err(format!(
            "`merkleTreeDepth` must be {MAX_SUPPORTED_MERKLE_DEPTH} or lower."
        ));
    }
    if candidates.is_empty() || candidates.iter().any(|c| c.trim().is_empty()) {
        return Err("`candidates` must be a non-empty array of strings.".to_string());
    }
    let normalized: Vec<String> = candidates.iter().map(|c| c.trim().to_string()).collect();
    if normalized.len() > MAX_SUPPORTED_CANDIDATES {
        return Err(format!(
            "`candidates` must contain {MAX_SUPPORTED_CANDIDATES} or fewer entries."
        ));
    }
    let mut keys: Vec<String> = normalized.iter().map(|c| c.to_lowercase()).collect();
    keys.sort();
    keys.dedup();
    if keys.len() != normalized.len() {
        return Err("`candidates` must not contain duplicate names.".to_string());
    }
    if registration_end <= now {
        return Err(
            "`regEndTime` must be a valid ISO 8601 date string set in the future.".to_string(),
        );
    }
    Ok((trimmed_name.to_string(), normalized))
}

// ---------------------------------------------------------------------------
// Finalization eligibility pre-checks
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum FinalizationRejection {
    #[error("STATE_ERROR")]
    ContractNotDeployed,
    #[error("ALREADY_FINALIZED")]
    AlreadyFinalized,
    #[error("NO_VOTERS_REGISTERED")]
    NoVotersRegistered,
    #[error("VALIDATION_ERROR")]
    VoteEndNotInFuture,
}

pub struct FinalizationCheck {
    pub now: OffsetDateTime,
    pub contract_deployed: bool,
    pub already_finalized: bool,
    pub registered_voters: u64,
    pub vote_end: OffsetDateTime,
}

pub fn check_finalization(check: &FinalizationCheck) -> Result<(), FinalizationRejection> {
    if check.vote_end <= check.now {
        return Err(FinalizationRejection::VoteEndNotInFuture);
    }
    if !check.contract_deployed {
        return Err(FinalizationRejection::ContractNotDeployed);
    }
    if check.already_finalized {
        return Err(FinalizationRejection::AlreadyFinalized);
    }
    if check.registered_voters == 0 {
        return Err(FinalizationRejection::NoVotersRegistered);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Vote submission validation (post-C1 4-signal)
// ---------------------------------------------------------------------------

pub const PUBLIC_SIGNAL_ROOT_INDEX: usize = 0;
pub const PUBLIC_SIGNAL_CANDIDATE_INDEX: usize = 1;
pub const PUBLIC_SIGNAL_NULLIFIER_INDEX: usize = 2;
pub const PUBLIC_SIGNAL_ELECTION_ID_INDEX: usize = 3;
pub const PUBLIC_SIGNAL_COUNT: usize = 4;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum SubmitRejection {
    #[error("INVALID_PAYLOAD")]
    MalformedSignals,
    #[error("TICKET_ELECTION_MISMATCH")]
    TicketElectionMismatch,
    #[error("ELECTION_ID_MISMATCH")]
    ElectionIdMismatch,
    #[error("MERKLE_ROOT_MISMATCH")]
    RootMismatch,
    #[error("INVALID_CANDIDATE_INDEX")]
    CandidateOutOfRange,
}

pub struct SubmitCheck<'a> {
    pub public_signals: &'a [String],
    pub route_election_id: uuid::Uuid,
    pub ticket_election_id: uuid::Uuid,
    /// Finalized election root (decimal string from the DB).
    pub election_merkle_root: &'a str,
    /// Root the single-use ticket was issued against.
    pub ticket_merkle_root: &'a str,
    pub num_candidates: u64,
}

/// The validated, normalized public signals of an accepted submission.
#[derive(Debug)]
pub struct ValidatedSubmission {
    pub root: BigUint,
    pub candidate_index: u64,
    pub nullifier_hash: BigUint,
}

pub fn check_submission(check: &SubmitCheck<'_>) -> Result<ValidatedSubmission, SubmitRejection> {
    if check.public_signals.len() != PUBLIC_SIGNAL_COUNT {
        return Err(SubmitRejection::MalformedSignals);
    }
    let parse = |index: usize| {
        parse_field_element(&check.public_signals[index])
            .map_err(|_| SubmitRejection::MalformedSignals)
    };
    let root = parse(PUBLIC_SIGNAL_ROOT_INDEX)?;
    let candidate = parse(PUBLIC_SIGNAL_CANDIDATE_INDEX)?;
    let nullifier = parse(PUBLIC_SIGNAL_NULLIFIER_INDEX)?;
    let proof_election = parse(PUBLIC_SIGNAL_ELECTION_ID_INDEX)?;

    if check.ticket_election_id != check.route_election_id {
        return Err(SubmitRejection::TicketElectionMismatch);
    }
    // C1: the proof must bind THIS election; the contract enforces the same
    // check on-chain, this gives a clean 400 before relaying a doomed tx.
    if proof_election != election_id_to_field(&check.route_election_id) {
        return Err(SubmitRejection::ElectionIdMismatch);
    }

    let db_root = parse_field_element(check.election_merkle_root)
        .map_err(|_| SubmitRejection::RootMismatch)?;
    let ticket_root =
        parse_field_element(check.ticket_merkle_root).map_err(|_| SubmitRejection::RootMismatch)?;
    if root != db_root || root != ticket_root {
        return Err(SubmitRejection::RootMismatch);
    }

    let candidate_index =
        u64::try_from(&candidate).map_err(|_| SubmitRejection::CandidateOutOfRange)?;
    if candidate_index >= check.num_candidates {
        return Err(SubmitRejection::CandidateOutOfRange);
    }

    Ok(ValidatedSubmission {
        root,
        candidate_index,
        nullifier_hash: nullifier,
    })
}

// ---------------------------------------------------------------------------
// Completion eligibility
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum CompletionRejection {
    #[error("ALREADY_COMPLETED")]
    AlreadyCompleted,
    #[error("ELECTION_SUPERSEDED")]
    Superseded,
    #[error("VOTING_NOT_STARTED")]
    VotingNotStarted,
    #[error("VOTING_PERIOD_ACTIVE")]
    VotingActive,
}

pub fn check_completion(
    now: OffsetDateTime,
    voting_end: Option<OffsetDateTime>,
    completed: bool,
    superseded: bool,
) -> Result<(), CompletionRejection> {
    if completed {
        return Err(CompletionRejection::AlreadyCompleted);
    }
    if superseded {
        return Err(CompletionRejection::Superseded);
    }
    let Some(voting_end) = voting_end else {
        return Err(CompletionRejection::VotingNotStarted);
    };
    if now < voting_end {
        return Err(CompletionRejection::VotingActive);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Duration;

    fn now() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_780_000_000).unwrap()
    }

    fn registration_base() -> RegistrationCheck {
        RegistrationCheck {
            now: now(),
            registration_end: now() + Duration::hours(1),
            finalized: false,
            allowlisted: true,
            already_registered: false,
            registered_count: 3,
            merkle_depth: 4,
        }
    }

    #[test]
    fn registration_accepts_an_eligible_voter() {
        assert_eq!(check_registration(&registration_base()), Ok(()));
    }

    #[test]
    fn registration_rejections_mirror_node_codes() {
        let mut check = registration_base();
        check.finalized = true;
        assert_eq!(
            check_registration(&check),
            Err(RegistrationRejection::AlreadyFinalized)
        );

        let mut check = registration_base();
        check.registration_end = now() - Duration::minutes(1);
        assert_eq!(
            check_registration(&check),
            Err(RegistrationRejection::PeriodEnded)
        );

        let mut check = registration_base();
        check.allowlisted = false;
        assert_eq!(
            check_registration(&check),
            Err(RegistrationRejection::NotOnVoterList)
        );

        let mut check = registration_base();
        check.already_registered = true;
        assert_eq!(
            check_registration(&check),
            Err(RegistrationRejection::AlreadyRegistered)
        );

        let mut check = registration_base();
        check.registered_count = 16; // capacity(4) == 16, +1 overflows
        assert_eq!(
            check_registration(&check),
            Err(RegistrationRejection::OverCapacity)
        );
    }

    #[test]
    fn allowlist_capacity_guard_matches_ar_h2() {
        assert_eq!(check_allowlist_capacity(3, 1, 2), Ok(()));
        assert_eq!(
            check_allowlist_capacity(3, 2, 2),
            Err(RegistrationRejection::OverCapacity)
        );
    }

    #[test]
    fn finalization_requires_contract_root_voters_and_future_end() {
        let base = FinalizationCheck {
            now: now(),
            contract_deployed: true,
            already_finalized: false,
            registered_voters: 2,
            vote_end: now() + Duration::hours(1),
        };
        assert_eq!(check_finalization(&base), Ok(()));

        let check = FinalizationCheck {
            contract_deployed: false,
            ..base
        };
        assert_eq!(
            check_finalization(&check),
            Err(FinalizationRejection::ContractNotDeployed)
        );

        let check = FinalizationCheck {
            already_finalized: true,
            ..base
        };
        assert_eq!(
            check_finalization(&check),
            Err(FinalizationRejection::AlreadyFinalized)
        );

        let check = FinalizationCheck {
            registered_voters: 0,
            ..base
        };
        assert_eq!(
            check_finalization(&check),
            Err(FinalizationRejection::NoVotersRegistered)
        );

        let check = FinalizationCheck {
            vote_end: now() - Duration::minutes(1),
            ..base
        };
        assert_eq!(
            check_finalization(&check),
            Err(FinalizationRejection::VoteEndNotInFuture)
        );
    }

    const ELECTION_UUID: &str = "00000000-0000-0000-0000-00000000007b";

    fn submit_base(signals: Vec<&str>) -> (Vec<String>, uuid::Uuid) {
        (
            signals.into_iter().map(String::from).collect(),
            ELECTION_UUID.parse().unwrap(),
        )
    }

    #[test]
    fn submission_accepts_the_post_c1_signal_shape() {
        // election_id 0x7b == 123 — the electionIdToBigInt derivation.
        let (signals, election) = submit_base(vec!["123", "1", "456", "123"]);
        let result = check_submission(&SubmitCheck {
            public_signals: &signals,
            route_election_id: election,
            ticket_election_id: election,
            election_merkle_root: "123",
            ticket_merkle_root: "123",
            num_candidates: 3,
        })
        .unwrap();
        assert_eq!(result.candidate_index, 1);
        assert_eq!(result.nullifier_hash.to_string(), "456");
    }

    #[test]
    fn submission_rejects_v1_three_signal_payloads() {
        let (signals, election) = submit_base(vec!["123", "1", "456"]);
        let err = check_submission(&SubmitCheck {
            public_signals: &signals,
            route_election_id: election,
            ticket_election_id: election,
            election_merkle_root: "123",
            ticket_merkle_root: "123",
            num_candidates: 3,
        })
        .unwrap_err();
        assert_eq!(err, SubmitRejection::MalformedSignals);
    }

    #[test]
    fn submission_rejects_wrong_election_binding_c1() {
        let (signals, election) = submit_base(vec!["123", "1", "456", "999"]);
        let err = check_submission(&SubmitCheck {
            public_signals: &signals,
            route_election_id: election,
            ticket_election_id: election,
            election_merkle_root: "123",
            ticket_merkle_root: "123",
            num_candidates: 3,
        })
        .unwrap_err();
        assert_eq!(err, SubmitRejection::ElectionIdMismatch);
    }

    #[test]
    fn submission_rejects_root_and_candidate_mismatches() {
        let (signals, election) = submit_base(vec!["124", "1", "456", "123"]);
        let err = check_submission(&SubmitCheck {
            public_signals: &signals,
            route_election_id: election,
            ticket_election_id: election,
            election_merkle_root: "123",
            ticket_merkle_root: "123",
            num_candidates: 3,
        })
        .unwrap_err();
        assert_eq!(err, SubmitRejection::RootMismatch);

        let (signals, election) = submit_base(vec!["123", "7", "456", "123"]);
        let err = check_submission(&SubmitCheck {
            public_signals: &signals,
            route_election_id: election,
            ticket_election_id: election,
            election_merkle_root: "123",
            ticket_merkle_root: "123",
            num_candidates: 3,
        })
        .unwrap_err();
        assert_eq!(err, SubmitRejection::CandidateOutOfRange);
    }

    #[test]
    fn submission_rejects_foreign_tickets() {
        let (signals, election) = submit_base(vec!["123", "1", "456", "123"]);
        let err = check_submission(&SubmitCheck {
            public_signals: &signals,
            route_election_id: election,
            ticket_election_id: uuid::Uuid::nil(),
            election_merkle_root: "123",
            ticket_merkle_root: "123",
            num_candidates: 3,
        })
        .unwrap_err();
        assert_eq!(err, SubmitRejection::TicketElectionMismatch);
    }

    #[test]
    fn completion_requires_an_ended_unfinished_vote() {
        assert_eq!(
            check_completion(now(), Some(now() - Duration::hours(1)), false, false),
            Ok(())
        );
        assert_eq!(
            check_completion(now(), Some(now() - Duration::hours(1)), true, false),
            Err(CompletionRejection::AlreadyCompleted)
        );
        assert_eq!(
            check_completion(now(), Some(now() - Duration::hours(1)), false, true),
            Err(CompletionRejection::Superseded)
        );
        assert_eq!(
            check_completion(now(), None, false, false),
            Err(CompletionRejection::VotingNotStarted)
        );
        assert_eq!(
            check_completion(now(), Some(now() + Duration::hours(1)), false, false),
            Err(CompletionRejection::VotingActive)
        );
    }

    #[test]
    fn election_id_field_matches_node_derivation() {
        let uuid: uuid::Uuid = ELECTION_UUID.parse().unwrap();
        assert_eq!(election_id_to_field(&uuid).to_string(), "123");
    }

    #[test]
    fn parses_decimal_and_hex_field_elements() {
        assert_eq!(parse_field_element("123").unwrap().to_string(), "123");
        assert_eq!(parse_field_element("0x7b").unwrap().to_string(), "123");
        assert!(parse_field_element("not-a-number").is_err());
        assert_eq!(
            parse_field_element(FIELD_ELEMENT_MODULUS_DEC),
            Err(FieldElementError::OutOfRange)
        );
    }

    #[test]
    fn proof_points_use_the_larger_base_field_fq() {
        // SOL-VAL-3 boundary: Fr (the scalar modulus) is a valid base-field (Fq)
        // coordinate but NOT a valid scalar-field signal. Proof points must use Fq.
        assert_eq!(
            parse_field_element(FIELD_ELEMENT_MODULUS_DEC),
            Err(FieldElementError::OutOfRange)
        );
        assert!(parse_base_field_element(FIELD_ELEMENT_MODULUS_DEC).is_ok());
        // Fq itself is out of range for the base field.
        assert_eq!(
            parse_base_field_element(BASE_FIELD_MODULUS_DEC),
            Err(FieldElementError::OutOfRange)
        );
        assert_eq!(parse_base_field_element("0x7b").unwrap().to_string(), "123");
    }

    #[test]
    fn election_input_validation_mirrors_node_m4_rules() {
        let future = now() + Duration::hours(1);
        let ok =
            validate_election_input(" Election ", 4, &["  A ".into(), "b".into()], future, now())
                .unwrap();
        assert_eq!(ok.0, "Election");
        assert_eq!(ok.1, vec!["A".to_string(), "b".to_string()]);

        assert!(validate_election_input("  ", 4, &["A".into()], future, now()).is_err());
        assert!(validate_election_input("E", 0, &["A".into()], future, now()).is_err());
        assert!(validate_election_input("E", 6, &["A".into()], future, now()).is_err());
        assert!(validate_election_input("E", 4, &[], future, now()).is_err());
        // duplicate after trim, case-insensitive (audit M4)
        assert!(validate_election_input(
            "E",
            4,
            &["Alice".into(), " alice ".into()],
            future,
            now()
        )
        .is_err());
        // candidate cap (audit M4)
        let six: Vec<String> = (0..6).map(|i| format!("c{i}")).collect();
        assert!(validate_election_input("E", 4, &six, future, now()).is_err());
        // past deadline
        assert!(
            validate_election_input("E", 4, &["A".into()], now() - Duration::hours(1), now())
                .is_err()
        );
    }
}
