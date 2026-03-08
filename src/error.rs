use anchor_lang::prelude::*;

#[error_code]
pub enum Rule110Error {
    #[msg("Width must be between 1 and 64")]
    InvalidWidth,

    #[msg("Boundary values must be 0 or 1")]
    InvalidBoundary,

    #[msg("Rule 110 transition verification failed")]
    VerificationFailed,

    #[msg("generations must be >= 1")]
    InvalidGenerations,

    #[msg("side must be 0 (left) or 1 (right)")]
    InvalidSide,

    #[msg("A neighbor pubkey is set but the neighbor account was not passed in remaining_accounts")]
    MissingNeighborAccount,
}
