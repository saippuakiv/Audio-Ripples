'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { useOnClickOutside } from 'usehooks-ts';
import * as Tone from 'tone';
import * as THREE from 'three';
import { motion, AnimatePresence } from 'framer-motion';
import NextImage from 'next/image';
import { fullscreenVert, waveSimFrag, renderFrag } from './shaders';

interface Anchor {
  name: string;
  label: string;
  files: string[];
  getPosition: (w: number, h: number) => { x: number; y: number };
}

const ANCHORS: Anchor[] = [
  {
    name: 'texture',
    label: 'texture',
    files: [
      'texture-01.wav',
      'texture-02.wav',
      'texture-03.wav',
      'texture-04.wav',
      'texture-05.wav',
    ],
    getPosition: (w) => ({ x: w / 2, y: 0 }),
  },
  {
    name: 'melody',
    label: 'melody',
    files: ['melody-01.wav', 'melody-02.wav', 'melody-03.wav', 'melody-04.wav'],
    getPosition: (_w, h) => ({ x: 0, y: h / 2 }),
  },
  {
    name: 'accent',
    label: 'accent',
    files: ['accent-01.wav', 'accent-02.wav'],
    getPosition: (w, h) => ({ x: w, y: h / 2 }),
  },
  {
    name: 'rhythm',
    label: 'rhythm',
    files: ['rhythm-01.wav', 'rhythm-02.wav', 'rhythm-03.wav'],
    getPosition: (w, h) => ({ x: w / 2, y: h }),
  },
];

const FADE_DURATION = 8;
const CROSSFADE_DURATION = 0.3;
const BLEND_OLD = 0.6;
const BLEND_NEW = 0.4;

interface CategoryState {
  currentIndex: number; // which file is currently playing (-1 = none)
  player: Tone.Player | null; // active player
  gain: Tone.Gain; // persistent gain node
}

const BACKGROUNDS = [
  { src: '/bg.jpg', label: 'Default', fontColor: 'rgba(255, 253, 245, 0.88)' },
  { src: '/bg1.jpg', label: 'bg1', fontColor: '#2a5c58' },
  { src: '/bg2.jpg', label: 'bg2', fontColor: '#ff00ed' },
  { src: '/bg3.jpg', label: 'bg3', fontColor: '#5e13b3' },
  { src: '/bg4.png', label: 'bg4', fontColor: '#f20808' },
  { src: '/bg5.jpg', label: 'bg5', fontColor: '#083eff' },
];

export default function AudioRippleCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);

  // Three.js refs
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const renderMaterialRef = useRef<THREE.ShaderMaterial | null>(null);
  const animFrameRef = useRef<number>(0);
  const readPingRef = useRef(true);

  // Drag state
  const isDraggingRef = useRef(false);
  const dropPendingRef = useRef(false);
  const mouseRef = useRef<{ x: number; y: number }>({ x: -1, y: -1 });
  const prevMouseRef = useRef<{ x: number; y: number }>({ x: -1, y: -1 });

  // Audio refs
  const categoriesRef = useRef<CategoryState[]>([]);
  const buffersRef = useRef<Map<string, Tone.ToneAudioBuffer>>(new Map());
  const weightsRef = useRef<number[]>([0.25, 0.25, 0.25, 0.25]);
  const audioStartedRef = useRef(false);
  const lastClickTimeRef = useRef<number>(0);
  const fadingOutRef = useRef(false);

  const [hasClicked, setHasClicked] = useState(false);
  const [mixPercents, setMixPercents] = useState<number[]>([0, 0, 0, 0]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedBg, setSelectedBg] = useState(0);
  const [uploadedBgs, setUploadedBgs] = useState<
    { src: string; label: string; fontColor: string }[]
  >([]);

  const panelRef = useRef<HTMLDivElement>(null!);
  useOnClickOutside(panelRef, () => setPanelOpen(false));

  const allBgs = [...BACKGROUNDS, ...uploadedBgs];

  const changeBackground = useCallback(
    (index: number) => {
      const mat = renderMaterialRef.current;
      if (!mat) return;
      setSelectedBg(index);
      const bgs = [...BACKGROUNDS, ...uploadedBgs];
      const loader = new THREE.TextureLoader();
      loader.load(bgs[index].src, (texture) => {
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        mat.uniforms.backgroundImage.value = texture;
        mat.uniforms.bgImageSize.value.set(
          texture.image.width,
          texture.image.height,
        );
      });
    },
    [uploadedBgs],
  );

  const handleUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      const url = URL.createObjectURL(file);
      setUploadedBgs((prev) => [
        ...prev,
        { src: url, label: file.name, fontColor: 'rgba(255,255,255,0.75)' },
      ]);
    });
    e.target.value = '';
  }, []);

  // Initialize audio context and preload all buffers
  const initAudio = useCallback(async () => {
    if (audioStartedRef.current) return;
    await Tone.start();
    Tone.getTransport().bpm.value = 115;
    Tone.getTransport().start();
    audioStartedRef.current = true;

    const cats: CategoryState[] = ANCHORS.map(() => ({
      currentIndex: -1,
      player: null,
      gain: new Tone.Gain(0).toDestination(),
    }));
    categoriesRef.current = cats;

    // Preload all audio files
    const loadPromises: Promise<void>[] = [];
    ANCHORS.forEach((anchor) => {
      anchor.files.forEach((file) => {
        const url = `/stems/${anchor.name}/${file}`;
        loadPromises.push(
          new Promise<void>((resolve) => {
            const buf = new Tone.ToneAudioBuffer(url, () => {
              buffersRef.current.set(url, buf);
              resolve();
            });
          }),
        );
      });
    });
    await Promise.all(loadPromises);
  }, []);

  // Find nearest anchor index for a click position
  const getNearestAnchor = useCallback(
    (clickX: number, clickY: number, viewW: number, viewH: number) => {
      let minDist = Infinity;
      let nearest = 0;
      ANCHORS.forEach((anchor, i) => {
        const pos = anchor.getPosition(viewW, viewH);
        const dist = Math.sqrt((clickX - pos.x) ** 2 + (clickY - pos.y) ** 2);
        if (dist < minDist) {
          minDist = dist;
          nearest = i;
        }
      });
      return nearest;
    },
    [],
  );

  // Calculate distance-based weights and apply gains
  const updateWeights = useCallback(
    (clickX: number, clickY: number, viewW: number, viewH: number) => {
      const maxDist = Math.sqrt(viewW * viewW + viewH * viewH);
      const distances = ANCHORS.map((anchor) => {
        const pos = anchor.getPosition(viewW, viewH);
        return Math.sqrt((clickX - pos.x) ** 2 + (clickY - pos.y) ** 2);
      });

      const inverseDistances = distances.map((d) => 1 / (d / maxDist + 0.01));
      const sum = inverseDistances.reduce((a, b) => a + b, 0);
      const newWeights = inverseDistances.map((d) => d / sum);

      const blended = weightsRef.current.map(
        (old, i) => BLEND_OLD * old + BLEND_NEW * newWeights[i],
      );
      const blendedSum = blended.reduce((a, b) => a + b, 0);
      const normalized = blended.map((w) => w / blendedSum);

      weightsRef.current = normalized;
      fadingOutRef.current = false;
      lastClickTimeRef.current = performance.now() / 1000;

      // Apply weights as gains only for active categories
      categoriesRef.current.forEach((cat, i) => {
        if (cat.player) {
          cat.gain.gain.rampTo(normalized[i], 0.3);
        }
      });

      // Show percentages only for active categories
      setMixPercents(
        normalized.map((w, i) =>
          categoriesRef.current[i]?.player ? Math.round(w * 100) : 0,
        ),
      );
    },
    [],
  );

  // Trigger or cycle a category's loop
  const triggerCategory = useCallback((catIndex: number) => {
    const cat = categoriesRef.current[catIndex];
    const anchor = ANCHORS[catIndex];
    if (!cat) return;

    fadingOutRef.current = false;
    lastClickTimeRef.current = performance.now() / 1000;

    const nextIndex = (cat.currentIndex + 1) % anchor.files.length;
    const url = `/stems/${anchor.name}/${anchor.files[nextIndex]}`;

    const oldPlayer = cat.player;
    const transport = Tone.getTransport();
    const buffer = buffersRef.current.get(url);

    // Create new player from preloaded buffer — ready immediately
    const targetGain = weightsRef.current[catIndex];
    const newPlayer = new Tone.Player(buffer);
    newPlayer.loop = true;
    newPlayer.connect(cat.gain);

    const nextBar = transport.nextSubdivision('1m');

    // Schedule crossfade at the bar boundary
    transport.scheduleOnce((time) => {
      // Fade out old player: disconnect from cat.gain, route through its own fading gain
      if (oldPlayer) {
        const currentGain = cat.gain.gain.value;
        const oldGain = new Tone.Gain(currentGain).toDestination();
        oldPlayer.disconnect();
        oldPlayer.connect(oldGain);
        oldGain.gain.rampTo(0, CROSSFADE_DURATION, time);
        oldPlayer.stop(time + CROSSFADE_DURATION + 0.05);
        setTimeout(
          () => {
            oldPlayer.dispose();
            oldGain.dispose();
          },
          (CROSSFADE_DURATION + 0.1) * 1000,
        );
      }

      // Start new player
      cat.gain.gain.rampTo(targetGain, CROSSFADE_DURATION, time);
      newPlayer.start(time);
    }, nextBar);

    cat.player = newPlayer;
    cat.currentIndex = nextIndex;

    // Update mix percentages for active categories
    setMixPercents(
      weightsRef.current.map((w, i) => {
        const isActive = i === catIndex || categoriesRef.current[i]?.player;
        return isActive ? Math.round(w * 100) : 0;
      }),
    );
  }, []);

  // Audio fade logic — fade all playing categories after inactivity
  const updateFade = useCallback(() => {
    if (!audioStartedRef.current) return;
    const now = performance.now() / 1000;
    const elapsed = now - lastClickTimeRef.current;

    if (lastClickTimeRef.current === 0) return;

    if (elapsed > FADE_DURATION) {
      if (!fadingOutRef.current) {
        fadingOutRef.current = true;
        categoriesRef.current.forEach((cat) => {
          cat.gain.gain.rampTo(0, 0.5);
        });
      }
      return;
    }

    const fadeProgress = Math.max(0, 1 - elapsed / FADE_DURATION);
    categoriesRef.current.forEach((cat, i) => {
      if (cat.player) {
        cat.gain.gain.rampTo(weightsRef.current[i] * fadeProgress, 0.1);
      }
    });
  }, []);

  // Three.js setup and render loop
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const w = window.innerWidth;
    const h = window.innerHeight;

    // --- Renderer: fills entire viewport ---
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(1);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.cursor = 'pointer';
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // --- Orthographic camera: maps NDC directly ---
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // --- Two separate scenes: one for sim, one for render ---
    const simScene = new THREE.Scene();
    const simQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    simScene.add(simQuad);

    const renderScene = new THREE.Scene();
    const renderQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    renderScene.add(renderQuad);

    // --- Ping-pong render targets ---
    const rtOpts: THREE.RenderTargetOptions = {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.FloatType,
    };
    const pingTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);
    const pongTarget = new THREE.WebGLRenderTarget(w, h, rtOpts);

    // Clear both buffers
    renderer.setRenderTarget(pingTarget);
    renderer.clear();
    renderer.setRenderTarget(pongTarget);
    renderer.clear();
    renderer.setRenderTarget(null);

    // --- Wave simulation material (Pass 1) ---
    const simMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: waveSimFrag,
      uniforms: {
        heightMap: { value: null },
        resolution: { value: new THREE.Vector2(w, h) },
        clickPos: { value: new THREE.Vector2(-1, -1) },
        prevPos: { value: new THREE.Vector2(-1, -1) },
        addDrop: { value: 0.0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    simQuad.material = simMaterial;

    // --- Render material (Pass 2) ---
    const renderMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVert,
      fragmentShader: renderFrag,
      uniforms: {
        heightMap: { value: null },
        backgroundImage: { value: null },
        bgImageSize: { value: new THREE.Vector2(1, 1) },
        resolution: { value: new THREE.Vector2(w, h) },
      },
      depthTest: false,
      depthWrite: false,
    });
    renderQuad.material = renderMaterial;
    renderMaterialRef.current = renderMaterial;

    // --- Load background as Three.js texture ---
    let bgLoaded = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      '/bg.jpg',
      (texture) => {
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        renderMaterial.uniforms.backgroundImage.value = texture;
        renderMaterial.uniforms.bgImageSize.value.set(
          texture.image.width,
          texture.image.height,
        );
        bgLoaded = true;
      },
      undefined,
      (err) => console.error('bg load failed:', err),
    );

    // --- Animation loop ---
    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);

      const readTarget = readPingRef.current ? pingTarget : pongTarget;
      const writeTarget = readPingRef.current ? pongTarget : pingTarget;

      // Pass drag/click state to shader
      if (isDraggingRef.current || dropPendingRef.current) {
        simMaterial.uniforms.clickPos.value.set(
          mouseRef.current.x,
          mouseRef.current.y,
        );
        simMaterial.uniforms.prevPos.value.set(
          prevMouseRef.current.x,
          prevMouseRef.current.y,
        );
        simMaterial.uniforms.addDrop.value = 1.0;
        // Sync prev to current so a stationary mouse doesn't re-draw the last segment
        prevMouseRef.current = { ...mouseRef.current };
        dropPendingRef.current = false;
      } else {
        simMaterial.uniforms.addDrop.value = 0.0;
      }

      // PASS 1 — Wave simulation: read from readTarget, write into writeTarget
      simMaterial.uniforms.heightMap.value = readTarget.texture;
      renderer.setRenderTarget(writeTarget);
      renderer.render(simScene, camera);

      // Swap: writeTarget becomes readTarget next frame
      readPingRef.current = !readPingRef.current;

      // PASS 2 — Render to screen
      if (bgLoaded) {
        renderMaterial.uniforms.heightMap.value = writeTarget.texture;
        renderer.setRenderTarget(null);
        renderer.render(renderScene, camera);
      }

      updateFade();
    };

    animFrameRef.current = requestAnimationFrame(animate);

    // --- Resize ---
    const onResize = () => {
      const nw = window.innerWidth;
      const nh = window.innerHeight;
      renderer.setSize(nw, nh);
      pingTarget.setSize(nw, nh);
      pongTarget.setSize(nw, nh);
      simMaterial.uniforms.resolution.value.set(nw, nh);
      renderMaterial.uniforms.resolution.value.set(nw, nh);
    };
    window.addEventListener('resize', onResize);

    // Resume audio context when returning from another app/tab
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && audioStartedRef.current) {
        Tone.getContext().resume();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', handleVisibility);
      cancelAnimationFrame(animFrameRef.current);
      renderer.dispose();
      pingTarget.dispose();
      pongTarget.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [updateFade]);

  // Helper: get normalized UV from pointer event
  const getUV = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current!;
    const rect = container.getBoundingClientRect();
    const pixelX = e.clientX - rect.left;
    const pixelY = e.clientY - rect.top;
    return {
      uvX: pixelX / rect.width,
      uvY: 1.0 - pixelY / rect.height,
      pixelX,
      pixelY,
      viewW: rect.width,
      viewH: rect.height,
    };
  }, []);

  useEffect(() => {
    BACKGROUNDS.forEach((bg) => {
      const img = new Image();
      img.src = bg.src;
      img.decode().catch(() => {});
    });
  }, []);

  const handlePointerDown = useCallback(
    async (e: React.PointerEvent<HTMLDivElement>) => {
      const { uvX, uvY, pixelX, pixelY, viewW, viewH } = getUV(e);
      const pos = { x: uvX, y: uvY };
      mouseRef.current = pos;
      prevMouseRef.current = pos; // prevent line from stale position
      isDraggingRef.current = true;
      dropPendingRef.current = true;

      if (!audioStartedRef.current) {
        await initAudio();
      }
      setHasClicked(true);

      updateWeights(pixelX, pixelY, viewW, viewH);
      const nearest = getNearestAnchor(pixelX, pixelY, viewW, viewH);
      triggerCategory(nearest);
    },
    [initAudio, getUV, updateWeights, getNearestAnchor, triggerCategory],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDraggingRef.current) return;

      const { uvX, uvY, pixelX, pixelY, viewW, viewH } = getUV(e);
      prevMouseRef.current = { ...mouseRef.current };
      mouseRef.current = { x: uvX, y: uvY };

      updateWeights(pixelX, pixelY, viewW, viewH);
    },
    [getUV, updateWeights],
  );

  const handlePointerUp = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  const handlePointerLeave = useCallback(() => {
    isDraggingRef.current = false;
  }, []);

  return (
    <div
      ref={containerRef}
      className='relative w-screen h-screen overflow-hidden touch-none'
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    >
      {/* Three.js canvas is appended here by the effect — it IS the background */}

      {/* Stem labels — fade out after first click */}
      <div
        className='absolute top-4 left-1/2 -translate-x-1/2 pointer-events-none select-none z-10'
        style={{
          color: allBgs[selectedBg].fontColor,
          fontSize: '20px',
          letterSpacing: '0.12em',
          fontFamily: 'Retrogression, serif',
          opacity: hasClicked ? 0 : 1,
          transition: `color 0.5s ease${hasClicked ? ', opacity 2s ease 1s' : ''}`,
        }}
      >
        texture
      </div>
      <div
        className='absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none select-none z-10'
        style={{
          color: allBgs[selectedBg].fontColor,
          fontSize: '20px',
          letterSpacing: '0.12em',
          fontFamily: 'Retrogression, serif',
          opacity: hasClicked ? 0 : 1,
          transition: `color 0.5s ease${hasClicked ? ', opacity 2s ease 1s' : ''}`,
        }}
      >
        melody
      </div>
      <div
        className='absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none select-none z-10'
        style={{
          color: allBgs[selectedBg].fontColor,
          fontSize: '20px',
          letterSpacing: '0.12em',
          fontFamily: 'Retrogression, serif',
          opacity: hasClicked ? 0 : 1,
          transition: `color 0.5s ease${hasClicked ? ', opacity 2s ease 1s' : ''}`,
        }}
      >
        accent
      </div>
      <div
        className='absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none select-none z-10'
        style={{
          color: allBgs[selectedBg].fontColor,
          fontSize: '20px',
          letterSpacing: '0.12em',
          fontFamily: 'Retrogression, serif',
          opacity: hasClicked ? 0 : 1,
          transition: `color 0.5s ease${hasClicked ? ', opacity 2s ease 1s' : ''}`,
        }}
      >
        rhythm
      </div>

      {/* Click hint */}
      <div
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none select-none z-10 transition-opacity duration-1000 ${
          hasClicked ? 'opacity-0' : 'opacity-100'
        }`}
        style={{
          color: allBgs[selectedBg].fontColor,
          fontSize: '40px',
          fontWeight: 'medium',
          letterSpacing: '0.12em',
          fontFamily: 'Retrogression, serif',
          transition: 'color 0.5s ease',
        }}
      >
        With sound on Click anywhere
      </div>

      {/* Mix HUD */}
      <div
        className={`absolute bottom-10 left-1/2 -translate-x-1/2 pointer-events-none select-none z-10 transition-opacity duration-1000 ${
          hasClicked ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          color: allBgs[selectedBg].fontColor,
          fontSize: '20px',
          fontWeight: 'medium',
          letterSpacing: '0.12em',
          fontFamily: 'Retrogression, serif',
          transition: 'color 0.5s ease',
        }}
      >
        <div className='flex gap-6'>
          {ANCHORS.map((anchor, i) => (
            <span key={anchor.name}>
              {anchor.label} {mixPercents[i]}%
            </span>
          ))}
        </div>
      </div>

      {/* Background Panel */}
      <div
        className='absolute top-6 right-6 z-20'
        style={{ pointerEvents: 'none' }}
      >
        {/* Collapsed panel */}
        <motion.div
          layoutId='panel-wrapper'
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          style={{
            pointerEvents: 'auto',
            background: 'rgba(255, 255, 255, 0.12)',
            backdropFilter: 'blur(40px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(40px) saturate(1.4)',
            borderRadius: 16,
            padding: '12px 16px',
            color: 'white',
            cursor: 'pointer',
            border: '1px solid rgba(255, 255, 255, 0.25)',
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.15), 0 8px 32px rgba(0,0,0,0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
          }}
        >
          <motion.span
            layoutId='panel-title'
            style={{
              fontSize: '14px',
              fontWeight: 600,
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap',
            }}
          >
            Background Setting
          </motion.span>
          <motion.button
            layoutId='panel-btn'
            onClick={() => setPanelOpen(true)}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              border: '1.5px solid rgba(255,255,255,0.5)',
              background: 'rgba(255,255,255,0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '16px',
              flexShrink: 0,
            }}
          >
            <motion.span layoutId='panel-btn-spn'> &#x25A1;</motion.span>
          </motion.button>
        </motion.div>

        {/* Expanded panel */}
        <AnimatePresence>
          {panelOpen && (
            <motion.div
              ref={panelRef}
              layoutId='panel-wrapper'
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              style={{
                pointerEvents: 'auto',
                position: 'absolute',
                top: 0,
                right: 0,
                background: 'rgba(255, 255, 255, 0.12)',
                backdropFilter: 'blur(40px) saturate(1.4)',
                WebkitBackdropFilter: 'blur(40px) saturate(1.4)',
                borderRadius: 20,
                padding: '20px 24px 24px',
                width: '320px',
                color: 'white',
                overflow: 'hidden',
                border: '1px solid rgba(255, 255, 255, 0.25)',
                boxShadow:
                  'inset 0 1px 0 rgba(255,255,255,0.15), 0 8px 32px rgba(0,0,0,0.25)',
              }}
            >
              {/* Header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '16px',
                }}
              >
                <motion.span
                  layoutId='panel-title'
                  style={{
                    fontSize: '18px',
                    fontWeight: 600,
                    letterSpacing: '0.02em',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Background Setting
                </motion.span>
                <motion.button
                  layoutId='panel-btn'
                  onClick={() => setPanelOpen(false)}
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '8px',
                    border: '1.5px solid rgba(255,255,255,0.5)',
                    background: 'rgba(255,255,255,0.1)',
                    color: 'white',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '16px',
                    flexShrink: 0,
                  }}
                >
                  <motion.span layoutId='panel-btn-spn'>&#x2212;</motion.span>
                </motion.button>
              </div>

              {/* Content — fades in after morph */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2, duration: 0.2 }}
              >
                <div style={{ marginTop: '16px' }}>
                  <div
                    style={{
                      height: '1px',
                      background: 'rgba(255,255,255,0.2)',
                      marginBottom: '16px',
                    }}
                  />
                  <div
                    style={{
                      fontSize: '15px',
                      fontWeight: 500,
                      marginBottom: '12px',
                      letterSpacing: '0.02em',
                    }}
                  >
                    Images
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: '10px',
                    }}
                  >
                    {allBgs.map((bg, i) => {
                      const isUploaded = i >= BACKGROUNDS.length;
                      const isSelected = selectedBg === i;
                      return (
                        <div
                          key={bg.src}
                          className='group'
                          style={{ position: 'relative' }}
                        >
                          <button
                            onClick={() => changeBackground(i)}
                            style={{
                              width: '100%',
                              aspectRatio: '1',
                              borderRadius: '12px',
                              overflow: 'hidden',
                              border: isSelected
                                ? '2.5px solid white'
                                : '2.5px solid transparent',
                              cursor: 'pointer',
                              padding: 0,
                              background: 'rgba(255,255,255,0.1)',
                              transition: 'border-color 0.2s ease',
                            }}
                          >
                            {isUploaded ? (
                              /* eslint-disable-next-line @next/next/no-img-element */
                              <img
                                src={bg.src}
                                alt={bg.label}
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'cover',
                                  display: 'block',
                                }}
                              />
                            ) : (
                              <NextImage
                                src={bg.src}
                                alt={bg.label}
                                width={160}
                                height={160}
                                sizes='80px'
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'cover',
                                  display: 'block',
                                }}
                              />
                            )}
                          </button>
                          {isUploaded && !isSelected && (
                            <button
                              className='opacity-0 group-hover:opacity-100'
                              onClick={(e) => {
                                e.stopPropagation();
                                const uploadIndex = i - BACKGROUNDS.length;
                                URL.revokeObjectURL(bg.src);
                                setUploadedBgs((prev) =>
                                  prev.filter((_, j) => j !== uploadIndex),
                                );
                                if (selectedBg > i) {
                                  setSelectedBg((prev) => prev - 1);
                                }
                              }}
                              style={{
                                position: 'absolute',
                                top: '4px',
                                right: '4px',
                                width: '20px',
                                height: '20px',
                                borderRadius: '50%',
                                border: 'none',
                                background: 'rgba(0,0,0,0.55)',
                                color: 'white',
                                fontSize: '12px',
                                lineHeight: '20px',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'opacity 0.15s ease',
                              }}
                            >
                              &#x2715;
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Upload area */}
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      marginTop: '12px',
                      padding: '10px',
                      borderRadius: '12px',
                      border: '1.5px dashed rgba(255,255,255,0.35)',
                      background: 'rgba(255,255,255,0.06)',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: 'rgba(255,255,255,0.6)',
                      transition:
                        'border-color 0.2s ease, background 0.2s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor =
                        'rgba(255,255,255,0.6)';
                      e.currentTarget.style.background =
                        'rgba(255,255,255,0.1)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor =
                        'rgba(255,255,255,0.35)';
                      e.currentTarget.style.background =
                        'rgba(255,255,255,0.06)';
                    }}
                  >
                    <span style={{ fontSize: '16px' }}>+</span>
                    Upload an image
                    <input
                      type='file'
                      accept='image/*'
                      multiple
                      onChange={handleUpload}
                      style={{ display: 'none' }}
                    />
                  </label>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
