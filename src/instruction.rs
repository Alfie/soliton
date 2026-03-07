use borsh::{BorshDeserialize, BorshSerialize};

/// Wire format for every instruction this program accepts.
///
/// The first byte is the discriminant (instruction tag).  The rest is the
/// Borsh-encoded payload.  Clients build instructions with `Instruction::new_with_borsh`.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub enum Rule110Instruction {
    /// Initialize a new CA instance.
    ///
    /// Accounts expected:
    ///   0. `[writable]`         CA state PDA (must be uninitialized / zero-lamport)
    ///   1. `[signer, writable]` Authority (payer)
    ///   2. `[]`                 System program
    Initialize {
        width: u8,
        initial_cells: u64,
        left_boundary: u8,
        right_boundary: u8,
    },

    /// Advance one verified generation.
    ///
    /// Accounts expected:
    ///   0. `[writable]` CA state PDA
    ///   1. `[signer]`   Authority
    Evolve,

    /// Advance N verified generations in one transaction.
    ///
    /// Accounts expected:
    ///   0. `[writable]` CA state PDA
    ///   1. `[signer]`   Authority
    EvolveN { generations: u16 },

    /// Reset to a new initial state (keeps the same PDA).
    ///
    /// Accounts expected:
    ///   0. `[writable]` CA state PDA
    ///   1. `[signer]`   Authority
    Reset {
        initial_cells: u64,
        left_boundary: u8,
        right_boundary: u8,
    },
}
