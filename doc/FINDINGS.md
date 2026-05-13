# Tessera Implementation Findings

Tessera fleshes out DOMECS exemplar #4 with deterministic headless rules, a browser shell, per-accepted-move snapshots, undo/redo, replay export/rebuild, tournament-clock command data, and a `Changed(Piece)` AI-evaluation path.

## What worked

- The rules layer (`src/game.ts`) is DOM-free and runs under Vitest with `createWorld({ headless: true })`.
- `seed + playerCount + move list` rebuilds to a byte-identical `world.snapshot()`.
- Snapshot-per-move undo/redo is straightforward when snapshots are recorded after `tickEnd`, once reactive systems have completed.
- The browser UI can avoid RAF entirely: click → command event → `world.turn(...)` → DOM commit.

## Issues / limitations

1. **History is controller state, not world state.** The snapshot list intentionally lives in `TesseraRefs.history` to avoid recursive snapshots. This is fine for an exemplar, but a production app needs a persistence wrapper for history/replay metadata.
2. **Move commands currently use entity ids.** Replays are deterministic because setup spawns entities in a stable order. A network protocol should probably address pieces by `{owner,index}` and resolve to ids after rollback.
3. **Tournament clocks are command data.** This preserves determinism, but local play trusts the browser shell's `spentMs`. Network/tournament mode needs authoritative clock adjudication.
4. **Rules are intentionally small.** The one-step move, capture, surround, and sanctum scoring rules validate the DOMECS pressures without proving deep board-game balance.
5. **UI selection is local transient state.** It is not snapshotted and is repainted manually, which is correct for game state but would need a cleaner view-state pattern for larger board UIs.
