/**
 * reinitialize.ts
 *
 * Closes the old CAState account (returning lamports to authority)
 * then initializes a fresh one with the new 735-byte layout.
 *
 * Usage:
 *   ts-node reinitialize.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import fs from 'fs'
import os from 'os'

// ================================================================
// Config
// ================================================================

const RPC_URL    = 'https://api.devnet.solana.com'
const PROGRAM_ID = new PublicKey('CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ')
const SEED       = Buffer.from('rule110')

const DISC = {
  close_account: Buffer.from([125, 255, 149,  14, 110,  34,  72,  24]),
  initialize:    Buffer.from([175, 175, 109,  31,  13, 152, 155, 237]),
}

const WIDTH          = 64
const INITIAL_CELLS  = BigInt(1) << BigInt(32)  // single cell at position 32
const LEFT_BOUNDARY  = 0
const RIGHT_BOUNDARY = 0

// ================================================================
// Load keypair
// ================================================================

const keypairPath = `${os.homedir()}/.config/solana/id.json`
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8')))
)
console.log('Authority:', keypair.publicKey.toBase58())

const [statePDA] = PublicKey.findProgramAddressSync(
  [SEED, keypair.publicKey.toBytes()],
  PROGRAM_ID
)
console.log('State PDA:', statePDA.toBase58())

// ================================================================
// Helpers
// ================================================================

function encodeClose(): Buffer {
  return Buffer.from(DISC.close_account)
}

function encodeInitialize(width: number, cells: bigint, leftBoundary: number, rightBoundary: number): Buffer {
  const buf = Buffer.alloc(8 + 1 + 8 + 1 + 1)
  DISC.initialize.copy(buf, 0)
  buf.writeUInt8(width, 8)
  buf.writeBigUInt64LE(cells, 9)
  buf.writeUInt8(leftBoundary, 17)
  buf.writeUInt8(rightBoundary, 18)
  return buf
}

function printState(data: Buffer) {
  const width = data[8]
  let cells = 0n
  for (let i = 0; i < 8; i++) cells |= BigInt(data[9 + i]) << BigInt(i * 8)
  let gen = 0n
  for (let i = 0; i < 8; i++) gen |= BigInt(data[19 + i]) << BigInt(i * 8)
  const historyHead = data[94]
  const row = Array.from({ length: width }, (_, i) =>
    ((cells >> BigInt(i)) & 1n) === 1n ? '█' : '·'
  ).join('')

  console.log(`  width:        ${width}`)
  console.log(`  cells:        0x${cells.toString(16).padStart(16, '0')}`)
  console.log(`  generation:   ${gen}`)
  console.log(`  history_head: ${historyHead}`)
  console.log(`  pattern:      ${row}`)
}

// ================================================================
// Main
// ================================================================

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')

  const existing = await connection.getAccountInfo(statePDA)

  // ---- Step 1: close existing account if present ----
  if (existing) {
    console.log(`\nExisting account: ${existing.data.length} bytes, owner: ${existing.owner.toBase58()}`)

    if (existing.owner.toBase58() !== PROGRAM_ID.toBase58()) {
      console.error('Account is not owned by our program — cannot close.')
      process.exit(1)
    }

    console.log('Closing old account...')
    const closeIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: statePDA,          isSigner: false, isWritable: true }, // ca_state
        { pubkey: keypair.publicKey, isSigner: true,  isWritable: true }, // authority
      ],
      data: encodeClose(),
    })

    const closeTx = new Transaction().add(closeIx)
    const closeSig = await sendAndConfirmTransaction(connection, closeTx, [keypair], {
      commitment: 'confirmed',
    })
    console.log('✓ Closed:', closeSig)
  } else {
    console.log('\nNo existing account found — proceeding to initialize.')
  }

  // ---- Step 2: initialize fresh account ----
  console.log('\nInitializing new account (735 bytes)...')

  const initIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: statePDA,                isSigner: false, isWritable: true  }, // ca_state
      { pubkey: keypair.publicKey,       isSigner: true,  isWritable: true  }, // authority
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
    ],
    data: encodeInitialize(WIDTH, INITIAL_CELLS, LEFT_BOUNDARY, RIGHT_BOUNDARY),
  })

  const initTx = new Transaction().add(initIx)
  try {
    const sig = await sendAndConfirmTransaction(connection, initTx, [keypair], {
      commitment: 'confirmed',
    })
    console.log('✓ Initialized:', sig)

    const info = await connection.getAccountInfo(statePDA)
    console.log(`\nNew account: ${info?.data.length} bytes (expected 735)`)
    if (info?.data) {
      console.log('\nInitial state:')
      printState(info.data as Buffer)
    }
  } catch (err: any) {
    console.error('✗ Failed:', err.message ?? err)
    if (err.logs) console.error('Logs:', err.logs)
  }
}

main()
