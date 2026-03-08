/**
 * canvas.js — Rule 110 spacetime diagram renderer
 *
 * Visual style: phosphor terminal / oscilloscope
 * - Deep black background
 * - Amber glow on live cells
 * - Smooth fade-in for new rows
 * - Generation counter overlay
 */

// Visual constants — phosphor terminal aesthetic
const CELL_SIZE     = 12    // pixels per cell (increased for visibility)
const COLOR_ALIVE   = '#f0a500'   // amber phosphor
const COLOR_DEAD    = '#16162a'   // very dark, almost black
const COLOR_BG      = '#07070d'   // deep black
const GLOW_COLOR    = 'rgba(240, 165, 0, 0.4)'  // amber glow
const GLOW_RADIUS   = 3

// Animation state
let lastDrawnGeneration = 0

/**
 * Draw the full spacetime diagram with visual enhancements.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {boolean[][]}       generations  - array of rows, oldest first
 */
export function drawGenerations(canvas, generations) {
  if (!canvas || generations.length === 0) return
  console.log('drawGenerations called:', canvas?.id, generations.length, 'rows')
  if (!canvas || generations.length === 0) return

  const ctx = canvas.getContext('2d')

  // Resize canvas to fit current content
  const width  = (generations[0]?.length ?? 0) * CELL_SIZE
  const height = generations.length * CELL_SIZE
  
  // Only resize if dimensions changed (avoids flicker)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width  = width
    canvas.height = height
  }

  // Clear background
  ctx.fillStyle = COLOR_BG
  ctx.fillRect(0, 0, width, height)

  // Detect if we have a new generation (for fade-in animation)
  const hasNewRow = generations.length > lastDrawnGeneration
  const newRowIndex = generations.length - 1

  // Draw each generation
  generations.forEach((row, rowIndex) => {
    const isNewRow = hasNewRow && rowIndex === newRowIndex

    row.forEach((cell, colIndex) => {
      const x = colIndex * CELL_SIZE
      const y = rowIndex * CELL_SIZE

      if (cell) {
        // Live cell — draw with glow effect
        drawLiveCell(ctx, x, y, isNewRow)
      } else {
        // Dead cell — subtle dark square
        ctx.fillStyle = COLOR_DEAD
        ctx.fillRect(x, y, CELL_SIZE - 1, CELL_SIZE - 1)
      }
    })
  })

  // Draw generation counter overlay (bottom-right)
  drawGenerationCounter(ctx, width, height, generations.length)

  lastDrawnGeneration = generations.length
}

/**
 * Draw a live cell with phosphor glow effect.
 */
function drawLiveCell(ctx, x, y, isNew) {
  const size = CELL_SIZE - 1

  // Outer glow (only for live cells)
  ctx.shadowBlur = GLOW_RADIUS * 2
  ctx.shadowColor = GLOW_COLOR
  
  // Cell body
  ctx.fillStyle = COLOR_ALIVE
  ctx.fillRect(x, y, size, size)
  
  // Reset shadow for next draw
  ctx.shadowBlur = 0

  // Subtle inner highlight for depth
  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)'
  ctx.fillRect(x + 1, y + 1, Math.max(1, size - 4), Math.max(1, size - 4))

  // Fade-in animation for new row (optional, adds polish)
  if (isNew) {
    // This could be enhanced with requestAnimationFrame for smooth fade
    // For now, the immediate draw is fine
  }
}

/**
 * Draw generation counter in bottom-right corner.
 */
function drawGenerationCounter(ctx, canvasWidth, canvasHeight, count) {
  const text = `gen ${count}`
  const padding = 8

  // Measure text
  ctx.font = '10px "Azeret Mono", monospace'
  const metrics = ctx.measureText(text)
  const textWidth = metrics.width

  const x = canvasWidth - textWidth - padding
  const y = canvasHeight - padding

  // Semi-transparent background
  ctx.fillStyle = 'rgba(7, 7, 13, 0.7)'
  ctx.fillRect(
    x - 4,
    y - 12,
    textWidth + 8,
    16
  )

  // Text
  ctx.fillStyle = 'rgba(240, 165, 0, 0.6)'  // dimmed amber
  ctx.fillText(text, x, y)
}

/**
 * Scroll the canvas so the latest generation is always visible.
 */
export function scrollToLatest(canvas) {
  if (!canvas) return
  
  // Smooth scroll to bottom
  const wrapper = canvas.parentElement
  if (wrapper && wrapper.classList.contains('canvas-wrapper')) {
    wrapper.scrollIntoView({ behavior: 'smooth', block: 'end' })
  } else {
    canvas.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }
}
