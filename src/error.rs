use anchor_lang::prelude::*;

#[error_code]
pub enum Rule110Error {
    #[msg("Width must be between 1 and 64")]
    InvalidWidth,

    #[msg("Boundary values must be 0 or 1")]
    InvalidBoundary,

    #[msg("Rule 110 transition verification failed")]
    VerificationFailed,

    #[msg("Generations must be at least 1")]
    InvalidGenerations,
}
