module Main exposing (main)

{-
   Main.elm — Rule 110 on-chain cellular automaton

   Architecture:
     - Model holds wallet state, tx state, ER session state,
       and the growing spacetime diagram (list of cell rows)
     - Update handles port messages and user interactions
     - View branches on session state:
         base layer → Initialize / Evolve / Delegate ER
         ER session → Evolve ER ⚡ / End Session
     - Canvas drawing is handled on the JS side (canvas.js)

   Spacetime diagram:
     - On wallet connect, historyLoaded paints all stored rows at once
     - accountUpdated appends one row at a time as WS notifications arrive
     - Rows are List Bool, oldest at head, newest at tail
-}

import Browser
import Html exposing (Html, button, div, input, p, span, text)
import Html.Attributes exposing (class, disabled, placeholder, value)
import Html.Events exposing (onClick, onInput)
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

stateAccount : String
stateAccount =
    "YOUR_STATE_ACCOUNT_ADDRESS_HERE"

{- Maximum number of generations to keep in memory.
   Older rows are dropped to avoid unbounded growth.
   Set to 2× HISTORY_LEN so we always have room for a full
   on-chain history plus live rows accumulated in-session. -}
maxGenerations : Int
maxGenerations =
    200


-- ================================================================
-- Model
-- ================================================================

type WalletState
    = Disconnected
    | Connecting
    | Connected String


type TxState
    = Idle
    | Initializing
    | Pending
    | Delegating
    | Undelegating
    | Confirmed String
    | Failed String


type alias Model =
    { wallet        : WalletState
    , tx            : TxState
    , delegated     : Bool              -- True when account is in an ER session
    , generations   : List (List Bool)  -- spacetime diagram rows, oldest first
    , subscribed    : Bool
    , neighborInput : String            -- text field for set_neighbor address
    }


init : () -> ( Model, Cmd Msg )
init _ =
    ( { wallet        = Disconnected
      , tx            = Idle
      , delegated     = False
      , generations   = []
      , subscribed    = False
      , neighborInput = ""
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

    -- History loaded on connect
    | HistoryLoaded (List (List Bool))

    -- ER session state
    | SessionStateChanged Bool

    -- Neighbor wiring
    | NeighborInputChanged String
    | UserClickedSetNeighbor Int   -- 0 = left, 1 = right
    | UserClickedClearNeighbor Int


-- ================================================================
-- Update
-- ================================================================

update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of

        UserClickedConnect ->
            ( { model | wallet = Connecting }
            , Ports.connectWallet ()
            )

        UserClickedInitialize ->
            case model.wallet of
                Connected _ ->
                    ( { model | tx = Initializing }
                    , Ports.sendInitialize ()
                    )
                _ ->
                    ( model, Cmd.none )

        UserClickedEvolve ->
            case model.wallet of
                Connected _ ->
                    ( { model | tx = Pending }
                    , Ports.sendEvolve stateAccount
                    )
                _ ->
                    ( model, Cmd.none )

        UserClickedDelegate ->
            case model.wallet of
                Connected _ ->
                    ( { model | tx = Delegating }
                    , Ports.sendDelegate ()
                    )
                _ ->
                    ( model, Cmd.none )

        UserClickedEvolveER ->
            case model.wallet of
                Connected _ ->
                    ( { model | tx = Pending }
                    , Ports.sendEvolveER ()
                    )
                _ ->
                    ( model, Cmd.none )

        UserClickedUndelegate ->
            case model.wallet of
                Connected _ ->
                    ( { model | tx = Undelegating }
                    , Ports.sendUndelegate ()
                    )
                _ ->
                    ( model, Cmd.none )

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

        WalletError err ->
            ( { model | wallet = Disconnected, tx = Failed err }
            , Cmd.none
            )

        TxConfirmed sig ->
            ( { model | tx = Confirmed sig }
            , Cmd.none
            )

        TxFailed err ->
            ( { model | tx = Failed err }
            , Cmd.none
            )

        -- Single new row arriving via WS — append to diagram
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

        -- Full history arriving on wallet connect — replace diagram
        HistoryLoaded rows ->
            ( { model | generations = dropOldest rows }
            , Cmd.none
            )

        -- ER session state restored (e.g. after page refresh while delegated)
        -- or changed by delegate / undelegate transactions
        SessionStateChanged active ->
            let
                newTx =
                    case model.tx of
                        Delegating   -> if active then Idle else model.tx
                        Undelegating -> if not active then Idle else model.tx
                        _            -> model.tx
            in
            ( { model
                | delegated = active
                , tx        = newTx
              }
            , Cmd.none
            )

        NeighborInputChanged s ->
            ( { model | neighborInput = s }, Cmd.none )

        UserClickedSetNeighbor side ->
            if String.isEmpty model.neighborInput then
                ( model, Cmd.none )
            else
                ( { model | tx = Pending }
                , Ports.sendSetNeighbor
                    { side = side, neighbor = Just model.neighborInput }
                )

        UserClickedClearNeighbor side ->
            ( { model | tx = Pending }
            , Ports.sendSetNeighbor { side = side, neighbor = Nothing }
            )


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
        , Ports.historyLoaded      HistoryLoaded
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
        , viewNeighborPanel model
        , viewTxStatus model
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
                div [ class "wallet-info" ]
                    [ span [ class "pubkey" ] [ text (abbreviate pubkey) ]
                    , if model.delegated then
                        span [ class "er-badge" ] [ text "● ER session active" ]
                      else
                        text ""
                    ]
        ]


viewControls : Model -> Html Msg
viewControls model =
    let
        isConnected =
            case model.wallet of
                Connected _ -> True
                _           -> False

        isIdle =
            case model.tx of
                Idle        -> True
                Confirmed _ -> True
                _           -> False

        canAct = isConnected && isIdle
    in
    div [ class "controls" ]
        [ if model.delegated then
            -- ER session active
            div [ class "er-controls" ]
                [ button
                    [ onClick UserClickedEvolveER
                    , disabled (not canAct)
                    ]
                    [ text "Evolve ER ⚡" ]
                , button
                    [ onClick UserClickedUndelegate
                    , disabled (not canAct)
                    , class "secondary"
                    ]
                    [ text "End Session" ]
                ]
          else
            -- Base layer
            div [ class "base-controls" ]
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
                    , class "secondary"
                    ]
                    [ text "Delegate ER" ]
                ]
        , span [ class "generation-count" ]
            [ text
                (String.fromInt (List.length model.generations)
                    ++ " generations"
                )
            ]
        ]


viewNeighborPanel : Model -> Html Msg
viewNeighborPanel model =
    let
        isConnected =
            case model.wallet of
                Connected _ -> True
                _           -> False

        isIdle =
            case model.tx of
                Idle        -> True
                Confirmed _ -> True
                _           -> False

        canAct = isConnected && isIdle
    in
    div [ class "neighbor-panel" ]
        [ p [ class "neighbor-label" ] [ text "Neighbor wiring" ]
        , div [ class "neighbor-input-row" ]
            [ input
                [ placeholder "neighbor tile address"
                , value model.neighborInput
                , onInput NeighborInputChanged
                , class "neighbor-input"
                ]
                []
            , button
                [ onClick (UserClickedSetNeighbor 0)
                , disabled (not canAct || String.isEmpty model.neighborInput)
                , class "secondary small"
                ]
                [ text "Set Left" ]
            , button
                [ onClick (UserClickedSetNeighbor 1)
                , disabled (not canAct || String.isEmpty model.neighborInput)
                , class "secondary small"
                ]
                [ text "Set Right" ]
            ]
        , div [ class "neighbor-clear-row" ]
            [ button
                [ onClick (UserClickedClearNeighbor 0)
                , disabled (not canAct)
                , class "secondary small"
                ]
                [ text "Clear Left" ]
            , button
                [ onClick (UserClickedClearNeighbor 1)
                , disabled (not canAct)
                , class "secondary small"
                ]
                [ text "Clear Right" ]
            ]
        ]


viewTxStatus : Model -> Html Msg
viewTxStatus model =
    div [ class "tx-status" ]
        [ case model.tx of
            Idle ->
                text ""

            Initializing ->
                span [ class "pending" ] [ text "Initializing account…" ]

            Pending ->
                span [ class "pending" ] [ text "Transaction pending…" ]

            Delegating ->
                span [ class "pending" ] [ text "Opening ER session…" ]

            Undelegating ->
                span [ class "pending" ] [ text "Ending session, settling to chain…" ]

            Confirmed sig ->
                span [ class "confirmed" ]
                    [ text ("✓ " ++ abbreviate sig) ]

            Failed err ->
                span [ class "failed" ]
                    [ text ("✗ " ++ err) ]
        ]



-- ================================================================
-- Helpers
-- ================================================================

abbreviate : String -> String
abbreviate s =
    if String.length s <= 12 then
        s
    else
        String.left 4 s ++ "…" ++ String.right 4 s
