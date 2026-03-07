module Main exposing (main)

{-
   Main.elm — Rule 110 on-chain demo

   Architecture:
     - Model holds wallet state, tx state, session state, and the growing grid of cell rows
     - Update handles port messages and user interactions
     - View renders wallet controls + triggers canvas rendering via port
     - Canvas drawing is handled on the JS side (see solana-bridge.js)

   Spacetime diagram:
     - Each confirmed on-chain step appends a new row to `generations`
     - Rows are List Bool, oldest at head, newest at tail
     - JS renders the full grid to canvas whenever `generations` changes

   Session model:
     - Delegated = False  → base layer, user can Initialize or Delegate
     - Delegated = True   → ER session active, any wallet can Evolve ER or End Session
-}

import Browser
import Html exposing (Html, button, div, p, span, text)
import Html.Attributes exposing (class, disabled)
import Html.Events exposing (onClick)
import Ports


-- ================================================================
-- Main
-- ================================================================

main : Program () Model Msg
main =
    Browser.element
        { init          = init
        , update        = update
        , subscriptions = subscriptions
        , view          = view
        }


-- ================================================================
-- Constants
-- ================================================================

{- Base58 address of the on-chain game state account. -}
stateAccount : String
stateAccount =
    "Hy3kXRXV8SnJE5kUfu9VArGAX2Tobk9McH8WfEVQfB8n"

{- Maximum number of generations to keep in memory.
   Older rows are dropped to avoid unbounded growth. -}
maxGenerations : Int
maxGenerations =
    200


-- ================================================================
-- Model
-- ================================================================

type WalletState
    = Disconnected
    | Connecting
    | Connected String   -- holds the wallet's public key


type TxState
    = Idle
    | Initializing       -- Initialize tx submitted
    | Delegating         -- Delegate tx submitted
    | Pending            -- Evolve tx submitted, awaiting confirmation
    | Undelegating       -- Undelegate tx submitted
    | Confirmed String   -- holds the tx signature
    | Failed String      -- holds the error message


type alias Model =
    { wallet      : WalletState
    , tx          : TxState
    , generations : List (List Bool)  -- spacetime diagram rows, oldest first
    , subscribed  : Bool
    , delegated   : Bool              -- True when an ER session is active
    }


init : () -> ( Model, Cmd Msg )
init _ =
    ( { wallet      = Disconnected
      , tx          = Idle
      , generations = []
      , subscribed  = False
      , delegated   = False
      }
    , Cmd.none
    )


-- ================================================================
-- Msg
-- ================================================================

type Msg
    -- User actions
    = UserClickedConnect
    | UserClickedInitialize
    | UserClickedEvolve
    | UserClickedDelegate
    | UserClickedEvolveER
    | UserClickedUndelegate

    -- Wallet port responses
    | WalletConnected String
    | WalletError String

    -- Transaction port responses
    | TxConfirmed String
    | TxFailed String

    -- Account subscription
    | AccountUpdated (List Bool)

    -- Session state from JS
    | SessionStateChanged Bool


-- ================================================================
-- Update
-- ================================================================

update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of

        -- --------------------------------------------------------
        -- User clicks "Connect Wallet"
        -- --------------------------------------------------------
        UserClickedConnect ->
            ( { model | wallet = Connecting }
            , Ports.connectWallet ()
            )

        -- --------------------------------------------------------
        -- User clicks "Initialize" — create the on-chain account
        -- --------------------------------------------------------
        UserClickedInitialize ->
            case model.wallet of
                Connected _ ->
                    ( { model | tx = Initializing }
                    , Ports.sendInitialize ()
                    )

                _ ->
                    ( model, Cmd.none )

        -- --------------------------------------------------------
        -- User clicks "Evolve" — base layer fallback
        -- --------------------------------------------------------
        UserClickedEvolve ->
            case model.wallet of
                Connected _ ->
                    ( { model | tx = Pending }
                    , Ports.sendEvolve stateAccount
                    )

                _ ->
                    ( model, Cmd.none )

        -- --------------------------------------------------------
        -- User clicks "Delegate" — open an ER session
        -- --------------------------------------------------------
        UserClickedDelegate ->
            case model.wallet of
                Connected _ ->
                    ( { model | tx = Delegating }
                    , Ports.sendDelegate ()
                    )

                _ ->
                    ( model, Cmd.none )

        -- --------------------------------------------------------
        -- User clicks "Evolve ER" — fast path via Ephemeral Rollup
        -- --------------------------------------------------------
        UserClickedEvolveER ->
            ( { model | tx = Pending }
            , Ports.sendEvolveER ()
            )

        -- --------------------------------------------------------
        -- User clicks "End Session" — commit + undelegate
        -- --------------------------------------------------------
        UserClickedUndelegate ->
            case model.wallet of
                Connected _ ->
                    ( { model | tx = Undelegating }
                    , Ports.sendUndelegate ()
                    )

                _ ->
                    ( model, Cmd.none )

        -- --------------------------------------------------------
        -- Wallet connected successfully
        -- --------------------------------------------------------
        WalletConnected pubkey ->
            let
                subCmd =
                    if model.subscribed then
                        Cmd.none
                    else
                        Ports.subscribeToAccount stateAccount
            in
            ( { model
                | wallet     = Connected pubkey
                , subscribed = True
              }
            , subCmd
            )

        -- --------------------------------------------------------
        -- Wallet connection failed
        -- --------------------------------------------------------
        WalletError err ->
            ( { model | wallet = Disconnected, tx = Failed err }
            , Cmd.none
            )

        -- --------------------------------------------------------
        -- Transaction confirmed — clear pending state
        -- The new row will arrive via AccountUpdated
        -- --------------------------------------------------------
        TxConfirmed sig ->
            ( { model | tx = Confirmed sig }
            , Cmd.none
            )

        -- --------------------------------------------------------
        -- Transaction failed
        -- --------------------------------------------------------
        TxFailed err ->
            ( { model | tx = Failed err }
            , Cmd.none
            )

        -- --------------------------------------------------------
        -- New generation received from WS account subscription
        -- Append to the spacetime diagram, capping at maxGenerations
        -- --------------------------------------------------------
        AccountUpdated row ->
            let
                newGenerations =
                    model.generations
                        ++ [ row ]
                        |> dropOldest

                newTx =
                    case model.tx of
                        Confirmed _ -> Idle
                        _           -> model.tx
            in
            ( { model
                | generations = newGenerations
                , tx          = newTx
              }
            , Cmd.none
            )

        -- --------------------------------------------------------
        -- JS notifies Elm that delegation session state changed
        -- --------------------------------------------------------
        SessionStateChanged isDelegated ->
            ( { model
                | delegated = isDelegated
                , tx        = Idle
              }
            , Cmd.none
            )


{- Drop rows from the front once we exceed maxGenerations -}
dropOldest : List (List Bool) -> List (List Bool)
dropOldest rows =
    let
        excess = List.length rows - maxGenerations
    in
    if excess > 0 then
        List.drop excess rows
    else
        rows


-- ================================================================
-- Subscriptions
-- ================================================================

subscriptions : Model -> Sub Msg
subscriptions _ =
    Sub.batch
        [ Ports.walletConnected    WalletConnected
        , Ports.walletError        WalletError
        , Ports.txConfirmed        TxConfirmed
        , Ports.txFailed           TxFailed
        , Ports.accountUpdated     AccountUpdated
        , Ports.sessionStateChanged SessionStateChanged
        ]


-- ================================================================
-- View
-- ================================================================

view : Model -> Html Msg
view model =
    div [ class "app" ]
        [ viewHeader
        , viewWalletPanel model
        , viewControls model
        , viewTxStatus model
        , viewCanvas
        ]


viewHeader : Html Msg
viewHeader =
    div [ class "header" ]
        [ p [] [ text "Rule 110 — on-chain cellular automaton" ] ]


viewWalletPanel : Model -> Html Msg
viewWalletPanel model =
    div [ class "wallet-panel" ]
        [ case model.wallet of
            Disconnected ->
                button [ onClick UserClickedConnect ]
                    [ text "Connect Wallet" ]

            Connecting ->
                button [ disabled True ]
                    [ text "Connecting…" ]

            Connected pubkey ->
                span [ class "pubkey" ]
                    [ text (abbreviate pubkey) ]
        ]


viewControls : Model -> Html Msg
viewControls model =
    let
        isConnected =
            case model.wallet of
                Connected _ -> True
                _           -> False

        isFree =
            case model.tx of
                Idle        -> True
                Confirmed _ -> True
                _           -> False

        canAct =
            isConnected && isFree
    in
    div [ class "controls" ]
        ( if model.delegated then
            -- ER session active — show ER evolve + end session
            [ button
                [ onClick UserClickedEvolveER
                , disabled (not isFree)
                , class "btn-evolve-er"
                ]
                [ text "Evolve ER ⚡" ]
            , button
                [ onClick UserClickedUndelegate
                , disabled (not canAct)
                , class "btn-end-session"
                ]
                [ text "End Session" ]
            , span [ class "session-badge" ]
                [ text "● ER session active" ]
            , span [ class "generation-count" ]
                [ text
                    ( String.fromInt (List.length model.generations)
                        ++ " generations"
                    )
                ]
            ]

          else
            -- Base layer — show initialize, evolve, delegate
            [ button
                [ onClick UserClickedInitialize
                , disabled (not canAct)
                ]
                [ text "Initialize" ]
            , button
                [ onClick UserClickedEvolve
                , disabled (not canAct)
                ]
                [ text "Evolve →" ]
            , button
                [ onClick UserClickedDelegate
                , disabled (not canAct)
                , class "btn-delegate"
                ]
                [ text "Delegate ER" ]
            , span [ class "generation-count" ]
                [ text
                    ( String.fromInt (List.length model.generations)
                        ++ " generations"
                    )
                ]
            ]
        )


viewTxStatus : Model -> Html Msg
viewTxStatus model =
    div [ class "tx-status" ]
        [ case model.tx of
            Idle ->
                text ""

            Initializing ->
                span [ class "pending" ] [ text "Initializing account…" ]

            Delegating ->
                span [ class "pending" ] [ text "Opening ER session…" ]

            Pending ->
                span [ class "pending" ] [ text "Transaction pending…" ]

            Undelegating ->
                span [ class "pending" ] [ text "Settling to base layer…" ]

            Confirmed sig ->
                span [ class "confirmed" ]
                    [ text ("✓ " ++ abbreviate sig) ]

            Failed err ->
                span [ class "failed" ]
                    [ text ("✗ " ++ err) ]
        ]


{- Canvas element wrapped for the scanline CSS overlay.
   JS draws the spacetime diagram into the inner canvas.
   The wrapper div provides the ::after scanline pseudo-element. -}
viewCanvas : Html Msg
viewCanvas =
    div [ class "canvas-wrapper" ]
        [ Html.node "canvas"
            [ Html.Attributes.id "rule110-canvas"
            , Html.Attributes.attribute "width" "640"
            , Html.Attributes.attribute "height" "640"
            ]
            []
        ]


-- ================================================================
-- Helpers
-- ================================================================

{- Shorten a long base58 string for display: "AbCd…XyZ1" -}
abbreviate : String -> String
abbreviate s =
    if String.length s <= 12 then
        s
    else
        String.left 4 s ++ "…" ++ String.right 4 s
