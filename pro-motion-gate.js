// ┌─────────────────────────────────────────────────────────────────────────┐
// │ گیتِ مشترکِ انیمیشن‌هایِ نیم‌پلیت (rig engines)                            │
// ├─────────────────────────────────────────────────────────────────────────┤
// │ لانچر از قبل زیرساختِ «وقتی پنجره مخفی است کار نکن» را داشت و polling،    │
// │ ویدیوهایِ تبلیغ و موتورِ APNG همه به آن احترام می‌گذاشتند — ولی پنج موتورِ  │
// │ requestAnimationFrameِ نیم‌پلیت به هیچ‌کدام وصل نبودند. نتیجه: ۶۰ فریم بر  │
// │ ثانیه محاسبه + بازنویسیِ inline style، حتی وقتی لانچر مینیمایز است یا      │
// │ کاربر وسطِ بازی است. این‌جا سه گیت اضافه می‌شود:                            │
// │   ۱) پنجره مخفی (document.hidden)                                        │
// │   ۲) بازی در حالِ اجراست → کلاً متوقف، تا CPU/GPU برایِ ماینکرفت آزاد شود  │
// │   ۳) rig بیرونِ دیدِ کاربر است (IntersectionObserver) → همان یکی رد می‌شود │
// │                                                                           │
// │ نکته‌ی مهم: وقتی گیت بسته است، rAF اصلاً دوباره زمان‌بندی نمی‌شود (نه این‌که │
// │ زمان‌بندی شود و سریع return کند) — وگرنه باز هم هر فریم بیدار می‌شدیم.     │
// └─────────────────────────────────────────────────────────────────────────┘
export const ProMotionGate = (() => {
  const resumers = new Set();   // هر موتور یک callbackِ «دوباره شروع کن» ثبت می‌کند
  let gameRunning = false;

  // rigهایی که هنوز observe نشده‌اند یا مرورگر IO ندارد، پیش‌فرض «دیده‌می‌شود» حساب
  // می‌شوند تا در بدترین حالت رفتار مثلِ قبل باشد، نه این‌که انیمیشن هرگز پخش نشود.
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        let woke = false;
        for (const e of entries) {
          e.target.__proOnScreen = e.isIntersecting;
          if (e.isIntersecting) woke = true;
        }
        if (woke) wake();
      }, { rootMargin: "96px" })   // کمی حاشیه تا هنگامِ اسکرول ناگهانی جان نگیرد
    : null;

  const suspended = () => document.hidden || gameRunning;

  function wake() {
    if (suspended()) return;
    for (const resume of resumers) { try { resume(); } catch (_) {} }
  }

  document.addEventListener("visibilitychange", wake);

  return {
    /** موتور callbackِ ازسرگیری‌اش را ثبت می‌کند (باید rAF را دوباره زمان‌بندی کند). */
    register(resume) { if (typeof resume === "function") resumers.add(resume); },
    observe(rig) {
      if (!rig) return;
      rig.__proOnScreen = true;
      if (io) { try { io.observe(rig); } catch (_) {} }
    },
    unobserve(rig) { if (io && rig) { try { io.unobserve(rig); } catch (_) {} } },
    /** آیا این rig الان جایی است که کاربر ببیندش؟ */
    visible(rig) { return !rig || rig.__proOnScreen !== false; },
    /**
     * ساعتِ این rig برای فریمِ جاری.
     *
     * موتورها فازشان را از performance.now() می‌گرفتند، یعنی هر بار که پخش شروع
     * می‌شد، انیمیشن از یک جای تصادفیِ وسطِ چرخه راه می‌افتاد. با این ساعت، هر
     * دور پخش از صفر شروع می‌شود:
     *   «میخوام از فریم اول وقتی پخش میکنم اولین بار پخش شه»
     * و برای پلاکِ متوقف صفر برمی‌گرداند، که همان فریمِ اولِ انیمیشن است.
     *
     * حتماً باید *قبل از* گاردِ shouldRender صدا زده شود، وگرنه مبدأ برای پلاکِ
     * متوقف پاک نمی‌شود و دورِ بعدی از وسط شروع می‌کند.
     */
    clock(rig, frameNow, playing) {
      if (!rig) return playing ? frameNow : 0;
      if (!playing) { rig.__proPlayOrigin = null; return 0; }
      if (rig.__proPlayOrigin == null) rig.__proPlayOrigin = frameNow;
      return frameNow - rig.__proPlayOrigin;
    },
    /**
     * آیا این rig همین حالا باید کشیده شود؟
     *
     * تا امروز موتورها برای پلاکِ متوقف بی‌درنگ return می‌کردند، یعنی هرگز حتی
     * یک بار هم نمی‌کشیدند. چیزی که CSS خودش رسم می‌کند (منظره، ماه، ماشین)
     * سرِ جایش بود، ولی هرچه دستِ همین موتورهاست غایب می‌ماند:
     *   «آسمان مهتابی ذرات نور در عکسش نیست»
     *   «ویرانم ولی میرانم توی عکسش بارون نیست»
     *   «اسکلت چایی خور فریم اولش عکس نیست» (لیوان و بازو را JS جا می‌گذارد)
     *
     * پس پلاکی که هنوز هیچ‌وقت کشیده نشده، یک فریم با ساعتِ صفر می‌گیرد — همان
     * فریمِ اولِ انیمیشن. ولی پلاکی که یک دور پخش شده و حالا متوقف است، *دوباره*
     * کشیده نمی‌شود: آخرین فریمش همان‌جا می‌ماند، که خواسته‌ی دوم است — با
     * برداشتنِ نشانگر همان‌جا عکس شود، نه اینکه به اول بپرد.
     */
    shouldRender(rig, playing) {
      if (!rig) return !!playing;
      if (playing) { rig.__proDrawnOnce = true; return true; }
      if (rig.__proDrawnOnce) return false;
      rig.__proDrawnOnce = true;
      return true;
    },
    suspended,
    /** از app.js صدا زده می‌شود: اجرای بازی → توقفِ کامل، بسته‌شدنِ بازی → ازسرگیری. */
    setGameRunning(on) { gameRunning = !!on; wake(); },
  };
})();

/**
 * setInterval که وقتی پنجره مخفی است یا بازی در حالِ اجراست، callback را اجرا نمی‌کند.
 * خروجی همان idِ معمولی است، پس `clearInterval(id)` بدونِ تغییر کار می‌کند.
 *
 * عمداً «اجرای فوری هنگامِ بازگشت» ندارد: نگه‌داشتنِ یک callback برایِ بیدارباش، بعد از
 * clearInterval هم زنده می‌ماند و روی نمایی که دیگر وجود ندارد اجرا می‌شد. برایِ پول‌هایِ
 * ۳۰۰ms تا ۵s، یک دوره تأخیر بعد از برگشتِ کاربر محسوس نیست.
 *
 * فقط برایِ pollingِ رابطِ کاربری — هرگز برایِ pingِ WebSocket (اتصال قطع می‌شود).
 */
export function setIntervalWhenActive(fn, ms) {
  return setInterval(() => { if (!ProMotionGate.suspended()) fn(); }, ms);
}
