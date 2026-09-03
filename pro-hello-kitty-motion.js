// Kitty and the scooter stay still. This loop drives only the blink and a
// renewing stream of lightweight leaves around the nameplate.
import { ProMotionGate } from "./pro-motion-gate.js?v=1";

export const ProHelloKittyMotion = (() => {
  const rigs = new Set();
  let frame = 0;
  const motionQuery = typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const paths = [
    { cx: 47, cy: 44, rx: 47, ry: 29, duration: 7.2, phase: .02, turns: .76, scale: 1, dir: 1 },
    { cx: 49, cy: 51, rx: 54, ry: 38, duration: 8.4, phase: .16, turns: .68, scale: .9, dir: -1 },
    { cx: 46, cy: 48, rx: 43, ry: 42, duration: 7.7, phase: .29, turns: .82, scale: .78, dir: 1 },
    { cx: 50, cy: 43, rx: 51, ry: 33, duration: 8.8, phase: .41, turns: .72, scale: 1.08, dir: -1 },
    { cx: 45, cy: 50, rx: 48, ry: 39, duration: 7.4, phase: .54, turns: .79, scale: .86, dir: 1 },
    { cx: 51, cy: 47, rx: 56, ry: 31, duration: 8.1, phase: .66, turns: .66, scale: .72, dir: -1 },
    { cx: 48, cy: 45, rx: 45, ry: 44, duration: 9.1, phase: .79, turns: .74, scale: .96, dir: 1 },
    { cx: 46, cy: 52, rx: 53, ry: 36, duration: 7.9, phase: .91, turns: .81, scale: .8, dir: -1 },
  ];

  const smooth = (value) => value * value * (3 - 2 * value);

  const openEyes = (parts) => {
    parts.eyelids.forEach((eyelid) => {
      eyelid.style.opacity = "0";
      eyelid.style.transform = "scaleY(.08)";
    });
  };

  const staticLeaves = (parts) => {
    const positions = [
      [8, 16], [92, 29], [85, 86], [15, 75],
      [65, 8], [96, 61], [34, 91], [5, 45],
    ];
    parts.leaves.forEach((leaf, index) => {
      leaf.style.left = `${positions[index][0]}%`;
      leaf.style.top = `${positions[index][1]}%`;
      leaf.style.opacity = ".9";
      leaf.style.zIndex = "8";
      leaf.style.transform = "translate(-50%,-50%) rotate(-24deg)";
    });
  };

  const blinkAmount = (now) => {
    const phase = now % 4200;
    if (phase < 82) return phase / 82;
    if (phase < 142) return 1;
    if (phase < 236) return 1 - ((phase - 142) / 94);
    return 0;
  };

  let lastFrame = 0;
  const tick = (frameNow) => {
    frame = 0;
    // در حالتِ کم‌مصرف نرخ را پایین می‌آوریم — دو موتورِ دیگر (moonlit/rainy) این را
    // داشتند و این سه نداشتند، پس با perf-mode هم با تمامِ سرعت کار می‌کردند.
    const interval = window.__perfMode ? 42 : 16;
    if (frameNow - lastFrame < interval) {
      if (rigs.size && !ProMotionGate.suspended()) frame = requestAnimationFrame(tick);
      return;
    }
    lastFrame = frameNow;
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
      const now = ProMotionGate.clock(rig, frameNow, playing);
      if (!ProMotionGate.shouldRender(rig, playing)) return;
      const t = now * .001;
      const parts = rig._proHelloKittyParts;
      if (!parts) return;
      const forestParts = rig._proHelloKittyForestParts;
      if (forestParts) {
        forestParts.forestPan.style.transform = "none";
        forestParts.rays.style.opacity = (.35 + Math.sin(now * .00071) * .11).toFixed(3);
        forestParts.rays.style.transform =
          `translate3d(${(Math.sin(now * .00031) * 5.2).toFixed(2)}px, 0, 0) rotate(${(Math.sin(now * .00019) * 1.8).toFixed(2)}deg)`;
        forestParts.mist.style.opacity = (.3 + Math.sin(now * .00043 + .8) * .08).toFixed(3);
        forestParts.mist.style.transform =
          `translate3d(${(Math.sin(now * .00027 + 2.1) * 8).toFixed(2)}px, 0, 0)`;
      }
      if (motionQuery && motionQuery.matches) {
        openEyes(parts);
        staticLeaves(parts);
        return;
      }

      parts.leaves.forEach((leaf, index) => {
        const path = paths[index];
        const rawCycle = (t / path.duration) + path.phase;
        const cycleIndex = Math.floor(rawCycle);
        const progress = rawCycle - cycleIndex;
        const seed = index * 1.731 + cycleIndex * 2.399;
        const startAngle = index * .77 + Math.sin(seed) * 1.35;
        const angle = startAngle + progress * path.turns * Math.PI * 2 * path.dir;
        const depth = Math.sin(angle);
        const x = path.cx + Math.sin(seed * 1.7) * 3.5 + Math.cos(angle) * path.rx;
        const y = path.cy + Math.cos(seed * 1.3) * 2.5 + depth * path.ry +
          Math.sin(t * 1.15 + index) * 2.2;
        const fadeIn = smooth(Math.min(1, progress / .16));
        const fadeOut = smooth(Math.min(1, (1 - progress) / .24));
        const visibility = Math.min(fadeIn, fadeOut);
        const tumble = angle * 57.2958 + Math.sin(t * 2.1 + index) * 22;
        leaf.style.left = `${x.toFixed(2)}%`;
        leaf.style.top = `${y.toFixed(2)}%`;
        leaf.style.opacity = (visibility * (depth < 0 ? .58 : .96)).toFixed(2);
        leaf.style.zIndex = depth < 0 ? "3" : "8";
        leaf.style.transform =
          `translate(-50%,-50%) rotate(${tumble.toFixed(2)}deg) ` +
          `rotateY(${(Math.sin(t * 2.5 + index) * 48).toFixed(2)}deg) ` +
          `scale(${(path.scale * (depth < 0 ? .82 : 1)).toFixed(3)})`;
      });

      const amount = blinkAmount(now);
      parts.eyelids.forEach((eyelid) => {
        eyelid.style.opacity = amount > .02 ? "1" : "0";
        eyelid.style.transform = `scaleY(${Math.max(.08, amount).toFixed(3)})`;
      });
    });
    if (rigs.size && !ProMotionGate.suspended()) frame = requestAnimationFrame(tick);
  };

  const resume = () => { if (rigs.size && !frame && !ProMotionGate.suspended()) frame = requestAnimationFrame(tick); };
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
