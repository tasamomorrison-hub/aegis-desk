/* AEGIS wall display: Three.js backdrop + live HUD fed by the local paper engine. */
(() => {
  "use strict";

  const CLASS = { SPY: "eq", QQQ: "eq", IWM: "eq", EFA: "eq", EEM: "eq", TLT: "bd", IEF: "bd", GLD: "ra", DBC: "ra", VNQ: "ra", SHY: "safe" };
  const CLASS_HEX = { eq: 0x7dd3fc, bd: 0xa5b4fc, ra: 0xfcd08a, safe: 0x94a3b8 };
  const SERIES = { aegis: "#3395bf", spy: "#c2803f" }; // validated pair (dataviz check, dark surface)
  const $ = (id) => document.getElementById(id);
  const fmt$ = (v, d = 0) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPct = (v, d = 1) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(d) + "%";
  const cls = (v) => (v > 1e-9 ? "up" : v < -1e-9 ? "down" : "flat");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let state = null, backtest = null, view = "live";
  let seenTrades = null, latency = null;
  const bootAt = Date.now();
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================================================================ 3D SCENE */
  const canvas = $("scene");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x080b17);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0e1d, 0.022);
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 400);
  const CORE_Y = 2.4;

  scene.add(new THREE.AmbientLight(0x8fa6d6, 0.75));
  const keyLight = new THREE.PointLight(0xbfe6ff, 1.4, 50); keyLight.position.set(3, CORE_Y + 6, 8); scene.add(keyLight);
  const rimLight = new THREE.PointLight(0xc4b5fd, 1.2, 50); rimLight.position.set(-9, CORE_Y - 1, -7); scene.add(rimLight);

  // one soft radial sprite, reused for every glow in the scene
  const GLOW = (() => {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d"), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, "rgba(255,255,255,1)"); grd.addColorStop(0.25, "rgba(255,255,255,.55)");
    grd.addColorStop(0.6, "rgba(255,255,255,.12)"); grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const glowSprite = (color, scale, opacity) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.scale.setScalar(scale); return s;
  };
  const softPoints = (geo, size, opacity, fog = true) => new THREE.Points(geo, new THREE.PointsMaterial({
    map: GLOW, size, vertexColors: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog }));

  // pastel star dust
  const STAR_TINTS = [0xbfe6ff, 0xd9ccff, 0xffe1c4, 0xffffff].map((h) => new THREE.Color(h));
  const starGeo = new THREE.BufferGeometry();
  const N = 2200, sp = new Float32Array(N * 3), sc = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 45 + Math.random() * 110, th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 2 - 1);
    sp.set([r * Math.sin(ph) * Math.cos(th), Math.abs(r * Math.cos(ph)) * 0.8 - 5, r * Math.sin(ph) * Math.sin(th)], i * 3);
    sc.set(STAR_TINTS[i % 4].toArray(), i * 3);
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(sc, 3));
  const stars = softPoints(starGeo, 1.1, 0.7, false);
  scene.add(stars);

  // dot-matrix floor with a slow swell running through it
  const FW = 90, FS = 1.3;
  const floorGeo = new THREE.BufferGeometry();
  const fp = new Float32Array(FW * FW * 3), fc = new Float32Array(FW * FW * 3);
  const floorTint = new THREE.Color(0x7dd3fc), floorTint2 = new THREE.Color(0xa5b4fc);
  for (let i = 0; i < FW; i++) for (let j = 0; j < FW; j++) {
    const k = (i * FW + j) * 3, x = (i - FW / 2) * FS, z = (j - FW / 2) * FS;
    fp.set([x, 0, z], k);
    fc.set(floorTint.clone().lerp(floorTint2, (Math.sin(x * 0.08) + 1) / 2).toArray(), k);
  }
  floorGeo.setAttribute("position", new THREE.BufferAttribute(fp, 3));
  floorGeo.setAttribute("color", new THREE.BufferAttribute(fc, 3));
  const floorPts = softPoints(floorGeo, 0.32, 0.55);
  floorPts.position.y = -3.6;
  scene.add(floorPts);

  // horizon made of the backtest's equity curve, drawn as soft particles
  const terrGeo = new THREE.PlaneGeometry(160, 40, 200, 24);
  terrGeo.rotateX(-Math.PI / 2);
  const tc = new Float32Array(terrGeo.attributes.position.count * 3);
  const terrTint = new THREE.Color(0xc4b5fd).toArray();
  for (let i = 0; i < terrGeo.attributes.position.count; i++) tc.set(terrTint, i * 3);
  terrGeo.setAttribute("color", new THREE.BufferAttribute(tc, 3));
  const terrain = softPoints(terrGeo, 0.42, 0.45);
  terrain.position.set(0, -3.4, -58);
  scene.add(terrain);
  function sculptTerrain(curve) {
    const pos = terrGeo.attributes.position;
    const vals = curve && curve.length ? curve.map((c) => c[1]) : null;
    const mx = vals ? Math.max(...vals) : 1, mn = vals ? Math.min(...vals) : 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const u = (x + 80) / 160;
      let h = 0;
      if (vals) h = ((vals[Math.min(vals.length - 1, Math.floor(u * vals.length))] - mn) / (mx - mn || 1)) * 14;
      const depth = (20 - z) / 40;
      h = h * depth + Math.sin(x * 0.3 + z * 0.4) * 0.6 * depth;
      pos.setY(i, Math.max(0, h));
    }
    pos.needsUpdate = true;
  }
  sculptTerrain(null);

  // allocation core: fresnel-lit orb inside a slowly turning geodesic point shell
  const core = new THREE.Group(); core.position.y = CORE_Y; scene.add(core);
  const heart = new THREE.Mesh(new THREE.SphereGeometry(0.95, 64, 64), new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x7dd3fc) }, uTime: { value: 0 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); vP = position; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){ float f = pow(1. - max(dot(vN, vV), 0.), 2.2);
        float bands = .5 + .5*sin(vP.y*18. + uTime*1.4);
        vec3 c = mix(uColor*.18, uColor, f) + uColor*bands*.07;
        gl_FragColor = vec4(c, .35 + f*.65); }`,
    transparent: true, depthWrite: false,
  }));
  core.add(heart);
  const heartGlow = glowSprite(0x7dd3fc, 5.5, 0.45);
  core.add(heartGlow);
  const shellGeo = new THREE.IcosahedronGeometry(1.45, 3);
  shellGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(shellGeo.attributes.position.count * 3).fill(0.85), 3));
  const shell = softPoints(shellGeo, 0.09, 0.8);
  core.add(shell);

  // HUD rings: dashed orbit + tick-marked dial
  function dashedRing(r, color, opacity, dash) {
    const pts = []; for (let i = 0; i <= 256; i++) { const a = (i / 256) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)); }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: dash, gapSize: dash * 0.8 }));
    line.computeLineDistances(); return line;
  }
  const halo1 = dashedRing(3.0, 0xbfe6ff, 0.45, 0.14);
  const halo2 = new THREE.Group();
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2, long = i % 6 === 0;
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.018, long ? 0.22 : 0.09),
      new THREE.MeshBasicMaterial({ color: 0xc4b5fd, transparent: true, opacity: long ? 0.6 : 0.3, side: THREE.DoubleSide }));
    tick.position.set(Math.cos(a) * 3.45, Math.sin(a) * 3.45, 0); tick.rotation.z = a - Math.PI / 2;
    halo2.add(tick);
  }
  halo1.rotation.x = Math.PI / 2 - 0.75; halo2.rotation.x = Math.PI / 2 - 0.75;
  core.add(halo1, halo2);
  const allocRing = new THREE.Group(); allocRing.rotation.x = Math.PI / 2 - 0.75; core.add(allocRing);

  function buildAllocation(weights) {
    while (allocRing.children.length) {
      const c = allocRing.children.pop();
      c.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    const entries = Object.entries(weights).filter(([, w]) => w > 0.002).sort((a, b) => b[1] - a[1]);
    const gap = 0.16; let a0 = 0;
    const total = entries.reduce((s, [, w]) => s + w, 0) || 1;
    const R = 2.2;
    for (const [sym, w] of entries) {
      const arc = Math.max(0.03, (w / total) * Math.PI * 2 - gap);
      const col = CLASS_HEX[CLASS[sym] || "safe"];
      const tube = 0.13 + 0.2 * Math.min(1, w * 2.5);
      const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.35, metalness: 0.1, roughness: 0.55 });
      const seg = new THREE.Group(); seg.rotation.z = a0;
      const body = new THREE.Mesh(new THREE.TorusGeometry(R, tube, 24, 96, arc), mat);
      body.userData = { kind: "alloc", sym, w };
      seg.add(body);
      for (const a of [0, arc]) { // rounded end caps: no hard edges anywhere on the ring
        const cap = new THREE.Mesh(new THREE.SphereGeometry(tube, 24, 16), mat);
        cap.position.set(Math.cos(a) * R, Math.sin(a) * R, 0); cap.userData = body.userData;
        seg.add(cap);
      }
      const g = glowSprite(col, 1.6 + w * 3, 0.22);
      g.position.set(Math.cos(arc / 2) * R, Math.sin(arc / 2) * R, 0);
      seg.add(g);
      allocRing.add(seg);
      a0 += arc + gap;
    }
  }

  // momentum orbit nodes
  const nodes = {}; const labelsEl = $("labels");
  function ensureNode(sym) {
    if (nodes[sym]) return nodes[sym];
    const col = CLASS_HEX[CLASS[sym]];
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.2, 32, 32), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.5, roughness: 0.5, transparent: true }));
    const glow = glowSprite(col, 1.5, 0.5);
    const ring = dashedRing(0.42, col, 0.8, 0.06);
    mesh.add(glow, ring); mesh.userData = { kind: "node", sym };
    scene.add(mesh);
    const lab = document.createElement("div"); lab.className = "node-label"; labelsEl.appendChild(lab);
    const n = { mesh, ring, glow, lab, radius: 5, target: 5, angle: Math.random() * Math.PI * 2, speed: 0.08 + Math.random() * 0.08, tilt: (Math.random() - 0.5) * 0.9, info: null };
    return (nodes[sym] = n);
  }
  function updateNodes(sig) {
    if (!sig || !sig.rotation) return;
    const ranked = Object.entries(sig.rotation).sort((a, b) => b[1].mom - a[1].mom);
    ranked.forEach(([sym, d], i) => {
      const n = ensureNode(sym); n.info = d;
      const eligible = d.mom > 0 && d.trend;
      n.target = d.picked ? 4.3 : eligible ? 5.5 : 6.8;
      n.mesh.scale.setScalar(0.6 + Math.min(0.8, Math.abs(d.mom) * 3));
      n.mesh.material.emissiveIntensity = d.picked ? 0.9 : eligible ? 0.45 : 0.1;
      n.mesh.material.opacity = eligible ? 1 : 0.45;
      n.glow.material.opacity = d.picked ? 0.75 : eligible ? 0.35 : 0.12;
      n.ring.visible = !!d.picked;
      n.lab.className = "node-label" + (d.picked ? " picked" : "");
      n.lab.innerHTML = `<b>${sym}</b><span>${fmtPct(d.mom)}</span><em>#${i + 1}</em>`;
    });
  }

  // soft ripples when trades print
  const waves = [];
  function shockwave(color) {
    const m = new THREE.Mesh(new THREE.RingGeometry(1, 1.25, 96), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = CORE_Y - 0.1; m.userData.t = 0;
    scene.add(m); waves.push(m);
  }

  // camera controls: drag orbit, idle drift, wall-mode cinematic
  let yaw = 0, pitch = 0.3, dist = 19, dragging = false, lastX = 0, lastY = 0, idle = 0;
  let mouseNX = 0, mouseNY = 0, camX = 0, camY = 0;
  canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; idle = 0; });
  addEventListener("pointerup", () => (dragging = false));
  addEventListener("pointermove", (e) => {
    mouseNX = e.clientX / innerWidth - 0.5; mouseNY = e.clientY / innerHeight - 0.5;
    if (!dragging) return;
    yaw -= (e.clientX - lastX) * 0.005; pitch = Math.max(-0.1, Math.min(0.9, pitch + (e.clientY - lastY) * 0.003));
    lastX = e.clientX; lastY = e.clientY; idle = 0;
  });
  addEventListener("wheel", (e) => { if (e.target === canvas) dist = Math.max(9, Math.min(26, dist + e.deltaY * 0.01)); }, { passive: true });

  // click to inspect
  const ray = new THREE.Raycaster(); const mv = new THREE.Vector2();
  let downAt = null;
  canvas.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
  canvas.addEventListener("click", (e) => {
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
    mv.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(mv, camera);
    const targets = Object.values(nodes).map((n) => n.mesh);
    allocRing.traverse((o) => { if (o.isMesh) targets.push(o); });
    const hits = ray.intersectObjects(targets, false);
    if (hits.length) inspect(hits[0].object.userData, e.clientX, e.clientY); else $("inspect").hidden = true;
  });

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    drawChart(); drawSpark();
  }
  addEventListener("resize", resize);

  const clock = new THREE.Clock(); const tmp = new THREE.Vector3();
  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    const wall = document.body.classList.contains("wall");
    const motion = reduceMotion ? 0.15 : 1;
    idle += dt;
    if (!dragging && idle > 4) yaw += dt * (wall ? 0.07 : 0.025) * motion;
    const p = wall ? 0.3 + Math.sin(t * 0.07) * 0.12 : pitch;
    const d = wall ? dist + Math.sin(t * 0.05) * 3 : dist;
    camX += (mouseNX - camX) * 0.04; camY += (mouseNY - camY) * 0.04; // eased parallax
    camera.position.set(Math.sin(yaw) * Math.cos(p) * d + camX * 1.4, CORE_Y + Math.sin(p) * d - camY * 0.9, Math.cos(yaw) * Math.cos(p) * d);
    camera.lookAt(0, CORE_Y - 2.2, 0);

    const fpos = floorGeo.attributes.position.array;
    for (let i = 0; i < fpos.length; i += 3) fpos[i + 1] = Math.sin(fpos[i] * 0.18 + t * 0.8 * motion) * Math.cos(fpos[i + 2] * 0.15 + t * 0.5 * motion) * 0.35;
    floorGeo.attributes.position.needsUpdate = true;
    stars.rotation.y = t * 0.004 * motion;
    heart.material.uniforms.uTime.value = t * motion;
    shell.rotation.y = t * 0.12 * motion; shell.rotation.x = t * 0.05 * motion;
    heartGlow.material.opacity = 0.38 + Math.sin(t * 1.6) * 0.08 * motion;
    halo1.rotation.z = t * 0.08 * motion; halo2.rotation.z = -t * 0.04 * motion;
    allocRing.rotation.z = t * 0.1 * motion;

    for (const n of Object.values(nodes)) {
      n.radius += (n.target - n.radius) * Math.min(1, dt * 1.2);
      n.angle += dt * n.speed * motion * (6 / n.radius);
      n.mesh.position.set(Math.cos(n.angle) * n.radius, CORE_Y + Math.sin(n.angle * 1.3) * n.tilt, Math.sin(n.angle) * n.radius);
      n.ring.lookAt(camera.position); n.ring.rotateZ(dt * 0.6);
      tmp.copy(n.mesh.position).project(camera);
      n.lab.style.opacity = tmp.z < 1 ? 1 : 0;
      n.lab.style.left = ((tmp.x + 1) / 2) * innerWidth + "px";
      n.lab.style.top = ((1 - tmp.y) / 2) * innerHeight + "px";
    }
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i]; w.userData.t += dt;
      const s = 1 + w.userData.t * 5; w.scale.set(s, s, s); w.material.opacity = Math.max(0, 0.5 * (1 - w.userData.t / 2.4));
      if (w.userData.t > 2.4) { scene.remove(w); w.geometry.dispose(); w.material.dispose(); waves.splice(i, 1); }
    }
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  /* ================================================================ HUD */
  function inspect(ud, x, y) {
    const box = $("inspect");
    let html = "";
    if (ud.kind === "node") {
      const d = nodes[ud.sym].info || {};
      const status = d.picked ? "HELD by rotation sleeve" : d.mom > 0 && d.trend ? "Eligible, not top 3" : "Filtered out (no trend or negative momentum)";
      html = `<h3>${esc(ud.sym)}</h3><div style="color:var(--ink-3)">${esc(d.desc || "")}</div>
        Blended momentum: <b class="${cls(d.mom)}">${fmtPct(d.mom || 0)}</b><br>
        Above 200-day avg: <b>${d.trend ? "Yes" : "No"}</b><br>
        Annualized vol: <b>${((d.vol || 0) * 100).toFixed(1)}%</b><br>
        <span style="color:var(--accent)">${status}</span>`;
    } else {
      const pos = (state && state.positions[ud.sym]) || 0;
      const px = state && state.quotes[ud.sym] ? state.quotes[ud.sym].price : 0;
      html = `<h3>${esc(ud.sym)}</h3><div style="color:var(--ink-3)">${esc((state && state.descriptions[ud.sym]) || "")}</div>
        Portfolio weight: <b>${(ud.w * 100).toFixed(1)}%</b><br>Shares: <b>${pos}</b> @ ${fmt$(px, 2)}<br>Value: <b>${fmt$(pos * px)}</b>`;
    }
    box.innerHTML = `<button class="x" aria-label="Close">✕</button>` + html;
    box.querySelector(".x").onclick = () => (box.hidden = true);
    box.style.left = Math.min(x + 16, innerWidth - 280) + "px";
    box.style.top = Math.min(y + 16, innerHeight - 200) + "px";
    box.hidden = false;
  }

  function setGauge(id, frac, text, color) {
    const g = $(id), arc = g.querySelector(".arc");
    arc.style.strokeDashoffset = 264 * (1 - Math.max(0, Math.min(1, frac)));
    if (color) arc.style.stroke = color;
    g.querySelector("b").textContent = text;
  }

  function prevClose(sym) { const q = state.quotes[sym]; return q && q.prev ? q.prev : q ? q.price : 0; }

  function render() {
    if (!state) return;
    const nav = state.equity, q = state.quotes;
    $("nav").textContent = fmt$(nav, 2);
    // day P&L = change since the last equity mark before today's midnight (New York)
    const todayNY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const before = (state.equity_log || []).filter(([ts]) => new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" }) < todayNY);
    const dayPL = nav - (before.length ? before[before.length - 1][1] : state.start_cash);
    const tot = nav / state.start_cash - 1;
    $("day-pl").className = "val " + cls(dayPL); $("day-pl").textContent = `${dayPL >= 0 ? "+" : "−"}${fmt$(Math.abs(dayPL))} (${fmtPct(dayPL / (nav - dayPL || 1), 2)})`;
    $("tot-pl").className = "val " + cls(tot); $("tot-pl").textContent = `${fmtPct(tot, 2)}`;

    // status pills
    const mo = marketOpen();
    $("mkt-pill").className = "pill " + (mo ? "on" : "off"); $("mkt-text").textContent = mo ? "Market open" : "Market closed";
    $("eng-pill").className = "pill " + (state.paused ? "off" : "on");
    $("eng-text").textContent = state.paused ? "Engine paused" : state.static ? "Engine scheduled" : "Engine live";
    if (state.static) { // hosted build: controls live in GitHub Actions, not on the public page
      $("btn-pause").hidden = $("btn-rebal").hidden = true;
      const c = $("btn-controls"); c.hidden = !state.controls_url; if (state.controls_url) c.href = state.controls_url;
    }
    $("btn-pause").textContent = state.paused ? "▶ Resume" : "⏸ Pause";

    // governor
    const gov = state.governor || {};
    const weights = {};
    for (const [s, sh] of Object.entries(state.positions)) if (q[s]) weights[s] = (sh * q[s].price) / nav;
    const cashW = state.cash / nav;
    const exposure = Object.entries(weights).reduce((a, [s, w]) => a + (s === "SHY" ? 0 : w), 0);
    setGauge("g-exposure", exposure, (exposure * 100).toFixed(0) + "%", "#7dd3fc");
    const pv = (gov.port_vol || 0) * (gov.scale || 1);
    setGauge("g-vol", pv / 0.24, (pv * 100).toFixed(1) + "%", pv > 0.12 ? "#fcd08a" : "#c4b5fd");
    const dd = Math.min(0, nav / Math.max(state.peak, nav) - 1);
    setGauge("g-dd", -dd / 0.2, (dd * 100).toFixed(1) + "%", dd < -0.1 ? "#fda4af" : "#86efac");
    const br = $("breaker");
    br.className = "breaker" + (gov.breaker ? " tripped" : "");
    br.innerHTML = gov.breaker ? "Drawdown breaker: <b>TRIPPED · risk halved</b>" : `Drawdown breaker: <b>ARMED</b> <span style="color:var(--ink-3)">(trips at −15%)</span>`;

    // log
    $("events").innerHTML = (state.events || []).slice().reverse().map(([t, m]) => `<li><time>${esc(t.slice(5, 16).replace("T", " "))}</time>${esc(m)}</li>`).join("");

    // positions
    const rows = Object.entries(weights).sort((a, b) => b[1] - a[1]);
    $("pos-count").textContent = `${rows.length} held · cash ${fmt$(state.cash)}`;
    $("positions").innerHTML = rows.length ? rows.map(([s, w]) => {
      const ch = q[s].price / prevClose(s) - 1;
      return `<tr><td><span class="sym">${s}</span><span class="d">${esc(state.descriptions[s] || "")}</span></td>
        <td>${state.positions[s]}</td><td>${fmt$(state.positions[s] * q[s].price)}</td>
        <td><span class="wbar" style="width:${Math.round(w * 60)}px"></span>${(w * 100).toFixed(1)}%</td>
        <td class="${cls(ch)}">${fmtPct(ch, 2)}</td></tr>`;
    }).join("") : `<tr><td colspan="5" class="empty">No positions yet. Engine is allocating…</td></tr>`;

    // momentum matrix
    const sig = state.signals || {};
    if (sig.rotation) {
      $("sig-asof").textContent = "as of " + sig.asof;
      const ranked = Object.entries(sig.rotation).sort((a, b) => b[1].mom - a[1].mom);
      const maxAbs = Math.max(0.05, ...ranked.map(([, d]) => Math.abs(d.mom)));
      $("matrix").innerHTML = ranked.map(([s, d]) => {
        const w = (Math.abs(d.mom) / maxAbs) * 50;
        const bar = d.mom >= 0 ? `left:50%;width:${w}%;background:var(--good)` : `right:50%;width:${w}%;background:var(--bad)`;
        return `<div class="sym ${d.picked ? "picked" : ""}" title="${esc(d.desc)}">${s}</div>
          <div class="mbar" title="Blended 1/3/6/12-month return"><span style="${bar}"></span></div>
          <div class="num ${cls(d.mom)}">${fmtPct(d.mom)}</div>
          <div class="trend ${d.trend ? "on" : "off"}" title="${d.trend ? "Above" : "Below"} 200-day average"></div>`;
      }).join("") + `<div class="matrix-foot">Highlighted = held. Dot = above 200-day trend line. Top 3 with both momentum &gt; 0 and trend are bought.</div>`;
      $("rsi").innerHTML = Object.entries(sig.meanrev).map(([s, d]) => `
        <div class="rsi-card"><div class="top"><b>${s}</b><span>RSI-2 ${d.rsi2.toFixed(1)}</span></div>
        <div class="rsi-scale" title="Buy zone: RSI-2 below 10"><div class="needle" style="left:calc(${Math.max(0, Math.min(100, d.rsi2))}% - 1px)"></div></div>
        <div class="state">${d.in_trade ? `<b>IN TRADE</b> · day ${d.days + 1} of max 10` : !d.above200 ? "Below 200-day avg · standing down" : d.rsi2 < 10 ? "<b>TRIGGER ZONE</b>" : "Waiting for a sharp pullback"}</div></div>`).join("");
    }

    // tape
    const trades = (state.trades || []).slice(-24).reverse();
    const quotes = Object.entries(q).map(([s, v]) => { const c = v.price / (v.prev || v.price) - 1; return `<span>${s} <b>${v.price.toFixed(2)}</b> <span class="${cls(c)}">${fmtPct(c, 2)}</span></span>`; });
    const tr = trades.map((t) => `<span><span class="${t.side === "BUY" ? "b" : "s"}">${t.side}</span> ${t.qty} ${t.sym} @ ${t.price.toFixed(2)} <span style="color:var(--ink-3)">${esc(t.time.slice(5, 16).replace("T", " "))} · ${esc(t.reason)}</span></span>`);
    const html = [...tr, ...quotes].join("");
    $("tape").innerHTML = html + html;

    // 3D
    const w3 = { ...weights }; if (cashW > 0.002) w3.SHY = (w3.SHY || 0) + cashW;
    buildAllocation(w3);
    updateNodes(sig);
    const dayColor = dayPL > 0 ? 0x86efac : dayPL < 0 ? 0xfda4af : 0x7dd3fc;
    heart.material.uniforms.uColor.value.setHex(dayColor); heartGlow.material.color.setHex(dayColor);

    // new trades -> shockwaves + toast
    const n = (state.trades || []).length;
    if (seenTrades !== null && n > seenTrades) {
      const fresh = state.trades.slice(seenTrades);
      fresh.slice(-6).forEach((t, i) => setTimeout(() => shockwave(t.side === "BUY" ? 0x86efac : 0xfda4af), i * 250));
      toast(`${fresh.length} new fill${fresh.length > 1 ? "s" : ""}: ${fresh.slice(-3).map((t) => `${t.side} ${t.sym}`).join(", ")}`);
    }
    seenTrades = n;
    if (view === "live") drawChart();
    drawSpark(); telemetry();
  }

  function marketOpen() { // regular session, New York time (holidays show as open but flat)
    const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const m = ny.getHours() * 60 + ny.getMinutes();
    return ny.getDay() > 0 && ny.getDay() < 6 && m >= 570 && m < 960;
  }

  function drawSpark() {
    const cv = $("spark"); if (!cv || !state) return;
    const { ctx, w, h } = sizeCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const vals = (state.equity_log || []).slice(-360).map((r) => r[1]);
    if (vals.length < 2) { ctx.strokeStyle = "rgba(125,211,252,.35)"; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke(); ctx.setLineDash([]); return; }
    const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
    const X = (i) => (i / (vals.length - 1)) * w, Y = (v) => h - 3 - ((v - mn) / rng) * (h - 6);
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, "rgba(125,211,252,.28)"); g.addColorStop(1, "rgba(125,211,252,0)");
    ctx.beginPath(); vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
    ctx.strokeStyle = "#7dd3fc"; ctx.lineWidth = 1.5; ctx.lineJoin = ctx.lineCap = "round"; ctx.stroke();
    ctx.fillStyle = "#e6f1ff"; ctx.beginPath(); ctx.arc(X(vals.length - 1), Y(vals[vals.length - 1]), 2.5, 0, Math.PI * 2); ctx.fill();
  }

  function telemetry() {
    if (!state) return;
    const spy = state.quotes && state.quotes.SPY;
    const age = spy && spy.time ? (Date.now() / 1000 - spy.time) : null;
    const open = marketOpen();
    if (state.static) {
      const mins = Math.max(0, Math.round((Date.now() / 1000 - state.updated) / 60));
      const fresh = mins <= 35;
      $("t-feed").textContent = !spy ? "NO DATA" : open ? (fresh ? "SNAPSHOT · 15 MIN" : "STALE") : "IDLE · MKT CLOSED";
      $("t-feed").parentElement.className = "tchip " + (!spy ? "bad" : open && fresh ? "good" : "");
      $("t-lat").previousSibling.textContent = "Updated ";
      $("t-lat").textContent = mins < 60 ? mins + "m ago" : mins < 2880 ? Math.round(mins / 60) + "h ago" : Math.round(mins / 1440) + "d ago";
    } else {
      $("t-feed").textContent = !spy ? "NO DATA" : open ? (age < 180 ? "STREAMING" : "DELAYED") : "IDLE · MKT CLOSED";
      $("t-feed").parentElement.className = "tchip " + (!spy ? "bad" : open && age < 180 ? "good" : "");
      $("t-lat").textContent = latency == null ? "—" : Math.round(latency) + " ms";
    }
    $("t-pts").textContent = (state.equity_log || []).length.toLocaleString();
    $("t-fills").textContent = (state.trades || []).length;
  }

  /* ================================================================ CHART */
  const chartEl = $("chart"), ddEl = $("ddchart"), tip = $("tip");
  let series = null; // {x:[labels], lines:[{name,color,vals}], dd:[{name,color,vals}], log:bool}
  let hoverI = null;

  function buildSeries() {
    if (view === "live") {
      const log = (state && state.equity_log) || [];
      const start = state ? state.start_cash : 100000;
      let pk = start; const dd = log.map(([, e]) => { pk = Math.max(pk, e); return e / pk - 1; });
      return { x: log.map(([ts]) => new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })),
        lines: [{ name: "Paper account", color: SERIES.aegis, vals: log.map(([, e]) => e) }], dd: [{ name: "Paper account", color: SERIES.aegis, vals: dd }],
        log: false, money: true };
    }
    if (!backtest) return null;
    const c = backtest.curve;
    let ps = 0;
    const ddS = c.map((r) => { ps = Math.max(ps, r[3]); return r[3] / ps - 1; });
    return { x: c.map((r) => r[0]),
      lines: [{ name: "AEGIS", color: SERIES.aegis, vals: c.map((r) => r[1]) }, { name: "S&P 500 (SPY)", color: SERIES.spy, vals: c.map((r) => r[3]) }],
      dd: [{ name: "AEGIS", color: SERIES.aegis, vals: c.map((r) => r[2]) }, { name: "S&P 500 (SPY)", color: SERIES.spy, vals: ddS }],
      log: true, money: false };
  }

  function sizeCanvas(cv) {
    const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height };
  }
  const PAD = { l: 64, r: 96, t: 8, b: 18 };

  function drawLines(cv, lines, opts) {
    const { ctx, w, h } = sizeCanvas(cv);
    ctx.clearRect(0, 0, w, h);
    const n = lines[0].vals.length;
    if (n < 2) {
      ctx.fillStyle = "#62748c"; ctx.font = "12px JetBrains Mono"; ctx.textAlign = "center";
      ctx.fillText(opts.empty || "Collecting data…", w / 2, h / 2); return null;
    }
    const tf = opts.log ? Math.log : (v) => v;
    let mn = Infinity, mx = -Infinity;
    for (const l of lines) for (const v of l.vals) { const y = tf(v); if (y < mn) mn = y; if (y > mx) mx = y; }
    if (opts.zeroTop) mx = 0;
    if (mx - mn < 1e-9) { mx += 0.5; mn -= 0.5; }
    const pr = (mx - mn) * 0.06; if (!opts.zeroTop) mx += pr; mn -= pr;
    const X = (i) => PAD.l + (i / (n - 1)) * (w - PAD.l - PAD.r);
    const Y = (v) => PAD.t + (1 - (tf(v) - mn) / (mx - mn)) * (h - PAD.t - PAD.b);

    // recessive grid + axis labels
    ctx.font = "10px JetBrains Mono"; ctx.fillStyle = "#7a88a8"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    const ticks = opts.ticks(mn, mx);
    for (const tv of ticks) {
      const y = Y(tv); if (y < PAD.t - 1 || y > h - PAD.b + 1) continue;
      ctx.strokeStyle = "rgba(180,200,255,0.09)"; ctx.lineWidth = 1; ctx.setLineDash([2, 5]); ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillText(opts.fmtY(tv, opts.log ? 0 : mx - mn), PAD.l - 8, y);
    }
    if (opts.xLabels) {
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const k = Math.max(1, Math.floor(n / 6));
      for (let i = 0; i < n; i += k) ctx.fillText(opts.xLabels[i].slice(0, opts.xTrim || 99), X(i), h - PAD.b + 4);
    }

    // lines (back to front, AEGIS on top)
    for (let li = lines.length - 1; li >= 0; li--) {
      const l = lines[li];
      if (opts.area) {
        ctx.beginPath(); ctx.moveTo(X(0), Y(opts.zeroTop ? 0 : l.vals[0]));
        l.vals.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
        ctx.lineTo(X(n - 1), Y(opts.zeroTop ? 0 : l.vals[n - 1])); ctx.closePath();
        ctx.fillStyle = l.color + (li === 0 ? "40" : "22"); ctx.fill();
      }
      if (!opts.area && li === 0) { // soft gradient wash under the primary series
        const g = ctx.createLinearGradient(0, PAD.t, 0, h - PAD.b);
        g.addColorStop(0, l.color + "38"); g.addColorStop(1, l.color + "00");
        ctx.beginPath(); l.vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
        ctx.lineTo(X(n - 1), h - PAD.b); ctx.lineTo(X(0), h - PAD.b); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
      }
      ctx.beginPath(); l.vals.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v))));
      ctx.lineCap = "round"; ctx.strokeStyle = l.color; ctx.lineWidth = 2; ctx.lineJoin = "round";
      ctx.shadowColor = l.color; ctx.shadowBlur = li === 0 ? 14 : 0; ctx.stroke(); ctx.shadowBlur = 0;
      // direct end label
      if (opts.endLabels) {
        const yv = Y(l.vals[n - 1]);
        ctx.fillStyle = l.color; ctx.beginPath(); ctx.arc(X(n - 1), yv, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#e6f1ff"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = "11px JetBrains Mono";
        ctx.fillText(opts.fmtEnd(l, l.vals[n - 1]), X(n - 1) + 8, yv + (li === 0 ? -7 : 7));
      }
    }
    // crosshair
    if (hoverI !== null && hoverI < n) {
      const x = X(hoverI);
      ctx.strokeStyle = "rgba(230,241,255,0.3)"; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, PAD.t); ctx.lineTo(x, h - PAD.b); ctx.stroke(); ctx.setLineDash([]);
      for (const l of lines) { ctx.fillStyle = l.color; ctx.strokeStyle = "#11172b"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, Y(l.vals[hoverI]), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    }
    return { X, n, w };
  }

  function niceTicks(mn, mx, log) {
    if (log) {
      const out = []; const lo = Math.exp(mn), hi = Math.exp(mx);
      for (const v of [0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 15, 20]) if (v >= lo && v <= hi) out.push(v);
      return out;
    }
    const span = mx - mn, step = Math.pow(10, Math.floor(Math.log10(span / 4)));
    const st = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => span / s <= 5);
    const out = []; for (let v = Math.ceil(mn / st) * st; v <= mx; v += st) out.push(v); return out;
  }

  let geo = null;
  function drawChart() {
    series = buildSeries();
    const leg = $("chart-legend");
    if (!series) { leg.innerHTML = ""; return; }
    leg.innerHTML = series.lines.map((l) => `<span><i style="--c:${l.color}"></i>${l.name}</span>`).join("") +
      `<span style="color:var(--ink-3)">${series.log ? "growth of $1 · log scale" : ""}</span>`;
    geo = drawLines(chartEl, series.lines, {
      log: series.log, endLabels: true, xLabels: series.x, xTrim: series.log ? 4 : 13,
      empty: "Live paper curve starts collecting now: one point per minute while the engine runs",
      ticks: (a, b) => niceTicks(a, b, series.log),
      fmtY: (v, span) => (series.money ? (span < 5000 ? fmt$(v) : "$" + (v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : (v / 1e3).toFixed(1) + "k")) : "$" + v.toFixed(v < 2 ? 2 : 1)),
      fmtEnd: (l, v) => (series.money ? fmt$(v) : `${l.name.split(" ")[0]} $${v.toFixed(2)}`),
    });
    drawLines(ddEl, series.dd, {
      area: true, zeroTop: true, ticks: (a) => { const s = a < -0.3 ? 0.2 : a < -0.1 ? 0.1 : 0.02; const o = []; for (let v = 0; v >= a; v -= s) o.push(+v.toFixed(3)); return o; },
      fmtY: (v) => (v * 100).toFixed(0) + "%", endLabels: false, empty: " ",
    });
    ddEl.getContext("2d").fillStyle = "#62748c";
    if (!$("chart-table").hidden) renderTable();
  }

  function hover(e) {
    if (!geo || !series) return;
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left - PAD.l) / (r.width - PAD.l - PAD.r);
    if (fx < 0 || fx > 1) return leave();
    hoverI = Math.round(fx * (geo.n - 1));
    drawChart();
    const rows = series.lines.map((l, k) => `<div><span class="sw" style="background:${l.color}"></span>${l.name}: <b>${series.money ? fmt$(l.vals[hoverI], 2) : "$" + l.vals[hoverI].toFixed(2)}</b> · drawdown ${fmtPct(series.dd[k].vals[hoverI])}</div>`).join("");
    tip.innerHTML = `<div style="color:var(--ink-3)">${esc(series.x[hoverI])}</div>${rows}`;
    tip.style.display = "block";
    const wrap = chartEl.parentElement.getBoundingClientRect();
    let left = e.clientX - wrap.left + 14; if (left + tip.offsetWidth > wrap.width) left -= tip.offsetWidth + 28;
    tip.style.left = left + "px"; tip.style.top = Math.max(0, e.clientY - wrap.top - 20) + "px";
  }
  function leave() { hoverI = null; tip.style.display = "none"; drawChart(); }
  [chartEl, ddEl].forEach((c) => { c.addEventListener("pointermove", hover); c.addEventListener("pointerleave", leave); });

  function renderTable() {
    if (!series) return;
    const step = Math.max(1, Math.floor(series.x.length / 250));
    let h = `<table><thead><tr><th style="text-align:left">Date</th>${series.lines.map((l) => `<th>${l.name}</th><th>Drawdown</th>`).join("")}</tr></thead><tbody>`;
    for (let i = series.x.length - 1; i >= 0; i -= step)
      h += `<tr><td style="text-align:left">${esc(series.x[i])}</td>${series.lines.map((l, k) => `<td>${series.money ? fmt$(l.vals[i], 2) : l.vals[i].toFixed(3)}</td><td>${fmtPct(series.dd[k].vals[i])}</td>`).join("")}</tr>`;
    $("chart-table").innerHTML = h + "</tbody></table>";
  }
  $("btn-table").onclick = () => { const t = $("chart-table"); t.hidden = !t.hidden; $("btn-table").textContent = t.hidden ? "Table" : "Chart"; if (!t.hidden) renderTable(); };
  document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    view = b.dataset.view; hoverI = null; drawChart();
  }));

  /* ================================================================ DOSSIER */
  function dossier() {
    const b = backtest;
    if (!b) { $("dossier-body").textContent = "Backtest not found. Run: .venv/bin/python aegis/backtest.py"; return; }
    const cols = [["cagr", "Annual return", 1], ["vol", "Volatility", 1], ["sharpe", "Sharpe", 0], ["sortino", "Sortino", 0], ["max_dd", "Max drawdown", 1], ["calmar", "Calmar", 0], ["pct_up_months", "Up months", 1], ["worst_year", "Worst year", 1]];
    const tbl = (blk) => `<table class="stats"><thead><tr><th></th>${cols.map((c) => `<th>${c[1]}</th>`).join("")}</tr></thead><tbody>${
      Object.entries(blk).map(([name, s]) => `<tr class="${name === "AEGIS" ? "aegis" : ""}"><td>${esc(name)}</td>${cols.map(([k, , pct]) => `<td>${pct ? fmtPct(s[k]) : s[k].toFixed(2)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    const yrs = Object.entries(b.yearly.AEGIS).map(([y, v]) => `<div><b>${y}</b><span class="${cls(v)}">${fmtPct(v)}</span> <span style="color:var(--ink-3)">vs ${fmtPct(b.yearly.SPY[y] || 0)}</span></div>`).join("");
    $("dossier-body").innerHTML = `
      <p>AEGIS combines three independent, well-documented market effects and a risk governor. Every parameter is a textbook default fixed <i>before</i> the backtest was run; nothing was tuned to make this history look good.</p>
      <h3>How it decides</h3>
      <p><b>1 · Momentum rotation (80%)</b>: on the first trading day of each month, rank 10 asset-class ETFs by their average 1/3/6/12-month return. Hold the top 3 that also trade above their 200-day average, weighted so each contributes similar risk. Empty slots park in short Treasuries (SHY).<br>
      <b>2 · Pullback reversion (20%)</b>: when SPY or QQQ has a 2-day RSI below 10 while above its 200-day average, buy. Sell on a close above the 5-day average or after 10 days.<br>
      <b>3 · Governor</b>: shrink the risky book so forecast volatility ≤ 12%/yr (never leveraged). If the account falls 15% from its peak, halve risk until it recovers to within 8%.</p>
      <h3>Full history · ${b.period[0]} → ${b.period[1]}</h3>${tbl(b.full)}
      <h3>Before ${b.oos_start} (in-sample)</h3>${tbl(b.in_sample)}
      <h3>${b.oos_start} → today (out-of-sample)</h3>${tbl(b.out_of_sample)}
      <div class="note"><b>Honest read.</b> AEGIS's edge is <i>survival</i>, not outperformance: it cut the worst loss from −55% to about −19% and was positive in 2008. But over 2017 onward, a plain S&amp;P 500 index fund and a 60/40 portfolio both earned more per unit of risk. Trend systems lag in long, calm bull markets and earn their keep in crashes. Costs assumed: ${b.cost_bps} bps per trade. ${b.trades_per_year} trades/yr. Average exposure to risk assets: ${(b.avg_exposure * 100).toFixed(0)}%.</div>
      <h3>Calendar years · AEGIS vs SPY</h3><div class="years">${yrs}</div>
      <h3>Rules of engagement</h3>
      <p>Paper trading only: real prices, simulated money. A backtest is not a forecast. Run this for months, compare the live curve with the backtest, and only then decide what, if anything, to do with real capital.</p>`;
  }
  $("btn-dossier").onclick = () => { dossier(); $("dossier").hidden = false; };
  $("dossier-close").onclick = () => ($("dossier").hidden = true);
  $("dossier").onclick = (e) => { if (e.target.id === "dossier") $("dossier").hidden = true; };
  addEventListener("keydown", (e) => { if (e.key === "Escape") { $("dossier").hidden = true; $("inspect").hidden = true; } });

  /* ================================================================ CONTROLS */
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 4000); }
  async function post(action, btn) {
    if (btn) btn.disabled = true;
    try { const r = await fetch("/api/" + action, { method: "POST" }).then((r) => r.json()); toast(r.message || "Done"); await poll(); }
    catch (e) { toast("Engine unreachable: " + e.message); }
    finally { if (btn) btn.disabled = false; }
  }
  $("btn-pause").onclick = (e) => post(state && state.paused ? "resume" : "pause", e.currentTarget);
  $("btn-rebal").onclick = (e) => { toast("Running full strategy evaluation…"); post("rebalance", e.currentTarget); };
  $("btn-wall").onclick = async () => {
    const on = !document.body.classList.contains("wall");
    document.body.classList.toggle("wall", on);
    try { if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen(); else if (!on && document.fullscreenElement) await document.exitFullscreen(); } catch (_) {}
    toast(on ? "Wall mode: cinematic camera on. Press W or Esc to exit." : "Wall mode off");
  };
  addEventListener("keydown", (e) => { if (e.key.toLowerCase() === "w" && !e.metaKey && !e.ctrlKey) $("btn-wall").click(); });
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) document.body.classList.remove("wall"); });

  function tickClock() {
    $("clock").textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });
    // countdown to the next 15:45 New York evaluation (weekdays)
    const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const next = new Date(ny); next.setHours(15, 45, 0, 0);
    if (ny >= next) next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    const s = Math.floor((next - ny) / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    $("t-next").textContent = hh > 23 ? `${Math.floor(hh / 24)}d ${hh % 24}h ${String(mm).padStart(2, "0")}m` : [hh, mm, ss].map((x) => String(x).padStart(2, "0")).join(":");
    const up = Math.floor((Date.now() - bootAt) / 1000);
    $("t-up").textContent = `${Math.floor(up / 3600)}h ${String(Math.floor((up % 3600) / 60)).padStart(2, "0")}m`;
  }
  setInterval(tickClock, 1000); tickClock();

  /* ================================================================ DATA */
  async function poll() {
    const t0 = performance.now();
    try { state = await fetch("data/state.json?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json()); latency = performance.now() - t0; render(); }
    catch (e) { $("eng-pill").className = "pill off"; $("eng-text").textContent = "Engine offline"; }
  }
  async function loadBacktest() {
    try { backtest = await fetch("data/backtest.json?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json()); if (backtest) sculptTerrain(backtest.curve); if (view === "bt") drawChart(); } catch (_) {}
  }

  resize();
  requestAnimationFrame(tick);
  loadBacktest();
  poll();
  (function loop() { setTimeout(() => poll().finally(loop), state && state.static ? 60000 : 5000); })();
})();
