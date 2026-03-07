use anchor_lang::prelude::*;
use direct_consequence::verify_step;

/// On-chain state for one Rule 110 automaton instance.
///
/// Serialized with Borsh via Anchor.
/// Total size = 8 (discriminator) + 1 + 8 + 1 + 1 + 8 + 1 = 28 bytes.
#[account]
#[derive(Debug)]
pub struct CAState {
    /// Number of cells in use (1..=64).
    pub width: u8,

    /// Packed cell state: bit i = cell i, LSB first.
    pub cells: u64,

    /// Boundary bit to the left of cell 0.
    pub left_boundary: u8,

    /// Boundary bit to the right of cell `width - 1`.
    pub right_boundary: u8,

    /// Monotonically increasing step counter.
    pub generation: u64,

    /// Cached PDA bump seed.
    pub bump: u8,
}

impl CAState {
    /// Serialized size in bytes — discriminator + fields.
    pub const LEN: usize = 8 + 1 + 8 + 1 + 1 + 8 + 1; // = 28

    // -----------------------------------------------------------------------
    // Bit-level accessors
    // -----------------------------------------------------------------------

    /// Return the bit at position `pos`.
    ///
    /// Out-of-range positions return the appropriate boundary value.
    pub fn get_bit(&self, pos: i32) -> u8 {
        if pos < 0 {
            self.left_boundary & 1
        } else if pos >= self.width as i32 {
            self.right_boundary & 1
        } else {
            ((self.cells >> (pos as u64)) & 1) as u8
        }
    }

    /// Compute the 3-bit neighborhood index for cell `pos`.
    ///
    /// Bit 2 = left neighbor, Bit 1 = center, Bit 0 = right neighbor.
    pub fn neighborhood(&self, pos: i32) -> u8 {
        let left   = self.get_bit(pos - 1);
        let center = self.get_bit(pos);
        let right  = self.get_bit(pos + 1);
        (left << 2) | (center << 1) | right
    }

    // -----------------------------------------------------------------------
    // Rule 110
    // -----------------------------------------------------------------------

    /// Apply the Rule 110 lookup table to a 3-bit neighborhood index.
    ///
    /// Rule 110 = 0b_0110_1110 = 0x6E.
    #[inline(always)]
    pub fn rule110_lookup(neighborhood: u8) -> u8 {
        (0x6E_u8 >> neighborhood) & 1
    }

    /// Compute the next generation as a packed u64.
    ///
    /// Pure function — does NOT mutate self.
    pub fn compute_next(&self) -> u64 {
        let mut next: u64 = 0;
        for pos in 0..self.width as i32 {
            let n   = self.neighborhood(pos);
            let bit = Self::rule110_lookup(n) as u64;
            next |= bit << pos as u64;
        }
        next
    }

    // -----------------------------------------------------------------------
    // Verifier bridge
    // -----------------------------------------------------------------------

    /// Verify that `next_cells` is the correct Rule 110 successor of the
    /// current state, accounting for boundary conditions.
    pub fn verify_transition(&self, next_cells: u64) -> Result<()> {
        // Build padded current: [left_boundary, ...cells..., right_boundary]
        let mut current_padded = Vec::with_capacity(self.width as usize + 2);
        current_padded.push(self.left_boundary != 0);
        for i in 0..self.width {
            current_padded.push((self.cells >> i) & 1 == 1);
        }
        current_padded.push(self.right_boundary != 0);

        // Build padded next by applying Rule 110 to padded_current.
        let padded_len = current_padded.len();
        let mut next_padded = Vec::with_capacity(padded_len);
        for i in 0..padded_len {
            let l = if i == 0             { false } else { current_padded[i - 1] };
            let c = current_padded[i];
            let r = if i == padded_len - 1 { false } else { current_padded[i + 1] };
            let n = ((l as u8) << 2) | ((c as u8) << 1) | (r as u8);
            next_padded.push(Self::rule110_lookup(n) != 0);
        }

        // Overwrite interior with the actual on-chain next values.
        for i in 0..self.width as usize {
            next_padded[i + 1] = (next_cells >> i) & 1 == 1;
        }

        if verify_step(&current_padded, &next_padded) {
            Ok(())
        } else {
            err!(crate::error::Rule110Error::VerificationFailed)
        }
    }

    // -----------------------------------------------------------------------
    // Misc helpers
    // -----------------------------------------------------------------------

    pub fn cells_as_bools(&self) -> Vec<bool> {
        (0..self.width)
            .map(|i| (self.cells >> i) & 1 == 1)
            .collect()
    }
}
