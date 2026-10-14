import {
  BackSide, CanvasTexture, Color, DirectionalLight, DoubleSide, Euler, ExtrudeGeometry, Float32BufferAttribute, Group, HemisphereLight,
  Mesh, MeshBasicMaterial, MeshPhysicalMaterial, NeutralToneMapping, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, Shape,
  ShapeGeometry, SphereGeometry, SRGBColorSpace, Vector2, Vector3, WebGLRenderer, type BufferGeometry, type Material,
} from 'three';

/**
 * The two-card hero rendered live, so touching it tilts the cards and the studio lights slide across their faces.
 * src/assets/aqua-cards.webp is a still of this same scene (1800×1200 frame cropped to the cards), so the first live
 * frame matches the image it replaces. Re-render that still whenever the scene changes.
 */

const FRAME = { width: 1800, height: 1200 };
/** Where the still image is cropped from the frame. */
const CROP = { x: 282, y: 198, width: 1237, height: 812 };
/** Extra frame drawn around the crop so tilted corners are never cut off. CardHero.css places the canvas to match. */
const BLEED = 40;
const FONT = "'Pretendard Variable', Pretendard, Arial, sans-serif";

type Plan = 'standard' | 'premium' | 'private';
/** Height, roughness and metalness of one part of the face, each 0–1. */
type Finish = [height: number, roughness: number, metalness: number];
interface Look {
  label: string; bg: [string, string, string]; contour: string; mark: string; text: string; holder: string; edge: string;
  /** The plain face, the wordmark, the small type and the chip. */
  face: Finish; logo: Finish; type: Finish; chip: Finish;
  /** Brushed metal stretches highlights along the grain (0 = none). */
  brushed: number; coat: number; edgeMetal: number;
}
const CHIP: Finish = [0.9, 0.24, 1];
const LOOKS: Record<Plan, Look> = {
  // PVC under a gloss laminate: silver-foil wordmark, matte printed type.
  standard: { label: 'STANDARD', bg: ['#26405c', '#1a2e46', '#122036'], contour: 'rgba(216,228,243,.10)', mark: '#c9d6e4', text: '#9fadc0', holder: '#93a4b9', edge: '#16263b',
    face: [0, 0.4, 0.15], logo: [1, 0.16, 1], type: [0.45, 0.5, 0.1], chip: CHIP, brushed: 0, coat: 0.75, edgeMetal: 0.55 },
  // Brushed steel with laser-engraved marks.
  premium: { label: 'PREMIUM', bg: ['#45484d', '#2b2d31', '#1a1b1e'], contour: 'rgba(230,232,236,.08)', mark: '#d9dce0', text: '#a6abb2', holder: '#9aa0a8', edge: '#1d1e21',
    face: [1, 0.34, 0.9], logo: [0.25, 0.55, 0.75], type: [0.4, 0.55, 0.75], chip: CHIP, brushed: 0.2, coat: 0.3, edgeMetal: 0.9 },
  // Brushed gold with engraved marks.
  private: { label: 'PRIVATE', bg: ['#efdcaa', '#d6ba7d', '#b39150'], contour: 'rgba(90,66,26,.12)', mark: '#5b4520', text: '#6e5729', holder: '#6a5530', edge: '#b8955a',
    face: [1, 0.3, 0.62], logo: [0.25, 0.5, 0.6], type: [0.4, 0.5, 0.6], chip: CHIP, brushed: 0.2, coat: 0.45, edgeMetal: 0.9 },
};

/** How far a touch moves things at the edge of the hero: card tilt in radians, and the studio turned around the cards. */
const REACH = { tiltX: 0.09, tiltY: 0.13, lightX: 0.35, lightY: 0.9 };
const SPRING = { stiffness: 120, damping: 17 };

/** Soft overhead dome plus a few soft boxes and one thin strip; only their reflections are seen. */
function studio(): Scene {
  const scene = new Scene();
  const dome = new SphereGeometry(30, 96, 48);
  const top = new Color('#f2f4f5').multiplyScalar(0.9), mid = new Color('#6f777c').multiplyScalar(0.9), low = new Color('#0e1215');
  const colors: number[] = [];
  const position = dome.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i) / 30, color = new Color();
    if (y > 0) color.lerpColors(mid, top, Math.pow(y, 1.4)); else color.lerpColors(mid, low, Math.min(1, -y * 2));
    colors.push(color.r, color.g, color.b);
  }
  dome.setAttribute('color', new Float32BufferAttribute(colors, 3));
  scene.add(new Mesh(dome, new MeshBasicMaterial({ vertexColors: true, side: BackSide })));
  const box = (width: number, height: number, color: string, strength: number, at: [number, number, number]) => {
    const panel = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ color: new Color(color).multiplyScalar(strength), side: DoubleSide }));
    panel.position.set(...at);
    panel.lookAt(0, 0, 0);
    scene.add(panel);
  };
  box(14, 1.2, '#ffffff', 1.6, [2.6, 8.5, 4.4]);
  box(1.4, 12, '#c9f1f2', 2.5, [10, 1, -3]);
  box(12, 4, '#ffffff', 0.8, [2, 3, 14]);
  box(2, 10, '#ffffff', 1.2, [-11, 0, 2]);
  // A thin bright strip that a tilt sweeps across the foil and the brushed metal.
  box(0.35, 16, '#ffffff', 2, [-5, 5, 9]);
  return scene;
}

const finishColor = ([height, roughness, metalness]: Finish) => `rgb(${Math.round(height * 255)},${Math.round(roughness * 255)},${Math.round(metalness * 255)})`;

/**
 * Draws one face. `color` is the printed art. `surface` packs height (red, for the bump map), roughness (green) and
 * metalness (blue), so the foil, the engraving and the chip catch light differently from the plain face.
 */
function paintFace(g: CanvasRenderingContext2D, width: number, height: number, plan: Plan, mode: 'color' | 'surface') {
  const look = LOOKS[plan];
  const color = mode === 'color';
  if (color) {
    const bg = g.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, look.bg[0]); bg.addColorStop(0.45, look.bg[1]); bg.addColorStop(1, look.bg[2]);
    g.fillStyle = bg;
  } else g.fillStyle = finishColor(look.face);
  g.fillRect(0, 0, width, height);
  // Brushed metal shows its grain through the material's anisotropy; drawn rows would shimmer as stripes when tilted.
  if (color) {
    g.save(); g.translate(width * 0.42, 0); g.scale(width / 300 * 0.66, height / 220 * 0.92);
    g.strokeStyle = look.contour; g.lineWidth = 0.65;
    g.stroke(new Path2D('M11 237C12 135 191 157 222 67C238 22 241-22 301-37')); g.stroke(new Path2D('M42 250C37 157 217 176 245 86C261 38 263-2 315-17'));
    g.restore();
  }
  const pad = width * 0.079;
  // Wordmark
  const k = height * 0.105 / 32;
  g.save(); g.translate(pad + 0.5 * k, pad * 0.92 - 5.5 * k); g.scale(k, k);
  g.strokeStyle = color ? look.mark : finishColor(look.logo); g.lineWidth = 4.6; g.lineCap = 'butt';
  for (const d of ['M19.7 7v22', 'M45.7 7v30', 'M54.3 7v11a8.7 8.7 0 0 0 17.4 0V7', 'M71.7 7v22', 'M97.7 7v22']) g.stroke(new Path2D(d));
  for (const cx of [11, 37, 89]) { g.beginPath(); g.arc(cx, 18, 8.7, 0, Math.PI * 2); g.stroke(); }
  g.restore();
  const spaced = g as CanvasRenderingContext2D & { letterSpacing?: string };
  g.fillStyle = color ? look.text : finishColor(look.type); g.font = `500 ${height * 0.034}px ${FONT}`; g.textAlign = 'right'; g.textBaseline = 'middle';
  spaced.letterSpacing = `${height * 0.012}px`; g.fillText(look.label, width - pad, pad * 1.3);
  // Chip
  const cx = pad, cy = height * 0.43, cw = width * 0.097, ch = width * 0.074;
  if (color) {
    const metal = g.createLinearGradient(cx, cy, cx + cw, cy + ch);
    metal.addColorStop(0, '#eef1ec'); metal.addColorStop(0.37, '#b9c3c2'); metal.addColorStop(0.62, '#dfe4de'); metal.addColorStop(1, '#a9b5b5');
    g.fillStyle = metal;
  } else g.fillStyle = finishColor(look.chip);
  g.beginPath(); g.roundRect(cx, cy, cw, ch, cw * 0.12); g.fill();
  g.strokeStyle = color ? '#8e9da3' : finishColor([0.75, 0.32, 1]); g.lineWidth = cw * 0.014; g.stroke();
  g.save(); g.translate(cx, cy); g.scale(cw / 42, ch / 32); g.strokeStyle = color ? '#7f9197' : finishColor([0.55, 0.36, 1]); g.lineWidth = 0.65;
  g.stroke(new Path2D('M14 1V10H1M28 1V10H41M14 31V22H1M28 31V22H41M1 16H14M28 16H41')); g.beginPath(); g.roundRect(14, 10, 14, 12, 2); g.stroke(); g.restore();
  g.textAlign = 'left'; g.fillStyle = color ? look.holder : finishColor(look.type); g.font = `500 ${height * 0.03}px ${FONT}`; spaced.letterSpacing = `${height * 0.01}px`;
  g.fillText('AQUA MEMBER', pad, height * 0.86);
}

function faceTexture(plan: Plan, width: number, mode: 'color' | 'surface', anisotropy: number): CanvasTexture {
  const height = Math.round(width / 1.586);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  paintFace(canvas.getContext('2d')!, width, height, plan, mode);
  const texture = new CanvasTexture(canvas);
  if (mode === 'color') texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** A rounded slab with the printed face on top. */
function cardGeometry() {
  const width = 3.2, height = width / 1.586, radius = 0.12, thickness = 0.034;
  const shape = new Shape();
  const x0 = -width / 2, y0 = -height / 2;
  shape.moveTo(x0 + radius, y0); shape.lineTo(x0 + width - radius, y0); shape.quadraticCurveTo(x0 + width, y0, x0 + width, y0 + radius);
  shape.lineTo(x0 + width, y0 + height - radius); shape.quadraticCurveTo(x0 + width, y0 + height, x0 + width - radius, y0 + height);
  shape.lineTo(x0 + radius, y0 + height); shape.quadraticCurveTo(x0, y0 + height, x0, y0 + height - radius); shape.lineTo(x0, y0 + radius); shape.quadraticCurveTo(x0, y0, x0 + radius, y0);
  const body = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: 0.007, bevelSize: 0.007, bevelSegments: 6, curveSegments: 32 });
  body.translate(0, 0, -thickness / 2);
  const face = new ShapeGeometry(shape, 32);
  const uv = face.attributes.uv, position = face.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (position.getX(i) - x0) / width, (position.getY(i) - y0) / height);
  return { body, face, faceOffset: thickness / 2 + 0.0075 };
}

export const CANVAS_BOX = {
  left: -BLEED / CROP.width, top: -BLEED / CROP.height,
  width: (CROP.width + 2 * BLEED) / CROP.width, height: (CROP.height + 2 * BLEED) / CROP.height,
};

interface Placement { plan: Plan; position: [number, number, number]; rotation: [number, number, number]; /** Share of the touch tilt. */ depth: number }
/** The back card is the gold Private, the front one the navy Standard. */
const HERO: Placement[] = [
  { plan: 'private', position: [0.95, 0.7, -1.3], rotation: [-0.5, 0.35, 0.22], depth: 0.8 },
  { plan: 'standard', position: [-0.5, -0.42, 0.3], rotation: [-0.55, 0.15, 0.08], depth: 1 },
];

/** The card type is drawn in the app font, so wait for its Latin glyphs first. */
const loadFont = () => document.fonts?.load(`500 40px ${FONT}`, 'AQUA MEMBER STANDARD PRIVATE PREMIUM').then(() => undefined, () => undefined);

function newRenderer(canvas: HTMLCanvasElement, keepFrame = false) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: keepFrame });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
  return renderer;
}

/** Studio reflections, lights and the cards in their resting places. */
function buildStage(renderer: WebGLRenderer, placements: Placement[]) {
  const disposables: { dispose(): void }[] = [];
  const pmrem = new PMREMGenerator(renderer);
  const room = studio();
  const environment = pmrem.fromScene(room, 0.02);
  room.traverse((item) => { if (item instanceof Mesh) { (item.geometry as BufferGeometry).dispose(); (item.material as Material).dispose(); } });
  pmrem.dispose();
  disposables.push(environment);

  const scene = new Scene();
  scene.environment = environment.texture;
  const sunHome = new Vector3(-4, 6, 6);
  const sun = new DirectionalLight('#ffffff', 2.2);
  sun.position.copy(sunHome);
  scene.add(sun, new HemisphereLight('#ffffff', '#3a4146', 0.6));

  const capabilities = renderer.capabilities;
  const colorWidth = Math.min(2048, capabilities.maxTextureSize), surfaceWidth = Math.min(1024, capabilities.maxTextureSize);
  const anisotropy = capabilities.getMaxAnisotropy();
  const geometry = cardGeometry();
  disposables.push(geometry.body, geometry.face);
  const cards = placements.map(({ plan, position, rotation, depth }) => {
    const look = LOOKS[plan];
    const group = new Group();
    const art = faceTexture(plan, colorWidth, 'color', anisotropy);
    const surface = faceTexture(plan, surfaceWidth, 'surface', anisotropy);
    const edge = new MeshPhysicalMaterial({ color: look.edge, metalness: look.edgeMetal, roughness: 0.3, clearcoat: look.coat, anisotropy: look.brushed * 0.6 });
    const face = new MeshPhysicalMaterial({
      map: art, roughness: 1, roughnessMap: surface, metalness: 1, metalnessMap: surface, bumpMap: surface, bumpScale: 0.8,
      clearcoat: look.coat, clearcoatRoughness: 0.12, anisotropy: look.brushed, anisotropyRotation: 0,
    });
    disposables.push(art, surface, edge, face);
    group.add(new Mesh(geometry.body, edge));
    const printed = new Mesh(geometry.face, face);
    printed.position.z = geometry.faceOffset;
    group.add(printed);
    group.position.set(...position);
    const rest = new Euler(...rotation, 'XYZ');
    group.rotation.copy(rest);
    scene.add(group);
    return { group, rest, depth };
  });
  return { scene, sun, sunHome, cards, dispose: () => { for (const item of disposables) item.dispose(); } };
}

/**
 * Renders a still for src/assets: the hero crop at `scale` × 960×630, or one card in a 900×620 frame at `scale`.
 * Resolves to a PNG data URL with a transparent background. Only the image tooling calls this.
 */
export async function renderStill(kind: 'hero' | Plan, scale = 2): Promise<string> {
  await loadFont();
  const canvas = document.createElement('canvas');
  const renderer = newRenderer(canvas, true);
  renderer.setPixelRatio(1);
  const stage = buildStage(renderer, kind === 'hero' ? HERO : [{ plan: kind, position: [0, 0, 0], rotation: [-0.3, 0.32, 0.04], depth: 1 }]);
  const camera = new PerspectiveCamera(26, kind === 'hero' ? FRAME.width / FRAME.height : 900 / 620, 0.1, 100);
  camera.position.set(0, 0.4, kind === 'hero' ? 9.5 : 8.6);
  camera.lookAt(0, 0, 0);
  if (kind === 'hero') {
    camera.setViewOffset(FRAME.width, FRAME.height, CROP.x, CROP.y, CROP.width, CROP.height);
    renderer.setSize(Math.round(960 * scale), Math.round(630 * scale), false);
  } else renderer.setSize(900 * scale, 620 * scale, false);
  renderer.render(stage.scene, camera);
  const url = canvas.toDataURL('image/png');
  stage.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return url;
}

/**
 * Adds a canvas to `host`, renders the hero into it and tilts it while `host` is touched (or hovered with a mouse).
 * Calls `onReady` after the first frame and `onLost` if the GPU drops the context. Resolves to a cleanup function
 * that removes the canvas. Rejects when WebGL is not available, so the caller keeps the still image.
 */
export async function mountCardScene(host: HTMLElement, onReady: () => void, onLost: () => void): Promise<() => void> {
  await loadFont();
  // A fresh canvas per mount: a canvas keeps its first context, so one lost on cleanup could not be used again.
  const canvas = document.createElement('canvas');
  canvas.className = 'card-hero-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const renderer = newRenderer(canvas);
  const { scene, sun, sunHome, cards, dispose } = buildStage(renderer, HERO);

  const camera = new PerspectiveCamera(26, FRAME.width / FRAME.height, 0.1, 100);
  camera.position.set(0, 0.4, 9.5);
  camera.lookAt(0, 0, 0);
  camera.setViewOffset(FRAME.width, FRAME.height, CROP.x - BLEED, CROP.y - BLEED, CROP.width + 2 * BLEED, CROP.height + 2 * BLEED);

  // Pose: x and y run from -1 to 1 across the hero; the spring eases toward the target.
  const pose = { x: 0, y: 0, vx: 0, vy: 0 };
  const target = { x: 0, y: 0 };
  const turn = new Euler();
  let shown = '';
  function apply() {
    // The current tilt, rounded, for tests and debugging.
    const tilt = `${pose.x.toFixed(2)} ${pose.y.toFixed(2)}`.replaceAll('-0.00', '0.00');
    if (tilt !== shown) host.dataset.tilt = shown = tilt;
    for (const { group, rest, depth } of cards) group.rotation.set(rest.x + pose.y * REACH.tiltX * depth, rest.y + pose.x * REACH.tiltY * depth, rest.z);
    turn.set(pose.y * REACH.lightX, pose.x * REACH.lightY, 0);
    scene.environmentRotation.copy(turn);
    sun.position.copy(sunHome).applyEuler(turn);
  }
  const render = () => { apply(); renderer.render(scene, camera); };

  let frame = 0, last = 0, pressed = false;
  const tick = (now: number) => {
    // Follow real time in small steps, so a slow device drops frames instead of slowing the motion down.
    let remaining = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    while (remaining > 0) {
      const dt = Math.min(1 / 120, remaining);
      remaining -= dt;
      for (const axis of ['x', 'y'] as const) {
        const speed = axis === 'x' ? 'vx' : 'vy';
        pose[speed] += ((target[axis] - pose[axis]) * SPRING.stiffness - pose[speed] * SPRING.damping) * dt;
        pose[axis] += pose[speed] * dt;
      }
    }
    render();
    const settled = Math.abs(target.x - pose.x) < 1e-4 && Math.abs(target.y - pose.y) < 1e-4 && Math.abs(pose.vx) < 1e-3 && Math.abs(pose.vy) < 1e-3;
    frame = settled ? 0 : requestAnimationFrame(tick);
  };
  const kick = () => { if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); } };

  const aim = (event: PointerEvent) => {
    const bounds = host.getBoundingClientRect();
    const clamp = (value: number) => Math.max(-1, Math.min(1, value));
    target.x = clamp(((event.clientX - bounds.left) / bounds.width) * 2 - 1);
    target.y = clamp(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
    kick();
  };
  const release = () => { pressed = false; target.x = 0; target.y = 0; kick(); };
  const hover = matchMedia('(hover: hover) and (pointer: fine)');
  const down = (event: PointerEvent) => { if (event.pointerType === 'mouse' && event.button !== 0) return; pressed = true; aim(event); };
  const move = (event: PointerEvent) => { if (pressed || (event.pointerType === 'mouse' && hover.matches)) aim(event); };
  const up = (event: PointerEvent) => { if (event.pointerType === 'mouse' && hover.matches) { pressed = false; aim(event); } else release(); };
  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerup', up);
  host.addEventListener('pointercancel', release);
  host.addEventListener('pointerleave', release);

  const size = new Vector2();
  const resize = () => {
    const bounds = host.getBoundingClientRect();
    if (!bounds.width) return;
    // Up to 3× so text on the cards stays as sharp as the still image on high-density phones.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
    const width = Math.round(bounds.width * CANVAS_BOX.width), height = Math.round(bounds.height * CANVAS_BOX.height);
    if (renderer.getSize(size).x !== width || size.y !== height) renderer.setSize(width, height, false);
    render();
  };
  // Watching the canvas too redraws it when CSS first shows it.
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  observer.observe(canvas);
  const lost = (event: Event) => { event.preventDefault(); onLost(); };
  canvas.addEventListener('webglcontextlost', lost);

  host.append(canvas);
  resize();
  onReady();

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    host.removeEventListener('pointerdown', down);
    host.removeEventListener('pointermove', move);
    host.removeEventListener('pointerup', up);
    host.removeEventListener('pointercancel', release);
    host.removeEventListener('pointerleave', release);
    canvas.removeEventListener('webglcontextlost', lost);
    delete host.dataset.tilt;
    dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}
