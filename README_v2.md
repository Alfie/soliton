# Rule 110 — on-chain

A formally verified cellular automaton running on Solana, with an Elm frontend.

Each cell transition is verified on-chain against the Rule 110 lookup table.
The spacetime diagram is rendered in the browser as generations accumulate.

---

## Stack

| Layer | Technology |
|---|---|
| On-chain program | Rust (Solana) |
| Formal verification | Isabelle/HOL |
| Frontend | Elm 0.19.1 |
| Wallet / RPC | @solana/kit v2 |
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
    ├── main.js             # entry point — mounts Elm, inits bridge, wires canvas
    ├── style.css           # terminal/phosphor aesthetic
    ├── canvas.js           # spacetime diagram rendering
    ├── solana-bridge.js    # Solana Kit — wallet, transactions, WS subscriptions
    └── elm/
        ├── Main.elm        # TEA loop — model, update, view
        └── Ports.elm       # Elm ↔ JS port definitions
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Elm](https://guide.elm-lang.org/install/elm.html) 0.19.1

```bash
npm install -g elm
```

---

## Getting Started

**1. Install dependencies**
```bash
npm install
```

**2. Configure your deployment**

> 🔴 **The app will not load until a real value is provided for `PROGRAM_ID`.**
> Kit validates addresses immediately on import — placeholders will throw on startup.


In `src/solana-bridge.js`:
```js
const RPC_URL    = 'https://api.devnet.solana.com'
const WS_URL     = 'wss://api.devnet.solana.com'
const PROGRAM_ID = address('EV2MYGcPYsSqRQzfAXLRiEnfpQHDDGfsxkkQk5NCJoJA')
```

**Note:** The PDA is derived client-side from your connected wallet, so no hardcoded `stateAccount` address is needed.

**3. Fund your wallet**
```bash
solana airdrop 2 --url devnet
```

**4. Start the dev server**
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

### Data Flow
```
User clicks Initialize/Evolve
  ↓
Elm sends port message to JS
  ↓
solana-bridge.js builds transaction with @solana/web3.js v1
  ├─ ComputeBudgetProgram.setComputeUnitLimit(1M)
  └─ Initialize or Evolve instruction
  ↓
Phantom signs transaction
  ↓
Transaction lands on-chain
  ↓
Solana program (processor.rs) verifies Rule 110 transition
  ├─ compute_next() generates candidate state
  └─ verify_transition() checks against formal proof
  ↓
State updates on-chain (CAState serialized via Borsh)
  ↓
WebSocket fires account change notification
  ↓
solana-bridge.js decodes base64 → Uint8Array
  ↓
decodeRuleState extracts cells from packed u64
  ↓
Elm port receives List Bool
  ↓
main.js intercepts and calls canvas.js
  ↓
Spacetime diagram appends new row
```

### Key Components

**CAState (state.rs)**
```rust
pub struct CAState {
    width: u8,           // 1-64 cells
    cells: u64,          // packed bitfield, LSB = cell 0
    left_boundary: u8,   // 0 or 1
    right_boundary: u8,  // 0 or 1
    generation: u64,     // monotonic counter
    bump: u8,            // PDA bump seed
}
```
20 bytes total, serialized with Borsh (no Anchor discriminator).

**PDA Derivation**
```rust
seeds = [b"rule110", authority_pubkey]
```
Derived identically on-chain (Rust) and client-side (JS) so the frontend knows the account address without querying.

**Compute Budget**
Rule 110 verification consumes ~430K CUs. We request 1M (the per-transaction max) via `ComputeBudgetProgram.setComputeUnitLimit`.

**Base64 Decoding**
WebSocket returns account data as `[base64String, 'base64']`. We decode to `Uint8Array` before extracting cells from the packed bitfield.

The Elm update loop never touches Solana directly — all side effects
are isolated to the JS bridge. Elm owns state, JS owns effects.

---

## Technical Notes

### Challenges & Solutions

**Challenge: Kit v2 account ordering**
`@solana/kit`'s `compileTransaction` reorders accounts in ways that break PDA signer verification in CPI calls. The runtime error is `PrivilegeEscalation` or `ReadonlyDataModified`.

**Solution:** Bypass Kit for transaction building. Use `@solana/web3.js` v1's `Transaction` and `TransactionInstruction` for precise account ordering, then sign with Phantom and send via web3.js `Connection`. Kit is still used for RPC/WebSocket.

**Challenge: Compute budget exhaustion**
Rule 110 verification consumed ~430K CUs, exceeding the default 200K limit.

**Solution:** Prepend `ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })` to every transaction. The compute budget instruction must come first.

**Challenge: WebSocket data encoding**
Account notifications return `[base64String, 'base64']`, not raw bytes.

**Solution:** Extract the string from the array, decode with `atob()`, and convert to `Uint8Array` before parsing the packed bitfield.

**Challenge: BigInt serialization**
`JSON.stringify` can't serialize `BigInt` values, causing errors in simulation logs.

**Solution:** Use a custom replacer: `JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? v.toString() : v)`

### Why This Stack Works

**Isabelle/HOL + Rust**
The formal proof guarantees correctness at the specification level. The `direct-consequence` crate bridges the proof to runtime checks. This gives mathematical certainty that on-chain transitions are correct.

**Elm + Ports**
Elm's type system prevents entire classes of bugs. Ports create a clean boundary between pure Elm logic and effectful JS. The TEA pattern maps naturally onto on-chain state machines.

**PDA-based state**
Deriving the account address from `[b"rule110", authority_pubkey]` means no keyfile management and deterministic addressing. Anyone can compute the address from a wallet pubkey.

---

## Formal Verification

The on-chain transition logic is formally verified in Isabelle/HOL.
The central theorem:

```isabelle
verify_step_sound:
  verify_step cs ns ⟹ ns = next_gen cs
```

**What this guarantees:**
- The verifier (`verify_transition` in state.rs) only accepts transitions that are mathematically proven to be correct Rule 110 steps
- No invalid state can be committed to the chain, even if the compute logic has bugs
- The `direct-consequence` crate bridges the Isabelle proof to Rust runtime checks

**Proof structure (theory_Rule110_thy.txt):**
1. `rule110_lookup` — verified against the Rule 110 specification for all 8 neighborhoods
2. `next_gen` — pure function computing the next generation
3. `verify_step` — predicate checking if a transition is valid
4. `verify_step_sound` — theorem proving that accepted transitions are correct
5. `solana_evolve_correct` — connects the Rust implementation to the formal model

This approach scales to complex game rules — any deterministic state transition can be formally verified and enforced on-chain.

---

## Current Status

### ✅ Fully Working Demo
The complete stack is operational on devnet:
- Program: `EV2MYGcPYsSqRQzfAXLRiEnfpQHDDGfsxkkQk5NCJoJA`
- Formally verified state transitions (Isabelle/HOL)
- Wallet connect + PDA derivation
- Initialize creates on-chain account with triangle seed (`10000000`)
- Evolve executes verified Rule 110 transitions
- WebSocket streams state changes in real-time
- Canvas renders growing spacetime diagram

### Architecture Decisions

**Why web3.js v1 for transactions?**
`@solana/kit` v2's `compileTransaction` reorders accounts in ways that conflict with PDA signer verification in CPI calls. Using `@solana/web3.js` v1 for transaction building gives us precise control over account ordering while still using Kit for RPC/WebSocket.

**Why Elm?**
The TEA (The Elm Architecture) pattern maps perfectly onto on-chain state machines — pure functions, explicit state, no side effects in update logic. The type system prevents entire classes of bugs.

**Why formal verification?**
In multiplayer on-chain games, players will probe every edge case. Formal verification provides mathematical certainty that the rules are correct, which builds trust and prevents exploits.

---

## Roadmap

- [x] **Rule 110 PoC** — frontend running against devnet ✅
  - Formally verified state transitions
  - Real-time WebSocket updates
  - Canvas spacetime diagram rendering
- [ ] **Polish demo**
  - Visual refinements
  - Better error messaging
  - Performance optimization
- [ ] **Multiplayer shared world roguelike** (working title)
  - Turn-based game logic
  - Procedural dungeon generation
  - Player state + inventory system
  - Combat + alliance mechanics
- [ ] **MagicBlock ephemeral rollups** for real-time sessions
- [ ] **Softer consequence model** for broader audience
- [ ] **Open source workflow toolkit** for on-chain game developers
  - Isabelle ↔ Rust verification pipeline
  - Elm + Solana Kit template
  - Best practices documentation

---

## License

MIT
