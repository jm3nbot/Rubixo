export const BLANK_COLOR = -2;

export const PAINT_COLORS = [
  { label: 'White',  colorIdx: 0, face: 'U', hex: '#f8fafc' },
  { label: 'Yellow', colorIdx: 3, face: 'D', hex: '#ffd500' },
  { label: 'Red',    colorIdx: 1, face: 'R', hex: '#d91f35' },
  { label: 'Orange', colorIdx: 4, face: 'L', hex: '#ff8c00' },
  { label: 'Blue',   colorIdx: 5, face: 'B', hex: '#0046ad' },
  { label: 'Green',  colorIdx: 2, face: 'F', hex: '#009b48' },
];

const FACE_ORDER = ['U', 'R', 'F', 'D', 'L', 'B'];
const FACE_OFFSETS = { U: 0, R: 9, F: 18, D: 27, L: 36, B: 45 };
const CENTER_INDEX = { U: 4, R: 13, F: 22, D: 31, L: 40, B: 49 };
const CORNERS = [
  { position: [1, 1, 1], faces: ['U', 'R', 'F'] },
  { position: [-1, 1, 1], faces: ['U', 'F', 'L'] },
  { position: [-1, 1, -1], faces: ['U', 'L', 'B'] },
  { position: [1, 1, -1], faces: ['U', 'B', 'R'] },
  { position: [1, -1, 1], faces: ['D', 'F', 'R'] },
  { position: [-1, -1, 1], faces: ['D', 'L', 'F'] },
  { position: [-1, -1, -1], faces: ['D', 'B', 'L'] },
  { position: [1, -1, -1], faces: ['D', 'R', 'B'] },
];
const EDGES = [
  { position: [1, 1, 0], faces: ['U', 'R'] },
  { position: [0, 1, 1], faces: ['U', 'F'] },
  { position: [-1, 1, 0], faces: ['U', 'L'] },
  { position: [0, 1, -1], faces: ['U', 'B'] },
  { position: [1, -1, 0], faces: ['D', 'R'] },
  { position: [0, -1, 1], faces: ['D', 'F'] },
  { position: [-1, -1, 0], faces: ['D', 'L'] },
  { position: [0, -1, -1], faces: ['D', 'B'] },
  { position: [1, 0, 1], faces: ['F', 'R'] },
  { position: [-1, 0, 1], faces: ['F', 'L'] },
  { position: [-1, 0, -1], faces: ['B', 'L'] },
  { position: [1, 0, -1], faces: ['B', 'R'] },
];

function faceletToSticker(index) {
  const face = FACE_ORDER[Math.floor(index / 9)];
  const local = index % 9;
  const r = Math.floor(local / 3);
  const c = local % 3;

  if (face === 'U') return { face, position: [c - 1, 1, 1 - r] };
  if (face === 'R') return { face, position: [1, 1 - r, 1 - c] };
  if (face === 'F') return { face, position: [c - 1, 1 - r, 1] };
  if (face === 'D') return { face, position: [c - 1, -1, r - 1] };
  if (face === 'L') return { face, position: [-1, 1 - r, c - 1] };
  return { face, position: [1 - c, 1 - r, -1] };
}

export function makeBlankFaceletColors() {
  return new Array(54).fill(BLANK_COLOR);
}

export function faceletIndexFromSticker(face, position) {
  const x = Math.round(position.x ?? position[0]);
  const y = Math.round(position.y ?? position[1]);
  const z = Math.round(position.z ?? position[2]);
  let r = 0;
  let c = 0;

  if (face === 'U') {
    r = 1 - z;
    c = x + 1;
  } else if (face === 'R') {
    r = 1 - y;
    c = 1 - z;
  } else if (face === 'F') {
    r = 1 - y;
    c = x + 1;
  } else if (face === 'D') {
    r = z + 1;
    c = x + 1;
  } else if (face === 'L') {
    r = 1 - y;
    c = z + 1;
  } else {
    r = 1 - y;
    c = 1 - x;
  }

  return FACE_OFFSETS[face] + r * 3 + c;
}

export function getPaintCounts(faceletColors) {
  const counts = new Map(PAINT_COLORS.map(color => [color.colorIdx, 0]));
  let blanks = 0;
  for (const colorIdx of faceletColors) {
    if (colorIdx === BLANK_COLOR) {
      blanks++;
    } else {
      counts.set(colorIdx, (counts.get(colorIdx) || 0) + 1);
    }
  }
  return { counts, blanks };
}

export function validatePaintCounts(faceletColors) {
  const issues = [];
  const { counts, blanks } = getPaintCounts(faceletColors);

  for (const color of PAINT_COLORS) {
    const count = counts.get(color.colorIdx) || 0;
    if (count > 9) issues.push(`${color.label} has ${count} stickers. A real cube can only have 9.`);
  }

  if (blanks === 0) {
    for (const color of PAINT_COLORS) {
      const count = counts.get(color.colorIdx) || 0;
      if (count !== 9) issues.push(`${color.label} has ${count} stickers. It needs exactly 9.`);
    }
  }

  return { issues, blanks, counts };
}

export function buildPaintFaceletString(faceletColors) {
  const { issues, blanks } = validatePaintCounts(faceletColors);
  if (blanks > 0) throw new Error(`${blanks} stickers are still blank.`);
  if (issues.length) throw new Error(issues[0]);

  const colorToFace = new Map();
  for (const face of FACE_ORDER) {
    const centerColor = faceletColors[CENTER_INDEX[face]];
    if (centerColor === BLANK_COLOR) throw new Error('Every center sticker must be painted.');
    if (colorToFace.has(centerColor)) {
      throw new Error('Two center stickers use the same color. Each center must be unique.');
    }
    colorToFace.set(centerColor, face);
  }

  for (const color of PAINT_COLORS) {
    if (!colorToFace.has(color.colorIdx)) {
      throw new Error(`${color.label} must appear on exactly one center sticker.`);
    }
  }

  return faceletColors.map(colorIdx => colorToFace.get(colorIdx)).join('');
}

function sortedKey(values) {
  return values.slice().sort().join('');
}

function permutationParity(perm) {
  let parity = 0;
  for (let i = 0; i < perm.length; i++) {
    for (let j = i + 1; j < perm.length; j++) {
      if (perm[i] > perm[j]) parity ^= 1;
    }
  }
  return parity;
}

const SOLVED_CORNER_BY_KEY = new Map(CORNERS.map((corner, idx) => [
  sortedKey(corner.faces),
  idx,
]));
const SOLVED_EDGE_BY_KEY = new Map(EDGES.map((edge, idx) => [
  sortedKey(edge.faces),
  idx,
]));

export function validatePhysicalState(facelets) {
  const issues = [];
  if (!/^[URFDLB]{54}$/.test(facelets)) {
    return ['The facelet string is incomplete.'];
  }

  const cornerPerm = [];
  const edgePerm = [];
  const seenCorners = new Set();
  const seenEdges = new Set();
  let cornerTwist = 0;
  let edgeFlip = 0;

  for (const corner of CORNERS) {
    const colors = corner.faces.map(face => facelets[faceletIndexFromSticker(face, corner.position)]);
    const cubieId = SOLVED_CORNER_BY_KEY.get(sortedKey(colors));
    if (cubieId === undefined || seenCorners.has(cubieId)) {
      issues.push('Unsolvable configuration: corner pieces do not match a real cube.');
      break;
    }
    seenCorners.add(cubieId);
    cornerPerm.push(cubieId);
    const udIndex = colors.findIndex(color => color === 'U' || color === 'D');
    cornerTwist = (cornerTwist + udIndex) % 3;
  }

  for (const edge of EDGES) {
    const colors = edge.faces.map(face => facelets[faceletIndexFromSticker(face, edge.position)]);
    const cubieId = SOLVED_EDGE_BY_KEY.get(sortedKey(colors));
    if (cubieId === undefined || seenEdges.has(cubieId)) {
      issues.push('Unsolvable configuration: edge pieces do not match a real cube.');
      break;
    }
    seenEdges.add(cubieId);
    edgePerm.push(cubieId);

    const udIndex = colors.findIndex(color => color === 'U' || color === 'D');
    if (udIndex >= 0) {
      edgeFlip = (edgeFlip + udIndex) % 2;
    } else {
      const fbIndex = colors.findIndex(color => color === 'F' || color === 'B');
      edgeFlip = (edgeFlip + (fbIndex === 0 ? 0 : 1)) % 2;
    }
  }

  if (!issues.length && cornerTwist !== 0) {
    issues.push('Unsolvable configuration: one or more corners are twisted.');
  }
  if (!issues.length && edgeFlip !== 0) {
    issues.push('Unsolvable configuration: one or more edges are flipped.');
  }
  if (!issues.length && permutationParity(cornerPerm) !== permutationParity(edgePerm)) {
    issues.push('Unsolvable configuration: pieces are swapped in an impossible way.');
  }

  return issues;
}

export function applyFaceletColorsToCubeState(cubeState, faceletColors) {
  cubeState.reset();
  for (let i = 0; i < faceletColors.length; i++) {
    const { face, position } = faceletToSticker(i);
    const cubie = cubeState.cubies.find(cu =>
      cu.position[0] === position[0] &&
      cu.position[1] === position[1] &&
      cu.position[2] === position[2]
    );
    if (cubie) cubie.colors[face] = faceletColors[i];
  }
  if (typeof cubeState.clearUndo === 'function') cubeState.clearUndo();
}
