port module Ports exposing (..)

{-
   Ports.elm — Elm side of the Solana Kit JS interop bridge

   Convention:
     - outgoing : Elm → JS commands
     - incoming : JS → Elm messages

   Flow:
     1. User clicks "Connect Wallet"       → connectWallet
     2. JS resolves wallet + reads history → walletConnected, historyLoaded
     3. JS opens WS subscription           → accountUpdated (per generation)
     4. User clicks "Evolve"               → sendEvolve
     5. JS sends tx, waits confirm         → txConfirmed / txFailed
     6. User clicks "Delegate ER"          → sendDelegate
     7. User clicks "Evolve ER"            → sendEvolveER
     8. User clicks "End Session"          → sendUndelegate
     9. ER session state changes           → sessionStateChanged
-}


-- =========================================================
-- Outgoing (Elm → JS)
-- =========================================================

port connectWallet : () -> Cmd msg

port sendInitialize : () -> Cmd msg

port sendEvolve : String -> Cmd msg

port subscribeToAccount : String -> Cmd msg

port unsubscribeFromAccount : String -> Cmd msg

port sendDelegate : () -> Cmd msg

port sendEvolveER : () -> Cmd msg

port sendUndelegate : () -> Cmd msg

{- Set a neighbor link.
   Payload: { side : Int, neighbor : Maybe String }
   side 0 = left, side 1 = right
   neighbor = Nothing clears the link -}
port sendSetNeighbor : { side : Int, neighbor : Maybe String } -> Cmd msg


-- =========================================================
-- Incoming (JS → Elm)
-- =========================================================

port walletConnected : (String -> msg) -> Sub msg

port walletError : (String -> msg) -> Sub msg

port txConfirmed : (String -> msg) -> Sub msg

port txFailed : (String -> msg) -> Sub msg

{- A single new generation row, arriving live via WS. -}
port accountUpdated : (List Bool -> msg) -> Sub msg

{- Full history loaded on wallet connect.
   Payload: list of rows, oldest first, each row a List Bool.
   Use this to paint the spacetime diagram on initial load
   rather than waiting for the first WS notification. -}
port historyLoaded : (List (List Bool) -> msg) -> Sub msg

{- ER session state changed.
   True  = session active (account delegated to ER).
   False = session ended (account back on base layer). -}
port sessionStateChanged : (Bool -> msg) -> Sub msg
