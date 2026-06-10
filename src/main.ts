import { Has, type Entity } from '@domecs/core'
import { defineView, mountDOM } from '@domecs/dom'
import {
  BoardCell,
  EvalStats,
  GameState,
  Mobility,
  Piece,
  exportReplay,
  findCellId,
  legalMovesForPiece,
  snapshotHash,
  createTessera,
} from './index.js'

const board = must('board')
const playersEl = must('players')
const statusEl = must('status')
const chromeEl = must('chrome')
const logEl = must('log')
const replayEl = must('replay') as HTMLTextAreaElement

const refs = createTessera({ seed: 0x7e55e4a, playerCount: 2 })
let selectedPieceId: Entity | null = null
let turnStartedAt = performance.now()

const cellView = defineView({
  slot: 'board',
  query: Has(BoardCell),
  changedOn: { mode: 'explicit', types: [BoardCell] },
  create(entity) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'hex cell'
    el.addEventListener('click', () => onCellClick(entity.id))
    paintCell(el, entity.id)
    return el
  },
  update(el, entity) { paintCell(el, entity.id) },
});

const pieceView = defineView({
  slot: 'board',
  query: Has(Piece),
  changedOn: { mode: 'explicit', types: [Piece, Mobility] },
  create(entity) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'hex piece'
    el.addEventListener('click', (event) => {
      event.stopPropagation()
      onPieceClick(entity.id)
    })
    paintPiece(el, entity.id)
    return el
  },
  update(el, entity) { paintPiece(el, entity.id) },
});

const mountResult = mountDOM(refs.world, { slots: { board }, views: [cellView, pieceView] })
if (!mountResult.ok) {
  throw new Error(`Tessera failed to mount DOM: ${mountResult.error.kind}`)
}

refs.world.signals.tickEnd.subscribe(() => paintHud())

const undoButton = must('undo') as HTMLButtonElement
const redoButton = must('redo') as HTMLButtonElement

undoButton.addEventListener('click', () => {
  if (refs.undo()) {
    selectedPieceId = null
    turnStartedAt = performance.now()
    refs.world.step(0)
    paintHud()
  }
})

redoButton.addEventListener('click', () => {
  if (refs.redo()) {
    selectedPieceId = null
    turnStartedAt = performance.now()
    refs.world.step(0)
    paintHud()
  }
})

must('pass').addEventListener('click', () => {
  submit({ kind: 'pass', spentMs: spentMs() })
})

must('copy-replay').addEventListener('click', async () => {
  const json = JSON.stringify(exportReplay(refs), null, 2)
  replayEl.value = json
  await navigator.clipboard?.writeText(json).catch(() => undefined)
})

refs.world.step(0)
paintHud()

function onPieceClick(pieceId: Entity): void {
  const game = refs.world.getComponent(refs.gameId, GameState)
  const piece = refs.world.getComponent(pieceId, Piece)
  if (!game || !piece?.active) return
  if (piece.owner === game.currentPlayer) {
    selectedPieceId = pieceId
    paintHud()
    return
  }
  if (selectedPieceId !== null) submitMoveTo(piece.q, piece.r)
}

function onCellClick(cellId: Entity): void {
  const cell = refs.world.getComponent(cellId, BoardCell)
  if (!cell) return
  if (cell.occupantId !== null) {
    onPieceClick(cell.occupantId)
    return
  }
  if (selectedPieceId !== null) submitMoveTo(cell.q, cell.r)
}

function submitMoveTo(q: number, r: number): void {
  if (selectedPieceId === null) return
  submit({ kind: 'move', pieceId: selectedPieceId, to: { q, r }, spentMs: spentMs() })
}

function submit(command: Parameters<typeof refs.submit>[0]): void {
  const accepted = refs.submit(command)
  selectedPieceId = null
  if (accepted) turnStartedAt = performance.now()
  refs.world.step(0)
  paintHud()
}

function paintCell(el: HTMLElement, id: Entity): void {
  const cell = refs.world.getComponent(id, BoardCell)
  if (!cell) return
  el.dataset.cell = String(id)
  el.className = `hex cell ${cell.kind} ${cell.occupantId === null ? 'empty' : 'occupied'}`
  el.style.left = `${cell.x}px`
  el.style.top = `${cell.y}px`
  el.textContent = cell.kind === 'sanctum' ? '✦' : ''
  el.title = `q${cell.q}, r${cell.r}${cell.homePlayer !== null ? ` · P${cell.homePlayer + 1} home` : ''}`
}

function paintPiece(el: HTMLElement, id: Entity): void {
  const piece = refs.world.getComponent(id, Piece)
  const mobility = refs.world.getComponent(id, Mobility)
  if (!piece) return
  const cellId = findCellId(refs, piece.q, piece.r)
  const cell = cellId === null ? null : refs.world.getComponent(cellId, BoardCell)
  el.dataset.piece = String(id)
  el.className = `hex piece p${piece.owner} ${piece.kind} ${piece.active ? 'active' : 'captured'} ${selectedPieceId === id ? 'selected' : ''}`
  el.style.left = `${cell?.x ?? -200}px`
  el.style.top = `${cell?.y ?? -200}px`
  el.textContent = piece.kind === 'crown' ? '◆' : '●'
  el.title = `P${piece.owner + 1} ${piece.kind} · moves ${mobility?.moves ?? 0} · captures ${mobility?.captures ?? 0}`
}

function paintHud(): void {
  updateSelectionClasses()
  undoButton.disabled = !refs.history.canUndo()
  redoButton.disabled = !refs.history.canRedo()
  const game = refs.world.getComponent(refs.gameId, GameState)
  const stats = refs.world.getComponent(refs.gameId, EvalStats)
  if (!game || !stats) return
  playersEl.innerHTML = game.scores.map((score, player) => `
    <div class="player-card ${player === game.currentPlayer && game.status === 'playing' ? 'current' : ''} p${player}">
      <span>Player ${player + 1}</span>
      <strong>${score}/${game.targetScore}</strong>
      <em>${formatClock(game.clocks[player] ?? 0)}</em>
    </div>
  `).join('')
  statusEl.innerHTML = game.status === 'playing'
    ? `<strong>Turn ${game.turn + 1}</strong><br>Player ${game.currentPlayer + 1} to move${selectedPieceId !== null ? `<br>Selected piece ${selectedPieceId}` : ''}${game.lastError ? `<br><b class="bad">${escapeHtml(game.lastError)}</b>` : ''}`
    : `<strong>Game over</strong><br>${game.status}: Player ${(game.winnerId ?? 0) + 1} wins`
  logEl.innerHTML = game.moveLog.slice(-12).map((record) => `<li><b>P${record.player + 1}</b> ${escapeHtml(record.note)} <code>${escapeHtml(commandText(record.command))}</code></li>`).join('')
  replayEl.value = JSON.stringify(exportReplay(refs), null, 2)
  chromeEl.textContent = `tick ${refs.world.time.tick} · history ${refs.history.index + 1}/${refs.history.length} · changed pieces ${stats.changedPieceUpdates} · hash ${snapshotHash(refs.world.snapshot()).length} bytes`
}

function updateSelectionClasses(): void {
  for (const el of board.querySelectorAll<HTMLElement>('[data-piece]')) {
    el.classList.toggle('selected', Number(el.dataset.piece) === selectedPieceId)
  }
  for (const el of board.querySelectorAll<HTMLElement>('[data-cell]')) el.classList.remove('legal')
  if (selectedPieceId === null) return
  for (const move of legalMovesForPiece(refs, selectedPieceId)) {
    const cellId = findCellId(refs, move.to.q, move.to.r)
    if (cellId === null) continue
    board.querySelector<HTMLElement>(`[data-cell="${cellId}"]`)?.classList.add('legal')
  }
}

function spentMs(): number {
  return Math.max(1, Math.round(performance.now() - turnStartedAt))
}

function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60).toString().padStart(2, '0')
  const s = (total % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

function commandText(command: Parameters<typeof refs.submit>[0]): string {
  if (command.kind === 'pass') return 'pass'
  return `${command.pieceId} → ${command.to.q},${command.to.r}`
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function must(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el
}
