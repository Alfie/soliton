use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};

pub mod error;
pub mod state;

use state::CAState;

declare_id!("CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ");

pub const CA_STATE_SEED: &[u8] = b"rule110";

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[ephemeral]
#[program]
pub mod rule110_raw {
    use super::*;

    // --- Base layer only ---

    pub fn initialize(
        ctx: Context<Initialize>,
        width: u8,
        initial_cells: u64,
        left_boundary: u8,
        right_boundary: u8,
    ) -> Result<()> {
        require!(width >= 1 && width <= 64, error::Rule110Error::InvalidWidth);
        require!(left_boundary <= 1 && right_boundary <= 1, error::Rule110Error::InvalidBoundary);

        let mask = if width == 64 { u64::MAX } else { (1u64 << width) - 1 };

        let state = &mut ctx.accounts.ca_state;
        state.width          = width;
        state.cells          = initial_cells & mask;
        state.left_boundary  = left_boundary;
        state.right_boundary = right_boundary;
        state.generation     = 0;
        state.bump           = ctx.bumps.ca_state;

        msg!("Initialized Rule 110: width={}, cells={:#018x}, gen=0", width, state.cells);
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

        state.cells          = initial_cells & mask;
        state.left_boundary  = left_boundary;
        state.right_boundary = right_boundary;
        state.generation     = 0;

        msg!("Reset to cells={:#018x}", state.cells);
        Ok(())
    }

    /// Delegate the CA state PDA to the ER delegation program.
    /// Call this on the base layer to open a real-time session.
    pub fn delegate(ctx: Context<DelegateCA>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.authority,
            &[CA_STATE_SEED, ctx.accounts.authority.key().as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|a| a.key()),
                ..Default::default()
            },
        )?;
        msg!("CA state delegated to ER");
        Ok(())
    }

    /// Evolve one generation on the ER.
    /// Any wallet can call this during an active session.
    /// Commits state to the ER after each step so all subscribers see updates.
    pub fn evolve(ctx: Context<Evolve>) -> Result<()> {
        let state = &mut ctx.accounts.ca_state;

        let next_cells = state.compute_next();
        state.verify_transition(next_cells)?;

        state.cells      = next_cells;
        state.generation += 1;

        msg!("Evolved to gen {}: cells={:#018x}", state.generation, state.cells);

        // Sync to ER so all subscribers see the update immediately.
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.ca_state.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        Ok(())
    }

    /// Evolve N generations in one ER transaction.
    /// Useful for fast-forwarding; commits once at the end.
    pub fn evolve_n(ctx: Context<Evolve>, generations: u16) -> Result<()> {
        require!(generations >= 1, error::Rule110Error::InvalidGenerations);

        let state = &mut ctx.accounts.ca_state;

        for _ in 0..generations {
            let next_cells = state.compute_next();
            state.verify_transition(next_cells)?;
            state.cells      = next_cells;
            state.generation += 1;
        }

        msg!("Evolved {} generations; now at gen {}", generations, state.generation);

        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.ca_state.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        Ok(())
    }

    /// Commit current ER state to base layer and end the session.
    /// Call this on the ER to settle the final state back to devnet.
    pub fn undelegate(ctx: Context<Evolve>) -> Result<()> {
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
#[instruction(width: u8)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer  = authority,
        space  = CAState::LEN,
        seeds  = [CA_STATE_SEED, authority.key().as_ref()],
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
        seeds = [CA_STATE_SEED, authority.key().as_ref()],
        bump  = ca_state.bump
    )]
    pub ca_state:  Account<'info, CAState>,

    pub authority: Signer<'info>,
}

/// Delegation context — base layer only.
#[delegate]
#[derive(Accounts)]
pub struct DelegateCA<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: validated by the delegate macro
    pub validator: Option<AccountInfo<'info>>,

    /// CHECK: the PDA to delegate
    #[account(
        mut,
        del,
        seeds = [CA_STATE_SEED, authority.key().as_ref()],
        bump
    )]
    pub pda: AccountInfo<'info>,
}

/// Evolve context — ER only during an active session.
/// No authority check: any wallet can push the CA forward.
#[commit]
#[derive(Accounts)]
pub struct Evolve<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut)]
    pub ca_state: Account<'info, CAState>,
}
