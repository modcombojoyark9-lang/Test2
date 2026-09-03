// A shared canvas loop gives every moonlit nameplate a real moving starfield.
// Stars drift at different depths; none of the motion is faked with CSS opacity alone.
import { ProMotionGate } from "./pro-motion-gate.js?v=1";

export const ProMoonlitSkyMotion = (() => {
  const rigs = new Set();
  let frame = 0;
  let lastFrame = 0;
  const motionQuery = typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)") : null;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const seeded = (value) => {
    const result = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
    return result - Math.floor(result);
  };

  const createStars = (count) => Array.from({ length: count }, (_, index) => {
    const depth = .2 + seeded(index * 7.13 + 2) * .8;
    return {
      x: seeded(index * 3.71 + 11),
      y: .07 + seeded(index * 5.29 + 19) * .82,
      depth,
      radius: .32 + depth * .78 + seeded(index * 2.17) * .28,
      speed: .009 + depth * .016 + seeded(index * 4.41) * .006,
      sway: .008 + seeded(index * 8.37) * .026,
      phase: seeded(index * 9.91) * Math.PI * 2,
      pulse: .8 + seeded(index * 6.73) * 1.35,
      alpha: .38 + depth * .46,
      cool: seeded(index * 10.31) > .36,
    };
  });

  const createState = () => ({
    width: 0,
    height: 0,
    dpr: 1,
    travel: 0,
    stars: createStars(window.__perfMode ? 24 : 38),
  });

  const resizeCanvas = (canvas, state) => {
    const width = Math.max(80, Math.round(canvas.clientWidth || 220));
    const height = Math.max(24, Math.round(canvas.clientHeight || 52));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 1.75);
    if (state.width === width && state.height === height && state.dpr === dpr) return;
    state.width = width;
    state.height = height;
    state.dpr = dpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  };

  const drawStar = (ctx, star, width, height, now) => {
    const x = star.x * width;
    const y = (star.y + Math.sin(now * .0007 * star.pulse + star.phase) * star.sway) * height;
    const pulse = .66 + (Math.sin(now * .0017 * star.pulse + star.phase) + 1) * .17;
    const alpha = star.alpha * pulse;
    const radius = star.radius * (.88 + pulse * .18);

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.shadowBlur = 2.5 + star.depth * 5.5;
    ctx.shadowColor = star.cool
      ? `rgba(105,174,255,${(alpha * .9).toFixed(3)})`
      : `rgba(235,244,255,${(alpha * .88).toFixed(3)})`;
    ctx.fillStyle = star.cool
      ? `rgba(216,237,255,${alpha.toFixed(3)})`
      : `rgba(255,255,248,${alpha.toFixed(3)})`;
    ctx.fill();
    ctx.shadowBlur = 0;
  };

  const drawMeteor = (ctx, width, height, now, period, offset, lane) => {
    const phase = ((now + offset) % period) / period;
    const activeSpan = .19;
    if (phase > activeSpan) return;
    const progress = phase / activeSpan;
    const eased = 1 - Math.pow(1 - progress, 2.2);
    const fade = Math.sin(Math.PI * progress);
    const headX = width * (1.08 - eased * (.54 + lane * .05));
    const headY = height * (.06 + lane * .13 + eased * .58);
    const tailLength = width * (.1 + lane * .018);
    const tailX = headX + tailLength;
    const tailY = headY - tailLength * .22;
    const gradient = ctx.createLinearGradient(tailX, tailY, headX, headY);
    gradient.addColorStop(0, "rgba(108,180,255,0)");
    gradient.addColorStop(.68, `rgba(145,205,255,${(fade * .42).toFixed(3)})`);
    gradient.addColorStop(1, `rgba(250,253,255,${(fade * .98).toFixed(3)})`);
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(headX, headY);
    ctx.lineCap = "round";
    ctx.lineWidth = .62 + lane * .12;
    ctx.shadowBlur = 5;
    ctx.shadowColor = `rgba(100,177,255,${fade.toFixed(3)})`;
    ctx.strokeStyle = gradient;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(headX, headY, .9 + lane * .12, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${fade.toFixed(3)})`;
    ctx.fill();
    ctx.shadowBlur = 0;
  };

  const render = (rig, now, delta) => {
    const canvas = rig._proMoonlitSkyParts && rig._proMoonlitSkyParts.starCanvas;
    if (!canvas) return;
    const state = rig._proMoonlitSkyMotionState
      || (rig._proMoonlitSkyMotionState = createState());
    resizeCanvas(canvas, state);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.width, state.height);
    ctx.globalCompositeOperation = "screen";

    const reduced = motionQuery && motionQuery.matches;
    if (!reduced) {
      state.travel += delta;
      state.stars.forEach((star) => {
        star.x -= star.speed * delta;
        star.y += star.speed * delta * .055;
        if (star.x < -.025) star.x += 1.05;
        if (star.y > .95) star.y -= .88;
      });
    }
    state.stars.forEach((star) => drawStar(ctx, star, state.width, state.height, now));
    if (!reduced) {
      drawMeteor(ctx, state.width, state.height, now, 4300, 400, 0);
      drawMeteor(ctx, state.width, state.height, now, 6100, 3300, 1);
      drawMeteor(ctx, state.width, state.height, now, 7900, 6100, 2);
    }
  };

  const tick = (now) => {
    frame = 0;
    const interval = window.__perfMode ? 42 : 16;
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
