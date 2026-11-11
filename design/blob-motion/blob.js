/* Blob, the living presence. Shared by the motion prototypes in this folder.
 * createBlob(svg, halo, at) returns { st, set, reset, tick, render, pos }.
 * Everything that moves runs on springs, so any target can change mid-move. */
(function () {
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (c1, c2, t) => c1.map((v, i) => Math.round(lerp(v, c2[i], t)));
  const hex = (c) =>
    "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

  class Spring {
    constructor(v, k = 170, d = 26) {
      this.x = v;
      this.vel = 0;
      this.target = v;
      this.k = k;
      this.d = d;
    }
    step(dt) {
      const f = -this.k * (this.x - this.target) - this.d * this.vel;
      this.vel += f * dt;
      this.x += this.vel * dt;
    }
    set(v) {
      this.x = v;
      this.target = v;
      this.vel = 0;
    }
  }

  const INK = [
    [90, 90, 90],
    [35, 35, 35],
    [20, 20, 20],
  ];
  const SKY = [
    [93, 178, 227],
    [29, 130, 188],
    [21, 106, 156],
  ];
  // energy: how lively the outline is · open: eyes · smile: eyes as arcs · halo · sky: colour
  const MODES = {
    quiet: { energy: 0.25, open: 0, smile: 0, halo: 0, sky: 0 },
    listen: { energy: 0.6, open: 1, smile: 0, halo: 1, sky: 0 },
    think: { energy: 0.8, open: 1, smile: 0, halo: 0, sky: 0 },
    speak: { energy: 1, open: 1, smile: 1, halo: 0, sky: 0 },
    you: { energy: 0.5, open: 1, smile: 0, halo: 0.6, sky: 1 },
    draw: { energy: 0.45, open: 1, smile: 0, halo: 0, sky: 0 },
  };

  function createBlob(svg, halo, at) {
    const $ = (id) => svg.querySelector("#" + id);
    // tilt: degrees, for hinge effects · typing: no halo, as in the app, so
    // the ring doesn't sit behind Blob for every keystroke.
    const st = {
      mode: "quiet",
      at,
      look: null,
      reduce: false,
      tilt: 0,
      typing: false,
    };
    const sp = {
      x: new Spring(at.x, 120, 17),
      y: new Spring(at.y, 120, 17),
      size: new Spring(at.size, 140, 20),
      sky: new Spring(0, 90, 18),
      open: new Spring(0, 220, 24),
      smile: new Spring(0, 200, 24),
      lookX: new Spring(0, 260, 22),
      lookY: new Spring(0, 260, 22),
      energy: new Spring(0.25, 60, 14),
      halo: new Spring(0, 140, 20),
      pulse: new Spring(1, 300, 14),
    };
    let t = 0,
      seed = 7,
      blinkAt = 2.2,
      blinkT = -1,
      env = 0;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

    function apply() {
      const m = MODES[st.mode];
      sp.sky.target = m.sky;
      sp.open.target = m.open;
      sp.smile.target = m.smile;
      sp.energy.target = m.energy;
      sp.halo.target = st.typing ? 0 : m.halo;
      sp.x.target = st.at.x;
      sp.y.target = st.at.y;
      sp.size.target = st.at.size;
    }
    function set(p) {
      const was = st.mode;
      Object.assign(st, p);
      if (st.mode === "you" && was !== "you") {
        sp.pulse.x = 1;
        sp.pulse.vel = 2.2;
      } // one soft pop, then still
      apply();
    }
    function reset(p) {
      t = 0;
      seed = 7;
      blinkAt = 2.2;
      blinkT = -1;
      env = 0;
      Object.assign(st, { mode: "quiet", look: null }, p);
      apply();
      for (const k in sp) sp[k].set(sp[k].target);
      sp.pulse.set(1);
    }

    function step(dt) {
      t += dt;
      for (const k in sp) sp[k].step(dt);
      // random blinks every 2.5 to 6 s, 140 ms each
      if (t > blinkAt && st.mode !== "quiet") {
        blinkT = 0;
        blinkAt = t + 2.5 + rand() * 3.5;
      }
      if (blinkT >= 0) {
        blinkT += dt;
        if (blinkT > 0.14) blinkT = -1;
      }
      // speech envelope: syllable-like bursts while speaking, voice level while listening
      const talking = st.mode === "speak" || st.mode === "listen";
      const target = talking
        ? clamp(
            0.45 +
              0.35 * Math.sin(t * 11) * Math.sin(t * 3.7) +
              0.2 * Math.sin(t * 23),
            0,
            1,
          )
        : 0;
      env = lerp(env, target, 1 - Math.exp(-dt * 18));
      // eyes: a look target wins, thinking glances up and right, listening looks up
      let lx = 0,
        ly = 0;
      if (st.mode === "think") {
        lx = 9 + 3 * Math.sign(Math.sin(t * 1.7));
        ly = -9;
      } else if (st.mode === "listen") ly = -4;
      if (st.look) {
        const dx = st.look.x - sp.x.x,
          dy = st.look.y - sp.y.x,
          m = Math.hypot(dx, dy) || 1;
        const reach = clamp(m / 60, 0, 1); // close targets get a softer glance
        lx = (dx / m) * 12 * reach;
        ly = (dy / m) * 10 * reach;
      }
      sp.lookX.target = lx;
      sp.lookY.target = ly;
    }
    function tick(dt) {
      const n = Math.max(1, Math.ceil(dt / (1 / 240)));
      for (let i = 0; i < n; i++) step(dt / n);
    }

    function outline(energy, speech) {
      const pts = [],
        N = 40;
      const a2 = 0.035 * energy + 0.05 * speech,
        a3 = 0.025 * energy + 0.03 * speech,
        a4 = 0.012 * energy;
      for (let i = 0; i < N; i++) {
        const th = (i / N) * Math.PI * 2;
        const r =
          80 *
          (1 +
            a2 * Math.sin(2 * th + t * 0.9) +
            a3 * Math.sin(3 * th - t * 1.3 + 1.2) +
            a4 * Math.sin(4 * th + t * 2.1 + 0.4));
        pts.push([100 + r * Math.cos(th), 100 + r * Math.sin(th)]);
      }
      let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
      for (let i = 0; i < N; i++) {
        const p0 = pts[(i - 1 + N) % N],
          p1 = pts[i],
          p2 = pts[(i + 1) % N],
          p3 = pts[(i + 2) % N];
        d +=
          `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ` +
          `${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
      }
      return d + "Z";
    }

    function render() {
      const reduce = st.reduce,
        size = sp.size.x;
      const vx = reduce ? 0 : sp.x.vel,
        vy = reduce ? 0 : sp.y.vel;
      const stretch = 1 + clamp(Math.hypot(vx, vy) / 2600, 0, 0.22); // stretch along travel
      const angle = (Math.atan2(vy, vx) * 180) / Math.PI;
      const breathe = reduce
        ? 1
        : 1 + 0.018 * Math.sin(t * (st.mode === "quiet" ? 1.4 : 2.2));
      const s =
        (size / 200) *
        breathe *
        (reduce ? 1 : sp.pulse.x) *
        (reduce ? 1 : 1 + 0.035 * env);
      svg.style.transform = `translate(${sp.x.x - 100}px, ${sp.y.x - 100}px) rotate(${reduce ? 0 : st.tilt}deg) scale(${s}) rotate(${angle}deg) scale(${stretch}, ${1 / stretch}) rotate(${-angle}deg)`;

      $("shape").setAttribute(
        "d",
        outline(reduce ? 0 : sp.energy.x, reduce ? 0 : env),
      );
      const c = [0, 1, 2].map((i) =>
        hex(mix(INK[i], SKY[i], clamp(sp.sky.x, 0, 1))),
      );
      $("s0").setAttribute("stop-color", c[0]);
      $("s1").setAttribute("stop-color", c[1]);
      $("s2").setAttribute("stop-color", c[2]);

      // eyes close into the smile: ovals shrink over the first half, arcs grow over the second
      const blink = blinkT >= 0 ? Math.sin((blinkT / 0.14) * Math.PI) : 0;
      const open = clamp(sp.open.x, 0, 1.1) * (1 - blink);
      const smile = clamp(sp.smile.x, 0, 1);
      const ex = sp.lookX.x,
        ey = sp.lookY.x;
      const ry = Math.max(
        0.6,
        14 * open * (st.mode === "you" ? 1.2 : 1) * clamp(1 - smile * 2, 0, 1),
      );
      for (const [id, cx] of [
        ["eyeL", 82],
        ["eyeR", 124],
      ]) {
        const e = $(id);
        e.setAttribute("cx", cx + ex);
        e.setAttribute("cy", 100 + ey);
        e.setAttribute("ry", ry);
        e.setAttribute("opacity", ry > 1 && open > 0.06 ? 1 : 0);
      }
      const curve = lerp(10, -14, smile); // + sleepy lid, - smile
      const arcOpacity = Math.max(
        clamp(smile * 2 - 1, 0, 1),
        open < 0.06 ? 1 : 0,
      );
      for (const [id, cx] of [
        ["smileL", 82],
        ["smileR", 124],
      ]) {
        const p = $(id);
        p.setAttribute(
          "d",
          `M${cx - 12 + ex},${104 + ey} Q${cx + ex},${104 + ey + curve} ${cx + 12 + ex},${104 + ey}`,
        );
        p.setAttribute("opacity", arcOpacity);
        p.setAttribute("stroke-width", lerp(6, 8, smile));
      }

      if (halo) {
        // A soft ring just outside the body (radius 0.4 of size), at most
        // 1.3 times its radius.
        const hs =
          (size / 200) *
          (0.98 + (reduce ? 0 : 0.06 * env * (st.mode === "listen" ? 1 : 0)));
        halo.style.transform = `translate(${sp.x.x - 100}px, ${sp.y.x - 100}px) scale(${hs})`;
        halo.style.opacity = clamp(sp.halo.x, 0, 1.2);
        halo.style.background =
          sp.sky.x > 0.5 ? "rgb(29 130 188 / 12%)" : "rgb(0 0 0 / 4.5%)";
      }
    }

    apply();
    return {
      st,
      set,
      reset,
      tick,
      render,
      get pos() {
        return { x: sp.x.x, y: sp.y.x };
      },
    };
  }

  window.createBlob = createBlob;
})();
