# Sokoban solver — sokoban-solver-01-run-20261121
[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/mietrea519-cyber/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/mietrea519-cyber/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in a single `main.ts` (Node 22, no dependencies).

## How it works

The generator builds each level as a 1-wide hallway with 1–4 rooms off it,
each room holding as many boxes as goals and opening through a single door.
A box pushed out of its room can never come back, so an optimal solution
keeps every box in its room and the level optimum is the sum of the rooms'
push-optima. The solver therefore:

1. **Decomposes** the level into rooms — the hallway is the player's row,
   and each component of the floor with that row removed is a room
   (articulation-point detection is the fallback).
2. **Solves each room push-optimally** with A* over pushes: the state is the
   player square plus the sorted box squares, and each action is one push
   (with the walk to the pushing square reconstructed by BFS). The
   heuristic is the minimum-cost assignment of boxes to goals, a lower
   bound on the pushes still needed. Deadlock pruning comes from
   pull-reachability dead squares (a box that can never be pulled to a
   goal) and 2×2 freeze detection.
3. **Stitches** the room solutions together with hallway walks — walks add
   steps, never pushes, so the total stays push-optimal.

If no rooms are found, the same push search runs on the whole level, with
a greedy best-first pass as a fallback so a level is solved even when the
optimal search runs out of its work budget. All budgets are counted in
expansions, never wall time, and every tie-break is fixed, so two runs
produce byte-identical output.

## Run it

```sh
MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=<output> node main.ts
```

It reads `<input>/<id>/level.txt` for each instance and writes
`<output>/<id>/solution.txt` with the player's moves in LURD.

Try make.fun with my referral link: https://make.fun/r/1e3qpbvy
