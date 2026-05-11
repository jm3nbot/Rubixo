import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const COLOR_SCHEMES = {
  pastel: {
    label: 'Pastel',
    colors: [0xf8c7ff, 0xff5bbd, 0x7ef9ff, 0xfff08a, 0xc59bff, 0x90f0b6],
  },
  normal: {
    label: 'Normal',
    colors: [0xffffff, 0xd91f35, 0x009b48, 0xffd500, 0xff8c00, 0x0046ad],
  },
  vibrant: {
    label: 'Vibrant',
    colors: [0xffb6d7, 0xff2845, 0x1ec85a, 0xffe833, 0xff8c1a, 0x2a6bff],
  },
};

const STICKER_OFFSET = 0.469;
const STICKER_SIZE = 0.82;
const STICKER_RADIUS = 0.055;
const HINT_COLOR = 0xb8c7dc;
const BLANK_STICKER_COLOR = 0x202938;

// face name → normal direction and up axis for sticker placement
const FACE_DEFS = [
  { face: 'U', normal: new THREE.Vector3(0,  1, 0),  rot: new THREE.Euler(-Math.PI/2, 0, 0) },
  { face: 'D', normal: new THREE.Vector3(0, -1, 0),  rot: new THREE.Euler( Math.PI/2, 0, 0) },
  { face: 'R', normal: new THREE.Vector3( 1, 0, 0),  rot: new THREE.Euler(0,  Math.PI/2, 0) },
  { face: 'L', normal: new THREE.Vector3(-1, 0, 0),  rot: new THREE.Euler(0, -Math.PI/2, 0) },
  { face: 'F', normal: new THREE.Vector3(0, 0,  1),  rot: new THREE.Euler(0, 0, 0) },
  { face: 'B', normal: new THREE.Vector3(0, 0, -1),  rot: new THREE.Euler(0, Math.PI, 0) },
];

function easeInOut(t) {
  return t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
}

function createRoundedStickerGeometry(size, radius) {
  const half = size / 2;
  const r = Math.min(radius, half);
  const shape = new THREE.Shape();
  shape.moveTo(-half + r, -half);
  shape.lineTo(half - r, -half);
  shape.quadraticCurveTo(half, -half, half, -half + r);
  shape.lineTo(half, half - r);
  shape.quadraticCurveTo(half, half, half - r, half);
  shape.lineTo(-half + r, half);
  shape.quadraticCurveTo(-half, half, -half, half - r);
  shape.lineTo(-half, -half + r);
  shape.quadraticCurveTo(-half, -half, -half + r, -half);
  const geometry = new THREE.ShapeGeometry(shape, 4);
  geometry.computeVertexNormals();
  return geometry;
}

function axisVector(axis) {
  if (axis === 'x') return new THREE.Vector3(1, 0, 0);
  if (axis === 'y') return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

function axisBasis(axis) {
  if (axis === 'x') {
    return { u: new THREE.Vector3(0, 1, 0), v: new THREE.Vector3(0, 0, 1) };
  }
  if (axis === 'y') {
    return { u: new THREE.Vector3(0, 0, 1), v: new THREE.Vector3(1, 0, 0) };
  }
  return { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0) };
}

export class CubeView {
  constructor(scene) {
    this.scene = scene;
    this.cubeGroup = new THREE.Group();
    scene.add(this.cubeGroup);
    this.hintGroup = new THREE.Group();
    this.cubeGroup.add(this.hintGroup);
    this.cubies = []; // {mesh, position:[x,y,z], stickerMeshes:{U,R,F,D,L,B}}
    this.isAnimating = false;
    this.colorScheme = 'vibrant';
    this.cubeSize = 3;
    this.cubieSpacing = 1.0;
    this.stickerGlare = 0.24;
    this.bodyGlare = 0.08;
    this._hintMaterials = [];
    this._geo = new RoundedBoxGeometry(0.93, 0.93, 0.93, 2, 0.055);
    this._bodyMat = new THREE.MeshStandardMaterial({
      color: 0x0b0d10,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: this.bodyGlare,
    });
    this._stickerGeo = createRoundedStickerGeometry(STICKER_SIZE, STICKER_RADIUS);
    this._stickerTexture = null;
  }

  build(state) {
    this.cubeSize = state.size === 2 ? 2 : 3;
    this.cubeGroup.scale.setScalar(this.cubeSize === 2 ? 1.42 : 1);
    // Remove existing cubies
    for (const c of this.cubies) this.cubeGroup.remove(c.mesh);
    this.cubies = [];

    const cubieData = state.getCubies();
    for (const { position: [cx, cy, cz], colors } of cubieData) {
      const mesh = new THREE.Mesh(this._geo, this._bodyMat);
      mesh.userData.logicalPosition = [cx, cy, cz];
      const renderStep = this._renderStep();
      mesh.position.set(cx * renderStep, cy * renderStep, cz * renderStep);
      mesh.castShadow = true;
      mesh.receiveShadow = false;

      const stickerMeshes = {};
      for (const { face, normal, rot } of FACE_DEFS) {
        const colorIdx = colors[face];
        if (colorIdx === -1) continue;
        // Only add sticker if this cubie actually has this face exposed
        const nx = Math.round(normal.x), ny = Math.round(normal.y), nz = Math.round(normal.z);
        if ((nx !== 0 && nx !== cx) || (ny !== 0 && ny !== cy) || (nz !== 0 && nz !== cz)) continue;
        const mat = new THREE.MeshStandardMaterial({
          color: this._stickerTexture ? 0xffffff : this._colorFor(colorIdx),
          map: this._stickerTexture,
          roughness: 0.64,
          metalness: 0.0,
          envMapIntensity: this.stickerGlare,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
        });
        const s = new THREE.Mesh(this._stickerGeo, mat);
        s.rotation.copy(rot);
        s.position.copy(normal.clone().multiplyScalar(STICKER_OFFSET));
        s.userData.face = face;
        s.userData.colorIdx = colorIdx;
        s.userData.cubie = mesh;
        mesh.add(s);
        stickerMeshes[face] = s;
      }

      this.cubies.push({ mesh, position: [cx, cy, cz], stickerMeshes });
      this.cubeGroup.add(mesh);
    }
  }

  // Collect all sticker meshes for raycasting
  getStickerMeshes() {
    const all = [];
    for (const c of this.cubies) {
      for (const s of Object.values(c.stickerMeshes)) all.push(s);
    }
    return all;
  }

  showMoveHint(move) {
    this.clearMoveHint();
    const base = move.replace(/['2]/g, '');
    const suffix = move.slice(base.length);
    const def = LAYER_DEF[base];
    if (!def) return;

    const axis = axisVector(def.axis);
    const { u, v } = axisBasis(def.axis);
    const hintScale = this.cubeSize === 2 ? 0.55 : 1;
    const center = axis.clone().multiplyScalar(def.layerCoord * 1.64 * hintScale);
    const radius = 1.55 * hintScale;
    const turnSign = (suffix === "'" ? -1 : 1) * def.dir;
    const sweep = suffix === '2' ? Math.PI : Math.PI * 0.72;
    const start = -Math.PI * 0.62;
    const steps = 42;
    const points = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const angle = start + turnSign * sweep * t;
      points.push(
        center.clone()
          .addScaledVector(u, Math.cos(angle) * radius)
          .addScaledVector(v, Math.sin(angle) * radius)
      );
    }

    const curve = new THREE.CatmullRomCurve3(points);
    const tubeGeo = new THREE.TubeGeometry(curve, 48, 0.026 * hintScale, 10, false);
    const tubeMat = new THREE.MeshBasicMaterial({
      color: HINT_COLOR,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    tube.renderOrder = 30;

    const tangent = points[points.length - 1].clone().sub(points[points.length - 2]).normalize();
    const coneGeo = new THREE.ConeGeometry(0.13 * hintScale, 0.34 * hintScale, 28);
    const coneMat = tubeMat.clone();
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.copy(points[points.length - 1]);
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
    cone.renderOrder = 31;

    this._hintMaterials = [tubeMat, coneMat];
    this.hintGroup.add(tube, cone);
  }

  clearMoveHint() {
    this.hintGroup.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
    this.hintGroup.clear();
    this._hintMaterials = [];
  }

  updateMoveHint(now) {
    if (!this._hintMaterials.length) return;
    const opacity = 0.72 + Math.sin(now * 0.006) * 0.16;
    for (const material of this._hintMaterials) {
      material.opacity = opacity;
    }
  }

  // Animate a face turn. move: e.g. "U", "R'", "F2"
  applyMove(move, animateMs, onComplete) {
    if (this.isAnimating) return;
    this.isAnimating = true;

    const base = move.replace(/['2]/g, '');
    const suffix = move.slice(base.length);
    const { axis, layerCoord, layerAxis, dir } = LAYER_DEF[base];

    // Which cubies are in this layer?
    const inLayer = this.cubies.filter(c => Math.round(c.position[layerAxis]) === layerCoord);

    // Build a temporary group
    const layerGroup = new THREE.Group();
    this.cubeGroup.add(layerGroup);
    for (const c of inLayer) {
      this.cubeGroup.remove(c.mesh);
      layerGroup.add(c.mesh);
    }

    const totalAngle = (suffix === '2' ? Math.PI : Math.PI/2) * (suffix === '\'' ? -1 : 1) * dir;
    const startTime = performance.now();

    const tick = (now) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / animateMs, 1);
      const angle = easeInOut(t) * totalAngle;

      layerGroup.rotation.set(0, 0, 0);
      layerGroup.rotation[axis] = angle;

      if (t < 1) {
        requestAnimationFrame(tick);
        return;
      }

      // Snap to exact final rotation
      layerGroup.rotation[axis] = totalAngle;
      layerGroup.updateMatrixWorld(true);

      // Reparent cubies back, baking the layer rotation into each cubie
      for (const c of inLayer) {
        c.mesh.applyMatrix4(layerGroup.matrix);
        layerGroup.remove(c.mesh);
        this.cubeGroup.add(c.mesh);

        // Snap position
        const renderStep = this._renderStep();
        const lx = Math.round(c.mesh.position.x / renderStep);
        const ly = Math.round(c.mesh.position.y / renderStep);
        const lz = Math.round(c.mesh.position.z / renderStep);
        c.mesh.position.set(
          lx * renderStep,
          ly * renderStep,
          lz * renderStep,
        );
        c.position = [lx, ly, lz];
        c.mesh.userData.logicalPosition = c.position.slice();
      }

      this.cubeGroup.remove(layerGroup);
      this.isAnimating = false;
      if (onComplete) onComplete();
    };

    requestAnimationFrame(tick);
  }

  // Instant sync (no animation) — rebuild all sticker colors from state
  syncFromState(state) {
    this.build(state);
  }

  setColorScheme(scheme) {
    if (!COLOR_SCHEMES[scheme]) return;
    this.colorScheme = scheme;
    for (const c of this.cubies) {
      for (const sticker of Object.values(c.stickerMeshes)) {
        sticker.material.color.setHex(this._stickerTexture ? 0xffffff : this._colorFor(sticker.userData.colorIdx));
      }
    }
  }

  setCubieSpacing(spacing) {
    this.cubieSpacing = THREE.MathUtils.clamp(spacing, 0.94, 1.18);
    const renderStep = this._renderStep();
    for (const c of this.cubies) {
      const [x, y, z] = c.position;
      c.mesh.position.set(
        x * renderStep,
        y * renderStep,
        z * renderStep,
      );
    }
  }

  setStickerGlare(value) {
    this.stickerGlare = THREE.MathUtils.clamp(value, 0, 0.8);
    for (const c of this.cubies) {
      for (const sticker of Object.values(c.stickerMeshes)) {
        sticker.material.envMapIntensity = this.stickerGlare;
        sticker.material.roughness = THREE.MathUtils.lerp(0.82, 0.34, this.stickerGlare / 0.8);
        sticker.material.needsUpdate = true;
      }
    }
  }

  setBodyGlare(value) {
    this.bodyGlare = THREE.MathUtils.clamp(value, 0, 0.45);
    this._bodyMat.envMapIntensity = this.bodyGlare;
    this._bodyMat.roughness = THREE.MathUtils.lerp(0.96, 0.55, this.bodyGlare / 0.45);
    this._bodyMat.needsUpdate = true;
  }

  setStickerTexture(texture) {
    if (this._stickerTexture && this._stickerTexture !== texture) {
      this._stickerTexture.dispose();
    }
    this._stickerTexture = texture;
    if (this._stickerTexture) {
      this._stickerTexture.colorSpace = THREE.SRGBColorSpace;
      this._stickerTexture.wrapS = THREE.ClampToEdgeWrapping;
      this._stickerTexture.wrapT = THREE.ClampToEdgeWrapping;
      this._stickerTexture.anisotropy = 4;
    }
    for (const c of this.cubies) {
      for (const sticker of Object.values(c.stickerMeshes)) {
        sticker.material.map = this._stickerTexture;
        sticker.material.color.setHex(this._stickerTexture ? 0xffffff : this._colorFor(sticker.userData.colorIdx));
        sticker.material.needsUpdate = true;
      }
    }
  }

  clearStickerTexture() {
    this.setStickerTexture(null);
  }

  getColorSchemeLabel() {
    return COLOR_SCHEMES[this.colorScheme].label;
  }

  _colorFor(colorIdx) {
    if (colorIdx < 0) return BLANK_STICKER_COLOR;
    return COLOR_SCHEMES[this.colorScheme].colors[colorIdx];
  }

  _renderStep() {
    return (this.cubeSize === 2 ? 0.5 : 1) * this.cubieSpacing;
  }
}

// dir is the world-space right-hand rotation sign for a standard clockwise face move.
const LAYER_DEF = {
  U: { axis: 'y', layerAxis: 1, layerCoord:  1, dir:  1 },
  D: { axis: 'y', layerAxis: 1, layerCoord: -1, dir: -1 },
  R: { axis: 'x', layerAxis: 0, layerCoord:  1, dir: -1 },
  L: { axis: 'x', layerAxis: 0, layerCoord: -1, dir:  1 },
  F: { axis: 'z', layerAxis: 2, layerCoord:  1, dir: -1 },
  B: { axis: 'z', layerAxis: 2, layerCoord: -1, dir:  1 },
};
