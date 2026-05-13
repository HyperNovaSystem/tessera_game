import { describe, expect, it } from 'vitest'
import { Has } from '@domecs/core'
import {
  BoardCell,
  EvalStats,
  GameState,
  Piece,
  createTessera,
  exportReplay,
  findCellId,
  legalMovesForPiece,
  rebuildFromReplay,
  snapshotHash,
  submitCommand,
} from '../src/index.js'

describe('Tessera exemplar', () => {
  it('builds a headless radius-4 hex board for 2-4 players', () => {
    const refs = createTessera({ seed: 11, playerCount: 4, headless: true })

    expect(refs.cellIds).toHaveLength(61)
    expect(refs.pieceIds).toHaveLength(20)
    expect(refs.world.query(Has(BoardCell)).size).toBe(61)
    expect(refs.world.query(Has(Piece)).size).toBe(20)

    const game = refs.world.getComponent(refs.gameId, GameState)!
    expect(game.playerCount).toBe(4)
    expect(game.currentPlayer).toBeGreaterThanOrEqual(0)
    expect(game.currentPlayer).toBeLessThan(4)
  })

  it('applies only legal discrete moves and records one snapshot per accepted move', () => {
    const refs = createTessera({ seed: 1, playerCount: 2, headless: true })
    const game = refs.world.getComponent(refs.gameId, GameState)!
    const pieceId = refs.pieceIds.find((id) => refs.world.getComponent(id, Piece)?.owner === game.currentPlayer)!
    const [move] = legalMovesForPiece(refs, pieceId)
    expect(move).toBeDefined()

    const beforeTurn = game.turn
    const movingPlayer = game.currentPlayer
    const accepted = submitCommand(refs, { kind: 'move', pieceId, to: move!.to, spentMs: 750 })
    expect(accepted).toBe(true)

    const after = refs.world.getComponent(refs.gameId, GameState)!
    expect(after.turn).toBe(beforeTurn + 1)
    expect(after.moveLog).toHaveLength(1)
    expect(refs.history.snapshots).toHaveLength(2)
    expect(after.clocks[movingPlayer]).toBe(4 * 60_000 - 750)

    const rejected = submitCommand(refs, { kind: 'move', pieceId, to: { q: 99, r: 99 }, spentMs: 1 })
    expect(rejected).toBe(false)
    expect(refs.history.snapshots).toHaveLength(2)
  })

  it('undo and redo navigate hermetic snapshots', () => {
    const refs = createTessera({ seed: 2, playerCount: 2, headless: true })
    const first = firstLegalMove(refs)
    submitCommand(refs, first)
    const afterMoveHash = snapshotHash(refs.world.snapshot())

    expect(refs.undo()).toBe(true)
    const afterUndo = refs.world.getComponent(refs.gameId, GameState)!
    expect(afterUndo.moveLog).toHaveLength(0)

    expect(refs.redo()).toBe(true)
    expect(snapshotHash(refs.world.snapshot())).toBe(afterMoveHash)
  })

  it('rebuilds bit-identical state from seed and exported move list', () => {
    const refs = createTessera({ seed: 3, playerCount: 2, headless: true })
    for (let i = 0; i < 4; i++) submitCommand(refs, firstLegalMove(refs))

    const replay = exportReplay(refs)
    const rebuilt = rebuildFromReplay(replay, { headless: true })

    expect(snapshotHash(rebuilt.world.snapshot())).toBe(snapshotHash(refs.world.snapshot()))
  })

  it('supports rollback by rebuilding from a truncated move list', () => {
    const refs = createTessera({ seed: 4, playerCount: 2, headless: true })
    const commands = []
    for (let i = 0; i < 3; i++) {
      const command = firstLegalMove(refs)
      commands.push(command)
      submitCommand(refs, command)
    }

    const replay = exportReplay(refs)
    const rolled = rebuildFromReplay({ ...replay, moves: replay.moves.slice(0, 1) }, { headless: true })
    expect(rolled.world.getComponent(rolled.gameId, GameState)!.moveLog).toHaveLength(1)

    const replacement = firstLegalMove(rolled)
    submitCommand(rolled, replacement)
    expect(snapshotHash(rolled.world.snapshot())).not.toBe(snapshotHash(refs.world.snapshot()))
  })

  it('uses Changed(Piece) to feed headless AI-evaluation deltas', () => {
    const refs = createTessera({ seed: 5, playerCount: 2, headless: true })
    const before = refs.world.getComponent(refs.gameId, EvalStats)!
    expect(before.changedPieceUpdates).toBe(0)

    submitCommand(refs, firstLegalMove(refs))

    const after = refs.world.getComponent(refs.gameId, EvalStats)!
    expect(after.changedPieceUpdates).toBeGreaterThan(0)
    expect(after.lastChangedPieces).toBeGreaterThan(0)
  })

  it('keeps board-cell occupancy and piece coordinates in sync', () => {
    const refs = createTessera({ seed: 6, playerCount: 2, headless: true })
    submitCommand(refs, firstLegalMove(refs))

    for (const pieceId of refs.pieceIds) {
      const piece = refs.world.getComponent(pieceId, Piece)!
      if (!piece.active) continue
      const cellId = findCellId(refs, piece.q, piece.r)!
      const cell = refs.world.getComponent(cellId, BoardCell)!
      expect(cell.occupantId).toBe(pieceId)
    }
  })
})

function firstLegalMove(refs: ReturnType<typeof createTessera>) {
  const game = refs.world.getComponent(refs.gameId, GameState)!
  for (const pieceId of refs.pieceIds) {
    const piece = refs.world.getComponent(pieceId, Piece)
    if (!piece || piece.owner !== game.currentPlayer || !piece.active) continue
    const [move] = legalMovesForPiece(refs, pieceId)
    if (move) return { kind: 'move' as const, pieceId, to: move.to, spentMs: 500 }
  }
  return { kind: 'pass' as const, spentMs: 500 }
}
