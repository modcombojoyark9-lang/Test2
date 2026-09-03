/* ═══════════════════════════════════════════════════════════════════════════
 *  mihan-polyfill.js — Android implementations of the desktop commands the
 *  compiled Kotlin bridge (AndroidBridge) does NOT handle (~90 of them).
 *
 *  Loads AFTER tauri-shim.js. It registers handlers on window.__MIHAN_POLY__;
 *  the shim's invoke() consults that map first and only falls through to the
 *  native bridge for everything else. Filesystem/image work goes through the
 *  Java companion interface `MihanExt`; HTTP goes through fetch() (the WebView
 *  runs with AllowUniversalAccessFromFileURLs, so cross-origin works). Progress
 *  is emitted through window.__mihanEmit(event, payloadJson), same channel the
 *  native side uses, so the existing UI listeners light up unchanged.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var Ext = window.MihanExt || null;
  var POLY = (window.__MIHAN_POLY__ = window.__MIHAN_POLY__ || {});

  // ── small utils ────────────────────────────────────────
  function emit(ev, payload) {
    try { window.__mihanEmit(ev, JSON.stringify(payload)); } catch (_) {}
  }
  // فیچر-سطحِ رویدادهای دانلود (شروع/تلاش دوباره/موفقیت/شکستِ کل عملیات) را کنارِ
  // لاگِ بایت‌به‌بایتِ MihanDownloadJob در همان logs/download.log می‌نویسد تا دیباگِ
  // یک دانلودِ گیرکرده یا ناموفق بدون تکرارِ زنده‌اش ممکن باشد.
  function dlog(kind, detail) {
    try {
      if (!Ext || !Ext.appendLog) return;
      var line = { ts: Date.now(), kind: kind };
      if (detail) for (var k in detail) line[k] = detail[k];
      Ext.appendLog("download.log", JSON.stringify(line));
    } catch (_) {}
  }
  function cfg() {
    try { return JSON.parse(Ext.config() || "{}"); } catch (_) { return {}; }
  }
  function cfgGet(k, d) { var c = cfg(); return (c[k] != null && c[k] !== "") ? c[k] : d; }
  function accountBase() { return String(cfgGet("account_base_url", "https://auth.mihancraft.com")).replace(/\/+$/, ""); }
  function accountToken() { return String(cfgGet("account_token", "") || ""); }
  function siteBase() { return String(cfgGet("site_base_url", "") || "").replace(/\/+$/, ""); }
  // native passthrough — for keeping the Kotlin Store's in-memory config in sync
  function nativeInvoke(cmd, args) {
    try { return window.__TAURI__.core.invoke(cmd, args); } catch (e) { return Promise.reject(e); }
  }
  // مسیرِ مستقیم به پلِ بومی که چکِ POLY را دور می‌زند — لازم برای کامندهایی که خودِ
  // POLY آن‌ها را override کرده (مثلِ instance_launch) و از داخلشان باید پیاده‌سازیِ
  // اصلیِ نیتیو صدا زده شود؛ nativeInvoke معمولی دوباره POLY را چک می‌کند و بازگشتِ
  // بی‌نهایت می‌سازد.
  function nativeForceInvoke(cmd, args) {
    try { return window.__mihanForceNative(cmd, args); } catch (e) { return Promise.reject(e); }
  }
  function setCfg(key, value) { return nativeInvoke("set_config", { key: String(key), value: value }); }
  var DATA = Ext ? Ext.dataRoot() : "";
  // MC = the REAL Pojav game dir (worlds/screenshots/mods/versions live here),
  // NOT getFilesDir/.minecraft — otherwise every fs read shows empty.
  var MC = Ext ? (Ext.gameDir ? Ext.gameDir() : Ext.minecraftDir()) : "";
  var INST = Ext ? Ext.instancesDir() : "";

  // ── پوشه‌ی اختصاصیِ هر پروفایل (مثلِ نسخه‌ی دسکتاپ) ────────────────────────────────
  // تا پیش از این همه‌ی پروفایل‌ها یک پوشه‌ی mods/resourcepacks/shaderpacks مشترک داشتند،
  // چون MinecraftProfile.gameDir هیچ‌جا ست نمی‌شد و پوجاو در آن حالت همیشه از DIR_GAME_NEW
  // اجرا می‌کند. نتیجه: مادِ ۱٫۱۲٫۲ و ۱٫۲۰٫۱ کنارِ هم می‌نشستند و اجرای هر پروفایلی کرش
  // می‌کرد (روی همین دستگاه دیده شد).
  //
  // پوجاو این فیلد را کاملاً پشتیبانی می‌کند — Tools.getGameDirPath() پیشوندِ "pojav://" را
  // با DIR_GAME_HOME جایگزین می‌کند و Tools.launchMinecraft همان مسیر را به‌عنوانِ
  // game_directory به بازی می‌دهد. مهم‌تر: assets_root/game_assets از Tools.ASSETS_PATH
  // می‌آیند و نسخه‌ها/کتابخانه‌ها هم از پوشه‌ی سراسری خوانده می‌شوند، پس این جداسازی
  // هیچ فایلِ چندگیگابایتی‌ای را تکرار نمی‌کند — دقیقاً همان تقسیمِ لانچرِ رسمی.
  var GAME_HOME = MC.replace(/[\/\\]\.minecraft[\/\\]?$/, "");
  var PROF_ROOT_REL = "instances";

  /** مسیرِ مطلقِ پوشه‌ی یک پروفایل. */
  function profileDirPath(id) { return J(GAME_HOME, PROF_ROOT_REL, String(id)); }

  /**
   * تضمین می‌کند پروفایل در launcher_profiles.json فیلدِ gameDir داشته باشد و پوشه‌اش ساخته
   * شده باشد؛ مسیرِ مطلق را برمی‌گرداند. اگر شناسه‌ای ندهیم (یا پروفایل پیدا نشود) به همان
   * پوشه‌ی سراسری برمی‌گردیم تا هیچ مسیرِ قدیمی‌ای نشکند.
   */
  function ensureProfileDir(id) {
    if (!id) return MC;
    var dir = profileDirPath(id);
    try {
      var lp = J(MC, "launcher_profiles.json");
      var obj = JSON.parse(Ext.readText(lp) || "{}");
      var p = obj && obj.profiles && obj.profiles[id];
      if (!p) return MC;                       // شناسه‌ی ناشناخته → رفتارِ قبلی
      var want = "pojav://" + PROF_ROOT_REL + "/" + id;
      // gameDir MUST go through the native model, not straight into the JSON. Pojav's
      // LauncherProfiles keeps its own in-memory copy and writes it back on every launch (to bump
      // lastUsed), discarding whatever we wrote to the file meanwhile — see MihanProfiles' class
      // doc. For javaArgs a lost edit is harmless; for gameDir it means the launch silently runs
      // against the OLD shared directory, so the player gets a different options.txt, different
      // mods and different worlds than last time. That is the "settings reset themselves" and
      // "per-profile mods only sometimes work" cluster in the reports.
      if (p.gameDir !== want) {
        var done = false;
        // Reload FIRST. setProfileField only touches profiles Pojav already has in its model, and
        // a profile the installers just wrote straight to launcher_profiles.json is not in it yet
        // — so on a brand-new profile the call silently did nothing and we fell through to the
        // file write, which Pojav then reverted when it saved its own copy on launch. The game
        // then ran from the OLD SHARED .minecraft: no per-profile mods, and no CustomSkinLoader,
        // which is the "my skin does not show in game" and "the mods section is empty" clusters.
        // Same trap as javaArgs in ensureLwjglForProfile; same fix.
        try { if (Ext.reloadProfiles) Ext.reloadProfiles(); } catch (_) {}
        try { done = !!(Ext.setProfileField && Ext.setProfileField(id, "gameDir", want)); } catch (_) {}
        if (!done) {
          // Older bridge, or a profile the model still refuses: write the file, then make Pojav
          // re-read it so its copy matches ours instead of overwriting it a moment later.
          p.gameDir = want;
          Ext.writeText(lp, JSON.stringify(obj));
          try { if (Ext.reloadProfiles) Ext.reloadProfiles(); } catch (_) {}
        }
      }
    } catch (_) { return MC; }
    try {
      Ext.mkdirs(dir);
      ["mods", "resourcepacks", "shaderpacks", "config", "saves"].forEach(function (d) {
        try { Ext.mkdirs(J(dir, d)); } catch (_) {}
      });
    } catch (_) {}
    return dir;
  }

  /**
   * یک‌بار برای همیشه: محتوای پوشه‌ی مشترکِ فعلی را به پروفایلِ «اصلی» کاربر منتقل می‌کند تا
   * دنیاها/مادها/ریسورس‌پک‌هایی که همین حالا دارد از دستش نروند، و برای بقیه‌ی پروفایل‌ها
   * gameDir را ست می‌کند تا از این به بعد تمیز شروع کنند.
   *
   * انتقال است نه کپی: هر دو مسیر زیرِ DIR_GAME_HOME و روی یک فایل‌سیستم‌اند، پس rename فوری
   * است و چند گیگابایت دنیا دوباره نوشته نمی‌شود.
   * versions/libraries/assets عمداً دست‌نخورده در پوشه‌ی سراسری می‌مانند (مشترک‌اند).
   */
  var MIGRATE_DIRS = ["saves", "mods", "resourcepacks", "shaderpacks", "config", "defaultconfigs", "CustomSkinLoader"];
  var MIGRATE_FILES = ["options.txt", "servers.dat", "servers.dat_old", "optionsof.txt", "optionsshaders.txt"];
  function ensurePerProfileLayout(preferredId) {
    if (!Ext || !MC) return;
    if (cfgGet("perprofile_migrated", "") === "1") return;
    var target = "";
    var obj = null;
    try {
      var lp = J(MC, "launcher_profiles.json");
      obj = JSON.parse(Ext.readText(lp) || "{}");
    } catch (_) { return; }
    if (!obj || !obj.profiles) return;
    var ids = Object.keys(obj.profiles);
    if (!ids.length) return;
    if (preferredId && obj.profiles[preferredId]) target = preferredId;
    if (!target) { var lastp = cfgGet("last_profile", ""); if (lastp && obj.profiles[lastp]) target = lastp; }
    if (!target) target = ids[0];

    var dest = profileDirPath(target);
    try { Ext.mkdirs(dest); } catch (_) {}
    MIGRATE_DIRS.concat(MIGRATE_FILES).forEach(function (name) {
      try {
        var from = J(MC, name);
        if (!Ext.exists(from)) return;
        var to = J(dest, name);
        if (Ext.exists(to)) return;            // مقصد از قبل چیزی دارد → دست نزن
        Ext.rename(from, to);
      } catch (_) {}
    });
    ids.forEach(function (id) { try { ensureProfileDir(id); } catch (_) {} });
    // هر چیزی که بعد از انتقال در پوشه‌ی مشترک باقی مانده (مثلاً چون مقصد از قبل همان نام را
    // داشت) دیگر توسطِ هیچ پروفایلی خوانده نمی‌شود — حالا همه gameDir دارند. اگر خالی است
    // پاکش کن تا کاربر با دو پوشه‌ی mods که یکی‌شان بی‌اثر است روبه‌رو نشود.
    MIGRATE_DIRS.forEach(function (name) {
      try {
        var leftover = J(MC, name);
        if (!Ext.exists(leftover)) return;
        if (JSON.parse(Ext.list(leftover) || "[]").length === 0) Ext.del(leftover);
      } catch (_) {}
    });
    try { setCfg("perprofile_migrated", "1"); } catch (_) {}
  }
  // ── موتورِ دانلود ────────────────────────────────────────────────────────
  // کلِ دانلود (متادیتا، نسخه‌ها، کتابخانه‌ها، assetها، لودرها، جاوا) در
  // mihan-download.js زندگی می‌کند و تنها منبعش cdn.mihancraft.com است. این فایل
  // فقط فرمان‌های Tauri را به آن وصل می‌کند. پلِ بومیِ HTTP/دانلود هم آن‌جاست، پس
  // اینجا صرفاً alias می‌گیریم (یک مالک، یک صف، یک نوارِ پیشرفت).
  var DL = window.__MIHAN_DL__ || null;
  if (!DL) throw new Error("mihan-download.js بارگذاری نشده است");
  // پیش‌فرضِ منبعِ دانلود = ایران (اگر کاربر قبلاً چیزی انتخاب نکرده) تا کلِ اپ روی سرور ایران باشد.
  try { if (Ext && !cfgGet("download_source", "")) setCfg("download_source", "iran"); } catch (_) {}
  var CDN = DL.CDN;
  var PVP_CDN = DL.LOADERS;

  function genUuid() {
    if (window.crypto && window.crypto.randomUUID) { try { return window.crypto.randomUUID(); } catch (_) {} }
    var s = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
    return s.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ── نسخه‌ها و لودرها — همه از mihan-download.js (سرورِ ایران) ───────────────
  // قبلاً این‌ها یا مستقیم به launchermeta.mojang.com / meta.fabricmc.net می‌زدند
  // (نیتیو) یا نصبی نیمه‌کاره می‌ساختند که فقط چند فایل را می‌گرفت و بقیه را به
  // دانلودگرِ نیتیوِ Pojav می‌سپرد — همان چیزی که روی هر نسخه‌ی مود‌شده به
  // «دانلود Minecraft انجام نشد» می‌رسید. حالا هر نصب یعنی stageVersion: نسخه
  // ۱۰۰٪ آفلاین‌آماده می‌شود و تازه بعدش پروفایل ساخته می‌شود.
  POLY.list_versions = function (a) {
    var showSnapshots = !!(a && a.showSnapshots), showOld = a && a.showOld !== false;
    return DL.versionManifest().then(function (man) {
      return ((man && man.versions) || []).filter(function (v) {
        // نسخه‌هایی که موتورِ فعلی اصلاً نمی‌تواند اجرا کند (۲۶.x به بعد — LWJGL 3.4)
        // اصلاً در لیستِ اندروید نشان داده نمی‌شوند؛ وگرنه کاربر صدها مگ دانلود می‌کند و
        // بعد کرشِ نامفهوم می‌گیرد.
        if (!DL.engineSupportsVersion(v.id)) return false;
        if (v.type === "snapshot" && !showSnapshots) return false;
        if ((v.type === "old_alpha" || v.type === "old_beta") && !showOld) return false;
        return true;
      }).map(function (v) {
        return { id: v.id, type: v.type, url: v.url || "", time: v.time || "", releaseTime: v.releaseTime || "" };
      });
    });
  };
  POLY.install_version = function (a) { return DL.installVanilla(a || {}); };

  POLY.optifine_versions = function () {
    // فهرستِ CDN بر اساسِ رشته مرتب شده ("1.10" قبل از "1.7.10")؛ اینجا به ترتیبِ
    // واقعیِ نسخه، نزولی، مثلِ بقیه‌ی لیست‌های UI.
    return DL.optifineIndex().then(function (list) {
      return list.map(function (e) { return e.mc; }).filter(DL.engineSupportsVersion).sort(verCmpDesc);
    });
  };
  POLY.install_optifine = function (a) {
    var mc = String((a && (a.mcVersion || a.mc)) || "");
    if (!mc) return Promise.reject(new Error("نسخه مشخص نشده"));
    return DL.installOptifine(mc, (a && a.token) || ("of-" + mc), !a || a.makeProfile !== false);
  };

  // ── نسخه‌های نصب‌شده روی دستگاه ─────────────────────────────────────────
  // نه پلِ بومی این دو را دارد و نه تا امروز کسی صدایشان می‌زد — صفحه‌ی «خانه»
  // فقط invoke("list_installed").catch(() => []) می‌کرد و همیشه لیستِ خالی می‌گرفت،
  // یعنی «نسخه‌ی نصب‌شده» روی اندروید همیشه صفر بود. یک نسخه‌ی نصب‌شده روی دیسک
  // یعنی versions/<id>/<id>.json موجود باشد؛ صرفِ وجودِ پوشه کافی نیست چون یک دانلودِ
  // نیمه‌کاره هم پوشه می‌سازد و آن نسخه واقعاً قابلِ اجرا نیست.
  function versionsDir() { return J(MC, "versions"); }
  POLY.list_installed = function () {
    return Promise.resolve().then(function () {
      var entries;
      try { entries = JSON.parse(Ext.list(versionsDir()) || "[]"); } catch (_) { return []; }
      return entries.filter(function (e) {
        if (!e || !e.is_dir || !e.name) return false;
        try { return Ext.exists(J(versionsDir(), e.name, e.name + ".json")); } catch (_) { return false; }
      }).map(function (e) { return e.name; }).sort(verCmpDesc);
    });
  };
  POLY.delete_version = function (a) {
    var id = String((a && (a.versionId || a.id)) || "");
    if (!id || /[\/\\]|\.\./.test(id)) return Promise.reject(new Error("نسخه مشخص نشده"));
    return Promise.resolve().then(function () {
      var dir = J(versionsDir(), id);
      if (!Ext.exists(dir)) throw new Error("این نسخه نصب نیست");
      if (!Ext.del(dir)) throw new Error("حذف نسخه ممکن نشد");
      return true;
    });
  };


  // ── لانچ — پاک‌سازیِ «مادهای عملکردی» ────────────────────────────────────
  // نیتیو قبلاً موقعِ هر اجرای پروفایلِ مدرن، Sodium/Embeddium/Lithium/FerriteCore/
  // ModernFix را مستقیم از Modrinth دانلود می‌کرد. آن نصب‌کننده (McCommands
  // .reconcilePerfMods) حالا در smaliِ APKِ پایه با return-void خنثی شده، پس نه
  // درخواستِ خارجی می‌ماند و نه ترکیبِ ناسازگارِ ماد.
  // نیتیو دیگر «مادهای عملکردی» را نصب نمی‌کند: reconcilePerfMods در smaliِ APKِ پایه
  // با یک return-void خنثی شده (تأییدشده). پس استاب‌های خالی نه‌تنها لازم نیستند، بلکه
  // خودشان خراب‌کارند — FML یک mods.toml را که مادِ اعلام‌شده‌اش وجود ندارد رد می‌کند و
  // فورج با «The Mod File …-STUB.jar has mods that were not found / Error loading mods»
  // درست بعد از بارگذاری می‌مرد.
  //
  // ⚠ این تابع تا امروز هر جاری را که نامش با sodium-/lithium-/embeddium-/… شروع می‌شد
  // هم پاک می‌کرد، در هر بار اجرا. ولی حالا که نصب‌کننده‌ی نیتیو خنثی شده، تنها کسی که
  // چنین فایلی می‌گذارد خودِ کاربر است — از مرورگرِ مادِ همین لانچر، که از قبل بر اساس
  // لودر و نسخه فیلتر می‌کند. نتیجه این بود که کاربر Sodium را نصب می‌کرد، لانچر
  // «نصب شد» می‌گفت، و اجرای بعدی بی‌صدا پاکش می‌کرد:
  //   «سودیم نصب میکنم ولی میرم تو بازی اصلا مود سودیم نیست خودکار حذف میشه» (گزارش ۵۱۴۶)
  //   «مود سدیم رو دانلود می کنم تو بخش ماد ها نشون نمیده»              (گزارش ۵۱۴۷)
  // پس فقط استاب‌ها پاک می‌شوند — همان چیزی که واقعاً فورج را می‌کشت. مادِ واقعی، از هر
  // کجا که آمده باشد، دستِ کاربر است نه ما.
  function ensureNoPerfMods(profileId) {
    try {
      var modsDir = J(ensureProfileDir(profileId), "mods");
      var entries;
      try { entries = JSON.parse(Ext.list(modsDir) || "[]"); } catch (_) { return; }
      entries.forEach(function (e) {
        var n = e && e.name;
        if (!n) return;
        if (/-STUB\.jar$/i.test(n)) { try { Ext.del(J(modsDir, n)); } catch (_) {} }
      });
      try { if (Ext.exists(J(modsDir, ".mihan-perf"))) Ext.del(J(modsDir, ".mihan-perf")); } catch (_) {}
    } catch (_) {}
  }
  // ── پروفایلِ «Default»ِ خودِ Pojav (نسخه‌ی ۱٫۷٫۱۰) ────────────────────────────
  // Pojav هنگامِ اولین اجرا یک پروفایل با نامِ Default و lastVersionId=1.7.10 در
  // launcher_profiles.json می‌سازد. مالِ ما نیست، هیچ‌وقت نصب نشده، و در فهرستِ پروفایل‌ها
  // به‌عنوانِ «یک نسخه‌ی آماده» دیده می‌شد: کاربر اجرایش می‌کرد و یا ~۷۰۰ مگ دانلودِ یک
  // نسخه‌ی ۲۰۱۴ راه می‌افتاد یا خطا می‌گرفت. هم از فایل پاکش می‌کنیم و هم از فهرست فیلترش
  // می‌کنیم (اگر روزی Pojav دوباره بسازدش، دیگر دیده نمی‌شود).
  //
  // فقط نسخه‌ی دست‌نخورده‌ی همان seed حذف می‌شود: نام Default، نسخه‌ی 1.7.10 و هیچ نشانی
  // از استفاده (lastUsed/created). اگر کاربر خودش پروفایلی به این نام ساخته یا یک‌بار
  // اجرایش کرده باشد، دست‌نخورده می‌ماند.
  function isPojavSeedProfile(p) {
    if (!p) return false;
    if (String(p.name || "") !== "Default") return false;
    if (String(p.lastVersionId || "") !== "1.7.10") return false;
    if (p.lastUsed || p.created) return false;
    return true;
  }
  var _seedPruned = false;
  function pruneDefaultProfileOnce() {
    if (_seedPruned) return;
    _seedPruned = true;
    try {
      var lp = J(MC, "launcher_profiles.json");
      var obj = JSON.parse(Ext.readText(lp) || "null");
      if (!obj || !obj.profiles) return;
      var removed = [];
      Object.keys(obj.profiles).forEach(function (k) {
        if (isPojavSeedProfile(obj.profiles[k])) { delete obj.profiles[k]; removed.push(k); }
      });
      if (!removed.length) return;
      // مثلِ ensureProfileDir: مدلِ درون‌حافظه‌ی Pojav باید دوباره از فایل بخواند، وگرنه
      // موقعِ اجرای بعدی نسخه‌ی خودش را برمی‌گرداند و پروفایل دوباره سبز می‌شود.
      Ext.writeText(lp, JSON.stringify(obj));
      try { if (Ext.reloadProfiles) Ext.reloadProfiles(); } catch (_) {}
      removed.forEach(function (k) {
        try { Ext.del(J(INST, k)); } catch (_) {}
      });
    } catch (_) {}
  }
  /**
   * آپتی‌فاین روی اندروید عمداً «فورج + جارِ آپتی‌فاین داخلِ mods» نصب می‌شود (توضیحِ کامل
   * کنارِ ensureOptifineMod). یعنی پروفایل واقعاً لودرِ forge دارد و درست هم کار می‌کند —
   * ولی کاربری که در فهرست «OptiFine» را انتخاب کرده، بعدش می‌بیند نوشته «forge» و نتیجه
   * می‌گیرد نصب اشتباه شده: «نسخه اوپتیفاین نصب میکنم تبدیل میشه به فورج» (گزارش ۵۲۵۱).
   * markerِ ‎.mihan-optifine‎ از قبل موقعِ نصب کنارِ version.json نوشته می‌شود، پس فقط کافی
   * است همان را به رابط برسانیم تا برچسب درست نشان داده شود. خودِ loader دست‌نخورده می‌ماند
   * (منطقِ ماد/نسخه به آن وابسته است).
   */
  // ── RAM هر پروفایل ──────────────────────────────────────────────────────────
  // چیزی که JVM واقعاً می‌خواند، ‎-Xmx‎ داخلِ javaArgsِ همان پروفایل در
  // launcher_profiles.json است. instance_create از اول همین را می‌نوشت، ولی
  // instance_update اصلاً polyfill نشده بود و به نیتیو می‌افتاد که ram را نادیده
  // می‌گیرد — تست روی دستگاه: patch {ram:900} مقدارِ null برمی‌گرداند و در فهرست
  // دوباره 0 می‌شود. یعنی تنظیمِ RAM بعد از ساختِ پروفایل هیچ اثری نداشت و بازی با
  // پیش‌فرضِ خودِ Pojav اجرا می‌شد:
  //   «رم رو انتخاب میکنم ولی خودکار 2000 رم می‌زاره و کرش میکنه»        (گزارش ۵۰۸۵)
  //   «رم بازی رو می‌زارم روی ۹۰۰ اما خودکار می‌ره روی ۲۰۰۰»             (گزارش ۴۹۹۳)
  function readProfiles() {
    try { return JSON.parse(Ext.readText(J(MC, "launcher_profiles.json")) || "{}") || {}; }
    catch (_) { return {}; }
  }
  function parseXmxMb(javaArgs) {
    var m = /-Xmx\s*(\d+)\s*([gGmMkK]?)/.exec(String(javaArgs || ""));
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    var u = (m[2] || "M").toLowerCase();
    if (u === "g") n *= 1024;
    else if (u === "k") n = Math.round(n / 1024);
    return n > 0 ? n : 0;
  }
  function profileRamMb(key) {
    var obj = readProfiles();
    var p = obj.profiles && obj.profiles[key];
    return p ? parseXmxMb(p.javaArgs) : 0;
  }
  /**
   * ‎-Xmx‎ را در javaArgs جایگزین/اضافه/حذف می‌کند و بقیه‌ی آرگومان‌ها را دست‌نخورده
   * نگه می‌دارد. ⚠ این پروفایل‌ها ‎-javaagent:authlib-injector‎ و یک ‎-D…prefetched=‎
   * بسیار طولانی هم دارند؛ بازنویسیِ کاملِ javaArgs اسکینِ همه را از کار می‌انداخت.
   */
  function setProfileRam(key, mb) {
    try {
      var lp = J(MC, "launcher_profiles.json");
      var obj = readProfiles();
      if (!obj.profiles || !obj.profiles[key]) return false;
      var args = String(obj.profiles[key].javaArgs || "");
      args = args.replace(/(^|\s)-Xmx\s*\d+\s*[gGmMkK]?(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
      if (mb > 0) args = (args ? args + " " : "") + "-Xmx" + mb + "M";
      if (args) obj.profiles[key].javaArgs = args; else delete obj.profiles[key].javaArgs;
      Ext.writeText(lp, JSON.stringify(obj));
      return true;
    } catch (_) { return false; }
  }
  POLY.instance_update = function (a) {
    var id = String((a && a.id) || "");
    var patch = (a && a.patch) || {};
    var ramGiven = Object.prototype.hasOwnProperty.call(patch, "ram");
    if (ramGiven && id) {
      var mb = Number(patch.ram || 0) || 0;
      setProfileRam(id, mb);
    }
    // بقیه‌ی فیلدها (نام/آیکن/…) همچنان کارِ نیتیو است؛ فقط RAM را خودمان می‌نویسیم.
    return nativeForceInvoke("instance_update", a || {}).then(function (r) {
      var out = (r && typeof r === "object") ? r : {};
      if (!out.id) out.id = id;
      out.ram = id ? profileRamMb(id) : (Number(patch.ram || 0) || 0);
      return out;
    }).catch(function () {
      return { id: id, ram: id ? profileRamMb(id) : 0 };
    });
  };

  function instanceIsOptifine(it) {
    try {
      var v = String((it && (it.version || it.base_version)) || "");
      if (!v) return false;
      if (/optifine/i.test(v)) return true;
      return Ext.exists(optifineMarkerPath(v));
    } catch (_) { return false; }
  }
  POLY.instance_list = function (a) {
    try { pruneDefaultProfileOnce(); } catch (_) {}
    return nativeForceInvoke("instance_list", a || {}).then(function (list) {
      if (!Array.isArray(list)) return list;
      return list.filter(function (it) {
        if (!it) return false;
        var ver = String(it.version || it.base_version || "");
        return !(String(it.name || "") === "Default" && ver === "1.7.10");
      }).map(function (it) {
        if (instanceIsOptifine(it)) it.optifine = true;
        // RAM را از همان جایی بخوان که JVM می‌خواند (‎-Xmx‎ در javaArgs)، وگرنه فیلدِ
        // تنظیمات بعد از ذخیره دوباره خالی/صفر نشان داده می‌شود چون نیتیو ram ندارد.
        try {
          var mb = profileRamMb(it.id);
          if (mb > 0) it.ram = mb;
        } catch (_) {}
        return it;
      });
    });
  };

  /**
   * قبل از هر اجرای بازی، وضعیتِ تماس را همین حالا (همگام) به بومی برسان.
   *
   * پرچمِ mihan_voice_active تنها چیزی است که به ContextAwareDoneListenerِ پچ‌شده می‌گوید
   * پروسه‌ی ":launcher" را موقعِ اجرای بازی نکشد، و سرویسِ میکروفون را هم همان می‌گیرد.
   * ولی این پرچم فقط از داخلِ setInterval یک‌ثانیه‌ای voicePush ست می‌شد. اگر کاربر وارد
   * روم شود و در همان کمتر از یک ثانیه دکمه‌ی اجرا را بزند، پرچم هنوز false است → پروسه
   * کشته می‌شود → تماس همان لحظه قطع می‌شود:
   *   «وقتی میرم داخل بازی تو گفتگوی رفیقمم صدا قطع میشه» (گزارش ۵۴۵۲)
   * setVoiceActive از commit() استفاده می‌کند (نه apply)، پس یک push همین‌جا کافی است.
   */
  function flushVoiceStateBeforeLaunch() {
    try { voicePush(); } catch (_) {}
  }

  /**
   * رمِ پروفایل را به تنظیمی می‌برد که موتور واقعاً می‌خواند.
   *
   * چرا لازم است: setProfileRam مقدار را به‌صورتِ ‎-Xmx‎ در javaArgs پروفایل می‌نویسد، ولی
   * JREUtils هنگامِ ساختِ آرگومان‌ها صریحاً purgeArg(list, "-Xmx") می‌زند — یعنی هر ‎-Xmx‎ی
   * که ما نوشته باشیم دور ریخته می‌شود و بعد مقدارِ خودش را از تنظیمِ allocation می‌گذارد.
   * پس رمِ هر پروفایل از ابتدا بی‌اثر بوده: کاربر عدد را عوض می‌کرد، ذخیره هم می‌شد، و بازی
   * با همان allocationِ قبلی بالا می‌آمد. در گزارش‌ها این «رم رو عوض می‌کنم، خودش برمی‌گرده
   * روی ۲۰۰۰» است — که ۲۰۰۰ همان allocationِ دست‌نخورده بود.
   *
   * پروفایلی که رم ندارد allocation را دست نمی‌زند، تا مقدارِ سراسریِ کاربر سرِ جایش بماند.
   */
  function applyProfileRamToEngine(pid) {
    try {
      if (!pid || !Ext || !Ext.pojavPrefSet) return;
      var mb = profileRamMb(pid);
      if (!(mb > 0)) return;
      Ext.pojavPrefSet("allocation", "int", String(mb));
    } catch (_) {}
  }

  POLY.instance_launch = function (a) {
    flushVoiceStateBeforeLaunch();
    var requested = String((a && a.id) || "");
    // اولین اجرا بعدِ به‌روزرسانی: محتوای مشترکِ فعلی به همین پروفایل منتقل می‌شود (اگر کاربر
    // دارد آن را اجرا می‌کند، همان پروفایلِ «اصلی»ِ اوست) و gameDirِ همه‌ی پروفایل‌ها ست می‌شود.
    try { ensurePerProfileLayout(requested); } catch (_) {}
    try { ensureProfileDir(requested); } catch (_) {}
    try { ensureNoPerfMods(requested); } catch (_) {}
    try { ensureAuthlibInjector(requested); } catch (_) {}
    try { ensureJavaOverride(requested); } catch (_) {}
    try { ensureCustomSkinLoaderMod(requested); } catch (_) {}
    // دو مسیرِ اجرا وجود دارد و رمِ پروفایل باید در هر دو اعمال شود: کارتِ پروفایل از همین
    // instance_launch می‌رود و دکمه‌ی خانه از launch_game. اولین اصلاح فقط دومی را گرفته بود،
    // که یعنی همان راهی که بیشتر کاربرها از آن اجرا می‌کنند هنوز رم را نادیده می‌گرفت.
    try { applyProfileRamToEngine(requested); } catch (_) {}
    // Minecraft 26.x needs LWJGL 3.4.1 (and the vma/shaderc natives that come with it); every
    // earlier version stays on the 3.3.3 shim. Swapping the set is a directory swap plus one
    // JVM arg — see MihanLwjgl. Done here, before the version is resolved and handed to native,
    // so the classpath Tools builds from DIR_GAME_HOME/lwjgl3 is already the right one.
    try { ensureLwjglForProfile(requested); } catch (_) {}
    // MIHAN-LAUNCH-GATE: stage first, then hand the caller's OWN id to native untouched —
    // native owns its instance store and must get back exactly what the UI gave us.
    return repairShadowFabric(requested).then(function () {
      return resolveLaunchVersion(requested);
    }).then(function (versionId) {
      try { ensureOptifineMod(versionId, requested); } catch (_) {}
      return prepareForLaunch(versionId);
    }).then(function () {
      return ensurePojavLibRewrites();
    }).then(function () {
      // شناسه‌ی حساب را تازه کن و rootِ CustomSkinLoader را با آن بازنویس، وگرنه بعد از
      // ورود به حساب تا اجرای بعدی هنوز rootِ عمومی نوشته شده بود.
      return refreshCslId().then(function () { try { ensureCustomSkinLoaderMod(requested); } catch (_) {} });
    }).then(function () {
      return nativeForceInvoke("instance_launch", { id: requested });
    });
  };

  function J(/*...parts*/) { return Array.prototype.filter.call(arguments, function (x) { return x != null && x !== ""; }).join("/").replace(/\/+/g, "/"); }
  function shortHash(s) {
    var h = 2166136261, str = String(s || "");
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  // شناسه‌ی فایل‌سیستمی از نام نمایشی جداست: نام فارسی یکتا می‌ماند و مقادیر خطرناک
  // مثل . و .. هیچ‌وقت نمی‌توانند از پوشه‌ی servers بیرون بروند.
  function safeName(s) {
    var raw = String(s == null ? "" : s).trim();
    if (/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(raw) && raw !== "." && raw !== "..") return raw;
    var slug = raw.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    if (!slug) slug = "server";
    slug = slug.slice(0, 46);
    return slug + "_" + shortHash(raw || "server");
  }
  function validateServerName(s) {
    var raw = String(s == null ? "" : s).trim();
    if (!raw) throw new Error("یک نام برای سرور وارد کن");
    if (raw === "." || raw === ".." || /[\\/\x00-\x1f]/.test(raw)) throw new Error("این نام برای سرور قابل استفاده نیست");
    if (raw.length > 48) throw new Error("نام سرور باید حداکثر ۴۸ نویسه باشد");
    return raw;
  }
  function baseName(p) { p = String(p).replace(/\\/g, "/"); var i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }
  function stem(p) { var b = baseName(p); var i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; }

  // sandbox base for fs_* : server folder, instance folder, or the shared mc dir
  //
  // The instance branch used to point at J(INST, instance, ".minecraft"). INST is INTERNAL
  // storage (files/instances) while the game — and every installer in this file — runs out of
  // the EXTERNAL per-profile dir, so that path was an empty folder nothing ever wrote to. The
  // in-app file browser therefore showed nothing for a profile: no mods, no plugins, no config.
  // That is the "قسمت مود تو فایل‌ها نمیاد" / "اسم فایل‌های سرور معلوم نیست" cluster.
  // content_installed had already been corrected the same way; this one was missed.
  function fsBase(name, instance) {
    if (name) return J(DATA, "servers", safeName(name));
    if (instance) return ensureProfileDir(instance);
    return MC;
  }
  function serverDir(name) { return J(DATA, "servers", safeName(name)); }

  // ── HTTP / دانلود — همه از mihan-download.js ─────────────────────────────
  // پلِ بومی (window.__mihanHttp / __mihanDownloadProgress) و صفِ دانلود آن‌جا
  // ثبت می‌شوند؛ اینجا فقط alias می‌گیریم تا دو مالکِ رقیب برای یک کال‌بکِ سراسری
  // وجود نداشته باشد.
  var javaHttp = DL.javaHttp;
  var getText = DL.getText;
  var getJson = DL.getJson;
  var postJson = DL.postJson;
  var downloadTo = DL.downloadFile;
  var rconCommand = DL.rconCommand;
  // authed POST: server expects the token inside the JSON body
  function authPost(path, body) {
    return postJson(accountBase() + path, Object.assign({ token: accountToken() }, body || {}));
  }

  // نگهداریِ وضعیتِ لغو در mihan-download.js است (همان جایی که صفِ دانلود زندگی می‌کند)؛
  // این‌جا فقط برای خواندن alias می‌گیریم تا نصبِ سرور بتواند «لغو» را از «خطا» تشخیص دهد.
  function isCancelled(token) { return DL.isCancelled(token); }

  // authlib-injector: makes any launched game load skins/capes from MihanCraft's own
  // Yggdrasil-compatible endpoint (auth-server/server.py already serves real textures.SKIN/
  // CAPE payloads — nothing on Android ever told the JVM to look there). Exact same jar +
  // prefetched-metadata approach the desktop launcher and PvP client already use (see
  // src-tauri/src/launcher.rs's "-javaagent:...authlib-injector" wiring and
  // src-tauri/src/authlib_prefetched.txt, embedded verbatim below so Java on old/offline
  // devices never has to fetch it live and hit "PKIX path building failed").
  var AUTHLIB_PREFETCHED = "eyJtZXRhIjogeyJzZXJ2ZXJOYW1lIjogIk1paGFuQ3JhZnQiLCAiaW1wbGVtZW50YXRpb25OYW1lIjogIm1paGFuY3JhZnQteWdnZHJhc2lsIiwgImltcGxlbWVudGF0aW9uVmVyc2lvbiI6ICIxLjAiLCAiZmVhdHVyZS5ub25fZW1haWxfbG9naW4iOiB0cnVlfSwgInNraW5Eb21haW5zIjogWyJhdXRoLm1paGFuY3JhZnQuY29tIiwgIi5taWhhbmNyYWZ0LmNvbSJdLCAic2lnbmF0dXJlUHVibGlja2V5IjogIi0tLS0tQkVHSU4gUFVCTElDIEtFWS0tLS0tXG5NSUlDSWpBTkJna3Foa2lHOXcwQkFRRUZBQU9DQWc4QU1JSUNDZ0tDQWdFQXRBT0N3RkFUZXVOSXZJanRaQitJXG5BVm85MHFVbjRhQ2ZuaVhVZlZjSEkwclJkWlhaSnE0R0szU0cwRi9JV3EwWnZ4cjVOcnJGZVpOM2ZYRFArdzFNXG5XZERHcGVESXR5NUN3dit2cmhjVmkvT2lxQksvYUVyT1FoNmV2bFNmanlraUNMMk9qVDFYYllieHA0Nlo1aFprXG4yZmdxSy9vY215Q0QwZ0lhemNUSHhZRlgyK2VFdmkveUZBbFhxeVhadjFVUW9xNmJmRWc1OVZUYXlPMzYwY2N1XG5CVTZDTUNyZmRRdHd3TG03WW5NNmpvL3N4Y2xxM1JvcDJhNHJYd3lJK1NkYUh1ZGNabTlsVWpmUHVuNDNiUllhXG42cEthTkQ1TnBiOVMwMDhJUjlqcnVVTmR3aWZBVEJxenM4WTk5aXdscTBHNG01ZXUrbG9NVGc1NmhtSnZ2OUxmXG4rUXpVNmtTNzB0Q2ZxNG9KcnNiYTI5a01IV3FwUnl1b0ZHOUdOVVFSMWFUVjMwR2tHN3lvUFJtR255bWdveUMwXG50a01TL2hlUWM3ZG9LZ1I0YlRZM1B3WmNFQ2pDQk5rZVNJdnVmOTNEb3RuK2g3TFpTbUF4UU16dTNyRHpFeUIvXG5WVVZsR2pxVG5FRk8xNEE2R1NaZ0tEQTBYQ3h0aC9vVGZRc0FkTlFaR1VHSlU0SUZla0Zxd3VVQmhCR2dNdzRYXG5HTXRXQjkxaTBxS0l6S2VQZkJTOExZeGhhT2JBTEYvVTdiZnZIUXRwbThJREU2VTAySGlrb2htWjRuV2FsQ2N6XG5adWRxQWFTTHcvemd3QUFJNXBJZWwzVkQzSCt1bkxPN0d3OStZZnJlNHAwR0ZmUUlHaThLaUlGVEV1MDVKNURrXG5vMUIwYkR5ZStMQ2VsZ0IwTXJDZng5OENBd0VBQVE9PVxuLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tXG4iLCAic2lnbmF0dXJlUHVibGljS2V5IjogIi0tLS0tQkVHSU4gUFVCTElDIEtFWS0tLS0tXG5NSUlDSWpBTkJna3Foa2lHOXcwQkFRRUZBQU9DQWc4QU1JSUNDZ0tDQWdFQXRBT0N3RkFUZXVOSXZJanRaQitJXG5BVm85MHFVbjRhQ2ZuaVhVZlZjSEkwclJkWlhaSnE0R0szU0cwRi9JV3EwWnZ4cjVOcnJGZVpOM2ZYRFArdzFNXG5XZERHcGVESXR5NUN3dit2cmhjVmkvT2lxQksvYUVyT1FoNmV2bFNmanlraUNMMk9qVDFYYllieHA0Nlo1aFprXG4yZmdxSy9vY215Q0QwZ0lhemNUSHhZRlgyK2VFdmkveUZBbFhxeVhadjFVUW9xNmJmRWc1OVZUYXlPMzYwY2N1XG5CVTZDTUNyZmRRdHd3TG03WW5NNmpvL3N4Y2xxM1JvcDJhNHJYd3lJK1NkYUh1ZGNabTlsVWpmUHVuNDNiUllhXG42cEthTkQ1TnBiOVMwMDhJUjlqcnVVTmR3aWZBVEJxenM4WTk5aXdscTBHNG01ZXUrbG9NVGc1NmhtSnZ2OUxmXG4rUXpVNmtTNzB0Q2ZxNG9KcnNiYTI5a01IV3FwUnl1b0ZHOUdOVVFSMWFUVjMwR2tHN3lvUFJtR255bWdveUMwXG50a01TL2hlUWM3ZG9LZ1I0YlRZM1B3WmNFQ2pDQk5rZVNJdnVmOTNEb3RuK2g3TFpTbUF4UU16dTNyRHpFeUIvXG5WVVZsR2pxVG5FRk8xNEE2R1NaZ0tEQTBYQ3h0aC9vVGZRc0FkTlFaR1VHSlU0SUZla0Zxd3VVQmhCR2dNdzRYXG5HTXRXQjkxaTBxS0l6S2VQZkJTOExZeGhhT2JBTEYvVTdiZnZIUXRwbThJREU2VTAySGlrb2htWjRuV2FsQ2N6XG5adWRxQWFTTHcvemd3QUFJNXBJZWwzVkQzSCt1bkxPN0d3OStZZnJlNHAwR0ZmUUlHaThLaUlGVEV1MDVKNURrXG5vMUIwYkR5ZStMQ2VsZ0IwTXJDZng5OENBd0VBQVE9PVxuLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tXG4ifQ==";
  var _authlibJarPath = null;
  function authlibJarPath() {
    if (!_authlibJarPath) _authlibJarPath = Ext.ensureAuthlibInjectorJar();
    return _authlibJarPath;
  }
  /** Appends the authlib-injector agent args to one profile object in place. Additive
   *  (keeps whatever javaArgs — RAM, etc. — was already there) and idempotent. Returns
   *  true if it actually changed anything, so callers only rewrite the file when needed. */
  function addAuthlibArgs(p) {
    var jar = authlibJarPath();
    if (!jar) return false; // asset missing/copy failed — never block a launch over this
    var existing = String(p.javaArgs || "");
    if (existing.indexOf("authlib-injector") !== -1) return false; // already wired
    var agentArgs = "-Dauthlibinjector.yggdrasil.prefetched=" + AUTHLIB_PREFETCHED +
      " -javaagent:" + jar + "=https://auth.mihancraft.com/yggdrasil";
    p.javaArgs = existing ? (existing + " " + agentArgs) : agentArgs;
    return true;
  }
  function ensureAuthlibInjector(ref) {
    try {
      var lp = J(MC, "launcher_profiles.json");
      var obj = JSON.parse(Ext.readText(lp) || "{}");
      if (!obj.profiles) obj.profiles = {};
      var r = resolveProfileRef(ref);
      var key = r.key;
      if (!key) {
        // No profile tracks this version yet (its very first launch) — find-or-create by
        // lastVersionId, the exact same shape instance_create already uses below.
        var vid = r.version || String(ref || "");
        if (!vid) return;
        key = Object.keys(obj.profiles).filter(function (k) { return obj.profiles[k].lastVersionId === vid; })[0];
        if (!key) { key = genUuid(); obj.profiles[key] = { lastVersionId: vid }; }
      }
      if (addAuthlibArgs(obj.profiles[key])) Ext.writeText(lp, JSON.stringify(obj));
    } catch (_) {}
  }
  /**
   * Pojav's native LauncherProfiles manager loads launcher_profiles.json into memory of
   * its own — confirmed on-device that it does this early (before any profile is ever
   * launched) and later writes its OWN in-memory copy back out (e.g. to bump lastUsed),
   * silently discarding any edit our JS made to the file in between. Patching a profile's
   * javaArgs right before instance_launch/launch_game (still done below, for profiles
   * created mid-session) therefore isn't reliably in time — testing showed the edit gets
   * wiped by the time the game actually boots. Patching every EXISTING profile here, at
   * script load (i.e. before native gets its first chance to load the file this session),
   * closes that race for the common case. Belt-and-suspenders with the per-launch calls,
   * not a replacement for them. */
  function ensureAuthlibInjectorAllProfiles() {
    try {
      var lp = J(MC, "launcher_profiles.json");
      if (!Ext.exists(lp)) return;
      var obj = JSON.parse(Ext.readText(lp) || "{}");
      if (!obj.profiles) return;
      var changed = false;
      Object.keys(obj.profiles).forEach(function (k) {
        if (addAuthlibArgs(obj.profiles[k])) changed = true;
      });
      if (changed) Ext.writeText(lp, JSON.stringify(obj));
    } catch (_) {}
  }
  ensureAuthlibInjectorAllProfiles();

  // ── Pojav Java-runtime override ("تنظیمات پوجاو" in Settings) ──────────────────────────
  // javaDir is a plain per-profile field that NOTHING native ever overwrites (unlike renderer —
  // see the MIHAN PATCH note in McCommands.smali/tuneMobileGraphics for why that one needed a
  // smali patch instead), so a normal JS-side stamp is enough here. Same native
  // load-then-write-back race as launcher_profiles.json above (see ensureAuthlibInjectorAllProfiles's
  // comment) still applies, hence the same belt-and-suspenders shape: a bulk pass at script load,
  // plus a per-profile call right before each launch.
  function javaOverrideMajor() { return String(cfgGet("pojav_java_override", "") || ""); }
  // MihanPvP is hardcoded to Java 8 (Forge 1.8.9 requires it) — a global override must never touch it.
  function isPvpProfileKey(key) { return key === PVP_PROFILE_UUID; }
  function applyJavaOverride(p) {
    var want = javaOverrideMajor();
    if (!want) {
      if (!p.javaDir) return false;
      delete p.javaDir;
      return true;
    }
    var wantDir = "pojav://Internal-" + want;
    if (p.javaDir === wantDir) return false;
    p.javaDir = wantDir;
    return true;
  }
  function ensureJavaOverrideAllProfiles() {
    try {
      var lp = J(MC, "launcher_profiles.json");
      if (!Ext.exists(lp)) return;
      var obj = JSON.parse(Ext.readText(lp) || "{}");
      if (!obj.profiles) return;
      var changed = false;
      Object.keys(obj.profiles).forEach(function (k) {
        if (isPvpProfileKey(k)) return;
        if (applyJavaOverride(obj.profiles[k])) changed = true;
      });
      if (changed) Ext.writeText(lp, JSON.stringify(obj));
    } catch (_) {}
  }
  ensureJavaOverrideAllProfiles();
  function ensureJavaOverride(ref) {
    try {
      var lp = J(MC, "launcher_profiles.json");
      var obj = JSON.parse(Ext.readText(lp) || "{}");
      if (!obj.profiles) obj.profiles = {};
      var r = resolveProfileRef(ref);
      var key = r.key;
      if (!key || isPvpProfileKey(key)) return;
      if (applyJavaOverride(obj.profiles[key])) Ext.writeText(lp, JSON.stringify(obj));
    } catch (_) {}
  }

  // ── in-game voice panel: keep-alive flag + state pushes ────────────────────────────────
  // Two jobs, both Android-only (hence living here rather than in the shared app.js):
  //
  //  1. Tell the native side whether a call is in progress. Upstream Pojav kills THIS process
  //     (":launcher") the instant a game launches, to free RAM — which also kills the WebSocket,
  //     AudioContext and mic capture that make up the call, and is the real cause of the
  //     long-standing "voice cuts out when I enter the game" reports. ContextAwareDoneListener is
  //     patched to skip that kill, but only while this flag is set, so players who aren't on a
  //     call still get the RAM back.
  //
  //  2. Push call state out to the floating panel MihanVoicePanel draws over the game. The panel
  //     lives in the ":game" process and so cannot read any of this directly — see
  //     MihanVoiceBridge's class doc for the broadcast contract.
  //
  // Polling window.__mihanVoiceState() (defined in app.js) rather than hooking every mutation
  // keeps this decoupled: app.js stays a shared file with no Android-specific calls in it.
  var _voiceLastJson = null;
  var _voiceLastPush = 0;
  var _voiceActiveFlag = null;
  function voicePush() {
    if (!Ext || !Ext.publishVoiceState) return;
    var state = null;
    try { state = window.__mihanVoiceState && window.__mihanVoiceState(); } catch (_) { state = null; }
    var json = state ? JSON.stringify(state) : "";
    var now = Date.now();
    // Re-push unchanged state every second anyway: the panel treats a gap as "call is gone"
    // (its staleness watchdog), and a silent-but-live call must not trip that.
    if (json === _voiceLastJson && (now - _voiceLastPush) < 1000) return;
    _voiceLastJson = json;
    _voiceLastPush = now;
    try { Ext.publishVoiceState(json); } catch (_) {}
    var active = !!(state && state.inRoom);
    if (active !== _voiceActiveFlag) {
      _voiceActiveFlag = active;
      try { Ext.setVoiceActive(active); } catch (_) {}
    }
  }
  // Let the native bridge ask for an immediate snapshot (the panel does this the moment it
  // attaches, instead of waiting out a tick).
  window.__mihanVoicePush = function () { _voiceLastJson = null; voicePush(); };
  // __mihanVoiceDeafToggle deliberately does NOT live here. It was defined in this file at first
  // and could never have worked: app.js is loaded as <script type="module">, so its setDeaf() and
  // Voice are module-scoped and invisible from this classic script. It now sits in app.js beside
  // __mihanVoiceMuteToggle / __mihanVoiceLeave, which are exposed the same way for the same reason.
  setInterval(voicePush, 1000);
  // Clear the keep-alive flag if this process is going away for any other reason, so a crash
  // mid-call can't leave it stuck on and defeat the RAM saving on every later launch.
  window.addEventListener("pagehide", function () {
    try { if (_voiceActiveFlag) Ext.setVoiceActive(false); } catch (_) {}
  });

  // ── CustomSkinLoader: the fix that actually works for custom skins/capes ───────────────
  // authlib-injector (above) never worked — real-device testing confirmed Minecraft's own
  // latest.log shows zero trace of it (success or failure) under every reachable injection
  // point, meaning Pojav's native MainActivity creates the embedded JVM before anything on
  // our side can set -javaagent/JAVA_TOOL_OPTIONS in time (see MihanAuthlib.java's doc for
  // the full trail). CustomSkinLoader is the standard alternative comparable Android MC
  // launchers ship instead: a client-side MOD that hooks the game's OWN skin-rendering code
  // directly, so it only needs a mod loader present (Forge/NeoForge/Fabric/Quilt) — no
  // JVM-agent, no timing race. auth-server/server.py already serves the exact protocol this
  // mod's "CustomSkinAPI" loader expects (cross-checked against the mod's own bytecode:
  // GET <root><username>.json → {username, textures:{default|slim, cape}}, GET
  // <root>textures/<hash> → raw PNG — h_csl_profile/h_csl_texture match this exactly).
  var CSL_JAR_NAME = "CustomSkinLoader_Universal.jar";
  /**
   * rootِ حساب‌محور. اسکین‌ها روی سرور با «یوزرنیمِ ماینکرفت» کلید می‌خورند، ولی در بازیِ
   * آفلاین چند کاربرِ متفاوت می‌توانند یک یوزرنیم داشته باشند. اگر root ساده‌ی «/csl/» باشد،
   * همه‌ی آن کاربرها مجبورند یک اسکینِ مشترک داشته باشند و عملاً اولین نفری که نام را
   * می‌گرفت مالکش می‌شد. با گذاشتنِ شناسه‌ی حسابِ لانچر داخلِ خودِ root، سرور می‌فهمد
   * «این درخواست از طرفِ کدام حساب است» و نسخه‌ی همان حساب را برمی‌گرداند
   * (نگاه کن به h_csl_profile در auth-server/server.py). اگر هنوز وارد حساب نشده باشیم به
   * همان مسیرِ عمومی برمی‌گردیم.
   */
  function cslRoot() {
    var base = String(accountBase() || "https://auth.mihancraft.com").replace(/\/+$/, "");
    var id = cfg().csl_id;
    return id ? (base + "/csl/a/" + id + "/") : (base + "/csl/");
  }
  /** شناسه‌ی حسابِ لانچر را یک‌بار از /api/me می‌گیرد و در کانفیگ نگه می‌دارد. */
  function refreshCslId() {
    try {
      if (!accountToken()) return Promise.resolve(null);
      if (cfg().csl_id) return Promise.resolve(cfg().csl_id);
      return postJson(accountBase() + "/api/me", { token: accountToken() })
        .then(function (r) {
          if (!r || !r.csl_id) return null;
          return setCfg("csl_id", r.csl_id).then(function () { return r.csl_id; });
        }).catch(function () { return null; });
    } catch (_) { return Promise.resolve(null); }
  }
  var _cslJarPath = null;
  function cslJarPath() {
    if (!_cslJarPath) _cslJarPath = (Ext.ensureCustomSkinLoaderJar && Ext.ensureCustomSkinLoaderJar()) || null;
    return _cslJarPath;
  }
  /** Places the mod jar in the shared mods/ folder (the SAME global dir every modded profile
   *  launches from — see installModrinth's comment above) and wires our skin API into its
   *  config, additive/idempotent like addAuthlibArgs above. Skipped for the PvP client: its
   *  own profile shares this same mods/ folder (see pvp_launch below) but already has a
   *  bespoke cosmetics system (Cape.java/CosmeticsNet.java) — pvp_launch defensively removes
   *  this jar right before it launches so the two never both patch that client's rendering. */
  /**
   * پروفایل‌هایی که «وانیلا» ساخته شده‌اند ولی Fabricِ زیرِپوستی نگرفته‌اند را ترمیم می‌کند.
   *
   * ساختِ پروفایلِ وانیلا عمداً Fabric را هم نصب می‌کند، چون CustomSkinLoader یک مادِ Fabric
   * است و بدونِ لودر اصلاً بارگذاری نمی‌شود — یعنی اسکین/شنلِ سفارشی روی آن پروفایل هیچ‌وقت
   * نمی‌آید. آن مسیر از fabric_loaders → dirEntries می‌گذرد، و در ۳۰ ژوئیه تا ۱ اوت که
   * فهرست‌گیریِ CDN با «Options -Indexes» خراب بود، همیشه لیستِ خالی برمی‌گشت و به
   * وانیلای واقعی عقب‌نشینی می‌کرد. آن پروفایل‌ها خودشان درست نمی‌شوند — نسخه از قبل
   * نصب شده و ساخت دوباره اجرا نمی‌شود. (رفع سمتِ CDN فقط جلوی ساخته شدنِ پروفایلِ خرابِ
   * جدید را می‌گیرد.)
   *
   * فقط وقتی کار می‌کند که پروفایل هیچ لودری نداشته باشد، و هر خطایی را می‌بلعد: ترمیمِ
   * ناموفق نباید جلوی اجرای بازی را بگیرد.
   */
  function repairShadowFabric(instanceId) {
    if (!instanceId) return Promise.resolve();
    var mc = "";
    try {
      if (profileLoaderOf(instanceId)) return Promise.resolve();   // لودر دارد → کاری نکن
      var obj = JSON.parse(Ext.readText(J(MC, "launcher_profiles.json")) || "{}");
      var p = obj && obj.profiles && obj.profiles[instanceId];
      if (!p) return Promise.resolve();
      mc = String(p.lastVersionId || "");
      // فقط یک نسخه‌ی خامِ ماینکرفت مثلِ «1.21.4»؛ هر چیزِ دیگری را دست نمی‌زنیم.
      if (!/^\d+\.\d+(\.\d+)?$/.test(mc)) return Promise.resolve();
    } catch (_) { return Promise.resolve(); }
    return POLY.fabric_loaders({ mcVersion: mc }).then(function (list) {
      var lv = (list && list[0] && ((list[0].loader && list[0].loader.version) || list[0].version)) || "";
      if (!lv) return null;                                        // این نسخه Fabric ندارد (پیش از ۱٫۱۴)
      return POLY.install_fabric({ mcVersion: mc, loaderVersion: lv,
                                   token: "shadow-" + instanceId, makeProfile: false })
        .then(function () { return "fabric-loader-" + lv + "-" + mc; });
    }).then(function (newId) {
      if (!newId) return;
      // از راهِ مدلِ بومی، وگرنه بازنویسیِ بعدیِ Pojav این را دور می‌ریزد (نگاه کن به MihanProfiles).
      var done = false;
      try { if (Ext.reloadProfiles) Ext.reloadProfiles(); } catch (_) {}   // see ensureProfileDir
      try { done = !!(Ext.setProfileField && Ext.setProfileField(instanceId, "lastVersionId", newId)); } catch (_) {}
      if (!done) {
        try {
          var lp = J(MC, "launcher_profiles.json");
          var o = JSON.parse(Ext.readText(lp) || "{}");
          if (o && o.profiles && o.profiles[instanceId]) {
            o.profiles[instanceId].lastVersionId = newId;
            Ext.writeText(lp, JSON.stringify(o));
            if (Ext.reloadProfiles) Ext.reloadProfiles();
          }
        } catch (_) {}
      }
      try { ensureCustomSkinLoaderMod(instanceId); } catch (_) {}
    }).catch(function () { /* CDN در دسترس نبود → همان وانیلا اجرا شود */ });
  }

  /**
   * انتخابِ ستِ LWJGL بر اساسِ نسخه‌ی واقعیِ ماینکرفتِ این پروفایل.
   *
   * ماینکرفتِ ۲۶ به LWJGL 3.4.1 رفت و علاوه بر آن vma/shaderc را هم پیش از خواندنِ هر تنظیمِ
   * گرافیکی لود می‌کند؛ شیمِ ۳.۳.۳ هیچ‌کدام را ندارد. ستِ ۳.۴.۱ همان شیم است ولی به‌روز —
   * CallbackBridge و glfwPlatformSupported هر دو داخلش هستند (نگاه کن به MihanLwjgl).
   *
   * برای نسخه‌های قدیمی‌تر عمداً روی ۳.۳.۳ می‌مانیم: آن‌ها سال‌هاست رویش تست شده‌اند و
   * بردنشان روی ۳.۴.۱ ریسکِ بی‌دلیل است.
   */
  function ensureLwjglForProfile(instanceId) {
    if (!Ext || !Ext.prepareLwjgl) return;
    // نصب‌کننده‌های این فایل launcher_profiles.json را مستقیم می‌نویسند، ولی پوجاو یک کپیِ
    // درون‌حافظه‌ای دارد و همان را برمی‌گرداند روی دیسک. بدونِ این reload، پروفایلِ تازه‌ساخته
    // در مدل نیست و setProfileField پایین بی‌اثر می‌ماند: روی دستگاه، نئوفورج/کوییلتِ ۲۶.۲ در
    // اولین اجرا بعدِ ساخت، بدونِ -Dorg.lwjgl.librarypath بالا می‌آمدند و با
    // «Failed to locate library: liblwjgl_vma.so» می‌مردند. پروفایلِ قدیمی‌تر که یک‌بار اپ بعدش
    // ری‌استارت شده بود سالم بود — و همین تفاوت باعث شد اول به‌نظر برسد مشکلِ لودر است.
    try { if (Ext.reloadProfiles) Ext.reloadProfiles(); } catch (_) {}
    var mc = "";
    try {
      var obj = JSON.parse(Ext.readText(J(MC, "launcher_profiles.json")) || "{}");
      var p = obj && obj.profiles && obj.profiles[instanceId];
      mc = String((p && p.lastVersionId) || "");
    } catch (_) { return; }
    // «مدرن» یعنی نام‌گذاریِ سال‌محورِ ۲۶ به بعد (26.2، 26w14a) — همان قالبی که
    // engineSupportsVersion هم می‌شناسد.
    var m = mc.match(/(?:^|[-_])(\d{2})[.w]/);
    var modern = !!(m && parseInt(m[1], 10) >= 26);
    var nativesDir = "";
    try { nativesDir = Ext.prepareLwjgl(modern) || ""; } catch (_) { return; }
    // LWJGL طبیعتاً natives را کنارِ APK می‌گردد؛ ستِ ۳.۴.۱ آن‌جا نیست، پس مسیرش را صریح بده.
    // Configuration.LIBRARY_PATH خودِ LWJGL همین کلید است.
    var FLAG = "-Dorg.lwjgl.librarypath=";
    try {
      var cur = Ext.getProfileField(instanceId, "javaArgs") || "";
      var kept = cur.split(/\s+/).filter(function (a) { return a && a.indexOf(FLAG) !== 0; });
      // برای همه‌ی نسخه‌ها، نه فقط ۲۶.x: ماژول stb حالا از ستِ ۳.۴.۱ می‌آید و شیم دیگر
      // نسخه‌ی خودش را ندارد، پس ۱.۲۱ هم بدون این مسیر، کتابخانه‌ی هم‌نسخه‌اش را پیدا نمی‌کند.
      if (nativesDir) kept.push(FLAG + nativesDir);
      var next = kept.join(" ");
      if (next !== cur) Ext.setProfileField(instanceId, "javaArgs", next);
    } catch (_) {}
  }

  function ensureCustomSkinLoaderMod(instanceId) {
    try {
      var jar = cslJarPath();
      if (!jar) return;
      // per-profile now: the jar has to sit in the mods folder of the profile actually being
      // launched, not the old shared one (see ensureProfileDir).
      var gdir = ensureProfileDir(instanceId);
      var modsDir = J(gdir, "mods");
      Ext.mkdirs(modsDir);
      var dest = J(modsDir, CSL_JAR_NAME);
      if (!Ext.exists(dest) || Ext.sizeOf(dest) !== Ext.sizeOf(jar)) Ext.copyInto(jar, dest);
      // توجه: نامِ محلی عمداً cslCfg است نه cfg — داخلِ این تابع cfg سایه‌ی تابعِ سراسریِ
      // cfg() می‌شد و cslRoot() که به آن نیاز دارد از کار می‌افتاد.
      var root = cslRoot();
      var cfgDir = J(gdir, "CustomSkinLoader");
      var cfgPath = J(cfgDir, "CustomSkinLoader.json");
      var cslCfg = null;
      try { cslCfg = JSON.parse(Ext.readText(cfgPath) || "null"); } catch (_) { cslCfg = null; }
      if (!cslCfg || typeof cslCfg !== "object") cslCfg = {};
      if (!Array.isArray(cslCfg.loadlist)) cslCfg.loadlist = [];
      var changed = false;
      // ورودیِ خودمان را پیدا کن و rootش را به‌روز نگه دار — بعد از ورود/خروج از حساب
      // شناسه عوض می‌شود و اگر فقط «اگر نبود اضافه کن» بود، rootِ کهنه برای همیشه می‌ماند.
      var mine = cslCfg.loadlist.filter(function (e) { return e && e.name === "MihanCraft"; })[0];
      if (!mine) {
        cslCfg.loadlist.push({ name: "MihanCraft", type: "CustomSkinAPI", root: root });
        changed = true;
      } else if (mine.root !== root || mine.type !== "CustomSkinAPI") {
        mine.type = "CustomSkinAPI"; mine.root = root; changed = true;
      }
      if (cslCfg.enableCape !== true) { cslCfg.enableCape = true; changed = true; }
      if (changed) { Ext.mkdirs(cfgDir); Ext.writeText(cfgPath, JSON.stringify(cslCfg)); }
    } catch (_) {}
  }
  // عمداً اینجا صدا زده نمی‌شود. قبلاً موقعِ بارگذاریِ اسکریپت و بدونِ شناسه‌ی پروفایل اجرا
  // می‌شد، که حالا یعنی نوشتنِ جار در پوشه‌ی mods مشترک — پوشه‌ای که بعد از جداسازی هیچ
  // پروفایلی از آن اجرا نمی‌شود. جار در مسیرِ لانچ (instance_launch/launch_game/pvp_launch)
  // داخلِ پوشه‌ی همان پروفایلی که اجرا می‌شود گذاشته می‌شود، که تنها جای مفیدش است.

  // ── آپتی‌فاین به‌صورتِ مادِ Forge (تا اسکینِ سفارشی رویش هم کار کند) ───────────
  // آپتی‌فاینِ «مستقل» با LaunchWrapper و --tweakClass optifine.OptiFineTweaker اجرا
  // می‌شود (نگاه کن به versions/optifine/<id>.json روی CDN). CustomSkinLoader اما فقط
  // چهار بوت‌استرپ دارد — fabric / forge(v1,v2) / neoforge — و هیچ ITweakerِ خامِ
  // LaunchWrapper ندارد (روی خودِ jar تأیید شد)، پس زیرِ آپتی‌فاینِ مستقل اصلاً
  // بارگذاری نمی‌شود. راهِ استاندارد (همان کاری که لانچرهای دسکتاپ می‌کنند): Forge را
  // پایه بگذار و خودِ آپتی‌فاین را به‌عنوانِ یک مادِ معمولی داخلِ mods بینداز — آن‌وقت
  // CSL از مسیرِ Forgeِ خودش بالا می‌آید و هر دو با هم کار می‌کنند.
  var OF_MARKER = ".mihan-optifine";
  function optifineInstallerName(mc, ver) {
    return "OptiFine_" + mc + "_" + String(ver || "").replace(/^OptiFine_/, "") + ".jar";
  }
  function optifineMarkerPath(versionId) { return J(MC, "versions", versionId, OF_MARKER); }
  // انبارِ مشترکِ جارهای آپتی‌فاین (کنارِ versions می‌ماند، نه داخلِ پوشه‌ی هیچ پروفایلی)
  var OF_STAGE = J(MC, "optifine-jars");
  /**
   * پوشه‌ی mods سراسری است (همه‌ی پروفایل‌ها از همان یکی اجرا می‌شوند — نگاه کن به
   * کامنتِ installModrinth)، پس جارِ آپتی‌فاینِ ۱٫۲۰٫۱ اگر آن‌جا بماند موقعِ اجرای یک
   * پروفایلِ ۱٫۱۲٫۲ هم بارگذاری می‌شود و بازی را می‌کشد. قبل از هر لانچ فقط جارِ متعلق
   * به همین پروفایل (از markerِ کنارِ version.json) نگه داشته می‌شود و بقیه پاک — دقیقاً
   * همان الگوی ensureNoPerfMods بالا.
   */
  function ensureOptifineMod(versionId, instanceId) {
    try {
      var want = "";
      try {
        var m = JSON.parse(Ext.readText(optifineMarkerPath(versionId)) || "null");
        want = (m && m.jar) || "";
      } catch (_) {}
      var modsDir = J(ensureProfileDir(instanceId), "mods");
      var entries;
      try { entries = JSON.parse(Ext.list(modsDir) || "[]"); } catch (_) { return; }
      entries.forEach(function (e) {
        var n = e && e.name;
        if (!n || !/^OptiFine_.*\.jar$/i.test(n) || n === want) return;
        try { Ext.del(J(modsDir, n)); } catch (_) {}
      });
      // و جارِ متعلق به این نسخه را از انبارِ مشترک داخلِ همین پروفایل بگذار (اگر نیست).
      if (want) {
        try {
          var dest = J(modsDir, want), src = J(OF_STAGE, want);
          if (!Ext.exists(dest) && Ext.exists(src)) { Ext.mkdirs(modsDir); Ext.copyInto(src, dest); }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ── کتابخانه‌هایی که خودِ Pojav موقعِ لانچ عوضشان می‌کند ──────────────────────
  // Tools.preProcessLibraries (در smaliِ APKِ پایه تأیید شد) دو کتابخانه را قبل از ساختنِ
  // کلاس‌پث به نسخه‌ی سازگار با اندروید بازنویسی می‌کند — در logcatِ یک اجرای واقعی:
  //   Library com.github.oshi:oshi-core:6.2.2 has been changed to version 6.3.0
  //   Library net.java.dev.jna:jna:5.12.1 has been changed to version 5.13.0
  // ولی استیجرِ ما همان چیزی را می‌گیرد که در version.json نوشته شده (6.2.2 / 5.12.1)، پس
  // مسیرِ بازنویسی‌شده فایلی ندارد و Tools.generateLaunchClassPath بی‌سروصدا ردش می‌کند:
  //   Ignored non-exists file: .../oshi-core-6.3.0.jar
  // نتیجه: oshi اصلاً روی کلاس‌پث نیست. وانیلا/فبریک زنده می‌مانند (فقط بخشِ سخت‌افزارِ
  // crash-report می‌شکند)، ولی زیرِ Forge به‌محضِ این‌که چیزی کلاسِ ارجاع‌دهنده به oshi را
  // ترنسفورم کند کشنده است — و تنها کسی که این کار را می‌کند آپتی‌فاین است. برای همین هر
  // پروفایلِ آپتی‌فاینِ ۱٫۱۷+ موقعِ بوت می‌مرد («Cannot find class oshi/hardware/CentralProcessor»)
  // در حالی که Forgeِ خالی سالم بود. oshi از ۱٫۱۷ به ماینکرفت اضافه شده، پس نسخه‌های
  // قدیمی‌تر اصلاً درگیرش نیستند.
  var JNA_REWRITE_REL = "net/java/dev/jna/jna/5.13.0/jna-5.13.0.jar";
  var OSHI_REWRITE_REL = "com/github/oshi/oshi-core/6.3.0/oshi-core-6.3.0.jar";
  /** هر دو فایل را سرِ جای موردِ انتظارِ Pojav می‌گذارد. بهترین-تلاش: هیچ خطایی نباید جلوی
   *  لانچ را بگیرد (بدونشان بازی همان رفتارِ قبلی را دارد، نه بدتر). */
  function ensurePojavLibRewrites() {
    var libs = J(MC, "libraries");
    var jobs = [];
    try {
      // oshi 6.3.0 روی CDNِ ایران نیست (۴۰۴) و maven مرکزی هم از ایران قابلِ اتکا نیست،
      // پس داخلِ خودِ APK باندل شده — نگاه کن به MihanPojavLibs.
      var dest = J(libs, OSHI_REWRITE_REL);
      if (!Ext.exists(dest) && Ext.ensureOshiJar) {
        var src = Ext.ensureOshiJar();
        if (src) Ext.copyInto(src, dest);
      }
    } catch (_) {}
    try {
      // jna 5.13.0 روی CDNِ ایران هست، پس همان‌جا از آن گرفته می‌شود.
      var jdest = J(libs, JNA_REWRITE_REL);
      if (!Ext.exists(jdest)) {
        jobs.push(downloadTo(CDN + "/minecraft-loaders/libraries/" + JNA_REWRITE_REL,
          jdest, "pojav-libs", "jna-5.13.0.jar", { silent: true }).catch(function () { return null; }));
      }
    } catch (_) {}
    return jobs.length ? Promise.all(jobs).catch(function () { return null; }) : Promise.resolve(null);
  }

  // Modrinth version resolution shared by mods/content/instance/plugin installers
  function modrinthPickFile(projectId, mcVersion, loader) {
    var q = accountBase; // unused; keep lints calm
    var url = "https://api.modrinth.com/v2/project/" + encodeURIComponent(projectId) + "/version";
    var params = [];
    if (mcVersion) params.push("game_versions=" + encodeURIComponent('["' + mcVersion + '"]'));
    if (loader) params.push("loaders=" + encodeURIComponent('["' + loader + '"]'));
    if (params.length) url += "?" + params.join("&");
    return getJson(url).then(function (versions) {
      if (!Array.isArray(versions) || !versions.length) throw new Error("نسخه‌ای برای این افزودنی پیدا نشد");
      var v = versions[0];
      var files = v.files || [];
      var f = files.filter(function (x) { return x.primary; })[0] || files[0];
      if (!f) throw new Error("فایلی برای دانلود نبود");
      return f;
    });
  }
  function contentSubdir(kind) {
    kind = String(kind || "").toLowerCase();
    if (kind === "shader" || kind === "shaderpack" || kind === "shaderpacks") return "shaderpacks";
    if (kind === "resourcepack" || kind === "resourcepacks") return "resourcepacks";
    return "mods";
  }

  // ═══════════════════════════════════════════════════════
  //  CATEGORY 1 — HTTP-backed (social, support, versions, mods…)
  // ═══════════════════════════════════════════════════════
  // سرور پاکت می‌فرستد: {ok:true, ads:{slot_id:{media,is_video,url}}}. این‌جا باید خودِ
  // نگاشتِ جایگاه‌ها برگردد، چون adCard با State.ads[slotId] سراغش می‌رود — با برگرداندنِ
  // کلِ پاکت، State.ads فقط {ok, ads} می‌شد و هیچ جایگاهی پیدا نمی‌شد، یعنی روی اندروید
  // هیچ‌وقت هیچ تبلیغی نشان داده نمی‌شد.
  POLY.ads_active = function () {
    return getJson(accountBase() + "/api/ads/active")
      .then(function (r) { return (r && r.ads) || {}; })
      .catch(function () { return {}; });
  };
  POLY.social_poll = function () { return authPost("/api/social/poll", {}); };
  POLY.social_prefs_get = function () { return authPost("/api/social/prefs", {}); };
  // /api/social/prefs ده تنظیم دارد (پیام/تماس، غریبه‌ها، سیاستِ افزودن به گروه، و پنج
  // نوعِ رسانه برای کاربرِ طلایی) ولی این‌جا فقط دوتای اول فرستاده می‌شد — یعنی بقیه از روی
  // اندروید اصلاً قابلِ تغییر نبودند. سرور هر کلیدی را که نفرستیم دست‌نخورده نگه می‌دارد،
  // پس فقط کلیدهایی را می‌فرستیم که واقعاً داده شده‌اند (به‌روزرسانیِ جزئی سالم می‌ماند).
  POLY.social_prefs_set = function (a) {
    a = a || {};
    var body = {};
    var MAP = {
      dmEnabled: "dm_enabled",
      callsEnabled: "calls_enabled",
      dmFromStrangers: "dm_from_strangers",
      callsFromStrangers: "calls_from_strangers",
      dmVoiceFromStrangers: "dm_voice_from_strangers",
      dmPostsFromStrangers: "dm_posts_from_strangers",
      dmImagesFromStrangers: "dm_images_from_strangers",
      dmVideosFromStrangers: "dm_videos_from_strangers",
      dmFilesFromStrangers: "dm_files_from_strangers",
    };
    Object.keys(MAP).forEach(function (k) { if (a[k] !== undefined) body[MAP[k]] = !!a[k]; });
    if (a.groupAddPolicy !== undefined) body.group_add_policy = String(a.groupAddPolicy || "everyone");
    return authPost("/api/social/prefs", body);
  };
  POLY.block_list = function () { return authPost("/api/block/list", {}); };
  POLY.admin_delete_cosmetic = function (a) { return authPost("/api/admin/cosmetics/delete", { id: a.id }); };
  POLY.cape_gallery = function () { return getJson(accountBase() + "/api/cape/list").catch(function () { return []; }); };

  // هر لینکِ پرداخت/بیرونی باید به مرورگرِ سیستم برود. window.open این کار را نمی‌کند
  // (نه onCreateWindow داریم نه setSupportMultipleWindows) و فقط همین WebView را می‌برد؛
  // درگاهِ زیبال آن‌وقت اوریجینِ appassets را می‌بیند و «دامنه غیرمجاز» می‌دهد.
  function openExternal(url) {
    try {
      if (Ext && Ext.openExternal && Ext.openExternal(String(url))) return true;
    } catch (_) {}
    try { window.open(String(url), "_blank"); } catch (_) {}
    return false;
  }

  POLY.support_create = function (a) {
    var publicName = a.publicName == null ? true : !!a.publicName;
    return authPost("/api/support/create", { amount: a.amount, publicName: publicName }).then(function (res) {
      if (res && res.url) openExternal(res.url);
      return res;
    });
  };
  POLY.support_status = function (a) { return postJson(accountBase() + "/api/support/status", { trackId: a.trackId }); };
  POLY.support_list = function () { return postJson(accountBase() + "/api/support/list", {}); };

  POLY.site_login = function (a) {
    var base = String(a.siteBase || "").replace(/\/+$/, "");
    return postJson(base + "/api/launcher/login.php", { username: a.username, password: a.password }).then(function (res) {
      return Promise.all([
        setCfg("site_base_url", base),
        setCfg("site_username", a.username),
        setCfg("site_launcher_token", (res && (res.token || res.launcher_token)) || ""),
      ]).then(function () { return res; });
    });
  };

  // ── کلاینتِ PvP (MihanPvP) ────────────────────────────────
  // دسکتاپ یک پکِ کاملاً ویندوزی/LWJGL2 (JNA، oshi، ساندسیستمِ paulscode، …) را مستقیم
  // با java.exe اجرا می‌کند — روی اندروید/ARM آن پک اصلاً قابلِ اجرا نیست. این کامند قبلاً
  // اصلاً پیاده نشده بود، پس invoke("pvp_launch") به AndroidBridgeِ بومی (که چنین
  // دستوری نمی‌شناسد) سقوط می‌کرد و همان‌جا بود که رفتارِ نامعتبر («دانلودِ نسخه‌ی
  // اشتباه») پیش می‌آمد. راه‌حلِ درست: همان Forge 1.8.9 را از طریقِ لوله‌ی نصب/اجرای
  // خودِ Pojav (ARM-سازگار، از قبل برای صفحه‌ی «نسخه‌ها» کار می‌کند) نصب می‌کنیم و
  // MihanPvP.jar (یک modِ Forgeِ معمولی، نه کدِ بومی) را داخلِ mods آن می‌گذاریم.
  // ── راهِ درستِ موبایل ─────────────────────────────────────────────
  // ناتیوِ install_forge برای 1.8.9 یک پروفایلِ معتبر نمی‌سازد (نصبِ فورجِ قدیمیِ Pojav
  // شکننده است) و instance_launch بی‌سروصدا به پروفایلِ پیش‌فرض (وانیلا) برمی‌گردد. به‌جایش
  // خودمان پروفایلِ Forge 1.8.9 را قطعی می‌سازیم: (۱) جاوا ۸ باندل‌شده در APK را نصب می‌کنیم
  // (این بیلد فقط ۱۷/۲۱/۲۵ را خودکار مدیریت می‌کند)، (۲) JSONِ نسخه را می‌نویسیم، (۳) یک
  // پروفایل با javaDir=Internal-8 و رندرِ gl4es می‌سازیم، (۴) مادِ MihanPvP را در gameDirِ
  // جدا می‌گذاریم، (۵) همان پروفایل را لانچ می‌کنیم. وانیلا/asset را Pojav از Mojang می‌گیرد.
  var PVP_FORGE_ID = "1.8.9-forge1.8.9-11.15.1.2318-1.8.9";
  var PVP_VANILLA = "1.8.9";
  // پروفایلِ Pojav باید کلیدش یک UUIDِ معتبر باشد — LauncherProfiles.normalizeProfileIds()
  // هر کلیدِ غیرِ UUID را «Illegal profile uuid» شمرده و حذف می‌کند (برای همین نسخه‌ی قبلی
  // بی‌سروصدا به پروفایلِ Default = وانیلا برمی‌گشت). کلیدِ ثابت تا هر بار همان پروفایل به‌روز شود.
  var PVP_PROFILE_UUID = "e7b9a5c2-1f34-4a6d-b8e0-1a2b3c4d5e6f";
  // پایه‌ی مِیوِنِ کتابخانه‌های مخصوصِ فورج. برای کاربرانِ ایران که maven.minecraftforge.net
  // فیلتر است، این را به آینه‌ی سرورِ ایران (auth.mihancraft.com/dl/pvp/maven/) عوض کن.
  // همه‌ی کتابخانه‌های فورج (forge/scala/akka/config) از CDN ایران؛ Pojav با استفاده از فیلدِ
  // url هر کتابخانه مستقیم از اینجا می‌گیرد (CDN جارِ forge را با نامِ ساده هم دارد، برخلافِ maven).
  var PVP_MAVEN = "https://cdn.mihancraft.com/minecraft-loaders/libraries/";

  // JSONِ نسخه‌ی Forge 1.8.9 (inheritsFrom: 1.8.9). urlِ کتابخانه‌های فورج به PVP_MAVEN اشاره می‌کند.
  function pvpForgeJson() {
    var m = PVP_MAVEN;
    return {
      id: PVP_FORGE_ID, type: "release", inheritsFrom: PVP_VANILLA, jar: PVP_VANILLA,
      assets: "1.8", minimumLauncherVersion: 14,
      mainClass: "net.minecraft.launchwrapper.Launch",
      minecraftArguments: "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory} --assetsDir ${assets_root} --assetIndex ${assets_index_name} --uuid ${auth_uuid} --accessToken ${auth_access_token} --userProperties ${user_properties} --userType ${user_type} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker",
      libraries: [
        { name: "net.minecraftforge:forge:1.8.9-11.15.1.2318-1.8.9", url: m },
        { name: "net.minecraft:launchwrapper:1.12" },
        { name: "org.ow2.asm:asm-all:5.0.3" },
        { name: "com.typesafe.akka:akka-actor_2.11:2.3.3", url: m },
        { name: "com.typesafe:config:1.2.1", url: m },
        { name: "org.scala-lang:scala-actors-migration_2.11:1.1.0", url: m },
        { name: "org.scala-lang:scala-compiler:2.11.1", url: m },
        { name: "org.scala-lang.plugins:scala-continuations-library_2.11:1.0.2", url: m },
        { name: "org.scala-lang.plugins:scala-continuations-plugin_2.11.1:1.0.2", url: m },
        { name: "org.scala-lang:scala-library:2.11.1", url: m },
        { name: "org.scala-lang:scala-parser-combinators_2.11:1.0.1", url: m },
        { name: "org.scala-lang:scala-reflect:2.11.1", url: m },
        { name: "org.scala-lang:scala-swing_2.11:1.0.1", url: m },
        { name: "org.scala-lang:scala-xml_2.11:1.0.2", url: m },
        { name: "lzma:lzma:0.0.1" },
        { name: "net.sf.jopt-simple:jopt-simple:4.6" },
        { name: "java3d:vecmath:1.5.2" },
        { name: "net.sf.trove4j:trove4j:3.0.3" }
      ]
    };
  }

  // نصبِ جاوا ۸ (Internal-8) — یک‌بار؛ اگر از قبل هست، فوری برمی‌گردد.
  // بیلدِ LITE (همانی که آپدیت‌کننده‌ی داخلِ اپ نصب می‌کند) کلِ assets/components/jre* را
  // حذف می‌کند، پس installBundledJava8Async آن‌جا با یک FileNotFoundException می‌مرد و
  // پیامِ خامش («components/jre/universal.tar.xz») مستقیم به کاربر نشان داده می‌شد —
  // شکایتِ «کلاینت پی وی پی روی اندروید ارور می‌دهد». DL.ensureJava همان فال‌بکِ CDN را
  // دارد که مسیرِ دانلودِ نسخه‌ها استفاده می‌کند، پس همان را صدا می‌زنیم.
  function pvpInstallJava8() {
    try { if (Ext && Ext.java8Ready && Ext.java8Ready()) return Promise.resolve("Internal-8"); } catch (_) {}
    return new Promise(function (resolve, reject) {
      if (!Ext || !Ext.installBundledJava8Async) { reject(new Error("پل بومی در دسترس نیست")); return; }
      try { Ext.installBundledJava8Async(DL.pending(resolve, reject)); }
      catch (e) { reject(e); }
    }).catch(function (e) {
      if (!DL || !DL.ensureJava) throw e;
      return DL.ensureJava(8, "pvp-setup").then(function () { return "Internal-8"; });
    });
  }

  // نوشتنِ JSONِ نسخه در .minecraft/versions/<forge>/<forge>.json
  function pvpStageVersion() {
    var vdir = J(MC, "versions", PVP_FORGE_ID);
    try { Ext.mkdirs(vdir); } catch (_) {}
    Ext.writeText(J(vdir, PVP_FORGE_ID + ".json"), JSON.stringify(pvpForgeJson()));
    return Promise.resolve();
  }

  // آماده‌سازیِ کاملِ ۱.۸.۹-فورج (وانیلا + همه‌ی کتابخانه‌ها + همه‌ی assetها) از CDN
  // ایران. قبلاً فقط json/jar/اندیسِ وانیلا pre-stage می‌شد و بقیه به دانلودگرِ نیتیو
  // سپرده می‌شد — که کتابخانه‌های فورجِ ۱.۸.۹ (scala/akka/…) را از maven.minecraftforge
  // .net می‌خواست و در ایران شکست می‌خورد. stageVersion همه را از CDN می‌گیرد و marker
  // می‌نویسد، پس مسیرِ لانچ هم دیگر هیچ درخواستی نمی‌زند.
  function pvpStageVanilla(token) {
    return DL.stageVersion(PVP_FORGE_ID, token);
  }

  // ساختن/به‌روزکردنِ پروفایلِ Pojav با جاوا ۸ + رندرِ gl4es + gameDirِ جدا
  function pvpEnsureProfile() {
    var lp = J(MC, "launcher_profiles.json");
    var obj = {};
    try { obj = JSON.parse(Ext.readText(lp) || "{}"); } catch (_) { obj = {}; }
    if (!obj || typeof obj !== "object") obj = {};
    if (!obj.profiles) obj.profiles = {};
    try { delete obj.profiles[PVP_FORGE_ID]; } catch (_) {} // پاک‌سازیِ کلیدِ بدِ نسخه‌های قبلی
    obj.profiles[PVP_PROFILE_UUID] = {
      name: "MihanPvP 1.8.9",
      lastVersionId: PVP_FORGE_ID,
      javaDir: "pojav://Internal-8",
      pojavRendererName: "opengles2",
      javaArgs: "-Dfml.ignoreInvalidMinecraftCertificates=true -Dfml.ignorePatchDiscrepancies=true -Dlog4j2.formatMsgNoLookups=true"
    };
    Ext.writeText(lp, JSON.stringify(obj));
    // A brand-new profile has to go through the file (setProfileField can only touch profiles the
    // native model already knows), so tell that model to re-read it. Without this it keeps a copy
    // from before this write and puts it back on the next launch, taking the MihanPvP profile with
    // it — after which ensureProfileDir() no longer recognises the id, falls back to the SHARED
    // .minecraft, and the installer below wipes conflicting mods out of the user's own mods folder.
    try { if (Ext.reloadProfiles) Ext.reloadProfiles(); } catch (_) {}
    return Promise.resolve();
  }

  POLY.pvp_available = function () { return Promise.resolve(true); };

  POLY.pvp_installed = function () {
    if (!Ext) return Promise.resolve(false);
    try { return Promise.resolve(!!Ext.exists(J(MC, "versions", PVP_FORGE_ID, PVP_FORGE_ID + ".json"))); }
    catch (_) { return Promise.resolve(false); }
  };

  POLY.pvp_launch = function () {
    flushVoiceStateBeforeLaunch();
    var token = "pvp-setup";
    emit("update://progress", { token: token, label: "در حال آماده‌سازی کلاینت...", pct: 0 });
    return pvpInstallJava8().then(function () {
      emit("update://progress", { token: token, label: "آماده‌سازیِ نسخه‌ی Forge ۱.۸.۹...", pct: 25 });
      return pvpStageVersion();
    }).then(function () {
      return pvpEnsureProfile();
    }).then(function () {
      emit("update://progress", { token: token, label: "آماده‌سازیِ وانیلا ۱.۸.۹ از سرور ایران...", pct: 45 });
      return pvpStageVanilla(token);
    }).then(function () {
      var pvpDir = ensureProfileDir(PVP_PROFILE_UUID);
      // ensureProfileDir() falls back to the SHARED .minecraft whenever it can't find the profile.
      // That fallback is fine for reads, but everything below deletes mods and drops a Forge 1.8.9
      // client jar in — doing that to the shared folder is what destroyed users' mods ("کلاینت PVP
      // خود به خود فایل های داخل پوشه mods رو پاک کرده"). If we didn't get a directory of our own,
      // recreate the profile and try once more; if it still isn't ours, refuse rather than damage
      // anything.
      if (pvpDir === MC) {
        try { pvpEnsureProfile(); } catch (_) {}
        pvpDir = ensureProfileDir(PVP_PROFILE_UUID);
      }
      if (pvpDir === MC) {
        throw new Error("پوشه‌ی اختصاصیِ کلاینت PvP ساخته نشد — برای این‌که مادهای خودت پاک نشوند نصب متوقف شد.");
      }
      var modsDir = J(pvpDir, "mods");
      try { Ext.mkdirs(modsDir); } catch (_) {}
      // پاک‌سازیِ زیر فقط داخلِ پوشه‌ی *خودِ* پروفایلِ PvP انجام می‌شود (بالا تضمین شد).
      // کامنتِ قبلی این‌جا می‌گفت این پوشه با بقیه‌ی پروفایل‌ها مشترک است — که از پیش از
      // جداسازیِ per-profile مانده بود و دقیقاً همان فرضِ غلطی بود که این حذف‌ها را روی
      // مادهای خودِ کاربر توجیه می‌کرد.
      // کلاینتِ PvP سیستمِ کازمتیکِ اختصاصیِ خودش را دارد (Cape.java/CosmeticsNet.java)، پس
      // اگر لانچِ قبلیِ همین پروفایل CustomSkinLoader را جا گذاشته باشد پاک می‌شود تا دو
      // سیستم همزمان رندرینگِ اسکین را پچ نکنند.
      try { Ext.del(J(modsDir, CSL_JAR_NAME)); } catch (_) {}
      // به همان دلیل: این پروفایل markerِ آپتی‌فاین ندارد، پس این فراخوانی هر جارِ
      // آپتی‌فاینِ به‌جامانده از یک پروفایلِ دیگر را پاک می‌کند — وگرنه آپتی‌فاینِ مثلاً
      // ۱٫۲۰٫۱ داخلِ همین mods روی کلاینتِ Forge 1.8.9 هم بارگذاری می‌شد و می‌مرد.
      // (این مسیر مستقیم nativeInvoke را صدا می‌زند، پس POLY.instance_launch و
      // ensureOptifineModِ داخلش اصلاً اجرا نمی‌شوند.)
      try { ensureOptifineMod(PVP_FORGE_ID); } catch (_) {}
      emit("update://progress", { token: token, label: "دریافتِ نسخه‌ی جدیدِ کلاینت...", pct: 55 });
      // مثلِ دسکتاپ، جارِ کلاینت هر بار دوباره دانلود می‌شود تا آپدیت‌ها خودکار اعمال شوند
      return downloadTo("https://auth.mihancraft.com/dl/MihanPvP.jar", J(modsDir, "MihanPvP.jar"), token, "MihanPvP.jar");
    }).then(function () {
      return setCfg("pvp_instance_id", PVP_PROFILE_UUID);
    }).then(function () {
      emit("update://progress", { token: token, label: "در حال اجرای کلاینت (بارِ اول کمی طول می‌کشد)...", pct: 100 });
      return nativeInvoke("instance_launch", { id: PVP_PROFILE_UUID });
    }).catch(function (e) {
      emit("update://progress", { token: token, label: "خطا: " + (e && e.message || e), pct: 0 });
      throw e;
    });
  };

  POLY.mods_versions = function (a) {
    var url = "https://api.modrinth.com/v2/project/" + encodeURIComponent(a.projectId) + "/version";
    var params = [];
    if (a.mcVersion) params.push("game_versions=" + encodeURIComponent('["' + a.mcVersion + '"]'));
    if (a.loader) params.push("loaders=" + encodeURIComponent('["' + a.loader + '"]'));
    if (params.length) url += "?" + params.join("&");
    return getJson(url).catch(function () { return []; });
  };
  POLY.server_vanilla_versions = function () {
    return DL.versionManifest();
  };
  POLY.server_paper_versions = function () {
    // شکلِ سازگار با papermc-v3 از فهرستِ iran-index.servers.paper
    // (ترتیبِ نزولی — همان چیزی که UI انتظار دارد؛ iran-index صعودی است)
    return DL.iranList("servers", "paper").then(function (list) { return { versions: { all: (list || []).slice().reverse() } }; });
  };

  POLY.iran_addon_list = function (a) {
    var kind = a.kind, dir = (/shader/.test(kind) ? "shaders" : /resourcepack/.test(kind) ? "resourcepacks" : "mods");
    return getJson("https://cdn.mihancraft.com/afzodaniha/" + dir + "/" + a.version + "/_files.json").catch(function () { return []; });
  };

  // Modrinth / CDN installers (write into mods|shaderpacks|resourcepacks)
  // `instance` is intentionally UNUSED for the destination folder: Pojav's real engine
  // (McCommands.openPojavEngine) always launches against the single global game dir (MC,
  // = Tools.DIR_GAME_NEW) — MinecraftProfile.gameDir, the only field that could redirect a
  // profile to its own folder, is never set anywhere in this codebase. Content written
  // under INST/<instance>/.minecraft was therefore write-only: nothing ever launched from
  // there, so installed mods/resourcepacks/shaders silently never appeared in-game. This
  // matches pvp_launch's own pattern below, which already writes straight to MC.
  /** نسخه‌ی کاملِ مادرینث (نه فقط فایل) را برمی‌گرداند تا بتوانیم dependencies را هم بخوانیم. */
  function modrinthPickVersion(projectId, mcVersion, loader) {
    var url = "https://api.modrinth.com/v2/project/" + encodeURIComponent(projectId) + "/version";
    var params = [];
    if (mcVersion) params.push("game_versions=" + encodeURIComponent('["' + mcVersion + '"]'));
    // کویلت مادِ فابریک را اجرا می‌کند؛ اگر فقط quilt بفرستیم خیلی مادها «نسخه ندارد» می‌شوند.
    if (loader) params.push("loaders=" + encodeURIComponent(loader === "quilt" ? '["quilt","fabric"]' : '["' + loader + '"]'));
    if (params.length) url += "?" + params.join("&");
    return getJson(url).then(function (versions) {
      if (!Array.isArray(versions) || !versions.length) throw new Error("نسخه‌ای برای این افزودنی پیدا نشد");
      return versions[0];
    });
  }

  /**
   * نصبِ یک پروژه‌ی مادرینث به‌همراهِ وابستگی‌های اجباری‌اش.
   * مادرینث در هر نسخه آرایه‌ی dependencies را می‌دهد ({project_id, dependency_type})؛ هر چیزی
   * که "required" باشد بازگشتی نصب می‌شود. بدونِ این، کاربر مادی نصب می‌کند و بازی با خطای
   * وابستگیِ مفقود اصلاً بالا نمی‌آید (روی دستگاه با Artifacts/baubles دیده شد).
   */
  function installModrinth(projectId, mcVersion, loader, kind, instance, token, seen, depth) {
    var sub = contentSubdir(kind);
    var base = ensureProfileDir(instance);
    seen = seen || {};
    depth = depth || 0;
    seen[String(projectId)] = 1;
    return modrinthPickVersion(projectId, mcVersion, loader).then(function (v) {
      var files = v.files || [];
      var f = files.filter(function (x) { return x.primary; })[0] || files[0];
      if (!f) throw new Error("فایلی برای دانلود نبود");
      Ext.mkdirs(J(base, sub));
      return downloadTo(f.url, J(base, sub, baseName(f.filename || f.url)), token, f.filename)
        .then(function () {
          // وابستگی‌ها همیشه ماد هستند، حتی وقتی خودِ آیتم شیدر یا ریسورس‌پک باشد — پس
          // همیشه در پوشه‌ی mods می‌نشینند، نه کنارِ آیتمِ اصلی.
          if (depth > 3) return null;
          var deps = (v.dependencies || []).filter(function (d) {
            return d && d.dependency_type === "required" && d.project_id && !seen[d.project_id];
          });
          var chain = Promise.resolve();
          deps.forEach(function (d) {
            chain = chain.then(function () {
              return installModrinth(d.project_id, mcVersion, loader, "mods", instance, token, seen, depth + 1)
                .catch(function () { return null; });   // یک وابستگیِ حل‌نشده نباید کلِ نصب را بیندازد
            });
          });
          return chain;
        });
    }).then(function () { return null; });
  }
  POLY.mods_install = function (a) { return installModrinth(a.projectId, a.mcVersion, a.loader, "mods", null, a.token); };
  POLY.content_install = function (a) { return installModrinth(a.projectId, a.mcVersion, a.loader, a.kind, a.instance, a.token); };
  POLY.instance_mod_install = function (a) { return installModrinth(a.projectId, a.mcVersion, a.loader, "mods", a.id, a.token); };
  // ── وابستگی‌های ماد روی سرور ایران ───────────────────────────────────────────────────
  // هر جار وابستگی‌هایش را داخل خودش اعلام می‌کند (fabric.mod.json / mods.toml / mcmod.info).
  // deploy/cdn_deps_scan.py همه‌ی جارهای CDN را اسکن کرده و برای هر نسخه یک _deps.json ساخته:
  //     { "<فایل>": { "id": "<modid>", "requires": [...], "loaders": [...] } }
  // پس می‌توانیم بدونِ هیچ درخواستِ خارجی بفهمیم یک ماد چه می‌خواهد و همان را هم نصب کنیم.
  //
  // بدونِ این، نصبِ مادی مثل Artifacts (که baubles می‌خواهد) بازی را اصلاً بالا نمی‌آورد:
  // فورج با «You must include the right dependencies» رد می‌کند — روی همین دستگاه دیده شد.
  var _iranDeps = {};   // version -> index (کش برای هر نشست)
  function iranDepsIndex(version) {
    if (_iranDeps[version]) return Promise.resolve(_iranDeps[version]);
    return getJson(CDN + "/afzodaniha/mods/" + version + "/_deps.json")
      .then(function (d) { _iranDeps[version] = d || {}; return _iranDeps[version]; })
      .catch(function () { _iranDeps[version] = {}; return _iranDeps[version]; });
  }
  // چیزهایی که خودِ لودر می‌دهد و هیچ‌وقت نباید دنبالشان بگردیم
  var DEP_BUILTIN = /^(minecraft|java|forge|neoforge|fabricloader|fabric-loader|fabric_loader|quilt_loader|mcp|fml|mixin|mixinbootstrap|com_electronwill_)/;
  /** پیشوندهای پیاپیِ یک شناسه: "a-b-c" → ["a-b","a"] (برای کتابخانه‌های چتری) */
  function depParents(req) {
    var parts = String(req).split(/[-_]/), out = [];
    for (var n = parts.length - 1; n > 0; n--) {
      out.push(parts.slice(0, n).join("-"), parts.slice(0, n).join("_"));
    }
    return out;
  }
  function depSatisfied(req, haveIds) {
    if (!req || DEP_BUILTIN.test(req)) return true;
    if (haveIds[req]) return true;
    // زیرماژول‌های Fabric API همه در یک جار هستند
    if (/^fabric[-_]/.test(req) && (haveIds["fabric-api"] || haveIds["fabric"])) return true;
    if (/^quilt(ed)?[-_]/.test(req) && haveIds["quilted_fabric_api"]) return true;
    // کتابخانه‌های چتری فقط شناسه‌ی پدر را اعلام می‌کنند ولی همه‌ی زیرماژول‌ها داخلِ همان جارند:
    // Cardinal-Components-API می‌گوید "cardinal-components" در حالی که مادها
    // "cardinal-components-base" می‌خواهند، و c2me-fabric می‌گوید "c2me" برای "c2me-base".
    // بدونِ این، لانچر دنبالِ فایلی می‌گردد که همین حالا روی CDN هست و پیدایش نمی‌کند.
    var ps = depParents(req);
    for (var i = 0; i < ps.length; i++) if (haveIds[ps[i]]) return true;
    return false;
  }

  /**
   * وابستگی‌های یک فایلِ نصب‌شده را (به‌صورت بازگشتی) از سرور ایران نصب می‌کند.
   * فقط داخلِ همان نسخه و ترجیحاً همان زیرپوشه‌ی لودر می‌گردد، و هر چیزی را که پروفایل
   * از قبل دارد رد می‌کند. اگر چیزی روی CDN نبود بی‌سروصدا می‌گذرد — نصبِ اصلی نباید
   * به‌خاطرِ یک وابستگیِ پیدانشده شکست بخورد؛ فقط گزارش می‌شود.
   */
  function installIranDeps(version, rel, base, token, loaderHint, seen, missingOut) {
    seen = seen || {};
    return iranDepsIndex(version).then(function (idx) {
      if (!idx || !idx[rel]) return null;
      var modsDir = J(base, "mods");
      // چه مودآیدی‌هایی همین حالا در پروفایل هست
      var haveIds = {};
      try {
        JSON.parse(Ext.list(modsDir) || "[]").forEach(function (e) {
          if (e.is_dir) return;
          var info = idx[e.name] || idx[(loaderHint ? loaderHint + "/" : "") + e.name];
          if (info && info.id) haveIds[info.id] = 1;
        });
      } catch (_) {}
      // نگاشتِ modid -> فایلِ CDN (زیرپوشه‌ی لودرِ خودمان اولویت دارد)
      var provider = {};
      Object.keys(idx).forEach(function (f) {
        var info = idx[f];
        if (!info || !info.id) return;
        var inOurLoader = loaderHint && f.indexOf(loaderHint + "/") === 0;
        var atRoot = f.indexOf("/") === -1;
        if (!inOurLoader && !atRoot) return;
        if (!provider[info.id] || inOurLoader) provider[info.id] = f;
      });
      // همان قانون برای پیدا کردنِ فایل: اگر برای "a-b" چیزی نبود، فایلی که "a" را می‌دهد هم
      // جواب است (همان جارِ چتری).
      function providerFor(req) {
        if (provider[req]) return provider[req];
        var ps = depParents(req);
        for (var i = 0; i < ps.length; i++) if (provider[ps[i]]) return provider[ps[i]];
        return null;
      }
      var reqs = (idx[rel].requires || []).filter(function (r) { return !depSatisfied(r, haveIds); });
      var chain = Promise.resolve();
      reqs.forEach(function (req) {
        if (seen[req]) return;
        seen[req] = 1;
        var f = providerFor(req);
        if (!f) { if (missingOut) missingOut.push(req); return; }
        chain = chain.then(function () {
          var dest = J(modsDir, baseName(f));
          if (Ext.exists(dest)) return null;
          return downloadTo(CDN + "/afzodaniha/mods/" + version + "/" + f, dest, token, baseName(f))
            .then(function () {
              // خودِ وابستگی هم ممکن است وابستگی داشته باشد
              return installIranDeps(version, f, base, token, loaderHint, seen, missingOut);
            }).catch(function () { if (missingOut) missingOut.push(req); return null; });
        });
      });
      return chain.then(function () {
        return failed.length ? { shader_loader_failed: failed } : null;
      });
    }).catch(function () { return null; });
  }

  /** لودرِ یک پروفایل از روی lastVersionId داخل launcher_profiles.json. */
  function profileLoaderOf(instanceId) {
    if (!instanceId) return "";
    try {
      var obj = JSON.parse(Ext.readText(J(MC, "launcher_profiles.json")) || "{}");
      var p = obj && obj.profiles && obj.profiles[instanceId];
      var v = String((p && (p.lastVersionId || "")) || "").toLowerCase();
      if (/neoforge/.test(v)) return "neoforge";
      if (/forge/.test(v)) return "forge";
      if (/quilt/.test(v)) return "quilt";
      if (/fabric/.test(v)) return "fabric";
    } catch (_) {}
    return "";
  }


  // ── مادِ بارگذاریِ شیدر ────────────────────────────────────────────────────────────────
  // شیدرپک یک zip است و برخلافِ jar هیچ متادیتایی ندارد، پس نیازش هرگز در _deps.json نمی‌آید —
  // ولی بدونِ مادِ بارگذاری، شیدر اصلاً روی بازی اعمال نمی‌شود و کاربر فکر می‌کند نصب خراب است.
  //   fabric/quilt → Iris (+ Sodium که Iris رویش سوار است)
  //   forge        → Oculus (+ Embeddium/Rubidium)
  //   optifine     → خودِ آپتی‌فاین شیدر را اجرا می‌کند، چیزی لازم نیست
  // Iris فقط برای ۱٫۱۶٫۵ به بعد وجود دارد؛ پایین‌تر از آن تنها راه آپتی‌فاین است (روی CDN هم
  // برای آن نسخه‌ها هیچ مادِ بارگذاری‌ای نیست — بررسی شد).
  var SHADER_LOADER_WANT = {
    fabric: [/^iris[-_]/i, /^sodium-fabric[-_]|^sodium-\d/i],
    quilt:  [/^iris[-_]/i, /^sodium-fabric[-_]|^sodium-\d/i],
    forge:  [/^oculus-mc/i, /^embeddium-\d|^rubidium-\d/i],
    neoforge: [/^oculus-mc/i, /^embeddium-\d|^rubidium-\d/i],
  };

  /** آیا این نسخه اصلاً می‌تواند Iris/Oculus داشته باشد؟ (۱٫۱۶٫۵ به بعد) */
  function shaderLoaderPossible(ver) {
    var m = String(ver || "").match(/^1\.(\d+)(?:\.(\d+))?/);
    if (!m) return false;
    var minor = +m[1], patch = +(m[2] || 0);
    return minor > 16 || (minor === 16 && patch >= 5);
  }

  /**
   * مادِ بارگذاریِ شیدر را (اگر نبود) از سرور ایران داخلِ همین پروفایل نصب می‌کند.
   * اسمِ فایل‌ها عمداً با الگوی دقیق تطبیق داده می‌شود: روی CDN چیزهایی مثل
   * sodiumextras / oculus-flywheel-compat هم هست که ماد بارگذاری نیستند و انتخابشان
   * فقط پوشه را شلوغ می‌کند.
   */
  function installShaderLoader(version, base, token, loader) {
    var want = SHADER_LOADER_WANT[loader];
    if (!want || !shaderLoaderPossible(version)) return Promise.resolve(null);
    var modsDir = J(base, "mods");
    Ext.mkdirs(modsDir);
    var existing = [];
    var failed = [];
    try { existing = JSON.parse(Ext.list(modsDir) || "[]").map(function (e) { return e.name; }); } catch (_) {}
    return getJson(CDN + "/afzodaniha/mods/" + version + "/_files.json").then(function (files) {
      if (!Array.isArray(files)) return null;
      var chain = Promise.resolve();
      want.forEach(function (re) {
        if (existing.some(function (n) { return re.test(n); })) return;   // از قبل هست
        var pick = files.filter(function (f) {
          var head = f.indexOf("/") > 0 ? f.split("/")[0] : "";
          return (head === loader || head === "") && re.test(baseName(f));
        })[0];
        if (!pick) return;
        chain = chain.then(function () {
          var dest = J(modsDir, baseName(pick));
          if (Ext.exists(dest)) return null;
          return downloadTo(CDN + "/afzodaniha/mods/" + version + "/" + pick, dest, token, baseName(pick))
            .then(function () {
              // خودِ ماد بارگذاری هم وابستگی دارد (مثلاً Oculus به Embeddium)
              return installIranDeps(version, pick, base, token, loader, {}, []);
            }).catch(function (e) {
              // یک شکستِ گذرای شبکه اینجا یعنی شیدر نصب شده ولی هیچ‌وقت اجرا نمی‌شود، و کاربر
              // هیچ نشانه‌ای نمی‌بیند (یک‌بار همین اتفاق افتاد و Embeddium بی‌صدا جا ماند).
              // نصبِ شیدر را نمی‌شکنیم، ولی حتماً گزارش می‌کنیم.
              failed.push(baseName(pick));
              try { dlog("shader_loader_failed", { file: pick, error: e && e.message }); } catch (_) {}
              return null;
            });
        });
      });
      return chain;
    }).catch(function () { return null; });
  }

  POLY.iran_content_install = function (a) {
    var kind = a.kind, dir = (/shader/.test(kind) ? "shaders" : /resourcepack/.test(kind) ? "resourcepacks" : "mods");
    var sub = contentSubdir(kind);
    var base = ensureProfileDir(a.instance);
    var url = "https://cdn.mihancraft.com/afzodaniha/" + dir + "/" + a.version + "/" + a.rel;
    Ext.mkdirs(J(base, sub));
    return downloadTo(url, J(base, sub, baseName(a.rel)), a.token, baseName(a.rel)).then(function () {
      if (dir === "shaders") {
        // شیدر بدونِ مادِ بارگذاری هیچ اثری ندارد — همان‌جا نصبش کن.
        var ldr = a.loader || profileLoaderOf(a.instance) || "";
        return installShaderLoader(a.version, base, a.token, ldr);
      }
      if (dir !== "mods") return null;
      // وقتی خودِ ماد در ریشه‌ی CDN است (فایلِ لودرناوابسته) هیچ سرنخی از لودر در مسیر نیست، و
      // بدونِ آن پوشه‌ی forge/ اصلاً گشته نمی‌شود — یعنی وابستگی‌ای که همان‌جاست پیدا نمی‌شود.
      // (دقیقاً همین باعث شد Artifacts در ریشه، baubles را از forge/ برندارد.)
      var loaderHint = a.rel.indexOf("/") > 0 ? a.rel.split("/")[0]
                      : (a.loader || profileLoaderOf(a.instance) || "");
      var missing = [];
      return installIranDeps(a.version, a.rel, base, a.token, loaderHint, {}, missing)
        .then(function () { return missing.length ? { missing_deps: missing } : null; });
    });
  };
  POLY.server_install_plugin = function (a) {
    var loader = a.loader || "paper";
    var folder = (a.folder === "mods") ? "mods" : "plugins";
    return modrinthPickFile(a.projectId, a.mcVersion, loader).then(function (f) {
      var dir = J(serverDir(a.name), folder);
      Ext.mkdirs(dir);
      return downloadTo(f.url, J(dir, baseName(f.filename || f.url)), a.token, f.filename);
    }).then(function () { return null; });
  };
  // ── نصبِ مودپک ────────────────────────────────────────────────────────────
  // تا امروز هر دو کامند فقط «پشتیبانی نمی‌شود» برمی‌گرداندند، در حالی که صفحه‌ی
  // «مودپک‌ها» با دکمه‌ی نصبش سرِ جایش بود — یعنی کاربر می‌گشت، انتخاب می‌کرد، «نصب» را
  // می‌زد و خطا می‌گرفت. (به همین خاطر آن صفحه از منو هم پنهان شده بود.)
  //
  // مسیرِ سرورِ ایران ساده است: modpacks/instances/<slug>/_tree.json دقیقاً همان شکلِ
  // _tree.jsonِ سرورهاست و یک .minecraftِ آماده را توصیف می‌کند. تفاوتِ عمدی با دسکتاپ:
  // فایل‌های versions/ libraries/ assets/ از درخت دانلود **نمی‌شوند**، چون نصب‌کننده‌های
  // خودمان (install_fabric/forge/…) همان‌ها را از قبل استیج می‌کنند و markerهای لازمِ
  // اجرا روی اندروید را هم می‌نویسند؛ دانلودِ دوباره‌شان چند صد مگابایتِ تکراری است.

  /** مسیرِ مقصدِ امن داخلِ یک ریشه — جلوی «..» و مسیرِ مطلق در فهرستِ پک را می‌گیرد. */
  function safePackDest(root, rel) {
    var parts = String(rel || "").replace(/\\/g, "/").split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (!s || s === "." ) continue;
      if (s === "..") return null;
      if (/^[A-Za-z]:$/.test(s)) return null;
      out.push(s);
    }
    if (!out.length) return null;
    return J(root, out.join("/"));
  }
  function encPath(p) {
    return String(p).split("/").map(encodeURIComponent).join("/");
  }
  /**
   * نسخه‌ی پایه + لودرِ اعلام‌شده‌ی مودپک را نصب می‌کند و شناسه‌ی نسخه را برمی‌گرداند.
   *
   * توکنِ جدا (`<token>-base`) عمدی است: نصب‌کننده‌های پایه در پایانِ کارشان یک رویدادِ
   * `state:"complete", done:true` روی توکنشان می‌فرستند. اگر همان توکنِ مودپک را می‌دادیم،
   * نوارِ پیشرفت وسطِ کار «✓ آماده شد» می‌شد در حالی که هنوز صدها ماد مانده بود.
   */
  function installModpackBase(loader, mc, lver, token) {
    loader = String(loader || "vanilla").toLowerCase();
    if (!mc) return Promise.reject(new Error("نسخه‌ی ماینکرفتِ این مودپک مشخص نیست"));
    var sub = String(token) + "-base";
    DL.clearCancel(sub);
    if (loader === "fabric" || loader === "quilt") {
      return (lver ? Promise.resolve(lver)
        : (loader === "quilt" ? POLY.quilt_loaders : POLY.fabric_loaders)({ mcVersion: mc }).then(function (list) {
            return (list && list[0] && ((list[0].loader && list[0].loader.version) || list[0].version)) || "";
          })).then(function (v) {
        if (!v) throw new Error(loader + " برای نسخه‌ی " + mc + " روی سرورِ ایران موجود نیست");
        return DL.installMetaLoader(loader, mc, v, sub, false);
      });
    }
    if (loader === "forge" || loader === "neoforge") return DL.installForgeLike(loader, mc, sub, false, lver || "");
    // وانیلا و هر چیزِ ناشناخته → خودِ نسخه. عمداً ترفندِ «وانیلا ولی زیرِ پوست فابریک»ِ
    // instance_create این‌جا اعمال نمی‌شود: مادهای یک مودپک برای لودرِ اعلام‌شده ساخته
    // شده‌اند و عوض‌کردنِ بی‌صدای لودر می‌تواند کلِ پک را بشکند.
    return DL.installVanilla({ versionId: mc, token: sub, makeProfile: false });
  }
  /** یک پروفایلِ **تازه** (نه بازاستفاده‌ی پروفایلِ هم‌نسخه) برای این مودپک می‌سازد. */
  function newModpackProfile(versionId, displayName, ram) {
    var lp = J(MC, "launcher_profiles.json");
    var obj = {};
    try { obj = JSON.parse(Ext.readText(lp) || "{}") || {}; } catch (_) { obj = {}; }
    if (!obj.profiles) obj.profiles = {};
    if (!obj.settings) obj.settings = {};
    if (!obj.version) obj.version = 3;
    // همیشه کلیدِ نو: دو مودپکِ مختلف روی یک نسخه باید دو پروفایلِ جدا با پوشه‌ی جدا باشند،
    // وگرنه مادهای‌شان روی هم می‌ریزند و هر دو کرش می‌کنند.
    var key = genUuid();
    obj.profiles[key] = { name: displayName, lastVersionId: versionId, type: "custom" };
    if (ram > 0) obj.profiles[key].javaArgs = "-Xmx" + ram + "M";
    Ext.writeText(lp, JSON.stringify(obj));
    try { if (Ext.reloadProfiles) Ext.reloadProfiles(); } catch (_) {}
    return key;
  }

  POLY.iran_modpack_install = function (a) {
    a = a || {};
    var pack = a.pack || a;
    var slug = String(pack.slug || a.slug || "");
    if (!slug) return Promise.reject(new Error("شناسه‌ی مودپکِ سرور ایران مشخص نیست"));
    var display = String(a.name || pack.name || slug);
    // صفحه‌ی مودپک‌ها نسخه‌ی پایه را با نامِ `base` می‌فرستد (نه `mc`) — هر دو پذیرفته می‌شود.
    var mc = String(pack.mc || a.mc || a.base || a.baseVersion || "");
    var loader = String(pack.loader || a.loader || "vanilla").toLowerCase();
    var lver = String(pack.loader_version || pack.loaderVersion || a.loaderVersion || "");
    var ram = Number(a.ram || 0) || 0;
    var token = String(a.token || ("mp-iran-" + slug));
    var base = CDN + "/modpacks/instances/" + encodeURIComponent(slug);
    DL.clearCancel(token);
    emit("download://status", { token: token, label: "دریافتِ فهرستِ فایل‌های مودپک…", pct: 1, state: "queued" });
    return getJson(base + "/_tree.json").then(function (tree) {
      var files = ((tree && tree.files) || []).filter(function (f) {
        return f && f.path && String(f.path).charAt(0) !== ".";
      });
      if (!files.length) throw new Error("فهرستِ فایلِ این مودپک خالی است");
      emit("download://status", { token: token, label: "نصبِ نسخه‌ی پایه و لودر…", pct: 3, state: "downloading" });
      return installModpackBase(loader, mc, lver, token).then(function (versionId) {
        var key = newModpackProfile(String(versionId || mc), display, ram);
        var gdir = ensureProfileDir(key);
        var items = [];
        files.forEach(function (f) {
          var p = String(f.path);
          // مرحله‌ی بالا این سه را کامل و استیج‌شده آورده — دوباره گرفتنشان فقط
          // چند صد مگابایت ترافیکِ تکراری است.
          if (/^(versions|libraries|assets)\//.test(p)) return;
          var dest = safePackDest(gdir, p);
          if (!dest) return;                      // مسیرِ ناامن در فهرستِ پک
          items.push({
            url: base + "/" + encPath(p),
            dest: dest,
            sha1: String(f.sha1 || ""),
            size: Number(f.size || f.bytes) || 0,
            opt: false,
          });
        });
        dlog("modpack_iran_start", { token: token, slug: slug, files: items.length, version: versionId });
        var done = function () {
          emit("download://status", { token: token, label: "مودپک «" + display + "» نصب شد", pct: 100, state: "complete", done: true });
          return { id: key, name: display, loader: loader, base_version: mc, version: String(versionId || mc), icon: "gift", ram: ram,
                   modpack: { source: "iran", slug: slug, name: display } };
        };
        if (!items.length) return done();
        return DL.downloadBatch(items, token, "دانلودِ فایل‌های مودپک").then(done);
      });
    }).catch(function (e) {
      var msg = (e && e.message) ? e.message : String(e || "خطای نامشخص");
      dlog("modpack_iran_error", { token: token, slug: slug, error: msg });
      emit("download://status", { token: token, label: "نصبِ مودپک «" + display + "»", state: /لغو/.test(msg) ? "cancelled" : "error", error: msg });
      throw e;
    });
  };

  // ── مودپکِ Modrinth (.mrpack) ──────────────────────────────────────────────
  // .mrpack یک zip است: modrinth.index.json (فهرستِ فایل‌ها با URL) به‌علاوه‌ی پوشه‌ی
  // overrides/ که همان‌طور روی پروفایل کپی می‌شود.
  function copyTreeInto(srcDir, destDir) {
    var entries;
    try { entries = JSON.parse(Ext.list(srcDir) || "[]"); } catch (_) { return; }
    entries.forEach(function (e) {
      if (!e || !e.name) return;
      var from = J(srcDir, e.name), to = J(destDir, e.name);
      if (e.is_dir) { try { Ext.mkdirs(to); } catch (_) {} copyTreeInto(from, to); }
      else { try { Ext.copyInto(from, to); } catch (_) {} }
    });
  }
  POLY.modpack_install = function (a) {
    a = a || {};
    var projectId = String(a.projectId || a.project_id || a.slug || "");
    if (!projectId) return Promise.reject(new Error("شناسه‌ی مودپک مشخص نیست"));
    var display = String(a.name || a.title || projectId);
    var ram = Number(a.ram || 0) || 0;
    var token = String(a.token || ("mp-mr-" + projectId));
    var work = J(Ext.cacheDir(), "mrpack-" + Date.now());
    var zipPath = J(work, "pack.mrpack");
    DL.clearCancel(token);
    emit("download://status", { token: token, label: "دریافتِ اطلاعاتِ مودپک…", pct: 1, state: "queued" });
    return getJson("https://api.modrinth.com/v2/project/" + encodeURIComponent(projectId) + "/version").then(function (versions) {
      if (!Array.isArray(versions) || !versions.length) throw new Error("نسخه‌ای برای این مودپک پیدا نشد");
      var v = versions[0];
      var f = (v.files || []).filter(function (x) { return x.primary; })[0] || (v.files || [])[0];
      if (!f || !f.url) throw new Error("فایلی برای این مودپک پیدا نشد");
      Ext.mkdirs(work);
      emit("download://status", { token: token, label: "دانلودِ بسته‌ی مودپک…", pct: 4, state: "downloading" });
      return downloadTo(f.url, zipPath, token, f.filename || "pack.mrpack", { silent: true }).then(function () {
        Ext.unzip(zipPath, work);
        var idx = {};
        try { idx = JSON.parse(Ext.readText(J(work, "modrinth.index.json")) || "{}") || {}; } catch (_) { idx = {}; }
        var deps = idx.dependencies || {};
        var mc = String(deps.minecraft || "");
        var loader = "vanilla", lver = "";
        if (deps["fabric-loader"]) { loader = "fabric"; lver = String(deps["fabric-loader"]); }
        else if (deps["quilt-loader"]) { loader = "quilt"; lver = String(deps["quilt-loader"]); }
        else if (deps["forge"]) { loader = "forge"; lver = String(deps["forge"]); }
        else if (deps["neoforge"]) { loader = "neoforge"; lver = String(deps["neoforge"]); }
        if (!mc) throw new Error("نسخه‌ی ماینکرفتِ این مودپک در فایلش مشخص نشده");
        emit("download://status", { token: token, label: "نصبِ نسخه‌ی پایه و لودر…", pct: 8, state: "downloading" });
        return installModpackBase(loader, mc, lver, token).then(function (versionId) {
          var key = newModpackProfile(String(versionId || mc), display, ram);
          var gdir = ensureProfileDir(key);
          var items = [];
          (idx.files || []).forEach(function (entry) {
            if (!entry || !entry.path) return;
            // env.client === "unsupported" یعنی این فایل فقط مالِ سرور است.
            if (entry.env && entry.env.client === "unsupported") return;
            var url = (entry.downloads || [])[0];
            if (!url) return;
            var dest = safePackDest(gdir, entry.path);
            if (!dest) return;
            items.push({ url: url, dest: dest, sha1: (entry.hashes && entry.hashes.sha1) || "",
                         size: Number(entry.fileSize) || 0, opt: false });
          });
          dlog("modpack_mr_start", { token: token, project: projectId, files: items.length, mc: mc, loader: loader });
          var applyOverrides = function () {
            // overrides عمومی اول، بعد client-overrides تا رویش بنشیند.
            ["overrides", "client-overrides"].forEach(function (d) {
              var src = J(work, d);
              try { if (Ext.exists(src)) copyTreeInto(src, gdir); } catch (_) {}
            });
            try { Ext.del(work); } catch (_) {}
            emit("download://status", { token: token, label: "مودپک «" + display + "» نصب شد", pct: 100, state: "complete", done: true });
            return { id: key, name: display, loader: loader, base_version: mc, version: String(versionId || mc), icon: "gift", ram: ram,
                     modpack: { source: "modrinth", project_id: projectId, name: display } };
          };
          if (!items.length) return applyOverrides();
          return DL.downloadBatch(items, token, "دانلودِ ماد‌های مودپک").then(applyOverrides);
        });
      });
    }).catch(function (e) {
      try { Ext.del(work); } catch (_) {}
      var msg = (e && e.message) ? e.message : String(e || "خطای نامشخص");
      dlog("modpack_mr_error", { token: token, project: projectId, error: msg });
      emit("download://status", { token: token, label: "نصبِ مودپک «" + display + "»", state: /لغو/.test(msg) ? "cancelled" : "error", error: msg });
      throw e;
    });
  };
  POLY.create_server_from_world = function () { return Promise.reject(new Error("ساخت سرور از دنیا روی موبایل پشتیبانی نمی‌شود")); };
  POLY.server_reinstall = function () { return Promise.reject(new Error("نصب مجدد سرور روی موبایل پشتیبانی نمی‌شود")); };
  // لاگِ کاملِ همه‌ی رویدادهای دانلود (سرور + نسخه‌ها + لودرها) برای دیباگ. UI فعلاً
  // آن را نمایش نمی‌دهد؛ این کامند فقط متنِ خامِ logs/download.log را برمی‌گرداند تا
  // بعداً یا از طریق یک صفحه‌ی دیباگ نمایش داده شود یا هنگامِ گزارشِ باگ خوانده شود.
  POLY.get_download_log = function () {
    try { return Promise.resolve(Ext && Ext.readLog ? (Ext.readLog("download.log") || "") : ""); }
    catch (e) { return Promise.resolve(""); }
  };
  POLY.tunnel_test_relay = function (a) {
    // no raw TCP in JS; report reachable optimistically so UI proceeds
    return Promise.resolve({ ok: false, reason: "تست رله روی موبایل در دسترس نیست" });
  };

  // ═══════════════════════════════════════════════════════
  //  CATEGORY 2 — local filesystem
  // ═══════════════════════════════════════════════════════
  // fs manager (relative to server/instance/mc base)
  POLY.fs_list = function (a) {
    var base = fsBase(a.name, a.instance);
    var rel = String(a.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    var abs = rel ? J(base, rel) : base;
    Ext.mkdirs(base);
    var entries = JSON.parse(Ext.list(abs) || "[]");
    return Promise.resolve({ path: rel, entries: entries });
  };
  POLY.fs_read = function (a) { return Promise.resolve(Ext.readText(J(fsBase(a.name, a.instance), a.path))); };
  POLY.fs_write = function (a) { Ext.writeText(J(fsBase(a.name, a.instance), a.path), a.content == null ? "" : a.content); return Promise.resolve(null); };
  POLY.fs_mkdir = function (a) { Ext.mkdirs(J(fsBase(a.name, a.instance), a.path)); return Promise.resolve(null); };
  POLY.fs_new_file = function (a) { Ext.newFile(J(fsBase(a.name, a.instance), a.path)); return Promise.resolve(null); };
  POLY.fs_delete = function (a) { Ext.del(J(fsBase(a.name, a.instance), a.path)); return Promise.resolve(null); };
  POLY.fs_rename = function (a) {
    var base = fsBase(a.name, a.instance);
    Ext.rename(J(base, a.path), J(base, a.newPath));
    return Promise.resolve(null);
  };
  POLY.fs_upload = function (a) {
    var name = Ext.copyInto(a.src, J(fsBase(a.name, a.instance), a.dest, baseName(a.src)));
    return Promise.resolve(name);
  };
  POLY.fs_download = function (a) {
    Ext.copyInto(J(fsBase(a.name, a.instance), a.path), a.dest);
    return Promise.resolve(null);
  };
  POLY.fs_extract = function (a) {
    var base = fsBase(a.name, a.instance);
    Ext.unzip(J(base, a.path), J(base, a.dest));
    return Promise.resolve(null);
  };
  POLY.fs_compress = function (a) {
    var base = fsBase(a.name, a.instance);
    var abs = (a.paths || []).map(function (p) { return J(base, p); });
    Ext.zip(J(base, a.dest), base, JSON.stringify(abs));
    return Promise.resolve(null);
  };
  POLY.fs_search = function (a) {
    var base = fsBase(a.name, a.instance);
    var q = String(a.query || "").toLowerCase();
    var matches = [], truncated = false, MAXN = 500;
    if (!q) return Promise.resolve({ matches: matches, truncated: false });
    function walk(dir, rel) {
      if (matches.length >= MAXN) { truncated = true; return; }
      var entries;
      try { entries = JSON.parse(Ext.list(dir) || "[]"); } catch (_) { return; }
      for (var i = 0; i < entries.length; i++) {
        if (matches.length >= MAXN) { truncated = true; return; }
        var e = entries[i], childRel = rel ? rel + "/" + e.name : e.name, childAbs = J(dir, e.name);
        if (e.is_dir) { walk(childAbs, childRel); continue; }
        if (e.size > 2 * 1024 * 1024) continue;
        var txt; try { txt = Ext.readText(childAbs); } catch (_) { continue; }
        var lines = txt.split(/\r?\n/);
        for (var l = 0; l < lines.length; l++) {
          if (lines[l].toLowerCase().indexOf(q) >= 0) {
            matches.push({ path: childRel, line: l + 1, text: lines[l].trim().slice(0, 220) });
            if (matches.length >= MAXN) { truncated = true; return; }
          }
        }
      }
    }
    Ext.mkdirs(base);
    walk(base, "");
    return Promise.resolve({ matches: matches, truncated: truncated });
  };

  // config — delegate to native set_config so the Kotlin Store stays consistent
  // (writing config.json directly would leave the Store's in-memory copy stale).
  POLY.set_config_many = function (a) {
    var patch = a.patch || {}, keys = Object.keys(patch);
    return Promise.all(keys.map(function (k) { return setCfg(k, patch[k]); })).then(function () { return null; });
  };
  POLY.site_logout = function () {
    return Promise.all([setCfg("site_username", ""), setCfg("site_launcher_token", "")]).then(function () { return null; });
  };

  // mods listing (shared mc dir + per-instance)
  function listMods(dir) {
    Ext.mkdirs(dir);
    var entries = JSON.parse(Ext.list(dir) || "[]");
    return entries.filter(function (e) { return !e.is_dir && /\.jar(\.disabled)?$/i.test(e.name); }).map(function (e) {
      var enabled = !/\.disabled$/i.test(e.name);
      return { name: e.name.replace(/\.disabled$/i, ""), path: J(dir, e.name), enabled: enabled, size: e.size };
    }).sort(function (x, y) { return x.name.localeCompare(y.name); });
  }
  // بدونِ instance صدا زده می‌شود؛ بعد از جداسازی، پوشه‌ی مشترک عملاً خالی است، پس
  // پوشه‌ی همان پروفایلی را نشان بده که کاربر با آن بازی می‌کند.
  POLY.mods_installed = function () {
    return Promise.resolve(listMods(J(ensureProfileDir(cfgGet("last_profile", "")), "mods")));
  };
  // Same correction as fsBase above: the profile's mods live in its EXTERNAL game dir.
  POLY.instance_mods = function (a) { return Promise.resolve(listMods(J(ensureProfileDir(a.id), "mods"))); };

  // skins
  POLY.skins_list = function () {
    var dir = J(DATA, "skins"); Ext.mkdirs(dir);
    var entries = JSON.parse(Ext.list(dir) || "[]");
    return Promise.resolve(entries.filter(function (e) { return !e.is_dir && /\.png$/i.test(e.name); })
      .map(function (e) { return { name: stem(e.name), path: J(dir, e.name) }; })
      .sort(function (x, y) { return x.name.localeCompare(y.name); }));
  };
  POLY.skin_save = function (a) {
    var dir = J(DATA, "skins"); Ext.mkdirs(dir);
    var rgba = a.rgba;
    var path = Ext.skinSavePng(J(dir, safeName(a.name) + ".png"), JSON.stringify(rgba));
    return Promise.resolve(path);
  };
  POLY.skin_load = function (a) { return Promise.resolve(JSON.parse(Ext.skinLoad(a.path))); };
  POLY.skin_delete = function (a) { Ext.del(a.path); return Promise.resolve(null); };

  // images
  POLY.read_image_b64 = function (a) { return Promise.resolve(Ext.imgToB64(a.path)); };
  POLY.gallery_thumb = function (a) {
    var dir = J(DATA, "cache", "thumbs"); Ext.mkdirs(dir);
    var key = String(a.path).replace(/[^A-Za-z0-9]+/g, "_");
    return Promise.resolve(Ext.thumb(a.path, J(dir, key + ".jpg")));
  };

  // backups (zip inspection)
  POLY.backup_contents = function (a) {
    var names = JSON.parse(Ext.zipEntries(a.path) || "[]");
    var seen = {}, out = [];
    names.forEach(function (n) {
      var seg = String(n).split("/")[0];
      if (seg && seg.indexOf(".") === -1 && !seen[seg]) { seen[seg] = 1; out.push(seg); }
    });
    return Promise.resolve(out);
  };
  POLY.backup_components = function () {
    // desktop scans the mc dir for known component folders; return the standard set present
    var comps = ["saves", "mods", "config", "resourcepacks", "shaderpacks", "options.txt", "servers.dat"];
    var out = comps.filter(function (c) { return Ext.exists(J(MC, c)); });
    return Promise.resolve(out.length ? out : comps);
  };

  // server file-based ops (servers/<name>/…)
  POLY.server_props_get = function (a) {
    var f = J(serverDir(a.name), "server.properties");
    if (!Ext.exists(f)) return Promise.resolve({});
    var txt = Ext.readText(f), out = {};
    txt.split(/\r?\n/).forEach(function (line) {
      if (!line || line[0] === "#") return;
      var i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    return Promise.resolve(out);
  };
  POLY.server_props_set = function (a) {
    var props = a.props || {}, lines = [];
    Object.keys(props).forEach(function (k) { lines.push(k + "=" + props[k]); });
    Ext.writeText(J(serverDir(a.name), "server.properties"), lines.join("\n") + "\n");
    return Promise.resolve(null);
  };
  POLY.server_delete = function (a) { Ext.del(serverDir(a.name)); return Promise.resolve(null); };
  POLY.server_disk_usage = function (a) { return Promise.resolve(Number(Ext.sizeOf(serverDir(a.name)) || 0)); };
  POLY.server_icon = function (a) {
    var d = serverDir(a.name);
    if (!Ext.exists(d)) return Promise.resolve(null);
    var icon = J(d, "server-icon.png");
    return Promise.resolve(Ext.exists(icon) ? icon : null);
  };
  POLY.server_set_icon = function (a) {
    Ext.copyInto(a.src, J(serverDir(a.name), "server-icon.png"));
    return Promise.resolve(null);
  };
  POLY.server_default_icon = function (a) {
    // no embedded asset on mobile; ensure dir exists, leave icon absent
    Ext.mkdirs(serverDir(a.name));
    return Promise.resolve(null);
  };
  POLY.server_meta_set = function (a) {
    var f = J(serverDir(a.name), "launcher_server.json");
    var meta = {};
    if (Ext.exists(f)) { try { meta = JSON.parse(Ext.readText(f)); } catch (_) {} }
    else return Promise.reject(new Error("سرور پیدا نشد"));
    var patch = a.patch || {};
    Object.keys(patch).forEach(function (k) { meta[k] = patch[k]; });
    Ext.writeText(f, JSON.stringify(meta));
    return Promise.resolve(meta);
  };
  POLY.server_plugin_delete = function (a) { Ext.del(a.path); return Promise.resolve(null); };
  POLY.server_leaderboard = function () { return Promise.resolve([]); }; // stats parsing is heavy; empty is a safe UI state

  // instances export/import (zip)
  POLY.instance_export = function (a) {
    var dir = J(INST, a.id);
    Ext.zip(a.dest, dir, JSON.stringify([J(dir, "instance.json"), J(dir, ".minecraft")]));
    return Promise.resolve(a.dest);
  };
  POLY.instance_import = function (a) {
    // extract into a fresh instance folder; derive id from name/stem
    var id = safeName((a.name || stem(a.zipPath)) + "_" + Date.now());
    var dir = J(INST, id);
    Ext.mkdirs(dir);
    Ext.unzip(a.zipPath, dir);
    var meta = {};
    var mf = J(dir, "instance.json");
    if (Ext.exists(mf)) { try { meta = JSON.parse(Ext.readText(mf)); } catch (_) {} }
    meta.id = id;
    if (a.name) meta.name = a.name;
    if (!meta.name) meta.name = id;
    Ext.writeText(mf, JSON.stringify(meta));
    return Promise.resolve({ instance: meta, repair_ok: false });
  };

  // chunk map (region header parse). render is heavy → graceful empty.
  POLY.chunk_map = function (a) {
    var regionDir = a.regionDir;
    var entries;
    try { entries = JSON.parse(Ext.list(regionDir) || "[]"); } catch (_) { entries = []; }
    var chunks = [], regions = 0, totalKb = 0, capped = false, CAP = 400000;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.is_dir || !/^r\.-?\d+\.-?\d+\.mca$/i.test(e.name)) continue;
      regions++;
      var m = e.name.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/i);
      var rx = parseInt(m[1], 10), rz = parseInt(m[2], 10);
      var b64; try { b64 = Ext.readSliceB64(J(regionDir, e.name), 0, 8192); } catch (_) { continue; }
      var bytes = b64ToBytes(b64);
      if (bytes.length < 8192) continue;
      for (var idx = 0; idx < 1024; idx++) {
        var off = idx * 4;
        var sectors = bytes[off + 3];
        if (sectors === 0) continue;
        var ts = (bytes[4096 + off] << 24) | (bytes[4096 + off + 1] << 16) | (bytes[4096 + off + 2] << 8) | bytes[4096 + off + 3];
        var cx = rx * 32 + (idx % 32), cz = rz * 32 + Math.floor(idx / 32);
        var kb = sectors * 4;
        totalKb += kb;
        if (chunks.length < CAP) chunks.push({ x: cx, z: cz, kb: kb, ts: ts >>> 0 });
        else capped = true;
      }
    }
    return Promise.resolve({ chunks: chunks, count: chunks.length, regions: regions, total_kb: totalKb, capped: capped });
  };
  // ═══════════════════════════════════════════════════════
  //  CHUNK RENDER — real top-down terrain map, heightmap-based (not full
  //  block-color like desktop's fastanvil renderer — a true per-block-type
  //  palette decode is a much heavier lift; a real heightmap is an honest,
  //  useful middle ground rather than leaving this stubbed). Reads each
  //  chunk's NBT straight out of the .mca region file, decompresses with the
  //  browser's native DecompressionStream (zlib, matches Anvil's compression
  //  type 2), and shades by elevation using the modern Heightmaps.WORLD_SURFACE
  //  packed long array (post-1.16 9-bits-per-value, long-aligned packing).
  // ═══════════════════════════════════════════════════════
  function nbtReader(buf) {
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var pos = 0;
    function u8() { return buf[pos++]; }
    function i16() { var v = dv.getInt16(pos); pos += 2; return v; }
    function i32() { var v = dv.getInt32(pos); pos += 4; return v; }
    function i64() { var hi = dv.getInt32(pos), lo = dv.getUint32(pos + 4); pos += 8; return { hi: hi, lo: lo }; }
    function f32() { var v = dv.getFloat32(pos); pos += 4; return v; }
    function f64() { var v = dv.getFloat64(pos); pos += 8; return v; }
    function str() { var n = dv.getUint16(pos); pos += 2; var s = ""; for (var i = 0; i < n; i++) s += String.fromCharCode(buf[pos + i]); pos += n; return s; }
    function skipArr(elemSize) { var n = i32(); pos += n * elemSize; }
    function readTag(type) {
      switch (type) {
        case 1: return u8();
        case 2: return i16();
        case 3: return i32();
        case 4: return i64();
        case 5: return f32();
        case 6: return f64();
        case 7: { var n = i32(); var a = []; for (var i = 0; i < n; i++) a.push(u8()); return a; } // byte array
        case 8: return str();
        case 9: { // list
          var et = u8(), n = i32(), arr = [];
          for (var i = 0; i < n; i++) arr.push(et === 0 ? null : readTag(et));
          return arr;
        }
        case 10: { // compound
          var o = {};
          for (;;) {
            var t = u8();
            if (t === 0) break;
            var nm = str();
            o[nm] = readTag(t);
          }
          return o;
        }
        case 11: { var n = i32(); var a = []; for (var i = 0; i < n; i++) a.push(i32()); return a; } // int array
        case 12: { var n = i32(); var a = []; for (var i = 0; i < n; i++) a.push(i64()); return a; } // long array
        default: throw new Error("bad NBT tag " + type);
      }
    }
    // root: 1 byte type (10=compound) + name string + compound body
    var rootType = u8();
    if (rootType !== 10) throw new Error("not a compound root");
    str(); // root name, usually ""
    return readTag(10);
  }

  function inflateZlib(bytes) {
    if (!window.DecompressionStream) return Promise.reject(new Error("DecompressionStream unsupported"));
    var ds = new DecompressionStream("deflate"); // WHATWG 'deflate' = zlib-wrapped (RFC1950), matches Anvil type 2
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }
  function inflateGzip(bytes) {
    if (!window.DecompressionStream) return Promise.reject(new Error("DecompressionStream unsupported"));
    var ds = new DecompressionStream("gzip");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  // unpack a Heightmaps long-array (post-1.16: 9 bits/value, values never span a
  // long boundary — 7 values per 64-bit long, top bits unused) into 256 heights.
  function unpackHeightmap9(longs) {
    var bitsPer = 9, perLong = Math.floor(64 / bitsPer), mask = (1 << bitsPer) - 1;
    var out = new Array(256);
    var idx = 0;
    for (var li = 0; li < longs.length && idx < 256; li++) {
      var lo = longs[li].lo >>> 0, hi = longs[li].hi >>> 0;
      for (var k = 0; k < perLong && idx < 256; k++) {
        var bitOff = k * bitsPer;
        var v;
        if (bitOff < 32) {
          // value may straddle the lo/hi 32-bit halves
          var lowBits = 32 - bitOff;
          if (lowBits >= bitsPer) {
            v = (lo >>> bitOff) & mask;
          } else {
            var lowPart = lo >>> bitOff;
            var highPart = hi & ((1 << (bitsPer - lowBits)) - 1);
            v = (lowPart | (highPart << lowBits)) & mask;
          }
        } else {
          v = (hi >>> (bitOff - 32)) & mask;
        }
        out[idx++] = v;
      }
    }
    return out;
  }

  // height → a pleasant terrain-ish color ramp (water/lowland/hill/peak)
  function heightColor(h) {
    if (h <= 62) return [56, 88, 196];       // water level and below
    if (h <= 74) return [219, 207, 163];     // beach/sand band
    if (h <= 100) return [85, 130, 64];      // grassland
    if (h <= 140) return [110, 96, 67];      // hills
    return [235, 235, 240];                  // peaks/snow
  }

  function readChunkHeightmap(regionAbs, headerBytes, idx) {
    var off = idx * 4;
    var sectors = headerBytes[off + 3];
    if (sectors === 0) return Promise.resolve(null);
    var sectorOffset = (headerBytes[off] << 16) | (headerBytes[off + 1] << 8) | headerBytes[off + 2];
    var byteOff = sectorOffset * 4096;
    var lenB64;
    try { lenB64 = Ext.readSliceB64(regionAbs, byteOff, 5); } catch (_) { return Promise.resolve(null); }
    var lenBytes = b64ToBytes(lenB64);
    if (lenBytes.length < 5) return Promise.resolve(null);
    var len = (lenBytes[0] << 24) | (lenBytes[1] << 16) | (lenBytes[2] << 8) | lenBytes[3];
    var ctype = lenBytes[4];
    if (!len || len < 1 || len > sectors * 4096) return Promise.resolve(null);
    var payloadB64;
    try { payloadB64 = Ext.readSliceB64(regionAbs, byteOff + 5, len - 1); } catch (_) { return Promise.resolve(null); }
    var payload = b64ToBytes(payloadB64);
    var inflate = ctype === 1 ? inflateGzip : (ctype === 2 ? inflateZlib : function (b) { return Promise.resolve(b); });
    return inflate(payload).then(function (raw) {
      var root;
      try { root = nbtReader(raw); } catch (_) { return null; }
      var lvl = root.Level || root; // pre-1.18 wraps everything in root.Level; 1.18+ is flat
      // modern (1.13+): Heightmaps compound of packed-long arrays
      var hm = lvl && lvl.Heightmaps;
      if (hm) {
        var longs = hm.WORLD_SURFACE || hm.MOTION_BLOCKING || hm.OCEAN_FLOOR;
        if (longs && longs.length) {
          var yBase = 64; // value is height above the min build limit; modern worlds min=-64
          try {
            var heights = unpackHeightmap9(longs);
            for (var i = 0; i < heights.length; i++) heights[i] = heights[i] - yBase;
            return heights;
          } catch (_) { /* fall through to legacy */ }
        }
      }
      // legacy (pre-1.13, e.g. 1.7.10): plain HeightMap int[256], absolute Y, no offset
      if (lvl && Array.isArray(lvl.HeightMap) && lvl.HeightMap.length === 256) {
        return lvl.HeightMap.slice();
      }
      return null;
    }).catch(function () { return null; });
  }

  POLY.chunk_render = function (a) {
    var regionDir = a.regionDir, token = a.token || 0;
    if (!window.DecompressionStream) {
      return Promise.resolve({ min_cx: 0, min_cz: 0, span_cx: 0, span_cz: 0, ppc: 1, regions: 0, error: "این نسخه‌ی وب‌ویو از رندر نقشه پشتیبانی نمی‌کند" });
    }
    var entries;
    try { entries = JSON.parse(Ext.list(regionDir) || "[]"); } catch (_) { entries = []; }
    var regionFiles = entries.filter(function (e) { return !e.is_dir && /^r\.-?\d+\.-?\d+\.mca$/i.test(e.name); });
    if (!regionFiles.length) {
      emit("chunkmap://status", "این بُعد چانکی برای رندر ندارد");
      return Promise.resolve({ min_cx: 0, min_cz: 0, span_cx: 0, span_cz: 0, ppc: 1, regions: 0 });
    }
    var cacheDir = J(DATA, "cache"); Ext.mkdirs(cacheDir);
    var keySeed = regionDir.split("").reduce(function (h, c) { return ((h << 5) - h + c.charCodeAt(0)) | 0; }, 0);
    var key = Math.abs(keySeed).toString(16);
    var total = regionFiles.length, done = 0, painted = 0;
    emit("chunkmap://status", "رندر زمین — 0/" + total + " ریجن");

    function renderRegion(e) {
      var m = e.name.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/i);
      var rx = parseInt(m[1], 10), rz = parseInt(m[2], 10);
      var abs = J(regionDir, e.name);
      var headerB64;
      try { headerB64 = Ext.readSliceB64(abs, 0, 4096); } catch (_) { return Promise.resolve(); }
      var header = b64ToBytes(headerB64);
      if (header.length < 4096) return Promise.resolve();
      var canvas = document.createElement("canvas");
      canvas.width = 512; canvas.height = 512; // 32 chunks * 16 px/chunk = 512
      var ctx = canvas.getContext("2d");
      var img = ctx.createImageData(512, 512);
      var anyPx = false;

      var chunkPromises = [];
      for (var idx = 0; idx < 1024; idx++) {
        (function (idx) {
          var lx = idx % 32, lz = Math.floor(idx / 32);
          chunkPromises.push(readChunkHeightmap(abs, header, idx).then(function (heights) {
            if (!heights) return;
            anyPx = true;
            var ox = lx * 16, oz = lz * 16;
            for (var bz = 0; bz < 16; bz++) {
              for (var bx = 0; bx < 16; bx++) {
                var h = heights[bz * 16 + bx];
                var c = heightColor(h);
                var px = ox + bx, py = oz + bz;
                var o = (py * 512 + px) * 4;
                img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
              }
            }
          }));
        })(idx);
      }
      return Promise.all(chunkPromises).then(function () {
        done++;
        if (done % 2 === 0 || done === total) emit("chunkmap://status", "رندر زمین — " + done + "/" + total + " ریجن");
        if (!anyPx) return;
        ctx.putImageData(img, 0, 0);
        var dataUrl = canvas.toDataURL("image/png");
        var b64 = dataUrl.split(",")[1];
        var outPath = J(cacheDir, "tile_" + key + "_" + rx + "_" + rz + ".png");
        try {
          Ext.writeB64(outPath, b64);
          painted++;
          emit("chunkmap://tile", { path: outPath, cx: rx * 32, cz: rz * 32, span: 32, ppc: 16, token: token });
        } catch (_) {}
      });
    }

    // render regions with limited concurrency (a handful at a time) so we don't
    // stall the WebView with hundreds of parallel synchronous JNI fs reads at once
    var CONCURRENCY = 3, i = 0;
    function next() {
      if (i >= regionFiles.length) return Promise.resolve();
      var e = regionFiles[i++];
      return renderRegion(e).then(next);
    }
    var workers = [];
    for (var w = 0; w < CONCURRENCY; w++) workers.push(next());
    return Promise.all(workers).then(function () {
      if (painted === 0) {
        emit("chunkmap://status", "نمایش زمینِ این دنیا ممکن نشد (فرمت چانک پشتیبانی نمی‌شود) — اما نقشه‌ی چانک‌ها در دسترس است.");
      } else {
        emit("chunkmap://status", "رندر کامل شد");
      }
      return { min_cx: 0, min_cz: 0, span_cx: 0, span_cz: 0, ppc: 16, regions: total, tiles: painted };
    });
  };
  POLY.chunk_delete = function (a) {
    var coords = a.coords || [], n = 0;
    // zero the 4-byte location header entry for each [cx,cz]
    var byRegion = {};
    coords.forEach(function (c) {
      var cx = c[0], cz = c[1];
      var rx = Math.floor(cx / 32), rz = Math.floor(cz / 32);
      var key = rx + "." + rz;
      (byRegion[key] = byRegion[key] || []).push([((cx % 32) + 32) % 32, ((cz % 32) + 32) % 32]);
    });
    Object.keys(byRegion).forEach(function (key) {
      var parts = key.split("."), rx = parseInt(parts[0], 10), rz = parseInt(parts[1], 10);
      var f = J(a.regionDir, "r." + rx + "." + rz + ".mca");
      if (!Ext.exists(f)) return;
      var b64; try { b64 = Ext.readSliceB64(f, 0, 4096); } catch (_) { return; }
      var head = b64ToBytes(b64);
      byRegion[key].forEach(function (lc) {
        var idx = lc[1] * 32 + lc[0], off = idx * 4;
        if (head[off] || head[off + 1] || head[off + 2] || head[off + 3]) {
          head[off] = head[off + 1] = head[off + 2] = head[off + 3] = 0; n++;
        }
      });
      Ext.writeB64Slice ? Ext.writeB64Slice(f, 0, bytesToB64(head)) : writeHeader(f, head);
    });
    return Promise.resolve(n);
  };
  function writeHeader(f, head) {
    // fallback: read whole file, splice header, rewrite (region headers are 4KB)
    try {
      var whole = b64ToBytes(Ext.readB64(f));
      for (var i = 0; i < head.length && i < whole.length; i++) whole[i] = head[i];
      Ext.writeB64(f, bytesToB64(whole));
    } catch (_) {}
  }
  POLY.region_delete = function (a) {
    var f = J(a.regionDir, "r." + a.rx + "." + a.rz + ".mca");
    Ext.del(f);
    return Promise.resolve(null);
  };
  POLY.chunk_backup = function (a) {
    var dir = J(DATA, "backups", "chunks"); Ext.mkdirs(dir);
    var label = baseName(a.regionDir) || "region";
    var dest = J(dir, safeName(label) + "_" + Date.now() + ".zip");
    Ext.zip(dest, a.regionDir, JSON.stringify([a.regionDir]));
    return Promise.resolve(dest);
  };

  // voice soundboard
  POLY.voice_pad_add = function (a) {
    var dir = J(DATA, "soundboard"); Ext.mkdirs(dir);
    Ext.copyInto(a.path, J(dir, safeName(baseName(a.path))));
    var entries = JSON.parse(Ext.list(dir) || "[]");
    var exts = { mp3: 1, wav: 1, ogg: 1, m4a: 1, opus: 1, webm: 1, flac: 1, aac: 1 };
    return Promise.resolve(entries.filter(function (e) { return !e.is_dir && exts[e.ext]; })
      .map(function (e) { return { file: e.name, label: stem(e.name) }; })
      .sort(function (x, y) { return x.label.localeCompare(y.label); }));
  };

  // bighanoon offline user helpers (files under bighanoon/)
  POLY.bighanoon_rename_pending = function () { return Promise.resolve(Ext.exists(J(DATA, "bighanoon", "bighanoon_newuser.txt"))); };
  POLY.bighanoon_persist_newuser = function () {
    var f = J(DATA, "bighanoon", "bighanoon_newuser.txt");
    if (!Ext.exists(f)) return Promise.resolve(null);
    var name; try { name = Ext.readText(f).trim(); } catch (_) { return Promise.resolve(null); }
    Ext.del(f);
    if (!name || name.length < 3) return Promise.resolve(null);
    // adding an offline account is a native concern; delegate if available, else just return the name
    return Promise.resolve(name);
  };

  // verify_version — check the version json/jar exist (light integrity check)
  POLY.verify_version = function (a) {
    var vId = a.versionId, vdir = J(MC, "versions", vId), missing = [];
    if (!Ext.exists(J(vdir, vId + ".json"))) missing.push("versions/" + vId + "/" + vId + ".json");
    if (!Ext.exists(J(vdir, vId + ".jar"))) missing.push("versions/" + vId + "/" + vId + ".jar");
    return Promise.resolve(missing);
  };
  POLY.detect_versions = function () { return Promise.resolve([]); }; // foreign-launcher scan not applicable on mobile

  // bedrock (Windows UWP only — not applicable on Android/Pojav)
  POLY.bedrock_status = function () { return Promise.resolve({ installed: false, winget: false, worlds_dir: "" }); };
  POLY.bedrock_worlds = function () { return Promise.resolve([]); };
  POLY.bedrock_launch = function () { return Promise.reject(new Error("راکراست روی این دستگاه در دسترس نیست")); };
  POLY.bedrock_install = function () { return Promise.reject(new Error("نصب راکراست روی این دستگاه پشتیبانی نمی‌شود")); };

  // ═══════════════════════════════════════════════════════
  //  CATEGORY 3 — trivial / stubs
  // ═══════════════════════════════════════════════════════
  POLY.quit_app = function () { try { window.close(); } catch (_) {} return Promise.resolve(null); };
  POLY.show_social_popup = function () { return Promise.resolve(null); };
  POLY.pause_download = function (a) {
    var token = a && a.token != null ? String(a.token) : "";
    try { return Promise.resolve(!!(Ext && Ext.pauseDownload && Ext.pauseDownload(token))); } catch (e) { return Promise.reject(e); }
  };
  POLY.resume_download = function (a) {
    var token = a && a.token != null ? String(a.token) : "";
    try { return Promise.resolve(!!(Ext && Ext.resumeDownload && Ext.resumeDownload(token))); } catch (e) { return Promise.reject(e); }
  };
  POLY.cancel_download = function (a) {
    var token = a && a.token != null ? String(a.token) : "";
    // DL.cancel raises the JS-side flag AND kills the native single-file jobs + staging
    // batch registered under this token.
    try { return Promise.resolve(!!DL.cancel(token)); } catch (e) { return Promise.reject(e); }
  };

  // desktop-only launcher/game/server-process controls → safe values
  POLY.game_logs = function () { return Promise.resolve([]); };
  POLY.game_running = function () { return Promise.resolve(false); };
  POLY.game_stop = function () { return Promise.resolve(null); };
  POLY.server_stop = function () { return Promise.resolve(null); };
  POLY.server_kill = function () { return Promise.resolve(null); };
  POLY.server_restart = function () { return Promise.resolve(null); };
  // real hosting exists (see the SERVER HOSTING section below) — this stub is kept
  // ONLY as the pre-hosting-block default; POLY.server_stats below (near server_start)
  // is the one actually used (later definitions win). Left here for readability of intent.
  // real implementations are defined further below (near the server-hosting
  // section) — see POLY.tunnel_start / tunnel_stop / tunnel_address overrides.
  // ── آپدیتِ خودِ اپ (APK) — مثلِ دسکتاپ: چک، دانلود با پیشرفت، نصب از طریقِ خودِ اپ ──
  // سرور همان endpoint دسکتاپ (/api/update) را با یک کلیدِ جدا به‌نامِ "android" برمی‌گرداند.
  // شکلِ برگشتی دقیقاً هم‌شکلِ چیزی است که app.js (مشترک با دسکتاپ) در checkForUpdate انتظار دارد:
  // {launcher:{current,latest,min_required,mandatory,url,notes}}.
  // url: عمداً از update_url (نسخه‌ی LITE، بدونِ ~۱۴۶ مگ جاواهای باندل‌شده) استفاده می‌کند، نه
  // از url (نسخه‌ی کامل که فقط دانلودِ مستقیم از سایت لازمش دارد) — چون کسی که این endpoint را
  // می‌بیند از قبل یک‌بار نصب کرده و جاواها از قبل روی گوشیش هستند (بوت‌استرپِ خودِ Pojav وقتی
  // asset باندل‌شده را پیدا نکند ولی runtime هم‌نام از قبل نصب باشد، بی‌صدا رد می‌شود — تأیید‌شده
  // روی دستگاهِ واقعی). اگر update_url هنوز ست نشده (سرور قدیمی)، به url کامل برمی‌گردد.
  POLY.check_update = function () {
    var local = {};
    try { local = JSON.parse(Ext.appVersion() || "{}"); } catch (_) {}
    var current = String(local.versionName || "0.0.0");
    return getJson(accountBase() + "/api/update").then(function (cfg) {
      var a = (cfg && cfg.android) || {};
      return {
        launcher: {
          current: current,
          latest: a.latest || current,
          min_required: a.min_required || "0.0.0",
          mandatory: !!a.mandatory,
          url: a.update_url || a.url || "",
          notes: a.notes || "",
        },
        client: null,
      };
    }).catch(function () { return null; });
  };
  POLY.apply_update = function (a) {
    var url = a && a.url, token = (a && a.token) || "apk-update";
    if (!url) return Promise.reject(new Error("لینکِ آپدیت تنظیم نشده"));
    if (!Ext || !Ext.downloadApkAsync || !Ext.installApk || !Ext.cacheDir()) {
      return Promise.reject(new Error("پلِ بومی در دسترس نیست"));
    }
    // Android 8+ grants "install unknown apps" per source app. Ask before downloading
    // the large APK so users do not wait only to hit a blocked installer afterwards.
    try {
      if (Ext.canInstallPackages && !Ext.canInstallPackages()) {
        if (Ext.openInstallPermissionSettings) Ext.openInstallPermissionSettings();
        return Promise.reject(new Error("اجازهٔ «نصب برنامه‌های ناشناس» را برای میهن‌کرفت فعال کن، سپس دوباره روی نصب بزن."));
      }
    } catch (_) {}
    var dest = J(Ext.cacheDir(), "mihancraft-update.apk");
    return new Promise(function (resolve, reject) {
      var id = DL.pending(function () {
        try { Ext.installApk(dest); resolve(null); }
        catch (e) { reject(e); }
      }, reject);
      try { Ext.downloadApkAsync(id, url, dest, token); }
      catch (e) { reject(e); }
    });
  };
  // آپدیتِ کلاینتِ پی‌وی‌پی از داخلِ اپِ اندروید هدفِ این تغییر نیست (کلاینت داخلِ خودِ اپ اجرا
  // می‌شود، نه یک jarِ جدا مثلِ دسکتاپ) — همان رفتارِ قبلی (رد‌کردن) می‌ماند.
  POLY.apply_client_update = function () { return Promise.reject(new Error("به‌روزرسانی کلاینت روی موبایل در دسترس نیست")); };
  POLY.open_in_explorer = function () { return Promise.reject(new Error("باز کردن پوشه در فایل‌منیجرِ سیستم روی موبایل پشتیبانی نمی‌شود")); };
  POLY.reveal_in_explorer = POLY.open_in_explorer;

  // ═══════════════════════════════════════════════════════
  //  OVERRIDES — commands the native Kotlin bridge implements WRONG.
  //  The shim checks POLY before AndroidBridge, so these win. Each is a
  //  faithful port of the desktop (Rust) behavior so Android matches desktop.
  // ═══════════════════════════════════════════════════════

  // native loaderGameVersions: forge→[], neoforge→ALL vanilla (bug). Desktop
  // (forge::supported_mc) returns the MC versions each loader actually supports.
  // همه‌ی این فهرست‌ها از iran-index.json / autoindexِ CDN می‌آیند (mihan-download.js).
  function verCmpDesc(a, b) { return DL.verCmpDesc(a, b); }
  function isOldMc(v) {
    var p = String(v).split(/[.\- ]/);
    if (p[0] === "1") { var minor = parseInt(p[1], 10); if (!isNaN(minor)) return minor < 14; }
    return false;
  }
  POLY.loader_game_versions = function (a) {
    var loader = a.loader, showOld = a.showOld !== false;
    return DL.iranList("loaders", loader).then(function (list) {
      list = (list || []).slice().filter(DL.engineSupportsVersion).sort(verCmpDesc);
      if (!showOld) list = list.filter(function (v) { return !isOldMc(v); });
      return list.filter(function (v, i) { return list.indexOf(v) === i; });
    });
  };
  POLY.forge_versions = function (a) {
    return DL.forgeBuilds(String(a.mcVersion || a.mc || "")).catch(function () { return []; });
  };
  POLY.neoforge_versions = function (a) {
    return DL.neoforgeBuilds(String(a.mcVersion || a.mc || "")).catch(function () { return []; });
  };
  POLY.fabric_loaders = function (a) {
    return DL.metaLoaderVersions("fabric", String((a && (a.mcVersion || a.mc)) || "")).then(function (vs) {
      return vs.map(function (v) { return { loader: { version: v }, version: v }; });
    });
  };
  POLY.quilt_loaders = function (a) {
    return DL.metaLoaderVersions("quilt", String((a && (a.mcVersion || a.mc)) || "")).then(function (vs) {
      return vs.map(function (v) { return { loader: { version: v }, version: v }; });
    });
  };
  POLY.install_forge = function (a) {
    return DL.installForgeLike("forge", String((a && (a.mcVersion || a.mc)) || ""),
      (a && a.token) || "forge-install", !a || a.makeProfile !== false,
      String((a && (a.forgeVersion || a.loaderVersion)) || ""));
  };
  POLY.install_neoforge = function (a) {
    return DL.installForgeLike("neoforge", String((a && (a.mcVersion || a.mc)) || ""),
      (a && a.token) || "neoforge-install", !a || a.makeProfile !== false,
      String((a && (a.forgeVersion || a.loaderVersion)) || ""));
  };
  POLY.install_fabric = function (a) {
    return DL.installMetaLoader("fabric", String((a && (a.mcVersion || a.mc)) || ""),
      String((a && (a.loaderVersion || a.loader_version || a.loader)) || ""),
      (a && a.token) || "fabric-install", !a || a.makeProfile !== false);
  };
  POLY.install_quilt = function (a) {
    return DL.installMetaLoader("quilt", String((a && (a.mcVersion || a.mc)) || ""),
      String((a && (a.loaderVersion || a.loader_version || a.loader)) || ""),
      (a && a.token) || "quilt-install", !a || a.makeProfile !== false);
  };

  // ساختِ پروفایل از صفحه‌ی «پروفایل‌ها». نیتیوِ instance_create برای forge/neoforge خطای
  // «به‌زودی اضافه می‌شود» می‌داد و برای fabric/quilt مستقیم به meta.fabricmc.net/meta.quiltmc.org
  // می‌زد. این‌جا نصب را از همان نصب‌کننده‌های polyfill (CDN ایران، داخلِ لانچر، با پروگرس) انجام
  // می‌دهیم — که خودشان یک پروفایلِ launcher_profiles.json می‌سازند — بعد نام/آیکن/رمِ کاربر را روی
  // همان پروفایل ست می‌کنیم. وانیلا را به نیتیو می‌سپاریم (از قبل درست و CDN است) تا رفتارِ سالمش
  // دست‌نخورده بماند.
  POLY.instance_create = function (a) {
    var opts = (a && a.opts) || a || {};
    var name = (String(opts.name || "").trim()) || "profile";
    var mc = String(opts.base_version || opts.version || "");
    var loader = String(opts.loader || "vanilla").toLowerCase();
    var icon = String(opts.icon || "cube");
    var ram = Number(opts.ram || 0) || 0;
    if (!mc) return Promise.reject(new Error("نسخه انتخاب نشده است"));
    var token = "inst-" + name;
    var installer;
    // وانیلا هم مثلِ بقیه واقعاً نصب می‌شود. قبلاً مستقیم به نیتیو می‌رفت که فقط یک
    // پروفایل در launcher_profiles.json می‌ساخت و هیچ فایلی نمی‌گرفت؛ نتیجه این بود که
    // کاربر «پروفایل ساخته شد» می‌دید ولی کلِ ~۷۰۰ مگ تازه موقعِ زدنِ دکمه‌ی اجرا دانلود
    // می‌شد (شکایتِ «موقع اجرای نسخه فایل هاش کامل دانلود میشه»). حالا نصب یعنی نصب:
    // وقتی این تابع تمام شد نسخه کاملاً روی گوشی است و اجرا هیچ دانلودی لازم ندارد.
    if (loader === "vanilla") {
      // شفاف برای کاربر می‌ماند («لودر: وانیلا» پایین، همین تابع) و از نظرِ گیم‌پلی/جهان‌ها/
      // ریسورس‌پک‌ها دقیقاً وانیلاست — ولی زیرِ پوست، اگر Fabric برای این نسخه روی سرورِ
      // ایران باشد، همان نصب می‌شود تا CustomSkinLoader (ensureCustomSkinLoaderMod بالا)
      // بتواند بارگذاری شود: تنها راهِ واقعاً کارکننده‌ی اسکین/شنلِ سفارشی روی موبایل همین
      // است (نگاه کن به doc همان تابع برای این‌که چرا authlib-injector هیچ‌وقت کار نکرد).
      // نسخه‌های خیلی قدیمی که هنوز Fabric رویشان نیست (پیش از ۱٫۱۴، مثلِ فهرستِ خالیِ
      // fabric_loaders) وانیلای واقعی نصب می‌شوند — بدونِ اسکینِ سفارشی، ولی بدونِ تغییر.
      installer = POLY.fabric_loaders({ mcVersion: mc }).then(function (list) {
        var lv = (list && list[0] && ((list[0].loader && list[0].loader.version) || list[0].version)) || "";
        if (!lv) return POLY.install_version({ versionId: mc, token: token, makeProfile: false });
        return POLY.install_fabric({ mcVersion: mc, loaderVersion: lv, token: token });
      }).catch(function () {
        // سرورِ ایران در دسترس نبود یا فهرستِ Fabric گرفتن شکست خورد — به‌جای شکستِ کاملِ
        // ساختِ پروفایل، به وانیلای معمولی برمی‌گردیم.
        return POLY.install_version({ versionId: mc, token: token, makeProfile: false });
      });
    }
    else if (loader === "forge") installer = POLY.install_forge({ mcVersion: mc, token: token });
    else if (loader === "neoforge") installer = POLY.install_neoforge({ mcVersion: mc, token: token });
    else if (loader === "optifine") {
      // Forge پایه + آپتی‌فاین به‌عنوانِ ماد (نگاه کن به ensureOptifineMod بالا برای
      // این‌که چرا آپتی‌فاینِ مستقل نمی‌تواند اسکینِ سفارشی داشته باشد). اگر Forge برای
      // این نسخه نبود، به آپتی‌فاینِ مستقلِ قبلی برمی‌گردیم: بازی درست کار می‌کند، فقط
      // اسکین/شنلِ سفارشی روی آن پروفایل نخواهد بود.
      installer = DL.optifineIndex().then(function (list) {
        var entry = null;
        (list || []).forEach(function (e) { if (e && e.mc === mc && !entry) entry = e; });
        if (!entry) throw new Error("آپتی‌فاینِ آماده برای نسخه‌ی " + mc + " هنوز روی سرورِ ایران نیست");
        // این مسیر یک‌بار فقط برای نسخه‌های پیش از ۱٫۱۷ باز بود، چون ۱٫۱۷+ موقعِ بوت
        // با «Cannot find class oshi/hardware/CentralProcessor» می‌مرد. ریشه‌اش پیدا و رفع
        // شد (نگاه کن به ensurePojavLibRewrites بالا: Pojav خودش oshi را به ۶٫۳٫۰ و jna را
        // به ۵٫۱۳٫۰ بازنویسی می‌کند ولی ما آن نسخه‌ها را استیج نمی‌کردیم)، پس حالا هر
        // نسخه‌ای که Forge داشته باشد از همین مسیر می‌آید. ۱٫۲۰٫۱ و ۱٫۱۲٫۲ هر دو روی
        // دستگاهِ واقعی تا منویِ بازی با OptiFine + CSL فعال تأیید شدند.
        return POLY.install_forge({ mcVersion: mc, token: token }).then(function (forgeId) {
          var jarName = optifineInstallerName(mc, entry.ver);
          // انبارِ مشترک، نه پوشه‌ی mods: حالا هر پروفایل mods خودش را دارد و این نصب به
          // «نسخه» گره خورده نه به یک پروفایلِ مشخص. ensureOptifineMod موقعِ هر اجرا جارِ
          // متعلق به همان نسخه را از این‌جا داخلِ پوشه‌ی پروفایل کپی می‌کند.
          var stageDir = OF_STAGE;
          Ext.mkdirs(stageDir);
          return downloadTo(CDN + "/minecraft-loaders/loaders/optifine/" + jarName,
            J(stageDir, jarName), token, jarName).then(function () {
            try { Ext.writeText(optifineMarkerPath(forgeId), JSON.stringify({ jar: jarName, mc: mc })); } catch (_) {}
            return forgeId;
          });
        }).catch(function (e) {
          dlog("optifine_forge_fallback", { mc: mc, error: e && e.message });
          return DL.installOptifine(mc, token, false);
        });
      });
    }
    else if (loader === "fabric" || loader === "quilt") {
      installer = (loader === "quilt" ? POLY.quilt_loaders : POLY.fabric_loaders)({ mcVersion: mc }).then(function (list) {
        var lv = (list && list[0] && ((list[0].loader && list[0].loader.version) || list[0].version)) || "";
        if (!lv) throw new Error(loader + " برای این نسخه روی سرورِ ایران موجود نیست");
        return (loader === "quilt" ? POLY.install_quilt : POLY.install_fabric)({ mcVersion: mc, loaderVersion: lv, token: token });
      });
    } else return Promise.reject(new Error("لودرِ ناشناخته: " + loader));
    return installer.then(function (versionId) {
      var id = String(versionId || mc);
      try {
        var lp = J(MC, "launcher_profiles.json");
        var obj = {}; try { obj = JSON.parse(Ext.readText(lp) || "{}"); } catch (_) { obj = {}; }
        if (!obj.profiles) obj.profiles = {};
        var key = Object.keys(obj.profiles).filter(function (k) { return obj.profiles[k].lastVersionId === id; })[0];
        if (!key) { key = genUuid(); obj.profiles[key] = { lastVersionId: id }; }
        obj.profiles[key].name = name;
        if (ram > 0) obj.profiles[key].javaArgs = "-Xmx" + ram + "M";
        Ext.writeText(lp, JSON.stringify(obj));
      } catch (_) {}
      // `id` MUST be the real launcher_profiles.json key (`key`), not the version string
      // (`id` — kept separately below as `version`): every other instance_* command (launch,
      // content_install, worlds, delete, export…) is keyed by this value, and instance_launch
      // forwards it to native untouched (MIHAN-LAUNCH-GATE). Returning the version string here
      // used to make native's key lookup miss and silently fall back to launching whatever
      // profile was previously active — so a freshly created/modded profile's own content
      // (installed under this same wrong id) never actually launched.
      return { name: name, loader: loader, base_version: mc, version: id, icon: icon, id: key, ram: ram };
    });
  };
  // نصبِ نیمه‌کاره دیگر «یتیم» نمی‌ماند: هیچ نصبی پروسه‌ی اپ را نمی‌بندد (نه فورج،
  // نه آپتی‌فاین — هر دو حالا صرفاً دانلود از CDN ایران‌اند) و پروفایل فقط بعد از
  // نوشتنِ markerِ استیج ساخته می‌شود. ولی نسخه‌هایی که با بیلدهای قبلی نیمه‌کاره
  // مانده‌اند (یا با دست وارد شده‌اند) marker ندارند؛ آن‌ها را در اولین اجرا خودِ
  // stageVersion (که قبل از هر لانچ صدا زده می‌شود) کامل می‌کند.
  POLY.scan_orphaned_versions = function () {
    return Promise.resolve(DL.unstagedVersions().map(function (id) {
      return { id: id, version: id, name: id, staged: false };
    }));
  };
  POLY.import_orphaned_version = function (a) {
    var id = String((a && (a.id || a.version || a.versionId)) || "");
    if (!id) return Promise.reject(new Error("نسخه مشخص نشده"));
    return DL.stageVersion(id, (a && a.token) || ("import-" + id)).then(function () {
      DL.writeProfile(id);
      return id;
    });
  };

  // خانه‌ی SFUِ صدا دو بار عوض شده و این‌جا روی نسلِ دوم جا مانده بود:
  // اندروید به cdn.mihancraft.com (‎5.42.217.15‎، همان جعبه‌ی سایت/دانلود) وصل می‌شد
  // در حالی که دسکتاپ مدت‌هاست روی auth.mihancraft.com/voice2 (‎5.42.217.17‎) است —
  // یعنی کاربرِ گوشی روی یک SFUِ دیگر می‌نشست و فهرستِ روم‌ها برایش خالی بود
  // («همه‌ی روم‌ها لود نمی‌شود»). فهرست و مقصد عیناً از src-tauri/src/lib.rs
  // (voice_info) گرفته شده تا هر آدرسی که تا امروز فرستاده‌ایم مهاجرت کند؛
  // آدرسِ سفارشیِ خودِ کاربر (سرورِ شخصی) دست‌نخورده می‌ماند.
  var VOICE_ENDPOINT = "wss://auth.mihancraft.com/voice2";
  var SHIPPED_VOICE_URLS = [
    "auth.mihancraft.com/voice",   // تا ۴۳
    "cdn.mihancraft.com/voice",    // ۴۴
    "cdn.mihancraft.com/voice2",   // ۴۵–۴۶
  ];
  POLY.voice_info = function () {
    var c = cfg();
    var url = String(c.voice_url || "");
    var ours = SHIPPED_VOICE_URLS.some(function (u) { return url.indexOf(u) >= 0; });
    if (!url.trim() || ours) url = VOICE_ENDPOINT;
    var token = String(c.account_token || "");
    return Promise.resolve({
      url: url.trim(), token: token,
      username: c.account_username || "", avatar: c.account_avatar || "",
      logged_in: token.trim() !== "",
    });
  };
  POLY.chat_info = function () {
    var c = cfg();
    var url = String(c.chat_url || "");
    if (!url.trim()) url = "wss://auth.mihancraft.com/chat";
    var token = String(c.account_token || "");
    return Promise.resolve({
      url: url.trim(), token: token,
      username: c.account_username || "", avatar: c.account_avatar || "",
      logged_in: token.trim() !== "",
    });
  };

  // ── consolidated overrides (audit-derived, ported from desktop) ──
/**
 * سرورِ اسکین/شنل فقط `accounts: [{name, uuid}, …]` را می‌فهمد و هر عضوی که dict نباشد
 * را بی‌صدا دور می‌اندازد (نگاه کن به h_skin_upload در auth-server/server.py). ولی مودالِ
 * «انتخابِ شنل — <حساب>» در app.js آن را به شکلِ `accounts: [account.uuid]` یعنی آرایه‌ای
 * از رشته می‌فرستد. نتیجه: لیست عملاً خالی می‌شد، سرور به شاخه‌ی «حسابِ خودِ کاربر»
 * می‌افتاد و کازمتیک روی حسابِ لانچر می‌نشست نه حسابی که کاربر انتخاب کرده بود. این‌جا هر
 * دو شکل (رشته‌ی uuid/نام، یا آبجکت) به شکلِ موردِ انتظارِ سرور نگاشت می‌شود.
 */
function normalizeAccountRefs(list) {
  if (list == null) return null;
  var all = (cfg().accounts || []).filter(function (x) { return x && x.username; });
  var out = [];
  (list || []).forEach(function (it) {
    if (it && typeof it === "object" && it.name) {
      out.push({ name: String(it.name), uuid: String(it.uuid || "") });
      return;
    }
    var key = String((it && it.uuid) || it || "");
    if (!key) return;
    var m = all.filter(function (x) { return x.uuid === key || x.username === key; })[0];
    if (m) out.push({ name: m.username, uuid: m.uuid || "" });
  });
  return out;
}

POLY.skin_upload = function (a) {
  var tok = accountToken();
  if (!tok) return Promise.reject(new Error("اول وارد حساب لانچر شو (تب «حساب لانچر»)."));
  var only = a.accounts != null;
  var accounts = normalizeAccountRefs(a.accounts);
  if (!accounts) {
    accounts = (cfg().accounts || []).filter(function (x) { return x && x.username; })
      .map(function (x) { return { name: x.username, uuid: x.uuid || "" }; });
  }
  return postJson(accountBase() + "/api/skin/upload",
    { token: tok, image: a.image, model: a.model, accounts: accounts, only: only })
    .then(function (res) { if (res && res.ok === false) throw new Error(res.error || "درخواست ناموفق بود."); return res; });
  };

POLY.skin_gallery = function (a) {
  return getJson(accountBase() + "/api/skin/list").catch(function () { return { skins: [] }; });
  };

/**
 * مودالِ «انتخابِ اسکین — <حساب>» (app.js) این کامند را صدا می‌زند، نه skin_upload را.
 * تا حالا این‌جا پیاده نشده بود، پس درخواست به بریجِ نیتیو می‌افتاد — و آن‌جا فقط اسکین را
 * *محلی* روی حسابِ خودِ Pojav ست می‌کند و هیچ‌وقت چیزی به auth.mihancraft.com نمی‌فرستد.
 * ظاهرش هم موفق بود (آواتار عوض می‌شد و «اسکین ثبت شد» می‌آمد) ولی روی سرور هیچ تغییری
 * نمی‌کرد، و چون CustomSkinLoader اسکین را از همان سرور می‌گیرد، داخلِ بازی/سرورها هرگز
 * اسکینِ انتخاب‌شده دیده نمی‌شد. روی دستگاه تأیید شد: انتخاب از گالری هیچ اثری روی
 * /csl/<user>.json نداشت. حالا به همان skin_upload وصل می‌شود، منتها فقط برای همان یک
 * حساب (accounts پرشده ⇒ only=true).
 */
POLY.account_set_skin = function (a) {
  var accs = normalizeAccountRefs([(a && a.uuid) || ""]);
  if (!accs || !accs.length) return Promise.reject(new Error("حسابِ موردنظر پیدا نشد."));
  return POLY.skin_upload({ image: a.image, model: a.model, accounts: accs });
  };

POLY.cape_upload = function (a) {
  var tok = accountToken();
  if (!tok) return Promise.reject(new Error("اول وارد حساب لانچر شو (تب «حساب لانچر»)."));
  var only = a.accounts != null;
  var accounts = normalizeAccountRefs(a.accounts);
  if (!accounts) {
    accounts = (cfg().accounts || []).filter(function (x) { return x && x.username; })
      .map(function (x) { return { name: x.username, uuid: x.uuid || "" }; });
  }
  return postJson(accountBase() + "/api/cape/upload",
    { token: tok, image: a.image, accounts: accounts, only: only })
    .then(function (res) { if (res && res.ok === false) throw new Error(res.error || "درخواست ناموفق بود."); return res; });
  };

POLY.cape_select = function (a) {
  var tok = accountToken();
  if (!tok) return Promise.reject(new Error("اول وارد حساب لانچر شو (تب «حساب لانچر»)."));
  var only = a.accounts != null;
  var accounts = normalizeAccountRefs(a.accounts);
  if (!accounts) {
    accounts = (cfg().accounts || []).filter(function (x) { return x && x.username; })
      .map(function (x) { return { name: x.username, uuid: x.uuid || "" }; });
  }
  return postJson(accountBase() + "/api/cape/select",
    { token: tok, url: a.url, accounts: accounts, only: only })
    .then(function (res) { if (res && res.ok === false) throw new Error(res.error || "درخواست ناموفق بود."); return res; });
  };

POLY.cape_remove = function (a) {
  var tok = accountToken();
  if (!tok) return Promise.reject(new Error("اول وارد حساب لانچر شو (تب «حساب لانچر»)."));
  var only = a.accounts != null;
  var accounts = normalizeAccountRefs(a.accounts);
  if (!accounts) {
    accounts = (cfg().accounts || []).filter(function (x) { return x && x.username; })
      .map(function (x) { return { name: x.username, uuid: x.uuid || "" }; });
  }
  return postJson(accountBase() + "/api/cape/remove",
    { token: tok, accounts: accounts, only: only })
    .then(function (res) { if (res && res.ok === false) throw new Error(res.error || "درخواست ناموفق بود."); return res; });
  };

  // ── Instances, worlds, backups, migrate ──

POLY.worlds_list = function (a) {
function scanSaves(savesDir, instance, out) {
  var entries;
  try { entries = JSON.parse(Ext.list(savesDir) || "[]"); } catch (_) { return; }
  entries.forEach(function (e) {
    if (!e.is_dir) return;
    var p = J(savesDir, e.name), iconP = J(p, "icon.png");
    out.push({
      name: e.name, path: p, saves_dir: savesDir, instance: instance || "",
      icon: Ext.exists(iconP) ? iconP : "",
      size: Number(Ext.sizeOf(p) || 0),
      modified: e.modified || 0,
      valid: Ext.exists(J(p, "level.dat")),
      version: "",
    });
  });
}
var out = [];
// پوشه‌ی مشترکِ قدیمی هنوز اسکن می‌شود (نصب‌های قبل از جداسازی، و کاربرانی که هنوز مهاجرت
// نکرده‌اند)، به‌علاوه‌ی پوشه‌ی اختصاصیِ هر پروفایل که دنیاها از این به بعد آن‌جا ساخته می‌شوند.
scanSaves(J(MC, "saves"), "", out);
try {
  var _profRoot = J(GAME_HOME, PROF_ROOT_REL);
  JSON.parse(Ext.list(_profRoot) || "[]").forEach(function (e) {
    if (e.is_dir) scanSaves(J(_profRoot, e.name, "saves"), e.name, out);
  });
} catch (_) {}
var insts;
try { insts = JSON.parse(Ext.list(INST) || "[]"); } catch (_) { insts = []; }
insts.forEach(function (e) {
  if (e.is_dir) scanSaves(J(INST, e.name, ".minecraft", "saves"), e.name, out);
});
out.sort(function (a, b) { return b.modified - a.modified; });
return Promise.resolve(out);
  };

POLY.world_delete = function (a) {
var p = a.path;
if (p && Ext.exists(p)) Ext.del(p);
return Promise.resolve(null);
  };

POLY.world_dims = function (a) {
var base = a.worldPath;
var cands = [
  ["overworld", "اصلی (Overworld)", J(base, "region")],
  ["nether", "نتر (Nether)", J(base, "DIM-1", "region")],
  ["end", "اند (The End)", J(base, "DIM1", "region")],
];
var out = [];
cands.forEach(function (c) {
  var entries;
  try { entries = JSON.parse(Ext.list(c[2]) || "[]"); } catch (_) { entries = []; }
  var hasMca = entries.some(function (e) { return !e.is_dir && /\.mca$/i.test(e.name); });
  if (hasMca) out.push({ id: c[0], label: c[1], dir: c[2] });
});
return Promise.resolve(out);
  };

POLY.screenshots_all = function (a) {
function collectDir(shotsDir, source, out) {
  var entries;
  try { entries = JSON.parse(Ext.list(shotsDir) || "[]"); } catch (_) { return; }
  entries.forEach(function (e) {
    if (e.is_dir || !/\.(png|jpe?g)$/i.test(e.name)) return;
    out.push({ path: J(shotsDir, e.name), name: e.name, source: source, modified: e.modified || 0, size: e.size || 0 });
  });
}
var PRUNE = { libraries: 1, assets: 1, mods: 1, resourcepacks: 1, shaderpacks: 1, logs: 1, cache: 1, "crash-reports": 1 };
function collect(dir, source, out, depth) {
  var entries;
  try { entries = JSON.parse(Ext.list(dir) || "[]"); } catch (_) { return; }
  entries.forEach(function (e) {
    if (!e.is_dir) return;
    var n = e.name.toLowerCase();
    if (n === "screenshots") { collectDir(J(dir, e.name), source, out); return; }
    if (depth <= 0 || PRUNE[n]) return;
    collect(J(dir, e.name), source, out, depth - 1);
  });
}
var out = [];
collect(MC, "نسخه اصلی", out, 6);
// per-profile content lives in the external instances root; without this a profile's worlds
// and configs were invisible to the backup picker for the same reason fsBase was blind.
try {
  var _pr = J(GAME_HOME, PROF_ROOT_REL);
  JSON.parse(Ext.list(_pr) || "[]").forEach(function (e) {
    if (e.is_dir) collect(J(_pr, e.name), e.name, out, 6);
  });
} catch (_) {}
var insts;
try { insts = JSON.parse(Ext.list(INST) || "[]"); } catch (_) { insts = []; }
insts.forEach(function (e) {
  if (!e.is_dir) return;
  var label = e.name;
  try { var m = JSON.parse(Ext.readText(J(INST, e.name, "instance.json"))); if (m && m.name) label = m.name; } catch (_) {}
  collect(J(INST, e.name, ".minecraft"), label, out, 6);
});
out.sort(function (a, b) { return b.modified - a.modified; });
return Promise.resolve(out);
  };

POLY.screenshot_delete = function (a) {
var p = a.path;
if (p && /\.(png|jpe?g)$/i.test(p) && Ext.exists(p)) Ext.del(p);
return Promise.resolve(null);
  };

POLY.create_backup = function (a) {
var comps = a.components || [];
var label = String(a.label || "").trim();
var destDir = cfgGet("backup_dir", "") || J(DATA, "backups");
Ext.mkdirs(destDir);
function p2(n) { return (n < 10 ? "0" : "") + n; }
var d = new Date();
var ts = "" + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "_" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
var tag = label.replace(/\s+/g, "-").slice(0, 24) || "mc";
var out = J(destDir, tag + "_" + ts + ".zip");
// accept both desktop keys and the mobile folder-name components
var ALIAS = { worlds: ["saves"], config: ["config", "options.txt", "servers.dat"] };
var paths = [];
comps.forEach(function (c) {
  if (c === "servers") return; // no local server processes on mobile
  var rels = ALIAS[c] || [c];
  rels.forEach(function (r) { var abs = J(MC, r); if (Ext.exists(abs)) paths.push(abs); });
});
if (!paths.length) { emit("backup://status", "هیچ موردی برای بک‌آپ پیدا نشد."); return Promise.resolve(""); }
emit("backup://status", "در حال فشرده‌سازی...");
Ext.zip(out, MC, JSON.stringify(paths));
emit("backup://status", "✓ پشتیبان ساخته شد");
return Promise.resolve(out);
  };

POLY.list_backups = function (a) {
var destDir = cfgGet("backup_dir", "") || J(DATA, "backups");
Ext.mkdirs(destDir);
var entries;
try { entries = JSON.parse(Ext.list(destDir) || "[]"); } catch (_) { entries = []; }
var out = entries.filter(function (e) { return !e.is_dir && /\.zip$/i.test(e.name); }).map(function (e) {
  var path = J(destDir, e.name), comps = [];
  try {
    var names = JSON.parse(Ext.zipEntries(path) || "[]"), seen = {};
    names.forEach(function (n) {
      var s = String(n).split("/")[0];
      if (s && s !== "backup_info.json" && s.indexOf(".") === -1 && !seen[s]) { seen[s] = 1; comps.push(s); }
    });
  } catch (_) {}
  var label = e.name.replace(/\.zip$/i, "").replace(/_\d{8}_\d{6}$/, "");
  return { name: e.name, path: path, size: e.size || 0, mtime: e.modified || 0, components: comps, label: label };
});
out.sort(function (a, b) { return b.mtime - a.mtime; });
return Promise.resolve(out);
  };

POLY.restore_backup = function (a) {
var zip = a.path, only = a.components || [];
if (!zip || !Ext.exists(zip)) return Promise.reject(new Error("فایل پشتیبان پیدا نشد"));
var tmp = J(DATA, "cache", "restore-" + Date.now());
Ext.mkdirs(tmp);
Ext.unzip(zip, tmp);
var tops;
try { tops = JSON.parse(Ext.list(tmp) || "[]"); } catch (_) { tops = []; }
tops.forEach(function (e) {
  var comp = e.name;
  if (comp === "backup_info.json") return;
  if (only.length && only.indexOf(comp) < 0) return;
  var srcAbs = J(tmp, comp);
  var dest = (comp === "servers") ? J(DATA, "servers") : J(MC, comp);
  if (e.is_dir) {
    if (Ext.exists(dest)) Ext.del(dest);
    Ext.mkdirs(MC);
    Ext.rename(srcAbs, dest);
  } else {
    Ext.copyInto(srcAbs, dest);
  }
});
Ext.del(tmp);
return Promise.resolve(null);
  };

POLY.delete_backup = function (a) {
var p = a.path;
if (p && /\.zip$/i.test(p) && Ext.exists(p)) Ext.del(p);
return Promise.resolve(null);
  };

POLY.fs_abs = function (a) {
return Promise.resolve(J(fsBase(a.name, a.instance), a.path || ""));
  };

// real reverse-tunnel (share the locally-hosted server publicly), backed by
// MihanTunnel — a Java port of mihan-agent (see relay-server/agent/main.go).
// Android can't exec the native mihan-agent/frpc binaries, same constraint as the
// game/server JVM, so this reimplements the wire protocol (TLS + yamux) natively.
POLY.tunnel_address = function (a) {
  var addr = "";
  try { addr = Ext.tunnelAddress ? (Ext.tunnelAddress(a.key) || "") : ""; } catch (_) {}
  return Promise.resolve(addr || null);
};
/**
 * a.slug اختیاری است و وقتی داده شود جای slugِ مشتق‌شده از key می‌نشیند.
 *
 * چرا لازم شد: نامِ agent روی رله «<username>-<slug>» است و اگر نشستِ قبلیِ همان نام
 * هنوز زنده دیده شود، تازه‌وارد «busy» می‌گیرد. agent هر ۳ ثانیه دوباره تلاش می‌کند،
 * ولی اگر آن نشستِ کهنه واقعاً پاسخ‌گو بماند (اتصالِ نیمه‌مرده روی شبکه‌ی موبایل، که
 * چکِ یک‌ثانیه‌ایِ رله زنده حسابش می‌کند) این وضع خودش باز نمی‌شود و کاربر هیچ آدرسی
 * نمی‌گیرد — همان اسکرین‌شات‌هایی که کاربرها فرستادند: سرور «در حال اجرا»، آدرسِ محلی
 * درست، و در کادرِ آدرسِ عمومی پیامِ خطا. با یک slugِ تازه، نامِ رله عوض می‌شود و
 * نشستِ کهنه دیگر سرِ راه نیست.
 */
POLY.tunnel_start = function (a) {
  if (!Ext || !Ext.tunnelStart) return Promise.reject(new Error("پل بومی در دسترس نیست"));
  var token = accountToken();
  if (!token) return Promise.reject(new Error("برای اشتراک‌گذاری باید وارد حسابِ لانچر شوی"));
  var slug = String((a && a.slug) || "").trim() || String(a.key || "").replace(/^srv-/, "");
  Ext.tunnelStart(String(a.key), token, slug, Number(a.localPort) || 25565);
  return Promise.resolve(null);
};
POLY.tunnel_stop = function (a) {
  try { if (Ext && Ext.tunnelStop) Ext.tunnelStop(String(a.key)); } catch (_) {}
  return Promise.resolve(null);
};
/**
 * تله‌متریِ نتیجه‌ی تونل → همان /api/tunnellog که نسخه‌ی دسکتاپ از Rust صدا می‌زند.
 * روی اندروید هیچ‌وقت پیاده نشده بود، پس در جدولِ tunnel_diag پلتفرمِ همه‌ی ۲۰۰۰۰ ردیف
 * windows بود و شکست‌های «آدرس عمومی ساخته نمی‌شود»ِ گوشی اصلاً دیده نمی‌شد — درحالی‌که
 * پرتکرارترین شکایتِ بخشِ سرور همین است. بی‌نام است (نه توکن، نه نامِ سرور).
 */
POLY.tunnel_log = function (a) {
  a = a || {};
  var body = {
    platform: "android",
    app_version: String(a.appVersion || ""),
    success: !!a.success,
    reason: String(a.reason || ""),
    detail: String(a.detail || "").slice(0, 800),
    provider: "agent",
    players: Number(a.players || 0) || 0,
  };
  if (a.rttMs != null && isFinite(a.rttMs)) body.rtt_ms = Number(a.rttMs);
  if (!body.app_version) {
    try { body.app_version = String((JSON.parse(Ext.appVersion() || "{}") || {}).versionName || ""); } catch (_) {}
  }
  return postJson(accountBase() + "/api/tunnellog", body).catch(function () { return null; });
};

  // ── Mods & modpacks ──

POLY.mods_search = function (a) {
var pt = a.projectType || "mod";
    var facets = [["project_type:" + pt]];
    if (a.mcVersion) facets.push(["versions:" + a.mcVersion]);
    if (a.loader) facets.push(["categories:" + a.loader]);
    if (a.category) facets.push(["categories:" + a.category]);
    var params = [
      "query=" + encodeURIComponent(a.query || ""),
      "facets=" + encodeURIComponent(JSON.stringify(facets)),
      "limit=" + encodeURIComponent(a.limit != null ? a.limit : 20),
      "offset=" + encodeURIComponent(a.offset != null ? a.offset : 0),
      "index=relevance"
    ];
    var url = "https://api.modrinth.com/v2/search?" + params.join("&");
    return getJson(url);
  };

POLY.content_installed = function (a) {
var kind = String(a.kind || "mod");
    var sub = contentSubdir(kind);
    // Reads exactly where the installers write — ensureProfileDir(instance), i.e. the profile's
    // own game dir (or the shared one when no instance is given).
    //
    // This used to disagree with its own installers in two ways that both guaranteed an empty
    // list, because the UI always passes the selected profile as `instance`:
    //   • it read J(INST, instance, ".minecraft"), a folder nothing ever wrote to or launched
    //     from — INST is on INTERNAL storage, while the game runs out of external storage;
    //   • before even that, it bailed out with [] unless INST/<instance>/instance.json declared a
    //     mod loader — a file these profiles do not have, since they come from
    //     launcher_profiles.json.
    // So "نصب‌شده‌ها" was empty no matter what, and a mod that had downloaded perfectly looked
    // like it had failed. That is the "installs to 100% then silently isn't installed" report.
    var dir = J(ensureProfileDir(a.instance), sub);
    Ext.mkdirs(dir);
    var entries = JSON.parse(Ext.list(dir) || "[]");
    var out = entries.filter(function (e) {
      if (e.is_dir) return false;
      var stripped = e.name.toLowerCase().replace(/\.disabled$/i, "");
      return /\.(jar|zip)$/.test(stripped);
    }).map(function (e) {
      return { name: e.name, path: J(dir, e.name), enabled: !/\.disabled$/i.test(e.name), size: e.size };
    }).sort(function (x, y) { return x.name.localeCompare(y.name); });
    return Promise.resolve(out);
  };

POLY.mods_toggle = function (a) {
var path = String(a.path || "");
    var enabled = !!a.enabled;
    var newPath = enabled ? path.replace(/\.disabled$/, "") : path + ".disabled";
    if (newPath !== path) Ext.rename(path, newPath);
    return Promise.resolve(newPath);
  };

POLY.mods_delete = function (a) {
if (a.path) Ext.del(a.path);
    return Promise.resolve(null);
  };

  // ── Server maker (host) ──

POLY.server_kinds = function (a) {
// neoforge/quilt removed: resolveServerUrl() unconditionally rejects them ("not supported on
// mobile yet") REGARDLESS of download_source, and no iranServerTree path covers them either
// (hasTree only matches paper/purpur/fabric/forge in installServer) \u2014 there is no configuration
// in which they can ever succeed on Android, yet they were listed identically to kinds that
// actually work. Worse, a failed attempt under the default Iran source told the user to "switch
// download source and pick Paper/Purpur", and switching source just traded that message for the
// same unconditional rejection \u2014 a confusing dead end. paper/purpur/fabric/forge (via the Iran
// server tree) and vanilla/folia (when download_source is non-Iran) all have at least one real
// working path, so they stay.
return Promise.resolve([
    { id: "paper", label: "Paper", desc: "\u0645\u062d\u0628\u0648\u0628\u200c\u062a\u0631\u06cc\u0646\u060c \u0628\u0647\u06cc\u0646\u0647 \u0648 \u0633\u0627\u0632\u06af\u0627\u0631 \u0628\u0627 \u067e\u0644\u0627\u06af\u06cc\u0646", proxy: false },
    { id: "purpur", label: "Purpur", desc: "\u0628\u0631 \u067e\u0627\u06cc\u0647\u200c\u06cc Paper \u0628\u0627 \u0627\u0645\u06a9\u0627\u0646\u0627\u062a \u0628\u06cc\u0634\u062a\u0631", proxy: false },
    { id: "folia", label: "Folia", desc: "\u0686\u0646\u062f\u0646\u062e\u06cc \u0628\u0631\u0627\u06cc \u0633\u0631\u0648\u0631\u0647\u0627\u06cc \u067e\u0631\u062c\u0645\u0639\u06cc\u062a", proxy: false },
    { id: "vanilla", label: "Vanilla", desc: "\u0633\u0631\u0648\u0631 \u0631\u0633\u0645\u06cc \u0645\u0648\u062c\u0646\u06af", proxy: false },
    { id: "fabric", label: "Fabric", desc: "\u0628\u0631\u0627\u06cc \u0645\u0627\u062f \u0628\u0627 \u0644\u0648\u062f\u0631 Fabric", proxy: false },
    { id: "forge", label: "Forge", desc: "\u0628\u0632\u0631\u06af\u200c\u062a\u0631\u06cc\u0646 \u0627\u06a9\u0648\u0633\u06cc\u0633\u062a\u0645 \u0645\u0627\u062f", proxy: false }
  ]);
  };

POLY.server_versions = function (a) {
var kind = String(a.kind || "paper").toLowerCase();
  var snap = !!a.showSnapshots;
  function verKey(s){ return String(s).split(/[._-]/).map(function(p){ var n=parseInt(p,10); return isNaN(n)?-1:n; }); }
  function cmpDesc(x,y){ var kx=verKey(x),ky=verKey(y),n=Math.max(kx.length,ky.length); for(var i=0;i<n;i++){ var a1=kx[i]||0,b1=ky[i]||0; if(a1!==b1) return b1-a1; } return 0; }
  function vanilla(){
    return DL.versionManifest().then(function(man){
      var vs=(man&&man.versions)||[];
      return vs.filter(function(v){ return v.type==="release"||(snap&&v.type==="snapshot"); }).map(function(v){ return v.id; });
    });
  }
  function papermc(project){
    // فهرستِ نسخه‌ها از iran-index.servers (paper). فولیا/ولاسیتی/… معادلِ ایرانی ندارند → paper.
    var key = (project==="paper"||project==="purpur")?project:"paper";
    return DL.iranList("servers", key).then(function(list){
      var out=(list||[]).slice(); out.sort(cmpDesc); return out;
    });
  }
  function purpur(){
    return DL.iranList("servers","purpur").then(function(list){ var out=(list||[]).slice(); out.sort(cmpDesc); return out; });
  }
  var p;
  if(kind==="vanilla"||kind==="fabric"||kind==="forge"||kind==="neoforge"||kind==="quilt") p=vanilla();
  else if(kind==="purpur") p=purpur();
  else if(kind==="folia") p=papermc("folia");
  else if(kind==="velocity") p=papermc("velocity");
  else if(kind==="waterfall") p=papermc("waterfall");
  else p=papermc("paper");
  return p.then(function(list){ return (list&&list.length)?list:vanilla(); }).catch(function(){ return vanilla().catch(function(){ return []; }); });
  };

// app.js has no direct access to mihan-download.js's internal listFailed flag (it only ever
// sees the plain array server_versions resolves to) — this lets loadVer() tell "genuinely no
// versions for this loader" apart from "the version_manifest/iran-index fetch itself failed",
// after an empty server_versions result, the same distinction _iranIdxFailed already makes for
// the separate native iran_index bridge path.
POLY.server_versions_list_failed = function (a) {
return Promise.resolve(!!(DL && DL.didListFail && DL.didListFail()));
  };

POLY.server_running = function (a) {
return Promise.resolve(false);
  };

POLY.server_ready = function (a) {
var d = serverDir(a.name);
  var f = J(d, "launcher_server.json");
  if (!Ext.exists(f)) return Promise.resolve(false);
  try {
    var m = JSON.parse(Ext.readText(f));
    if (m.install_state && m.install_state !== "ready" && m.install_state !== "recovered") return Promise.resolve(false);
    if (Array.isArray(m.run_args) && m.run_args.length) return Promise.resolve(true);
    return Promise.resolve(Ext.exists(J(d, "server.jar")));
  } catch (_) { return Promise.resolve(false); }
  };

/**
 * سروری که همه‌ی فایل‌هایش آمده ولی برای همیشه روی «در حال نصب» مانده را تمام می‌کند.
 *
 * زنجیره‌ی نصب یا install_state را «ready» می‌کند یا در catch «error» — ولی اگر بینِ این دو
 * متوقف شود (مشاهده‌ی واقعی روی دستگاه: eula.txt نوشته شده بود، server.properties نه، و متا
 * دست‌نخورده روی installing مانده بود) هیچ‌کدام اجرا نمی‌شود. نتیجه از دیدِ کاربر: سرور دانلود
 * شده ولی برای همیشه «در حال نصب» است و دکمه‌ی اجرا کار نمی‌کند — همان «سرورم روشن نمیشه».
 *
 * برای این‌که نصبِ واقعاً درحال‌انجام را قطع نکنیم، فقط وقتی وارد عمل می‌شویم که مدتی هیچ‌چیز
 * روی server.jar ننوشته باشد؛ تا وقتی دانلود زنده است mtime تازه می‌ماند.
 */
var STALLED_AFTER_MS = 90 * 1000;
function finishStalledInstall(base, name, m) {
  if (!m || m.install_state !== "installing") return m;
  var dir = J(base, name);
  var jar = J(dir, "server.jar");
  if (!Ext.exists(jar)) return m;                       // هنوز چیزی نیامده → واقعاً درحال نصب
  var mtime = 0;
  try {
    JSON.parse(Ext.list(dir) || "[]").forEach(function (x) {
      if (String(x.name) === "server.jar") mtime = Number(x.modified) || 0;
    });
  } catch (_) {}
  if (!mtime || (Date.now() - mtime) < STALLED_AFTER_MS) return m;   // دانلود هنوز فعال است
  // همان کارِ پایانیِ زنجیره‌ی نصب را انجام بده (نوشتنِ eula و server.properties از روی متا).
  try { Ext.writeText(J(dir, "eula.txt"), "eula=true\n"); } catch (_) {}
  try {
    var online = !!(m.online_mode || m.launcher_only);
    Ext.writeText(J(dir, "server.properties"), [
      "server-port=" + (m.port || 25565), "query.port=" + (m.port || 25565),
      "online-mode=" + (online ? "true" : "false"),
      "enforce-secure-profile=" + (online ? "true" : "false"),
      "motd=" + (m.motd || "ساخته‌شده با لانچر میهن‌کرفت"),
      "max-players=" + (m.max_players || 10),
      "difficulty=" + (m.difficulty || "easy"),
      "gamemode=" + (m.gamemode || "survival"),
      "enable-command-block=true", "enable-rcon=true",
      "rcon.port=" + (m.rcon_port || 25575),
      "rcon.password=" + (m.rcon_password || randToken(18)),
      "broadcast-rcon-to-ops=false"
    ].join("\n") + "\n");
  } catch (_) {}
  m.install_state = "ready";
  m.last_error = "";
  m.updated = Math.floor(Date.now() / 1000);
  try {
    var f = J(dir, "launcher_server.json");
    if (Ext.atomicWriteText) Ext.atomicWriteText(f, JSON.stringify(m)); else Ext.writeText(f, JSON.stringify(m));
  } catch (_) {}
  dlog("server_install_unstuck", { server: name });
  return m;
}

POLY.server_list = function (a) {
var base = J(DATA, "servers");
  try { Ext.mkdirs(base); } catch (_) {}
  var entries;
  try { entries = JSON.parse(Ext.list(base) || "[]"); } catch (_) { entries = []; }
  var out = [];
  entries.forEach(function (e) {
    if (!e.is_dir) return;
    var f = J(base, e.name, "launcher_server.json");
    var m = null;
    if (Ext.exists(f)) {
      try { m = JSON.parse(Ext.readText(f)); }
      catch (_) {
        m = { name: e.name, display_name: e.name, install_state: "error", last_error: "اطلاعات سرور آسیب دیده است؛ فایل‌ها حذف نشده‌اند.", server_type: "unknown", version: "؟", ram: 0 };
      }
    } else {
      // نسخه‌های قدیمی پس از خطای آخرین فایل CDN پوشه و server.jar را جا می‌گذاشتند
      // اما متادیتا نداشتند؛ آن‌ها را بازیابی می‌کنیم تا دوباره در «سرورهای من» دیده شوند.
      var dir = J(base, e.name), children = [];
      try { children = JSON.parse(Ext.list(dir) || "[]"); } catch (_) {}
      if (!children.length) return;
      var hasJar = Ext.exists(J(dir, "server.jar"));
      var recoveredVersion = "نامشخص";
      if (hasJar) {
        try {
          var cacheFiles = JSON.parse(Ext.list(J(dir, "cache")) || "[]");
          cacheFiles.some(function (x) { var mm = String(x.name || "").match(/^mojang[_-](.+)\.jar$/i); if (mm) { recoveredVersion = mm[1]; return true; } return false; });
        } catch (_) {}
      }
      var recoveredRcon = randToken(18);
      m = {
        name: e.name, display_name: e.name, server_type: "paper", version: recoveredVersion, ram: 1024,
        port: 25565, rcon_port: 25575, rcon_password: recoveredRcon, online_mode: false, created: Math.floor((Number(e.modified) || Date.now()) / 1000),
        install_state: hasJar ? "recovered" : "error",
        last_error: hasJar ? "این سرور از نصب قدیمی بازیابی شد؛ پیش از اجرا تنظیماتش را بررسی کن." : "نصب قبلی نیمه‌کاره مانده است؛ ادامه دانلود یا حذف را انتخاب کن."
      };
      if (hasJar) {
        try { if (!Ext.exists(J(dir, "eula.txt"))) Ext.writeText(J(dir, "eula.txt"), "eula=true\n"); } catch (_) {}
        try {
          if (!Ext.exists(J(dir, "server.properties"))) Ext.writeText(J(dir, "server.properties"), [
            "server-port=25565", "query.port=25565", "online-mode=false", "enforce-secure-profile=false",
            "motd=بازیابی‌شده با لانچر میهن‌کرفت", "max-players=10", "difficulty=easy", "gamemode=survival",
            "enable-command-block=true", "enable-rcon=true", "rcon.port=25575", "rcon.password=" + recoveredRcon, "broadcast-rcon-to-ops=false"
          ].join("\n") + "\n");
        } catch (_) {}
      }
      try { if (Ext.atomicWriteText) Ext.atomicWriteText(f, JSON.stringify(m)); else Ext.writeText(f, JSON.stringify(m)); } catch (_) {}
    }
    m.name = e.name; // مسیر فقط از نام واقعی پوشه می‌آید، نه داده‌ی قابل‌دستکاریِ JSON
    m.display_name = String(m.display_name || m.name || e.name);
    try { m = finishStalledInstall(base, e.name, m); } catch (_) {}
    if (!m.install_state) m.install_state = (Array.isArray(m.run_args) && m.run_args.length) || Ext.exists(J(base, e.name, "server.jar")) ? "ready" : "error";
    out.push(m);
  });
  out.sort(function (x, y) { return String(x.display_name || x.name || "").localeCompare(String(y.display_name || y.name || "")); });
  return Promise.resolve(out);
  };

POLY.server_players = function (a) {
return Promise.resolve({ online: [], known: [] });
  };

POLY.server_plugins_list = function (a) {
var folder = (a.folder === "mods") ? "mods" : "plugins";
  var dir = J(serverDir(a.name), folder);
  var entries;
  try { entries = JSON.parse(Ext.list(dir) || "[]"); } catch (_) { entries = []; }
  var out = entries.filter(function (e) { return !e.is_dir && /\.jar$/i.test(e.name); }).map(function (e) {
    return { name: e.name, path: J(dir, e.name), size: e.size };
  });
  out.sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
  return Promise.resolve(out);
  };

  // ── Social/friends/DM/community ──

POLY.dm_send = function (a) {
var body = { to: a.to, text: a.text || "", post_id: (a.postId != null ? a.postId : (a.post_id != null ? a.post_id : 0)), reply_to: (a.replyTo != null ? a.replyTo : (a.reply_to != null ? a.reply_to : 0)) };
  if (a.audio) { body.audio = a.audio; body.vdur = (a.vdur != null ? a.vdur : 0); }
  // عکس/ویدیو/گیف/استیکر/فایل. این دو تا اینجا ساخته نمی‌شدند و رابط هم آن‌ها را
  // می‌فرستاد، پس سرور پیام را «متنیِ خالی» می‌دید و «متن پیام لازم است» با HTTP 400
  // برمی‌گرداند — یعنی ارسالِ رسانه در دایرکتِ موبایل هیچ‌وقت کار نمی‌کرد.
  // سرور فقط kindهای image/video/gif/file را می‌پذیرد؛ هر چیزِ دیگری دوباره همان ۴۰۰
  // را می‌سازد، برای همین اینجا به یکی از آن‌ها نگاشت می‌شود.
  if (a.media) {
    body.media = String(a.media);
    var k = String(a.kind || "").toLowerCase();
    body.kind = (k === "image" || k === "video" || k === "gif" || k === "file") ? k : "file";
  }
  return authPost("/api/dm/send", body).then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u0627\u0631\u0633\u0627\u0644 \u067e\u06cc\u0627\u0645 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f."); return r; });
  };
POLY.dm_forward = function (a) {
var mid = a.messageId != null ? a.messageId : a.message_id;
  return authPost("/api/dm/forward", { message_id: mid, to: a.to }).then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u0641\u0648\u0631\u0648\u0627\u0631\u062f \u0646\u0634\u062f."); return r; });
  };
POLY.dm_typing = function (a) {
return authPost("/api/dm/typing", { with: a.with }).catch(function () { return { ok: false }; });
  };

  // \u2500\u2500 \u0641\u06cc\u062f (\u067e\u0633\u062a\u200c\u0647\u0627\u06cc \u0627\u06cc\u0646\u0633\u062a\u0627\u06af\u0631\u0627\u0645\u200c\u06af\u0648\u0646\u0647) \u2014 \u0628\u062f\u0648\u0646 UI \u0631\u0648\u06cc \u0647\u06cc\u0686 \u067e\u0644\u062a\u0641\u0631\u0645\u06cc \u0646\u0628\u0648\u062f\u061b \u0627\u06cc\u0646\u062c\u0627 \u0647\u0645 \u0645\u062b\u0644 \u062f\u0633\u06a9\u062a\u0627\u067e authPost \u0633\u0627\u062f\u0647 \u2500\u2500
  function feedPostId(a) { return a.postId != null ? a.postId : a.post_id; }
  POLY.social_feed = function (a) {
    return authPost("/api/feed/list", { before: a.before != null ? a.before : 0 })
      .then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u0628\u0627\u0631\u06af\u0630\u0627\u0631\u06cc\u0650 \u0641\u06cc\u062f \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f."); return r; });
  };
  POLY.social_post = function (a) {
    var body = { text: a.text || "", image_data: a.imageData != null ? a.imageData : (a.image_data != null ? a.image_data : null), sensitive: !!a.sensitive };
    return authPost("/api/feed/post", body)
      .then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u0627\u0646\u062a\u0634\u0627\u0631\u0650 \u067e\u0633\u062a \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f."); return r; });
  };
  POLY.social_like = function (a) {
    return authPost("/api/feed/like", { post_id: feedPostId(a) })
      .then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u0644\u0627\u06cc\u06a9 \u062b\u0628\u062a \u0646\u0634\u062f."); return r; });
  };
  POLY.social_comment = function (a) {
    return authPost("/api/feed/comment", { post_id: feedPostId(a), text: a.text || "" })
      .then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u06a9\u0627\u0645\u0646\u062a \u062b\u0628\u062a \u0646\u0634\u062f."); return r; });
  };
  POLY.social_comments = function (a) {
    return authPost("/api/feed/comments", { post_id: feedPostId(a) })
      .then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u06a9\u0627\u0645\u0646\u062a\u200c\u0647\u0627 \u0628\u0627\u0631\u06af\u0630\u0627\u0631\u06cc \u0646\u0634\u062f."); return r; });
  };
  POLY.social_delete = function (a) {
    return authPost("/api/feed/delete", { post_id: feedPostId(a) })
      .then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u062d\u0630\u0641\u0650 \u067e\u0633\u062a \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f."); return r; });
  };
  POLY.user_posts = function (a) {
    return authPost("/api/user/posts", { username: a.username, before: a.before != null ? a.before : 0 })
      .then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u0628\u0627\u0631\u06af\u0630\u0627\u0631\u06cc\u0650 \u067e\u0633\u062a\u200c\u0647\u0627 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f."); return r; });
  };

POLY.change_password = function (a) {
var oldp = a.oldPassword != null ? a.oldPassword : (a.old_password != null ? a.old_password : (a.old || ""));
  var newp = a.newPassword != null ? a.newPassword : (a.new_password != null ? a.new_password : (a["new"] || ""));
  return authPost("/api/profile/change_password", { old_password: oldp, new_password: newp }).then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u062a\u063a\u06cc\u06cc\u0631 \u0631\u0645\u0632 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f."); return r; });
  };

  // \u2500\u2500 \u067e\u0631\u0648\u0641\u0627\u06cc\u0644: \u0628\u06cc\u0648/\u0644\u06cc\u0646\u06a9/\u0646\u0627\u0645\u0650\u200c\u0646\u0645\u0627\u06cc\u0634\u06cc \u0648 \u06a9\u0627\u0648\u0631 \u2014 \u062a\u0627\u0632\u0647\u060c \u0645\u062b\u0644\u0650 \u0628\u062e\u0634\u0650 \u0641\u06cc\u062f \u0647\u06cc\u0686\u200c\u062c\u0627 \u0635\u062f\u0627 \u0632\u062f\u0647 \u0646\u0645\u06cc\u200c\u0634\u062f\u0646\u062f \u2500\u2500
  POLY.profile_update = function (a) {
    var displayName = a.displayName != null ? a.displayName : (a.display_name != null ? a.display_name : "");
    return authPost("/api/profile/update", { bio: a.bio || "", links: a.links || [], display_name: displayName })
      .then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u0628\u0647\u200c\u0631\u0648\u0632\u0631\u0633\u0627\u0646\u06cc\u0650 \u067e\u0631\u0648\u0641\u0627\u06cc\u0644 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f."); return r; });
  };
  POLY.set_cover = function (a) {
    var data = a.imageData != null ? a.imageData : a.image_data;
    return authPost("/api/profile/cover", { data: data })
      .then(function (r) { if (r && r.ok === false) throw new Error(r.error || "\u062a\u063a\u06cc\u06cc\u0631\u0650 \u06a9\u0627\u0648\u0631 \u0646\u0627\u0645\u0648\u0641\u0642 \u0628\u0648\u062f."); return r; });
  };


  // ── ارسالِ گزارشِ مشکل ────────────────────────────────────────────────────────────────
  // پلِ بومی این کامند را دارد، ولی app_version را از BuildConfigِ خودِ APKِ پایه‌ی پوجاو
  // می‌گیرد که همیشه "1.0" است — و همین یعنی هر ۳۰۰ گزارشِ اخیرِ اندروید در پنلِ ادمین
  // app_version="1.0" دارند و اصلاً نمی‌شود فهمید کاربر روی کدام بیلد بوده. بدونِ آن، تریاژِ
  // هر باگی به «نمی‌دانم این از نسخه‌ی قبلِ رفع است یا بعدش» می‌رسد (همین حالا سرِ باگِ اسکین
  // دقیقاً همین اتفاق افتاد). پس این‌جا override می‌شود تا نسخه‌ی واقعیِ نصب‌شده برود.
  function realAppVersion() {
    try {
      var v = JSON.parse((Ext && Ext.appVersion && Ext.appVersion()) || "{}");
      if (v && v.versionName) return String(v.versionName) + (v.versionCode ? " (" + v.versionCode + ")" : "");
    } catch (_) {}
    return "";
  }
  POLY.report_submit = function (a) {
    a = a || {};
    return authPost("/api/report/upload", {
      text: a.text || "",
      images: a.images || [],
      video: a.video || "",
      voice: a.voice || "",
      platform: "android",
      app_version: realAppVersion(),
    }).then(function (r) {
      if (r && r.ok === false) throw new Error(r.error || "ارسالِ گزارش ناموفق بود.");
      return r;
    });
  };

  // ── فید/اکسپلور/هشتگ، اعلان‌ها، جست‌وجو و پروفایلِ دیگران ─────────────────────
  // همتای دسکتاپِ این‌ها در lib.rs همگی social_call ساده‌اند (POST به auth-server با
  // token داخلِ بدنه) — یعنی authPost اینجا دقیقاً همان کار را می‌کند.
  function bad(r, msg) { if (r && r.ok === false) throw new Error(r.error || msg); return r; }

  POLY.feed_explore = function (a) {
    return authPost("/api/feed/explore", { offset: (a && a.offset) || 0 })
      .then(function (r) { return bad(r, "بارگذاریِ اکسپلور ناموفق بود."); });
  };
  POLY.hashtag_trending = function () {
    return authPost("/api/hashtag/trending", {})
      .then(function (r) { return bad(r, "هشتگ‌های داغ بارگذاری نشد."); });
  };
  POLY.hashtag_posts = function (a) {
    return authPost("/api/hashtag/posts", { tag: a.tag, before: a.before != null ? a.before : 0 })
      .then(function (r) { return bad(r, "پست‌های هشتگ بارگذاری نشد."); });
  };
  POLY.social_search = function (a) {
    return authPost("/api/search", { q: a.q || "", type: a.kind || a.type || "all" })
      .then(function (r) { return bad(r, "جست‌وجو ناموفق بود."); });
  };
  POLY.suggested_users = function () {
    return authPost("/api/user/suggested", {}).catch(function () { return { users: [] }; });
  };
  POLY.mutual_connections = function (a) {
    return authPost("/api/user/mutual", { username: a.username }).catch(function () { return { users: [] }; });
  };
  // آواتارِ گروهی — تا ۳۰۰ نام در یک درخواست. شکستش نباید ردیفِ کاربر را خالی کند.
  POLY.user_avatars = function (a) {
    return authPost("/api/user/avatars", { usernames: a.usernames || [] })
      .catch(function () { return {}; });
  };
  POLY.report_content = function (a) {
    var tt = a.targetType != null ? a.targetType : a.target_type;
    var ti = a.targetId != null ? a.targetId : a.target_id;
    return authPost("/api/report/content", { target_type: tt, target_id: ti, reason: a.reason || "" })
      .then(function (r) { return bad(r, "ارسالِ گزارش ناموفق بود."); });
  };

  POLY.notifications_list = function (a) {
    return authPost("/api/notifications/list", { before: (a && a.before) || 0 })
      .catch(function () { return { items: [] }; });
  };
  POLY.notifications_read = function () {
    return authPost("/api/notifications/read", {}).catch(function () { return { ok: false }; });
  };
  POLY.notif_prefs_get = function () {
    return authPost("/api/notifications/prefs", {}).catch(function () { return { prefs: {} }; });
  };
  POLY.notif_prefs_set = function (a) {
    return authPost("/api/notifications/prefs", { prefs: (a && a.prefs) || {} })
      .then(function (r) { return bad(r, "ذخیره‌ی تنظیماتِ اعلان ناموفق بود."); });
  };

  // ── DM: ویرایش/حذف/ری‌اکشن (ارسال و فوروارد از قبل بالاتر ثبت شده‌اند) ──────────
  POLY.dm_delete = function (a) {
    var mid = a.messageId != null ? a.messageId : a.message_id;
    var fe = a.forEveryone != null ? a.forEveryone : a.for_everyone;
    return authPost("/api/dm/delete", { message_id: mid, for_everyone: !!fe })
      .then(function (r) { return bad(r, "حذفِ پیام ناموفق بود."); });
  };
  POLY.dm_edit = function (a) {
    var mid = a.messageId != null ? a.messageId : a.message_id;
    return authPost("/api/dm/edit", { message_id: mid, text: a.text || "" })
      .then(function (r) { return bad(r, "ویرایشِ پیام ناموفق بود."); });
  };
  POLY.dm_react = function (a) {
    var mid = a.messageId != null ? a.messageId : a.message_id;
    return authPost("/api/dm/react", { message_id: mid, emoji: a.emoji || "" })
      .then(function (r) { return bad(r, "ثبتِ ری‌اکشن ناموفق بود."); });
  };

  // چتِ همگانی: آپلودِ عکس/ویدیو/ویس. سرور همان data-URL را می‌گیرد که دسکتاپ می‌فرستد.
  // ── آپلودِ تکه‌ایِ فایلِ چت (chat_file_chunk/finish/abort) ────────────────────
  // مثلِ دسکتاپ: هر تکه به یک فایلِ موقت append می‌شود و در پایان همان فایل به‌صورتِ
  // بدنه‌ی خام (نه base64) به /api/chat/upload_file استریم می‌شود، با توکن و نامِ فایل
  // در هدر. جمع‌کردنِ تکه‌ها در حافظه‌ی WebView برای فایلِ ۵۰۰ مگابایتیِ پرو دوام نمی‌آورد،
  // پس هر دو کار سمتِ جاوا انجام می‌شود: Ext.appendB64 و Ext.uploadFileAsync.
  // سقف را سرور تعیین می‌کند (۲۵ مگ رایگان، ۵۰۰ مگ پرو) — این‌جا سقفی گذاشته نمی‌شود.
  function chatUploadTemp(id) {
    var safe = String(id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 64);
    return J(DATA, "cache", "chat-upload", "upl-" + safe + ".tmp");
  }
  POLY.chat_file_chunk = function (a) {
    var id = String((a && a.uploadId) || "");
    if (!id) return Promise.reject(new Error("شناسه‌ی آپلود نامعتبر است."));
    try { Ext.appendB64(chatUploadTemp(id), String((a && a.chunkB64) || "")); }
    catch (e) { return Promise.reject(new Error("نوشتنِ فایلِ موقت ناموفق بود: " + e)); }
    return Promise.resolve(true);
  };
  POLY.chat_file_abort = function (a) {
    try { Ext.del(chatUploadTemp(String((a && a.uploadId) || ""))); } catch (_) {}
    return Promise.resolve(true);
  };
  POLY.chat_file_finish = function (a) {
    var id = String((a && a.uploadId) || "");
    var tmp = chatUploadTemp(id);
    var name = (a && a.fileName) || "file";
    if (!Ext || !Ext.uploadFileAsync) return Promise.reject(new Error("پل بومی در دسترس نیست"));
    return new Promise(function (resolve, reject) {
      // همان پاک‌سازیِ خطا که javaHttp دارد: بدونِ آن، ردِ بررسیِ محتوا روی این مسیر
      // (فایل‌های بزرگ) کلِ JSON را به پیامِ خطا می‌داد و رابط چاپش می‌کرد.
      var rid = DL.pending(resolve, function (e) { reject(DL.httpError(e)); });
      try { Ext.uploadFileAsync(rid, accountBase() + "/api/chat/upload_file", tmp, accountToken(), name); }
      catch (e) { reject(DL.httpError(e)); }
    }).then(function (text) {
      try { Ext.del(tmp); } catch (_) {}
      var r = null;
      try { r = text ? JSON.parse(text) : null; } catch (_) { throw new Error("پاسخ نامعتبر از سرور."); }
      return bad(r, "آپلود ناموفق بود.");
    }, function (e) {
      try { Ext.del(tmp); } catch (_) {}
      throw e;
    });
  };

  POLY.chat_upload = function (a) {
    return authPost("/api/chat/upload", { data: a.data, kind: a.kind || "", name: a.name || "" })
      .then(function (r) { return bad(r, "آپلود ناموفق بود."); });
  };

  // ── اشتراکِ طلایی ──────────────────────────────────────────────────────────────
  POLY.pro_pricing = function () { return getJson(accountBase() + "/api/pro/pricing"); };
  POLY.pro_gift_pending = function () {
    return authPost("/api/pro/gift/pending", {}).catch(function () { return { gift: null }; });
  };
  POLY.pro_gift_ack = function (a) {
    return authPost("/api/pro/gift/ack", { id: (a && a.id) || 0 });
  };
  POLY.pro_cosmetics_set = function (a) {
    return authPost("/api/pro/cosmetics/set", {
      color: a.color || "", ring: a.ring, nameplate: a.nameplate || "none",
    }).then(function (r) { return bad(r, "ذخیره‌ی کازمتیک ناموفق بود."); });
  };
  POLY.pro_purchase_status = function (a) {
    var tid = a.trackId != null ? a.trackId : a.track_id;
    return authPost("/api/pro/purchase/status", { trackId: tid });
  };
  // دسکتاپ صفحه‌ی پرداخت را با opener در مرورگرِ سیستم باز می‌کند؛ این‌جا openExternal
  // همان کار را با Intent می‌کند. داخلِ WebView باز کردنش یعنی ردِ تراکنش با «دامنه غیرمجاز».
  POLY.pro_purchase_create = function (a) {
    var giftTo = a.giftTo != null ? a.giftTo : (a.gift_to || "");
    return authPost("/api/pro/purchase/create", { plan: a.plan, gift_to: giftTo })
      .then(function (r) {
        bad(r, "ساختِ سفارش ناموفق بود.");
        if (r && r.url) openExternal(r.url);
        return r;
      });
  };
  // سلامتِ auth + CDN — دسکتاپ هر دو را موازی پینگ می‌کند و همان شکل را برمی‌گرداند.
  POLY.pro_purchase_health = function () {
    function up(url) {
      return getText(url).then(function () { return true; }).catch(function () { return false; });
    }
    return Promise.all([up(accountBase() + "/health"), up("https://cdn.mihancraft.com/")])
      .then(function (r) { return { ok: r[0] && r[1], auth: r[0], cdn: r[1] }; });
  };

  // سهمیه‌ی دانلود — روی اندروید شمارنده‌ی بایتِ محلی (dl_quota) وجود ندارد، پس فقط
  // وضعیت را می‌خوانیم و گزارشِ مصرف را نمی‌فرستیم.
  POLY.download_quota_refresh = function () {
    if (!accountToken()) return Promise.resolve({ ok: true, is_pro: false, signed_in: false });
    return authPost("/api/download/quota", {}).catch(function () {
      return { ok: false, is_pro: false, signed_in: true };
    });
  };

  // ── کشِ تصویر: کازمتیک‌های CDN و تصویرِ محتوا ────────────────────────────────
  // هر دو یک مسیرِ محلی برمی‌گردانند؛ convertFileSrc در tauri-shim آن را به data-URI
  // تبدیل می‌کند. دانلود از راهِ Ext.downloadAsync می‌رود تا UAی لانچر ست شود (CDN
  // روی UA گیت است و fetch مستقیم ۴۰۳ می‌گیرد).
  POLY.cosmetic_asset = function (a) {
    var rel = String((a && a.rel) || "").trim().replace(/^\/+/, "");
    if (!rel || rel.length > 200 || rel.indexOf("..") >= 0 || !/^[a-z0-9\-_.\/]+\.png$/.test(rel)) {
      return Promise.reject(new Error("نامِ کازمتیک نامعتبر است"));
    }
    var dest = J(DATA, "cache", "cosmetics", rel);
    try { if (Ext.exists(dest) && Number(Ext.sizeOf(dest)) > 0) return Promise.resolve(dest); } catch (_) {}
    try { Ext.mkdirs(dest.replace(/\/[^\/]+$/, "")); } catch (_) {}
    return downloadTo("https://cdn.mihancraft.com/cosmetics/" + rel, dest, null, rel, { silent: true })
      .then(function () { return dest; });
  };
  POLY.cache_remote_image = function (a) {
    var url = String((a && a.url) || "").trim();
    if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("آدرس تصویر نامعتبر است"));
    var dir = J(DATA, "cache", "content-images");
    var key = url.replace(/[^A-Za-z0-9]+/g, "_").slice(-120);
    var raw = J(dir, key + ".raw");
    var dest = J(dir, key + ".jpg");
    try { if (Ext.exists(dest) && Number(Ext.sizeOf(dest)) > 100) return Promise.resolve(dest); } catch (_) {}
    try { Ext.mkdirs(dir); } catch (_) {}
    return downloadTo(url, raw, null, key, { silent: true }).then(function () {
      var out = Ext.thumb(raw, dest);
      try { Ext.del(raw); } catch (_) {}
      return out || dest;
    });
  };

  // ── Versions & mod loaders ──

  // اخبارِ صفحه‌ی خانه — نیتیو اصلاً این کامند را ندارد (فیدِ خبرِ اندروید تا این‌جا کار نمی‌کرد؛
  // app.js:3208 `invoke("news_list")` بدونِ POLY override می‌افتاد روی پلِ بومی و رد می‌شد).
  // platform=android هم مطالبِ مخصوصِ اندروید و هم مطالبِ platform="both" را می‌گیرد.
  POLY.news_list = function () {
    return getJson(accountBase() + "/api/news/list?limit=50&platform=android").catch(function () { return { ok: false, news: [] }; });
  };

POLY.java_version = function (a) {
return Promise.resolve("Java مدیریت‌شده توسط میهن‌کرفت (نسخهٔ مناسب هنگام اجرا خودکار انتخاب می‌شود)");
  };

  // ── Pojav renderer picker — backed by MihanExt (see its class doc for the smali patch that
  // makes these actually take effect instead of being overwritten by the auto-tuner) ──
  POLY.pojav_renderer_options = function () {
    try { return Promise.resolve(JSON.parse(Ext.compatibleRenderers() || "[]")); } catch (_) { return Promise.resolve([]); }
  };
  POLY.pojav_renderer_get = function () {
    try { return Promise.resolve(Ext.rendererOverride() || ""); } catch (_) { return Promise.resolve(""); }
  };
  POLY.pojav_renderer_set = function (a) {
    var id = (a && (a.id != null ? a.id : a.value)) || "";
    try { Ext.setRendererOverride(id); } catch (_) {}
    return Promise.resolve(true);
  };
  POLY.pojav_renderer_last = function () {
    try { return Promise.resolve(Ext.lastEffectiveRenderer() || ""); } catch (_) { return Promise.resolve(""); }
  };
  // همه‌ی تنظیماتِ خودِ پوجاو، با نوعشان. کلیدی که هنوز دست نخورده در فایل نیست،
  // پس نبودِ کلید یعنی «هنوز پیش‌فرض» نه «وجود ندارد» — سمتِ UI پیش‌فرض را می‌گذارد.
  POLY.pojav_prefs_all = function () {
    try { return Promise.resolve(JSON.parse(Ext.pojavPrefAll() || "{}")); }
    catch (_) { return Promise.resolve({}); }
  };
  // نوع باید همانی باشد که پوجاو ذخیره می‌کند؛ نوعِ اشتباه یعنی ClassCastException
  // در اجرای بعدیِ بازی، نه فقط یک مقدارِ عجیب.
  POLY.pojav_pref_set = function (a) {
    var key = String((a && a.key) || "");
    var type = String((a && a.type) || "");
    var value = (a && a.value);
    try { return Promise.resolve(!!Ext.pojavPrefSet(key, type, value == null ? "" : String(value))); }
    catch (_) { return Promise.resolve(false); }
  };
  // دو صفحه‌ی نیتیو: به‌جای بازنویسی، خودشان باز می‌شوند.
  POLY.pojav_open_controls = function () {
    try { return Promise.resolve(!!Ext.openControlsEditor()); } catch (_) { return Promise.resolve(false); }
  };
  POLY.pojav_open_runtimes = function () {
    try { return Promise.resolve(!!Ext.openRuntimeManager()); } catch (_) { return Promise.resolve(false); }
  };
  POLY.pojav_open_gamepad = function () {
    try { return Promise.resolve(!!Ext.openGamepadMapper()); } catch (_) { return Promise.resolve(false); }
  };
  POLY.pojav_java_options = function () {
    try { return Promise.resolve(JSON.parse(Ext.readyRuntimesForPicker() || "[]")); } catch (_) { return Promise.resolve([]); }
  };

POLY.set_download_source = function (a) {
return setCfg("download_source", a.iran ? "iran" : "foreign");
  };

  // ── Voice & chat ──

POLY.voice_pad_list = function (a) {
var dir = J(DATA, "soundboard"); Ext.mkdirs(dir);
    var exts = { mp3:1, wav:1, ogg:1, m4a:1, opus:1, webm:1, flac:1, aac:1 };
    var entries = JSON.parse(Ext.list(dir) || "[]");
    return Promise.resolve(
      entries.filter(function (e) { return !e.is_dir && exts[String(e.ext || "").toLowerCase()]; })
        .map(function (e) { return { file: e.name, label: stem(e.name) }; })
        .sort(function (x, y) { return x.label.localeCompare(y.label); })
    );
  };

POLY.voice_pad_read = function (a) {
var dir = J(DATA, "soundboard");
    var file = (a && (a.file || a.name)) || "";
    return Promise.resolve(Ext.readB64(J(dir, file)));
  };

POLY.voice_pad_add_data = function (a) {
var dir = J(DATA, "soundboard"); Ext.mkdirs(dir);
    var name = (a && a.name) || "";
    var data = (a && (a.data || a.dataUrl || a.data_url)) || "";
    var comma = data.lastIndexOf(",");
    var b64 = comma >= 0 ? data.slice(comma + 1) : data;
    if (!b64) return Promise.reject(new Error("\u062f\u0627\u062f\u0647\u0654 \u0635\u062f\u0627 \u0646\u0627\u0645\u0639\u062a\u0628\u0631 \u0627\u0633\u062a."));
    if (b64.length > 7000000) return Promise.reject(new Error("\u062d\u062c\u0645 \u0635\u062f\u0627 \u0632\u06cc\u0627\u062f \u0627\u0633\u062a (\u062d\u062f\u0627\u06a9\u062b\u0631 \u06f5 \u0645\u06af\u0627\u0628\u0627\u06cc\u062a)."));
    Ext.writeB64(J(dir, safeName(name)), b64);
    var exts = { mp3:1, wav:1, ogg:1, m4a:1, opus:1, webm:1, flac:1, aac:1 };
    var entries = JSON.parse(Ext.list(dir) || "[]");
    return Promise.resolve(
      entries.filter(function (e) { return !e.is_dir && exts[String(e.ext || "").toLowerCase()]; })
        .map(function (e) { return { file: e.name, label: stem(e.name) }; })
        .sort(function (x, y) { return x.label.localeCompare(y.label); })
    );
  };

POLY.voice_pad_delete = function (a) {
var dir = J(DATA, "soundboard");
    var file = (a && (a.file || a.name)) || "";
    if (file) { try { Ext.del(J(dir, file)); } catch (_) {} }
    var exts = { mp3:1, wav:1, ogg:1, m4a:1, opus:1, webm:1, flac:1, aac:1 };
    var entries = JSON.parse(Ext.list(dir) || "[]");
    return Promise.resolve(
      entries.filter(function (e) { return !e.is_dir && exts[String(e.ext || "").toLowerCase()]; })
        .map(function (e) { return { file: e.name, label: stem(e.name) }; })
        .sort(function (x, y) { return x.label.localeCompare(y.label); })
    );
  };

POLY.presence_ping = function (a) {
var token = accountToken();
    if (!token || !token.trim()) return Promise.resolve({ ok: false, skipped: true });
    var ver = cfgGet("selected_version", "") || cfgGet("last_played", "") || "";
    // نسخه‌ی اندروید همیشه به‌جای 'launcher' مقدارِ 'launcher_android' می‌فرستد تا پنلِ ادمین
    // کاربرانِ موبایل را جدا از دسکتاپ بشمارد (کلاینتِ پی‌وی‌پیِ توکار همچنان 'client' می‌ماند).
    var k = (a && a.kind) || "launcher";
    if (k === "launcher") k = "launcher_android";
    var body = { kind: k, version: ver, server: "" };
    return authPost("/api/presence/ping", body).catch(function () { return { ok: false }; });
  };

  // Entry point the NATIVE side calls while Minecraft is in the foreground.
  // app.js pings presence on setIntervalWhenVisible(), which by design stops the moment the
  // launcher is backgrounded — and behind the game its WebView timers are suspended anyway
  // (measured: zero fires). So a player who is actually in-game silently dropped out of the
  // admin panel's online count. MihanGameBridge drives this from a plain Java Handler instead.
  window.__mihanPresencePing = function () {
    try { return POLY.presence_ping({ kind: "launcher" }); } catch (_) { return null; }
  };

  // ═══════════════════════════════════════════════════════
  //  SERVER HOSTING — run a real Java server in-process via Pojav's JVM
  //  (MihanServerHost). server_create downloads the jar + writes config;
  //  server_start launches it; commands go over RCON. One JVM per app-run.
  // ═══════════════════════════════════════════════════════
  function randToken(n) {
    var s = "", c = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    try {
      var bytes = new Uint8Array(n); window.crypto.getRandomValues(bytes);
      for (var i = 0; i < n; i++) s += c[bytes[i] % c.length];
      return s;
    } catch (_) {
      for (var j = 0; j < n; j++) s += c[Math.floor(Math.random() * c.length)];
      return s;
    }
  }
  function serverMetaPath(name) { return J(serverDir(name), "launcher_server.json"); }
  function saveServerMeta(meta) {
    var payload = JSON.stringify(meta || {}), path = serverMetaPath(meta && meta.name);
    if (Ext && Ext.atomicWriteText) Ext.atomicWriteText(path, payload);
    else Ext.writeText(path, payload);
  }
  function loadServerMeta(name) {
    var f = serverMetaPath(name);
    if (!Ext.exists(f)) return null;
    try { return JSON.parse(Ext.readText(f)); } catch (_) { return null; }
  }

  // resolve the download URL for a server jar (ports desktop resolve_server_url)
  function resolveServerUrl(kind, version) {
    kind = String(kind || "paper").toLowerCase();
    function papermc(project) {
      return getJson("https://fill.papermc.io/v3/projects/" + project + "/versions/" + version + "/builds").then(function (builds) {
        if (!Array.isArray(builds) || !builds.length) throw new Error("بیلدی برای " + project + " " + version + " نیست");
        var b = builds.filter(function (x) { return x.channel === "STABLE"; })[0] || builds[0];
        var u = b && b.downloads && b.downloads["server:default"] && b.downloads["server:default"].url;
        if (!u) throw new Error("لینک دانلود " + project + " پیدا نشد");
        return u;
      });
    }
    if (kind === "vanilla") {
      return getJson("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json").then(function (man) {
        var e = (man.versions || []).filter(function (v) { return v.id === version; })[0];
        if (!e) throw new Error("نسخه " + version + " پیدا نشد");
        return getJson(e.url).then(function (vj) {
          var u = vj && vj.downloads && vj.downloads.server && vj.downloads.server.url;
          if (!u) throw new Error("نسخه " + version + " سرور رسمی ندارد");
          return u;
        });
      });
    }
    if (kind === "purpur") {
      return getJson("https://api.purpurmc.org/v2/purpur/" + version).then(function (info) {
        var build = (info && info.builds && info.builds.latest) || "latest";
        return "https://api.purpurmc.org/v2/purpur/" + version + "/" + build + "/download";
      });
    }
    if (kind === "folia" || kind === "velocity" || kind === "waterfall") return papermc(kind);
    if (kind === "fabric" || kind === "forge" || kind === "neoforge" || kind === "quilt")
      return Promise.reject(new Error("سرورِ " + kind + " روی موبایل هنوز پشتیبانی نمی‌شود — از Paper یا Purpur استفاده کن."));
    return papermc("paper");
  }

  // جاوای لازمِ یک سرور (پورتِ desktop launcher::server_java_major). عدمِ تطابق
  // این‌جا آرام شکست نمی‌خورد: JVM در همین پروسه SIGABRT می‌کند و کلِ اپ را می‌برد،
  // پس باید پیش از لانچ گیت شود.
  function mcJavaMajor(mc) {
    var nums = String(mc).split(/\D+/).filter(function (t) { return t.length; }).map(Number);
    if (!nums.length) return 21;
    if (nums[0] >= 26) return 25;
    if (nums[0] !== 1) return 21;
    return DL.guessJavaMajor(String(mc));
  }
  function ensureJava(want, token) { return DL.ensureJava(want, token || "android-java"); }

  // MIHAN-LAUNCH-GATE — پیش از سپردنِ لانچ به نیتیو، نسخه را کاملاً آماده می‌کنیم:
  //   ۱) stageVersion: هر فایلِ لازم (json زنجیره، jar، کتابخانه‌ها، assetها) از CDN
  //      ایران؛ idempotent، پس اگر قبلاً استیج شده فوری برمی‌گردد. همین یک قدم،
  //      نسخه‌هایی را هم که با بیلدهای قبلی نیمه‌کاره مانده‌اند ترمیم می‌کند.
  //   ۲) جاوا: major را از خودِ markerِ استیج می‌خوانیم (javaVersion.majorVersion
  //      نسخه‌ی حل‌شده) — نه با پارس‌کردنِ نامِ پروفایل، که «fabric-loader-0.19.3-1.16.5»
  //      را به جاوا ۲۱ نگاشت می‌کرد و بازی همان اول کرش می‌شد.
  // بعد از این، دانلودگرِ نیتیو (که .mihan-staged را می‌بیند) اصلاً اجرا نمی‌شود.
  // یک idِ کاملاً UUID هرگز نامِ نسخه نیست — یعنی resolve نشده. تلاش برای استیجِ آن فقط
  // «نسخه‌ی <UUID> روی سرورِ ایران موجود نیست» تولید می‌کند و اجرا را الکی بلاک می‌کند
  // (همان باگی که دکمه‌ی «اجرای بازی» را از کار انداخته بود). در این حالت استیج را رد کن
  // و بگذار نیتیو با instanceِ خودش کار کند.
  function looksLikeUuid(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ""));
  }
  function prepareForLaunch(versionId, token) {
    var id = String(versionId || "");
    if (!id) return Promise.resolve();
    if (looksLikeUuid(id)) {
      dlog("launch_prepare_skipped_uuid", { id: id });
      return Promise.resolve();
    }
    // روی نصب‌های از قبل استیج‌شده stageVersion زود برمی‌گردد، پس این‌جا هم صدا زده می‌شود
    // تا پروفایل‌هایی که پیش از این اصلاح ساخته شده‌اند هم درست شوند. ایدمپوتنت است.
    try { DL.stripVulkanModuleInfo(); } catch (_) {}
    return DL.stageVersion(id, token || ("launch-" + id))
      .catch(function (e) {
        dlog("launch_prepare_failed", { id: id, error: e && e.message });
        // یک نسخه‌ی واردشده با دست (که روی CDN ما نیست) ولی از قبل کاملِ روی دیسک، باید
        // بتواند اجرا شود — نیتیو با مسیرِ خودش امتحان می‌کند. ولی اگر فایل‌های پایه هم
        // نیستند، سکوت کردن یعنی کاربر دوباره همان دیالوگِ بی‌معنیِ «دانلود Minecraft انجام
        // نشد» را می‌بیند؛ به‌جایش خطای واقعیِ خودمان را بالا می‌فرستیم.
        var haveLocal = false;
        try {
          haveLocal = Ext.exists(J(MC, "versions", id, id + ".json"))
            && Ext.exists(J(MC, "versions", id, id + ".jar"));
        } catch (_) {}
        if (!haveLocal) throw e;
      })
      // خطای Runtime هرگز نباید با «نسخه محلی است» بلعیده شود. قبلاً ensureJavaFor داخلِ
      // catch بالا بود؛ نصب Java شکست می‌خورد ولی Pojav باز می‌شد و failed to autopick می‌داد.
      .then(function () { return DL.ensureJavaFor(id, "launch-java"); });
  }

  /**
   * آیدی‌ای که UI می‌فرستد را به «نسخه‌ای که باید استیج شود» تبدیل می‌کند.
   *
   * دو فهرستِ کاملاً جدا وجود دارد و این تفاوت باعثِ باگِ «نسخه‌ی X روی سرورِ ایران موجود
   * نیست» موقعِ زدنِ دکمه‌ی «اجرای بازی» شد:
   *   • launcher_profiles.json — پروفایل‌های خودِ Pojav (کلید = UUID، مقدار = lastVersionId)
   *   • instance_list نیتیو     — instanceهای خودِ لانچر (id = UUIDِ دیگری، version جدا)
   * دکمه‌ی اصلیِ صفحه‌ی خانه idِ دومی را می‌فرستد (مثلاً پروفایلِ «Default» با
   * id=2d5b79ac-… و version=1.7.10) که در launcher_profiles.json هیچ‌وقت پیدا نمی‌شد، پس
   * resolver قدیمی خودِ UUID را «نامِ نسخه» فرض می‌کرد و استیج شکست می‌خورد.
   * حالا اول پروفایل‌های Pojav، بعد فهرستِ instanceهای نیتیو پرسیده می‌شود.
   */
  function resolveLaunchVersion(requested) {
    var ref = String(requested || "");
    if (!ref) return Promise.resolve("");
    var local = resolveProfileRef(ref);
    if (local.key || local.version !== ref) return Promise.resolve(local.version);
    return nativeForceInvoke("instance_list").then(function (list) {
      var found = null;
      (list || []).forEach(function (it) {
        if (!it || found) return;
        if (String(it.id || "") === ref || String(it.name || "") === ref) found = it;
      });
      if (!found) return ref;
      return String(found.version || found.base_version || ref);
    }).catch(function () { return ref; });
  }

  /** UUID، نام نمایشی یا version id را به کلید واقعی پروفایل + نسخه‌ی واقعی نگاشت می‌کند. */
  function resolveProfileRef(id) {
    var ref = String(id || "");
    try {
      var lp = J(MC, "launcher_profiles.json");
      var obj = JSON.parse(Ext.readText(lp) || "{}");
      var profiles = obj && obj.profiles;
      if (profiles) {
        var exact = profiles[ref];
        if (exact && exact.lastVersionId) return { key: ref, version: String(exact.lastVersionId) };
        var keys = Object.keys(profiles);
        for (var i = 0; i < keys.length; i++) {
          var p = profiles[keys[i]];
          if (p && String(p.name || "") === ref && p.lastVersionId)
            return { key: keys[i], version: String(p.lastVersionId) };
        }
        for (var j = 0; j < keys.length; j++) {
          var p2 = profiles[keys[j]];
          if (p2 && String(p2.lastVersionId || "") === ref)
            return { key: keys[j], version: ref };
        }
      }
    } catch (_) {}
    return { key: "", version: ref };
  }
  function profileVersionId(id) {
    return resolveProfileRef(id).version;
  }
  POLY.launch_game = function (a) {
    flushVoiceStateBeforeLaunch();
    var requested = String((a && (a.versionId || a.version)) || "");
    // این مسیر شناسه‌ی نسخه می‌گیرد نه پروفایل، ولی پوشه‌ی بازی به پروفایل تعلق دارد — پس اول
    // به کلیدِ پروفایل نگاشت می‌شود تا مادها/دنیاها در همان پوشه‌ی درست بنشینند.
    var pid = "";
    try { pid = (resolveProfileRef(requested) || {}).key || ""; } catch (_) {}
    try { ensurePerProfileLayout(pid); } catch (_) {}
    try { ensureProfileDir(pid); } catch (_) {}
    try { ensureAuthlibInjector(requested); } catch (_) {}
    try { ensureJavaOverride(requested); } catch (_) {}
    try { ensureCustomSkinLoaderMod(pid); } catch (_) {}
    try { applyProfileRamToEngine(pid); } catch (_) {}
    // Resolve ONLY to decide what to stage; pass the caller's args through untouched.
    return resolveLaunchVersion(requested).then(function (versionId) {
      try { ensureOptifineMod(versionId, pid); } catch (_) {}
      return prepareForLaunch(versionId);
    }).then(function () {
      return ensurePojavLibRewrites();
    }).then(function () {
      // شناسه‌ی حساب را تازه کن و rootِ CustomSkinLoader را با آن بازنویس، وگرنه بعد از
      // ورود به حساب تا اجرای بعدی هنوز rootِ عمومی نوشته شده بود.
      return refreshCslId().then(function () { try { ensureCustomSkinLoaderMod(pid); } catch (_) {} });
    }).then(function () {
      return nativeForceInvoke("launch_game", a);
    });
  };

  function usingIranSrc() { return cfgGet("download_source", "iran") === "iran"; }
  function isTransientServerFile(path) {
    var p = String(path || "").replace(/\\/g, "/");
    return !p || p === ".ok" || p === "start.sh" || /(^|\/)(tmp|logs|crash-reports)(\/|$)/i.test(p) || /\.(tmp|part)$/i.test(p);
  }
  // درختِ کاملِ سرورِ آفلاین را از CDN ایران می‌گیرد (jar + cache + libraries) تا سرور بدونِ
  // هیچ درخواستِ خارجی اجرا شود — تک‌جارِ Paper به‌تنهایی موقعِ اجرا از موجانگ دانلود می‌کند.
  function iranServerTree(kind, version, dir, token) {
    var base = CDN + "/servers/" + kind + "/" + version;
    return getJson(base + "/_tree.json").then(function (tree) {
      if (!tree || !Array.isArray(tree.files) || !tree.files.length) throw new Error("درختِ سرورِ ایران برای این نسخه موجود نیست");
      var jarName = null, hasModernLauncher = false;
      // فبریک یک نمونه‌ی دیگر است: خودِ درخت از قبل یک "server.jar" واقعی (جارِ وانیلا،
      // ~38MB) دارد، به‌علاوه‌ی "fabric-server-launch.jar" (لودرِ کوچکِ ۶۳۹ بایتی). اسمِ
      // این لودر هم با "fabric" شروع می‌شود، پس هیوریستیکِ پایین آن را هم واجدِ شرایطِ
      // «تغییرِ نام به server.jar» می‌دید — و چون هر دو فایل در همان حلقه دانلود می‌شدند،
      // هرکدام دیرتر می‌رسید (لودر، چون کوچک‌تر است، معمولاً زودتر تمام می‌شد ولی بسته به
      // ترتیبِ صفِ دانلود) رویِ دیگری را می‌نوشت. اگر لودر آخر بنشیند، server.jar واقعی
      // (وانیلا) با همان جارِ ۶۳۹ بایتی بازنویسی می‌شود و Fabric با خطای "couldn't locate
      // the game" (چون بازیِ وانیلا دیگر آنجا نیست) شکست می‌خورد — این یعنی سرورهای Fabric
      // با یک server.jar واقعی در درخت (اکثرِ نسخه‌ها) به‌طور تصادفی/همیشگی خراب می‌شدند.
      // پس اگر خودِ درخت از قبل یک "server.jar" دارد، آن سند است — هیچ فایلِ دیگری هرگز
      // نباید رویش بازنویسی شود.
      var hasNativeServerJar = tree.files.some(function (f) { return f && f.path === "server.jar"; });
      // و همین هیوریستیک یک‌بارِ دیگر هم گاز گرفت، این‌بار روی Forgeِ خیلی جدید (۶۱.x، مثلِ
      // 1.21.11): آن نسخه‌ها دیگر ماژول‌محور لانچ نمی‌شوند، بلکه unix_args.txt فقط شاملِ
      //     -Djava.net.preferIPv6Addresses=system -jar forge-<ver>-shim.jar
      // است — یعنی جارِ ریشه را با نامِ واقعیِ خودش صدا می‌زند. اسمِ آن شیم هم با "forge"
      // شروع می‌شود و "installer" در آن نیست، پس دقیقاً واجدِ شرایطِ تغییرِ نام می‌شد و
      // به server.jar منتقل می‌شد؛ نتیجه: «Error: Unable to access jarfile
      // forge-1.21.11-61.1.8-shim.jar» و مرگِ فوریِ سرور (روی دستگاه تأیید شد).
      // قاعده‌ی درست: در هر درختی که لانچرِ مدرن دارد (user_jvm_args.txt)، اجرا از مسیرِ
      // argfile انجام می‌شود و آن فایل‌ها فایل‌ها را با نامِ واقعی‌شان صدا می‌زنند — پس
      // هیچ‌چیز نباید تغییرِ نام بدهد. server.jar فقط برای سرورهای کلاسیکِ تک‌جار معنی دارد.
      var hasModernArgsLauncher = tree.files.some(function (f) { return f && f.path === "user_jvm_args.txt"; });
      tree.files.forEach(function (f) {
        var p = (f && f.path) || "";
        // نسخه‌های مدرنِ Forge/NeoForge (۱٫۱۳+) هیچ جارِ اجراییِ ریشه ندارند — فقط
        // run.sh/user_jvm_args.txt + libraries/.../unix_args.txt (لانچِ ماژول‌محورِ جاوا،
        // MihanServerHost آن را جدا تشخیص می‌دهد). تنها جارِ ریشه‌ی این درخت‌ها خودِ
        // installerِ Forge است (اسمش هم با "forge" شروع می‌شود) — قبلاً بدونِ این استثنا
        // اشتباهی همان installer به‌جای jarِ سرور به server.jar کپی می‌شد و launch عملاً
        // خودِ installer را (نه سرور را) اجرا می‌کرد؛ همان چیزی که در گزارش‌های کاربران به
        // شکلِ خطای "دانلود version manifest ناموفق" دیده می‌شد.
        if (p === "user_jvm_args.txt") hasModernLauncher = true;
        if (!hasNativeServerJar && !hasModernArgsLauncher && p.indexOf("/") < 0 && /\.jar$/.test(p) && p.indexOf(kind) === 0 && !/installer/i.test(p)) jarName = p;
      });
      if (!jarName && !hasNativeServerJar && !hasModernLauncher) throw new Error("جارِ اصلیِ سرور در درختِ ایران پیدا نشد");
      // One public task represents the whole tree. Silent child downloads report private byte
      // progress by request id; fold the active child's bytes into completed-file bytes so a large
      // first jar no longer looks frozen until the entire file has landed.
      var toGet = tree.files.filter(function (f) { return !isTransientServerFile(f && f.path); });
      var total = toGet.length, doneN = 0, doneBytes = 0;
      var lastAggregateBytes = 0, lastAggregatePct = 0;
      var totalBytes = toGet.reduce(function (sum, f) { return sum + Math.max(0, Number(f && (f.size || f.bytes)) || 0); }, 0);
      emit("download://status", { token: token, label: "دانلودِ فایل‌های سرور 0/" + total, pct: 0, state: "downloading", downloadedBytes: 0, totalBytes: totalBytes || null });
      dlog("server_tree_start", { token: token, kind: kind, version: version, fileCount: total, totalBytes: totalBytes });
      var seq = Promise.resolve();
      toGet.forEach(function (f) {
        var p = f.path;
        var expected = Math.max(0, Number(f && (f.size || f.bytes)) || 0);
        var dest = (p === jarName) ? J(dir, "server.jar") : J(dir, p);
        var slash = dest.lastIndexOf("/");
        if (slash > 0) { try { Ext.mkdirs(dest.slice(0, slash)); } catch (_) {} }
        seq = seq.then(function () {
          var have = false;
          try { have = Ext.exists(dest) && (!expected || Number(Ext.sizeOf(dest)) === expected); } catch (_) {}
          dlog("server_file_start", { token: token, path: p, expectedBytes: expected, alreadyHave: have });
          var activeBytes = 0;
          var expectedAdjustment = 0;
          function emitAggregate(child) {
            child = child || {};
            var childDownloaded = Math.max(0, Number(child.downloadedBytes) || 0);
            var childTotal = Math.max(0, Number(child.totalBytes) || expected || 0);
            // The tree's declared size can undercount the real file (e.g. server.jar).
            // Grow the aggregate total instead of clamping progress at a false ceiling.
            if (childTotal > expected + expectedAdjustment) {
              var extra = childTotal - expected - expectedAdjustment;
              totalBytes += extra;
              expectedAdjustment += extra;
            }
            var nextActiveBytes = childTotal ? Math.min(childDownloaded, childTotal) : childDownloaded;
            activeBytes = Math.max(activeBytes, nextActiveBytes);
            var aggregateBytes = Math.max(lastAggregateBytes, doneBytes + activeBytes);
            if (totalBytes) aggregateBytes = Math.min(totalBytes, aggregateBytes);
            var childFraction = childTotal ? activeBytes / childTotal : 0;
            var pct = totalBytes
              ? Math.min(99, Math.floor(aggregateBytes / totalBytes * 100))
              : Math.min(99, Math.floor((doneN + childFraction) / Math.max(1, total) * 100));
            pct = Math.max(lastAggregatePct, pct);
            lastAggregateBytes = aggregateBytes;
            lastAggregatePct = pct;
            var speed = Math.max(0, Number(child.speedBps) || 0);
            var eta = totalBytes && speed > 0
              ? Math.max(0, Math.ceil((totalBytes - aggregateBytes) / speed))
              : (Number(child.etaSeconds) >= 0 ? Number(child.etaSeconds) : -1);
            // Completing one child must not complete the aggregate task. Terminal aggregate
            // state is emitted only after every file is present and verification begins.
            var aggregateState = child.state === "complete" ? "downloading" : (child.state || "downloading");
            emit("download://status", {
              token: token,
              label: "دانلودِ فایل‌های سرور " + doneN + "/" + total,
              pct: pct,
              state: aggregateState,
              downloadedBytes: aggregateBytes,
              totalBytes: totalBytes || null,
              speedBps: speed,
              etaSeconds: eta
            });
          }
          var pump = have ? Promise.resolve() : downloadTo(base + "/" + p, dest, token, p, {
            silent: true,
            onProgress: emitAggregate
          });
          return pump.then(function () {
            doneN++;
            doneBytes += Math.max(expected + expectedAdjustment, activeBytes);
            var completedBytes = Math.max(lastAggregateBytes, doneBytes);
            if (totalBytes) completedBytes = Math.min(totalBytes, completedBytes);
            var pct = totalBytes ? Math.round(completedBytes / totalBytes * 100) : Math.round(doneN / Math.max(1, total) * 100);
            pct = doneN === total ? 100 : Math.min(99, Math.max(lastAggregatePct, pct));
            lastAggregateBytes = completedBytes;
            lastAggregatePct = pct;
            dlog("server_file_done", { token: token, path: p, doneN: doneN, total: total, aggregatePct: pct });
            emit("download://status", { token: token, label: "دانلودِ فایل‌های سرور " + doneN + "/" + total, pct: pct, state: doneN === total ? "verifying" : "downloading", downloadedBytes: completedBytes, totalBytes: totalBytes || null, speedBps: 0, etaSeconds: doneN === total ? 0 : -1 });
          }, function (err) {
            dlog("server_file_error", { token: token, path: p, error: err && err.message });
            throw err;
          });
        });
      });
      return seq;
    });
  }

  function installServer(meta) {
    var dir = serverDir(meta.name), kind = String(meta.server_type || "paper").toLowerCase();
    var version = String(meta.version || ""), token = "srv-" + meta.name;
    DL.clearCancel(token);
    meta.install_state = "installing";
    meta.last_error = "";
    meta.updated = Math.floor(Date.now() / 1000);
    saveServerMeta(meta);
    emit("server://status", "دانلود فایل‌های سرور آغاز شد…");
    emit("download://status", { token: token, label: "آماده‌سازی «" + (meta.display_name || meta.name) + "»", pct: 0, state: "queued" });
    dlog("server_install_start", { token: token, server: meta.name, kind: kind, version: version, hasTree: /^(paper|purpur|fabric|forge)$/.test(kind) });

    var hasTree = /^(paper|purpur|fabric|forge)$/.test(kind);
    var download = hasTree
      ? iranServerTree(kind, version, dir, token).catch(function (e) {
          if (isCancelled(token)) throw e;
          dlog("server_tree_fallback", { token: token, server: meta.name, error: e && e.message });
          if (usingIranSrc()) throw e;
          emit("server://status", "پیدا کردن لینک جایگزین دانلود…");
          return resolveServerUrl(kind, version).then(function (url) { return downloadTo(url, J(dir, "server.jar"), token, "server.jar"); });
        })
      : (usingIranSrc()
          ? Promise.reject(new Error("سرور «" + kind + "» روی منبع ایران موجود نیست؛ Paper یا Purpur را انتخاب کن."))
          : resolveServerUrl(kind, version).then(function (url) { return downloadTo(url, J(dir, "server.jar"), token, "server.jar"); }));

    return download.then(function () {
      emit("server://status", "بررسی فایل‌ها و ساخت تنظیمات…");
      emit("download://status", { token: token, label: "بررسی و تکمیل تنظیمات", pct: 100, state: "verifying" });
      Ext.writeText(J(dir, "eula.txt"), "eula=true\n");
      var online = !!(meta.online_mode || meta.launcher_only);
      var props = [
        "server-port=" + meta.port, "query.port=" + meta.port,
        "online-mode=" + (online ? "true" : "false"),
        "enforce-secure-profile=" + (online ? "true" : "false"),
        "motd=" + (meta.motd || "ساخته‌شده با لانچر میهن‌کرفت"),
        "max-players=" + (meta.max_players || 10),
        "difficulty=" + (meta.difficulty || "easy"),
        "gamemode=" + (meta.gamemode || "survival"),
        "enable-command-block=true",
        "enable-rcon=true", "rcon.port=" + meta.rcon_port, "rcon.password=" + meta.rcon_password, "broadcast-rcon-to-ops=false"
      ];
      Ext.writeText(J(dir, "server.properties"), props.join("\n") + "\n");
      meta.install_state = "ready";
      meta.last_error = "";
      meta.updated = Math.floor(Date.now() / 1000);
      saveServerMeta(meta);
      emit("server://status", "✓ سرور آماده است.");
      emit("download://status", { token: token, label: "سرور «" + (meta.display_name || meta.name) + "» آماده شد", pct: 100, state: "complete", done: true });
      dlog("server_install_done", { token: token, server: meta.name });
      return meta;
    }).catch(function (e) {
      var message = e && e.message ? e.message : String(e || "خطای نامشخص");
      meta.install_state = /لغو/.test(message) ? "cancelled" : "error";
      meta.last_error = message;
      meta.updated = Math.floor(Date.now() / 1000);
      try { saveServerMeta(meta); } catch (_) {}
      emit("server://status", "✗ ساخت سرور کامل نشد؛ فایل‌های دریافت‌شده برای ادامه نگه داشته شدند.");
      emit("download://status", { token: token, label: "ساخت «" + (meta.display_name || meta.name) + "»", state: meta.install_state, error: message });
      dlog("server_install_error", { token: token, server: meta.name, state: meta.install_state, error: message });
      throw new Error("ساخت سرور کامل نشد؛ از «سرورهای من» ادامه دانلود را بزن. " + message);
    });
  }

  POLY.server_create = function (a) {
    var opts = a.opts || a || {}, displayName;
    try { displayName = validateServerName(opts.name); } catch (e) { return Promise.reject(e); }
    var version = String(opts.version || ""), kind = String(opts.server_type || "paper").toLowerCase();
    if (!version) return Promise.reject(new Error("نسخه سرور را انتخاب کن"));
    var storageId = safeName(displayName), dir = serverDir(storageId);
    if (Ext.exists(dir)) return Promise.reject(new Error("سروری با نام «" + displayName + "» از قبل وجود دارد یا نصب نیمه‌کاره‌ای با این نام مانده است."));
    Ext.mkdirs(dir);
    var meta = {
      name: storageId, display_name: displayName, version: version, server_type: kind,
      ram: Number(opts.ram || 1024), cpu_cores: Number(opts.cpu_cores || 0),
      port: Number(opts.port || 25565) || 25565, rcon_port: 25575, rcon_password: randToken(18),
      motd: String(opts.motd || ""), online_mode: !!opts.online_mode, launcher_only: !!opts.launcher_only,
      max_players: Number(opts.max_players || 10), difficulty: opts.difficulty || "easy", gamemode: opts.gamemode || "survival",
      created: Math.floor(Date.now() / 1000), install_state: "installing", last_error: ""
    };
    try { saveServerMeta(meta); }
    catch (e) { try { Ext.del(dir); } catch (_) {} return Promise.reject(new Error("اطلاعات اولیه سرور ذخیره نشد: " + e)); }
    return installServer(meta);
  };

  POLY.server_retry = function (a) {
    var name = a && a.name;
    var meta = loadServerMeta(name);
    if (!meta) return Promise.reject(new Error("اطلاعات این سرور پیدا نشد"));
    if (meta.install_state === "ready") return Promise.resolve(meta);
    return installServer(meta);
  };

  var _srvLogTimer = null, _srvLogSeen = 0;
  function startServerLogPump(name) {
    _srvLogSeen = 0;
    if (_srvLogTimer) clearInterval(_srvLogTimer);
    var ready = false, doneLogged = false;
    _srvLogTimer = setInterval(function () {
      var all = "";
      try { all = Ext.serverLogTail(0) || ""; } catch (_) {}
      if (all.length > _srvLogSeen) {
        var fresh = all.slice(_srvLogSeen); _srvLogSeen = all.length;
        fresh.split(/\r?\n/).forEach(function (line) { if (line) emit("server://log", { name: name, line: line }); });
        if (!doneLogged && /\bDone \(/.test(all)) {
          doneLogged = true;
          emit("server://status", "سرور بوت شد؛ در حال بررسی پورت اتصال…");
        }
      }
      var meta = loadServerMeta(name) || {};
      if (!ready && Ext.serverPortOpen && Ext.serverPortOpen(Number(meta.port || 25565))) {
        ready = true;
        emit("server://ready", { name: name, port: Number(meta.port || 25565) });
        emit("server://status", "✓ سرور آماده است — بازیکنان می‌توانند وصل شوند.");
      }
      if (!Ext.serverIsRunning()) {
        clearInterval(_srvLogTimer); _srvLogTimer = null;
        var error = "";
        try { error = Ext.serverLastError ? String(Ext.serverLastError() || "") : ""; } catch (_) {}
        if (!error && !ready) error = "سرور پیش از آماده‌شدن متوقف شد؛ لاگ کنسول را بررسی کن.";
        emit("server://exit", { name: name, error: error });
      }
    }, 900);
  }

  POLY.server_start = function (a) {
    var name = a.name;
    var meta = loadServerMeta(name);
    if (!meta) return Promise.reject(new Error("سرور پیدا نشد — دوباره بساز."));
    if (meta.install_state && meta.install_state !== "ready" && meta.install_state !== "recovered") return Promise.reject(new Error("نصب این سرور هنوز کامل نشده است؛ اول «ادامه دانلود» را بزن."));
    // نسخه‌های مدرنِ Forge/NeoForge (۱٫۱۳+) اصلاً server.jar ندارند — فقط run.sh/
    // user_jvm_args.txt + libraries/.../unix_args.txt (MihanServerHost این لایوت را جدا
    // تشخیص و اجرا می‌کند). قبلاً این چکِ سخت‌گیرانه بدونِ استثنا هر سرورِ Forgeِ مدرن را همین‌جا،
    // پیش از رسیدن به کدِ نیتیو، رد می‌کرد — با «server.jar پیدا نشد» با اینکه نصب واقعاً کامل بود.
    if (!Ext.exists(J(serverDir(name), "server.jar")) && !Ext.exists(J(serverDir(name), "user_jvm_args.txt")))
      return Promise.reject(new Error("فایل‌های سرور پیدا نشد — سرور را دوباره بساز."));
    var minJava = mcJavaMajor(meta.version || "");
    return ensureJava(minJava, "server-java").then(function () {
      emit("server://status", "روشن‌کردن سرور...");
      var res = Ext.serverStart(serverDir(name), J(serverDir(name), "server.jar"),
        Number(meta.ram || 1024), String(meta.rcon_password || ""), Number(meta.rcon_port || 25575), minJava);
      if (res !== "ok") throw new Error(res);
      startServerLogPump(name);
      return null;
    });
  };

  POLY.server_running = function () { return Promise.resolve(!!Ext.serverIsRunning()); };
  POLY.server_local_address = function (a) {
    var port = Number(a && a.port) || 25565;
    try { return Promise.resolve(Ext.serverLocalAddress ? Ext.serverLocalAddress(port) : ("127.0.0.1:" + port)); }
    catch (_) { return Promise.resolve("127.0.0.1:" + port); }
  };
  POLY.server_logs = function () {
    var t = ""; try { t = Ext.serverLogTail(0) || ""; } catch (_) {}
    return Promise.resolve(t.split(/\r?\n/).filter(function (l) { return l.length; }));
  };
  POLY.server_command = function (a) {
    return rconCommand(String(a.command || a.cmd || ""));
  };
  POLY.server_stop = function () {
    rconCommand("stop").catch(function () {});
    return Promise.resolve(null);
  };
  POLY.server_kill = POLY.server_stop;
  // ری‌استارت روی موبایل درجا ممکن نیست: سرور داخلِ همین پروسه‌ی اپ روی یک JVM اجرا می‌شود و
  // HotSpot اجازه‌ی ساختِ JVMِ دوم در یک پروسه را نمی‌دهد؛ پس «stop سپس start» در همان نشست کار
  // نمی‌کند. به‌جای یک استابِ بی‌اثر (که قبلاً UI را الکی به حالتِ «در حال راه‌اندازی» می‌برد)، با
  // پیامِ روشن رد می‌کنیم تا کاربر سرور را متوقف و اپ را ببندد/باز کند.
  POLY.server_restart = function () {
    rconCommand("stop").catch(function () {});
    return Promise.reject(new Error("ری‌استارتِ سرور روی موبایل ممکن نیست؛ سرور را متوقف کن، برنامه را ببند و دوباره باز کن، بعد سرور را روشن کن."));
  };

  // real running-state stats for the management panel. The UI polls this every
  // 2-6s and flips its "on/off" indicator purely off st.running — a stub here
  // (as it was before) makes the whole management panel look permanently broken
  // even while the server is actually up.
  POLY.server_stats = function (a) {
    var isThis = Ext.serverIsRunning() && Ext.serverRconName() === safeName(a.name || "");
    var meta = loadServerMeta(a.name) || {};
    var port = Number(meta.port || 25565);
    var ready = false, error = "";
    try { ready = !!(isThis && Ext.serverPortOpen && Ext.serverPortOpen(port)); } catch (_) {}
    try { error = Ext.serverLastError ? String(Ext.serverLastError() || "") : ""; } catch (_) {}
    if (!isThis) return Promise.resolve({ running: false, ready: false, error: error, cpu: 0, memory: 0, uptime: 0, down: 0, up: 0, players: 0 });
    var uptime = 0, effectiveRam = Number(meta.ram || 0);
    try { uptime = Number(Ext.serverUptimeSec ? Ext.serverUptimeSec() : 0); } catch (_) {}
    try { effectiveRam = Number(Ext.serverEffectiveRamMb ? Ext.serverEffectiveRamMb() : effectiveRam); } catch (_) {}
    return Promise.resolve({
      running: true, ready: ready, error: error,
      cpu: 0, // not observable from JS for the shared app process; 0 reads as "—" is wrong so show a nominal value instead
      memory: effectiveRam,
      uptime: uptime, down: 0, up: 0, players: 0,
    });
  };

  // "There are N of a max of M players online: a, b, c" (vanilla/Paper/Spigot format)
  function parseRconList(text) {
    var m = String(text || "").match(/:\s*(.*)$/);
    if (!m) return [];
    var rest = m[1].trim();
    if (!rest) return [];
    return rest.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  }
  POLY.server_players = function (a) {
    var isThis = Ext.serverIsRunning() && Ext.serverRconName() === safeName(a.name || "");
    var known = [];
    try {
      var uc = J(serverDir(a.name), "usercache.json");
      if (Ext.exists(uc)) {
        var arr = JSON.parse(Ext.readText(uc) || "[]");
        known = (arr || []).map(function (e) { return { name: e.name }; }).filter(function (e) { return e.name; });
      }
    } catch (_) {}
    if (!isThis) return Promise.resolve({ online: [], known: known });
    return rconCommand("list").then(function (reply) {
      return { online: parseRconList(reply), known: known };
    }).catch(function () {
      return { online: [], known: known };
    });
  };

  // ── byte helpers ───────────────────────────────────────
  function b64ToBytes(b64) {
    var bin = atob(b64), n = bin.length, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var bin = "", chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }

  // ── window.__TAURI__.dialog ────────────────────────────────────────────────────────────────
  // The desktop UI reaches for T.dialog.open()/save() in a dozen places — the server icon, adding
  // plugin/mod jars to a hosted server, the server file manager, profile import/export. On Android
  // __TAURI__ only ever exposed core/event/window/app, so T.dialog was undefined, every one of
  // those calls threw, and every call site swallows it (.catch(() => null) or a bare try/catch).
  // The visible result was a button that did nothing at all — "برای آپلود پلاگین یا آپلود هر چیزی
  // کار نمیکنه" and "آیکون سرورمو نمیتونم عوض کنم" in the reports.
  //
  // The contract callers rely on is Tauri's: open() resolves to a PATH (or array of paths when
  // multiple), or null when cancelled; save() resolves to a path to write to. Hence the native
  // side copies the SAF selection into the cache and hands back real paths (see MihanPick).
  (function installDialogShim() {
    if (!Ext || !window.__TAURI__ || window.__TAURI__.dialog) return;
    var waiting = {};
    window.__mihanPick = function (id, paths) {
      var r = waiting[id];
      if (!r) return;
      delete waiting[id];
      r(Array.isArray(paths) ? paths : []);
    };

    // Tauri filters are [{name, extensions:["png","jpg"]}]. Android wants MIME types, so map the
    // common ones and fall back to */* — a wrong-but-permissive filter still lets the user pick,
    // whereas a wrong-and-narrow one hides their file.
    var EXT_MIME = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
      bmp: "image/bmp", gif: "image/gif", zip: "application/zip", jar: "application/java-archive",
      json: "application/json", txt: "text/plain", mp4: "video/mp4", mp3: "audio/mpeg",
      ogg: "audio/ogg", wav: "audio/wav", properties: "text/plain", yml: "text/plain",
      yaml: "text/plain", toml: "text/plain", log: "text/plain"
    };
    function mimesFor(opts) {
      var exts = [];
      (opts && opts.filters || []).forEach(function (f) {
        (f && f.extensions || []).forEach(function (e) { exts.push(String(e).toLowerCase()); });
      });
      var mimes = [];
      exts.forEach(function (e) {
        var m = EXT_MIME[e];
        if (m && mimes.indexOf(m) < 0) mimes.push(m);
      });
      // Any unmapped extension means our list is incomplete — don't filter at all rather than
      // hide the file the user is looking for.
      if (!exts.length || mimes.length !== exts.filter(function (e, i, a) { return a.indexOf(e) === i; }).length) {
        return { mime: "*/*", extra: "" };
      }
      return { mime: mimes.length === 1 ? mimes[0] : "*/*", extra: mimes.join(",") };
    }

    window.__TAURI__.dialog = {
      open: function (opts) {
        opts = opts || {};
        // A directory picker has no meaningful equivalent here (nothing native accepts an
        // arbitrary SAF tree), and the one caller treats a rejection as "cancelled".
        if (opts.directory) return Promise.reject(new Error("انتخاب پوشه در نسخه‌ی موبایل پشتیبانی نمی‌شود"));
        var m = mimesFor(opts);
        var id = "pick" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
        return new Promise(function (resolve) {
          waiting[id] = function (paths) {
            if (!paths.length) return resolve(null);          // cancelled — Tauri returns null
            resolve(opts.multiple ? paths : paths[0]);
          };
          try {
            Ext.pickPathsAsync(id, !!opts.multiple, m.mime, m.extra);
          } catch (e) { delete waiting[id]; resolve(null); }
          // The chooser is a separate activity; if it never comes back (killed while
          // backgrounded) the promise would hang and the button would look dead again.
          setTimeout(function () {
            if (waiting[id]) { delete waiting[id]; resolve(null); }
          }, 5 * 60 * 1000);
        });
      },
      save: function (opts) {
        opts = opts || {};
        try { return Promise.resolve(Ext.saveTargetPath(opts.defaultPath || "") || null); }
        catch (e) { return Promise.resolve(null); }
      }
    };
  })();

  window.__MIHAN_POLY_READY__ = true;
  try { console.log("[mihan-polyfill] ready — " + Object.keys(POLY).length + " commands, MihanExt=" + (!!Ext)); } catch (_) {}
})();
