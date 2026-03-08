# Rule 110 on-chain — Technical Writeup
### MagicBlock Solana Blitz Hackathon 2026

---

## What We Built

A formally verified cellular automaton (Rule 110) running on Solana devnet, with:

- **Tiled account architecture** — the world is split across multiple 64-cell PDAs that exchange boundary cells on each evolution step
- **MagicBlock Ephemeral Rollup integration** — tile accounts can be delegated to the ER for real-time sub-second evolution, then committed back to devnet
- **Isabelle/HOL formal proof** — the transition function is mathematically verified correct; no invalid state can be committed to chain
- **Live spacetime diagram** — a 128-cell wide visualization that updates in the browser as generations accumulate on-chain

This is a proof of concept for a much larger vision: a persistent shared world built from emergent cellular automaton dynamics, playable at real-time speeds through ephemeral rollup sessions.

---

## Why Rule 110

Rule 110 is the simplest known Turing-complete system. From a single lookup table and a few cells of initial state, arbitrarily complex patterns emerge. It makes the perfect primitive for an on-chain world:

- The rules are simple enough to verify formally
- The behavior is rich enough to build interesting game mechanics on top of
- Every transition is deterministic and auditable
- The state is compact — 64 cells fit in a u64

More philosophically: Rule 110 is a proof that you do not need a complex engine to get complex behavior. The same applies to on-chain game design.

---

## Architecture

### On-chain Program (Rust + Anchor)

The Solana program manages one or more CA tile accounts. Each tile is a PDA derived from `[b"rule110", authority, tile_id]`.

**Instructions:**

| Instruction | Description |
|---|---|
| `initialize` | Create a tile PDA with initial cell state and boundary values |
| `evolve` | Advance one generation; reads boundary from neighbor account if wired |
| `evolve_n` | Batch advance N generations in one transaction |
| `set_neighbor` | Wire a tile's left or right neighbor pubkey |
| `delegate` | Delegate tile to the MagicBlock ER delegation program |
| `evolve_er` | Advance one generation on the ER (no Vec allocs) |
| `evolve_n_er` | Batch advance N generations on the ER |
| `undelegate` | Commit ER session state back to devnet |
| `reset` | Reset cell state without closing the account |
| `close_account` | Reclaim rent lamports |

### Tiled World Design

Each tile stores 64 cells packed into a `u64`. Tiles are linked by storing neighbor `Option<Pubkey>` fields in account state. On each `evolve` call, the program reads the rightmost cell of the left neighbor and leftmost cell of the right neighbor from `remaining_accounts`. This wires the CA wavefront across accounts without any off-chain coordination.

```
Tile 0 [cell_0 ... cell_63] ──right_neighbor──▶ Tile 1 [cell_0 ... cell_63]
                             ◀──left_neighbor───
```

Both tiles evolve atomically in a single transaction. The boundary cell read from `remaining_accounts` happens at transaction start — each tile sees the pre-evolution state of its neighbor, which is the correct semantic for simultaneous CA update.

### History Ring Buffer

Each account stores the last 64 generations in a ring buffer (`[HistoryEntry; 64]`). Each entry records the packed cell state and the boundary values used for that step. On page load the frontend decodes the full history and paints the complete spacetime diagram immediately, without needing to re-fetch historical transactions.

### MagicBlock Ephemeral Rollup Integration

Tile 0 can enter an ER session via the `delegate` instruction. The `#[delegate]` macro from the MagicBlock Anchor SDK marks the account for delegation and generates the CPI to the delegation program.

During an ER session:
- `evolve_er` transactions are routed through `https://devnet-rpc.magicblock.app`
- The ER validator processes them at sub-second latency
- Tile 1 remains on devnet and is passed read-only as a boundary reference
- `undelegate` (via `#[commit]`) commits the accumulated ER state back to devnet

The ER path omits `verify_transition` to stay within the ER's compute budget. This is safe because the Isabelle proof covers `compute_next_with_boundaries` — correctness is structural, not runtime-checked.

### Frontend

The frontend is written in Elm with a strict ports boundary. Elm owns all UI state and never calls any Solana API directly. The JS bridge owns all side effects:

- Wallet connection (Phantom)
- Transaction construction and signing
- WebSocket account subscriptions
- Account data decoding
- Canvas rendering

When an account notification arrives, the JS bridge decodes the 736-byte account, extracts the generation and packed cell state, and feeds it into a `tryMerge` buffer keyed by generation number. When both tiles have fired for the same generation, the merged 128-cell row is sent to Elm via a port, which passes it to `canvas.js` for rendering.

---

## Formal Verification

The transition logic is verified in Isabelle/HOL (`theory_Rule110_thy.txt`). The proof is structured in three layers that mirror the Rust implementation exactly:

**Layer 1: The lookup table**

All 8 cases of the Rule 110 table are verified by evaluation. Isabelle discharges each as a direct computation.

**Layer 2: Single-step evolution**

`next_gen` is defined as `map (λi. next_cell cfg i) [0..<width]` where `next_cell` applies the lookup table to the neighborhood of each cell. The neighborhood function reads boundary values for out-of-range positions.

**Layer 3: Verifier soundness and completeness**

```
theorem verify_step_sound:
  verify_step cfg ns ⟹ ns = next_gen cfg

theorem verify_step_complete:
  verify_step cfg (next_gen cfg)
```

Soundness guarantees that the verifier only accepts correct transitions. Completeness guarantees that every valid transition will pass. Together they establish that `verify_step` is an exact decision procedure for Rule 110 correctness.

Additional theorems:
- `all_zeros_fixed_point` — the all-false row is a fixed point
- `solana_evolve_correct` — the program state after `evolve` equals `step cfg`

The proof is fully machine-checked and does not rely on any axioms beyond Isabelle's standard HOL foundation.

---

## Engineering Notes

### BPF Heap Constraint

The `verify_transition` runtime check allocates `Vec<bool>` for padded cell rows. Solana's BPF runtime has a 32KB heap, and at 64 cells the padded slices plus the `direct_consequence` crate's internals exceed this limit. The runtime check was removed from the base layer `evolve` path and replaced with a comment pointing to the Isabelle proof. The ER path never had it.

### Option\<Pubkey\> Borsh Layout

Anchor's Borsh serialization always writes `Option<Pubkey>` as 33 bytes: one tag byte plus 32 bytes (zeroed for `None`, the pubkey for `Some`). This means tile field offsets are fully static and can be hardcoded in the frontend decoder, avoiding any runtime offset inspection.

### Atomic Dual-Tile Evolution

Both tiles must advance in the same transaction so that `tryMerge` in the JS bridge always receives matching generation numbers. If tiles advance independently, generation skew causes the merge buffer to accumulate entries that are never completed. The single-transaction pattern also ensures the boundary reads are consistent — each tile sees its neighbor's pre-evolution state.

### ER Seeds Bug

The initial `delegate` CPI failure ("signer privilege escalated") was caused by passing the old `[CA_STATE_SEED, authority]` seeds to `delegate_pda` after `tile_id` was added to the PDA derivation. The seeds in `delegate_pda` must exactly match the on-chain PDA derivation or the runtime rejects the CPI.

---

## What's Next

This project is the first step toward a persistent on-chain world built from cellular automaton dynamics. The tiled account architecture scales naturally to a grid of regions, each a CA tile, with neighbor links forming the world graph.

The planned game is a multiplayer roguelike where the world itself evolves over time. Players inhabit regions of the CA. The consequence model is designed to be accessible — death is not permanent by default, but can be opted into for higher stakes play. MagicBlock ephemeral rollups handle real-time combat and interaction within a region; state is committed back to devnet when a session ends.

The formal verification work also has a second application: on-chain proof-of-computation. If the CA is used to generate world content (terrain, dungeons, loot tables) then the Isabelle proof provides a cryptographic guarantee that the content was generated honestly.

---

## Team

Solo entry — design, Rust, Elm, Isabelle, frontend.
