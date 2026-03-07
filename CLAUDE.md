# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A formally verified cellular automaton (Rule 110) running on Solana with MagicBlock ephemeral rollup (ER) support and an Elm frontend. The on-chain transition logic is verified in Isabelle/HOL via the `direct-consequence` crate, which bridges the formal proof to Rust runtime checks.

Deployed program: `CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ` (devnet)

## Commands

### On-chain program (Rust/Anchor)

```bash
# Build
anchor build

# Run all integration tests (uses solana-program-test, no validator needed)
cargo test

# Run a single test by name
cargo test test_initialize
cargo test test_evolve_one_generation

# Check without building
cargo check

# Lint
cargo clippy
```

### Frontend (Elm + Vite, run from `rule110-frontend/`)

```bash
cd rule110-frontend
npm install
npm run dev      # dev server at http://localhost:3000
npm run build    # production build → dist/
npm run preview  # preview production build
```

## Architecture

### On-chain program (`src/`)

The program uses Anchor 0.32.1 with the `#[ephemeral]` macro from `ephemeral-rollups-sdk` to support MagicBlock ER sessions.

- **`lib.rs`** — Anchor program entry point. Defines all instructions and account contexts:
  - `initialize` / `reset` — base layer only; authority-gated
  - `delegate` — delegates PDA to the ER delegation program, opening a real-time session
  - `evolve` / `evolve_n` — intended for ER; permissionless (any wallet), calls `commit_accounts` after each step
  - `undelegate` — settles ER state back to devnet via `commit_and_undelegate_accounts`

- **`state.rs`** — `CAState` account (28 bytes: 8 discriminator + fields). Contains `compute_next()` (pure Rule 110 step) and `verify_transition()` which calls `direct_consequence::verify_step` to enforce the Isabelle proof.

- **`processor.rs`** — Raw (non-Anchor) processor with the same handlers. Used by the integration test harness via `solana-program-test`.

- **`instruction.rs`** — Borsh-serialized `Rule110Instruction` enum for the raw processor path.

- **`error.rs`** — Anchor error codes.

**Note:** `lib.rs` (Anchor) and `processor.rs` (raw) are two parallel implementations. The integration tests in `tests/integration.rs` use the raw processor path.

### PDA

Seeds: `[b"rule110", authority_pubkey]`. Derived identically on-chain and client-side.

### State layout

```
CAState (28 bytes total):
  bytes 0–7:   Anchor discriminator
  byte  8:     width (u8, 1–64)
  bytes 9–16:  cells (u64, packed bitfield, LSB = cell 0)
  byte  17:    left_boundary (u8, 0 or 1)
  byte  18:    right_boundary (u8, 0 or 1)
  bytes 19–26: generation (u64, monotonic)
  byte  27:    bump (u8)
```

### Compute budget

Rule 110 verification consumes ~430K CUs. All evolve transactions must prepend `ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })` (or higher).

### Frontend (`rule110-frontend/`)

Architecture: Elm TEA loop owns all UI state. JS owns all Solana effects. They communicate via Elm ports.

- **`src/elm/Main.elm`** — TEA model/update/view
- **`src/elm/Ports.elm`** — Port definitions (Elm ↔ JS boundary)
- **`src/solana-bridge.js`** — All Solana interactions: wallet connect, transaction building, WS subscriptions, session management
- **`src/main.js`** — Entry point; mounts Elm, inits bridge, wires canvas
- **`src/canvas.js`** — Spacetime diagram rendering (appends rows as generations arrive)

**Transaction building:** Uses `@solana/web3.js` v1 for transaction construction (not Kit v2), because Kit v2's `compileTransaction` reorders accounts in ways that break PDA signer verification. Kit is still used for RPC WebSocket subscriptions.

**Session model:**
1. `sendDelegate` → base layer tx, hands PDA to delegation program, switches WS to ER endpoint
2. `sendEvolveER` → ER tx, fast-path evolution (no authority check)
3. `sendUndelegate` → ER tx, commits + settles back to devnet, switches WS back to base layer

### External dependency: `direct-consequence`

Local path dependency at `../../direct-consequence-checker`. This crate bridges the Isabelle/HOL formal proof to Rust. `verify_step(&current_padded, &next_padded)` returns `true` iff the transition is a valid Rule 110 step.

## Key Constants

| Constant | Value |
|---|---|
| Program ID (devnet) | `CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ` |
| CA state seed | `b"rule110"` |
| Rule 110 bitmask | `0x6E` (= `0b_0110_1110`) |
| ER RPC | `https://devnet-us.magicblock.app` |
| Delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Magic program | `Magic11111111111111111111111111111111111111` |
