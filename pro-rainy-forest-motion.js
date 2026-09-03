// One shared canvas loop renders physically-linked rain and pond impacts for
// every rainy-forest nameplate. The base artwork stays completely still.
import { ProMotionGate } from "./pro-motion-gate.js?v=1";

export const ProRainyForestMotion = (() => {
  const rigs = new Set();
  let frame = 0;
  let lastFrame = 0;
  const motionQuery = typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)") : null;

  const between = (min, max) => min + Math.random() * (max - min);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  // Impact area spans the full photoreal pond. The irregular render clip below
  // trims the few oval corners that fall over the muddy bank.
  const pondEllipse = (width, height) => ({
    x: width * .45,
    y: height * .55,
    radiusX: width * .3,
    radiusY: height * .29,
  });

  // The pond itself is not a perfect ellipse. This path follows the waterline
  // of rainy-forest-photoreal-v8 after the artwork is mirrored in the strip.
  const tracePondSurface = (ctx, width, height) => {
    ctx.beginPath();
    ctx.moveTo(width * .22, height * .25);
    ctx.bezierCurveTo(width * .33, height * .16, width * .51, height * .14, width * .63, height * .2);
    ctx.bezierCurveTo(width * .72, height * .24, width * .76, height * .37, width * .75, height * .5);
    ctx.bezierCurveTo(width * .73, height * .65, width * .62, height * .77, width * .47, height * .81);
    ctx.bezierCurveTo(width * .32, height * .82, width * .21, height * .73, width * .17, height * .57);
    ctx.bezierCurveTo(width * .14, height * .43, width * .16, height * .32, width * .22, height * .25);
    ctx.closePath();
  };

  const makeDrop = (width, height, initial = false) => {
    const depth = Math.pow(Math.random(), .9);
    const pond = pondEllipse(width, height);
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * .94;
    const impactX = pond.x + Math.cos(angle) * pond.radiusX * radius;
    const impactY = pond.y + Math.sin(angle) * pond.radiusY * radius;
    const speed = height * (.8 + depth * .95);
    const slant = between(-.012, .012);
    const wind = speed * slant * .08;
    const length = clamp(height * (.035 + depth * .035), 2.5, 5);
    const y = initial
      ? between(-height * 1.25, impactY - length - 1)
      : between(-height * 1.35, -height * .28);
    const travelTime = Math.max(0, (impactY - y - length) / speed);
    return {
      x: impactX - wind * travelTime,
      y,
      impactX,
      impactY,
      depth,
      speed,
      wind,
      length,
      width: .52 + depth * .3,
      alpha: Math.min(.76, .4 + depth * .3 + Math.random() * .035),
      slant,
    };
  };

  const makeState = () => ({ width: 0, height: 0, dpr: 1, drops: [], splashes: [] });

  const resizeCanvas = (canvas, state) => {
    const width = Math.max(44, Math.round(canvas.clientWidth || 90));
    const height = Math.max(22, Math.round(canvas.clientHeight || 36));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 1.6);
    if (state.width === width && state.height === height && state.dpr === dpr) return;
    state.width = width;
    state.height = height;
    state.dpr = dpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    state.drops = Array.from({ length: window.__perfMode ? 14 : 20 }, () =>
      makeDrop(width, height, true));
    state.splashes.length = 0;
  };

  const spawnSplash = (state, x, y, strength) => {
    const droplets = Array.from({ length: 4 + Math.round(strength * 3) }, () => ({
      angle: between(0, Math.PI * 2),
      distance: between(2.5, 5.5) * (.72 + strength * .42),
      size: between(.28, .58) * (.78 + strength * .26),
      phase: between(.82, 1.08),
    }));
    state.splashes.push({
      x,
      y,
      age: 0,
      life: between(.82, 1.08) * (.92 + strength * .12),
      strength,
      droplets,
      rotation: between(0, Math.PI * 2),
      squash: between(.88, .98),
      stagger: between(-.16, .16),
    });
    if (state.splashes.length > 12) state.splashes.shift();
  };

  const update = (state, delta) => {
    state.drops.forEach((drop, index) => {
      drop.y += drop.speed * delta;
      drop.x += drop.wind * delta;
      if (drop.y + drop.length >= drop.impactY) {
        spawnSplash(state, drop.impactX, drop.impactY, drop.depth);
        state.drops[index] = makeDrop(state.width, state.height);
      }
    });
    state.splashes.forEach((splash) => { splash.age += delta; });
    state.splashes = state.splashes.filter((splash) => splash.age < splash.life);
  };

  const drawDrop = (ctx, drop, height) => {
    if (drop.y + drop.length < 0 || drop.y > height) return;
    const headX = drop.x;
    const headY = drop.y + drop.length;
    const tailX = drop.x + drop.length * drop.slant;
    const tailY = drop.y;
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(headX, headY);
    ctx.lineWidth = drop.width * 1.65;
    ctx.shadowBlur = .3 + drop.depth * .65;
    ctx.shadowColor = `rgba(216,228,225,${(drop.alpha * .24).toFixed(3)})`;
    ctx.strokeStyle = `rgba(205,219,216,${(drop.alpha * .17).toFixed(3)})`;
    ctx.stroke();

    const streak = ctx.createLinearGradient(tailX, tailY, headX, headY);
    streak.addColorStop(0, "rgba(205,250,242,0)");
    streak.addColorStop(.68, `rgba(220,231,228,${(drop.alpha * .52).toFixed(3)})`);
    streak.addColorStop(1, `rgba(238,244,242,${drop.alpha.toFixed(3)})`);
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(headX, headY);
    ctx.lineWidth = drop.width;
    ctx.strokeStyle = streak;
    ctx.stroke();
    ctx.shadowBlur = 0;
  };

  const drawSplash = (ctx, splash) => {
    const progress = clamp(splash.age / splash.life, 0, 1);
    const ease = 1 - Math.pow(1 - progress, 2.4);
    const fade = Math.pow(1 - progress, 1.45);
    const strength = .55 + splash.strength * .45;
    const radius = .65 + ease * (4.2 + splash.strength * 1.6);

    ctx.save();
    ctx.translate(splash.x, splash.y);
    ctx.rotate(splash.rotation);
    ctx.scale(1, splash.squash);
    ctx.globalCompositeOperation = "screen";
    ctx.lineCap = "round";
    const outerArcs = [[.06, 1.42], [1.82, 3.08], [3.5, 4.78], [5.18, 6.08]];
    ctx.lineWidth = .58 + splash.strength * .24;
    ctx.strokeStyle = `rgba(224,236,233,${(fade * .68 * strength).toFixed(3)})`;
    outerArcs.forEach(([start, end]) => {
      ctx.beginPath();
      ctx.arc(0, 0, radius, start + splash.stagger, end + splash.stagger);
      ctx.stroke();
    });

    if (progress > .17) {
      const innerProgress = (progress - .17) / .83;
      const innerEase = 1 - Math.pow(1 - innerProgress, 2.1);
      const innerRadius = .4 + innerEase * (3.4 + splash.strength * 1.6);
      ctx.lineWidth = .42;
      ctx.strokeStyle = `rgba(232,241,239,${(fade * .4 * strength).toFixed(3)})`;
      [[.3, 2.55], [3.05, 5.75]].forEach(([start, end]) => {
        ctx.beginPath();
        ctx.arc(0, 0, innerRadius, start - splash.stagger, end - splash.stagger);
        ctx.stroke();
      });
    }

    if (progress < .16) {
      const flash = 1 - progress / .16;
      ctx.beginPath();
      ctx.arc(0, 0, .34 + splash.strength * .26, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(243,248,246,${(flash * .72 * strength).toFixed(3)})`;
      ctx.fill();
    }

    const burstProgress = clamp(progress / .68, 0, 1);
    const burstEase = 1 - Math.pow(1 - burstProgress, 2.2);
    const flight = Math.sin(Math.PI * burstProgress);
    splash.droplets.forEach((droplet) => {
      const travel = droplet.distance * burstEase * droplet.phase;
      const x = Math.cos(droplet.angle) * travel;
      const y = Math.sin(droplet.angle) * travel;
      const alpha = fade * flight * .88 * strength;
      if (alpha <= .01) return;
      ctx.beginPath();
      ctx.arc(x, y, droplet.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(235,244,241,${alpha.toFixed(3)})`;
      ctx.fill();
    });

    if (progress < .24) {
      const crown = Math.sin(Math.PI * progress / .24);
      ctx.lineWidth = .34;
      ctx.strokeStyle = `rgba(239,247,244,${(crown * .58 * strength).toFixed(3)})`;
      splash.droplets.slice(0, 4).forEach((droplet) => {
        const inner = .38 + splash.strength * .18;
        const outer = inner + crown * (1.6 + splash.strength * 1.3);
        ctx.beginPath();
        ctx.moveTo(Math.cos(droplet.angle) * inner, Math.sin(droplet.angle) * inner);
        ctx.lineTo(Math.cos(droplet.angle) * outer, Math.sin(droplet.angle) * outer);
        ctx.stroke();
      });
    }

    if (flight > .04) {
      ctx.beginPath();
      ctx.arc(0, 0, .34 + flight * (.42 + splash.strength * .28), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(241,247,245,${(fade * flight * .58 * strength).toFixed(3)})`;
      ctx.fill();
    }
    ctx.restore();
  };

  const render = (rig, now, delta) => {
    const parts = rig._proRainyForestParts;
    const canvas = parts && parts.rainCanvas;
    if (!canvas) return;
    const state = rig._proRainyForestMotionState || (rig._proRainyForestMotionState = makeState());
    resizeCanvas(canvas, state);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, state.height);

    if (!(motionQuery && motionQuery.matches)) {
      update(state, delta);
      ctx.save();
      tracePondSurface(ctx, state.width, state.height);
      ctx.clip();
      ctx.globalCompositeOperation = "screen";
      const step = window.__perfMode ? 2 : 1;
      for (let index = 0; index < state.drops.length; index += step) {
        drawDrop(ctx, state.drops[index], state.height);
      }
      state.splashes.forEach((splash) => drawSplash(ctx, splash));
      ctx.restore();
    }

    const width = Math.max(80, rig.offsetWidth || 180);
    const t = now * .001;
    parts.mist.style.transform = `translate3d(${(Math.sin(t * .24) * width * .018).toFixed(1)}px,0,0)`;
    parts.waterLight.style.opacity = (.26 + (Math.sin(t * 1.4) + 1) * .08).toFixed(2);
    parts.waterLight.style.transform =
      `translate3d(${(Math.sin(t * .61) * width * .012).toFixed(1)}px,0,0) scaleX(${(1 + Math.sin(t * .83) * .05).toFixed(3)})`;
  };

  const tick = (now) => {
    frame = 0;
    const interval = window.__perfMode ? 50 : 16;
    if (now - lastFrame < interval) {
      if (rigs.size && !ProMotionGate.suspended()) frame = requestAnimationFrame(tick);
      return;
    }
    const delta = clamp((now - lastFrame) / 1000 || .016, .008, .05);
    lastFrame = now;
    rigs.forEach((rig) => {
      if (!rig.isConnected) {
        rigs.delete(rig);
        ProMotionGate.unobserve(rig);
        return;
      }
      if (!ProMotionGate.visible(rig)) return;   // اسکرول‌شده بیرونِ دید → محاسبه نکن
      // Playback is decided by reading :hover from the DOM — closest(":hover")
      // finds the row even though the plate itself ignores pointer events, and
      // it cannot go stale when a list re-renders under the cursor.
      const playing = rig.dataset.motionPaused !== "1"
        || (typeof window.__mihanNameplateHovered === "function" && window.__mihanNameplateHovered(rig));
      // ساعتِ خودِ این پلاک — هر دورِ پخش از صفر. ر.ک. ProMotionGate.clock.
      const plateNow = ProMotionGate.clock(rig, now, playing);
      if (!ProMotionGate.shouldRender(rig, playing)) return;
      render(rig, plateNow, playing ? delta : 0);
    });
    if (rigs.size && !ProMotionGate.suspended()) frame = requestAnimationFrame(tick);
  };

  const resume = () => {
    if (!rigs.size || frame || ProMotionGate.suspended()) return;
    lastFrame = performance.now();   // بعد از توقف، delta را از نو بگیر تا پرشِ ناگهانی نشود
    frame = requestAnimationFrame(tick);
  };
  ProMotionGate.register(resume);

  return {
    mount(rig) {
      if (!rig) return;
      rigs.add(rig);
      ProMotionGate.observe(rig);
      resume();
    },
  };
})();
