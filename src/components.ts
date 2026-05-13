import { defineComponent, type Entity } from 'domecs'

export type PlayerId = 0 | 1 | 2 | 3
export type GameStatus = 'playing' | 'won' | 'timeout'
export type PieceKind = 'tessera' | 'crown'
export type CellKind = 'normal' | 'home' | 'sanctum'

export interface HexCoord {
  q: number
  r: number
}

export interface MoveCommand {
  kind: 'move'
  pieceId: Entity
  to: HexCoord
  spentMs?: number
}

export interface PassCommand {
  kind: 'pass'
  spentMs?: number
}

export type TesseraCommand = MoveCommand | PassCommand

export interface MoveRecord {
  ply: number
  player: number
  command: TesseraCommand
  captures: Entity[]
  scoreAfter: number[]
  clocks: number[]
  note: string
}

function integerInRange(name: string, value: number, min: number, max: number): true | string {
  return Number.isInteger(value) && value >= min && value <= max
    ? true
    : `${name} must be an integer in [${min}, ${max}]`
}

function nonNegativeInteger(name: string, value: number): true | string {
  return Number.isInteger(value) && value >= 0 ? true : `${name} must be a non-negative integer`
}

function nullableEntity(name: string, value: Entity | null): true | string {
  if (value === null) return true
  return nonNegativeInteger(name, value)
}

export const GameState = defineComponent<{
  seed: number
  radius: number
  playerCount: number
  currentPlayer: number
  turn: number
  status: GameStatus
  winnerId: number | null
  targetScore: number
  clockInitialMs: number
  clocks: number[]
  scores: number[]
  moveLog: MoveRecord[]
  lastError: string
}>('GameState', {
  defaults: {
    seed: 0,
    radius: 4,
    playerCount: 2,
    currentPlayer: 0,
    turn: 0,
    status: 'playing',
    winnerId: null,
    targetScore: 6,
    clockInitialMs: 240_000,
    clocks: [],
    scores: [],
    moveLog: [],
    lastError: '',
  },
  validate: (value) => {
    const radius = integerInRange('radius', value.radius, 1, 8)
    if (radius !== true) return radius
    const playerCount = integerInRange('playerCount', value.playerCount, 2, 4)
    if (playerCount !== true) return playerCount
    const currentPlayer = integerInRange('currentPlayer', value.currentPlayer, 0, Math.max(0, value.playerCount - 1))
    if (currentPlayer !== true) return currentPlayer
    const turn = nonNegativeInteger('turn', value.turn)
    if (turn !== true) return turn
    const targetScore = nonNegativeInteger('targetScore', value.targetScore)
    if (targetScore !== true) return targetScore
    const winner = nullableEntity('winnerId', value.winnerId)
    if (winner !== true) return winner
    return nonNegativeInteger('clockInitialMs', value.clockInitialMs)
  },
})

export const BoardCell = defineComponent<{
  q: number
  r: number
  s: number
  kind: CellKind
  homePlayer: number | null
  occupantId: Entity | null
  x: number
  y: number
}>('BoardCell', {
  defaults: { q: 0, r: 0, s: 0, kind: 'normal', homePlayer: null, occupantId: null, x: 0, y: 0 },
  validate: (value) => {
    if (value.q + value.r + value.s !== 0) return 'q + r + s must equal 0'
    const occupant = nullableEntity('occupantId', value.occupantId)
    if (occupant !== true) return occupant
    if (value.homePlayer !== null) {
      const home = integerInRange('homePlayer', value.homePlayer, 0, 3)
      if (home !== true) return home
    }
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return 'x/y must be finite'
    return true
  },
})

export const Piece = defineComponent<{
  owner: number
  index: number
  kind: PieceKind
  q: number
  r: number
  active: boolean
  capturedBy: number | null
}>('Piece', {
  defaults: { owner: 0, index: 0, kind: 'tessera', q: 0, r: 0, active: true, capturedBy: null },
  validate: (value) => {
    const owner = integerInRange('owner', value.owner, 0, 3)
    if (owner !== true) return owner
    const index = nonNegativeInteger('index', value.index)
    if (index !== true) return index
    if (value.capturedBy !== null) {
      const capturedBy = integerInRange('capturedBy', value.capturedBy, 0, 3)
      if (capturedBy !== true) return capturedBy
    }
    return true
  },
})

export const Mobility = defineComponent<{
  moves: number
  captures: number
  tacticalValue: number
}>('Mobility', {
  defaults: { moves: 0, captures: 0, tacticalValue: 0 },
  validate: (value) => {
    const moves = nonNegativeInteger('moves', value.moves)
    if (moves !== true) return moves
    const captures = nonNegativeInteger('captures', value.captures)
    if (captures !== true) return captures
    return Number.isFinite(value.tacticalValue) ? true : 'tacticalValue must be finite'
  },
})

export const EvalStats = defineComponent<{
  changedPieceUpdates: number
  lastChangedPieces: number
  lastMobilityTotal: number
}>('EvalStats', {
  defaults: { changedPieceUpdates: 0, lastChangedPieces: 0, lastMobilityTotal: 0 },
})

export const Selection = defineComponent<{
  selectedPieceId: Entity | null
}>('Selection', {
  defaults: { selectedPieceId: null },
  transient: true,
  validate: (value) => nullableEntity('selectedPieceId', value.selectedPieceId),
})
