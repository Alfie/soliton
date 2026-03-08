/**
 * catchup-tile.ts
 *
 * Evolves a tile N times to catch up to a target generation.
 * Both tiles must be at the same generation for the merged canvas to work.
 *
 * Usage:
 *   ts-node catchup-tile.ts <tile_id> <generations>
 *
 * Example — catch tile 1 up by 7 generations:
 *   ts-node catchup-tile.ts 1 7
 */

import {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import fs from 'fs'
import os from 'os'

const RPC_URL    = 'https://api.devnet.solana.com'
const PROGRAM_ID = new PublicKey('CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ')
const SEED       = Buffer.from('rule110')

const EVOLVE_N_DISC = Buffer.from([9, 149, 242, 155, 145, 130, 16, 240])

const TILE_PDAS: Record<number, string> = {
  0: '2KecrG5zbFAPcxy9YU6EDz2AUHAtFB4kAuThVUTxuAA4',
  1: 'dBhSsk6EhC94ZQT6C1z4Yid7VF21AA35hXd2vCcf1VL',
}
const NEIGHBOR: Record<number, string> = { 0: TILE_PDAS[1], 1: TILE_PDAS[0] }

const keypairPath = `${os.homedir()}/.config/solana/id.json`
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8')))
)

const tileId     = parseInt(process.argv[2] ?? '1', 10)
const generations = parseInt(process.argv[3] ?? '1', 10)

if (!(tileId in TILE_PDAS) || isNaN(generations) || generations < 1) {
  console.error('Usage: ts-node catchup-tile.ts <tile_id 0|1> <generations>')
  process.exit(1)
}

const tilePDA     = new PublicKey(TILE_PDAS[tileId])
const neighborPDA = new PublicKey(NEIGHBOR[tileId])

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')
  console.log(`Evolving tile ${tileId} by ${generations} generations...`)

  // evolve_n: disc(8) + generations(u16 LE)
  const data = Buffer.alloc(10)
  EVOLVE_N_DISC.forEach((b, i) => { data[i] = b })
  data.writeUInt16LE(generations, 8)

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  }, // payer
      { pubkey: tilePDA,           isSigner: false, isWritable: true  }, // ca_state
      { pubkey: neighborPDA,       isSigner: false, isWritable: false }, // remaining: neighbor
    ],
    data,
  })

  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })
  const tx = new Transaction().add(budget).add(ix)

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' })
    console.log(`✓ Tile ${tileId} advanced ${generations} gen(s):`, sig)

    const info = await connection.getAccountInfo(tilePDA)
    if (info) {
      let gen = 0n
      for (let i = 0; i < 8; i++) gen |= BigInt(info.data[20 + i]) << BigInt(i * 8)
      console.log(`  Now at generation: ${gen}`)
    }
  } catch (err: any) {
    console.error('✗ Failed:', err.message ?? err)
    if (err.logs) console.error('Logs:', err.logs)
  }
}

main()
