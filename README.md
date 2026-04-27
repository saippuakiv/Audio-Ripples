# Audio Ripple

A real-time interactive audiovisual instrument built with WebGL shaders and the Web Audio API. Pointer input drives a GPU-based fluid simulation that displaces a background texture, while spatially-weighted audio stems crossfade based on cursor position.

## Overview

The application renders a single fullscreen WebGL canvas. Pointer events inject energy into a wave simulation running on the GPU. The resulting height field displaces background-image UVs in a second render pass, producing a water-caustic distortion with specular highlights.

Four categories of audio stems are mixed in real time — each mapped to a screen edge. Moving the pointer toward an edge increases that category's gain.

```
            texture (top)
               |
  melody (left) ——— + ——— accent (right)
               |
            rhythm (bottom)
```

## Architecture

### Rendering pipeline

Two-pass ping-pong framebuffer pipeline via Three.js `WebGLRenderTarget`:

| Pass | Shader | Description |
|------|--------|-------------|
| 1 — Simulation | `waveSimFrag` | Solves the 2D wave equation per-pixel, outputs pressure, velocity, and gradients |
| 2 — Composite | `renderFrag` | Displaces background UVs using wave gradients, applies cover-fit and specular glint |

Shaders are defined in `app/components/shaders.ts`, decoupled from the React component.

### Audio engine

Built on Tone.js:

- 4 stem categories, each with a pool of `.wav` files
- Gain per category computed from pointer distance to the corresponding screen edge
- Stems crossfade to a new random file each loop cycle
- All audio fades out after 8s of inactivity

### UI

- Frosted-glass background panel with Framer Motion layout animations
- Session-only image upload via `URL.createObjectURL` (no server round-trip)
- Per-background `fontColor` for canvas-overlay text

## Project structure

```
app/
  layout.tsx                # Root layout, metadata
  page.tsx                  # Single-route entry — renders <AudioRippleCanvas />
  globals.css               # @font-face, resets
  components/
    AudioRippleCanvas.tsx   # Core component — Three.js, audio, pointer handling, UI
    shaders.ts              # GLSL: fullscreenVert, waveSimFrag, renderFrag
public/
  bg.jpg, bg1–bg5.*         # Built-in background textures
  stems/                    # Audio stems by category
    texture/                #   texture-01 … texture-05.wav
    melody/                 #   melody-01 … melody-04.wav
    accent/                 #   accent-01 … accent-02.wav
    rhythm/                 #   rhythm-01 … rhythm-03.wav
  fonts/                    # Retrogression Regular (.ttf, .otf)
```

## Tech stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 (App Router), React 19 |
| Rendering | Three.js — custom GLSL shaders, ping-pong framebuffers |
| Audio | Tone.js — Player, Gain, ToneAudioBuffer |
| Animation | Framer Motion |
| Styling | Tailwind CSS 4 |
| Language | TypeScript |

## Getting started

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Click anywhere with sound enabled to begin.
