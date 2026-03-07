use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

use crate::{error::Rule110Error, state::CAState};

// ---------------------------------------------------------------------------
// PDA seed
// ---------------------------------------------------------------------------

pub const CA_STATE_SEED: &[u8] = b"rule110";

/// Derive the CA state PDA and return `(pubkey, bump)`.
pub fn find_ca_state(authority: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CA_STATE_SEED, authority.as_ref()], program_id)
}

// ---------------------------------------------------------------------------
// Account validation helpers
// ---------------------------------------------------------------------------

fn require_signer(account: &AccountInfo) -> ProgramResult {
    if !account.is_signer {
        return Err(Rule110Error::MissingSigner.into());
    }
    Ok(())
}

fn require_owner(account: &AccountInfo, program_id: &Pubkey) -> ProgramResult {
    if account.owner != program_id {
        return Err(Rule110Error::InvalidAccountOwner.into());
    }
    Ok(())
}

fn require_pda(
    account: &AccountInfo,
    authority: &Pubkey,
    program_id: &Pubkey,
    expected_bump: Option<u8>,
) -> Result<u8, ProgramError> {
    let (pda, bump) = find_ca_state(authority, program_id);
    if pda != *account.key {
        return Err(Rule110Error::InvalidPDA.into());
    }
    if let Some(b) = expected_bump {
        if b != bump {
            return Err(Rule110Error::InvalidPDA.into());
        }
    }
    Ok(bump)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub fn process_initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    width: u8,
    initial_cells: u64,
    left_boundary: u8,
    right_boundary: u8,
) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let ca_account = next_account_info(account_iter)?;
    let authority = next_account_info(account_iter)?;
    let system_prog = next_account_info(account_iter)?;

    require_signer(authority)?;

    if width < 1 || width > 64 {
        return Err(Rule110Error::InvalidWidth.into());
    }
    if left_boundary > 1 || right_boundary > 1 {
        return Err(Rule110Error::InvalidBoundary.into());
    }

    let bump = require_pda(ca_account, authority.key, program_id, None)?;

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(CAState::LEN);

    invoke_signed(
        &system_instruction::create_account(
            authority.key,
            ca_account.key,
            lamports,
            CAState::LEN as u64,
            program_id,
        ),
        &[authority.clone(), ca_account.clone(), system_prog.clone()],
        &[&[CA_STATE_SEED, authority.key.as_ref(), &[bump]]],
    )?;

    let mask = if width == 64 {
        u64::MAX
    } else {
        (1u64 << width) - 1
    };
    let state = CAState {
        width,
        cells: initial_cells & mask,
        left_boundary,
        right_boundary,
        generation: 0,
        bump,
    };

    state.serialize(&mut &mut ca_account.data.borrow_mut()[..])?;

    msg!(
        "Initialized Rule 110: width={}, cells={:#018x}, gen=0",
        width,
        state.cells
    );
    Ok(())
}

// ---------------------------------------------------------------------------

pub fn process_evolve(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let account_iter = &mut accounts.iter();
    let ca_account = next_account_info(account_iter)?;
    let authority = next_account_info(account_iter)?;

    require_signer(authority)?;
    require_owner(ca_account, program_id)?;

    let mut state = CAState::try_from_slice(&ca_account.data.borrow())?;
    require_pda(ca_account, authority.key, program_id, Some(state.bump))?;

    // --- Compute + verify ---
    let next_cells = state.compute_next();

    state.verify_transition(next_cells).map_err(|_| {
        msg!("Verification failed");
        ProgramError::from(Rule110Error::VerificationFailed)
    })?;

    // --- Commit ---
    state.cells = next_cells;
    state.generation += 1;

    state.serialize(&mut &mut ca_account.data.borrow_mut()[..])?;

    msg!(
        "Evolved to gen {}: cells={:#018x}",
        state.generation,
        state.cells
    );
    Ok(())
}

// ---------------------------------------------------------------------------

pub fn process_evolve_n(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    generations: u16,
) -> ProgramResult {
    if generations < 1 {
        return Err(Rule110Error::InvalidGenerations.into());
    }

    let account_iter = &mut accounts.iter();
    let ca_account = next_account_info(account_iter)?;
    let authority = next_account_info(account_iter)?;

    require_signer(authority)?;
    require_owner(ca_account, program_id)?;

    let mut state = CAState::try_from_slice(&ca_account.data.borrow())?;
    require_pda(ca_account, authority.key, program_id, Some(state.bump))?;

    for _ in 0..generations {
        let next_cells = state.compute_next();

        state
            .verify_transition(next_cells)
            .map_err(|_| ProgramError::from(Rule110Error::VerificationFailed))?;

        state.cells = next_cells;
        state.generation += 1;
    }

    state.serialize(&mut &mut ca_account.data.borrow_mut()[..])?;

    msg!(
        "Evolved {} generations; now at gen {}",
        generations,
        state.generation
    );
    Ok(())
}

// ---------------------------------------------------------------------------

pub fn process_reset(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    initial_cells: u64,
    left_boundary: u8,
    right_boundary: u8,
) -> ProgramResult {
    if left_boundary > 1 || right_boundary > 1 {
        return Err(Rule110Error::InvalidBoundary.into());
    }

    let account_iter = &mut accounts.iter();
    let ca_account = next_account_info(account_iter)?;
    let authority = next_account_info(account_iter)?;

    require_signer(authority)?;
    require_owner(ca_account, program_id)?;

    let mut state = CAState::try_from_slice(&ca_account.data.borrow())?;
    require_pda(ca_account, authority.key, program_id, Some(state.bump))?;

    let mask = if state.width == 64 {
        u64::MAX
    } else {
        (1u64 << state.width) - 1
    };
    state.cells = initial_cells & mask;
    state.left_boundary = left_boundary;
    state.right_boundary = right_boundary;
    state.generation = 0;

    state.serialize(&mut &mut ca_account.data.borrow_mut()[..])?;

    msg!("Reset to cells={:#018x}", state.cells);
    Ok(())
}
