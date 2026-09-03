// One shared frame loop drives every lowrider rig. CSS keyframes are not used
// because the launcher's performance mode intentionally disables them globally.
import { ProMotionGate } from "./pro-motion-gate.js?v=1";

export const ProLowriderMotion = (() => {
  const rigs = new Set();
  const rainStates = new WeakMap();
  let frame = 0;
  let previousFrame = 0;
  let hop = null;
  let nextSide = Math.random() < .5 ? "front" : "rear";

  const randomBetween = (min, max) => min + Math.random() * (max - min);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  const resetDrop = (drop, width, height, initial = false) => {
    const depth = randomBetween(.18, 1);
    drop.depth = depth;
    drop.x = randomBetween(-width * .08, width * 1.08);
    drop.y = initial ? randomBetween(-height * .18, height * .96) : randomBetween(-height * .54, -2);
    drop.speed = height * randomBetween(1.85, 3.9) * (.68 + depth * .48);
    drop.length = Math.max(3, height * randomBetween(.045, .155) * (.58 + depth * .72));
    drop.width = .42 + depth * .92;
    drop.opacity = .17 + depth * .57;
    drop.wind = randomBetween(.105, .235);
    drop.phase = randomBetween(0, Math.PI * 2);
    drop.impactY = height * randomBetween(.78, .97);
    drop.cool = Math.random() > .47;
  };

  const rainStateFor = (canvas, width, height, dpr) => {
    const targetCount = clamp(Math.round((width * height) / 230), 26, 148);
    let state = rainStates.get(canvas);
    if (!state || state.width !== width || state.height !== height || state.dpr !== dpr) {
      const context = canvas.getContext("2d", { alpha: true });
      state = { context, width, height, dpr, drops: [], splashes: [] };
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      for (let index = 0; index < targetCount; index += 1) {
        const drop = {};
        resetDrop(drop, width, height, true);
        state.drops.push(drop);
      }
      rainStates.set(canvas, state);
    } else if (state.drops.length !== targetCount) {
      while (state.drops.length < targetCount) {
        const drop = {};
        resetDrop(drop, width, height, true);
        state.drops.push(drop);
      }
      state.drops.length = targetCount;
    }
    return state;
  };

  const drawRain = (canvas, now, elapsed) => {
    if (!canvas || !canvas.isConnected) return;
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight));
    if (width < 3 || height < 3) return;

    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const state = rainStateFor(canvas, width, height, dpr);
    const ctx = state.context;
    if (!ctx) return;
    const dt = clamp(elapsed || 16.67, 8, 48) / 1000;
    const glint = .9 + Math.sin(now * .0071) * .08 + Math.sin(now * .0137) * .035;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";

    state.drops.forEach((drop) => {
      drop.y += drop.speed * dt;
      drop.x += drop.speed * dt * drop.wind + Math.sin(now * .004 + drop.phase) * .08;
      if (drop.x > width * 1.12) drop.x -= width * 1.2;

      const tailX = drop.x - drop.length * drop.wind;
      const tailY = drop.y - drop.length;
      ctx.lineWidth = drop.width;
      ctx.strokeStyle = drop.cool
        ? `rgba(201, 238, 255, ${(drop.opacity * glint).toFixed(3)})`
        : `rgba(255, 142, 166, ${(drop.opacity * .74 * glint).toFixed(3)})`;
      ctx.shadowBlur = drop.depth > .72 ? 1.65 : 0;
      ctx.shadowColor = drop.cool ? "rgba(104, 209, 255, .7)" : "rgba(255, 83, 125, .55)";
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(drop.x, drop.y);
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (drop.y >= drop.impactY) {
        if (drop.depth > .43 && state.splashes.length < 26) {
          state.splashes.push({
            x: drop.x,
            y: drop.impactY,
            age: 0,
            life: randomBetween(.19, .42),
            depth: drop.depth,
            cool: drop.cool,
          });
        }
        resetDrop(drop, width, height);
      }
    });

    state.splashes = state.splashes.filter((splash) => {
      splash.age += dt;
      if (splash.age >= splash.life) return false;
      const progress = splash.age / splash.life;
      const alpha = (1 - progress) * (.22 + splash.depth * .34);
      const radius = (1.2 + splash.depth * 3.8) * (.35 + progress);
      ctx.lineWidth = .35 + splash.depth * .55;
      ctx.strokeStyle = splash.cool
        ? `rgba(126, 225, 255, ${alpha.toFixed(3)})`
        : `rgba(255, 119, 150, ${(alpha * .84).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(splash.x, splash.y, radius, Math.max(.35, radius * .22), 0, Math.PI, Math.PI * 2);
      ctx.stroke();
      if (progress < .55) {
        const burst = (1 - progress) * (1.4 + splash.depth * 2.2);
        ctx.beginPath();
        ctx.moveTo(splash.x - radius * .32, splash.y - .3);
        ctx.lineTo(splash.x - radius * .48, splash.y - burst);
        ctx.moveTo(splash.x + radius * .3, splash.y - .3);
        ctx.lineTo(splash.x + radius * .46, splash.y - burst * .82);
        ctx.stroke();
      }
      return true;
    });

    ctx.globalCompositeOperation = "source-over";
  };

  const scheduleHop = (now, first = false) => {
    const side = nextSide;
    nextSide = side === "front" ? "rear" : "front";
    hop = {
      side,
      start: now + (first ? 120 : randomBetween(260, 760)),
      duration: randomBetween(680, 1080),
      strength: randomBetween(.76, 1),
    };
  };

  const hopFrame = (now) => {
    if (!hop) scheduleHop(now, true);
    if (now >= hop.start + hop.duration) scheduleHop(now);
    if (now < hop.start) return { front: 0, rear: 0 };

    const progress = Math.min(1, Math.max(0, (now - hop.start) / hop.duration));
    const pulse = Math.sin(Math.PI * progress) * hop.strength;
    return hop.side === "front"
      ? { front: pulse, rear: 0 }
      : { front: 0, rear: pulse };
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
    const elapsed = previousFrame ? frameNow - previousFrame : 16.67;
    previousFrame = frameNow;
    const liveMovement = hopFrame(frameNow);

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
      // بدونِ این، بومِ باران هرگز یک بار هم رسم نمی‌شد و پلاکِ ساکن «بارون نداشت».
      // در ساعتِ صفر، hopFrame هنوز به اولین پرشش نرسیده، پس ماشین صاف روی
      // فنرهایش می‌نشیند — همان فریمِ اولِ انیمیشن.
      const now = ProMotionGate.clock(rig, frameNow, playing);
      if (!ProMotionGate.shouldRender(rig, playing)) return;
      const movement = playing ? liveMovement : { front: 0, rear: 0 };

      const parts = rig._proLowriderParts;
      if (!parts) return;

      const rigHeight = Math.max(32, (rig.offsetWidth || 120) / 2.5);
      const rigWidth = Math.max(72, rig.offsetWidth || 120);
      const { front, rear } = movement;
      const bodyLift = (front + rear) * .5;
      const bodyTravel = Math.max(2.1, Math.min(4.2, rigHeight * .04));
      const frontTravel = Math.max(2.6, Math.min(4.5, rigHeight * .035));
      const rearTravel = Math.max(1.8, Math.min(3.2, rigHeight * .025));
      const wheelSpin = (now * .24) % 360;
      const driveWave = Math.sin(now * .00072) * rigWidth * .11;
      const roadShift = -((now * .13) % 72);

      rig.style.setProperty("--lowrider-drive-x", `${driveWave.toFixed(2)}px`);
      const cityScene = rig._proLowriderScene;
      if (cityScene) {
        const sceneParts = rig._proLowriderSceneParts || {
          cityPan: cityScene.querySelector(".pro-lowrider-city-pan"),
          cityLights: cityScene.querySelector(".pro-lowrider-city-lights"),
          wetReflections: cityScene.querySelector(".pro-lowrider-wet-reflections"),
          rainCanvas: cityScene.querySelector(".pro-lowrider-rain-canvas"),
        };
        rig._proLowriderSceneParts = sceneParts;
        const sceneWidth = Math.max(rigWidth, cityScene.clientWidth || rigWidth * 2.8);
        // The loop image is 4096x768 (5.333:1) and CSS renders it at 150% height,
        // so one exact horizontal tile is 8x the city-pan element height.
        const cityTileWidth = Math.max(
          sceneWidth * 1.08,
          Math.max(1, sceneParts.cityPan?.clientHeight || cityScene.clientHeight * 1.18) * 8,
        );
        const cityShift = -((now * .026) % cityTileWidth);
        const lightPulse = .72 + Math.sin(now * .0042) * .12;
        cityScene.style.setProperty("--lowrider-city-shift", `${cityShift.toFixed(2)}px`);
        cityScene.style.setProperty("--lowrider-road-shift", `${roadShift.toFixed(2)}px`);
        cityScene.style.setProperty("--lowrider-rain-x", `${(roadShift * .24).toFixed(2)}px`);
        cityScene.style.setProperty("--lowrider-rain-y", `${((now * .21) % 96).toFixed(2)}px`);
        cityScene.style.setProperty("--lowrider-rain-x-slow", `${(roadShift * -.13).toFixed(2)}px`);
        cityScene.style.setProperty("--lowrider-rain-y-slow", `${((now * .15) % 96).toFixed(2)}px`);
        cityScene.style.setProperty("--lowrider-headlight-pulse", lightPulse.toFixed(3));
        if (sceneParts.cityLights) {
          const lightDrift = Math.sin(now * .00074) * 2.2;
          const lightLift = Math.sin(now * .00084) * .65;
          sceneParts.cityLights.style.opacity = (.5 + lightPulse * .22).toFixed(3);
          sceneParts.cityLights.style.transform =
            `translate3d(${lightDrift.toFixed(2)}px, ${lightLift.toFixed(2)}px, 0) scale(${(1.012 + lightPulse * .012).toFixed(3)})`;
        }
        if (sceneParts.wetReflections) {
          sceneParts.wetReflections.style.opacity = (.3 + lightPulse * .22).toFixed(3);
          sceneParts.wetReflections.style.transform =
            `translate3d(${(roadShift * .14).toFixed(2)}px, 0, 0) skewX(-4deg) scaleY(${(1.02 + Math.sin(now * .0031) * .035).toFixed(3)})`;
        }
        drawRain(sceneParts.rainCanvas, now, elapsed);
      }

      parts.body.style.transform =
        `translate3d(0, ${(-bodyLift * bodyTravel).toFixed(2)}px, 0) rotate(${((front - rear) * 1.45).toFixed(2)}deg)`;
      parts.frontWheel.style.transform =
        `translate3d(0, ${(front * frontTravel).toFixed(2)}px, 0) rotate(${(wheelSpin - front * 2.2).toFixed(2)}deg)`;
      parts.rearWheel.style.transform =
        `translate3d(0, ${(rear * rearTravel).toFixed(2)}px, 0) rotate(${(wheelSpin - rear * 1.2).toFixed(2)}deg)`;
      parts.frontSpring.style.transform = `scaleY(${(1 + front * .14).toFixed(3)})`;
      parts.rearSpring.style.transform = `scaleY(${(1 + rear * .10).toFixed(3)})`;

      const glow = .58 + Math.abs(bodyLift) * .34;
      parts.aura.style.opacity = glow.toFixed(2);
      parts.aura.style.transform = `scale(${(.97 + Math.abs(bodyLift) * .055).toFixed(3)})`;

      parts.sparkOne.style.opacity = front > .62 ? "1" : "0";
      parts.sparkOne.style.transform = `scale(${front > .62 ? 1 : .45}) rotate(45deg)`;
      parts.sparkTwo.style.opacity = rear > .62 ? "1" : "0";
      parts.sparkTwo.style.transform = `scale(${rear > .62 ? 1 : .45}) rotate(45deg)`;
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
