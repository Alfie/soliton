/**
 * initialize-tile.ts
 *
 * Initialize a CA tile at a given tile_id.
 * Tile PDA seeds: [b"rule110", authority_pubkey, tile_id_byte]
 *
 * Usage:
 *   ts-node initialize-tile.ts <tile_id> [initial_cell_bit]
 *
 * Examples:
 *   ts-node initialize-tile.ts 0        # tile 0, single center cell
 *   ts-node initialize-tile.ts 1        # tile 1, single center cell
 *   ts-node initialize-tile.ts 1 0      # tile 1, all zeros
 */

import {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction, SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import fs from 'fs'
import os from 'os'

const RPC_URL    = 'https://api.devnet.solana.com'
const PROGRAM_ID = new PublicKey('CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ')
const SEED       = Buffer.from('rule110')

const INITIALIZE_DISC = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237])

const WIDTH = 64

const keypairPath = `${os.homedir()}/.config/solana/id.json`
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8')))
)

const tileId = parseInt(process.argv[2] ?? '0', 10)
if (isNaN(tileId) || tileId < 0 || tileId > 255) {
  console.error('Usage: ts-node initialize-tile.ts <tile_id 0-255>')
  process.exit(1)
}

// Center cell for tile 0, leftmost cell for tile 1 (so they border each other)
const defaultCell = tileId === 0 ? BigInt(1) << BigInt(32) : BigInt(1) << BigInt(0)
const INITIAL_CELLS = defaultCell

const [statePDA, bump] = PublicKey.findProgramAddressSync(
  [SEED, keypair.publicKey.toBytes(), Buffer.from([tileId])],
  PROGRAM_ID
)

console.log(`Authority:  ${keypair.publicKey.toBase58()}`)
console.log(`Tile ID:    ${tileId}`)
console.log(`State PDA:  ${statePDA.toBase58()}`)
console.log(`Bump:       ${bump}`)
console.log(`Initial cells: 0x${INITIAL_CELLS.toString(16).padStart(16, '0')}`)

function encodeInitialize(tileId: number, width: number, cells: bigint, leftBoundary: number, rightBoundary: number): Buffer {
  // disc(8) + tile_id(1) + width(1) + cells(8) + left(1) + right(1) = 20
  const buf = Buffer.alloc(20)
  INITIALIZE_DISC.copy(buf, 0)
  buf.writeUInt8(tileId, 8)
  buf.writeUInt8(width, 9)
  buf.writeBigUInt64LE(cells, 10)
  buf.writeUInt8(leftBoundary, 18)
  buf.writeUInt8(rightBoundary, 19)
  return buf
}

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')

  const existing = await connection.getAccountInfo(statePDA)
  if (existing) {
    console.log(`\nAccount already exists: ${existing.data.length} bytes`)
    if (existing.data.length === 736) {
      console.log('Already initialized with new layout — done.')
      printState(existing.data as Buffer)
      return
    }
    console.error('Old layout detected — close it first with close-tile.ts')
    process.exit(1)
  }

  const data = encodeInitialize(tileId, WIDTH, INITIAL_CELLS, 0, 0)

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: statePDA,                isSigner: false, isWritable: true  },
      { pubkey: keypair.publicKey,       isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  })

  const tx = new Transaction().add(ix)
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' })
    console.log(`\n✓ Tile ${tileId} initialized:`, sig)
    const info = await connection.getAccountInfo(statePDA)
    console.log(`Account size: ${info?.data.length} bytes (expected 736)`)
    if (info?.data) printState(info.data as Buffer)
  } catch (err: any) {
    console.error('✗ Failed:', err.message ?? err)
    if (err.logs) console.error('Logs:', err.logs)
  }
}

function printState(data: Buffer) {
  const tileId = data[8]
  const width  = data[9]
  let cells = 0n
  for (let i = 0; i < 8; i++) cells |= BigInt(data[10 + i]) << BigInt(i * 8)
  let gen = 0n
  for (let i = 0; i < 8; i++) gen |= BigInt(data[20 + i]) << BigInt(i * 8)
  const row = Array.from({ length: width }, (_, i) =>
    ((cells >> BigInt(i)) & 1n) === 1n ? '█' : '·'
  ).join('')
  console.log(`\n  tile_id:    ${tileId}`)
  console.log(`  width:      ${width}`)
  console.log(`  cells:      0x${cells.toString(16).padStart(16, '0')}`)
  console.log(`  generation: ${gen}`)
  console.log(`  pattern:    ${row}`)
}

main()
