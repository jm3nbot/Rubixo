import * as THREE from 'three';

const DRAG_THRESHOLD = 14; // px — minimum drag to count as a face twist
const LAYER_MOVE_SIGN = { U: +1, D: -1, R: -1, L: +1, F: -1, B: +1 };
const LAYER_NAME = {
  0: { '-1': 'L', '1': 'R' },
  1: { '-1': 'D', '1': 'U' },
  2: { '-1': 'B', '1': 'F' },
};
const FACE_TURN_DEF = {
  U: { axis: new THREE.Vector3(0, 1, 0), dir: 1 },
  D: { axis: new THREE.Vector3(0, 1, 0), dir: -1 },
  R: { axis: new THREE.Vector3(1, 0, 0), dir: -1 },
  L: { axis: new THREE.Vector3(1, 0, 0), dir: 1 },
  F: { axis: new THREE.Vector3(0, 0, 1), dir: -1 },
  B: { axis: new THREE.Vector3(0, 0, 1), dir: 1 },
};

function faceFromNormal(n) {
  if (Math.abs(n.x) > 0.5) return n.x > 0 ? 'R' : 'L';
  if (Math.abs(n.y) > 0.5) return n.y > 0 ? 'U' : 'D';
  return n.z > 0 ? 'F' : 'B';
}

function snapAxisNormal(n) {
  const out = n.clone().normalize();
  const ax = Math.abs(out.x), ay = Math.abs(out.y), az = Math.abs(out.z);
  if (ax >= ay && ax >= az) return out.set(Math.sign(out.x), 0, 0);
  if (ay >= az) return out.set(0, Math.sign(out.y), 0);
  return out.set(0, 0, Math.sign(out.z));
}

// In R-mode, only the clicked face is allowed to turn. We compare the
// projected motion of that face in both directions and choose the one that
// best follows the user's screen-space drag.
function resolveFaceMove(faceName, cubeCenter, startPoint, dragScreen, camera) {
  if (dragScreen.lengthSq() === 0) return null;
  const def = FACE_TURN_DEF[faceName];
  if (!def) return null;

  const ndcStart = startPoint.clone().project(camera);
  let bestScore = -Infinity;
  let bestMove = null;

  for (const suffix of ['', "'"]) {
    const suffixSign = suffix === "'" ? -1 : 1;
    const angle = (Math.PI / 2) * suffixSign * def.dir;
    const moved = startPoint.clone().sub(cubeCenter).applyAxisAngle(def.axis, angle).add(cubeCenter);
    const ndcEnd = moved.project(camera);
    // NDC x maps to +screen-x, NDC y maps to -screen-y.
    const sdx = ndcEnd.x - ndcStart.x;
    const sdy = -(ndcEnd.y - ndcStart.y);
    const len2 = sdx * sdx + sdy * sdy;
    if (len2 < 1e-12) continue;
    const score = (sdx * dragScreen.x + sdy * dragScreen.y) / Math.sqrt(len2);
    if (score > bestScore) {
      bestScore = score;
      bestMove = faceName + suffix;
    }
  }

  return bestMove;
}

function resolveLayerMove(faceNormal, cubiePos, dragWorld) {
  const faceAxis =
    Math.abs(faceNormal.x) > 0.5 ? 0 :
    Math.abs(faceNormal.y) > 0.5 ? 1 : 2;
  const inPlane = [0, 1, 2].filter(axis => axis !== faceAxis);
  const drag = [dragWorld.x, dragWorld.y, dragWorld.z];

  const dragAxis = Math.abs(drag[inPlane[0]]) >= Math.abs(drag[inPlane[1]])
    ? inPlane[0]
    : inPlane[1];
  const rotAxis = inPlane[0] === dragAxis ? inPlane[1] : inPlane[0];
  const cubieCoord = [cubiePos.x, cubiePos.y, cubiePos.z][rotAxis];
  if (cubieCoord === 0) return null;

  const layerName = LAYER_NAME[rotAxis][cubieCoord.toString()];
  const cross = new THREE.Vector3().crossVectors(faceNormal, dragWorld);
  const rotSign = Math.sign([cross.x, cross.y, cross.z][rotAxis]);
  if (rotSign === 0) return null;

  const moveSign = rotSign * LAYER_MOVE_SIGN[layerName];
  return moveSign > 0 ? layerName : layerName + "'";
}

export class Interaction {
  constructor(canvas, camera, cubeView, orbitControls, onMove) {
    this.canvas = canvas;
    this.camera = camera;
    this.cubeView = cubeView;
    this.orbitControls = orbitControls;
    this.onMove = onMove;

    this._raycaster = new THREE.Raycaster();
    this._state = 'idle'; // idle | tracking | orbit
    this._pointerStart = null;
    this._lastPointer = null;
    this._startPoint = null;
    this._faceCenter = null;
    this._faceName = null;
    this._hitNormal = null;
    this._hitCubiePos = null;
    this._cubeCenter = null;
    this._turnMode = 'layer';
    this._rHeld = false;
    this.enabled = true;

    // Capture-phase pointerdown so we can decide whether to route the gesture
    // to OrbitControls (bubble-phase listener) or to face-twist.
    canvas.addEventListener('pointerdown', this._onDown.bind(this), { capture: true });
    canvas.addEventListener('pointermove', this._onMove.bind(this));
    canvas.addEventListener('pointerup',   this._onUp.bind(this));
    canvas.addEventListener('pointercancel', this._onUp.bind(this));
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'r') this._rHeld = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.key.toLowerCase() === 'r') this._rHeld = false;
    });
    window.addEventListener('blur', () => {
      this._rHeld = false;
    });
    canvas.style.touchAction = 'none';
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this._state = 'idle';
      this._rHeld = false;
      this.orbitControls.enabled = true;
    }
  }

  _ndc(e) {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  _onDown(e) {
    if (!this.enabled) return;
    if (this.cubeView.isAnimating) return;
    if (e.button !== 0) return; // only left button starts a face-twist gesture

    const ndc = this._ndc(e);
    this._raycaster.setFromCamera(ndc, this.camera);
    const stickers = this.cubeView.getStickerMeshes();
    const hits = this._raycaster.intersectObjects(stickers, false);

    if (hits.length === 0) {
      // Empty space — let OrbitControls handle the drag
      this._state = 'orbit';
      return;
    }

    const hit = hits[0];
    const stickerMesh = hit.object;
    const cubieMesh = stickerMesh.parent;

    const n = snapAxisNormal(new THREE.Vector3(0, 0, 1)
      .applyQuaternion(stickerMesh.getWorldQuaternion(new THREE.Quaternion()))
      .normalize());

    this._hitNormal = n;
    this._faceName = faceFromNormal(n);
    this._turnMode = this._rHeld ? 'face' : 'layer';
    const logicalPosition = cubieMesh.userData.logicalPosition || [
      Math.sign(cubieMesh.position.x),
      Math.sign(cubieMesh.position.y),
      Math.sign(cubieMesh.position.z),
    ];
    this._hitCubiePos = {
      x: logicalPosition[0],
      y: logicalPosition[1],
      z: logicalPosition[2],
    };
    this._startPoint = hit.point.clone();
    this._cubeCenter = this.cubeView.cubeGroup.getWorldPosition(new THREE.Vector3());
    this._faceCenter = this._cubeCenter.clone().addScaledVector(
      n,
      hit.point.clone().sub(this._cubeCenter).dot(n)
    );

    this._pointerStart = { x: e.clientX, y: e.clientY };
    this._lastPointer = { x: e.clientX, y: e.clientY };
    this._state = 'tracking';
    this.orbitControls.enabled = false;
    // Stop OrbitControls from also seeing this pointerdown
    e.stopPropagation();
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
  }

  _onMove(e) {
    if (!this.enabled) return;
    if (this._state !== 'tracking') return;
    this._lastPointer = { x: e.clientX, y: e.clientY };
  }

  _onUp(e) {
    if (!this.enabled) return;
    if (this._state !== 'tracking') {
      this._state = 'idle';
      return;
    }

    this._state = 'idle';
    this.orbitControls.enabled = true;

    const dx = this._lastPointer.x - this._pointerStart.x;
    const dy = this._lastPointer.y - this._pointerStart.y;
    const dist = Math.hypot(dx, dy);

    if (dist < DRAG_THRESHOLD) return;

    const dragScreen = new THREE.Vector2(
      this._lastPointer.x - this._pointerStart.x,
      this._lastPointer.y - this._pointerStart.y,
    );
    const useFaceTurn = this._turnMode === 'face' || this._rHeld;
    let move = null;
    if (useFaceTurn) {
      move = resolveFaceMove(this._faceName, this._cubeCenter, this._startPoint, dragScreen, this.camera);
    } else {
      const endPoint = this._pointOnFacePlane(e);
      if (!endPoint) return;
      const worldDrag = endPoint.clone().sub(this._startPoint);
      move = resolveLayerMove(this._hitNormal, this._hitCubiePos, worldDrag);
    }
    if (move && !this.cubeView.isAnimating) {
      this.onMove(move);
    }
  }

  _pointOnFacePlane(e) {
    const ndc = this._ndc(e);
    this._raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this._hitNormal, this._faceCenter);
    return this._raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }
}
