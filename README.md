# Rubixo

Rubixo is a browser-based cube simulator and guided solver for 3×3 and 2×2 cubes. Rotate a virtual cube, enter sticker colors, or scan a physical cube with a camera, then follow a move-by-move solution.

## Features

- Interactive 3D cube with mouse and touch controls.
- 3×3 and 2×2 cube modes, scrambling, and move history.
- Manual sticker painting and camera-assisted color capture.
- Guided solution playback with move descriptions.
- History-based reversal and cubejs-backed solving for supported entered states.

## Run locally

Requires Python 3 for the example server and a modern browser.

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [http://localhost:8000](http://localhost:8000). There is no package installation or build step. Serve the files over HTTP rather than opening `index.html` directly, because the app uses JavaScript modules.

Camera scanning requires permission and a secure browser context: use localhost during development and HTTPS when deployed. Check captured colors before solving; an invalid sticker configuration cannot produce a valid solution.

## Stack and structure

The app uses JavaScript modules, Three.js, and cubejs. External libraries load through the CDN references and import map in `index.html`, so the first load requires internet access.

- `cube/cube.js`: application orchestration and interface behavior.
- `cube/cubeState.js`: cube state and moves.
- `cube/cubeView.js` and `cube/interaction.js`: rendering and controls.
- `cube/manualPaint.js`: manual sticker entry.
- `cube/scanner.js`: camera capture and color detection.
- `cube/solver.js`: solution planning and move descriptions.

## Deployment

Upload the repository as a static site to a host that supports HTTPS. Use the repository root as the publish directory; no build command is required.
