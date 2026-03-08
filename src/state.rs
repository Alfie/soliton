use anchor_lang::prelude::*;
use direct_consequence::verify_step;

/// Number of history entries stored per account.
/// Each entry is 10 bytes: cells (u64) + left_used (u8) + right_used (u8).
/// 64 entries = 640 bytes of history.
pub const HISTORY_LEN: usize = 64;

/// A single generation snapshot stored in the ring buffer.
/// Records the cells and the boundary values actually used to compute them,
/// so any observer can verify the transition without reading neighbor accounts.
#[derive(AnchorSerialize, AnchorDeserialize, Debug, Clone, Copy, Default)]
pub struct HistoryEntry {
    /// Packed cell state for this generation: bit i = cell i, LSB first.
    pub cells: u64,
    /// Left boundary value used when computing this generation.
    pub left_used: u8,
    /// Right boundary value used when computing this generation.
    pub right_used: u8,
}

/// On-chain state for one Rule 110 automaton tile.
///
/// Serialized with Borsh + Anchor 8-byte discriminator.
/// Total size = 8 + 1 + 8 + 1 + 1 + 8 + 1 + 33 + 33 + 1 + 640 = 735 bytes.
#[account]
#[derive(Debug)]
pub struct CAState {
    /// Tile index — part of the PDA seed, allows multiple tiles per authority.
    pub tile_id: u8,

    /// Number of cells in use (1..=64).
    pub width: u8,

    /// Packed cell state for the current (latest) generation: bit i = cell i, LSB first.
    pub cells: u64,

    /// Fallback left boundary bit — used when left_neighbor is None.
    pub left_boundary: u8,

    /// Fallback right boundary bit — used when right_neighbor is None.
    pub right_boundary: u8,

    /// Monotonically increasing step counter.
    pub generation: u64,

    /// Cached PDA bump seed.
    pub bump: u8,

    /// Optional left neighbor account pubkey.
    /// When Some, the evolve instruction reads the neighbor's rightmost cell
    /// as the left boundary for this tile.
    pub left_neighbor: Option<Pubkey>,

    /// Optional right neighbor account pubkey.
    /// When Some, the evolve instruction reads the neighbor's leftmost cell
    /// as the right boundary for this tile.
    pub right_neighbor: Option<Pubkey>,

    /// Ring buffer write head — index of the slot that will be written NEXT.
    /// The most recent entry is at [(history_head + HISTORY_LEN - 1) % HISTORY_LEN].
    /// Initialized to 0; wraps around after HISTORY_LEN entries.
    pub history_head: u8,

    /// Ring buffer of past generation snapshots.
    /// Oldest entry is at history_head (about to be overwritten).
    /// Most recent entry is at (history_head + HISTORY_LEN - 1) % HISTORY_LEN.
    pub history: [HistoryEntry; HISTORY_LEN],
}

impl CAState {
    /// Serialized size in bytes (Anchor discriminator + all fields).
    pub const LEN: usize =
        8    // Anchor discriminator
        + 1  // tile_id
        + 1  // width
        + 8  // cells
        + 1  // left_boundary
        + 1  // right_boundary
        + 8  // generation
        + 1  // bump
        + 33 // left_neighbor  (Option<Pubkey>: 1 tag + 32)
        + 33 // right_neighbor (Option<Pubkey>: 1 tag + 32)
        + 1  // history_head
        + HISTORY_LEN * 10; // history (64 x 10 bytes)
    // = 736

    // -----------------------------------------------------------------------
    // Bit-level accessors
    // -----------------------------------------------------------------------

    /// Return the bit at position `pos` within this tile.
    pub fn get_bit(&self, pos: i32) -> u8 {
        if pos < 0 {
            self.left_boundary & 1
        } else if pos >= self.width as i32 {
            self.right_boundary & 1
        } else {
            ((self.cells >> (pos as u64)) & 1) as u8
        }
    }

    /// Return the leftmost cell of this tile (bit 0).
    pub fn left_edge(&self) -> u8 {
        (self.cells & 1) as u8
    }

    /// Return the rightmost cell of this tile (bit width-1).
    pub fn right_edge(&self) -> u8 {
        ((self.cells >> (self.width as u64 - 1)) & 1) as u8
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

    /// Compute the 3-bit neighborhood index for cell `pos`,
    /// using explicit left and right boundary overrides for the tile edges.
    fn neighborhood_with_boundaries(&self, pos: i32, left_bound: u8, right_bound: u8) -> u8 {
        let left = if pos == 0 {
            left_bound & 1
        } else {
            self.get_bit(pos - 1)
        };
        let center = self.get_bit(pos);
        let right = if pos == self.width as i32 - 1 {
            right_bound & 1
        } else {
            self.get_bit(pos + 1)
        };
        (left << 2) | (center << 1) | right
    }

    /// Compute the next generation given explicit boundary values.
    ///
    /// `left_bound`  — the cell immediately to the left of cell 0
    ///                 (from left neighbor's right_edge, or left_boundary fallback).
    /// `right_bound` — the cell immediately to the right of cell width-1
    ///                 (from right neighbor's left_edge, or right_boundary fallback).
    ///
    /// Pure function — does NOT mutate self.
    pub fn compute_next_with_boundaries(&self, left_bound: u8, right_bound: u8) -> u64 {
        let mut next: u64 = 0;
        for pos in 0..self.width as i32 {
            let n = self.neighborhood_with_boundaries(pos, left_bound, right_bound);
            let bit = Self::rule110_lookup(n) as u64;
            next |= bit << pos as u64;
        }
        next
    }

    /// Convenience wrapper — uses stored boundary values directly.
    /// Used when no neighbor accounts are provided.
    pub fn compute_next(&self) -> u64 {
        self.compute_next_with_boundaries(self.left_boundary, self.right_boundary)
    }

    // -----------------------------------------------------------------------
    // History
    // -----------------------------------------------------------------------

    /// Append a new entry to the ring buffer.
    ///
    /// Advances history_head to the next slot, writes there, so history_head
    /// always points to the most recently written entry.
    /// Overwrites the oldest entry once the buffer is full (after HISTORY_LEN steps).
    pub fn push_history(&mut self, cells: u64, left_used: u8, right_used: u8) {
        self.history_head = ((self.history_head as usize + 1) % HISTORY_LEN) as u8;
        let idx = self.history_head as usize;
        self.history[idx] = HistoryEntry { cells, left_used, right_used };
    }

    /// Return history entries in chronological order (oldest to newest),
    /// ending at history[history_head] which is the most recent entry.
    ///
    /// Returns up to min(generation, HISTORY_LEN) entries.
    /// Frontend can iterate the result straight through to render the spacetime diagram.
    pub fn history_ordered(&self) -> Vec<HistoryEntry> {
        let count = (self.generation as usize).min(HISTORY_LEN);
        let mut out = Vec::with_capacity(count);
        // oldest slot is (history_head + 1) % HISTORY_LEN when buffer is full,
        // or (history_head - count + 1 + HISTORY_LEN) % HISTORY_LEN in general.
        let oldest = (self.history_head as usize + HISTORY_LEN + 1 - count) % HISTORY_LEN;
        for i in 0..count {
            let idx = (oldest + i) % HISTORY_LEN;
            out.push(self.history[idx]);
        }
        out
    }

    // -----------------------------------------------------------------------
    // Verifier bridge (base layer only)
    // -----------------------------------------------------------------------

    /// Verify that `next_cells` is the correct Rule 110 successor given
    /// the explicit boundary values used.
    /// Kept for reference — not called on-chain due to BPF heap constraints.
    /// The Isabelle proof (theory_Rule110_thy.txt) formally verifies correctness.
    #[allow(dead_code)]
    pub fn verify_transition(&self, next_cells: u64, left_used: u8, right_used: u8) -> std::result::Result<(), ()> {
        let mut current_padded = Vec::with_capacity(self.width as usize + 2);
        current_padded.push(left_used != 0);
        for i in 0..self.width {
            current_padded.push((self.cells >> i) & 1 == 1);
        }
        current_padded.push(right_used != 0);

        let padded_len = current_padded.len();
        let mut next_padded = Vec::with_capacity(padded_len);
        for i in 0..padded_len {
            let l = if i == 0 { false } else { current_padded[i - 1] };
            let c = current_padded[i];
            let r = if i == padded_len - 1 { false } else { current_padded[i + 1] };
            let n = ((l as u8) << 2) | ((c as u8) << 1) | (r as u8);
            next_padded.push(Self::rule110_lookup(n) != 0);
        }

        for i in 0..self.width as usize {
            next_padded[i + 1] = (next_cells >> i) & 1 == 1;
        }

        if verify_step(&current_padded, &next_padded) { Ok(()) } else { Err(()) }
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
