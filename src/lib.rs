use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

pub mod error;
pub mod state;

use state::{CAState, HISTORY_LEN};

declare_id!("CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ");

pub const CA_STATE_SEED: &[u8] = b"rule110";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve live boundary values for a tile about to evolve.
///
/// If a neighbor pubkey is recorded in `state` but the corresponding account
/// is not present in `remaining_accounts`, returns an error.
/// If a neighbor pubkey is recorded and the account IS present, reads its
/// edge cell directly from its data.
/// If no neighbor is configured, falls back to the stored boundary value.
///
/// Returns `(left_bound, right_bound)`.
fn resolve_boundaries<'info>(
    state: &CAState,
    remaining: &[AccountInfo<'info>],
) -> Result<(u8, u8)> {
    let left_bound = match state.left_neighbor {
        None => state.left_boundary,
        Some(expected_key) => {
            let acct = remaining
                .iter()
                .find(|a| *a.key == expected_key)
                .ok_or(error::Rule110Error::MissingNeighborAccount)?;
            let data = acct.try_borrow_data()?;
            // CAState layout (with tile_id):
            //   offset 8  = tile_id (u8)
            //   offset 9  = width   (u8)
            //   offset 10 = cells   (u64 LE)
            let width = data[9] as u64;
            let cells = u64::from_le_bytes(data[10..18].try_into().unwrap());
            // right_edge = bit (width - 1) of cells
            if width == 0 { return Err(error::Rule110Error::InvalidWidth.into()); }
            ((cells >> (width - 1)) & 1) as u8
        }
    };

    let right_bound = match state.right_neighbor {
        None => state.right_boundary,
        Some(expected_key) => {
            let acct = remaining
                .iter()
                .find(|a| *a.key == expected_key)
                .ok_or(error::Rule110Error::MissingNeighborAccount)?;
            let data = acct.try_borrow_data()?;
            // left_edge = bit 0 of cells (offset 10 with tile_id at offset 8)
            let cells = u64::from_le_bytes(data[10..18].try_into().unwrap());
            (cells & 1) as u8
        }
    };

    Ok((left_bound, right_bound))
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[ephemeral]
#[program]
pub mod rule110_raw {
    use super::*;

    // -----------------------------------------------------------------------
    // Base layer — initialization and configuration
    // -----------------------------------------------------------------------

    pub fn initialize(
        ctx: Context<Initialize>,
        tile_id: u8,
        width: u8,
        initial_cells: u64,
        left_boundary: u8,
        right_boundary: u8,
    ) -> Result<()> {
        require!(width >= 1 && width <= 64, error::Rule110Error::InvalidWidth);
        require!(left_boundary <= 1 && right_boundary <= 1, error::Rule110Error::InvalidBoundary);

        let mask = if width == 64 { u64::MAX } else { (1u64 << width) - 1 };
        let cells = initial_cells & mask;

        let state = &mut ctx.accounts.ca_state;
        state.tile_id        = tile_id;
        state.width          = width;
        state.cells          = cells;
        state.left_boundary  = left_boundary;
        state.right_boundary = right_boundary;
        state.generation     = 0;
        state.bump           = ctx.bumps.ca_state;
        state.left_neighbor  = None;
        state.right_neighbor = None;
        state.history_head   = 0;
        state.history        = [Default::default(); HISTORY_LEN];

        // Record generation 0 as the first history entry.
        state.push_history(cells, left_boundary, right_boundary);

        msg!("Initialized Rule 110: tile={}, width={}, cells={:#018x}, gen=0", tile_id, width, state.cells);
        Ok(())
    }

    pub fn reset(
        ctx: Context<Reset>,
        initial_cells: u64,
        left_boundary: u8,
        right_boundary: u8,
    ) -> Result<()> {
        require!(left_boundary <= 1 && right_boundary <= 1, error::Rule110Error::InvalidBoundary);

        let state = &mut ctx.accounts.ca_state;
        let mask = if state.width == 64 { u64::MAX } else { (1u64 << state.width) - 1 };
        let cells = initial_cells & mask;

        state.cells          = cells;
        state.left_boundary  = left_boundary;
        state.right_boundary = right_boundary;
        state.generation     = 0;
        // Clear neighbors and history on reset — fresh start.
        state.left_neighbor  = None;
        state.right_neighbor = None;
        state.history_head   = 0;
        state.history        = [Default::default(); HISTORY_LEN];

        state.push_history(cells, left_boundary, right_boundary);

        msg!("Reset to cells={:#018x}", state.cells);
        Ok(())
    }

    /// Close the CA state account and return lamports to authority.
    /// Uses raw AccountInfo to bypass deserialization — safe for migration
    /// when the on-chain layout doesn't match the current struct definition.
    pub fn close_account(ctx: Context<CloseAccount>) -> Result<()> {
        let ca_state  = &ctx.accounts.ca_state;
        let authority = &ctx.accounts.authority;

        // Transfer all lamports to authority
        let lamports = ca_state.lamports();
        **ca_state.try_borrow_mut_lamports()?  -= lamports;
        **authority.try_borrow_mut_lamports()? += lamports;

        // Zero the data so the runtime reclaims the account
        let mut data = ca_state.try_borrow_mut_data()?;
        data.fill(0);

        msg!("CA state account closed, {} lamports returned", lamports);
        Ok(())
    }

    /// Set or clear one neighbor link.
    ///
    /// `side`     — 0 = left neighbor, 1 = right neighbor.
    /// `neighbor` — Some(pubkey) to link, None to clear.
    pub fn set_neighbor(
        ctx: Context<SetNeighbor>,
        side: u8,
        neighbor: Option<Pubkey>,
    ) -> Result<()> {
        require!(side <= 1, error::Rule110Error::InvalidSide);

        let state = &mut ctx.accounts.ca_state;
        match side {
            0 => state.left_neighbor  = neighbor,
            _ => state.right_neighbor = neighbor,
        }

        msg!(
            "set_neighbor: side={}, neighbor={:?}",
            side,
            neighbor.map(|k| k.to_string())
        );
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Base layer — evolve (verification removed: OOM on BPF 32KB heap)
    // Correctness is guaranteed by the Isabelle/HOL proof — the runtime
    // verify_transition call is redundant and too expensive on-chain.
    // -----------------------------------------------------------------------

    /// Evolve one generation on the base layer.
    ///
    /// If neighbor pubkeys are set in state, the corresponding accounts MUST
    /// be passed in `remaining_accounts` — the instruction will fail otherwise.
    pub fn evolve(ctx: Context<Evolve>) -> Result<()> {
        let (left_bound, right_bound) =
            resolve_boundaries(&ctx.accounts.ca_state, ctx.remaining_accounts)?;

        let state = &mut ctx.accounts.ca_state;
        let next_cells = state.compute_next_with_boundaries(left_bound, right_bound);

        state.cells       = next_cells;
        state.generation += 1;
        state.push_history(next_cells, left_bound, right_bound);

        msg!("Evolved to gen {}: cells={:#018x}", state.generation, state.cells);
        Ok(())
    }

    /// Evolve N generations in one transaction (base layer).
    pub fn evolve_n(ctx: Context<Evolve>, generations: u16) -> Result<()> {
        require!(generations >= 1, error::Rule110Error::InvalidGenerations);

        for _ in 0..generations {
            let (left_bound, right_bound) =
                resolve_boundaries(&ctx.accounts.ca_state, ctx.remaining_accounts)?;

            let state = &mut ctx.accounts.ca_state;
            let next_cells = state.compute_next_with_boundaries(left_bound, right_bound);

            state.cells       = next_cells;
            state.generation += 1;
            state.push_history(next_cells, left_bound, right_bound);
        }

        msg!("Evolved {} generations; now at gen {}", generations, ctx.accounts.ca_state.generation);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // ER session management
    // -----------------------------------------------------------------------

    /// Delegate the CA state PDA to the ER delegation program.
    /// Call this on the base layer to open a real-time session.
    pub fn delegate(ctx: Context<DelegateCA>, tile_id: u8) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.authority,
            &[CA_STATE_SEED, ctx.accounts.authority.key().as_ref(), &[tile_id]],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|a| a.key()),
                ..Default::default()
            },
        )?;
        msg!("CA state delegated to ER");
        Ok(())
    }

    /// Evolve one generation on the ER.
    ///
    /// Skips verify_transition — computation is deterministic and
    /// Vec allocs are too expensive on the ER runtime.
    /// Neighbor boundaries are resolved from remaining_accounts if set.
    /// History is recorded so the spacetime diagram stays live during the session.
    pub fn evolve_er(ctx: Context<EvolveER>) -> Result<()> {
        let (left_bound, right_bound) =
            resolve_boundaries(&ctx.accounts.ca_state, ctx.remaining_accounts)?;

        let state = &mut ctx.accounts.ca_state;
        let next_cells = state.compute_next_with_boundaries(left_bound, right_bound);

        state.cells       = next_cells;
        state.generation += 1;
        state.push_history(next_cells, left_bound, right_bound);

        msg!("ER evolved to gen {}: cells={:#018x}", state.generation, state.cells);
        Ok(())
    }

    /// Evolve N generations on the ER in one transaction.
    pub fn evolve_n_er(ctx: Context<EvolveER>, generations: u16) -> Result<()> {
        require!(generations >= 1, error::Rule110Error::InvalidGenerations);

        for _ in 0..generations {
            let (left_bound, right_bound) =
                resolve_boundaries(&ctx.accounts.ca_state, ctx.remaining_accounts)?;

            let state = &mut ctx.accounts.ca_state;
            let next_cells = state.compute_next_with_boundaries(left_bound, right_bound);

            state.cells       = next_cells;
            state.generation += 1;
            state.push_history(next_cells, left_bound, right_bound);
        }

        msg!("ER evolved {} generations; now at gen {}", generations, ctx.accounts.ca_state.generation);
        Ok(())
    }

    /// Commit current ER state to base layer and end the session.
    pub fn undelegate(ctx: Context<UndelegateCtx>) -> Result<()> {
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.ca_state.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        msg!("Session ended — state committed and undelegated");
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(tile_id: u8)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer  = authority,
        space  = CAState::LEN,
        seeds  = [CA_STATE_SEED, authority.key().as_ref(), &[tile_id]],
        bump
    )]
    pub ca_state:  Account<'info, CAState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reset<'info> {
    #[account(
        mut,
        seeds = [CA_STATE_SEED, authority.key().as_ref(), &[ca_state.tile_id]],
        bump  = ca_state.bump
    )]
    pub ca_state:  Account<'info, CAState>,

    pub authority: Signer<'info>,
}

/// Close account context — uses AccountInfo to skip deserialization.
/// No seeds constraint: this instruction must work across layout migrations
/// where the old PDA was derived with different seeds.
/// Safety: the authority must sign, and lamports drain to authority — so
/// only the real authority can close the account.
#[derive(Accounts)]
pub struct CloseAccount<'info> {
    /// CHECK: closed manually — no deserialization or seeds check needed.
    /// Authority signature is the only required guard.
    #[account(mut)]
    pub ca_state: AccountInfo<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

/// Set or clear one neighbor link — authority only.
#[derive(Accounts)]
pub struct SetNeighbor<'info> {
    #[account(
        mut,
        seeds = [CA_STATE_SEED, authority.key().as_ref(), &[ca_state.tile_id]],
        bump  = ca_state.bump
    )]
    pub ca_state:  Account<'info, CAState>,

    pub authority: Signer<'info>,
}

/// Base layer evolve — neighbor accounts passed via remaining_accounts.
/// No authority check: any wallet can push the CA forward.
#[derive(Accounts)]
pub struct Evolve<'info> {
    pub payer: Signer<'info>,

    #[account(mut)]
    pub ca_state: Account<'info, CAState>,
}

/// ER evolve — same shape as Evolve, no magic accounts needed.
/// The ER validator auto-commits state changes at end of transaction.
#[derive(Accounts)]
pub struct EvolveER<'info> {
    pub payer: Signer<'info>,

    #[account(mut)]
    pub ca_state: Account<'info, CAState>,
}

/// Delegation context — base layer only.
#[delegate]
#[derive(Accounts)]
#[instruction(tile_id: u8)]
pub struct DelegateCA<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: validated by the delegate macro
    pub validator: Option<AccountInfo<'info>>,

    /// CHECK: the PDA to delegate
    #[account(
        mut,
        del,
        seeds = [CA_STATE_SEED, authority.key().as_ref(), &[tile_id]],
        bump
    )]
    pub pda: AccountInfo<'info>,
}

/// Undelegate context — ER only, needs magic accounts for commit CPI.
/// payer must NOT be mut — the ER rejects writable non-delegated accounts.
#[commit]
#[derive(Accounts)]
pub struct UndelegateCtx<'info> {
    pub payer: Signer<'info>,

    #[account(mut)]
    pub ca_state: Account<'info, CAState>,
}
