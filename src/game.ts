import {
  OnChanged,
  createWorld,
  defineEvent,
  entry,
  type Entity,
  type World,
  type WorldSnapshot,
} from '@domecs/core'
import {
  BoardCell,
  EvalStats,
  GameState,
  Mobility,
  Piece,
  Selection,
  type HexCoord,
  type MoveCommand,
  type MoveRecord,
  type TesseraCommand,
} from './components.js'

export interface TesseraOptions {
  seed?: number
  playerCount?: 2 | 3 | 4
  radius?: number
  targetScore?: number
  clockInitialMs?: number
  headless?: boolean
}

export interface TesseraRefs {
  world: World
  gameId: Entity
  cellIds: readonly Entity[]
  pieceIds: readonly Entity[]
  history: TesseraHistory
  submit(command: TesseraCommand): boolean
  undo(): boolean
  redo(): boolean
}

export interface TesseraHistory {
  snapshots: WorldSnapshot[]
  cursor: number
}

export interface LegalMove {
  pieceId: Entity
  from: HexCoord
  to: HexCoord
  captureId: Entity | null
}

export interface TesseraReplay {
  version: 1
  seed: number
  playerCount: 2 | 3 | 4
  radius: number
  targetScore: number
  clockInitialMs: number
  moves: TesseraCommand[]
}

export const CommandEvent = defineEvent<TesseraCommand>('TesseraCommand')

const DEFAULT_SEED = 0x7e55_e4a
const PIECES_PER_PLAYER = 5
const DIRECTIONS: readonly HexCoord[] = Object.freeze([
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
])

export function createTessera(options: TesseraOptions = {}): TesseraRefs {
  const seed = normalizeSeed(options.seed ?? DEFAULT_SEED)
  const playerCount = options.playerCount ?? 2
  const radius = options.radius ?? 4
  const targetScore = options.targetScore ?? 6
  const clockInitialMs = options.clockInitialMs ?? 4 * 60_000
  const world = createWorld({ seed, headless: options.headless ?? false, idle: true })
  const cellIds: Entity[] = []
  const pieceIds: Entity[] = []
  const cellByKey = new Map<string, Entity>()
  const history: TesseraHistory = { snapshots: [], cursor: 0 }
  let pendingHistorySnapshot = false

  const gameId = world.spawn([
    entry(GameState, GameState.create({
      seed,
      radius,
      playerCount,
      targetScore,
      clockInitialMs,
      currentPlayer: world.rand.uniformInt(playerCount),
      clocks: Array.from({ length: playerCount }, () => clockInitialMs),
      scores: Array.from({ length: playerCount }, () => 0),
      moveLog: [],
    })),
    entry(EvalStats, EvalStats.create()),
    entry(Selection, Selection.create()),
  ]);

  for (const coord of allCoords(radius)) {
    const homePlayer = homePlayerFor(coord, radius, playerCount)
    const kind = coord.q === 0 && coord.r === 0 ? 'sanctum' : homePlayer === null ? 'normal' : 'home'
    const cellId = world.spawn([
      entry(BoardCell, BoardCell.create({
        ...coord,
        s: -coord.q - coord.r,
        kind,
        homePlayer,
        occupantId: null,
        ...screenFor(coord, radius),
      })),
    ])
    cellIds.push(cellId)
    cellByKey.set(key(coord.q, coord.r), cellId)
  }

  for (let player = 0; player < playerCount; player++) {
    const starts = homeCoords(player, radius).slice(0, PIECES_PER_PLAYER)
    for (let i = 0; i < starts.length; i++) {
      const coord = starts[i]
      if (!coord) continue
      const cellId = cellByKey.get(key(coord.q, coord.r))
      if (cellId === undefined) continue
      const pieceId = world.spawn([
        entry(Piece, Piece.create({ owner: player, index: i, kind: i === 2 ? 'crown' : 'tessera', q: coord.q, r: coord.r })),
        entry(Mobility, Mobility.create()),
      ])
      pieceIds.push(pieceId)
      const cell = world.getComponent(cellId, BoardCell)
      if (cell) cell.occupantId = pieceId
    }
  }

  refreshAllMobility()

  world.system('tessera-command-resolution', { schedule: 'event', triggers: [CommandEvent], priority: 10 }, (ctx) => {
    for (const command of ctx.events.of(CommandEvent)) {
      const accepted = applyCommand(command)
      if (accepted) pendingHistorySnapshot = true
    }
  });

  world.system('headless-ai-eval-delta', { query: OnChanged(Piece), schedule: 'reactive', reactsTo: OnChanged(Piece), priority: 20 }, (ctx) => {
    const stats = world.getComponent(gameId, EvalStats)
    if (!stats) return
    let changed = 0
    for (const entity of ctx.entities as Array<{ id: Entity }>) {
      changed += 1
      refreshMobility(entity.id)
    }
    if (changed > 0) {
      stats.changedPieceUpdates += changed
      stats.lastChangedPieces = changed
      stats.lastMobilityTotal = totalMobility()
      world.markChanged(gameId, EvalStats)
    }
  });

  world.signals.tickEnd.subscribe(() => {
    if (!pendingHistorySnapshot) return
    pendingHistorySnapshot = false
    recordSnapshot()
  })

  recordSnapshot()

  const refs: TesseraRefs = {
    world,
    gameId,
    cellIds,
    pieceIds,
    history,
    submit(command) { return submitCommand(refs, command) },
    undo() { return restoreAt(history.cursor - 1) },
    redo() { return restoreAt(history.cursor + 1) },
  }

  function applyCommand(command: TesseraCommand): boolean {
    const game = world.getComponent(gameId, GameState)
    if (!game) return false
    if (game.status !== 'playing') return reject(game, 'game is over')

    const player = game.currentPlayer
    if (command.kind === 'pass') {
      spendClock(game, player, command.spentMs ?? 0)
      if (game.status === 'playing') advanceTurn(game)
      game.moveLog.push(makeRecord(game, player, cloneCommand(command), [], 'pass'))
      game.lastError = ''
      game.turn += 1
      world.markChanged(gameId, GameState)
      return true
    }

    const verdict = validateMove(game, command)
    if (typeof verdict === 'string') return reject(game, verdict)

    const piece = world.getComponent(command.pieceId, Piece)
    const targetCell = world.getComponent(verdict.toCellId, BoardCell)
    if (!piece || !targetCell) return reject(game, 'move target disappeared')

    spendClock(game, player, command.spentMs ?? 0)
    if (game.status !== 'playing') {
      game.moveLog.push(makeRecord(game, player, cloneCommand(command), [], 'flag fall'))
      game.lastError = ''
      game.turn += 1
      world.markChanged(gameId, GameState)
      return true
    }

    const captures: Entity[] = []
    const fromCellId = findCellIdInMap(piece.q, piece.r)
    const fromCell = fromCellId === null ? undefined : world.getComponent(fromCellId, BoardCell)
    if (fromCell) {
      fromCell.occupantId = null
      world.markChanged(fromCellId!, BoardCell)
    }

    if (targetCell.occupantId !== null) {
      capturePiece(targetCell.occupantId, player, captures)
    }

    piece.q = command.to.q
    piece.r = command.to.r
    targetCell.occupantId = command.pieceId
    world.markChanged(command.pieceId, Piece)
    world.markChanged(verdict.toCellId, BoardCell)

    for (const victim of surroundedEnemies(player)) capturePiece(victim, player, captures)

    if (piece.q === 0 && piece.r === 0) {
      game.scores[player] = (game.scores[player] ?? 0) + 1
    }
    game.scores[player] = (game.scores[player] ?? 0) + captures.length

    checkVictory(game, player)
    if (game.status === 'playing') advanceTurn(game)

    game.moveLog.push(makeRecord(game, player, cloneCommand(command), captures, captures.length > 0 ? `captured ${captures.length}` : 'move'))
    game.lastError = ''
    game.turn += 1
    world.markChanged(gameId, GameState)
    return true
  }

  function validateMove(game: ReturnType<typeof GameState.create>, command: MoveCommand): { toCellId: Entity } | string {
    const piece = world.getComponent(command.pieceId, Piece)
    if (!piece || !piece.active) return 'piece is not active'
    if (piece.owner !== game.currentPlayer) return 'not this player\'s piece'
    const toCellId = findCellIdInMap(command.to.q, command.to.r)
    if (toCellId === null) return 'target is off board'
    if (hexDistance(piece, command.to) !== 1) return 'pieces move exactly one adjacent hex'
    const cell = world.getComponent(toCellId, BoardCell)
    if (!cell) return 'target cell missing'
    if (cell.occupantId !== null) {
      const occupant = world.getComponent(cell.occupantId, Piece)
      if (occupant?.active && occupant.owner === piece.owner) return 'target is occupied by an allied piece'
    }
    return { toCellId }
  }

  function reject(game: ReturnType<typeof GameState.create>, message: string): false {
    game.lastError = message
    world.markChanged(gameId, GameState)
    return false
  }

  function capturePiece(pieceId: Entity, player: number, captures: Entity[]): void {
    const victim = world.getComponent(pieceId, Piece)
    if (!victim || !victim.active || victim.owner === player) return
    const cellId = findCellIdInMap(victim.q, victim.r)
    const cell = cellId === null ? undefined : world.getComponent(cellId, BoardCell)
    if (cell?.occupantId === pieceId) {
      cell.occupantId = null
      world.markChanged(cellId!, BoardCell)
    }
    victim.active = false
    victim.capturedBy = player
    world.markChanged(pieceId, Piece)
    captures.push(pieceId)
  }

  function surroundedEnemies(player: number): Entity[] {
    const out: Entity[] = []
    for (const id of pieceIds) {
      const piece = world.getComponent(id, Piece)
      if (!piece || !piece.active || piece.owner === player) continue
      let adjacentAllies = 0
      for (const n of neighbors(piece)) {
        const cellId = findCellIdInMap(n.q, n.r)
        if (cellId === null) continue
        const cell = world.getComponent(cellId, BoardCell)
        if (cell?.occupantId === null || cell?.occupantId === undefined) continue
        const other = world.getComponent(cell.occupantId, Piece)
        if (other?.active && other.owner === player) adjacentAllies += 1
      }
      if (adjacentAllies >= 3) out.push(id)
    }
    return out.sort((a, b) => a - b)
  }

  function spendClock(game: ReturnType<typeof GameState.create>, player: number, spentMs: number): void {
    const spent = Math.max(0, Math.trunc(spentMs))
    game.clocks[player] = Math.max(0, (game.clocks[player] ?? 0) - spent)
    if ((game.clocks[player] ?? 0) <= 0) {
      game.status = 'timeout'
      game.winnerId = nextPlayerWithPieces(player)
    }
  }

  function checkVictory(game: ReturnType<typeof GameState.create>, player: number): void {
    if ((game.scores[player] ?? 0) >= game.targetScore) {
      game.status = 'won'
      game.winnerId = player
      return
    }
    const opponents = activePlayers().filter((p) => p !== player)
    if (opponents.length === 0) {
      game.status = 'won'
      game.winnerId = player
    }
  }

  function advanceTurn(game: ReturnType<typeof GameState.create>): void {
    const active = activePlayers()
    if (active.length <= 1) {
      game.status = 'won'
      game.winnerId = active[0] ?? game.currentPlayer
      return
    }
    for (let i = 1; i <= game.playerCount; i++) {
      const next = (game.currentPlayer + i) % game.playerCount
      if (active.includes(next)) {
        game.currentPlayer = next
        return
      }
    }
  }

  function activePlayers(): number[] {
    const active = new Set<number>()
    for (const id of pieceIds) {
      const piece = world.getComponent(id, Piece)
      if (piece?.active) active.add(piece.owner)
    }
    return Array.from(active).sort((a, b) => a - b)
  }

  function nextPlayerWithPieces(afterPlayer: number): number {
    const active = activePlayers().filter((p) => p !== afterPlayer)
    return active[0] ?? afterPlayer
  }

  function makeRecord(
    game: ReturnType<typeof GameState.create>,
    player: number,
    command: TesseraCommand,
    captures: Entity[],
    note: string,
  ): MoveRecord {
    return {
      ply: game.turn,
      player,
      command,
      captures: captures.slice(),
      scoreAfter: game.scores.slice(),
      clocks: game.clocks.slice(),
      note,
    }
  }

  function refreshAllMobility(): void {
    for (const id of pieceIds) refreshMobility(id)
  }

  function refreshMobility(pieceId: Entity): void {
    const mobility = world.getComponent(pieceId, Mobility)
    if (!mobility) return
    const moves = legalMovesForPieceId(pieceId)
    mobility.moves = moves.length
    mobility.captures = moves.reduce((n, m) => n + (m.captureId !== null ? 1 : 0), 0)
    mobility.tacticalValue = mobility.moves + mobility.captures * 3
    world.markChanged(pieceId, Mobility)
  }

  function totalMobility(): number {
    let total = 0
    for (const id of pieceIds) total += world.getComponent(id, Mobility)?.moves ?? 0
    return total
  }

  function legalMovesForPieceId(pieceId: Entity): LegalMove[] {
    const piece = world.getComponent(pieceId, Piece)
    if (!piece || !piece.active) return []
    const out: LegalMove[] = []
    for (const to of neighbors(piece)) {
      const cellId = findCellIdInMap(to.q, to.r)
      if (cellId === null) continue
      const cell = world.getComponent(cellId, BoardCell)
      if (!cell) continue
      if (cell.occupantId === null) {
        out.push({ pieceId, from: { q: piece.q, r: piece.r }, to, captureId: null })
      } else {
        const other = world.getComponent(cell.occupantId, Piece)
        if (other?.active && other.owner !== piece.owner) {
          out.push({ pieceId, from: { q: piece.q, r: piece.r }, to, captureId: cell.occupantId })
        }
      }
    }
    return out.sort(compareMoves)
  }

  function findCellIdInMap(q: number, r: number): Entity | null {
    return cellByKey.get(key(q, r)) ?? null
  }

  function recordSnapshot(): void {
    if (history.cursor < history.snapshots.length - 1) history.snapshots.splice(history.cursor + 1)
    history.snapshots.push(world.snapshot())
    history.cursor = history.snapshots.length - 1
  }

  function restoreAt(index: number): boolean {
    if (index < 0 || index >= history.snapshots.length) return false
    const snapshot = history.snapshots[index]
    if (!snapshot) return false
    world.restore(snapshot)
    history.cursor = index
    return true
  }

  return refs
}

export function submitCommand(refs: TesseraRefs, command: TesseraCommand): boolean {
  const before = refs.world.getComponent(refs.gameId, GameState)?.moveLog.length ?? 0
  refs.world.turn(CommandEvent, cloneCommand(command))
  const after = refs.world.getComponent(refs.gameId, GameState)?.moveLog.length ?? 0
  return after > before
}

export function legalMovesForPiece(refs: TesseraRefs, pieceId: Entity): LegalMove[] {
  const piece = refs.world.getComponent(pieceId, Piece)
  if (!piece || !piece.active) return []
  const out: LegalMove[] = []
  for (const to of neighbors(piece)) {
    const cellId = findCellId(refs, to.q, to.r)
    if (cellId === null) continue
    const cell = refs.world.getComponent(cellId, BoardCell)
    if (!cell) continue
    if (cell.occupantId === null) out.push({ pieceId, from: { q: piece.q, r: piece.r }, to, captureId: null })
    else {
      const other = refs.world.getComponent(cell.occupantId, Piece)
      if (other?.active && other.owner !== piece.owner) {
        out.push({ pieceId, from: { q: piece.q, r: piece.r }, to, captureId: cell.occupantId })
      }
    }
  }
  return out.sort(compareMoves)
}

export function findCellId(refs: Pick<TesseraRefs, 'world' | 'cellIds'>, q: number, r: number): Entity | null {
  for (const id of refs.cellIds) {
    const cell = refs.world.getComponent(id, BoardCell)
    if (cell?.q === q && cell.r === r) return id
  }
  return null
}

export function exportReplay(refs: TesseraRefs): TesseraReplay {
  const game = refs.world.getComponent(refs.gameId, GameState)
  if (!game) throw new Error('Tessera game state is missing')
  return {
    version: 1,
    seed: game.seed,
    playerCount: game.playerCount as 2 | 3 | 4,
    radius: game.radius,
    targetScore: game.targetScore,
    clockInitialMs: game.clockInitialMs,
    moves: game.moveLog.map((record) => cloneCommand(record.command)),
  }
}

export function rebuildFromReplay(replay: TesseraReplay, options: { headless?: boolean } = {}): TesseraRefs {
  const refs = createTessera({
    seed: replay.seed,
    playerCount: replay.playerCount,
    radius: replay.radius,
    targetScore: replay.targetScore,
    clockInitialMs: replay.clockInitialMs,
    headless: options.headless ?? true,
  })
  for (const move of replay.moves) {
    if (!submitCommand(refs, cloneCommand(move))) {
      const game = refs.world.getComponent(refs.gameId, GameState)
      throw new Error(`Replay rejected move ${game?.moveLog.length ?? 0}: ${game?.lastError ?? 'unknown error'}`)
    }
  }
  return refs
}

export function snapshotHash(snapshot: WorldSnapshot): string {
  return JSON.stringify(snapshot)
}

export function allCoords(radius: number): HexCoord[] {
  const out: HexCoord[] = []
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius)
    const r2 = Math.min(radius, -q + radius)
    for (let r = r1; r <= r2; r++) out.push({ q, r })
  }
  return out.sort((a, b) => a.r - b.r || a.q - b.q)
}

export function hexDistance(a: HexCoord, b: HexCoord): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2
}

export function neighbors(coord: HexCoord): HexCoord[] {
  return DIRECTIONS.map((d) => ({ q: coord.q + d.q, r: coord.r + d.r }))
}

export function cloneCommand(command: TesseraCommand): TesseraCommand {
  if (command.kind === 'pass') return { kind: 'pass', spentMs: command.spentMs }
  return { kind: 'move', pieceId: command.pieceId, to: { q: command.to.q, r: command.to.r }, spentMs: command.spentMs }
}

function normalizeSeed(seed: number): number {
  return (Math.trunc(seed) >>> 0) || DEFAULT_SEED
}

function key(q: number, r: number): string {
  return `${q},${r}`
}

function compareMoves(a: LegalMove, b: LegalMove): number {
  return a.to.r - b.to.r || a.to.q - b.to.q || (a.captureId ?? -1) - (b.captureId ?? -1)
}

function homePlayerFor(coord: HexCoord, radius: number, playerCount: number): number | null {
  for (let player = 0; player < playerCount; player++) {
    if (homeCoords(player, radius).some((c) => c.q === coord.q && c.r === coord.r)) return player
  }
  return null
}

function homeCoords(player: number, radius: number): HexCoord[] {
  const coords: HexCoord[] = []
  if (player === 0) {
    for (let q = 0; q <= radius; q++) coords.push({ q, r: -radius })
  } else if (player === 1) {
    for (let q = -radius; q <= 0; q++) coords.push({ q, r: radius })
  } else if (player === 2) {
    for (let r = 0; r <= radius; r++) coords.push({ q: -radius, r })
  } else {
    for (let r = -radius; r <= 0; r++) coords.push({ q: radius, r })
  }
  return coords.sort((a, b) => a.r - b.r || a.q - b.q)
}

function screenFor(coord: HexCoord, radius: number): { x: number; y: number } {
  const size = 44
  return {
    x: 420 + (coord.q + coord.r / 2) * size * 1.55,
    y: 320 + coord.r * size * 1.34 + radius * 2,
  }
}
