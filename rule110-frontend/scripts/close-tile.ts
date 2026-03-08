/**
 * close-tile.ts
 *
 * Closes a CA tile account by calling the program's close_account instruction.
 * Uses AccountInfo on-chain to bypass deserialization — safe across layout changes.
 *
 * Usage:
 *   ts-node close-tile.ts <tile_id>
 *
 * Example:
 *   ts-node close-tile.ts 0
 */

import {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import fs from 'fs'
import os from 'os'

const RPC_URL    = 'https://api.devnet.solana.com'
const PROGRAM_ID = new PublicKey('CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ')
const SEED       = Buffer.from('rule110')

// sha256("global:close_account")[0..8]
const CLOSE_DISC = Buffer.from([125, 255, 149, 14, 110, 34, 72, 24])

const keypairPath = `${os.homedir()}/.config/solana/id.json`
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8')))
)

const tileId = parseInt(process.argv[2] ?? '0', 10)
if (isNaN(tileId) || tileId < 0 || tileId > 255) {
  console.error('Usage: ts-node close-tile.ts <tile_id 0-255>')
  process.exit(1)
}

const [statePDA] = PublicKey.findProgramAddressSync(
  [SEED, keypair.publicKey.toBytes(), Buffer.from([tileId])],
  PROGRAM_ID
)

console.log(`Authority: ${keypair.publicKey.toBase58()}`)
console.log(`Tile ID:   ${tileId}`)
console.log(`PDA:       ${statePDA.toBase58()}`)

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')

  const existing = await connection.getAccountInfo(statePDA)
  if (!existing) {
    console.log('Account does not exist — nothing to close.')
    return
  }
  console.log(`\nAccount: ${existing.data.length} bytes, owner: ${existing.owner.toBase58()}`)

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: statePDA,          isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey, isSigner: true,  isWritable: true },
    ],
    data: CLOSE_DISC,
  })

  const tx = new Transaction().add(ix)
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' })
    console.log(`✓ Tile ${tileId} closed:`, sig)
  } catch (err: any) {
    console.error('✗ Failed:', err.message ?? err)
    if (err.logs) console.error('Logs:', err.logs)
  }
}

main()
