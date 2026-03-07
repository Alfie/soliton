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

// ER devnet endpoints — using US region, swap to eu/as if latency is better
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

// Anchor instruction discriminators (8-byte SHA256 of "global:<ix_name>")
// These must match what anchor-lang generates for your program.
// Run `anchor build` and check the IDL, or compute:
//   sha256("global:initialize")[0..8], etc.
// Placeholders below — replace with actual values from your IDL after build.
const IX = {
  initialize: [175, 175, 109,  31,  13, 152, 155, 237],
  evolve:     [139, 139, 160,  98, 252, 226, 106,  81],
  evolve_n:   [  9, 149, 242, 155, 145, 130,  16, 240],
  reset:      [ 23,  81, 251,  84, 138, 183, 240, 214],
  delegate:   [ 90, 147,  75, 178,  85,  88,   4, 137],
  undelegate: [131, 148, 180, 198,  91, 104,  42, 238],
}

// ================================================================
// Bridge initialisation
// ================================================================

export async function initSolanaBridge(app) {
  const rpcSubs   = createSolanaRpcSubscriptions(WS_URL)
  const erRpcSubs = createSolanaRpcSubscriptions(ER_WS_URL)

  let walletAddress   = null
  let stateAccountPDA = null
  let sessionActive   = false
  let erAbortController = null  // for switching WS subscription to ER

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
      const [pda] = await getProgramDerivedAddress({
        programAddress: PROGRAM_ID,
        seeds: [CA_STATE_SEED, walletBytes],
      })

      stateAccountPDA = pda
      console.log('CA state PDA:', stateAccountPDA)

      app.ports.walletConnected.send(wallet.publicKey.toBase58())

      // Start on base layer subscription
      openAccountSubscription(pda, app, rpcSubs, null)

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
  // sendEvolve — base layer fallback (pre-delegation)
  // --------------------------------------------------------------
  app.ports.sendEvolve.subscribe(async (_) => {
    if (!walletAddress) { app.ports.txFailed.send('Wallet not connected.'); return }

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey, ComputeBudgetProgram } =
        await import('@solana/web3.js')

      const wallet     = window.solana
      const connection = new Connection(RPC_URL, 'confirmed')

      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })

      // Anchor: discriminator (8) + no args = 8 bytes
      const data = new Uint8Array(8)
      data.set(IX.evolve, 0)

      const evolveIx = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: wallet.publicKey,                          isSigner: true,  isWritable: true  },
          { pubkey: new PublicKey(stateAccountPDA.toString()), isSigner: false, isWritable: true  },
        ],
        data,
      })

      const tx = new Transaction().add(computeBudgetIx).add(evolveIx)
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

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey } =
        await import('@solana/web3.js')

      const wallet     = window.solana
      const connection = new Connection(RPC_URL, 'confirmed')

      // delegate ix: discriminator only, validator passed as remaining account
      const data = new Uint8Array(8)
      data.set(IX.delegate, 0)

      const validatorPubkey = new PublicKey(ER_VALIDATOR)

      const delegateIx = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: wallet.publicKey,                          isSigner: true,  isWritable: true  },
          { pubkey: validatorPubkey,                           isSigner: false, isWritable: false },
          // The delegation program and system program are injected by the
          // #[delegate] macro's CPI — pass the PDA as the delegated account
          { pubkey: new PublicKey(stateAccountPDA.toString()), isSigner: false, isWritable: true  },
          { pubkey: new PublicKey(DELEGATION_PROGRAM_ID),      isSigner: false, isWritable: false },
          { pubkey: PublicKey.default,                         isSigner: false, isWritable: false }, // system program
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
  // sendEvolveER — ER fast path, any wallet can call
  // --------------------------------------------------------------
  app.ports.sendEvolveER.subscribe(async (_) => {
    if (!stateAccountPDA) { app.ports.txFailed.send('State account not derived yet.'); return }

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey } =
        await import('@solana/web3.js')

      const wallet       = window.solana
      const erConnection = new Connection(ER_RPC_URL, 'confirmed')

      // evolve ix on ER: discriminator + magic_context + magic_program
      // injected by #[commit] macro — they must be in remaining_accounts
      // The MagicBlock program ID:
      
      // magic_context is a PDA of the magic program — derived per session
      // For now pass as writable uninit; the ER validator handles it
      const magicContext = new PublicKey(MAGIC_CONTEXT_ID)

      const data = new Uint8Array(8)
      data.set(IX.evolve, 0)

      const evolveIx = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: wallet.publicKey,                          isSigner: true,  isWritable: true  },
          { pubkey: new PublicKey(stateAccountPDA.toString()), isSigner: false, isWritable: true  },
          { pubkey: magicContext,                              isSigner: false, isWritable: true  },
          { pubkey: new PublicKey(MAGIC_PROGRAM_ID),              isSigner: false, isWritable: false },
        ],
        data,
      })

      const tx = new Transaction().add(evolveIx)
      tx.recentBlockhash = (await erConnection.getLatestBlockhash()).blockhash
      tx.feePayer = wallet.publicKey

      const signedTx  = await wallet.signTransaction(tx)
      const signature = await erConnection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: true,   // skip preflight on ER — faster, ER validates
        preflightCommitment: 'confirmed',
      })
      // ER confirms fast — no need to poll aggressively
      await erConnection.confirmTransaction(signature, 'confirmed')

      app.ports.txConfirmed.send(signature)

    } catch (err) {
      console.error('sendEvolveER error:', err)
      app.ports.txFailed.send(err.message ?? String(err))
    }
  })

  // --------------------------------------------------------------
  // sendUndelegate — ER tx, commits + settles, ends session
  // --------------------------------------------------------------
  app.ports.sendUndelegate.subscribe(async (_) => {
    if (!stateAccountPDA) { app.ports.txFailed.send('State account not derived yet.'); return }

    try {
      const { Connection, Transaction, TransactionInstruction, PublicKey } =
        await import('@solana/web3.js')

      const wallet       = window.solana
      const erConnection = new Connection(ER_RPC_URL, 'confirmed')

      
      const magicContext = new PublicKey(MAGIC_CONTEXT_ID)

      const data = new Uint8Array(8)
      data.set(IX.undelegate, 0)

      const undelegateIx = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID.toString()),
        keys: [
          { pubkey: wallet.publicKey,                          isSigner: true,  isWritable: true  },
          { pubkey: new PublicKey(stateAccountPDA.toString()), isSigner: false, isWritable: true  },
          { pubkey: magicContext,                              isSigner: false, isWritable: true  },
          { pubkey: new PublicKey(MAGIC_PROGRAM_ID),              isSigner: false, isWritable: false },
        ],
        data,
      })

      const tx = new Transaction().add(undelegateIx)
      tx.recentBlockhash = (await erConnection.getLatestBlockhash()).blockhash
      tx.feePayer = wallet.publicKey

      const signedTx  = await wallet.signTransaction(tx)
      const signature = await erConnection.sendRawTransaction(signedTx.serialize(), {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
      })
      await erConnection.confirmTransaction(signature, 'confirmed')

      // Switch WS subscription back to base layer
      if (erAbortController) { erAbortController.abort(); erAbortController = null }
      openAccountSubscription(stateAccountPDA, app, createSolanaRpcSubscriptions(WS_URL), null)

      sessionActive = false
      app.ports.sessionStateChanged.send(false)
      app.ports.txConfirmed.send(signature)

    } catch (err) {
      console.error('sendUndelegate error:', err)
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

async function openAccountSubscription(accountAddress, app, rpcSubs, abortSignal) {
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

        const cells = decodeRuleState(bytes)
        app.ports.accountUpdated.send(cells)
      }
    })()

  } catch (err) {
    console.error('WS subscription error:', err)
  }
}

// ================================================================
// Account data decoding
//
// CAState layout (Anchor Borsh — 8-byte discriminator prefix):
//   bytes 0–7   : Anchor discriminator (skip)
//   byte  8     : width (u8)
//   bytes 9–16  : cells (u64, little-endian) — packed bitfield, LSB = cell 0
//   byte  17    : left_boundary (u8)
//   byte  18    : right_boundary (u8)
//   bytes 19–26 : generation (u64, little-endian)
//   byte  27    : bump (u8)
// ================================================================

function decodeRuleState(data) {
  // Anchor discriminator is 8 bytes — all offsets shift by 8 vs raw layout
  const DISC = 8

  const width = data[DISC + 0]
  console.log('Decoded width:', width)

  const cells = []
  for (let i = 0; i < width; i++) {
    const byteIndex = DISC + 1 + Math.floor(i / 8)
    const bitIndex  = i % 8
    const byte      = data[byteIndex] ?? 0
    cells.push(Boolean((byte >> bitIndex) & 1))
  }

  // Decode generation for debugging
  let generation = 0n
  for (let i = 0; i < 8; i++) {
    generation |= BigInt(data[DISC + 11 + i] ?? 0) << BigInt(i * 8)
  }
  console.log('Decoded generation:', generation.toString())

  return cells
}
