// Sokoban solver — sokoban-solver-01-run-20261121
//
// Approach: the generator lays a 1-wide hallway across the board with 1-4
// rooms off it, each room holding as many boxes as goals and opening onto
// the hallway through a single door. A box pushed out of a room can never
// come back, so an optimal solution keeps every box in its room and the
// level optimum is the sum of the rooms' push-optima. This solver therefore
// decomposes a level into rooms, solves each room push-optimally with A*
// over pushes (admissible assignment heuristic + pull-based dead squares +
// 2x2 freeze pruning), and stitches the room solutions together with
// hallway walks. A whole-level search is the fallback when no rooms are
// found. All budgets are counted in work (expansions), never wall time,
// and every tie-break is fixed, so two runs produce identical output.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

/** Four moves in a fixed order: up, down, left, right. */
const DIRS = [
  { dr: -1, dc: 0, ch: 'u' },
  { dr: 1, dc: 0, ch: 'd' },
  { dr: 0, dc: -1, ch: 'l' },
  { dr: 0, dc: 1, ch: 'r' },
] as const;

/** A binary heap ordered by a fixed comparator (deterministic). */
class Heap<T> {
  private a: T[] = [];
  private less: (x: T, y: T) => boolean;
  constructor(less: (x: T, y: T) => boolean) {
    this.less = less;
  }
  get size(): number {
    return this.a.length;
  }
  push(v: T): void {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      const t = a[i];
      a[i] = a[p];
      a[p] = t;
      i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        const t = a[i];
        a[i] = a[m];
        a[m] = t;
        i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Level
// ---------------------------------------------------------------------------

interface Level {
  w: number;
  h: number;
  /** true where a wall (or outside the board) sits. */
  wall: boolean[];
  /** row and column of every cell, for direction math without wrap bugs. */
  row: number[];
  col: number[];
  player: number;
  boxes: number[];
  goals: number[];
}

function parseLevel(text: string): Level {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const h = lines.length;
  const w = Math.max(0, ...lines.map((l) => l.length));
  const n = w * h;
  const wall = new Array<boolean>(n).fill(true);
  const row = new Array<number>(n);
  const col = new Array<number>(n);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      row[i] = r;
      col[i] = c;
    }
  }
  let player = -1;
  const boxes: number[] = [];
  const goals: number[] = [];
  for (let r = 0; r < h; r++) {
    const line = lines[r];
    for (let c = 0; c < line.length; c++) {
      const i = r * w + c;
      const ch = line[c];
      if (ch === '#') continue;
      wall[i] = false;
      if (ch === '@' || ch === '+') player = i;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, row, col, player, boxes, goals };
}

/** Step from cell `i` in direction `d`; -1 when the step leaves the board. */
function step(lv: Level, i: number, d: number): number {
  const r = lv.row[i] + DIRS[d].dr;
  const c = lv.col[i] + DIRS[d].dc;
  if (r < 0 || r >= lv.h || c < 0 || c >= lv.w) return -1;
  return r * lv.w + c;
}

/** The four neighbours of cell `i` that stay on the board. */
function neighbours(lv: Level, i: number): number[] {
  const out: number[] = [];
  for (let d = 0; d < 4; d++) {
    const j = step(lv, i, d);
    if (j >= 0) out.push(j);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decomposition into rooms
// ---------------------------------------------------------------------------

interface Room {
  /** Cells of the room interior plus its door square (box floor). */
  boxCells: number[];
  /** The door square: the room cell touching the hallway. */
  door: number;
  /** The hallway square outside the door: where the player enters. */
  hall: number;
  boxes: number[];
  goals: number[];
}

/** Connected components of the floor after removing every cell of `row`. */
function componentsWithoutRow(lv: Level, row: number): number[][] {
  const seen = new Array<boolean>(lv.w * lv.h).fill(false);
  const comps: number[][] = [];
  for (let i = 0; i < lv.w * lv.h; i++) {
    if (lv.wall[i] || lv.row[i] === row || seen[i]) continue;
    const comp: number[] = [];
    const queue = [i];
    seen[i] = true;
    for (let q = 0; q < queue.length; q++) {
      const cell = queue[q];
      comp.push(cell);
      for (const nb of neighbours(lv, cell)) {
        if (lv.wall[nb] || lv.row[nb] === row || seen[nb]) continue;
        seen[nb] = true;
        queue.push(nb);
      }
    }
    comps.push(comp);
  }
  return comps;
}

/**
 * Primary decomposition: the hallway is the player's row. Every component
 * of the floor with that row removed is a room (door square included) when
 * it holds as many boxes as goals. Returns null when the split does not
 * cover every box exactly once.
 */
function decomposeByHallwayRow(lv: Level): Room[] | null {
  const hallRow = lv.row[lv.player];
  const comps = componentsWithoutRow(lv, hallRow);
  const boxSet = new Set(lv.boxes);
  const rooms: Room[] = [];
  let covered = 0;
  for (const comp of comps) {
    const inComp = new Set(comp);
    const boxes = comp.filter((c) => boxSet.has(c)).sort((a, b) => a - b);
    const goals = comp.filter((c) => lv.goals.includes(c)).sort((a, b) => a - b);
    if (boxes.length === 0 && goals.length === 0) continue;
    if (boxes.length === 0 || boxes.length !== goals.length) return null;
    // The door: the room cell touching a hallway-row floor cell.
    let door = -1;
    let hall = -1;
    for (const c of comp) {
      for (let d = 0; d < 4; d++) {
        const nb = step(lv, c, d);
        if (nb >= 0 && !lv.wall[nb] && lv.row[nb] === hallRow) {
          door = c;
          hall = nb;
          break;
        }
      }
      if (door >= 0) break;
    }
    if (door < 0) return null;
    covered += boxes.length;
    rooms.push({ boxCells: comp.slice().sort((a, b) => a - b), door, hall, boxes, goals });
  }
  if (covered !== lv.boxes.length) return null;
  rooms.sort((a, b) => a.hall - b.hall);
  return rooms;
}

/**
 * Fallback decomposition: articulation points of the floor graph. Removing
 * a door square disconnects its room from the player start. Candidates are
 * the components that hold as many boxes as goals; the smallest are claimed
 * first so a hallway tail swallowing a room never wins over the room itself.
 */
function decomposeByArticulation(lv: Level): Room[] | null {
  const n = lv.w * lv.h;
  const floor: number[] = [];
  for (let i = 0; i < n; i++) if (!lv.wall[i]) floor.push(i);
  const boxSet = new Set(lv.boxes);
  interface Cand {
    door: number;
    comp: number[];
    boxes: number[];
    goals: number[];
  }
  const cands: Cand[] = [];
  for (const v of floor) {
    if (v === lv.player) continue;
    // Components of the floor with v removed; keep those away from the start.
    const seen = new Array<boolean>(n).fill(false);
    seen[v] = true;
    const startComp = new Set<number>();
    const queue = [lv.player];
    seen[lv.player] = true;
    for (let q = 0; q < queue.length; q++) {
      const cell = queue[q];
      startComp.add(cell);
      for (const nb of neighbours(lv, cell)) {
        if (lv.wall[nb] || seen[nb]) continue;
        seen[nb] = true;
        queue.push(nb);
      }
    }
    for (let i = 0; i < n; i++) {
      if (lv.wall[i] || seen[i]) continue;
      const comp: number[] = [];
      const q2 = [i];
      seen[i] = true;
      for (let q = 0; q < q2.length; q++) {
        const cell = q2[q];
        comp.push(cell);
        for (const nb of neighbours(lv, cell)) {
          if (lv.wall[nb] || seen[nb]) continue;
          seen[nb] = true;
          q2.push(nb);
        }
      }
      const boxes = comp.filter((c) => boxSet.has(c)).sort((a, b) => a - b);
      const goals = comp.filter((c) => lv.goals.includes(c)).sort((a, b) => a - b);
      if (boxes.length > 0 && boxes.length === goals.length) {
        cands.push({ door: v, comp, boxes, goals });
      }
    }
  }
  cands.sort((a, b) => a.comp.length - b.comp.length || a.door - b.door);
  const claimedCells = new Set<number>();
  const claimedBoxes = new Set<number>();
  const rooms: Room[] = [];
  for (const cand of cands) {
    if (cand.comp.some((c) => claimedCells.has(c))) continue;
    if (cand.boxes.some((b) => claimedBoxes.has(b))) continue;
    // The hallway square outside the door: a floor neighbour of the door
    // that is not part of the room.
    const inComp = new Set(cand.comp);
    let hall = -1;
    for (let d = 0; d < 4; d++) {
      const nb = step(lv, cand.door, d);
      if (nb >= 0 && !lv.wall[nb] && !inComp.has(nb)) {
        hall = nb;
        break;
      }
    }
    if (hall < 0) continue;
    for (const c of cand.comp) claimedCells.add(c);
    for (const b of cand.boxes) claimedBoxes.add(b);
    const boxCells = cand.comp.concat([cand.door]).sort((a, b) => a - b);
    rooms.push({ boxCells, door: cand.door, hall, boxes: cand.boxes, goals: cand.goals });
  }
  if (claimedBoxes.size !== lv.boxes.length || rooms.length === 0) return null;
  rooms.sort((a, b) => a.hall - b.hall);
  return rooms;
}

// ---------------------------------------------------------------------------
// One push-search problem (a room, or the whole level as fallback)
// ---------------------------------------------------------------------------

interface Problem {
  lv: Level;
  /** Cells the player may walk on. */
  walkSet: boolean[];
  /** Cells a box may occupy. */
  boxSet: boolean[];
  startPlayer: number;
  boxes: number[];
  goals: number[];
  /** The player must be able to reach this cell once solved (-1: no need). */
  exit: number;
  /** Walking distances from each goal over box cells: dist[g][cell]. */
  dist: number[][];
  /** Box cells a box can never leave towards a goal (dead squares). */
  dead: boolean[];
  /** 2x2 blocks (top-left cell) fully inside the box floor's bounding area. */
  blocks: number[];
}

function buildProblem(
  lv: Level,
  walkCells: number[],
  boxCells: number[],
  startPlayer: number,
  boxes: number[],
  goals: number[],
  exit: number,
): Problem {
  const n = lv.w * lv.h;
  const walkSet = new Array<boolean>(n).fill(false);
  const boxSet = new Array<boolean>(n).fill(false);
  for (const c of walkCells) walkSet[c] = true;
  for (const c of boxCells) boxSet[c] = true;

  // BFS distances from each goal over box cells (boxes do not block).
  const dist: number[][] = [];
  for (const g of goals) {
    const d = new Array<number>(n).fill(-1);
    d[g] = 0;
    const queue = [g];
    for (let q = 0; q < queue.length; q++) {
      const cell = queue[q];
      for (const nb of neighbours(lv, cell)) {
        if (!boxSet[nb] || d[nb] >= 0) continue;
        d[nb] = d[cell] + 1;
        queue.push(nb);
      }
    }
    dist.push(d);
  }

  // Dead squares by reverse pull reachability: a box on a goal can be
  // pulled (player drags it while stepping away) and can walk around it;
  // any box cell no pull sequence reaches is dead for good.
  const live = new Array<boolean>(n).fill(false);
  const seen = new Set<number>();
  const queue: number[] = [];
  const keyOf = (p: number, b: number): number => p * n + b;
  for (const g of goals) {
    live[g] = true;
    for (const p of walkCells) {
      if (p === g) continue;
      const k = keyOf(p, g);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push(k);
      }
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    const p = Math.floor(k / n);
    const b = k % n;
    live[b] = true;
    // The player walks to an adjacent square (never through the box).
    for (const np of neighbours(lv, p)) {
      if (!walkSet[np] || np === b) continue;
      const k2 = keyOf(np, b);
      if (!seen.has(k2)) {
        seen.add(k2);
        queue.push(k2);
      }
    }
    // The player pulls the box onto their own square: the player must be
    // beside the box, and steps one square further away from it.
    for (let d = 0; d < 4; d++) {
      if (step(lv, b, d) !== p) continue;
      const np = step(lv, p, d);
      if (np < 0 || !walkSet[np]) continue;
      const k2 = keyOf(np, p);
      if (!seen.has(k2)) {
        seen.add(k2);
        queue.push(k2);
      }
    }
  }
  const dead = new Array<boolean>(n).fill(false);
  for (const c of boxCells) {
    if (!live[c] && !goals.includes(c)) dead[c] = true;
  }

  // 2x2 blocks whose top-left cell is on the board (checked per state).
  const blocks: number[] = [];
  for (let r = 0; r + 1 < lv.h; r++) {
    for (let c = 0; c + 1 < lv.w; c++) {
      blocks.push(r * lv.w + c);
    }
  }
  return { lv, walkSet, boxSet, startPlayer, boxes, goals, exit, dist, dead, blocks };
}

// ---------------------------------------------------------------------------
// Push search (A*, then greedy best-first as fallback)
// ---------------------------------------------------------------------------

interface SearchOpts {
  /** Max expansions for the A* pass. */
  astarBudget: number;
  /** Max expansions for the greedy pass. */
  greedyBudget: number;
  /** Shared work counter for the whole run (safety valve). */
  shared: { used: number; cap: number };
}

interface State {
  key: number | string;
  player: number;
  boxes: number[];
  g: number;
  h: number;
}

/** Numeric state key while the box count stays small, else a string. */
function stateKey(boxes: number[], player: number, base: number): number | string {
  if (boxes.length <= 5) {
    let k = player;
    for (const b of boxes) k = k * base + b;
    return k;
  }
  return boxes.join(',') + '|' + player;
}

/** Flood fill from `from` over walk cells with `boxAt` as obstacles. */
function flood(
  prob: Problem,
  from: number,
  boxAt: boolean[],
): { dist: Int32Array; prev: Int32Array } {
  const n = prob.lv.w * prob.lv.h;
  const dist = new Int32Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  dist[from] = 0;
  const queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const cell = queue[q];
    for (let d = 0; d < 4; d++) {
      const nb = step(prob.lv, cell, d);
      if (nb < 0 || !prob.walkSet[nb] || boxAt[nb] || dist[nb] >= 0) continue;
      dist[nb] = dist[cell] + 1;
      prev[nb] = cell;
      queue.push(nb);
    }
  }
  return { dist, prev };
}

/** Walk string from `from` to `to` using a flood fill's parents. */
function walkString(lv: Level, prev: Int32Array, from: number, to: number): string {
  let out = '';
  let cell = to;
  const chars: string[] = [];
  while (cell !== from) {
    const p = prev[cell];
    const d = DIRS.findIndex(
      (dir) => lv.row[p] + dir.dr === lv.row[cell] && lv.col[p] + dir.dc === lv.col[cell],
    );
    chars.push(DIRS[d].ch);
    cell = p;
  }
  chars.reverse();
  out = chars.join('');
  return out;
}

/** Minimum-cost assignment of boxes to goals (exact for <= 4 boxes). */
function heuristic(prob: Problem, boxes: number[]): number {
  const nb = boxes.length;
  const ng = prob.goals.length;
  if (nb === 0) return 0;
  if (nb > 4) {
    // Cheaper lower bound for many boxes: each box's nearest goal.
    let sum = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (let g = 0; g < ng; g++) {
        const d = prob.dist[g][b];
        if (d >= 0 && d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      sum += best;
    }
    return sum;
  }
  // Exact min assignment over permutations of the goals.
  let best = Infinity;
  const used = new Array<boolean>(ng).fill(false);
  const rec = (i: number, sum: number): void => {
    if (sum >= best) return;
    if (i === nb) {
      best = sum;
      return;
    }
    for (let g = 0; g < ng; g++) {
      if (used[g]) continue;
      const d = prob.dist[g][boxes[i]];
      if (d < 0) continue;
      used[g] = true;
      rec(i + 1, sum + d);
      used[g] = false;
    }
  };
  rec(0, 0);
  return best;
}

/** True when a state holds a box frozen in a 2x2 block of walls/boxes. */
function frozen2x2(prob: Problem, boxes: number[], boxAt: boolean[]): boolean {
  const lv = prob.lv;
  for (const b of boxes) {
    if (prob.goals.includes(b)) continue;
    const r = lv.row[b];
    const c = lv.col[b];
    for (let dr = -1; dr <= 0; dr++) {
      for (let dc = -1; dc <= 0; dc++) {
        const r0 = r + dr;
        const c0 = c + dc;
        if (r0 < 0 || c0 < 0 || r0 + 1 >= lv.h || c0 + 1 >= lv.w) continue;
        const cells = [
          r0 * lv.w + c0,
          r0 * lv.w + c0 + 1,
          (r0 + 1) * lv.w + c0,
          (r0 + 1) * lv.w + c0 + 1,
        ];
        let blocked = 0;
        let hasGoal = false;
        for (const cell of cells) {
          if (prob.goals.includes(cell)) hasGoal = true;
          if (!prob.walkSet[cell] || boxAt[cell]) blocked++;
        }
        if (!hasGoal && blocked === 4) return true;
      }
    }
  }
  return false;
}

/**
 * Search one problem. A* first (push-optimal while the budget holds), then
 * greedy best-first so the level still gets solved when A* runs out of
 * work. Returns the move string, or null when neither pass solved it.
 */
function solveProblem(prob: Problem, opts: SearchOpts): string | null {
  const lv = prob.lv;
  const n = lv.w * lv.h;
  const startBoxes = prob.boxes.slice().sort((a, b) => a - b);
  const goalKey = prob.goals.slice().sort((a, b) => a - b).join(',');

  const solved = (boxes: number[]): boolean =>
    boxes.join(',') === goalKey;

  // One pass of push search: `astar` orders by pushes + heuristic,
  // greedy by the heuristic alone.
  const runPass = (astar: boolean, budget: number): string | null => {
    const bestG = new Map<number | string, number>();
    const came = new Map<number | string, { parent: number | string; seg: string }>();
    const startH = heuristic(prob, startBoxes);
    if (startH === Infinity) return null;
    const startKey = stateKey(startBoxes, prob.startPlayer, n);
    bestG.set(startKey, 0);
    type Entry = { f: number; g: number; h: number; seq: number; key: number | string; player: number; boxes: number[] };
    const heap = new Heap<Entry>((x, y) =>
      x.f !== y.f ? x.f < y.f : x.h !== y.h ? x.h < y.h : x.seq < y.seq,
    );
    let seq = 0;
    heap.push({ f: startH, g: 0, h: startH, seq: seq++, key: startKey, player: prob.startPlayer, boxes: startBoxes });
    let expansions = 0;
    const boxAt = new Array<boolean>(n).fill(false);

    while (heap.size > 0) {
      const cur = heap.pop();
      if (cur === undefined) break;
      if (opts.shared.used >= opts.shared.cap) return null;
      const known = bestG.get(cur.key);
      if (known === undefined || cur.g > known) continue;
      expansions++;
      opts.shared.used++;
      if (expansions > budget) return null;

      if (solved(cur.boxes)) {
        if (prob.exit >= 0) {
          for (const b of cur.boxes) boxAt[b] = true;
          const fl = flood(prob, cur.player, boxAt);
          for (const b of cur.boxes) boxAt[b] = false;
          if (fl.dist[prob.exit] < 0) continue;
          // Walk out to the exit, then rebuild the move string.
          let moves = walkString(lv, fl.prev, cur.player, prob.exit);
          let key: number | string | undefined = cur.key;
          const segs: string[] = [];
          while (key !== undefined && came.has(key)) {
            const stepInfo = came.get(key);
            if (stepInfo === undefined) break;
            segs.push(stepInfo.seg);
            key = stepInfo.parent;
          }
          segs.reverse();
          moves = segs.join('') + moves;
          return moves;
        }
        let key: number | string | undefined = cur.key;
        const segs: string[] = [];
        while (key !== undefined && came.has(key)) {
          const stepInfo = came.get(key);
          if (stepInfo === undefined) break;
          segs.push(stepInfo.seg);
          key = stepInfo.parent;
        }
        segs.reverse();
        return segs.join('');
      }

      for (const b of cur.boxes) boxAt[b] = true;
      const fl = flood(prob, cur.player, boxAt);
      // Try every push from this state.
      for (const b of cur.boxes) {
        for (let d = 0; d < 4; d++) {
          const back = step(lv, b, d ^ 1);
          const dest = step(lv, b, d);
          if (back < 0 || dest < 0) continue;
          if (fl.dist[back] < 0) continue;
          if (!prob.boxSet[dest] || boxAt[dest]) continue;
          const nb = cur.boxes.slice();
          const at = nb.indexOf(b);
          nb[at] = dest;
          nb.sort((x, y) => x - y);
          // Dead-square and freeze pruning.
          let deadHit = false;
          for (const x of nb) {
            if (prob.dead[x]) {
              deadHit = true;
              break;
            }
          }
          if (deadHit) continue;
          boxAt[b] = false;
          boxAt[dest] = true;
          const frozen = frozen2x2(prob, nb, boxAt);
          boxAt[b] = true;
          boxAt[dest] = false;
          if (frozen) continue;
          const h = heuristic(prob, nb);
          if (h === Infinity) continue;
          const g2 = cur.g + 1;
          const key2 = stateKey(nb, b, n);
          const prevBest = bestG.get(key2);
          if (prevBest !== undefined && prevBest <= g2) continue;
          bestG.set(key2, g2);
          const seg = walkString(lv, fl.prev, cur.player, back) + DIRS[d].ch;
          came.set(key2, { parent: cur.key, seg });
          const f2 = astar ? g2 + h : h;
          heap.push({ f: f2, g: g2, h, seq: seq++, key: key2, player: b, boxes: nb });
        }
      }
      for (const b of cur.boxes) boxAt[b] = false;
    }
    return null;
  };

  return runPass(true, opts.astarBudget) ?? runPass(false, opts.greedyBudget);
}

// ---------------------------------------------------------------------------
// Whole level
// ---------------------------------------------------------------------------

/** Walk-only move string from `from` to `to` over all floor cells. */
function walkBetween(lv: Level, from: number, to: number, boxAt: boolean[]): string | null {
  const n = lv.w * lv.h;
  const walkSet = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) if (!lv.wall[i]) walkSet[i] = true;
  const prob: Problem = {
    lv,
    walkSet,
    boxSet: new Array<boolean>(n).fill(false),
    startPlayer: from,
    boxes: [],
    goals: [],
    exit: -1,
    dist: [],
    dead: new Array<boolean>(n).fill(false),
    blocks: [],
  };
  const fl = flood(prob, from, boxAt);
  if (fl.dist[to] < 0) return null;
  return walkString(lv, fl.prev, from, to);
}

function solveLevel(lv: Level, opts: SearchOpts): string {
  const n = lv.w * lv.h;
  const allFloor: number[] = [];
  for (let i = 0; i < n; i++) if (!lv.wall[i]) allFloor.push(i);

  const rooms = decomposeByHallwayRow(lv) ?? decomposeByArticulation(lv);
  if (rooms !== null && rooms.length > 0) {
    let moves = '';
    let playerPos = lv.player;
    // Live box positions, for hallway walks: solved rooms rest on goals.
    let liveBoxes = lv.boxes.slice();
    for (const room of rooms) {
      const boxAt = new Array<boolean>(n).fill(false);
      for (const b of liveBoxes) boxAt[b] = true;
      const toDoor = walkBetween(lv, playerPos, room.hall, boxAt);
      if (toDoor === null) return tryWholeLevel(lv, opts);
      moves += toDoor;
      playerPos = room.hall;

      // Solve the room from its door; boxes stay inside it.
      const walkCells = room.boxCells.concat([room.hall]);
      const prob = buildProblem(lv, walkCells, room.boxCells, room.hall, room.boxes, room.goals, room.hall);
      const roomMoves = solveProblem(prob, opts);
      if (roomMoves === null) return tryWholeLevel(lv, opts);
      moves += roomMoves;
      playerPos = room.hall;
      // This room's boxes now sit on its goals.
      const roomBoxSet = new Set(room.boxes);
      liveBoxes = liveBoxes.filter((b) => !roomBoxSet.has(b)).concat(room.goals);
    }
    return moves;
  }
  return tryWholeLevel(lv, opts);
}

/** Whole-level push search (used when decomposition finds nothing). */
function tryWholeLevel(lv: Level, opts: SearchOpts): string {
  const n = lv.w * lv.h;
  const allFloor: number[] = [];
  for (let i = 0; i < n; i++) if (!lv.wall[i]) allFloor.push(i);
  const prob = buildProblem(lv, allFloor, allFloor, lv.player, lv.boxes, lv.goals, -1);
  return solveProblem(prob, opts) ?? '';
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const shared = { used: 0, cap: 6_000_000 };
const opts: SearchOpts = { astarBudget: 600_000, greedyBudget: 1_000_000, shared };

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    const text = readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8');
    const lv = parseLevel(text);
    moves = solveLevel(lv, opts);
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
