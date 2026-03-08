/**
 * wire-neighbors.ts
 *
 * Links tile 0 and tile 1 as neighbors:
 *   tile 0 right → tile 1
 *   tile 1 left  → tile 0
 *
 * Run once after both tiles are initialized.
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

const SET_NEIGHBOR_DISC = Buffer.from([40, 159, 174, 116, 216, 225, 210, 44])

const TILE_0 = new PublicKey('2KecrG5zbFAPcxy9YU6EDz2AUHAtFB4kAuThVUTxuAA4')
const TILE_1 = new PublicKey('dBhSsk6EhC94ZQT6C1z4Yid7VF21AA35hXd2vCcf1VL')

const keypairPath = `${os.homedir()}/.config/solana/id.json`
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8')))
)

// Encode: disc(8) + side(u8) + Option<Pubkey>(33: tag + 32 bytes)
function encodeSetNeighbor(side: number, neighbor: PublicKey): Buffer {
  const buf = Buffer.alloc(8 + 1 + 33)
  SET_NEIGHBOR_DISC.copy(buf, 0)
  buf.writeUInt8(side, 8)
  buf[9] = 0x01  // Some tag
  neighbor.toBytes().forEach((b, i) => { buf[10 + i] = b })
  return buf
}

async function setNeighbor(
  connection: Connection,
  caState: PublicKey,
  side: number,
  neighbor: PublicKey,
  label: string,
) {
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: caState,           isSigner: false, isWritable: true  },
      { pubkey: keypair.publicKey, isSigner: true,  isWritable: false },
    ],
    data: encodeSetNeighbor(side, neighbor),
  })

  const tx = new Transaction().add(ix)
  const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' })
  console.log(`✓ ${label}:`, sig)
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')
  console.log('Authority:', keypair.publicKey.toBase58())
  console.log('Tile 0:   ', TILE_0.toBase58())
  console.log('Tile 1:   ', TILE_1.toBase58())
  console.log()

  // tile 0 right neighbor = tile 1  (side 1 = right)
  await setNeighbor(connection, TILE_0, 1, TILE_1, 'tile0.right → tile1')

  // tile 1 left neighbor = tile 0   (side 0 = left)
  await setNeighbor(connection, TILE_1, 0, TILE_0, 'tile1.left  → tile0')

  console.log('\nNeighbors wired. Both tiles will now share boundary cells on evolve.')
  console.log('Tile 0 PDA:', TILE_0.toBase58())
  console.log('Tile 1 PDA:', TILE_1.toBase58())
}

main().catch(err => {
  console.error(err.message ?? err)
  if (err.logs) console.error(err.logs)
  process.exit(1)
})
