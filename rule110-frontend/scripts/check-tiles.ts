import { Connection, PublicKey } from '@solana/web3.js'

const RPC_URL = 'https://api.devnet.solana.com'
const TILES = {
  0: '2KecrG5zbFAPcxy9YU6EDz2AUHAtFB4kAuThVUTxuAA4',
  1: 'dBhSsk6EhC94ZQT6C1z4Yid7VF21AA35hXd2vCcf1VL',
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed')
  for (const [id, addr] of Object.entries(TILES)) {
    const info = await conn.getAccountInfo(new PublicKey(addr))
    if (!info) { console.log(`Tile ${id}: not found`); continue }
    const d = info.data
    const tileId = d[8]
    const width  = d[9]
    let cells = 0n
    for (let i = 0; i < 8; i++) cells |= BigInt(d[10+i]) << BigInt(i*8)
    let gen = 0n
    for (let i = 0; i < 8; i++) gen |= BigInt(d[20+i]) << BigInt(i*8)
    const bump = d[28]
    const leftTag  = d[29]
    const rightTag = d[62]
    const histHead = d[95]
    const owner = info.owner.toBase58()
    const delegated = owner !== 'CeGAuNrH9jMpyNrSZ9WzxNR9SAfpU3LtCduSQJhkr2tQ'

    console.log(`\nTile ${id} (${addr})`)
    console.log(`  owner:        ${owner}${delegated ? ' *** DELEGATED ***' : ''}`)
    console.log(`  tile_id:      ${tileId}`)
    console.log(`  width:        ${width}`)
    console.log(`  generation:   ${gen}`)
    console.log(`  bump:         ${bump}`)
    console.log(`  left_neighbor:  ${leftTag === 1 ? 'Some' : 'None'}`)
    console.log(`  right_neighbor: ${rightTag === 1 ? 'Some' : 'None'}`)
    console.log(`  history_head:   ${histHead}`)
    const row = Array.from({length: width}, (_,i) => ((cells >> BigInt(i)) & 1n) ? '█' : '·').join('')
    console.log(`  pattern:      ${row}`)
  }
}
main().catch(console.error)
