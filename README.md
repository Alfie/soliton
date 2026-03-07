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

**2. Configure your deployment values**

> 🔴 **The app will not load until real values are provided for `PROGRAM_ID` and `stateAccount`.**
> Kit validates addresses immediately on import — placeholders will throw on startup.


In `src/solana-bridge.js`:
```js
const RPC_URL    = 'https://api.devnet.solana.com'
const WS_URL     = 'wss://api.devnet.solana.com'
const PROGRAM_ID = address('EV2MYGcPYsSqRQzfAXLRiEnfpQHDDGfsxkkQk5NCJoJA')
```

In `src/elm/Main.elm`:
```elm
stateAccount : String
stateAccount =
    "YOUR_STATE_ACCOUNT_ADDRESS_HERE"
```

In `src/solana-bridge.js`, match your on-chain account layout:
```js
const HEADER_BYTES = 8    -- bytes to skip before cell data
const CELL_WIDTH   = 64   -- number of cells per row
```

Also fill in the instruction discriminator bytes for your `evolve` instruction.

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
    → solana-bridge.js builds + signs transaction via @solana/kit
      → transaction lands on-chain
        → Solana program verifies Rule 110 transition
          → account state updates
            → WS notification fires
              → JS decodes account bytes → List Bool
                → Elm port receives new row
                  → canvas.js appends row to spacetime diagram
```

The Elm update loop never touches Solana directly — all side effects
are isolated to the JS bridge. Elm owns state, JS owns effects.

---

## Formal Verification

The on-chain transition logic is formally verified in Isabelle/HOL.
The central theorem:

```
verify_step_sound:
  verify_step cs ns ⟹ ns = next_gen cs
```

The verifier only accepts transitions that are correct Rule 110 steps.
No invalid transition can be committed to chain.

See `theory_Rule110_thy.txt` for the full proof.

---

## Current Status

### ✓ Working
- Program deployed to devnet (`EV2MYGcPYsSqRQzfAXLRiEnfpQHDDGfsxkkQk5NCJoJA`)
- CA state account initialized on-chain via `scripts/initialize.js`
- Wallet connect + PDA derivation (Phantom + CLI keypair import)
- WebSocket account subscription
- Transaction signing flow (Kit v2 + Phantom workaround)
- Evolve transaction reaches the program and executes

### 🔧 Known Issues
- **Evolve exceeds compute budget** — default 200,000 CU limit is insufficient.
  Fix: add `ComputeBudgetProgram.setComputeUnitLimit` instruction to the transaction.
- **Frontend Initialize** — blocked by Kit account ordering issue with CPI accounts.
  Workaround: one-time initialization via `scripts/initialize.js`.

---

## Roadmap

- [ ] Rule 110 PoC — frontend running against devnet
- [ ] Multiplayer shared world roguelike (working title)
- [ ] MagicBlock ephemeral rollups for real-time sessions
- [ ] Softer consequence model for broader audience
- [ ] Open source workflow toolkit for on-chain game developers

---

## License

MIT
