use borsh::BorshDeserialize;
use rule110_raw::{instruction::Rule110Instruction, processor::find_ca_state, state::CAState};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::{processor, ProgramTest};
use solana_sdk::{signature::Signer, transaction::Transaction};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn program_id() -> Pubkey {
    "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
        .parse()
        .unwrap()
}

/// Pack an array of 0/1 values into a u64 (LSB = index 0).
fn pack_cells(bits: &[u8]) -> u64 {
    bits.iter()
        .enumerate()
        .fold(0u64, |acc, (i, &b)| acc | ((b as u64) << i))
}

/// Unpack a u64 into a Vec<u8> of given width.
fn unpack_cells(packed: u64, width: u8) -> Vec<u8> {
    (0..width).map(|i| ((packed >> i) & 1) as u8).collect()
}

/// Apply Rule 110 lookup to a 3-bit neighborhood.
fn rule110(n: u8) -> u8 {
    (0x6E >> n) & 1
}

/// Compute the next generation off-chain for comparison.
fn next_gen(cells: &[u8], left: u8, right: u8) -> Vec<u8> {
    let w = cells.len();
    cells
        .iter()
        .enumerate()
        .map(|(i, &c)| {
            let l = if i == 0 { left } else { cells[i - 1] };
            let r = if i == w - 1 { right } else { cells[i + 1] };
            rule110((l << 2) | (c << 1) | r)
        })
        .collect()
}

/// Build a program test harness.
fn build_program_test() -> ProgramTest {
    ProgramTest::new(
        "rule110_raw",
        program_id(),
        processor!(rule110_raw::process_instruction),
    )
}

/// Build and serialize an instruction.
fn make_instruction(ix: &Rule110Instruction, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction {
        program_id: program_id(),
        accounts,
        data: borsh::to_vec(ix).unwrap(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_initialize() {
    let mut pt = build_program_test();
    let (mut banks, payer, recent_hash) = pt.start().await;

    let (ca_pda, _bump) = find_ca_state(&payer.pubkey(), &program_id());

    let width: u8 = 16;
    let initial_bits: Vec<u8> = {
        let mut v = vec![0u8; width as usize];
        v[8] = 1; // single cell set in the middle — mirrors Forth reference impl
        v
    };

    let ix = make_instruction(
        &Rule110Instruction::Initialize {
            width,
            initial_cells: pack_cells(&initial_bits),
            left_boundary: 0,
            right_boundary: 0,
        },
        vec![
            AccountMeta::new(ca_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
    );

    let tx =
        Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], recent_hash);
    banks.process_transaction(tx).await.unwrap();

    // Read back and verify.
    let account = banks.get_account(ca_pda).await.unwrap().unwrap();
    let state = CAState::try_from_slice(&account.data).unwrap();

    assert_eq!(state.width, width);
    assert_eq!(state.generation, 0);
    assert_eq!(unpack_cells(state.cells, width), initial_bits);
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_evolve_one_generation() {
    let mut pt = build_program_test();
    let (mut banks, payer, recent_hash) = pt.start().await;

    let (ca_pda, _) = find_ca_state(&payer.pubkey(), &program_id());

    let width: u8 = 16;
    let initial_bits: Vec<u8> = {
        let mut v = vec![0u8; width as usize];
        v[8] = 1;
        v
    };

    // Initialize.
    let init_ix = make_instruction(
        &Rule110Instruction::Initialize {
            width,
            initial_cells: pack_cells(&initial_bits),
            left_boundary: 0,
            right_boundary: 0,
        },
        vec![
            AccountMeta::new(ca_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
    );
    banks
        .process_transaction(Transaction::new_signed_with_payer(
            &[init_ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_hash,
        ))
        .await
        .unwrap();

    // Evolve one step.
    let recent_hash = banks.get_latest_blockhash().await.unwrap();
    let evolve_ix = make_instruction(
        &Rule110Instruction::Evolve,
        vec![
            AccountMeta::new(ca_pda, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    banks
        .process_transaction(Transaction::new_signed_with_payer(
            &[evolve_ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_hash,
        ))
        .await
        .unwrap();

    // Verify matches off-chain computation.
    let account = banks.get_account(ca_pda).await.unwrap().unwrap();
    let state = CAState::try_from_slice(&account.data).unwrap();
    let expected = next_gen(&initial_bits, 0, 0);

    assert_eq!(unpack_cells(state.cells, width), expected);
    assert_eq!(state.generation, 1);
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_evolve_n_matches_single_steps() {
    let mut pt = build_program_test();
    let (mut banks, payer, recent_hash) = pt.start().await;

    let (ca_pda, _) = find_ca_state(&payer.pubkey(), &program_id());

    let width: u8 = 16;
    let initial_bits: Vec<u8> = {
        let mut v = vec![0u8; width as usize];
        v[8] = 1;
        v
    };

    // Initialize.
    let init_ix = make_instruction(
        &Rule110Instruction::Initialize {
            width,
            initial_cells: pack_cells(&initial_bits),
            left_boundary: 0,
            right_boundary: 0,
        },
        vec![
            AccountMeta::new(ca_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
    );
    banks
        .process_transaction(Transaction::new_signed_with_payer(
            &[init_ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_hash,
        ))
        .await
        .unwrap();

    // Compute 20 generations off-chain.
    const STEPS: usize = 20;
    let mut expected = initial_bits.clone();
    for _ in 0..STEPS {
        expected = next_gen(&expected, 0, 0);
    }

    // Advance 20 generations on-chain in one call.
    let recent_hash = banks.get_latest_blockhash().await.unwrap();
    let evolve_n_ix = make_instruction(
        &Rule110Instruction::EvolveN {
            generations: STEPS as u16,
        },
        vec![
            AccountMeta::new(ca_pda, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    banks
        .process_transaction(Transaction::new_signed_with_payer(
            &[evolve_n_ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_hash,
        ))
        .await
        .unwrap();

    let account = banks.get_account(ca_pda).await.unwrap().unwrap();
    let state = CAState::try_from_slice(&account.data).unwrap();

    assert_eq!(unpack_cells(state.cells, width), expected);
    assert_eq!(state.generation, STEPS as u64);
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_all_zeros_is_fixed_point() {
    let mut pt = build_program_test();
    let (mut banks, payer, recent_hash) = pt.start().await;

    let (ca_pda, _) = find_ca_state(&payer.pubkey(), &program_id());

    let width: u8 = 16;
    let zero_bits = vec![0u8; width as usize];

    let init_ix = make_instruction(
        &Rule110Instruction::Initialize {
            width,
            initial_cells: 0,
            left_boundary: 0,
            right_boundary: 0,
        },
        vec![
            AccountMeta::new(ca_pda, false),
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
    );
    banks
        .process_transaction(Transaction::new_signed_with_payer(
            &[init_ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_hash,
        ))
        .await
        .unwrap();

    let recent_hash = banks.get_latest_blockhash().await.unwrap();
    let evolve_ix = make_instruction(
        &Rule110Instruction::Evolve,
        vec![
            AccountMeta::new(ca_pda, false),
            AccountMeta::new_readonly(payer.pubkey(), true),
        ],
    );
    banks
        .process_transaction(Transaction::new_signed_with_payer(
            &[evolve_ix],
            Some(&payer.pubkey()),
            &[&payer],
            recent_hash,
        ))
        .await
        .unwrap();

    let account = banks.get_account(ca_pda).await.unwrap().unwrap();
    let state = CAState::try_from_slice(&account.data).unwrap();

    // Rule 110 case 000 → 0, so all-zeros is a fixed point.
    assert_eq!(unpack_cells(state.cells, width), zero_bits);
}
