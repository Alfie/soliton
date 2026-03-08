/**
 * solana-bridge.js
 *
 * JS side of the Elm <-> Solana Kit interop bridge.
 *
 * Signing approach:
 *   Kit v2's signer abstraction requires a `signTransactions` interface
 *   that Phantom doesn't implement natively. Instead we:
 *     1. Build the transaction with web3.js v1
 *     2. Sign with Phantom
 *     3. Send via web3.js connection (base layer) or ER connection (ER)
 *
 * Session model:
 *   - sendDelegate   → base layer tx, hands PDA to delegation program
 *   - sendEvolveER   → ER tx, fast real-time evolution (any wallet)
 *   - sendUndelegate → ER tx, commits + settles state back to devnet
 */

import {
  createSolanaRpcSubscriptions,
  getProgramDerivedAddress,
  getAddressCodec,
  getUtf8Encoder,
  address,
} from '@solana/kit'


// ================================================================
// Config
// ================================================================

const RPC_URL    = 'https://api.devnet.solana.com'
const WS_URL     = 'wss://api.devnet.solana.com'
const PROGRAM_ID = address('CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ')

// MagicBlock Magic Router — handles ER routing automatically
const ER_ROUTER_RPC = 'https://devnet-rpc.magicblock.app'
const ER_ROUTER_WS  = 'wss://devnet-rpc.magicblock.app'

// Direct ER endpoint for WS subscriptions (router WS for account notifications)
const ER_RPC_URL = 'https://devnet-us.magicblock.app'
const ER_WS_URL  = 'wss://devnet-us.magicblock.app'

// Devnet US ER validator pubkey
const ER_VALIDATOR = 'MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd'

// Delegation program — same on all clusters
const DELEGATION_PROGRAM_ID = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh'

// MagicBlock program constants (from magicblock-magic-program-api)
const MAGIC_PROGRAM_ID = 'Magic11111111111111111111111111111111111111'
const MAGIC_CONTEXT_ID = 'MagicContext1111111111111111111111111111111'

// Seeds must match lib.rs: CA_STATE_SEED = b"rule110"
const CA_STATE_SEED = getUtf8Encoder().encode('rule110')

// Known tile PDAs
const TILE_1_PDA = 'dBhSsk6EhC94ZQT6C1z4Yid7VF21AA35hXd2vCcf1VL'

// Anchor instruction discriminators (8-byte SHA256 of "global:<ix_name>")
// These must match what anchor-lang generates for your program.
// Run `anchor build` and check the IDL, or compute:
//   sha256("global:initialize")[0..8], etc.
// Placeholders below — replace with actual values from your IDL after build.
const IX = {
  initialize:  [175, 175, 109,  31,  13, 152, 155, 237],
  reset:       [ 23,  81, 251,  84, 138, 183, 240, 214],
  set_neighbor:[ 40, 159, 174, 116, 216, 225, 210,  44],
  // initialize takes: tile_id(u8), width(u8), initial_cells(u64), left_boundary(u8), right_boundary(u8)
  delegate:    [ 90, 147,  75, 178,  85,  88,   4, 137],
  evolve:      [139, 139, 160,  98, 252, 226, 106,  81],
  evolve_n:    [  9, 149, 242, 155, 145, 130,  16, 240],
  evolve_er:   [224, 185, 225,  28,   7, 137, 102,  46],
  evolve_n_er: [110, 161,  12,  40, 190,  48, 109,  24],
  undelegate:  [131, 148, 180, 198,  91, 104,  42, 238],
}

// ================================================================
// Bridge initialisation
// ================================================================

export async function initSolanaBridge(app) {
  const rpcSubs   = createSolanaRpcSubscriptions(WS_URL)
  const erRpcSubs = createSolanaRpcSubscriptions(ER_ROUTER_WS)  // router WS for ER account notifications

  let walletAddress   = null
  let stateAccountPDA = null
  let sessionActive   = false
  let erAbortController = null  // for switching WS subscription to ER
  let tile1AbortController = null

  // Two-tile merge buffer keyed by generation number
  const mergeBuffer = new Map()

  function tryMerge(gen, tileIndex, row) {
    if (!mergeBuffer.has(gen)) mergeBuffer.set(gen, {})
    const entry = mergeBuffer.get(gen)
    if (tileIndex === 0) entry.tile0 = row
    else                 entry.tile1 = row
    console.log('tryMerge gen', gen, 'tile', tileIndex, '→ tile0:', !!entry.tile0, 'tile1:', !!entry.tile1)
    if (entry.tile0 && entry.tile1) {
      const merged = [...entry.tile0, ...entry.tile1]
      mergeBuffer.delete(gen)
      for (const k of mergeBuffer.keys()) {
        if (k < gen - 10) mergeBuffer.delete(k)
      }
      console.log('tryMerge: firing accountUpdated gen', gen, 'width', merged.length)
      app.ports.accountUpdated.send(merged)
    }
  }

  // --------------------------------------------------------------
  // connectWallet
  // --------------------------------------------------------------
  app.ports.connectWallet.subscribe(async () => {
    try {
      const wallet = window.solana
      if (!wallet) throw new Error('No wallet found. Install Phantom or another Solana wallet.')

      await wallet.connect()
      walletAddress = address(wallet.publicKey.toBase58())

      const walletBytes = getAddressCodec().encode(walletAddress)
      const TILE_ID = 0  // tile index — matches initialize-tile.ts
      const [pda] = await getProgramDerivedAddress({
        programAddress: PROGRAM_ID,
        seeds: [CA_STATE_SEED, walletBytes, new Uint8Array([TILE_ID])],
      })

      stateAccountPDA = pda
      console.log('CA state PDA:', stateAccountPDA)

      app.ports.walletConnected.send(wallet.publicKey.toBase58())

      // Check if the account is already delegated (owner = delegation program).
      // This restores session state after a page refresh.
      const { Connection: Conn, PublicKey: PK } = await import('@solana/web3.js')
      const connection = new Conn(RPC_URL, 'confirmed')
      const accountInfo = await connection.getAccountInfo(new PK(pda.toString()))
      const alreadyDelegated = accountInfo?.owner?.toBase58() === DELEGATION_PROGRAM_ID

      // Load both tile histories and merge by generation index
      const tile1Info = await connection.getAccountInfo(new PK(TILE_1_PDA))

      const history0 = accountInfo?.data ? decodeHistory(new Uint8Array(accountInfo.data)) : []
      const history1 = tile1Info?.data    ? decodeHistory(new Uint8Array(tile1Info.data))   : []

      const mergedHistory = []
      const minLen = Math.min(history0.length, history1.length)
      for (let i = 0; i < minLen; i++) {
        mergedHistory.push([...history0[i], ...history1[i]])
      }
      if (mergedHistory.length > 0) {
        app.ports.historyLoaded.send(mergedHistory)
      }

      // Always subscribe to tile 1 on base layer
      tile1AbortController = new AbortController()
      openTileSubscription(TILE_1_PDA, 1, app, rpcSubs, tile1AbortController.signal, tryMerge)

      if (alreadyDelegated) {
        console.log('Account already delegated — restoring ER session')
        sessionActive = true
        erAbortController = new AbortController()
        console.log('Opening ER WS subscription on:', ER_ROUTER_WS)
        openTileSubscription(pda, 0, app, erRpcSubs, erAbortController.signal, tryMerge)
        app.ports.sessionStateChanged.send(true)
      } else {
        openTileSubscription(pda, 0, app, rpcSubs, null, tryMerge)
      }

    } catch (err) {
      app.ports.walletError.send(err.message)
    }
  })

  // --------------------------------------------------------------
  // sendInitialize
  // --------------------------------------------------------------
  app.ports.sendInitialize.subscribe(async (_) => {
    if (!walletAddress) { app.ports.txFailed.send('Wallet not connected.'); return }

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey, SystemProgram } =
        await import('@solana/web3.js')

      const wallet     = window.solana
      const connection = new Connection(RPC_URL, 'confirmed')

      // Anchor discriminator (8) + width (1) + initial_cells (8) + left (1) + right (1) = 19
      const data = new Uint8Array(19)
      data.set(IX.initialize, 0)
      data[8]  = 64                // width = 64
      // initial_cells: single bit set at position 32 (middle of 64-cell row)
      // bit 32 = byte 4, bit 0 of that byte → 0x00000001_00000000 little-endian
      data[13] = 1                 // byte 4 of cells u64 (bit 32)
      data[17] = 0                 // left_boundary
      data[18] = 0                 // right_boundary

      const ix = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: new PublicKey(stateAccountPDA.toString()), isSigner: false, isWritable: true  },
          { pubkey: wallet.publicKey,                          isSigner: true,  isWritable: true  },
          { pubkey: SystemProgram.programId,                   isSigner: false, isWritable: false },
        ],
        data,
      })

      const tx = new Transaction().add(ix)
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
      tx.feePayer = wallet.publicKey

      const signedTx  = await wallet.signTransaction(tx)
      const signature = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false, preflightCommitment: 'confirmed',
      })
      await connection.confirmTransaction(signature, 'confirmed')

      app.ports.txConfirmed.send(signature)

    } catch (err) {
      console.error('sendInitialize error:', err)
      app.ports.txFailed.send(err.message ?? String(err))
    }
  })

  // --------------------------------------------------------------
  // sendEvolve — evolves both tiles atomically in one transaction
  // Both tiles must advance together so tryMerge receives both rows.
  // Tile 0 reads tile 1 as right neighbor; tile 1 reads tile 0 as left neighbor.
  // --------------------------------------------------------------
  app.ports.sendEvolve.subscribe(async (_) => {
    if (!walletAddress) { app.ports.txFailed.send('Wallet not connected.'); return }

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey, ComputeBudgetProgram } =
        await import('@solana/web3.js')

      const wallet     = window.solana
      const connection = new Connection(RPC_URL, 'confirmed')
      const tile0      = new PublicKey(stateAccountPDA.toString())
      const tile1      = new PublicKey(TILE_1_PDA)

      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 })

      const data = new Uint8Array(8)
      data.set(IX.evolve, 0)

      // Tile 0: payer + tile0 (mut) + tile1 as remaining (for right boundary)
      const evolve0Ix = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: wallet.publicKey, isSigner: true,  isWritable: true  },
          { pubkey: tile0,            isSigner: false, isWritable: true  },
          { pubkey: tile1,            isSigner: false, isWritable: false }, // remaining: right neighbor
        ],
        data,
      })

      // Tile 1: payer + tile1 (mut) + tile0 as remaining (for left boundary)
      const evolve1Ix = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: wallet.publicKey, isSigner: true,  isWritable: true  },
          { pubkey: tile1,            isSigner: false, isWritable: true  },
          { pubkey: tile0,            isSigner: false, isWritable: false }, // remaining: left neighbor
        ],
        data,
      })

      const tx = new Transaction().add(computeBudgetIx).add(evolve0Ix).add(evolve1Ix)
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
      tx.feePayer = wallet.publicKey

      const signedTx  = await wallet.signTransaction(tx)
      const signature = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false, preflightCommitment: 'confirmed',
      })
      await connection.confirmTransaction(signature, 'confirmed')

      app.ports.txConfirmed.send(signature)

    } catch (err) {
      console.error('sendEvolve error:', err)
      app.ports.txFailed.send(err.message ?? String(err))
    }
  })

  // --------------------------------------------------------------
  // sendDelegate — base layer, opens ER session
  // --------------------------------------------------------------
  app.ports.sendDelegate.subscribe(async (_) => {
    if (!walletAddress) { app.ports.txFailed.send('Wallet not connected.'); return }
    if (sessionActive)  { app.ports.txFailed.send('Session already active — undelegate first.'); return }

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey } =
        await import('@solana/web3.js')

      const wallet     = window.solana
      const connection = new Connection(RPC_URL, 'confirmed')

      // delegate ix: discriminator (8) + tile_id (u8, 1) = 9 bytes
      const data = new Uint8Array(9)
      data.set(IX.delegate, 0)
      data[8] = 0  // tile_id = 0

      const validatorPubkey    = new PublicKey(ER_VALIDATOR)
      const pdaPubkey          = new PublicKey(stateAccountPDA.toString())
      const programPubkey      = new PublicKey(PROGRAM_ID.toString())
      const delegationProgram  = new PublicKey(DELEGATION_PROGRAM_ID)

      // Derive the three PDAs injected by the #[delegate] macro:
      //   buffer_pda:          seeds=[b"buffer", pda],              program=PROGRAM_ID
      //   delegation_record:   seeds=[b"delegation", pda],          program=DELEGATION_PROGRAM_ID
      //   delegation_metadata: seeds=[b"delegation-metadata", pda], program=DELEGATION_PROGRAM_ID
      const enc = new TextEncoder()
      const [bufferPda]          = PublicKey.findProgramAddressSync([enc.encode('buffer'),              pdaPubkey.toBytes()], programPubkey)
      const [delegationRecord]   = PublicKey.findProgramAddressSync([enc.encode('delegation'),          pdaPubkey.toBytes()], delegationProgram)
      const [delegationMetadata] = PublicKey.findProgramAddressSync([enc.encode('delegation-metadata'), pdaPubkey.toBytes()], delegationProgram)

      // Account order matches the macro-expanded DelegateCA struct:
      // 0  authority            (signer, writable)
      // 1  validator            (optional)
      // 2  buffer_pda           (writable, seeds=[b"buffer", pda], program=PROGRAM_ID)
      // 3  delegation_record    (writable, seeds=[b"delegation", pda], program=DELEGATION_PROGRAM_ID)
      // 4  delegation_metadata  (writable, seeds=[b"delegation-metadata", pda], program=DELEGATION_PROGRAM_ID)
      // 5  pda                  (writable — the CA state account being delegated)
      // 6  owner_program        (= PROGRAM_ID)
      // 7  delegation_program   (= DELEGATION_PROGRAM_ID)
      // 8  system_program
      const delegateIx = new TransactionInstruction({
        programId: programPubkey,
        keys: [
          { pubkey: wallet.publicKey,   isSigner: true,  isWritable: true  }, // authority
          { pubkey: validatorPubkey,    isSigner: false, isWritable: false }, // validator
          { pubkey: bufferPda,          isSigner: false, isWritable: true  }, // buffer_pda
          { pubkey: delegationRecord,   isSigner: false, isWritable: true  }, // delegation_record
          { pubkey: delegationMetadata, isSigner: false, isWritable: true  }, // delegation_metadata
          { pubkey: pdaPubkey,          isSigner: false, isWritable: true  }, // pda
          { pubkey: programPubkey,      isSigner: false, isWritable: false }, // owner_program
          { pubkey: delegationProgram,  isSigner: false, isWritable: false }, // delegation_program
          { pubkey: PublicKey.default,  isSigner: false, isWritable: false }, // system_program
        ],
        data,
      })

      const tx = new Transaction().add(delegateIx)
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
      tx.feePayer = wallet.publicKey

      const signedTx  = await wallet.signTransaction(tx)
      const signature = await connection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: false, preflightCommitment: 'confirmed',
      })
      await connection.confirmTransaction(signature, 'confirmed')

      // Switch WS subscription to ER endpoint
      if (erAbortController) erAbortController.abort()
      erAbortController = new AbortController()
      openAccountSubscription(stateAccountPDA, app, erRpcSubs, erAbortController.signal)

      sessionActive = true
      app.ports.sessionStateChanged.send(true)
      app.ports.txConfirmed.send(signature)

    } catch (err) {
      console.error('sendDelegate error:', err)
      app.ports.txFailed.send(err.message ?? String(err))
    }
  })

  // --------------------------------------------------------------
  // ----------------------------------------------------------------
  // getBlockhashForAccounts — router's custom RPC method.
  // Pass writable accounts so router routes to the correct ER validator
  // and returns a blockhash valid for that validator.
  // ----------------------------------------------------------------
  async function getBlockhashForAccounts(writableAccounts) {
    const res = await fetch(ER_ROUTER_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBlockhashForAccounts',
        params: [writableAccounts],
      }),
    })
    const json = await res.json()
    return json.result // { blockhash, lastValidBlockHeight }
  }

  // sendEvolveER — ER fast path via Magic Router
  // --------------------------------------------------------------
  app.ports.sendEvolveER.subscribe(async (_) => {
    if (!stateAccountPDA) { app.ports.txFailed.send('State account not derived yet.'); return }

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey, ComputeBudgetProgram } =
        await import('@solana/web3.js')

      const wallet     = window.solana
      const routerConn = new Connection(ER_ROUTER_RPC, 'confirmed')

      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 })

      const data = new Uint8Array(8)
      data.set(IX.evolve_er, 0)

      const evolveIx = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: wallet.publicKey,                          isSigner: true,  isWritable: false }, // payer
          { pubkey: new PublicKey(stateAccountPDA.toString()), isSigner: false, isWritable: true  }, // ca_state
          { pubkey: new PublicKey(TILE_1_PDA),                 isSigner: false, isWritable: false }, // remaining: right neighbor (read-only, on base layer)
        ],
        data,
      })

      const tx = new Transaction().add(computeBudgetIx).add(evolveIx)
      tx.feePayer = wallet.publicKey

      // writable accounts: feePayer + ca_state only (tile 1 is read-only, not delegated)
      const { blockhash, lastValidBlockHeight } = await getBlockhashForAccounts([
        wallet.publicKey.toBase58(),
        stateAccountPDA.toString(),
      ])
      tx.recentBlockhash = blockhash
      tx.lastValidBlockHeight = lastValidBlockHeight

      const signedTx  = await wallet.signTransaction(tx)
      const signature = await routerConn.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: true,
      })
      await routerConn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')

      app.ports.txConfirmed.send(signature)

    } catch (err) {
      console.error('sendEvolveER error:', err)
      app.ports.txFailed.send(err.message ?? String(err))
    }
  })

  // --------------------------------------------------------------
  // sendUndelegate — commit + settle via Magic Router, ends session
  // --------------------------------------------------------------
  app.ports.sendUndelegate.subscribe(async (_) => {
    if (!stateAccountPDA) { app.ports.txFailed.send('State account not derived yet.'); return }

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey, ComputeBudgetProgram } =
        await import('@solana/web3.js')

      const wallet     = window.solana
      const routerConn = new Connection(ER_ROUTER_RPC, 'confirmed')

      const data = new Uint8Array(8)
      data.set(IX.undelegate, 0)

      const undelegateIx = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: wallet.publicKey,                            isSigner: true,  isWritable: false }, // payer
          { pubkey: new PublicKey(stateAccountPDA.toString()),   isSigner: false, isWritable: true  }, // ca_state
          { pubkey: new PublicKey(MAGIC_PROGRAM_ID),             isSigner: false, isWritable: false }, // magic_program
          { pubkey: new PublicKey(MAGIC_CONTEXT_ID),             isSigner: false, isWritable: true  }, // magic_context
        ],
        data,
      })

      const tx = new Transaction().add(undelegateIx)
      tx.feePayer = wallet.publicKey

      // writable accounts: feePayer + ca_state + magic_context
      const { blockhash, lastValidBlockHeight } = await getBlockhashForAccounts([
        wallet.publicKey.toBase58(),
        stateAccountPDA.toString(),
        MAGIC_CONTEXT_ID,
      ])
      tx.recentBlockhash = blockhash
      tx.lastValidBlockHeight = lastValidBlockHeight

      const signedTx  = await wallet.signTransaction(tx)
      const signature = await routerConn.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: true,
      })
      await routerConn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')

      // Switch WS subscription back to base layer
      if (erAbortController) { erAbortController.abort(); erAbortController = null }
      openTileSubscription(stateAccountPDA, 0, app, createSolanaRpcSubscriptions(WS_URL), null, tryMerge)

      sessionActive = false
      app.ports.sessionStateChanged.send(false)
      app.ports.txConfirmed.send(signature)

    } catch (err) {
      console.error('sendUndelegate error:', err)
      app.ports.txFailed.send(err.message ?? String(err))
    }
  })

  // sendSetNeighbor — link or unlink a neighbor tile
  // --------------------------------------------------------------
  app.ports.sendSetNeighbor.subscribe(async ({ side, neighbor }) => {
    if (!walletAddress)    { app.ports.txFailed.send('Wallet not connected.'); return }
    if (!stateAccountPDA)  { app.ports.txFailed.send('State account not derived yet.'); return }

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey } =
        await import('@solana/web3.js')

      const wallet = window.solana
      const conn   = new Connection(RPC_URL, 'confirmed')

      // Encode: discriminator (8) + side (u8, 1) + Option<Pubkey> (1 or 33)
      // Borsh Option<Pubkey>: None = [0x00], Some(pk) = [0x01, ...32 bytes...]
      let dataLen = 8 + 1 + (neighbor ? 33 : 1)
      const data  = new Uint8Array(dataLen)
      data.set(IX.set_neighbor, 0)
      data[8] = side
      if (neighbor) {
        data[9] = 0x01  // Some tag
        const pkBytes = new PublicKey(neighbor).toBytes()
        data.set(pkBytes, 10)
      } else {
        data[9] = 0x00  // None tag
      }

      const ix = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: new PublicKey(stateAccountPDA.toString()), isSigner: false, isWritable: true }, // ca_state
          { pubkey: wallet.publicKey,                          isSigner: true,  isWritable: false }, // authority
        ],
        data,
      })

      const tx = new Transaction().add(ix)
      tx.feePayer = wallet.publicKey
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash()
      tx.recentBlockhash = blockhash

      const signed    = await wallet.signTransaction(tx)
      const signature = await conn.sendRawTransaction(signed.serialize())
      await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')

      console.log('set_neighbor confirmed:', signature, 'side:', side, 'neighbor:', neighbor)
      app.ports.txConfirmed.send(signature)

    } catch (err) {
      console.error('sendSetNeighbor error:', err)
      app.ports.txFailed.send(err.message ?? String(err))
    }
  })

  // --------------------------------------------------------------
  // unsubscribeFromAccount
  // --------------------------------------------------------------
  if (app.ports.unsubscribeFromAccount) {
    app.ports.unsubscribeFromAccount.subscribe((_) => {
      if (erAbortController) { erAbortController.abort(); erAbortController = null }
      console.log('unsubscribeFromAccount called')
    })
  }
}

// ================================================================
// Internal: open a WS subscription on a given account address
// ================================================================

// openTileSubscription — subscribes to one tile account.
// Decodes each notification and feeds tryMerge(generation, tileIndex, row).
// tileIndex 0 = left tile, 1 = right tile.
async function openTileSubscription(accountAddress, tileIndex, app, rpcSubs, abortSignal, onRow) {
  try {
    const abortController = abortSignal ? { signal: abortSignal } : new AbortController()
    const signal = abortSignal ?? abortController.signal

    const sub = await rpcSubs
      .accountNotifications(accountAddress, {
        commitment: 'confirmed',
        encoding: 'base64',
      })
      .subscribe({ abortSignal: signal })

    ;(async () => {
      for await (const notification of sub) {
        const base64Data = Array.isArray(notification.value.data)
          ? notification.value.data[0]
          : notification.value.data

        const binaryString = atob(base64Data)
        const bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i)
        }

        console.log('WS tile', tileIndex, 'bytes received:', bytes.length)
        const { cells, generation } = decodeRuleStateWithGen(bytes)
        if (onRow) onRow(Number(generation), tileIndex, cells)
      }
    })()

  } catch (err) {
    console.error('WS subscription error (tile', tileIndex, '):', err)
  }
}

// Legacy single-tile subscription — kept for any callers not yet migrated
function openAccountSubscription(accountAddress, app, rpcSubs, abortSignal) {
  return openTileSubscription(accountAddress, 0, app, rpcSubs, abortSignal, null)
}

// ================================================================
// Account data decoding
//
// CAState layout (Anchor Borsh — 8-byte discriminator prefix):
//   bytes  0–7  : Anchor discriminator (skip)
//   byte   8    : width (u8)
//   bytes  9–16 : cells (u64 LE) — packed bitfield, LSB = cell 0
//   byte  17    : left_boundary (u8)
//   byte  18    : right_boundary (u8)
//   bytes 19–26 : generation (u64 LE)
//   byte  27    : bump (u8)
//   bytes 28–60 : left_neighbor  (Option<Pubkey>: 1 tag byte + 32 data bytes)
//   bytes 61–93 : right_neighbor (Option<Pubkey>: 1 tag byte + 32 data bytes)
//   byte  94    : history_head (u8)
//   bytes 95+   : history ring buffer (64 × 10 bytes)
//                 each entry: cells u64 LE (8) + left_used u8 (1) + right_used u8 (1)
// ================================================================

// Static offsets — these never change (tile_id added at offset 8)
const OFFSETS_STATIC = {
  tile_id:        8,
  width:          9,
  cells:          10,  // 8 bytes (u64 LE)
  left_boundary:  18,
  right_boundary: 19,
  generation:     20,  // 8 bytes (u64 LE)
  bump:           28,
  left_neighbor:  29,  // Option<Pubkey>: 1 byte tag, then 32 bytes if Some
}

// Anchor Borsh always serializes Option<Pubkey> as 33 bytes:
//   None → [0x00, 0x00 * 32]
//   Some → [0x01, pubkey * 32]
// So offsets are fully static — no runtime inspection needed.
const OFFSETS_DYNAMIC = {
  right_neighbor: 62,   // 29 + 33
  history_head:   95,   // 29 + 33 + 33
  history:        96,   // 29 + 33 + 33 + 1
}

function computeOffsets(_data) {
  return { historyHead: OFFSETS_DYNAMIC.history_head, history: OFFSETS_DYNAMIC.history }
}

const HISTORY_LEN    = 64
const HISTORY_ENTRY  = 10  // bytes per entry

function readU64LE(data, offset) {
  let val = 0n
  for (let i = 0; i < 8; i++) {
    val |= BigInt(data[offset + i] ?? 0) << BigInt(i * 8)
  }
  return val
}

function decodeCells(data, offset, width) {
  const cells = []
  for (let i = 0; i < width; i++) {
    const byteIndex = offset + Math.floor(i / 8)
    const bitIndex  = i % 8
    cells.push(Boolean((data[byteIndex] ?? 0) >> bitIndex & 1))
  }
  return cells
}

function decodeHistoryEntry(data, entryOffset, width) {
  const cells    = readU64LE(data, entryOffset)
  const leftUsed = data[entryOffset + 8]
  const rightUsed = data[entryOffset + 9]
  return { cells: decodeCells(data, entryOffset, width), leftUsed, rightUsed }
}

// Decode the current generation's cell state — used by WS notifications.
function decodeRuleState(data) {
  return decodeRuleStateWithGen(data).cells
}

function decodeRuleStateWithGen(data) {
  const width      = data[OFFSETS_STATIC.width]
  const cells      = decodeCells(data, OFFSETS_STATIC.cells, width)
  const generation = readU64LE(data, OFFSETS_STATIC.generation)
  console.log('Decoded width:', width, 'generation:', generation.toString())
  return { cells, generation }
}

// Decode full history in chronological order (oldest → newest).
// Returns an array of cell rows ready for the canvas to paint on initial load.
function decodeHistory(data) {
  const width      = data[OFFSETS_STATIC.width]
  const generation = Number(readU64LE(data, OFFSETS_STATIC.generation))

  // Compute actual history offsets — Option<Pubkey> is variable-length
  const off = computeOffsets(data)

  // generation+1 because push_history is called in initialize for gen 0
  const count = Math.min(generation + 1, HISTORY_LEN)

  if (count === 0) return []

  const historyHead = data[off.historyHead]
  console.log('decodeHistory: gen', generation, 'historyHead', historyHead,
              'count', count, 'historyOffset', off.history)

  // oldest slot = (historyHead + HISTORY_LEN + 1 - count) % HISTORY_LEN
  const oldest = (historyHead + HISTORY_LEN + 1 - count) % HISTORY_LEN
  const rows = []
  for (let i = 0; i < count; i++) {
    const slot   = (oldest + i) % HISTORY_LEN
    const offset = off.history + slot * HISTORY_ENTRY
    rows.push(decodeCells(data, offset, width))
  }
  return rows
}
