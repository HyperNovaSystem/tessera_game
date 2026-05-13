# Tessera

DOMECS exemplar #4: an abstract deterministic strategy game on a hex grid.

## Game specification

- 2–4 players control five tessera pieces each on a radius-4 hex board.
- Every authoritative mutation is a discrete command (`move` or `pass`) delivered to a headless-safe DOMECS event system.
- A move selects one active piece owned by the current player and moves it one adjacent hex.
- Moving into an enemy-occupied hex captures that piece. After landing, any enemy piece adjacent to three or more of the mover's active pieces is surrounded and captured.
- A player scores one point per captured piece and one sanctum point when they end a move with any active piece at the center hex.
- The first player to `targetScore` points wins. A player also loses immediately if their tournament clock reaches zero.
- Tournament-clock time is command data (`spentMs`) rather than wall-clock reads inside rules, keeping replay deterministic.
- The rules layer is browser-free and can run headless for AI search, replay, rollback, and tests.

## DOMECS exemplar goals

- **Pure determinism:** `seed + playerCount + move list` reproduces bit-identical snapshots.
- **Snapshot-per-move:** every accepted command records a `world.snapshot()`; undo/redo navigates that list.
- **Rules/presentation split:** `src/game.ts` contains all rules; `src/main.ts` is a thin DOM shell.
- **Rollback/replay:** exported replay JSON can be rebuilt from genesis, truncated, or replayed with replacement commands.
- **Changed-filter pressure:** a reactive AI-evaluation system consumes `Changed(Piece)` so headless tools can update only touched pieces.

## Development

```sh
npm install
npm test
npm run dev
```
