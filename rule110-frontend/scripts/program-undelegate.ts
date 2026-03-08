/**
 * program-undelegate.ts
 *
 * Calls YOUR program's `undelegate` instruction via the MagicBlock router.
 * Uses getBlockhashForAccounts (the router's custom RPC method) directly.
 *
 * Usage:
 *   ts-node program-undelegate.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import fs from 'fs'
import os from 'os'

// ================================================================
// Config
// ================================================================

const ER_ROUTER_RPC   = 'https://devnet-rpc.magicblock.app'
const PROGRAM_ID      = new PublicKey('CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ')
const STATE_ACCOUNT   = new PublicKey('Hy3kXRXV8SnJE5kUfu9VArGAX2Tobk9McH8WfEVQfB8n')
const MAGIC_PROGRAM   = new PublicKey('Magic11111111111111111111111111111111111111')
const MAGIC_CONTEXT   = new PublicKey('MagicContext1111111111111111111111111111111')

// sha256("global:undelegate")[0..8]
const UNDELEGATE_DISC = Buffer.from([131, 148, 180, 198, 91, 104, 42, 238])

// ================================================================
// Load keypair
// ================================================================

const keypairPath = `${os.homedir()}/.config/solana/id.json`
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8')))
)
console.log('Wallet:', keypair.publicKey.toBase58())

// ================================================================
// Router blockhash — uses getBlockhashForAccounts with writable accounts
// ================================================================

async function getBlockhashForAccounts(writableAccounts: string[]): Promise<{blockhash: string, lastValidBlockHeight: number}> {
  console.log('Writable accounts:', writableAccounts)
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
  const json = await res.json() as any
  console.log('getBlockhashForAccounts response:', JSON.stringify(json))
  return json.result
}

// ================================================================
// Main
// ================================================================

async function main() {
  const conn = new Connection(ER_ROUTER_RPC, 'confirmed')

  const accountInfo = await conn.getAccountInfo(STATE_ACCOUNT)
  if (!accountInfo) {
    console.error('Account not found on ER — already undelegated?')
    process.exit(1)
  }
  console.log('Account owner on ER:', accountInfo.owner.toBase58())

  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })

  const undelegateIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true,  isWritable: false },
      { pubkey: STATE_ACCOUNT,     isSigner: false, isWritable: true  },
      { pubkey: MAGIC_PROGRAM,     isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT,     isSigner: false, isWritable: true  },
    ],
    data: UNDELEGATE_DISC,
  })

  // Build tx first so we know writable accounts
  const tx = new Transaction()
  tx.feePayer = keypair.publicKey
  tx.add(computeIx).add(undelegateIx)

  // Collect writable accounts: feePayer + all writable ix keys
  const writableAccounts = [
    keypair.publicKey.toBase58(),  // feePayer is always writable
    STATE_ACCOUNT.toBase58(),
    MAGIC_CONTEXT.toBase58(),
  ]

  console.log('Fetching blockhash via getBlockhashForAccounts...')
  const { blockhash, lastValidBlockHeight } = await getBlockhashForAccounts(writableAccounts)
  console.log('Blockhash:', blockhash)

  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight
  tx.sign(keypair)

  console.log('Sending via router...')
  try {
    const raw = tx.serialize()
    const sig = await conn.sendRawTransaction(raw, { skipPreflight: true })
    console.log('Sent:', sig)
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
    console.log('✓ Undelegated successfully:', sig)
    console.log('\nVerify on base layer:')
    console.log(`  solana account ${STATE_ACCOUNT.toBase58()} --url https://api.devnet.solana.com`)
  } catch (err: any) {
    console.error('✗ Failed:', err.message ?? err)
    if (err.logs) console.error('Logs:', err.logs)
  }
}

main()
