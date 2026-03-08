/**
 * force-undelegate.ts
 *
 * Force-undelegates the tile-0 CA state account from the ER,
 * committing any pending state back to devnet.
 *
 * Run this whenever the frontend can't close the session.
 */

import {
  Connection, Keypair, PublicKey,
  Transaction, TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import fs from 'fs'
import os from 'os'

const ER_ROUTER_RPC  = 'https://devnet-rpc.magicblock.app'
const PROGRAM_ID     = new PublicKey('CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ')
const MAGIC_PROGRAM  = new PublicKey('Magic11111111111111111111111111111111111111')
const MAGIC_CONTEXT  = new PublicKey('MagicContext1111111111111111111111111111111')

// sha256("global:undelegate")[0..8]
const UNDELEGATE_DISC = Buffer.from([131, 148, 180, 198, 91, 104, 42, 238])

// Tile to undelegate — change tile_id if needed
const TILE_ID   = parseInt(process.argv[2] ?? '0', 10)
const TILE_ADDR = TILE_ID === 0
  ? new PublicKey('2KecrG5zbFAPcxy9YU6EDz2AUHAtFB4kAuThVUTxuAA4')
  : new PublicKey('dBhSsk6EhC94ZQT6C1z4Yid7VF21AA35hXd2vCcf1VL')

const keypairPath = `${os.homedir()}/.config/solana/id.json`
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8')))
)

async function getBlockhashForAccounts(writableAccounts: string[]) {
  const res = await fetch(ER_ROUTER_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'getBlockhashForAccounts',
      params: [writableAccounts],
    }),
  })
  const json = await res.json() as any
  if (json.error) throw new Error(`getBlockhashForAccounts: ${JSON.stringify(json.error)}`)
  return json.result as { blockhash: string, lastValidBlockHeight: number }
}

async function main() {
  console.log('Authority:', keypair.publicKey.toBase58())
  console.log('Tile ID:  ', TILE_ID)
  console.log('Tile PDA: ', TILE_ADDR.toBase58())

  const routerConn = new Connection(ER_ROUTER_RPC, 'confirmed')

  const data = Buffer.from(UNDELEGATE_DISC)

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true,  isWritable: false },
      { pubkey: TILE_ADDR,         isSigner: false, isWritable: true  },
      { pubkey: MAGIC_PROGRAM,     isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT,     isSigner: false, isWritable: true  },
    ],
    data,
  })

  const budgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })

  const tx = new Transaction().add(budgetIx).add(ix)
  tx.feePayer = keypair.publicKey

  const writables = [
    keypair.publicKey.toBase58(),
    TILE_ADDR.toBase58(),
    MAGIC_CONTEXT.toBase58(),
  ]

  console.log('\nFetching ER blockhash...')
  const { blockhash, lastValidBlockHeight } = await getBlockhashForAccounts(writables)
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight

  tx.sign(keypair)

  console.log('Sending undelegate to ER router...')
  try {
    const sig = await routerConn.sendRawTransaction(tx.serialize(), { skipPreflight: true })
    await routerConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
    console.log('✓ Undelegated:', sig)
  } catch (err: any) {
    console.error('✗ Failed:', err.message ?? err)
    if (err.logs) console.error('Logs:', err.logs)
  }
}

main()
