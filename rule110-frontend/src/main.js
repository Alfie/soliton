/**
 * main.js — application entry point
 *
 * Responsibilities:
 *   1. Mount the Elm app
 *   2. Initialise the Solana bridge with the Elm app reference
 *   3. Intercept accountUpdated.send to drive canvas rendering
 */

import { Elm } from './elm/Main.elm'
import { initSolanaBridge } from './solana-bridge.js'
import { drawGenerations, scrollToLatest } from './canvas.js'

// ================================================================
// 1. Mount Elm
// ================================================================

const app = Elm.Main.init({
  node: document.getElementById('app'),
})

// ================================================================
// 2. Wire canvas rendering
//
// accountUpdated is an incoming port (JS → Elm), so it has .send()
// not .subscribe(). We intercept .send() here to drive the canvas
// before the value is forwarded into Elm.
// ================================================================

const canvas = document.getElementById('rule110-canvas')
let generations = []

const originalSend = app.ports.accountUpdated.send.bind(app.ports.accountUpdated)
app.ports.accountUpdated.send = (row) => {
  generations = [...generations, row].slice(-200)
  drawGenerations(canvas, generations)
  scrollToLatest(canvas)
  originalSend(row)  // forward to Elm as normal
}

// ================================================================
// 3. Initialise the Solana bridge
//    (must come after the send intercept is in place)
// ================================================================

initSolanaBridge(app)
