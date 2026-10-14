import {
  BackSide, CanvasTexture, Color, DirectionalLight, DoubleSide, Euler, ExtrudeGeometry, Float32BufferAttribute, Group, HemisphereLight,
  Mesh, MeshBasicMaterial, MeshPhysicalMaterial, NeutralToneMapping, PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, Shape,
  ShapeGeometry, SphereGeometry, SRGBColorSpace, Vector3, WebGLRenderer, type BufferGeometry, type Material, type Texture,
} from 'three';

/**
 * The two-card hero rendered live, so touching it tilts the cards and the studio lights slide across their faces.
 * It is the same scene, lights and camera that made src/assets/aqua-cards.webp (1800×1200 frame cropped to the
 * cards), so the first live frame matches the still image it replaces.
 */

const FRAME = { width: 1800, height: 1200 };
/** Where the still image was cropped from the frame. */
const CROP = { x: 282, y: 198, width: 1237, height: 812 };
/** Extra frame drawn around the crop so tilted corners are never cut off. CardHero.css places the canvas to match. */
const BLEED = 40;

type Plan = 'standard' | 'premium' | 'private';
const LOOKS: Record<Plan, { label: string; bg: [string, string, string]; contour: string; mark: string; text: string; holder: string; edge: string; faceMetal: number; edgeMetal: number; rough: number }> = {
  standard: { label: 'STANDARD', bg: ['#26405c', '#1a2e46', '#122036'], contour: 'rgba(216,228,243,.10)', mark: '#c3d1e0', text: '#9fadc0', holder: '#93a4b9', edge: '#16263b', faceMetal: 0.18, edgeMetal: 0.6, rough: 0.38 },
  premium: { label: 'PREMIUM', bg: ['#45484d', '#2b2d31', '#1a1b1e'], contour: 'rgba(230,232,236,.08)', mark: '#d9dce0', text: '#a6abb2', holder: '#9aa0a8', edge: '#1d1e21', faceMetal: 0.55, edgeMetal: 0.85, rough: 0.34 },
  private: { label: 'PRIVATE', bg: ['#efdcaa', '#d6ba7d', '#b39150'], contour: 'rgba(90,66,26,.12)', mark: '#5b4520', text: '#6e5729', holder: '#6a5530', edge: '#b8955a', faceMetal: 0.62, edgeMetal: 0.9, rough: 0.3 },
};

/** How far a touch moves things at the edge of the hero: card tilt in radians, and the studio turned around the cards. */
const REACH = { tiltX: 0.09, tiltY: 0.13, lightX: 0.35, lightY: 0.9 };
const SPRING = { stiffness: 120, damping: 17 };

/** Soft overhead dome plus a few soft boxes; only its reflections are seen. */
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
  return scene;
}

/** The printed face, drawn like the in-app CardVisual. */
function art(plan: Plan): CanvasTexture {
  const look = LOOKS[plan];
  const width = 1024, height = Math.round(width / 1.586);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const g = canvas.getContext('2d')!;
  const bg = g.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, look.bg[0]); bg.addColorStop(0.45, look.bg[1]); bg.addColorStop(1, look.bg[2]);
  g.fillStyle = bg; g.fillRect(0, 0, width, height);
  if (plan !== 'standard') {
    // Brushed finish on the metal cards.
    g.save(); g.globalAlpha = plan === 'private' ? 0.05 : 0.06;
    for (let y = 0; y < height; y += 2) { g.fillStyle = (y / 2) % 2 ? '#ffffff' : '#000000'; g.fillRect(0, y, width, 1); }
    g.restore();
  }
  g.save(); g.translate(width * 0.42, 0); g.scale(width / 300 * 0.66, height / 220 * 0.92);
  g.strokeStyle = look.contour; g.lineWidth = 0.65;
  g.stroke(new Path2D('M11 237C12 135 191 157 222 67C238 22 241-22 301-37')); g.stroke(new Path2D('M42 250C37 157 217 176 245 86C261 38 263-2 315-17'));
  g.restore();
  const pad = width * 0.079;
  // Wordmark
  const k = height * 0.105 / 32;
  g.save(); g.translate(pad + 0.5 * k, pad * 0.92 - 5.5 * k); g.scale(k, k);
  g.strokeStyle = look.mark; g.lineWidth = 4.6; g.lineCap = 'butt';
  for (const d of ['M19.7 7v22', 'M45.7 7v30', 'M54.3 7v11a8.7 8.7 0 0 0 17.4 0V7', 'M71.7 7v22', 'M97.7 7v22']) g.stroke(new Path2D(d));
  for (const cx of [11, 37, 89]) { g.beginPath(); g.arc(cx, 18, 8.7, 0, Math.PI * 2); g.stroke(); }
  g.restore();
  const spaced = g as CanvasRenderingContext2D & { letterSpacing?: string };
  g.fillStyle = look.text; g.font = `500 ${height * 0.034}px Arial, sans-serif`; g.textAlign = 'right'; g.textBaseline = 'middle';
  spaced.letterSpacing = `${height * 0.012}px`; g.fillText(look.label, width - pad, pad * 1.3);
  // Chip
  const cx = pad, cy = height * 0.43, cw = width * 0.097, ch = width * 0.074;
  const metal = g.createLinearGradient(cx, cy, cx + cw, cy + ch);
  metal.addColorStop(0, '#eef1ec'); metal.addColorStop(0.37, '#b9c3c2'); metal.addColorStop(0.62, '#dfe4de'); metal.addColorStop(1, '#a9b5b5');
  g.fillStyle = metal; g.beginPath(); g.roundRect(cx, cy, cw, ch, cw * 0.12); g.fill();
  g.strokeStyle = '#8e9da3'; g.lineWidth = cw * 0.014; g.stroke();
  g.save(); g.translate(cx, cy); g.scale(cw / 42, ch / 32); g.strokeStyle = '#7f9197'; g.lineWidth = 0.65;
  g.stroke(new Path2D('M14 1V10H1M28 1V10H41M14 31V22H1M28 31V22H41M1 16H14M28 16H41')); g.beginPath(); g.roundRect(14, 10, 14, 12, 2); g.stroke(); g.restore();
  g.textAlign = 'left'; g.fillStyle = look.holder; g.font = `500 ${height * 0.03}px Arial, sans-serif`; spaced.letterSpacing = `${height * 0.01}px`;
  g.fillText('AQUA MEMBER', pad, height * 0.86);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 8;
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
  const body = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 4, curveSegments: 24 });
  body.translate(0, 0, -thickness / 2);
  const face = new ShapeGeometry(shape, 24);
  const uv = face.attributes.uv, position = face.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (position.getX(i) - x0) / width, (position.getY(i) - y0) / height);
  return { body, face, faceOffset: thickness / 2 + 0.0065 };
}

export const CANVAS_BOX = {
  left: -BLEED / CROP.width, top: -BLEED / CROP.height,
  width: (CROP.width + 2 * BLEED) / CROP.width, height: (CROP.height + 2 * BLEED) / CROP.height,
};

/**
 * Adds a canvas to `host`, renders the hero into it and tilts it while `host` is touched (or hovered with a mouse).
 * Calls `onReady` after the first frame and `onLost` if the GPU drops the context. Returns a cleanup function that
 * removes the canvas. Throws when WebGL is not available, so the caller keeps the still image.
 */
export function mountCardScene(host: HTMLElement, onReady: () => void, onLost: () => void): () => void {
  // A fresh canvas per mount: a canvas keeps its first context, so one lost on cleanup could not be used again.
  const canvas = document.createElement('canvas');
  canvas.className = 'card-hero-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = NeutralToneMapping;
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

  const geometry = cardGeometry();
  disposables.push(geometry.body, geometry.face);
  const card = (plan: Plan) => {
    const look = LOOKS[plan];
    const group = new Group();
    const texture: Texture = art(plan);
    const edge = new MeshPhysicalMaterial({ color: look.edge, metalness: look.edgeMetal, roughness: 0.32, clearcoat: 0.6 });
    const face = new MeshPhysicalMaterial({ map: texture, roughness: look.rough, metalness: look.faceMetal, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    disposables.push(texture, edge, face);
    group.add(new Mesh(geometry.body, edge));
    const printed = new Mesh(geometry.face, face);
    printed.position.z = geometry.faceOffset;
    group.add(printed);
    return group;
  };
  const back = card('private');
  back.position.set(0.95, 0.7, -1.3);
  const backRest = new Euler(-0.5, 0.35, 0.22, 'XYZ');
  const front = card('standard');
  front.position.set(-0.5, -0.42, 0.3);
  const frontRest = new Euler(-0.55, 0.15, 0.08, 'XYZ');
  scene.add(back, front);

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
    front.rotation.set(frontRest.x + pose.y * REACH.tiltX, frontRest.y + pose.x * REACH.tiltY, frontRest.z);
    back.rotation.set(backRest.x + pose.y * REACH.tiltX * 0.8, backRest.y + pose.x * REACH.tiltY * 0.8, backRest.z);
    turn.set(pose.y * REACH.lightX, pose.x * REACH.lightY, 0);
    scene.environmentRotation.copy(turn);
    sun.position.copy(sunHome).applyEuler(turn);
  }
  const render = () => { apply(); renderer.render(scene, camera); };

  let frame = 0, last = 0, pressed = false;
  const tick = (now: number) => {
    const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000) || 1 / 60);
    last = now;
    for (const axis of ['x', 'y'] as const) {
      const speed = axis === 'x' ? 'vx' : 'vy';
      pose[speed] += ((target[axis] - pose[axis]) * SPRING.stiffness - pose[speed] * SPRING.damping) * dt;
      pose[axis] += pose[speed] * dt;
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

  const resize = () => {
    const bounds = host.getBoundingClientRect();
    if (!bounds.width) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(Math.round(bounds.width * CANVAS_BOX.width), Math.round(bounds.height * CANVAS_BOX.height), false);
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
    for (const item of disposables) item.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
}
