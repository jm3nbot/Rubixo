import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ALL_MOVES, CubeState } from './cubeState.js?v=11';
import { CubeView } from './cubeView.js?v=12';
import { Interaction } from './interaction.js?v=13';
import { describeMove, solveFromHistory, solveFromFacelets, invertMove } from './solver.js?v=10';
import {
  SCAN_FACES,
  SCAN_INSTRUCTIONS,
  sampleVideoGrid,
  classifySamples,
  validateClassification,
  applyScanToCubeState,
  rgbToHex,
} from './scanner.js?v=11';
import {
  PAINT_COLORS,
  applyFaceletColorsToCubeState,
  buildPaintFaceletString,
  faceletIndexFromSticker,
  getPaintCounts,
  makeBlankFaceletColors,
  validatePaintCounts,
  validatePhysicalState,
} from './manualPaint.js?v=9';

// ─── Scene setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('cube-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.2));
renderer.shadowMap.enabled = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.82;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030812);
const BACKGROUND_THEMES = {
  dark: { label: 'Dark', scene: 0x030812 },
  cream: { label: 'Cream', scene: 0xf3eddf },
  hologram: { label: 'Hologram', scene: 0x020515 },
};

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
camera.position.set(5.8, 4.7, 8.6);

// Environment
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const env = pmremGenerator.fromScene(new RoomEnvironment()).texture;
scene.environment = env;

// Lights
const ambient = new THREE.AmbientLight(0xffffff, 0.45);
scene.add(ambient);

const hemi = new THREE.HemisphereLight(0xfff4e0, 0x4a6cff, 0.42);
hemi.position.set(0, 1, 0);
scene.add(hemi);

const dirA = new THREE.DirectionalLight(0xffffff, 0.75);
dirA.position.set(5, 8, 6);
scene.add(dirA);

const dirB = new THREE.DirectionalLight(0x8090ff, 0.34);
dirB.position.set(-4, 2, -5);
scene.add(dirB);

// Bottom under-glow: ring of soft point lights below the cube
const underGlowGroup = new THREE.Group();
const underColor = 0x9ec8ff;
const underY = -2.1;
const underRadius = 2.6;
for (let i = 0; i < 6; i++) {
  const theta = (i / 6) * Math.PI * 2;
  const p = new THREE.PointLight(underColor, 0.42, 8, 1.6);
  p.position.set(Math.cos(theta) * underRadius, underY, Math.sin(theta) * underRadius);
  underGlowGroup.add(p);
}
// Plus a strong central up-light
const centerUp = new THREE.PointLight(0xffe7c0, 0.52, 6, 1.4);
centerUp.position.set(0, underY + 0.2, 0);
underGlowGroup.add(centerUp);
scene.add(underGlowGroup);

// ─── Camera controls ─────────────────────────────────────────────────────────

const orbit = new TrackballControls(camera, canvas);
orbit.enableDamping = true;
orbit.dynamicDampingFactor = 0.08;
orbit.noPan = true;
orbit.target.set(0, 0, 0);
orbit.minDistance = 4.4;
orbit.maxDistance = 16;
orbit.zoomSpeed = 2.2;
orbit.rotateSpeed = 3.0;
orbit.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,     // click-and-drag in empty space orbits;
                                // interaction.js disables orbit when a sticker is hit
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};
orbit.touches = {
  ONE: THREE.TOUCH.ROTATE,      // single-finger drag rotates camera (when not on a sticker)
  TWO: THREE.TOUCH.DOLLY_ROTATE,
};

// ─── State + View ────────────────────────────────────────────────────────────

const state = new CubeState();
const view = new CubeView(scene);
const paintRaycaster = new THREE.Raycaster();

let moveCount = 0;
let lastMove = '';
let moveHistory = [];
let solverMode = 'idle';
let guidedStartCount = 0;
let quickPlan = [];
let quickIndex = 0;
let isQuickSolving = false;
let isGuidedPreviewing = false;
let isCameraTransitioning = false;
let guidedAutoAdvance = false;
let guidedNoLoop = false;
let guidedLoopToken = 0;
let guidedLoopTimer = null;
let guidedPreviewMove = null;
let guidedPreviewedStepKey = '';
let guidedUndoStack = [];
let solverOpen = false;
let controlsOpen = false;
let turnDuration = 180;
let isScrambling = false;
let activeCameraStream = null;
let backgroundTheme = 'dark';
let motionBlurEnabled = false;
const colorSchemes = ['pastel', 'normal', 'vibrant'];
let colorSchemeIndex = colorSchemes.indexOf(view.colorScheme);
const SCAN_FACE_LABELS_2 = { F: 'Front', R: 'Right', B: 'Back', L: 'Left', U: 'Top', D: 'Bottom' };
const GUIDE_AUTO_DELAY_MS = 2800;
const GUIDE_REPEAT_DELAY_MS = 2600;
const GUIDE_CAMERA_MS = 780;
const GUIDE_CAMERA_VIEWS = {
  F: new THREE.Vector3(4.2, 2.9, 8.4),
  R: new THREE.Vector3(8.4, 2.9, 4.2),
  B: new THREE.Vector3(-4.2, 2.9, -8.4),
  L: new THREE.Vector3(-8.4, 2.9, -4.2),
  U: new THREE.Vector3(4.8, 8.8, 4.8),
  D: new THREE.Vector3(4.8, -8.8, 4.8),
};
const paintState = {
  active: false,
  selectedColorIdx: PAINT_COLORS[0].colorIdx,
  faceletColors: makeBlankFaceletColors(),
  pointerStart: null,
  pendingHit: null,
  solving: false,
};

function refreshUI() {
  const cubeSize = getCubeSize();
  const busy = isQuickSolving || isScrambling;
  document.getElementById('move-count').textContent = moveCount;
  document.getElementById('last-move').textContent = lastMove || '—';
  document.getElementById('solved-badge').style.display = state.isSolved() ? 'flex' : 'none';
  document.getElementById('btn-scheme').textContent = view.getColorSchemeLabel();
  document.getElementById('ui').classList.toggle('solver-open', solverOpen);
  document.getElementById('ui').classList.toggle('paint-open', paintState.active);
  document.getElementById('ui').classList.toggle('controls-open', controlsOpen);
  document.body.classList.toggle('paint-mode', paintState.active);
  document.getElementById('btn-solver-toggle').classList.toggle('btn--accent', solverOpen);
  document.getElementById('btn-camera').disabled = false;
  document.getElementById('btn-paint').disabled = cubeSize !== 3;
  document.getElementById('btn-scramble').disabled = busy;
  document.getElementById('btn-reset').disabled = busy;
  document.getElementById('btn-undo').disabled = busy;
  document.body.classList.toggle('motion-blur', motionBlurEnabled);
  refreshLabControls();
}

function getCubeSize() {
  return state.size === 2 ? 2 : 3;
}

function setSolverOpen(open) {
  solverOpen = open;
  if (!solverOpen) stopGuidedPreviewLoop(true);
  refreshUI();
  updateSolverUI();
}

function getVisibleSolution() {
  if (solverMode === 'quick') {
    return {
      plan: quickPlan,
      index: quickIndex,
      total: quickPlan.length,
      remaining: Math.max(0, quickPlan.length - quickIndex),
    };
  }

  const plan = solveFromHistory(moveHistory);
  const total = solverMode === 'guided' ? Math.max(guidedStartCount, plan.length) : plan.length;
  const done = Math.max(0, total - plan.length);
  return { plan, index: 0, total, remaining: plan.length, done };
}

function updateSolverUI() {
  const { plan, index, total, remaining, done = index } = getVisibleSolution();
  const nextMove = plan[index];
  const isSolved = state.isSolved();
  const status = document.getElementById('solver-status');
  const modeLabel = document.getElementById('solver-mode-label');
  const progressLabel = document.getElementById('solver-progress-label');
  const sequence = document.getElementById('solver-sequence');
  const quickBtn = document.getElementById('btn-quick-solve');
  const guidedBtn = document.getElementById('btn-guided-solve');
  const nextBtn = document.getElementById('btn-guided-next');
  const autoBtn = document.getElementById('btn-guided-auto');
  const loopBtn = document.getElementById('btn-guided-loop');
  const undoStepBtn = document.getElementById('btn-guided-undo');
  const guideModeValue = document.getElementById('guide-mode-value');

  if (!solverOpen) {
    view.clearMoveHint();
  }

  if (isSolved) {
    status.textContent = 'Solved. Scramble again when you want a new path.';
  } else if (solverMode === 'guided') {
    status.textContent = guidedAutoAdvance
      ? 'Auto guide is on. Each preview commits after the pause, then moves to the next step.'
      : guidedNoLoop
        ? 'No Loop is on. The next move previews once, then waits for Next step or Enter.'
        : 'Watch the slow preview loop, do it on your cube, then press Next step or Enter.';
  } else if (solverMode === 'quick') {
    status.textContent = 'Solving automatically. Watch the cube follow each arrow.';
  } else {
    status.textContent = remaining ? 'A guided path is ready for this cube state.' : 'Scramble the cube, then solve it automatically or follow the guide.';
  }

  if (nextMove) {
    const info = describeMove(nextMove);
    document.getElementById('solver-arrow').textContent = info.arrow;
    document.getElementById('solver-move').textContent = info.title;
    document.getElementById('solver-detail').textContent = info.detail;
    if (solverOpen) view.showMoveHint(nextMove);
  } else {
    document.getElementById('solver-arrow').textContent = isSolved ? 'OK' : '--';
    document.getElementById('solver-move').textContent = isSolved ? 'Solved' : 'Ready';
    document.getElementById('solver-detail').textContent = isSolved ? 'The cube is back to a solved state.' : 'A move sequence will appear here.';
    view.clearMoveHint();
  }

  const denominator = Math.max(1, total);
  const pct = isSolved ? 100 : Math.min(100, Math.round((done / denominator) * 100));
  document.getElementById('solver-bar-fill').style.width = `${pct}%`;
  progressLabel.textContent = remaining === 1 ? '1 step left' : `${remaining} steps left`;
  modeLabel.textContent = solverMode === 'quick' ? 'auto' : solverMode === 'guided' ? 'guided' : 'ready';
  quickBtn.disabled = isQuickSolving || isSolved || remaining === 0;
  guidedBtn.disabled = isQuickSolving || isSolved || remaining === 0;
  guidedBtn.textContent = solverMode === 'guided' ? 'Guiding' : 'Guided Solve';
  nextBtn.disabled = solverMode !== 'guided' || isQuickSolving || isSolved || remaining === 0 || isGuidedPreviewing;
  autoBtn.disabled = solverMode !== 'guided' || isSolved || remaining === 0;
  autoBtn.textContent = guidedAutoAdvance ? 'Auto On' : 'Auto';
  autoBtn.classList.toggle('is-selected', guidedAutoAdvance);
  loopBtn.disabled = solverMode !== 'guided' || isSolved || remaining === 0;
  loopBtn.classList.toggle('is-selected', guidedNoLoop);
  undoStepBtn.disabled = solverMode !== 'guided' || isQuickSolving || isGuidedPreviewing || isCameraTransitioning || guidedUndoStack.length === 0;
  if (guideModeValue) {
    guideModeValue.textContent = guidedAutoAdvance ? 'Auto' : guidedNoLoop ? 'No loop' : 'Loop';
  }

  sequence.replaceChildren();
  plan.forEach((move, i) => {
    const chip = document.createElement('span');
    chip.className = 'move-chip';
    if (solverMode === 'quick' && i < quickIndex) chip.classList.add('is-done');
    if (i === index && nextMove) chip.classList.add('is-current');
    chip.textContent = i + 1;
    chip.title = describeMove(move).detail;
    sequence.appendChild(chip);
  });

  const guidedStepKey = `${done}:${nextMove || ''}`;
  const shouldPreviewStep = !guidedNoLoop || guidedPreviewedStepKey !== guidedStepKey;
  if (solverOpen && solverMode === 'guided' && shouldPreviewStep && nextMove && !isGuidedPreviewing && !isCameraTransitioning && !guidedPreviewMove && !guidedLoopTimer && !view.isAnimating) {
    scheduleGuidedPreviewLoop(300);
  }
}

function setTheme(scheme) {
  const idx = colorSchemes.indexOf(scheme);
  if (idx < 0) return;
  colorSchemeIndex = idx;
  view.setColorScheme(scheme);
  refreshUI();
}

function setBackgroundTheme(theme) {
  if (!BACKGROUND_THEMES[theme]) return;
  backgroundTheme = theme;
  document.body.dataset.bgTheme = theme;
  scene.background.setHex(BACKGROUND_THEMES[theme].scene);
  refreshUI();
}

function setMotionBlur(enabled) {
  motionBlurEnabled = !!enabled;
  if (!motionBlurEnabled) document.body.classList.remove('cube-moving');
  refreshUI();
}

function setCubeMoving(moving) {
  document.body.classList.toggle('cube-moving', motionBlurEnabled && moving);
}

function cycleColorScheme() {
  const next = colorSchemes[(colorSchemeIndex + 1) % colorSchemes.length];
  setTheme(next);
}

function setControlsOpen(open) {
  controlsOpen = open;
  refreshUI();
}

function setCubeSize(size) {
  const nextSize = Number(size) === 2 ? 2 : 3;
  if (view.isAnimating || isQuickSolving || isScrambling || getCubeSize() === nextSize) return;

  closeCameraOverlay();
  if (paintState.active) closePaintMode();
  state.setSize(nextSize);
  moveHistory = [];
  moveCount = 0;
  lastMove = `${nextSize}x${nextSize}`;
  solverMode = 'idle';
  stopGuidedPreviewLoop(true);
  guidedUndoStack = [];
  guidedStartCount = 0;
  quickPlan = [];
  quickIndex = 0;
  view.syncFromState(state);
  refreshUI();
  updateSolverUI();
}

function refreshLabControls() {
  const cubeSize = getCubeSize();
  const themeValue = document.getElementById('theme-value');
  const speedValue = document.getElementById('speed-value');
  const gapValue = document.getElementById('gap-value');
  const glareValue = document.getElementById('glare-value');
  const plasticGlareValue = document.getElementById('plastic-glare-value');
  const motionBlurValue = document.getElementById('motion-blur-value');
  const motionBlurToggle = document.getElementById('motion-blur-toggle');
  const cubeSizeValue = document.getElementById('cube-size-value');
  const backgroundValue = document.getElementById('background-value');
  if (!themeValue || !speedValue || !gapValue || !glareValue || !plasticGlareValue || !motionBlurValue || !motionBlurToggle || !cubeSizeValue || !backgroundValue) return;

  cubeSizeValue.textContent = `${cubeSize}x${cubeSize}`;
  themeValue.textContent = view.getColorSchemeLabel();
  backgroundValue.textContent = BACKGROUND_THEMES[backgroundTheme].label;
  speedValue.textContent = `${turnDuration} ms`;
  const gapPct = Math.round(((view.cubieSpacing - 0.94) / (1.18 - 0.94)) * 100);
  gapValue.textContent = gapPct <= 4 ? 'zero' : gapPct >= 80 ? 'wide' : `${gapPct}%`;
  glareValue.textContent = `${Math.round((view.stickerGlare / 0.8) * 100)}%`;
  plasticGlareValue.textContent = `${Math.round((view.bodyGlare / 0.45) * 100)}%`;
  motionBlurValue.textContent = motionBlurEnabled ? 'On' : 'Off';
  motionBlurToggle.textContent = motionBlurEnabled ? 'On' : 'Off';
  motionBlurToggle.classList.toggle('is-selected', motionBlurEnabled);

  for (const btn of document.querySelectorAll('.theme-option')) {
    btn.classList.toggle('is-selected', btn.dataset.theme === view.colorScheme);
  }
  for (const btn of document.querySelectorAll('.bg-option')) {
    btn.classList.toggle('is-selected', btn.dataset.bg === backgroundTheme);
  }
  for (const btn of document.querySelectorAll('.cube-option')) {
    btn.classList.toggle('is-selected', Number(btn.dataset.size) === cubeSize);
  }
}

function setTurnSpeed(value) {
  turnDuration = Number(value);
  document.getElementById('turn-speed').value = String(turnDuration);
  refreshLabControls();
}

function setCubieGap(value) {
  const pct = Number(value) / 100;
  const spacing = THREE.MathUtils.lerp(0.94, 1.18, pct);
  view.setCubieSpacing(spacing);
  document.getElementById('cubie-gap').value = String(value);
  refreshLabControls();
}

function setStickerGlare(value) {
  const pct = Number(value) / 100;
  view.setStickerGlare(THREE.MathUtils.lerp(0, 0.8, pct));
  document.getElementById('sticker-glare').value = String(value);
  refreshLabControls();
}

function setPlasticGlare(value) {
  const pct = Number(value) / 100;
  view.setBodyGlare(THREE.MathUtils.lerp(0, 0.45, pct));
  document.getElementById('plastic-glare').value = String(value);
  refreshLabControls();
}

function makeScrambleSequence(n) {
  const seq = [];
  let last = '';
  for (let i = 0; i < n; i++) {
    let move;
    do {
      move = ALL_MOVES[Math.floor(Math.random() * ALL_MOVES.length)];
    } while (move.replace(/['2]/g, '') === last);
    last = move.replace(/['2]/g, '');
    seq.push(move);
  }
  return seq;
}

function handleStickerImageSelected(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const loader = new THREE.TextureLoader();
  loader.load(url, (texture) => {
    URL.revokeObjectURL(url);
    view.setStickerTexture(texture);
    document.getElementById('image-file-label').textContent = file.name;
  }, undefined, () => {
    URL.revokeObjectURL(url);
    document.getElementById('image-file-label').textContent = 'Could not load image';
  });
}

function clearStickerImage() {
  view.clearStickerTexture();
  const input = document.getElementById('sticker-image-input');
  input.value = '';
  document.getElementById('image-file-label').textContent = 'No image selected';
}

async function doScramble() {
  if (isQuickSolving || isScrambling || view.isAnimating) return;
  if (paintState.active) closePaintMode();

  const seq = makeScrambleSequence(getCubeSize() === 2 ? 14 : 20);
  const animateMs = Math.max(45, Math.min(78, Math.round(1100 / seq.length)));
  isScrambling = true;
  setCubeMoving(true);
  solverMode = 'idle';
  stopGuidedPreviewLoop(true);
  guidedUndoStack = [];
  quickPlan = [];
  quickIndex = 0;
  guidedStartCount = 0;
  moveCount = 0;
  lastMove = 'scrambling';
  state.clearUndo();
  refreshUI();
  updateSolverUI();

  for (const move of seq) {
    const moved = await applyAnimatedMove(move, {
      recordHistory: true,
      recordUndo: false,
      countMove: false,
      syncView: false,
      animateMs,
    });
    if (!moved) break;
    await new Promise(resolve => setTimeout(resolve, 4));
  }

  moveCount = 0;
  lastMove = 'scrambled';
  isScrambling = false;
  setCubeMoving(false);
  view.syncFromState(state);
  refreshUI();
  updateSolverUI();
}

function doReset() {
  if (isQuickSolving || isScrambling) return;
  if (paintState.active) closePaintMode();
  state.reset();
  moveHistory = [];
  solverMode = 'idle';
  guidedUndoStack = [];
  stopGuidedPreviewLoop(true);
  view.syncFromState(state);
  moveCount = 0;
  lastMove = '';
  refreshUI();
  updateSolverUI();
}

function doUndo() {
  if (view.isAnimating || isQuickSolving || isScrambling) return;
  if (paintState.active) closePaintMode();
  stopGuidedPreviewLoop(true);
  const inverse = state.undoMove();
  if (!inverse) return;
  moveHistory.pop();
  view.syncFromState(state);
  moveCount = Math.max(0, moveCount - 1);
  lastMove = inverse + ' (undo)';
  refreshUI();
  updateSolverUI();
}

function applyAnimatedMove(move, { recordHistory = true, recordUndo = true, countMove = true, syncView = true, animateMs = turnDuration } = {}) {
  if (view.isAnimating) return Promise.resolve(false);
  setCubeMoving(true);
  return new Promise(resolve => {
    view.applyMove(move, animateMs, () => {
      state.applyMove(move, recordUndo);
      if (syncView) view.syncFromState(state);
      if (recordHistory) moveHistory.push(move);
      if (countMove) moveCount++;
      lastMove = move;
      refreshUI();
      updateSolverUI();
      if (!isScrambling && !isQuickSolving) setCubeMoving(false);
      resolve(true);
    });
  });
}

async function doQuickSolve() {
  if (isQuickSolving || isScrambling || state.isSolved()) return;
  stopGuidedPreviewLoop(true);
  quickPlan = solveFromHistory(moveHistory);
  if (!quickPlan.length) return;

  solverMode = 'quick';
  quickIndex = 0;
  isQuickSolving = true;
  updateSolverUI();

  for (quickIndex = 0; quickIndex < quickPlan.length; quickIndex++) {
    updateSolverUI();
    const moved = await applyAnimatedMove(quickPlan[quickIndex], {
      recordHistory: false,
      recordUndo: false,
      animateMs: Math.max(55, Math.round(turnDuration * 0.68)),
    });
    if (!moved) break;
    await new Promise(resolve => setTimeout(resolve, 35));
  }

  moveHistory = state.isSolved() ? [] : moveHistory;
  quickIndex = quickPlan.length;
  isQuickSolving = false;
  setCubeMoving(false);
  solverMode = state.isSolved() ? 'idle' : 'guided';
  updateSolverUI();
}

function doGuidedSolve() {
  if (isQuickSolving || isScrambling || state.isSolved()) return;
  const plan = solveFromHistory(moveHistory);
  if (!plan.length) return;
  solverMode = 'guided';
  guidedStartCount = plan.length;
  guidedUndoStack = [];
  solverOpen = true;
  stopGuidedPreviewLoop(true);
  updateSolverUI();
}

function stopGuidedPreviewLoop(resetView = false) {
  guidedLoopToken++;
  if (guidedLoopTimer) {
    clearTimeout(guidedLoopTimer);
    guidedLoopTimer = null;
  }
  guidedPreviewMove = null;
  if (resetView) guidedPreviewedStepKey = '';
  isCameraTransitioning = false;
  orbit.enabled = true;
  if (!isGuidedPreviewing && resetView) {
    view.syncFromState(state);
  }
}

function scheduleGuidedPreviewLoop(delay = 450) {
  if (guidedLoopTimer || solverMode !== 'guided' || !solverOpen || isScrambling || isQuickSolving || isCameraTransitioning || state.isSolved()) return;
  const token = guidedLoopToken;
  guidedLoopTimer = setTimeout(() => {
    guidedLoopTimer = null;
    runGuidedPreviewLoop(token);
  }, delay);
}

function easeCamera(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function angleDelta(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

function focusCameraForMove(move, token) {
  const base = move.replace(/['2]/g, '');
  const desired = GUIDE_CAMERA_VIEWS[base];
  if (!desired) return Promise.resolve(false);

  const start = camera.position.clone();
  const radius = Math.max(orbit.minDistance || 4.4, Math.min(orbit.maxDistance || 16, start.length()));
  const startSpherical = new THREE.Spherical().setFromVector3(start);
  const endSpherical = new THREE.Spherical().setFromVector3(desired.clone().normalize().multiplyScalar(radius));
  const thetaDelta = angleDelta(startSpherical.theta, endSpherical.theta);
  const phiDelta = endSpherical.phi - startSpherical.phi;
  if (Math.abs(thetaDelta) < 0.01 && Math.abs(phiDelta) < 0.01) return Promise.resolve(true);

  isCameraTransitioning = true;
  orbit.enabled = false;
  const startedAt = performance.now();

  return new Promise(resolve => {
    const tick = (now) => {
      if (token !== guidedLoopToken || solverMode !== 'guided' || !solverOpen) {
        isCameraTransitioning = false;
        orbit.enabled = true;
        resolve(false);
        return;
      }

      const t = Math.min(1, (now - startedAt) / GUIDE_CAMERA_MS);
      const eased = easeCamera(t);
      const current = new THREE.Spherical(
        radius,
        THREE.MathUtils.clamp(startSpherical.phi + phiDelta * eased, 0.04, Math.PI - 0.04),
        startSpherical.theta + thetaDelta * eased,
      );
      camera.position.setFromSpherical(current);
      camera.lookAt(orbit.target);
      if (t < 1) {
        requestAnimationFrame(tick);
        return;
      }

      isCameraTransitioning = false;
      orbit.enabled = true;
      orbit.update();
      resolve(true);
    };
    requestAnimationFrame(tick);
  });
}

async function runGuidedPreviewLoop(token) {
  if (token !== guidedLoopToken || solverMode !== 'guided' || !solverOpen || view.isAnimating || isCameraTransitioning || state.isSolved()) return;
  const plan = solveFromHistory(moveHistory);
  const move = plan[0];
  if (!move) return;

  guidedPreviewMove = null;
  guidedPreviewedStepKey = `${Math.max(0, guidedStartCount - plan.length)}:${move}`;
  const focused = await focusCameraForMove(move, token);
  if (!focused || token !== guidedLoopToken || solverMode !== 'guided' || !solverOpen || view.isAnimating || state.isSolved()) return;

  isGuidedPreviewing = true;
  setCubeMoving(true);
  refreshUI();
  updateSolverUI();
  view.showMoveHint(move);
  view.applyMove(move, Math.max(420, Math.round(turnDuration * 2.15)), () => {
    isGuidedPreviewing = false;
    setCubeMoving(false);
    if (token !== guidedLoopToken || solverMode !== 'guided' || !solverOpen) {
      view.syncFromState(state);
      refreshUI();
      updateSolverUI();
      return;
    }

    guidedPreviewMove = move;
    refreshUI();
    updateSolverUI();
    guidedLoopTimer = setTimeout(() => {
      guidedLoopTimer = null;
      if (token !== guidedLoopToken || solverMode !== 'guided' || !solverOpen) return;
      if (guidedAutoAdvance) {
        commitGuidedStep(true);
        return;
      }
      guidedPreviewMove = null;
      view.syncFromState(state);
      refreshUI();
      updateSolverUI();
    }, guidedAutoAdvance ? GUIDE_AUTO_DELAY_MS : GUIDE_REPEAT_DELAY_MS);
  });
}

function finishGuidedStep(move) {
  const expectedHistoryMove = invertMove(move);
  if (moveHistory[moveHistory.length - 1] === expectedHistoryMove) {
    moveHistory.pop();
  } else {
    moveHistory = solveFromHistory(moveHistory).slice(1).reverse().map(invertMove);
  }
  moveCount++;
  lastMove = move;
  guidedUndoStack.push(move);
  guidedPreviewMove = null;
  if (state.isSolved()) {
    moveHistory = [];
    solverMode = 'idle';
    guidedStartCount = 0;
    guidedAutoAdvance = false;
  }
  view.syncFromState(state);
  refreshUI();
  updateSolverUI();
}

function undoGuidedStep() {
  if (solverMode !== 'guided' || isQuickSolving || isScrambling || isGuidedPreviewing || isCameraTransitioning || guidedUndoStack.length === 0) return;
  stopGuidedPreviewLoop(true);
  const move = guidedUndoStack.pop();
  const inverse = invertMove(move);
  state.applyMove(inverse, false);
  moveHistory.push(inverse);
  moveCount = Math.max(0, moveCount - 1);
  lastMove = `${inverse} (step back)`;
  solverMode = 'guided';
  guidedStartCount = Math.max(guidedStartCount, solveFromHistory(moveHistory).length);
  view.syncFromState(state);
  refreshUI();
  updateSolverUI();
}

async function commitGuidedStep(fromPreview = false) {
  if (solverMode !== 'guided' || isQuickSolving || isScrambling || isGuidedPreviewing || isCameraTransitioning || state.isSolved()) return;
  if (guidedLoopTimer) {
    clearTimeout(guidedLoopTimer);
    guidedLoopTimer = null;
  }
  guidedLoopToken++;
  const plan = solveFromHistory(moveHistory);
  const move = plan[0];
  if (!move) return;

  if (fromPreview && guidedPreviewMove === move) {
    state.applyMove(move, false);
    finishGuidedStep(move);
    return;
  }

  guidedPreviewMove = null;
  const moved = await applyAnimatedMove(move, {
    recordHistory: false,
    recordUndo: false,
    countMove: false,
    animateMs: Math.max(130, Math.round(turnDuration * 1.1)),
  });
  if (!moved) return;
  finishGuidedStep(move);
}

function toggleGuidedAuto() {
  guidedAutoAdvance = !guidedAutoAdvance;
  updateSolverUI();
}

function toggleGuidedLoop() {
  guidedNoLoop = !guidedNoLoop;
  stopGuidedPreviewLoop(true);
  updateSolverUI();
  if (!guidedNoLoop) scheduleGuidedPreviewLoop(250);
}

// ─── Manual paint input ─────────────────────────────────────────────────────

function setPaintWarning(message) {
  document.getElementById('paint-warning').textContent = message || '';
}

function buildPaintPalette() {
  const palette = document.getElementById('paint-palette');
  palette.replaceChildren();

  for (const color of PAINT_COLORS) {
    const btn = document.createElement('button');
    btn.className = 'btn paint-swatch';
    btn.type = 'button';
    btn.dataset.colorIdx = String(color.colorIdx);
    btn.innerHTML = `
      <span class="paint-dot" style="background:${color.hex}"></span>
      <span>${color.label}</span>
      <span class="paint-count">0/9</span>
    `;
    btn.addEventListener('click', () => {
      paintState.selectedColorIdx = color.colorIdx;
      setPaintWarning('');
      refreshPaintUI();
    });
    palette.appendChild(btn);
  }
}

function refreshPaintUI() {
  const { counts, blanks } = getPaintCounts(paintState.faceletColors);
  const selected = PAINT_COLORS.find(c => c.colorIdx === paintState.selectedColorIdx) || PAINT_COLORS[0];
  const painted = 54 - blanks;
  const countIssues = validatePaintCounts(paintState.faceletColors).issues;

  document.getElementById('paint-filled-label').textContent = `${painted} of 54 painted`;
  document.getElementById('paint-selected-label').textContent = `${selected.label} selected`;
  document.getElementById('paint-bar-fill').style.width = `${Math.round((painted / 54) * 100)}%`;
  document.getElementById('btn-paint-solve').disabled = paintState.solving || blanks > 0 || countIssues.length > 0;
  document.getElementById('btn-paint-solve').textContent = paintState.solving ? 'Checking…' : 'Use for Solver';

  for (const btn of document.querySelectorAll('.paint-swatch')) {
    const colorIdx = Number(btn.dataset.colorIdx);
    const count = counts.get(colorIdx) || 0;
    btn.classList.toggle('is-selected', colorIdx === paintState.selectedColorIdx);
    btn.querySelector('.paint-count').textContent = `${count}/9`;
  }
}

function beginPaintMode() {
  if (isQuickSolving || isScrambling) return;
  if (state.size !== 3) return;
  closeCameraOverlay();
  stopGuidedPreviewLoop(true);
  solverOpen = false;
  paintState.active = true;
  paintState.solving = false;
  paintState.selectedColorIdx = PAINT_COLORS[0].colorIdx;
  paintState.faceletColors = makeBlankFaceletColors();
  paintState.pointerStart = null;
  paintState.pendingHit = null;

  // Manual input uses the physical WCA color palette, so switch the cube to
  // the normal visual scheme while the user paints.
  colorSchemeIndex = colorSchemes.indexOf('normal');
  view.setColorScheme('normal');
  applyFaceletColorsToCubeState(state, paintState.faceletColors);
  view.syncFromState(state);

  moveHistory = [];
  moveCount = 0;
  lastMove = 'painting';
  solverMode = 'idle';
  guidedUndoStack = [];
  interaction.setEnabled(false);
  setPaintWarning('');
  refreshPaintUI();
  refreshUI();
  updateSolverUI();
}

function closePaintMode() {
  paintState.active = false;
  paintState.pointerStart = null;
  paintState.pendingHit = null;
  interaction.setEnabled(true);
  setPaintWarning('');
  refreshUI();
}

function clearPaintMode() {
  paintState.faceletColors = makeBlankFaceletColors();
  applyFaceletColorsToCubeState(state, paintState.faceletColors);
  view.syncFromState(state);
  moveHistory = [];
  moveCount = 0;
  lastMove = 'painting';
  solverMode = 'idle';
  guidedUndoStack = [];
  stopGuidedPreviewLoop(true);
  setPaintWarning('');
  refreshPaintUI();
  refreshUI();
  updateSolverUI();
}

function getPaintHit(event) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  paintRaycaster.setFromCamera(ndc, camera);
  const hits = paintRaycaster.intersectObjects(view.getStickerMeshes(), false);
  if (!hits.length) return null;

  const sticker = hits[0].object;
  const cubie = sticker.parent;
  return {
    index: faceletIndexFromSticker(sticker.userData.face, cubie.position),
    sticker,
  };
}

function paintFacelet(index) {
  const selected = PAINT_COLORS.find(c => c.colorIdx === paintState.selectedColorIdx);
  const current = paintState.faceletColors[index];
  if (current === paintState.selectedColorIdx) return;

  const { counts } = getPaintCounts(paintState.faceletColors);
  const selectedCount = counts.get(paintState.selectedColorIdx) || 0;
  if (selectedCount >= 9) {
    setPaintWarning(`${selected.label} already has 9 stickers. Repaint one of them before adding another.`);
    refreshPaintUI();
    return;
  }

  paintState.faceletColors[index] = paintState.selectedColorIdx;
  applyFaceletColorsToCubeState(state, paintState.faceletColors);
  view.syncFromState(state);
  const validation = validatePaintCounts(paintState.faceletColors);
  setPaintWarning(validation.issues[0] || '');
  refreshPaintUI();
  refreshUI();

  if (!validation.issues.length && validation.blanks === 0) {
    solvePaintedCube();
  }
}

async function solvePaintedCube() {
  if (paintState.solving) return;
  paintState.solving = true;
  refreshPaintUI();
  setPaintWarning('Checking solvability…');

  try {
    const facelets = buildPaintFaceletString(paintState.faceletColors);
    const physicalIssues = validatePhysicalState(facelets);
    if (physicalIssues.length) {
      throw new Error(physicalIssues[0]);
    }
    const solveMoves = await solveFromFacelets(facelets);
    applyFaceletColorsToCubeState(state, paintState.faceletColors);
    view.syncFromState(state);
    moveHistory = solveMoves.slice().reverse().map(invertMove);
    moveCount = 0;
    lastMove = 'painted';
    solverMode = solveMoves.length ? 'guided' : 'idle';
    guidedStartCount = solveMoves.length;
    paintState.solving = false;
    closePaintMode();
    setSolverOpen(true);
    refreshUI();
    updateSolverUI();
  } catch (err) {
    paintState.solving = false;
    setPaintWarning(err.message || 'Unsolvable configuration. Check the painted stickers.');
    refreshPaintUI();
  }
}

function handlePaintPointerDown(event) {
  if (!paintState.active || event.button !== 0 || paintState.solving) return;
  const hit = getPaintHit(event);
  if (!hit) return;

  paintState.pointerStart = { x: event.clientX, y: event.clientY };
  paintState.pendingHit = hit;
  event.stopPropagation();
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
}

function handlePaintPointerUp(event) {
  if (!paintState.active || !paintState.pendingHit) return;

  const dx = event.clientX - paintState.pointerStart.x;
  const dy = event.clientY - paintState.pointerStart.y;
  const hit = paintState.pendingHit;
  paintState.pointerStart = null;
  paintState.pendingHit = null;

  event.stopPropagation();
  event.preventDefault();
  try { canvas.releasePointerCapture(event.pointerId); } catch (err) {}

  if (Math.hypot(dx, dy) <= 8) {
    paintFacelet(hit.index);
  }
}

// ─── Cube scanner ────────────────────────────────────────────────────────────

const scanState = {
  step: 0,
  captured: {},   // { F: [9 [r,g,b]], R: [...], ... }
};
window.__scan = scanState;

function setScanError(message) {
  document.getElementById('camera-error').textContent = message || '';
}

function refreshScanUI() {
  const face = SCAN_FACES[scanState.step];
  const scanSize = getCubeSize();
  const cellCount = scanSize * scanSize;
  const stepLabel = document.getElementById('camera-step-num');
  const title = document.getElementById('camera-step-title');
  const status = document.getElementById('camera-status');
  const captureBtn = document.getElementById('btn-camera-capture');
  const backBtn = document.getElementById('btn-camera-back');
  const frame = document.getElementById('camera-scan-frame');
  const modal = document.getElementById('camera-modal');

  frame.classList.toggle('scan-frame--2', scanSize === 2);
  modal.classList.toggle('scan-size-2', scanSize === 2);

  if (face) {
    const inst = SCAN_INSTRUCTIONS[face];
    stepLabel.textContent = `Step ${scanState.step + 1} of 6`;
    title.textContent = scanSize === 2 ? `${SCAN_FACE_LABELS_2[face]} face` : inst.label;
    status.textContent = scanSize === 2
      ? `Fit this 2x2 face inside the four boxes. Use the same order: front, right, back, left, top, bottom. Smart detect will balance four stickers per color.`
      : inst.body;
    captureBtn.textContent = scanState.step === 5 ? 'Capture & finish' : 'Capture face';
    captureBtn.disabled = false;
  } else {
    stepLabel.textContent = 'Done';
    title.textContent = 'Scan complete';
    status.textContent = 'Processing colors…';
    captureBtn.disabled = true;
  }
  backBtn.disabled = scanState.step === 0;

  for (const f of SCAN_FACES) {
    const chip = document.querySelector(`.scan-chip[data-face="${f}"]`);
    if (!chip) continue;
    chip.classList.toggle('is-active', f === face);
    chip.classList.toggle('is-done', !!scanState.captured[f]);
    const label = chip.querySelector('.scan-chip-label');
    if (label) label.textContent = scanSize === 2 ? SCAN_FACE_LABELS_2[f] : (SCAN_INSTRUCTIONS[f].chip || f);
    const swatchHost = chip.querySelector('.scan-chip-swatches');
    swatchHost.classList.toggle('scan-chip-swatches--2', scanSize === 2);
    swatchHost.replaceChildren();
    const cells = scanState.captured[f] || new Array(cellCount).fill(null);
    for (const cell of cells) {
      const sw = document.createElement('span');
      sw.className = 'swatch';
      if (cell) sw.style.background = rgbToHex(cell);
      swatchHost.appendChild(sw);
    }
  }
}

async function openCameraOverlay() {
  if (isScrambling) return;
  stopGuidedPreviewLoop(true);
  const modal = document.getElementById('camera-modal');
  const video = document.getElementById('camera-video');

  // Scanner always uses real WCA colors, independent of the decorative palette
  // toggle, so the scanned cube does not come back pink/pastel by accident.
  colorSchemeIndex = colorSchemes.indexOf('normal');
  view.setColorScheme('normal');
  refreshUI();

  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  scanState.step = 0;
  scanState.captured = {};
  setScanError('');
  refreshScanUI();

  if (activeCameraStream) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setScanError('Camera access is not available in this browser.');
    document.getElementById('btn-camera-capture').disabled = true;
    return;
  }

  try {
    activeCameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    video.srcObject = activeCameraStream;
    await video.play();
  } catch (error) {
    activeCameraStream = null;
    video.srcObject = null;
    setScanError(error && error.name === 'NotAllowedError'
      ? 'Camera permission was blocked. Allow it in your browser settings, then reopen.'
      : 'Could not open the camera.');
    document.getElementById('btn-camera-capture').disabled = true;
  }
}

function closeCameraOverlay() {
  const modal = document.getElementById('camera-modal');
  const video = document.getElementById('camera-video');

  if (activeCameraStream) {
    activeCameraStream.getTracks().forEach(track => track.stop());
    activeCameraStream = null;
  }

  video.pause();
  video.srcObject = null;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  setScanError('');
}

function handleCaptureFace() {
  const face = SCAN_FACES[scanState.step];
  if (!face) return;
  const video = document.getElementById('camera-video');
  const frame = document.getElementById('camera-scan-frame');
  if (!activeCameraStream || video.videoWidth === 0) {
    setScanError('The camera feed isn’t ready yet — wait a second and try again.');
    return;
  }
  const samples = sampleVideoGrid(video, frame.getBoundingClientRect(), getCubeSize());
  if (!samples) {
    setScanError('Could not read a frame from the camera.');
    return;
  }
  scanState.captured[face] = samples;
  setScanError('');
  scanState.step += 1;

  if (scanState.step >= SCAN_FACES.length) {
    finalizeScan();
  } else {
    refreshScanUI();
  }
}

function handleScanBack() {
  if (scanState.step === 0) return;
  scanState.step -= 1;
  // Allow the user to re-shoot the previous face by clearing it.
  delete scanState.captured[SCAN_FACES[scanState.step]];
  setScanError('');
  refreshScanUI();
}

function handleChipClick(face) {
  const targetStep = SCAN_FACES.indexOf(face);
  if (targetStep < 0) return;
  // Clear the clicked face and all faces that come after it so the
  // user can re-scan in order from this point.
  for (let i = targetStep; i < SCAN_FACES.length; i++) {
    delete scanState.captured[SCAN_FACES[i]];
  }
  scanState.step = targetStep;
  setScanError('');
  refreshScanUI();
}

async function finalizeScan() {
  refreshScanUI();
  let classification;
  try {
    classification = classifySamples(scanState.captured, getCubeSize());
  } catch (err) {
    console.error(err);
    setScanError('Something went wrong processing the scan. Please try again.');
    return;
  }

  const issues = validateClassification(classification, getCubeSize());
  if (issues.length) {
    setScanError(issues.join(' ') + ' Tap "Back" to retry the last face.');
    // Step back so the user can re-shoot the most recent face.
    scanState.step = SCAN_FACES.length - 1;
    delete scanState.captured[SCAN_FACES[scanState.step]];
    refreshScanUI();
    return;
  }

  applyScanToCubeState(state, classification, getCubeSize());
  view.syncFromState(state);
  moveHistory = [];
  moveCount = 0;
  lastMove = 'scanned';
  solverMode = 'idle';
  guidedUndoStack = [];
  stopGuidedPreviewLoop(true);
  refreshUI();
  updateSolverUI();
  document.getElementById('camera-status').textContent = 'Checking if this scanned state is physically solvable…';
  document.getElementById('btn-camera-capture').disabled = true;

  // Compute the solve plan asynchronously so the UI can paint the scanned
  // cube before the (heavy) Kociemba initialization runs.
  try {
    const facelets = state.getFacelets();
    const physicalIssues = validatePhysicalState(facelets);
    if (physicalIssues.length) {
      throw new Error(physicalIssues[0]);
    }
    const solveMoves = await solveFromFacelets(facelets);
    closeCameraOverlay();
    setSolverOpen(true);
    if (solveMoves.length === 0) {
      lastMove = 'scanned (already solved)';
      refreshUI();
      updateSolverUI();
      return;
    }
    // Pretend the cube was scrambled by the inverse of the solve plan, so the
    // existing history-based solver UI produces our Kociemba sequence.
    moveHistory = solveMoves.slice().reverse().map(invertMove);
    refreshUI();
    updateSolverUI();
  } catch (err) {
    console.error(err);
    scanState.step = SCAN_FACES.length - 1;
    setScanError(
      (err.message || 'Could not solve the scanned cube.') +
      ' Tap any color chip that looks wrong, or recapture the current face.'
    );
    refreshScanUI();
  }
}

// Build static UI and scramble on load
setBackgroundTheme('dark');
buildPaintPalette();
refreshPaintUI();
moveHistory = state.scramble(20);
view.build(state);
moveCount = 0;
lastMove = '';
refreshUI();
updateSolverUI();

// ─── Interaction ─────────────────────────────────────────────────────────────

const interaction = new Interaction(canvas, camera, view, orbit, (move) => {
  if (isQuickSolving || isScrambling || isGuidedPreviewing || isCameraTransitioning || guidedPreviewMove) return;
  applyAnimatedMove(move);
});

canvas.addEventListener('pointerdown', handlePaintPointerDown, { capture: true });
canvas.addEventListener('pointerup', handlePaintPointerUp, { capture: true });
canvas.addEventListener('pointercancel', handlePaintPointerUp, { capture: true });

// Also allow left-drag in empty space to orbit
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 0 && !view.isAnimating) {
    // Orbit on left-click miss is handled by enabling orbit in interaction.js
  }
});

// ─── Button wiring ───────────────────────────────────────────────────────────

document.getElementById('btn-scramble').addEventListener('click', doScramble);
document.getElementById('btn-reset').addEventListener('click', doReset);
document.getElementById('btn-undo').addEventListener('click', doUndo);
document.getElementById('btn-scheme').addEventListener('click', cycleColorScheme);
document.getElementById('btn-lab-controls').addEventListener('click', () => setControlsOpen(!controlsOpen));
document.getElementById('btn-controls-close').addEventListener('click', () => setControlsOpen(false));
document.querySelectorAll('.theme-option').forEach(btn => {
  btn.addEventListener('click', () => setTheme(btn.dataset.theme));
});
document.querySelectorAll('.bg-option').forEach(btn => {
  btn.addEventListener('click', () => setBackgroundTheme(btn.dataset.bg));
});
document.getElementById('motion-blur-toggle').addEventListener('click', () => setMotionBlur(!motionBlurEnabled));
document.querySelectorAll('.cube-option').forEach(btn => {
  btn.addEventListener('click', () => setCubeSize(btn.dataset.size));
});
document.getElementById('turn-speed').addEventListener('input', (event) => setTurnSpeed(event.target.value));
document.getElementById('cubie-gap').addEventListener('input', (event) => setCubieGap(event.target.value));
document.getElementById('sticker-glare').addEventListener('input', (event) => setStickerGlare(event.target.value));
document.getElementById('plastic-glare').addEventListener('input', (event) => setPlasticGlare(event.target.value));
document.getElementById('btn-upload-image').addEventListener('click', () => {
  document.getElementById('sticker-image-input').click();
});
document.getElementById('sticker-image-input').addEventListener('change', handleStickerImageSelected);
document.getElementById('btn-clear-image').addEventListener('click', clearStickerImage);
document.getElementById('btn-solver-toggle').addEventListener('click', () => setSolverOpen(!solverOpen));
document.getElementById('btn-solver-close').addEventListener('click', () => setSolverOpen(false));
document.getElementById('btn-quick-solve').addEventListener('click', doQuickSolve);
document.getElementById('btn-guided-solve').addEventListener('click', doGuidedSolve);
document.getElementById('btn-guided-next').addEventListener('click', () => commitGuidedStep(guidedPreviewMove !== null));
document.getElementById('btn-guided-auto').addEventListener('click', toggleGuidedAuto);
document.getElementById('btn-guided-loop').addEventListener('click', toggleGuidedLoop);
document.getElementById('btn-guided-undo').addEventListener('click', undoGuidedStep);
document.getElementById('btn-camera').addEventListener('click', openCameraOverlay);
document.getElementById('btn-camera-close').addEventListener('click', closeCameraOverlay);
document.getElementById('btn-camera-capture').addEventListener('click', handleCaptureFace);
document.getElementById('btn-camera-back').addEventListener('click', handleScanBack);
document.querySelectorAll('.scan-chip[data-face]').forEach(chip => {
  chip.addEventListener('click', () => handleChipClick(chip.dataset.face));
});
document.getElementById('btn-paint').addEventListener('click', beginPaintMode);
document.getElementById('btn-paint-close').addEventListener('click', closePaintMode);
document.getElementById('btn-paint-clear').addEventListener('click', clearPaintMode);
document.getElementById('btn-paint-solve').addEventListener('click', solvePaintedCube);

document.addEventListener('keydown', (event) => {
  if (paintState.active && event.key !== 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.key === 'Escape') {
    closeCameraOverlay();
    if (paintState.active) closePaintMode();
    if (controlsOpen) setControlsOpen(false);
    if (solverOpen) setSolverOpen(false);
  }
  if (event.key === 'Enter' && solverOpen && solverMode === 'guided') {
    event.preventDefault();
    commitGuidedStep(guidedPreviewMove !== null);
  }
}, { capture: true });

window.addEventListener('pagehide', closeCameraOverlay);

// ─── Resize ──────────────────────────────────────────────────────────────────

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (orbit.handleResize) orbit.handleResize();
  }
}

// ─── Render loop ─────────────────────────────────────────────────────────────

renderer.setAnimationLoop(() => {
  resize();
  orbit.update();
  view.updateMoveHint(performance.now());
  renderer.render(scene, camera);
});
