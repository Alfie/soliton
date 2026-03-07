port module Ports exposing (..)

{-
   Ports.elm — Elm side of the Solana Kit JS interop bridge

   Convention:
     - toJs  : Elm → JS commands  (outgoing)
     - fromJs : JS → Elm messages (incoming)

   Flow:
     1. User clicks "Connect Wallet"  → connectWallet
     2. JS resolves wallet            → walletConnected
     3. User clicks "Initialize"      → sendInitialize
     4. User clicks "Delegate"        → sendDelegate  (opens ER session)
     5. User clicks "Evolve"          → sendEvolveER  (hits ER RPC, fast)
     6. WS account change fires       → accountUpdated (new row of cells)
     7. User clicks "End Session"     → sendUndelegate (commits + settles)

   Legacy:
     sendEvolve still exists for base-layer evolve (pre-delegation fallback)
-}


-- =========================================================
-- Outgoing (Elm → JS)
-- =========================================================

{- Request wallet connection via browser wallet adapter -}
port connectWallet : () -> Cmd msg

{- Send the Rule 110 initialize instruction on-chain. -}
port sendInitialize : () -> Cmd msg

{- Send the Rule 110 evolve instruction on base layer (legacy / fallback). -}
port sendEvolve : String -> Cmd msg

{- Delegate the CA state PDA to the ER — opens a real-time session. -}
port sendDelegate : () -> Cmd msg

{- Send an evolve instruction to the Ephemeral Rollup (fast path). -}
port sendEvolveER : () -> Cmd msg

{- Commit and undelegate — settles final ER state back to base layer. -}
port sendUndelegate : () -> Cmd msg

{- Subscribe to account change notifications over WebSocket.
   Payload: base58 public key to watch. -}
port subscribeToAccount : String -> Cmd msg

{- Unsubscribe from account notifications (e.g. on page leave) -}
port unsubscribeFromAccount : String -> Cmd msg


-- =========================================================
-- Incoming (JS → Elm)
-- =========================================================

{- Wallet connected successfully.
   Payload: base58 public key of the connected wallet. -}
port walletConnected : (String -> msg) -> Sub msg

{- Wallet connection failed or rejected.
   Payload: error message string. -}
port walletError : (String -> msg) -> Sub msg

{- Transaction confirmed on-chain.
   Payload: transaction signature (base58). -}
port txConfirmed : (String -> msg) -> Sub msg

{- Transaction failed.
   Payload: error message string. -}
port txFailed : (String -> msg) -> Sub msg

{- Account data changed — a new generation is available.
   Payload: list of bools representing the new cell row.
   JS decodes the raw account bytes before sending. -}
port accountUpdated : (List Bool -> msg) -> Sub msg

{- Session state changed — JS notifies Elm whether a delegation session
   is currently active. Payload: true = delegated, false = undelegated. -}
port sessionStateChanged : (Bool -> msg) -> Sub msg
