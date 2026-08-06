import * as THREE from "three";
import { GLTFLoader } from "../vendor/GLTFLoader.js";

export const KART_COLORS = { red: 0xe23d2e, blue: 0x2f6fe0, green: 0x3fa04c, yellow: 0xf2b21c };
export const KART_IDS = ["red", "blue", "green", "yellow"];

// 3-step gradient map shared by every toon material
function gradientMap() {
  const data = new Uint8Array([90, 180, 255, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.needsUpdate = true;
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  return tex;
}
const GRAD = gradientMap();

export function toon(color, opts = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: GRAD, ...opts });
}

function canvasTexture(draw, size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

async function loadTextureOrFallback(url, fallbackDraw) {
  const loader = new THREE.TextureLoader();
  try {
    const tex = await loader.loadAsync(url);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  } catch {
    console.warn(`asset missing, using placeholder: ${url}`);
    return canvasTexture(fallbackDraw);
  }
}

const roadDraw = (g, s) => {
  g.fillStyle = "#6b6f78"; g.fillRect(0, 0, s, s);
  g.fillStyle = "#767a84";
  for (let i = 0; i < 60; i++) g.fillRect(Math.random() * s, Math.random() * s, 3, 3);
};
const grassDraw = (g, s) => {
  g.fillStyle = "#7ec850"; g.fillRect(0, 0, s, s);
  g.fillStyle = "#8fd45e";
  for (let i = 0; i < 80; i++) g.fillRect(Math.random() * s, Math.random() * s, 4, 2);
};
const dirtDraw = (g, s) => {
  g.fillStyle = "#c9a06a"; g.fillRect(0, 0, s, s);
};
const checkerDraw = (g, s) => {
  const n = 8, c = s / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    g.fillStyle = (x + y) % 2 ? "#111" : "#fff";
    g.fillRect(x * c, y * c, c, c);
  }
};

// Chibi placeholder kart, used only if a generated GLB is missing
function placeholderKart(colorHex) {
  const grp = new THREE.Group();
  const body = toon(colorHex);
  const dark = toon(0x2a2a2e);
  const skin = toon(0xf2c94c);
  const add = (geo, mat, x, y, z) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    grp.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(1.5, 0.5, 2.2), body, 0, 0.45, 0);
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 12);
  for (const [wx, wz] of [[-0.8, 0.75], [0.8, 0.75], [-0.8, -0.75], [0.8, -0.75]]) {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.rotation.z = Math.PI / 2;
    w.position.set(wx, 0.34, wz);
    grp.add(w);
  }
  add(new THREE.CylinderGeometry(0.28, 0.36, 0.55, 10), body, 0, 0.95, -0.1);
  add(new THREE.SphereGeometry(0.52, 16, 12), skin, 0, 1.65, -0.1);
  return grp;
}

// generated meshes face arbitrary directions; measured per model (front must point +z)
const KART_YAW_FIX = { red: 0, blue: Math.PI / 2, green: 0, yellow: 0 };

async function loadGlb(url, tintToon = true) {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(url);
  const m = gltf.scene;
  if (tintToon) {
    m.traverse((n) => {
      if (n.isMesh) {
        n.material = new THREE.MeshToonMaterial({
          color: n.material.color ?? 0xffffff, map: n.material.map ?? null, gradientMap: GRAD,
        });
      }
    });
  }
  return m;
}

async function loadKartModel(id) {
  try {
    const model = await loadGlb(`./assets/kart_${id}.glb`);
    model.rotation.y = KART_YAW_FIX[id] ?? 0;
    const wrap = new THREE.Group();
    wrap.add(model);
    const box = new THREE.Box3().setFromObject(wrap);
    const s = 2.4 / (box.max.z - box.min.z || 1);
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;
    return wrap;
  } catch {
    console.warn(`kart model missing, using placeholder: kart_${id}.glb`);
    return placeholderKart(KART_COLORS[id]);
  }
}

export async function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9ed4f5, 120, 320);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
  camera.position.set(0, 30, -40);

  const hemi = new THREE.HemisphereLight(0xfff6e0, 0x7ec850, 1.1);
  const sun = new THREE.DirectionalLight(0xfff2cc, 1.6);
  sun.position.set(60, 100, 40);
  scene.add(hemi, sun);

  const [roadTex, grassTex, dirtTex] = await Promise.all([
    loadTextureOrFallback("./assets/tex_road.png", roadDraw),
    loadTextureOrFallback("./assets/tex_grass.png", grassDraw),
    loadTextureOrFallback("./assets/tex_dirt.png", dirtDraw),
  ]);
  grassTex.repeat.set(40, 40);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  for (const t of [roadTex, grassTex, dirtTex]) t.anisotropy = Math.min(4, maxAniso);
  const checker = canvasTexture(checkerDraw, 128);

  // prop templates loaded once, cloned per track build
  const outMat = new THREE.MeshBasicMaterial({ color: 0x1c1c22, side: THREE.BackSide });
  const propPlaceholders = {
    prop_tree: () => {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 2, 8), toon(0x8a5a33));
      trunk.position.y = 1;
      const crown = new THREE.Mesh(new THREE.SphereGeometry(1.9, 12, 10), toon(0x4fae53));
      crown.position.y = 3.2;
      g.add(trunk, crown);
      return g;
    },
    prop_house: () => {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(5, 3.4, 4.4), toon(0xf7cfd8));
      base.position.y = 1.7;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4.2, 2.4, 4), toon(0xb2543e));
      roof.position.y = 4.6;
      roof.rotation.y = Math.PI / 4;
      g.add(base, roof);
      return g;
    },
    prop_donut: () => {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 6, 8), toon(0x9a9aa5));
      pole.position.y = 3;
      const donut = new THREE.Mesh(new THREE.TorusGeometry(2, 0.85, 12, 24), toon(0xf7a8c4));
      donut.position.y = 7.5;
      g.add(pole, donut);
      return g;
    },
  };
  const PROP_HEIGHT = { prop_tree: 7, prop_house: 7, prop_donut: 9 };
  async function propTemplate(id) {
    let m;
    try {
      m = await loadGlb(`./assets/${id}.glb`);
    } catch {
      m = propPlaceholders[id]();
    }
    const box = new THREE.Box3().setFromObject(m);
    const s = (PROP_HEIGHT[id] ?? 5) / (box.max.y - box.min.y || 1);
    m.scale.setScalar(s);
    m.position.y = -box.min.y * s;
    const wrap = new THREE.Group();
    wrap.add(m);
    return wrap;
  }
  const propTemplates = {
    prop_tree: await propTemplate("prop_tree"),
    prop_house: await propTemplate("prop_house"),
    prop_donut: await propTemplate("prop_donut"),
  };

  // item entity meshes: donut projectile model (generated if present)
  let donutTemplate;
  try {
    const m = await loadGlb("./assets/item_donut.glb");
    const box = new THREE.Box3().setFromObject(m);
    m.scale.setScalar(1.4 / (box.max.y - box.min.y || 1));
    donutTemplate = new THREE.Group();
    donutTemplate.add(m);
  } catch {
    donutTemplate = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.28, 10, 18), toon(0xf7a8c4));
  }

  // --- sparks pool ---
  const SPARKS = 150;
  const sparkGeo = new THREE.BufferGeometry();
  const sparkPos = new Float32Array(SPARKS * 3).fill(0);
  const sparkCol = new Float32Array(SPARKS * 3).fill(0);
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute("color", new THREE.BufferAttribute(sparkCol, 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ size: 0.35, vertexColors: true, transparent: true, opacity: 0.9 }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  const sparkLife = new Float32Array(SPARKS).fill(0);
  const sparkVel = new Float32Array(SPARKS * 3).fill(0);
  let sparkHead = 0;

  // --- skid marks pool: flat quads on the road, fading out ---
  const SKIDS = 400;
  const skidGeo = new THREE.BufferGeometry();
  const skidPos = new Float32Array(SKIDS * 4 * 3);
  const skidAlpha = new Float32Array(SKIDS * 4).fill(0);
  const skidIdx = [];
  for (let i = 0; i < SKIDS; i++) skidIdx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2);
  skidGeo.setAttribute("position", new THREE.BufferAttribute(skidPos, 3));
  skidGeo.setAttribute("alpha", new THREE.BufferAttribute(skidAlpha, 1));
  skidGeo.setIndex(skidIdx);
  const skidMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: "attribute float alpha; varying float vA; void main(){ vA=alpha; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
    fragmentShader: "varying float vA; void main(){ gl_FragColor=vec4(0.12,0.12,0.14,vA*0.55); }",
  });
  const skids = new THREE.Mesh(skidGeo, skidMat);
  skids.frustumCulled = false;
  scene.add(skids);
  const skidLife = new Float32Array(SKIDS).fill(0);
  let skidHead = 0;

  const karts = {};
  let trackGroup = null;
  let itemGroup = null;
  let podiumGroup = null;
  const itemMeshes = { boxes: [], donuts: [], puddles: [] };
  let currentTrack = null;

  const api = {
    renderer, scene, camera,
    fov: 70,
    camPos: new THREE.Vector3(0, 6, -12),

    // ---------- track ----------
    async setTrack(track, rand) {
      currentTrack = track;
      const theme = track.theme;
      if (trackGroup) { scene.remove(trackGroup); disposeGroup(trackGroup); }
      if (itemGroup) { scene.remove(itemGroup); disposeGroup(itemGroup); itemMeshes.boxes = []; itemMeshes.donuts = []; itemMeshes.puddles = []; }
      trackGroup = new THREE.Group();

      renderer.setClearColor(theme.sky);
      scene.fog.color.set(theme.sky);
      scene.fog.near = theme.fogNear;
      scene.fog.far = theme.fogFar;
      hemi.color.set(theme.hemi[0]);
      hemi.groundColor.set(theme.hemi[1]);
      hemi.intensity = theme.hemi[2];
      sun.color.set(theme.sun[0]);
      sun.intensity = theme.sun[1];
      sun.position.set(...theme.sun[2]);

      const geos = track.buildRoadGeometry();
      trackGroup.add(new THREE.Mesh(geos.road, toon(theme.roadTint, { map: roadTex })));
      const dirtMat = toon(theme.roadTint, { map: dirtTex });
      trackGroup.add(new THREE.Mesh(geos.shoulderL, dirtMat));
      trackGroup.add(new THREE.Mesh(geos.shoulderR, dirtMat));
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), toon(theme.grassTint, { map: grassTex }));
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.02;
      trackGroup.add(ground);

      const padMat = new THREE.MeshBasicMaterial({ color: 0xff3fa4, transparent: true, opacity: 0.85 });
      for (const g of track.buildBoostPadGeometry()) trackGroup.add(new THREE.Mesh(g, padMat));
      trackGroup.add(new THREE.Mesh(track.buildStartLineGeometry(), new THREE.MeshBasicMaterial({ map: checker })));

      // props: landmark donut + scatter, clear of every road section
      const placed = [];
      const donutSign = propTemplates.prop_donut.clone();
      const s0 = track.sample(0.03);
      donutSign.position.set(s0.pos.x * 1.35, 0, s0.pos.z * 1.35);
      trackGroup.add(donutSign);
      placed.push(donutSign.position);
      for (let i = 0; i < 48; i++) {
        const t = rand();
        const { pos, tan } = track.sample(t);
        const side = new THREE.Vector3().crossVectors(tan, new THREE.Vector3(0, 1, 0));
        const dist = 12 + rand() * 25;
        const sgn = rand() > 0.5 ? 1 : -1;
        const kind = rand() > 0.75 ? "prop_house" : "prop_tree";
        const p = propTemplates[kind].clone();
        p.position.set(pos.x + side.x * dist * sgn, 0, pos.z + side.z * dist * sgn);
        if (Math.hypot(p.position.x, p.position.z) > 145) continue;
        if (Math.abs(track.closest(p.position).lateral) < track.ROAD_HALF_WIDTH + 4) continue;
        if (placed.some((q) => q.distanceTo(p.position) < 9)) continue;
        p.rotation.y = rand() * Math.PI * 2;
        p.scale.setScalar(0.8 + rand() * 0.5);
        trackGroup.add(p);
        placed.push(p.position);
      }
      scene.add(trackGroup);
    },

    // ---------- karts ----------
    async addKart(seat, id) {
      if (karts[seat]) scene.remove(karts[seat].group);
      const group = await loadKartModel(id);
      scene.add(group);
      karts[seat] = { group, id };
    },
    removeKart(seat) {
      if (karts[seat]) { scene.remove(karts[seat].group); delete karts[seat]; }
    },
    removeAllKarts() {
      for (const s of Object.keys(karts)) api.removeKart(s);
    },
    hasKart(seat) { return !!karts[seat]; },
    kartObject(seat) { return karts[seat]?.group ?? null; },

    setKartPose(seat, x, z, yaw, visual = {}) {
      const k = karts[seat];
      if (!k) return;
      k.group.position.set(x, 0, z);
      const slide = visual.drifting ? (visual.driftDir ?? 0) * 0.35 : 0;
      k.group.rotation.set(0, yaw + slide + (visual.spin ?? 0), 0);
      k.group.rotation.z = -(visual.steer ?? 0) * 0.08;
      const t = performance.now() / 1000;
      k.group.position.y = Math.abs(Math.sin(t * 10 + seat)) * 0.03 * Math.min(1, (visual.speed ?? 0) / 10);
    },

    // ---------- effects ----------
    emitSparks(x, z, yaw, tier) {
      const col = tier >= 2 ? [1, 0.25, 0.64] : tier === 3 ? [1, 0.8, 0.2] : [0.4, 0.8, 1];
      for (let i = 0; i < 3; i++) {
        const j = sparkHead = (sparkHead + 1) % SPARKS;
        sparkPos[j * 3] = x - Math.sin(yaw) * 1.2 + (Math.random() - 0.5) * 0.6;
        sparkPos[j * 3 + 1] = 0.2;
        sparkPos[j * 3 + 2] = z - Math.cos(yaw) * 1.2 + (Math.random() - 0.5) * 0.6;
        sparkCol.set(col, j * 3);
        sparkVel[j * 3] = (Math.random() - 0.5) * 3;
        sparkVel[j * 3 + 1] = 2 + Math.random() * 2;
        sparkVel[j * 3 + 2] = (Math.random() - 0.5) * 3;
        sparkLife[j] = 0.4;
      }
    },

    confetti(x, z) {
      for (let i = 0; i < 40; i++) {
        const j = sparkHead = (sparkHead + 1) % SPARKS;
        sparkPos[j * 3] = x + (Math.random() - 0.5) * 4;
        sparkPos[j * 3 + 1] = 4 + Math.random() * 3;
        sparkPos[j * 3 + 2] = z + (Math.random() - 0.5) * 4;
        sparkCol.set([Math.random(), Math.random(), Math.random()], j * 3);
        sparkVel[j * 3] = (Math.random() - 0.5) * 2;
        sparkVel[j * 3 + 1] = -0.5 - Math.random();
        sparkVel[j * 3 + 2] = (Math.random() - 0.5) * 2;
        sparkLife[j] = 3;
      }
    },

    updateSparks(dt) {
      for (let j = 0; j < SPARKS; j++) {
        if (sparkLife[j] <= 0) { sparkPos[j * 3 + 1] = -10; continue; }
        sparkLife[j] -= dt;
        sparkPos[j * 3] += sparkVel[j * 3] * dt;
        sparkPos[j * 3 + 1] += sparkVel[j * 3 + 1] * dt;
        sparkPos[j * 3 + 2] += sparkVel[j * 3 + 2] * dt;
        sparkVel[j * 3 + 1] -= sparkVel[j * 3 + 1] > -2 ? 3 * dt : 0;
      }
      sparkGeo.attributes.position.needsUpdate = true;
      sparkGeo.attributes.color.needsUpdate = true;
    },

    addSkid(x, z, yaw) {
      const j = skidHead = (skidHead + 1) % SKIDS;
      const sx = Math.cos(yaw) * 0.55, sz = -Math.sin(yaw) * 0.55; // sideways offset
      const fx = Math.sin(yaw) * 0.5, fz = Math.cos(yaw) * 0.5;
      const y = 0.015;
      skidPos.set([
        x - sx - fx, y, z - sz - fz,
        x + sx - fx, y, z + sz - fz,
        x - sx + fx, y, z - sz + fz,
        x + sx + fx, y, z + sz + fz,
      ], j * 12);
      skidLife[j] = 4;
      skidGeo.attributes.position.needsUpdate = true;
    },

    updateSkids(dt) {
      for (let j = 0; j < SKIDS; j++) {
        if (skidLife[j] <= 0) continue;
        skidLife[j] -= dt;
        const a = Math.max(0, Math.min(1, skidLife[j] / 4));
        skidAlpha.fill(a, j * 4, j * 4 + 4);
      }
      skidGeo.attributes.alpha.needsUpdate = true;
    },

    // ---------- items ----------
    syncItems(entities, now) {
      if (!itemGroup) { itemGroup = new THREE.Group(); scene.add(itemGroup); }
      // boxes: pool sized on first call
      while (itemMeshes.boxes.length < entities.boxes.length) {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(1.1, 1.1, 1.1),
          new THREE.MeshBasicMaterial({ color: 0xff9fd0, transparent: true, opacity: 0.85 }),
        );
        const edge = new THREE.Mesh(new THREE.BoxGeometry(1.16, 1.16, 1.16), new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }));
        m.add(edge);
        itemGroup.add(m);
        itemMeshes.boxes.push(m);
      }
      entities.boxes.forEach((b, i) => {
        const m = itemMeshes.boxes[i];
        m.visible = b.alive;
        m.position.set(b.x, 1 + Math.sin(now * 2 + i) * 0.15, b.z);
        m.rotation.y = now * 1.5 + i;
        m.rotation.x = now * 0.7;
      });
      while (itemMeshes.donuts.length < entities.donuts.length) {
        const m = donutTemplate.clone();
        itemGroup.add(m);
        itemMeshes.donuts.push(m);
      }
      itemMeshes.donuts.forEach((m, i) => {
        const d = entities.donuts[i];
        m.visible = !!d;
        if (d) {
          m.position.set(d.x, 0.7, d.z);
          m.rotation.set(0, d.yaw ?? 0, now * 8 % (Math.PI * 2)); // rolling
        }
      });
      while (itemMeshes.puddles.length < entities.puddles.length) {
        const m = new THREE.Mesh(
          new THREE.CircleGeometry(1.5, 20),
          new THREE.MeshBasicMaterial({ color: 0xff70b8, transparent: true, opacity: 0.8 }),
        );
        m.rotation.x = -Math.PI / 2;
        itemGroup.add(m);
        itemMeshes.puddles.push(m);
      }
      itemMeshes.puddles.forEach((m, i) => {
        const p = entities.puddles[i];
        m.visible = !!p;
        if (p) m.position.set(p.x, 0.02, p.z);
      });
    },

    // ---------- podium ----------
    showPodium(top3KartIds) {
      api.hidePodium();
      podiumGroup = new THREE.Group();
      const heights = [2.2, 1.5, 1.0];
      const order = [[0, 0], [1, -3.2], [2, 3.2]]; // place, x offset
      for (const [place, xo] of order) {
        const id = top3KartIds[place];
        if (!id) continue;
        const stand = new THREE.Mesh(new THREE.BoxGeometry(2.8, heights[place], 2.8), toon(0xfffdf5));
        stand.position.set(xo, heights[place] / 2, 0);
        podiumGroup.add(stand);
      }
      podiumGroup.position.set(0, 0, 0);
      scene.add(podiumGroup);
      return { heights, order };
    },
    hidePodium() {
      if (podiumGroup) { scene.remove(podiumGroup); disposeGroup(podiumGroup); podiumGroup = null; }
    },

    // ---------- cameras ----------
    followKart(seat, boosting, dt) {
      const k = karts[seat];
      if (!k) return;
      const yaw = k.group.rotation.y;
      const target = new THREE.Vector3(
        k.group.position.x - Math.sin(yaw) * 8,
        4.2,
        k.group.position.z - Math.cos(yaw) * 8,
      );
      const stiff = 1 - Math.exp(-6 * dt);
      this.camPos.lerp(target, stiff);
      camera.position.copy(this.camPos);
      const look = k.group.position.clone();
      look.y = 1.2;
      look.x += Math.sin(yaw) * 4;
      look.z += Math.cos(yaw) * 4;
      camera.lookAt(look);
      const targetFov = boosting ? 80 : 70;
      this.fov += (targetFov - this.fov) * Math.min(1, 8 * dt);
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    },

    // countdown fly-in: f goes 1 -> 0, from high overview down to the chase position
    introCamera(seat, f) {
      const k = karts[seat];
      if (!k) return;
      const yaw = k.group.rotation.y;
      const chase = new THREE.Vector3(
        k.group.position.x - Math.sin(yaw) * 8, 4.2, k.group.position.z - Math.cos(yaw) * 8,
      );
      const high = new THREE.Vector3(
        k.group.position.x - Math.sin(yaw) * 30 + 20, 35, k.group.position.z - Math.cos(yaw) * 30 - 20,
      );
      const e = f * f;
      camera.position.lerpVectors(chase, high, e);
      this.camPos.copy(camera.position);
      camera.lookAt(k.group.position.x, 1, k.group.position.z);
      camera.fov = 70; this.fov = 70;
      camera.updateProjectionMatrix();
    },

    overviewCamera(t) {
      camera.position.set(Math.sin(t * 0.08) * 120, 70, Math.cos(t * 0.08) * 120);
      camera.lookAt(0, 0, 0);
      camera.fov = 60;
      camera.updateProjectionMatrix();
    },

    podiumCamera(t) {
      camera.position.set(Math.sin(t * 0.15) * 12, 5.5, 11 + Math.cos(t * 0.15) * 2);
      camera.lookAt(0, 2.2, 0);
      camera.fov = 55;
      camera.updateProjectionMatrix();
    },

    resize(w, h, dpr) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },

    render() { renderer.render(scene, camera); },
    drawCalls() { return renderer.info.render.calls; },
  };
  return api;
}

function disposeGroup(g) {
  g.traverse((n) => {
    if (n.isMesh) {
      n.geometry?.dispose();
      if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose());
      else n.material?.dispose();
    }
  });
}
