/**
 * main.js — application entry point
 *
 * Responsibilities:
 *   1. Mount the Elm app
 *   2. Initialise the Solana bridge with the Elm app reference
 *   3. Intercept port sends to drive canvas rendering
 */

import { Elm } from './elm/Main.elm'
import { initSolanaBridge } from './solana-bridge.js'
import { drawGenerations, scrollToLatest } from './canvas.js'

// ================================================================
// 1. Mount Elm
// ================================================================

// Elm owns #app. We own #js-canvas — a canvas Elm never knows about.
// Elm re-renders its subtree on every model update, resetting any canvas
// pixels inside its DOM. By keeping our canvas outside #app entirely,
// Elm can never clear it.
const appNode = document.getElementById('app')

// Create our JS-owned canvas before Elm mounts, inserted as a sibling
// of #app so it's outside Elm's virtual DOM subtree entirely.
const jsCanvas = document.createElement('canvas')
jsCanvas.id = 'js-canvas'
jsCanvas.className = 'canvas-wrapper'
jsCanvas.style.display = 'block'
jsCanvas.style.width = '100%'
appNode.parentElement.insertBefore(jsCanvas, appNode.nextSibling)

const app = Elm.Main.init({
  node: appNode,
})

// ================================================================
// 2. Wire canvas rendering
//
// We intercept .send() on incoming ports (JS → Elm) to drive the
// canvas before the value is forwarded into Elm.
// ================================================================

let generations = []

// Always return our JS-owned canvas — never Elm's canvas
function getCanvas() {
  return jsCanvas
}

// Single new row arriving via WS — append and repaint
const originalAccountUpdated = app.ports.accountUpdated.send.bind(app.ports.accountUpdated)
app.ports.accountUpdated.send = (row) => {
  // Only append if this generation is newer than what we have
  // (prevents WS reconnect replaying old state)
  const lastGen = generations.length
  generations = [...generations, row].slice(-200)
  console.log('accountUpdated: generations', lastGen, '→', generations.length)
  drawGenerations(getCanvas(), generations)
  scrollToLatest(getCanvas())
  originalAccountUpdated(row)
}

// Full history on wallet connect — only reset if history is longer than
// what we already have (prevents ER session WS reconnect wiping live rows)
const originalHistoryLoaded = app.ports.historyLoaded.send.bind(app.ports.historyLoaded)
app.ports.historyLoaded.send = (rows) => {
  console.log('historyLoaded:', rows.length, 'rows, current:', generations.length)
  if (rows.length >= generations.length) {
    generations = rows.slice(-200)
    drawGenerations(getCanvas(), generations)
    scrollToLatest(getCanvas())
  } else {
    console.log('historyLoaded: skipping — already have more rows in memory')
  }
  originalHistoryLoaded(rows)
}

// ================================================================
// 3. Initialise the Solana bridge
//    (must come after the send intercepts are in place)
// ================================================================

initSolanaBridge(app)
