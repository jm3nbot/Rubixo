const FACE_INDEX = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
const FACE_CHARS = 'URFDLB';
const FACE_VECTORS = {
  U: [0, 1, 0],
  D: [0, -1, 0],
  R: [1, 0, 0],
  L: [-1, 0, 0],
  F: [0, 0, 1],
  B: [0, 0, -1],
};
const VECTOR_FACES = {
  '0,1,0': 'U',
  '0,-1,0': 'D',
  '1,0,0': 'R',
  '-1,0,0': 'L',
  '0,0,1': 'F',
  '0,0,-1': 'B',
};

const LAYER_DEF = {
  U: { axis: 'y', layerAxis: 1, layerCoord: 1, dir: 1 },
  D: { axis: 'y', layerAxis: 1, layerCoord: -1, dir: -1 },
  R: { axis: 'x', layerAxis: 0, layerCoord: 1, dir: -1 },
  L: { axis: 'x', layerAxis: 0, layerCoord: -1, dir: 1 },
  F: { axis: 'z', layerAxis: 2, layerCoord: 1, dir: -1 },
  B: { axis: 'z', layerAxis: 2, layerCoord: -1, dir: 1 },
};

export const ALL_MOVES = [
  'U', "U'", 'U2',
  'D', "D'", 'D2',
  'R', "R'", 'R2',
  'L', "L'", 'L2',
  'F', "F'", 'F2',
  'B', "B'", 'B2',
];

function emptyColors() {
  return { U: -1, D: -1, R: -1, L: -1, F: -1, B: -1 };
}

function rotateVector(vec, axis, quarterTurns) {
  let [x, y, z] = vec;
  const turns = ((quarterTurns % 4) + 4) % 4;
  for (let i = 0; i < turns; i++) {
    if (axis === 'x') {
      [x, y, z] = [x, -z, y];
    } else if (axis === 'y') {
      [x, y, z] = [z, y, -x];
    } else {
      [x, y, z] = [-y, x, z];
    }
  }
  return [x, y, z];
}

function rotateFaceName(face, axis, quarterTurns) {
  return VECTOR_FACES[rotateVector(FACE_VECTORS[face], axis, quarterTurns).join(',')];
}

function inverseMove(move) {
  const base = move.replace(/['2]/g, '');
  const suffix = move.slice(base.length);
  if (suffix === '2') return `${base}2`;
  return suffix === "'" ? base : `${base}'`;
}

function coordsForSize(size) {
  return size === 2 ? [-1, 1] : [-1, 0, 1];
}

function makeSolvedCubies(size = 3) {
  const cubies = [];
  const coords = coordsForSize(size);
  for (const x of coords) {
    for (const y of coords) {
      for (const z of coords) {
        const colors = emptyColors();
        if (y === 1) colors.U = FACE_INDEX.U;
        if (y === -1) colors.D = FACE_INDEX.D;
        if (x === 1) colors.R = FACE_INDEX.R;
        if (x === -1) colors.L = FACE_INDEX.L;
        if (z === 1) colors.F = FACE_INDEX.F;
        if (z === -1) colors.B = FACE_INDEX.B;
        cubies.push({ position: [x, y, z], colors });
      }
    }
  }
  return cubies;
}

function cloneCubie(cubie) {
  return {
    position: cubie.position.slice(),
    colors: { ...cubie.colors },
  };
}

export class CubeState {
  constructor(size = 3) {
    this.size = size === 2 ? 2 : 3;
    this.cubies = makeSolvedCubies(this.size);
    this._undoStack = [];
  }

  setSize(size) {
    const nextSize = size === 2 ? 2 : 3;
    if (this.size === nextSize) return;
    this.size = nextSize;
    this.reset();
  }

  applyMove(move, recordUndo = true) {
    const base = move.replace(/['2]/g, '');
    const suffix = move.slice(base.length);
    const def = LAYER_DEF[base];
    if (!def) return;

    const suffixSign = suffix === "'" ? -1 : 1;
    const quarterTurns = suffix === '2' ? 2 : suffixSign * def.dir;

    this.cubies = this.cubies.map(cubie => {
      if (cubie.position[def.layerAxis] !== def.layerCoord) {
        return cloneCubie(cubie);
      }

      const colors = emptyColors();
      for (const [face, colorIdx] of Object.entries(cubie.colors)) {
        if (colorIdx === -1) continue;
        colors[rotateFaceName(face, def.axis, quarterTurns)] = colorIdx;
      }

      return {
        position: rotateVector(cubie.position, def.axis, quarterTurns),
        colors,
      };
    });

    if (recordUndo) {
      this._undoStack.push(move);
      if (this._undoStack.length > 80) this._undoStack.shift();
    }
  }

  undoMove() {
    const move = this._undoStack.pop();
    if (!move) return null;
    const inverse = inverseMove(move);
    this.applyMove(inverse, false);
    return inverse;
  }

  clearUndo() {
    this._undoStack = [];
  }

  scramble(n = this.size === 2 ? 14 : 20) {
    this.reset();
    const seq = [];
    let last = '';
    for (let i = 0; i < n; i++) {
      let move;
      do {
        move = ALL_MOVES[Math.floor(Math.random() * ALL_MOVES.length)];
      } while (move.replace(/['2]/g, '') === last);
      last = move.replace(/['2]/g, '');
      seq.push(move);
      this.applyMove(move, false);
    }
    this._undoStack = [];
    return seq;
  }

  reset() {
    this.cubies = makeSolvedCubies(this.size);
    this._undoStack = [];
  }

  isSolved() {
    const centers = this._centerColors();
    if (Object.values(centers).some(colorIdx => colorIdx < 0)) return false;

    return this.getCubies().every(({ position: [x, y, z], colors }) => {
      if (y === 1 && colors.U !== centers.U) return false;
      if (y === -1 && colors.D !== centers.D) return false;
      if (x === 1 && colors.R !== centers.R) return false;
      if (x === -1 && colors.L !== centers.L) return false;
      if (z === 1 && colors.F !== centers.F) return false;
      if (z === -1 && colors.B !== centers.B) return false;
      return true;
    });
  }

  _centerColors() {
    if (this.size === 2) {
      return {
        U: FACE_INDEX.U,
        R: FACE_INDEX.R,
        F: FACE_INDEX.F,
        D: FACE_INDEX.D,
        L: FACE_INDEX.L,
        B: FACE_INDEX.B,
      };
    }

    const at = (x, y, z, face) => {
      const cubie = this.cubies.find(c =>
        c.position[0] === x && c.position[1] === y && c.position[2] === z
      );
      return cubie ? cubie.colors[face] : -1;
    };

    return {
      U: at(0, 1, 0, 'U'),
      R: at(1, 0, 0, 'R'),
      F: at(0, 0, 1, 'F'),
      D: at(0, -1, 0, 'D'),
      L: at(-1, 0, 0, 'L'),
      B: at(0, 0, -1, 'B'),
    };
  }

  getFacelets() {
    const facelets = Array.from({ length: 54 }, (_, i) => Math.floor(i / 9));
    for (const { position: [x, y, z], colors } of this.cubies) {
      if (y === 1) facelets[0 + (-z + 1) * 3 + (x + 1)] = colors.U;
      if (x === 1) facelets[9 + (-y + 1) * 3 + (-z + 1)] = colors.R;
      if (z === 1) facelets[18 + (-y + 1) * 3 + (x + 1)] = colors.F;
      if (y === -1) facelets[27 + (z + 1) * 3 + (x + 1)] = colors.D;
      if (x === -1) facelets[36 + (-y + 1) * 3 + (z + 1)] = colors.L;
      if (z === -1) facelets[45 + (-y + 1) * 3 + (-x + 1)] = colors.B;
    }
    return facelets.map(colorIdx => FACE_CHARS[colorIdx]).join('');
  }

  getCubies() {
    return this.cubies.map(cloneCubie);
  }
}
