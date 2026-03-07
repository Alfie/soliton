/**
 * scripts/initialize.js
 *
 * One-time script to initialize the Rule 110 CA state account on devnet.
 * Uses @solana/web3.js v1 directly to avoid Kit account ordering issues.
 *
 * Usage:
 *   node scripts/initialize.js
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { readFileSync } from 'fs'
import { homedir } from 'os'

// ================================================================
// Config
// ================================================================

const RPC_URL    = 'https://api.devnet.solana.com'
const PROGRAM_ID = new PublicKey('EV2MYGcPYsSqRQzfAXLRiEnfpQHDDGfsxkkQk5NCJoJA')

// Width, initial cells, boundaries
const WIDTH          = 8
const INITIAL_CELLS  = 1n   // 0b00000001 — single live cell at position 0
const LEFT_BOUNDARY  = 0
const RIGHT_BOUNDARY = 0

// ================================================================
// Load your local keypair (the authority / fee payer)
// ================================================================

const keypairPath = `${homedir()}/.config/solana/id.json`
const secret      = JSON.parse(readFileSync(keypairPath, 'utf8'))
const authority   = Keypair.fromSecretKey(Uint8Array.from(secret))

console.log('Authority:', authority.publicKey.toBase58())

// ================================================================
// Derive the CA state PDA
// ================================================================

const [stateAccountPDA, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('rule110'), authority.publicKey.toBuffer()],
  PROGRAM_ID
)

console.log('CA state PDA:', stateAccountPDA.toBase58())
console.log('Bump:', bump)

// ================================================================
// Build the Initialize instruction
//
// Borsh layout:
//   variant index : u8  = 0
//   width         : u8
//   initial_cells : u64 (little-endian)
//   left_boundary : u8
//   right_boundary: u8
//   total         : 12 bytes
// ================================================================

const data = Buffer.alloc(12)
data.writeUInt8(0, 0)                          // variant: Initialize
data.writeUInt8(WIDTH, 1)                      // width
data.writeBigUInt64LE(INITIAL_CELLS, 2)        // initial_cells
data.writeUInt8(LEFT_BOUNDARY, 10)             // left_boundary
data.writeUInt8(RIGHT_BOUNDARY, 11)            // right_boundary

const instruction = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: stateAccountPDA,            isSigner: false, isWritable: true  },  // ca_account
    { pubkey: authority.publicKey,        isSigner: true,  isWritable: true  },  // authority
    { pubkey: SystemProgram.programId,    isSigner: false, isWritable: false },  // system program
  ],
  data,
})

// ================================================================
// Send
// ================================================================

const connection = new Connection(RPC_URL, 'confirmed')
const tx = new Transaction().add(instruction)

console.log('Sending Initialize transaction...')

const signature = await sendAndConfirmTransaction(connection, tx, [authority])

console.log('✓ Initialized!')
console.log('  Signature:', signature)
console.log('  View on explorer:')
console.log(`  https://explorer.solana.com/tx/${signature}?cluster=devnet`)
