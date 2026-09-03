// Reclining death-skeleton nameplate: it drinks a real, separately rendered
// glass of tea, empties it, throws it away, then picks up a fresh full glass.
import { ProMotionGate } from "./pro-motion-gate.js?v=1";

export const ProDeathSkeletonMotion = (() => {
  const rigs = new Set();
  let frame = 0;
  // 40% faster than the original 10.8 s cycle: 10800 / 1.4.
  const CYCLE_MS = 7714;

  const clamp = (value) => Math.max(0, Math.min(1, value));
  const smooth = (value) => {
    const x = clamp(value);
    return x * x * (3 - 2 * x);
  };
  const mix = (from, to, amount) => from + (to - from) * amount;

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
      // ساعتِ هر پلاک از لحظه‌ی شروعِ پخشِ خودش می‌شمارد، پس هر دور از phase = 0
      // راه می‌افتد: «لیوانِ پُرِ تازه در دست» — وگرنه اسکلت از وسطِ چرخه (مثلاً
      // وسطِ پرت‌کردنِ لیوان) شروع می‌کرد.
      const now = ProMotionGate.clock(rig, frameNow, playing);
      if (!ProMotionGate.shouldRender(rig, playing)) return;
      const phase = (now % CYCLE_MS) / CYCLE_MS;
      const breath = Math.sin(now / 760);
      const relaxed = Math.sin(now / 1180);

      const parts = rig._proDeathSkeletonParts;
      if (!parts) return;

      const rigWidth = rig.offsetWidth || 124;
      const rigHeight = rig.offsetHeight || 54;
      let armAngle = 22;
      let wristAngle = 0;
      let fill = 1;
      let glassOpacity = 1;
      let glassX = 0;
      let glassY = 0;
      let glassRotate = 0;
      let glassScale = 1;
      let sip = 0;
      let pour = 0;
      let tossing = 0;

      if (phase < .10) {
        // A fresh full glass rests in the hand.
        armAngle = 22;
      } else if (phase < .22) {
        // Lift the full glass to the mouth.
        const lift = smooth((phase - .10) / .12);
        armAngle = mix(22, 15, lift);
        wristAngle = mix(0, -52, lift);
        sip = lift;
      } else if (phase < .52) {
        // Drink slowly: the amber liquid visibly drains to the bottom.
        const drink = clamp((phase - .22) / .30);
        armAngle = 15 - Math.sin(drink * Math.PI) * .7;
        wristAngle = mix(-52, -66, smooth(drink));
        fill = 1 - smooth(drink);
        pour = smooth(clamp((drink - .04) / .14)) * (1 - smooth(clamp((drink - .84) / .14)));
        sip = 1;
      } else if (phase < .59) {
        // Pull the empty glass away from the mouth.
        const lower = smooth((phase - .52) / .07);
        armAngle = mix(15, 18, lower);
        wristAngle = mix(-66, 0, lower);
        fill = 0;
        sip = 1 - lower;
      } else if (phase < .68) {
        // Throw immediately from the resting position, without a wind-up or pause.
        const throwPhase = clamp((phase - .59) / .09);
        const strike = smooth(clamp(throwPhase / .42));
        const followThrough = smooth(clamp((throwPhase - .42) / .58));
        const release = smooth(clamp((throwPhase - .18) / .08));
        const flight = clamp((throwPhase - .25) / .75);
        armAngle = mix(18, 4, strike);
        armAngle = mix(armAngle, 6, followThrough);
        wristAngle = mix(0, -18, strike);
        wristAngle = mix(wristAngle, -10, followThrough);
        fill = 0;
        tossing = release;
        glassX = flight * rigWidth * .44;
        glassY = rigHeight * (-.35 * flight + .65 * flight * flight);
        glassRotate = flight * 180;
        glassScale = 1 - flight * .06;
        glassOpacity = flight < .84 ? 1 : 1 - smooth((flight - .84) / .16);
      } else if (phase < .76) {
        // Empty hand returns toward the supply below the frame.
        const reach = smooth((phase - .68) / .08);
        armAngle = mix(6, 38, reach);
        wristAngle = mix(-10, 0, reach);
        fill = 0;
        glassOpacity = 0;
      } else if (phase < .91) {
        // The same separate glass enters the hand without swapping image layers.
        const pickup = smooth(clamp((phase - .76) / .11));
        armAngle = mix(38, 22, pickup);
        wristAngle = 0;
        fill = 1;
        glassOpacity = pickup;
        glassX = (1 - pickup) * rigWidth * .08;
        glassY = (1 - pickup) * rigHeight * .58;
        glassRotate = (1 - pickup) * -22;
        glassScale = .86 + pickup * .14;
      }

      rig.style.opacity = "1";
      rig.style.transform = `translate3d(0, ${(breath * .42).toFixed(2)}px, 0)`;
      parts.rug.style.transform =
        `var(--death-rug-base-transform, translateZ(0)) translateY(${(-breath * .42).toFixed(2)}px)`;
      parts.body.style.transform =
        `translateY(${(breath * .24 - sip * .35).toFixed(2)}px) rotate(${(relaxed * .14 - sip * .12).toFixed(2)}deg)`;
      parts.rearLeg.style.transform =
        `rotate(${(-1.5 + relaxed * .55).toFixed(2)}deg)`;
      parts.frontLeg.style.transform =
        `rotate(${(4 - relaxed * .78).toFixed(2)}deg)`;
      parts.rearLowerLeg.style.transform =
        `rotate(${(Math.sin(now / 980 + .8) * 1.15).toFixed(2)}deg)`;
      parts.frontLowerLeg.style.transform =
        `rotate(${(Math.sin(now / 760 + 1.9) * 2.35).toFixed(2)}deg)`;
      parts.teaWrap.style.transform =
        `rotate(${armAngle.toFixed(2)}deg) translateY(${(-sip * .35).toFixed(2)}px)`;
      parts.wristWrap.style.transform = `rotate(${wristAngle.toFixed(2)}deg)`;
      parts.teaHand.style.opacity = "1";
      parts.glassFrame.style.opacity = "1";
      parts.glass.style.opacity = clamp(glassOpacity).toFixed(2);
      parts.glass.style.transform =
        `translate3d(${glassX.toFixed(2)}px, ${glassY.toFixed(2)}px, 0) rotate(${glassRotate.toFixed(1)}deg) scale(${glassScale.toFixed(3)})`;
      parts.liquid.style.opacity = fill > .015 ? "1" : "0";
      parts.liquid.style.transform =
        `rotate(${(-wristAngle * .34).toFixed(2)}deg) scaleY(${clamp(fill).toFixed(3)})`;
      parts.teaStream.style.opacity = clamp(pour * glassOpacity).toFixed(2);
      parts.teaStream.style.transform =
        `rotate(${(-wristAngle * .12).toFixed(2)}deg) scaleX(${(.82 + pour * .28).toFixed(2)})`;

      const steamCounterAngle = -(armAngle + wristAngle + glassRotate);
      const steamActivity = clamp(
        glassOpacity * (.08 + fill * .92) * (1 - tossing) * (1 - sip * .18)
      );
      const steamRise = Math.max(9, rigHeight * .36);
      parts.steam.style.opacity = steamActivity > .015 ? "1" : "0";
      parts.steam.style.transform = `rotate(${steamCounterAngle.toFixed(2)}deg)`;
      parts.steamPuffs.forEach((puff, index) => {
        const travel = (now / 2450 + index / parts.steamPuffs.length) % 1;
        const appear = smooth(clamp(travel / .13));
        const disappear = 1 - smooth(clamp((travel - .66) / .34));
        const puffOpacity = steamActivity * appear * disappear * (.82 + (index % 3) * .08);
        const drift = Math.sin(travel * 5.4 + index * 1.7) * steamRise * .13
          + (index - 2) * steamRise * .025;
        const rise = -travel * steamRise * (.82 + (index % 2) * .12);
        const puffScale = .42 + travel * .86;
        puff.style.opacity = clamp(puffOpacity).toFixed(2);
        puff.style.transform =
          `translate3d(${drift.toFixed(2)}px, ${rise.toFixed(2)}px, 0) scale(${puffScale.toFixed(3)})`;
      });
      parts.aura.style.opacity = (.48 + Math.abs(breath) * .20).toFixed(2);
      parts.aura.style.transform = `scale(${(1 + Math.abs(breath) * .024).toFixed(3)})`;
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
