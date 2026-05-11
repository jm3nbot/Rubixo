const POWER_BY_SUFFIX = { '': 1, '2': 2, "'": 3 };
const SUFFIX_BY_POWER = { 1: '', 2: '2', 3: "'" };

export function invertMove(move) {
  const base = move.replace(/['2]/g, '');
  const suffix = move.slice(base.length);
  if (suffix === '2') return `${base}2`;
  return suffix === "'" ? base : `${base}'`;
}

export function simplifyMoves(moves) {
  const out = [];
  for (const move of moves) {
    const base = move.replace(/['2]/g, '');
    const suffix = move.slice(base.length);
    const last = out[out.length - 1];
    if (!last || last.replace(/['2]/g, '') !== base) {
      out.push(move);
      continue;
    }

    const lastBase = last.replace(/['2]/g, '');
    const lastSuffix = last.slice(lastBase.length);
    const power = (POWER_BY_SUFFIX[lastSuffix] + POWER_BY_SUFFIX[suffix]) % 4;
    out.pop();
    if (power !== 0) out.push(`${base}${SUFFIX_BY_POWER[power]}`);
  }
  return out;
}

export function solveFromHistory(history) {
  return simplifyMoves(history.slice().reverse().map(invertMove));
}

// ─── Kociemba two-phase solve from arbitrary state ─────────────────────────
// Used when the cube has no recorded move history (e.g. it was scanned from
// the camera). Backed by the global `Cube` object provided by the cubejs
// script tag in the HTML.

let kociembaReady = null;

function ensureKociembaReady() {
  if (kociembaReady) return kociembaReady;
  kociembaReady = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.Cube || !window.Cube.initSolver) {
      reject(new Error('Cube solver script failed to load.'));
      return;
    }
    // Yield once so the calling UI can paint a "Loading…" state, then run
    // the synchronous initialization (~3s on a modern machine — it builds
    // pruning tables in JS).
    setTimeout(() => {
      try {
        if (!window.Cube._tablesReady) {
          window.Cube.initSolver();
          window.Cube._tablesReady = true;
        }
        resolve();
      } catch (e) { reject(e); }
    }, 32);
  });
  return kociembaReady;
}

// CubeState.getFacelets() emits U and D faces with image-row 0 = front of
// cube, while the Kociemba/cubejs convention puts back-of-cube on row 0 of
// the U face and front-of-cube on row 0 of the D face. Reverse the rows for
// those two faces before handing the string to cubejs.
function toCubejsFacelets(s) {
  const reverseRows = (face) =>
    face.slice(6, 9) + face.slice(3, 6) + face.slice(0, 3);
  return (
    reverseRows(s.slice(0, 9)) +
    s.slice(9, 18) +
    s.slice(18, 27) +
    reverseRows(s.slice(27, 36)) +
    s.slice(36, 45) +
    s.slice(45, 54)
  );
}

// Our CubeState's U and D moves rotate in the opposite direction from
// cubejs's (Kociemba's) U and D — R/L/F/B match. Translate the cubejs plan
// back to our convention by inverting any U or D move (U → U', U' → U,
// U2 → U2, same for D).
function adaptCubejsMove(m) {
  const base = m.replace(/['2]/g, '');
  if (base !== 'U' && base !== 'D') return m;
  const suffix = m.slice(base.length);
  if (suffix === '2') return m;
  return suffix === "'" ? base : `${base}'`;
}

export async function solveFromFacelets(facelets) {
  if (facelets === 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB') {
    return [];
  }
  await ensureKociembaReady();
  try {
    const cube = window.Cube.fromString(toCubejsFacelets(facelets));
    const solution = cube.solve();
    if (typeof solution !== 'string') return [];
    return solution.split(/\s+/).filter(Boolean).map(adaptCubejsMove);
  } catch (err) {
    throw new Error('Unsolvable configuration. Check the sticker colors and centers.');
  }
}

export function describeMove(move) {
  const base = move.replace(/['2]/g, '');
  const suffix = move.slice(base.length);
  const faceNames = {
    U: 'Top side',
    D: 'Bottom side',
    R: 'Right side',
    L: 'Left side',
    F: 'Front side',
    B: 'Back side',
  };

  if (suffix === '2') {
    return {
      arrow: 'Half turn',
      title: faceNames[base],
      detail: 'Follow the guide arrow and keep turning until this side is halfway around.',
      tone: 'half turn',
      technical: move,
    };
  }

  const direction = suffix === "'" ? 'opposite' : 'forward';
  return {
    arrow: 'Follow arrow',
    title: faceNames[base],
    detail: `Turn this side one quarter-turn in the direction shown by the guide arrow.`,
    tone: direction,
    technical: move,
  };
}
