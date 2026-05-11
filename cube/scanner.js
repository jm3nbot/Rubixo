// Cube scanner — captures 6 faces from a webcam stream, classifies the sampled
// sticker colors, and produces a cube state. 3x3 scans use face centers as
// calibration colors. 2x2 scans have no centers, so they use a capacity-limited
// nearest-match against the standard WCA palette.

export const SCAN_FACES = ['F', 'R', 'B', 'L', 'U', 'D'];

export const SCAN_INSTRUCTIONS = {
  F: {
    label: 'Green front',
    chip: 'Green',
    body: 'Start with the GREEN center facing the camera and WHITE on top. Keep this as your home position.',
  },
  R: {
    label: 'Red right',
    chip: 'Red',
    body: 'From green-front, turn the cube left so the RED center comes to the camera. Keep white on top.',
  },
  B: {
    label: 'Blue back',
    chip: 'Blue',
    body: 'Turn left again so the BLUE center faces the camera. Keep white on top.',
  },
  L: {
    label: 'Orange left',
    chip: 'Orange',
    body: 'Turn left once more so the ORANGE center faces the camera. Keep white on top.',
  },
  U: {
    label: 'White top',
    chip: 'White',
    body: 'Switch back to green-front with white on top. Tilt the top edge toward the camera so the WHITE center fills the frame.',
  },
  D: {
    label: 'Yellow bottom',
    chip: 'Yellow',
    body: 'Switch back to green-front again. Tilt the bottom edge toward the camera so the YELLOW center fills the frame.',
  },
};

// For each scanned face, which physical cubie position the (row, col) grid cell
// covers. Derived from the orientation prescribed in SCAN_INSTRUCTIONS — every
// scan always has cube up = image up. See also CubeState.getFacelets convention.
export const SCAN_GRID_TO_CUBIE = {
  F: (r, c) => [c - 1, 1 - r, +1],
  R: (r, c) => [+1,    1 - r, 1 - c],
  B: (r, c) => [1 - c, 1 - r, -1],
  L: (r, c) => [-1,    1 - r, c - 1],
  U: (r, c) => [c - 1, +1,    r - 1],
  D: (r, c) => [c - 1, -1,    1 - r],
};

const FACE_INDEX = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
const WCA_RGB = [
  [245, 245, 245], // U white
  [196, 30, 58],   // R red
  [0, 158, 78],    // F green
  [255, 213, 0],   // D yellow
  [255, 128, 0],   // L orange
  [0, 81, 186],    // B blue
];

function coordForCell(size, i) {
  return size === 2 ? (i === 0 ? -1 : 1) : i - 1;
}

function invCoordForCell(size, i) {
  return size === 2 ? (i === 0 ? 1 : -1) : 1 - i;
}

function scanGridToCubie(face, r, c, size = 3) {
  if (size === 3) return SCAN_GRID_TO_CUBIE[face](r, c);
  const x = coordForCell(2, c);
  const y = invCoordForCell(2, r);
  const zForward = coordForCell(2, r);
  const zBack = invCoordForCell(2, r);
  if (face === 'F') return [x, y, 1];
  if (face === 'R') return [1, y, -x];
  if (face === 'B') return [-x, y, -1];
  if (face === 'L') return [-1, y, x];
  if (face === 'U') return [x, 1, zForward];
  return [x, -1, zBack];
}

// Sample a robust color of each of the 9 grid cells in the current video frame.
// The grid is the rectangular region described by `frameRect`, expressed in the
// same coordinate space as `videoElement.getBoundingClientRect()`.
//
// Returns an array of 9 [r,g,b] tuples in row-major order, or null if the video
// has no frame data yet.
export function sampleVideoGrid(videoElement, frameRect, gridSize = 3) {
  if (!videoElement.videoWidth || !videoElement.videoHeight) return null;

  const videoRect = videoElement.getBoundingClientRect();
  if (videoRect.width === 0 || videoRect.height === 0) return null;

  // The video uses object-fit: cover, so part of the source frame is cropped.
  // Compute the affine map from CSS pixel space → video pixel space.
  const videoAspect = videoElement.videoWidth / videoElement.videoHeight;
  const containerAspect = videoRect.width / videoRect.height;
  let scale, offsetX, offsetY;
  if (videoAspect > containerAspect) {
    scale = videoElement.videoHeight / videoRect.height;
    offsetX = (videoElement.videoWidth - videoRect.width * scale) / 2;
    offsetY = 0;
  } else {
    scale = videoElement.videoWidth / videoRect.width;
    offsetX = 0;
    offsetY = (videoElement.videoHeight - videoRect.height * scale) / 2;
  }

  const frameLeft   = (frameRect.left - videoRect.left) * scale + offsetX;
  const frameTop    = (frameRect.top  - videoRect.top)  * scale + offsetY;
  const frameWidth  = frameRect.width  * scale;
  const frameHeight = frameRect.height * scale;
  const cellW = frameWidth  / gridSize;
  const cellH = frameHeight / gridSize;

  // Draw the current video frame onto an offscreen canvas so we can read pixels.
  const canvas = document.createElement('canvas');
  canvas.width  = videoElement.videoWidth;
  canvas.height = videoElement.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(videoElement, 0, 0);

  const samples = [];
  // Sample a generous central block and use a trimmed median/mean. This removes
  // black sticker borders, hand shadows, and specular glare before the color is
  // handed to the classifier.
  const sampleSize = Math.max(10, Math.min(cellW, cellH) * 0.58);
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const cx = frameLeft + (c + 0.5) * cellW;
      const cy = frameTop  + (r + 0.5) * cellH;
      const x0 = Math.max(0, Math.round(cx - sampleSize / 2));
      const y0 = Math.max(0, Math.round(cy - sampleSize / 2));
      const w  = Math.min(canvas.width  - x0, Math.round(sampleSize));
      const h  = Math.min(canvas.height - y0, Math.round(sampleSize));
      if (w <= 0 || h <= 0) {
        samples.push([0, 0, 0]);
        continue;
      }
      samples.push(robustCellColor(ctx.getImageData(x0, y0, w, h)));
    }
  }
  return samples;
}

function robustCellColor(imageData) {
  const pixels = [];
  const { data, width, height } = imageData;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const radius = Math.min(width, height) * 0.47;
  let glare = 0;
  let dark = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (Math.hypot(dx, dy) > radius) continue;

      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sat = max === 0 ? 0 : (max - min) / max;
      if (luma < 28) {
        dark++;
        continue;
      }
      if (luma > 246 && sat < 0.08) glare++;
      pixels.push({ rgb: [r, g, b], luma, sat });
    }
  }

  const usable = pixels.length >= 24 ? pixels : [];
  if (!usable.length) {
    const fallback = [0, 0, 0];
    fallback.meta = { quality: 0, glareRatio: 1, darkRatio: 1 };
    return fallback;
  }

  usable.sort((a, b) => a.luma - b.luma);
  const lo = Math.floor(usable.length * 0.14);
  const hi = Math.max(lo + 1, Math.ceil(usable.length * 0.84));
  const trimmed = usable.slice(lo, hi);

  const byChannelMedian = (channel) => {
    const values = trimmed.map(p => p.rgb[channel]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  const rgb = [
    byChannelMedian(0),
    byChannelMedian(1),
    byChannelMedian(2),
  ];
  rgb.meta = {
    quality: trimmed.length / Math.max(1, Math.round(Math.PI * radius * radius)),
    glareRatio: glare / Math.max(1, pixels.length + dark),
    darkRatio: dark / Math.max(1, pixels.length + dark),
  };
  return rgb;
}

// sRGB → CIELAB (D65). Lab is perceptually uniform, so euclidean distance in
// Lab is a much better proxy for "do these stickers look the same color" than
// distance in raw RGB — which is what was causing white stickers to get split
// across two clusters and red-vs-orange stickers to get confused.
function rgbToLab([r, g, b]) {
  const linearize = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lr = linearize(r), lg = linearize(g), lb = linearize(b);
  let x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  let y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750);
  let z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / 1.08883;
  const eps = 216 / 24389;
  const kappa = 24389 / 27;
  const f = (t) => t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116;
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labSqDist(a, b) {
  const dl = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

// Capacitated stable matching: assign `n` non-center stickers to `k` colors
// such that each color receives exactly `capacity` stickers and the total Lab
// distance is small. We use Gale–Shapley with capacities (each sticker
// proposes to its closest color, each color tentatively keeps its `capacity`
// closest proposers, the rest re-propose to their next choice). With a square
// total capacity this terminates with every sticker matched.
function capacitatedStableMatch(distances, capacity) {
  const n = distances.length;
  const k = distances[0].length;

  const prefs = distances.map((d) =>
    d.map((_, c) => c).sort((a, b) => d[a] - d[b])
  );
  const nextProposal = new Array(n).fill(0);
  const accepted = Array.from({ length: k }, () => []); // [stickerIdx, dist]

  let pending = Array.from({ length: n }, (_, i) => i);
  while (pending.length) {
    for (const i of pending) {
      const c = prefs[i][nextProposal[i]++];
      accepted[c].push([i, distances[i][c]]);
    }
    pending = [];
    for (let c = 0; c < k; c++) {
      if (accepted[c].length > capacity) {
        accepted[c].sort((p, q) => p[1] - q[1]);
        for (let j = capacity; j < accepted[c].length; j++) {
          pending.push(accepted[c][j][0]);
        }
        accepted[c].length = capacity;
      }
    }
  }

  const assignments = new Array(n).fill(-1);
  for (let c = 0; c < k; c++) {
    for (const [i] of accepted[c]) assignments[i] = c;
  }
  return assignments;
}

// End-to-end classification. Strategy:
//   1. Convert all 54 RGB samples to CIELAB.
//   2. Use the 6 face-center stickers as fixed reference colors — one per
//      face, guaranteed by the cube's structure to be one sample of each
//      color.
//   3. Capacitated stable matching: assign each of the 48 non-center stickers
//      to one of the 6 reference colors, with capacity 8 per color (so that
//      each cluster ends up with exactly 9 = 1 center + 8 others).
//
// This guarantees the output is *always* a valid 9-per-color cube state, even
// under bad lighting where naive k-means would split similar stickers across
// clusters.
export function classifySamples(captured, size = 3) {
  if (size === 2) return classifySamples2x2(captured);

  const allRgb = [];
  for (const face of SCAN_FACES) {
    for (const s of captured[face]) allRgb.push(s);
  }
  const allLab = allRgb.map(rgbToLab);
  const sampleQuality = allRgb.map(sample => sample.meta || {
    quality: 1,
    glareRatio: 0,
    darkRatio: 0,
  });

  // Centers live at the (row=1, col=1) cell of each face → flat index f*9+4.
  const centerLab = SCAN_FACES.map((_, f) => allLab[f * 9 + 4]);
  let minCenterDistance = Infinity;
  for (let i = 0; i < centerLab.length; i++) {
    for (let j = i + 1; j < centerLab.length; j++) {
      minCenterDistance = Math.min(minCenterDistance, Math.sqrt(labSqDist(centerLab[i], centerLab[j])));
    }
  }

  // Build the 48×6 distance matrix for non-center stickers.
  const nonCenterIdx = [];
  for (let i = 0; i < allLab.length; i++) {
    if (i % 9 !== 4) nonCenterIdx.push(i);
  }
  const distMatrix = nonCenterIdx.map((i) =>
    centerLab.map((ref) => labSqDist(allLab[i], ref))
  );

  const nonCenterAssigns = capacitatedStableMatch(distMatrix, 8);

  // Reassemble assignments for all 54 stickers (centers go to their own face).
  const assignments = new Array(allLab.length).fill(-1);
  SCAN_FACES.forEach((_, f) => { assignments[f * 9 + 4] = f; });
  nonCenterIdx.forEach((stickerIdx, k) => {
    assignments[stickerIdx] = nonCenterAssigns[k];
  });

  // Per-face per-cell cluster id.
  const sampleClusters = {};
  SCAN_FACES.forEach((face, f) => {
    sampleClusters[face] = [];
    for (let cell = 0; cell < 9; cell++) {
      sampleClusters[face].push(assignments[f * 9 + cell]);
    }
  });

  // By construction face f's center belongs to cluster f.
  const faceColorIdx = {};
  SCAN_FACES.forEach((face, f) => { faceColorIdx[face] = f; });

  const clusterCounts = new Array(SCAN_FACES.length).fill(0);
  for (const a of assignments) clusterCounts[a]++;

  // Centroids are simply the captured RGB of each center.
  const centroids = SCAN_FACES.map((_, f) => allRgb[f * 9 + 4].slice());

  // Surface diagnostic info so validateClassification can flag low-quality
  // scans (stickers whose color is nearly equidistant between two centers).
  const ambiguities = [];
  for (let i = 0; i < allLab.length; i++) {
    if (i % 9 === 4) continue;
    const dists = centerLab.map((ref) => Math.sqrt(labSqDist(allLab[i], ref)));
    const sorted = dists.slice().sort((a, b) => a - b);
    ambiguities.push({ ratio: sorted[1] === 0 ? Infinity : sorted[0] / sorted[1] });
  }

  return {
    faceColorIdx,
    sampleClusters,
    clusterCounts,
    centroids,
    ambiguities,
    sampleQuality,
    minCenterDistance,
  };
}

function classifySamples2x2(captured) {
  const allRgb = [];
  for (const face of SCAN_FACES) {
    for (const s of captured[face]) allRgb.push(s);
  }
  const allLab = allRgb.map(rgbToLab);
  const referenceLab = WCA_RGB.map(rgbToLab);
  const sampleQuality = allRgb.map(sample => sample.meta || {
    quality: 1,
    glareRatio: 0,
    darkRatio: 0,
  });

  const distMatrix = allLab.map((lab) =>
    referenceLab.map((ref) => labSqDist(lab, ref))
  );
  const assignments = capacitatedStableMatch(distMatrix, 4);

  const sampleClusters = {};
  SCAN_FACES.forEach((face, f) => {
    sampleClusters[face] = [];
    for (let cell = 0; cell < 4; cell++) {
      sampleClusters[face].push(assignments[f * 4 + cell]);
    }
  });

  const clusterCounts = new Array(SCAN_FACES.length).fill(0);
  for (const a of assignments) clusterCounts[a]++;

  const ambiguities = allLab.map((lab) => {
    const dists = referenceLab.map((ref) => Math.sqrt(labSqDist(lab, ref)));
    const sorted = dists.slice().sort((a, b) => a - b);
    return { ratio: sorted[1] === 0 ? Infinity : sorted[0] / sorted[1] };
  });

  let minCenterDistance = Infinity;
  for (let i = 0; i < referenceLab.length; i++) {
    for (let j = i + 1; j < referenceLab.length; j++) {
      minCenterDistance = Math.min(minCenterDistance, Math.sqrt(labSqDist(referenceLab[i], referenceLab[j])));
    }
  }

  return {
    faceColorIdx: { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 },
    clusterToFaceIdx: [0, 1, 2, 3, 4, 5],
    sampleClusters,
    clusterCounts,
    centroids: WCA_RGB.map(rgb => rgb.slice()),
    ambiguities,
    sampleQuality,
    minCenterDistance,
    size: 2,
  };
}

// Cluster sizes are guaranteed exactly 9 by classifySamples, so the only
// remaining failure modes are "two face centers look like the same color"
// (broken scan, no way to disambiguate downstream) or "a lot of stickers are
// nearly equidistant between two colors" (scan quality is poor enough that
// the assignment is unreliable). Both lead to a clear, actionable message.
export function validateClassification(classification, size = 3) {
  const issues = [];
  const { ambiguities = [], sampleQuality = [], minCenterDistance = Infinity } = classification;

  if (size === 3) {
    const weakCenters = SCAN_FACES.filter((_, f) => {
      const q = sampleQuality[f * 9 + 4];
      return q && (q.quality < 0.18 || q.darkRatio > 0.56);
    });
    if (weakCenters.length) {
      issues.push(
        `The ${weakCenters.map(face => SCAN_INSTRUCTIONS[face].label).join(', ')} center sample is too shadowed or blocked. ` +
        'Center the cube inside the frame and re-scan that face.'
      );
    }
  } else {
    const weakSamples = sampleQuality.filter(q => q && (q.quality < 0.14 || q.darkRatio > 0.64)).length;
    if (weakSamples >= 3) {
      issues.push(
        `${weakSamples} stickers look too shadowed or blocked. Center the 2x2 face in the frame and re-scan with brighter light.`
      );
    }
  }

  if (size === 3 && minCenterDistance < 13) {
    issues.push(
      'Two center colors look almost identical in this lighting. Re-scan with less glare and more even light.'
    );
  }

  // Flag scans where the gap between best- and second-best color is so small
  // that the assignment is essentially a coin flip.
  const veryAmbiguous = ambiguities.filter(a => a.ratio > 0.92).length;
  if (veryAmbiguous >= (size === 2 ? 4 : 5)) {
    issues.push(
      `${veryAmbiguous} stickers are nearly the same distance to two colors. ` +
      'Re-scan with brighter, more even lighting and avoid glare on the stickers.'
    );
  }

  return issues;
}

// Apply a classification to a CubeState in-place. Cluster ids are remapped to
// the cube's URFDLB face-index enum so the resulting facelet string is valid
// input for downstream solvers.
export function applyScanToCubeState(cubeState, classification, size = 3) {
  // Cluster id → URFDLB face index, derived from each scanned center sticker.
  const clusterToFaceIdx = classification.clusterToFaceIdx
    ? classification.clusterToFaceIdx.slice()
    : new Array(6).fill(-1);
  if (!classification.clusterToFaceIdx) {
    for (const face of SCAN_FACES) {
      clusterToFaceIdx[classification.faceColorIdx[face]] = FACE_INDEX[face];
    }
  }

  cubeState.reset();
  const gridSize = size === 2 ? 2 : 3;
  for (const face of SCAN_FACES) {
    const clusters = classification.sampleClusters[face];
    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const [x, y, z] = scanGridToCubie(face, r, c, size);
        const cubie = cubeState.cubies.find(cu =>
          cu.position[0] === x && cu.position[1] === y && cu.position[2] === z
        );
        if (cubie) cubie.colors[face] = clusterToFaceIdx[clusters[r * gridSize + c]];
      }
    }
  }
}

// For UI: which preview swatches to draw for the chip after a face is captured.
// Maps each cell's RGB to a hex string for display.
export function rgbToHex([r, g, b]) {
  const n = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${n(r)}${n(g)}${n(b)}`;
}
