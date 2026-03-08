# Rule 110 — on-chain

A formally verified cellular automaton running on Solana, with real-time ephemeral rollup sessions and an Elm frontend.

Each cell transition is deterministically computed on-chain. The state space is tiled across multiple accounts with live boundary exchange. The spacetime diagram renders in the browser as generations accumulate.

---

## Stack

| Layer | Technology |
|---|---|
| On-chain program | Rust + Anchor (Solana) |
| Formal verification | Isabelle/HOL |
| Ephemeral rollups | MagicBlock ER SDK |
| Frontend | Elm 0.19.1 |
| Wallet / RPC | @solana/web3.js + Phantom |
| Build tool | Vite + vite-plugin-elm |

---

## Project Structure

```
rule110-frontend/
├── elm.json
├── index.html
├── package.json
├── vite.config.js
└── src/
    ├── main.js               # entry point — mounts Elm, inits bridge, wires canvas
    ├── style.css             # terminal/phosphor aesthetic
    ├── canvas.js             # spacetime diagram rendering
    ├── solana-bridge.js      # wallet, transactions, WS subscriptions, ER routing
    └── elm/
        ├── Main.elm          # TEA loop — model, update, view
        └── Ports.elm         # Elm ↔ JS port definitions

scripts/
    ├── initialize-tile.ts    # initialize a tile PDA on-chain
    ├── wire-neighbors.ts     # link tile right/left neighbor pubkeys
    ├── catchup-tile.ts       # advance a tile N generations to resync
    ├── check-tiles.ts        # inspect live on-chain state of both tiles
    ├── close-tile.ts         # close a tile account by tile_id
    ├── close-by-address.ts   # close any account by explicit address
    └── force-undelegate.ts   # escape hatch for stuck ER sessions

theory_Rule110_thy.txt        # Isabelle/HOL formal proof
```

---

## Deployed Program

| | |
|---|---|
| **Program ID** | `CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ` |
| **Network** | Solana Devnet |
| **Tile 0 PDA** | `2KecrG5zbFAPcxy9YU6EDz2AUHAtFB4kAuThVUTxuAA4` |
| **Tile 1 PDA** | `dBhSsk6EhC94ZQT6C1z4Yid7VF21AA35hXd2vCcf1VL` |

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Elm](https://guide.elm-lang.org/install/elm.html) 0.19.1
- [Phantom Wallet](https://phantom.app/) browser extension (devnet)

```bash
npm install -g elm
```

---

## Getting Started

**1. Install dependencies**
```bash
npm install
```

**2. Configure deployment values**

In `src/solana-bridge.js`:
```js
const RPC_URL    = 'https://api.devnet.solana.com'
const WS_URL     = 'wss://api.devnet.solana.com'
const PROGRAM_ID = address('CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ')
const TILE_1_PDA = 'dBhSsk6EhC94ZQT6C1z4Yid7VF21AA35hXd2vCcf1VL'
```

In `src/elm/Main.elm`:
```elm
stateAccount : String
stateAccount =
    "2KecrG5zbFAPcxy9YU6EDz2AUHAtFB4kAuThVUTxuAA4"
```

**3. Start the dev server**
```bash
npm run dev
```

App runs at `http://localhost:3000`

**4. Build for production**
```bash
npm run build
```

Output lands in `dist/` — serve statically.

---

## How It Works

```
User clicks Evolve
  → Elm sends port message to JS
    → solana-bridge.js builds transaction with both tile instructions
      → both tiles evolve atomically in one transaction
        → boundary cells are exchanged between tiles on-chain
          → WS notifications fire for both accounts
            → JS decodes account bytes, reads 64-entry history ring buffer
              → tryMerge waits for both tiles at matching generation
                → merged 128-cell row sent to Elm via port
                  → canvas.js appends row to spacetime diagram
```

The Elm update loop never touches Solana directly. All side effects are isolated to the JS bridge. Elm owns UI state, JS owns network effects.

---

## Tiled Architecture

The world is divided into 64-cell tiles, each stored as its own PDA. Tiles are linked by storing neighbor pubkeys in account state:

```
Tile 0                          Tile 1
[right_neighbor → Tile 1]  ←→  [left_neighbor → Tile 0]
```

On each evolution step, each tile reads one boundary cell from its neighbor's account via `remaining_accounts`. This allows the CA wavefront to propagate correctly across tile boundaries without any off-chain coordination.

**Account layout (736 bytes, Borsh):**

| Offset | Field | Size |
|--------|-------|------|
| 0 | Anchor discriminator | 8 |
| 8 | tile_id | 1 |
| 9 | width | 1 |
| 10 | cells (packed u64) | 8 |
| 18 | left_boundary | 1 |
| 19 | right_boundary | 1 |
| 20 | generation | 8 |
| 28 | bump | 1 |
| 29 | left_neighbor (Option\<Pubkey\>) | 33 |
| 62 | right_neighbor (Option\<Pubkey\>) | 33 |
| 95 | history_head | 1 |
| 96 | history [64 × HistoryEntry] | 640 |

---

## Ephemeral Rollup Sessions

Tile 0 can be delegated to a MagicBlock Ephemeral Rollup for real-time evolution at sub-second speeds, without paying base-layer transaction fees for every step.

```
Delegate (base layer tx)
  → tile 0 account owned by delegation program
    → ER session active
      → sendEvolveER sends tx to Magic Router
        → ER validator executes + notifies
          → tile 1 stays on base layer, provides boundary read-only
            → Undelegate (ER tx via Magic Router)
              → state committed back to devnet
```

The ER path uses `evolve_er` which skips `verify_transition` (Vec allocs exceed the ER heap). Correctness is guaranteed by the Isabelle proof — the runtime check is redundant.

---

## Formal Verification

The transition logic is formally verified in Isabelle/HOL. The proof covers three layers:

1. **rule110_lookup** — all 8 cases of the lookup table verified by evaluation
2. **next_gen** — single-step evolution with boundary conditions
3. **verify_step** — soundness of the cell-level verifier

**Central theorems:**

```
verify_step_sound:
  verify_step cs ns ⟹ ns = next_gen cs

verify_step_complete:
  verify_step cfg (next_gen cfg)

all_zeros_fixed_point:
  cells = replicate n False ∧ boundaries = False ⟹ next_gen cfg = replicate n False

solana_evolve_correct:
  verify_step cfg ns ⟹ ns = cells (step cfg)
```

See `theory_Rule110_thy.txt` for the full proof.

---

## Utility Scripts

```bash
# Inspect both tiles
ts-node scripts/check-tiles.ts

# Resync generation gap (e.g. after ER session divergence)
ts-node scripts/catchup-tile.ts 1 5   # advance tile 1 by 5 generations

# Re-wire neighbor links
ts-node scripts/wire-neighbors.ts

# Force undelegate if session is stuck
ts-node scripts/force-undelegate.ts

# Re-initialize a tile
ts-node scripts/initialize-tile.ts 0
```

---

## Known Limitations

- ER canvas updates require polling during session (WS router does not push delegated account notifications)
- `evolve_n_er` batch evolution on ER is limited by compute budget
- Only tile 0 participates in ER sessions; multi-tile ER co-delegation is a future feature

---

## Roadmap

- [x] Rule 110 PoC — dual-tile CA running against devnet with ER sessions
- [ ] ER canvas live updates via polling
- [ ] Multi-tile ER co-delegation
- [ ] Multiplayer shared world roguelike (working title)
- [ ] MagicBlock ephemeral rollups for real-time multiplayer sessions
- [ ] Open source workflow toolkit for on-chain game developers

---

## License

MIT
