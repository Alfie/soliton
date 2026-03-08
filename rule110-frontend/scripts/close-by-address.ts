/**
 * close-by-address.ts
 *
 * Closes any CA tile account by explicit address.
 * Use this when the PDA seed has changed and the old account
 * is at a different address than the new seed would derive.
 *
 * Usage:
 *   ts-node close-by-address.ts <account_address>
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
const CLOSE_DISC = Buffer.from([125, 255, 149, 14, 110, 34, 72, 24])

const keypairPath = `${os.homedir()}/.config/solana/id.json`
const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf-8')))
)

const address = process.argv[2]
if (!address) {
  console.error('Usage: ts-node close-by-address.ts <account_address>')
  process.exit(1)
}

const accountPubkey = new PublicKey(address)
console.log(`Authority: ${keypair.publicKey.toBase58()}`)
console.log(`Account:   ${accountPubkey.toBase58()}`)

async function main() {
  const connection = new Connection(RPC_URL, 'confirmed')

  const existing = await connection.getAccountInfo(accountPubkey)
  if (!existing) {
    console.log('Account does not exist.')
    return
  }
  console.log(`Size: ${existing.data.length} bytes, owner: ${existing.owner.toBase58()}`)

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accountPubkey,       isSigner: false, isWritable: true },
      { pubkey: keypair.publicKey,   isSigner: true,  isWritable: true },
    ],
    data: CLOSE_DISC,
  })

  const tx = new Transaction().add(ix)
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' })
    console.log('✓ Closed:', sig)
  } catch (err: any) {
    console.error('✗ Failed:', err.message ?? err)
    if (err.logs) console.error('Logs:', err.logs)
  }
}

main()
