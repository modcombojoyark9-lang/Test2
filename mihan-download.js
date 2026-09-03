/* ═══════════════════════════════════════════════════════════════════════════
 *  mihan-download.js — موتورِ دانلودِ نسخه‌ی اندروید (بازنویسیِ کامل، ۱۰۰٪ سرورِ ایران)
 *
 *  این فایل تنها مالکِ «دانلود» در کلِ اپِ اندروید است. قبل از mihan-polyfill.js
 *  لود می‌شود و روی window.__MIHAN_DL__ منتشر می‌گردد.
 *
 *  ── چرا از صفر نوشته شد ──────────────────────────────────────────────────
 *  نسخه‌ی قبلی، دانلودِ فایل‌های لازمِ اجرا را به دانلودگرِ نیتیوِ Pojav می‌سپرد و
 *  فقط چند فایل را «پیش‌بارگذاری» می‌کرد. اما DownloadMirror.getMirrorMapping در
 *  کلاسِ LIBRARIES **فقط** وقتی URL را به CDN بازنویسی می‌کند که هاست با
 *  libraries.minecraft.net تمام شود. کتابخانه‌های هر لودری هاستِ خارجی دارند
 *  (maven.fabricmc.net، maven.minecraftforge.net، …) پس دست‌نخورده به همان هاست
 *  می‌رفتند و در ایران تایم‌اوت می‌خوردند ⇒ دیالوگِ «دانلود Minecraft انجام نشد»
 *  روی هر نسخه‌ی Forge/NeoForge/Fabric/Quilt/OptiFine. بدتر: MinecraftDownloader
 *  .scheduleDownload برای هر lib بدونِ size (همه‌ی libهای fabric/quilt/optifine)
 *  **پیش از هر بررسیِ فایلِ محلی** یک getContentLength روی همان URLِ خارجی می‌زد،
 *  پس حتی دانلودِ کاملِ قبلی هم نجاتش نمی‌داد.
 *
 *  ── معماریِ جدید ─────────────────────────────────────────────────────────
 *  stageVersion(id) یک نسخه را ۱۰۰٪ آماده‌ی اجرای آفلاین می‌کند: زنجیره‌ی
 *  inheritsFrom را حل می‌کند، یک «پلن» تختِ {url,dest,sha1,size} می‌سازد که هر
 *  URLش را **خودش از روی مختصاتِ maven / هشِ asset** روی CDN ایران می‌سازد (هرگز
 *  به فیلدِ url داخلِ json اعتماد نمی‌شود، چون به Mojang/maven اشاره می‌کند)، پلن
 *  را یک‌جا به لایه‌ی جاوا می‌دهد (موازی + resume + sha1 + retry) و در پایان
 *  versions/<id>/.mihan-staged را می‌نویسد. پچِ smali روی MinecraftDownloader
 *  .downloadGame با دیدنِ همین marker بلافاصله return می‌کند، پس مسیرِ لانچ صفر
 *  بایت ترافیک و صفر احتمالِ خطا دارد.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var Ext = window.MihanExt || null;

  var CDN = "https://cdn.mihancraft.com";
  var LOADERS = CDN + "/minecraft-loaders";
  var LIBS = LOADERS + "/libraries";

  var DATA = Ext ? Ext.dataRoot() : "";
  // MC = پوشه‌ی واقعیِ بازیِ Pojav (Tools.DIR_GAME_NEW) — نه getFilesDir/.minecraft
  var MC = Ext ? (Ext.gameDir ? Ext.gameDir() : Ext.minecraftDir()) : "";

  var STAGE_MARKER = ".mihan-staged";
  var EXTRA_LIBS = ".mihan-extra.json"; // مختصاتِ jarهای processedِ فورج (خارج از version.json)

  // ── ابزارهای کوچک ────────────────────────────────────────────────────────
  function emit(ev, payload) {
    try { window.__mihanEmit(ev, JSON.stringify(payload)); } catch (_) {}
  }
  function dlog(kind, detail) {
    try {
      if (!Ext || !Ext.appendLog) return;
      var line = { ts: Date.now(), kind: kind };
      if (detail) for (var k in detail) line[k] = detail[k];
      Ext.appendLog("download.log", JSON.stringify(line));
    } catch (_) {}
  }
  function J() {
    return Array.prototype.filter.call(arguments, function (x) { return x != null && x !== ""; })
      .join("/").replace(/\/+/g, "/");
  }
  function baseName(p) {
    p = String(p).replace(/\\/g, "/");
    var i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
  }
  function exists(p) { try { return !!Ext.exists(p); } catch (_) { return false; } }
  function mkdirs(p) { try { Ext.mkdirs(p); } catch (_) {} }
  function readText(p) { try { return Ext.readText(p) || ""; } catch (_) { return ""; } }
  function readJson(p) { try { var t = readText(p); return t ? JSON.parse(t) : null; } catch (_) { return null; } }
  function writeJson(p, obj) { Ext.writeText(p, JSON.stringify(obj)); }
  function genUuid() {
    if (window.crypto && window.crypto.randomUUID) { try { return window.crypto.randomUUID(); } catch (_) {} }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  // مرتب‌سازیِ نزولیِ نسخه‌های نقطه‌ای/خط‌تیره‌ای (۱.۲۰.۱ > ۱.۹؛ 47.4.20 > 47.4.9)
  function verCmpDesc(a, b) {
    var na = String(a).split(/[.\-_]/), nb = String(b).split(/[.\-_]/);
    for (var i = 0; i < Math.max(na.length, nb.length); i++) {
      var x = parseInt(na[i], 10), y = parseInt(nb[i], 10);
      if (isNaN(x)) x = -1;
      if (isNaN(y)) y = -1;
      if (x !== y) return y - x;
    }
    return 0;
  }
  function uniq(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  // ── پلِ بومی: HTTP و دانلود ──────────────────────────────────────────────
  // این ماژول تنها مالکِ کال‌بک‌هایِ __mihanHttp/__mihanDownloadProgress است؛
  // mihan-polyfill.js از توابعِ صادرشده‌ی همین‌جا استفاده می‌کند.
  var HSEQ = 0, HPEND = {};
  var CANCELLED = {};

  window.__mihanHttp = function (id, ok, payload) {
    var cb = HPEND[id];
    if (!cb) return;
    delete HPEND[id];
    if (ok) cb.resolve(payload);
    else cb.reject(new Error(payload || "خطای شبکه"));
  };
  window.__mihanDownloadProgress = function (id, payload) {
    var cb = HPEND[id];
    if (!cb || typeof cb.progress !== "function") return;
    var data = payload;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (_) { return; } }
    try { cb.progress(data || {}); } catch (_) {}
  };

  function pending(resolve, reject, progress) {
    var id = "d" + (++HSEQ);
    HPEND[id] = { resolve: resolve, reject: reject, progress: progress || null };
    return id;
  }

  // WebView از appassets.androidplatform.net سرو می‌شود، پس fetch() به CDN CORS
  // می‌خورد — همه‌ی HTTP از HttpURLConnection جاوا رد می‌شود.
  /**
   * خطای HTTP را به یک Error با پیامِ تمیز تبدیل می‌کند.
   *
   * پلِ بومی روی وضعیتِ ناموفق رشته‌ی «HTTP <code>: <بدنه>» می‌دهد، و بدنه همان JSONِ
   * کاملِ سرور است. رابط ده‌ها جای مختلف خطا را با `toast("...: " + e)` نشان می‌دهد،
   * پس آن JSON مستقیم جلوی چشمِ کاربر می‌رفت — از جمله جزئیاتِ بررسیِ محتوا (نامِ مدل،
   * دسته، نمره‌ی اطمینان، شماره‌ی فریم). یعنی حذفِ آن پنل در بخشِ اجتماعی کافی نبود؛
   * همان اطلاعات از این مسیر باز هم بیرون می‌زد.
   *
   * این‌جا فقط جمله‌ی `error` سرور به‌عنوان پیام می‌ماند و بقیه روی خودِ شیءِ خطا
   * می‌نشیند (`status` و `body`) تا کدی که واقعاً لازمش دارد بتواند بخواند، ولی
   * چاپِ ساده‌ی خطا هیچ‌وقت داده‌ی داخلی لو ندهد.
   */
  function httpError(raw) {
    var text = String(raw == null ? "" : (raw.message != null ? raw.message : raw));
    var m = /^HTTP (\d{3})(?::\s*([\s\S]*))?$/.exec(text);
    if (!m) return raw instanceof Error ? raw : new Error(text);
    var status = Number(m[1]), payload = m[2] || "", parsed = null;
    try { parsed = payload ? JSON.parse(payload) : null; } catch (_) { parsed = null; }
    var msg = (parsed && typeof parsed === "object" && parsed.error)
      ? String(parsed.error)
      : ("خطای سرور (" + status + ")");
    var err = new Error(msg);
    err.status = status;
    if (parsed && typeof parsed === "object") err.body = parsed;
    return err;
  }

  function javaHttp(method, url, body, ct) {
    return new Promise(function (resolve, reject) {
      if (!Ext || !Ext.httpAsync) { reject(new Error("پل بومی در دسترس نیست")); return; }
      var id = pending(resolve, function (e) { reject(httpError(e)); });
      try { Ext.httpAsync(id, method, url, body || "", ct || ""); }
      catch (e) { delete HPEND[id]; reject(e); }
    });
  }
  // سرور: فرمانِ RCON بدونِ بلاک‌کردنِ نخِ JS — همان کانالِ __mihanHttp/HPEND را دوباره
  // استفاده می‌کند (پیامِ بازگشتی صرفاً یک متن است، فرقی با پاسخِ HTTP ندارد).
  function rconCommand(command) {
    return new Promise(function (resolve, reject) {
      if (!Ext || !Ext.serverCommandAsync) { reject(new Error("پل بومی در دسترس نیست")); return; }
      var id = pending(resolve, reject);
      try { Ext.serverCommandAsync(id, String(command || "")); }
      catch (e) { delete HPEND[id]; reject(e); }
    });
  }
  function getText(url) { return javaHttp("GET", url, "", ""); }
  function getJson(url) {
    return javaHttp("GET", url, "", "").then(function (t) { return t ? JSON.parse(t) : null; });
  }
  function postJson(url, body) {
    return javaHttp("POST", url, JSON.stringify(body || {}), "application/json").then(function (t) {
      try { return t ? JSON.parse(t) : {}; } catch (_) { return { raw: t }; }
    });
  }

  /** یک فایلِ تکی. silent=true یعنی رویدادِ عمومیِ download://status نفرستد. */
  function downloadFile(url, absPath, token, label, opts) {
    var silent = !!(opts && opts.silent);
    var onProgress = opts && typeof opts.onProgress === "function" ? opts.onProgress : null;
    if (token != null && CANCELLED[token]) return Promise.reject(new Error("لغو شد"));
    if (!silent) emit("download://status", { token: token, label: label || baseName(absPath), pct: 0, state: "queued" });
    return new Promise(function (resolve, reject) {
      if (!Ext || !Ext.downloadAsync) { reject(new Error("پل بومی در دسترس نیست")); return; }
      var id = pending(
        function (p) {
          if (!silent) emit("download://status", { token: token, label: label || baseName(absPath), pct: 100, state: "complete", done: true });
          resolve(p);
        },
        function (e) {
          if (!silent) emit("download://status", { token: token, label: label || baseName(absPath), state: /لغو/.test(String(e || "")) ? "cancelled" : "error", error: String(e || "خطای دانلود") });
          reject(e);
        },
        onProgress
      );
      // پیشوندِ «~» = زیرمجموعه‌ی یک عملیاتِ چندفایلی: با token قابلِ کنترل می‌ماند
      // ولی رویدادِ مستقل نمی‌فرستد تا نوارِ aggregate عقب‌وجلو نپرد.
      var t = token == null ? "" : (silent ? "~" + String(token) : String(token));
      try { Ext.downloadAsync(id, url, absPath, t); }
      catch (e) { delete HPEND[id]; reject(e); }
    });
  }

  /**
   * یک پلنِ کامل (تا هزاران فایل) را یک‌جا به جاوا می‌دهد. جاوا خودش موازی‌سازی،
   * skipِ فایل‌های سالم (sha1/size)، resume، retry و نوارِ پیشرفتِ تجمیعی را انجام
   * می‌دهد — رفت‌وبرگشتِ JS↔Java به‌ازای هر فایل (که برای ۳۰۰۰ assetِ یک نسخه فاجعه
   * بود) کاملاً حذف می‌شود.
   */
  function downloadBatch(items, token, label) {
    if (!items || !items.length) return Promise.resolve({ ok: 0, skipped: 0, bytes: 0 });
    if (token != null && CANCELLED[token]) return Promise.reject(new Error("لغو شد"));
    return new Promise(function (resolve, reject) {
      if (!Ext || !Ext.downloadBatchAsync) { reject(new Error("پل بومی در دسترس نیست")); return; }
      var id = pending(
        function (p) { try { resolve(typeof p === "string" ? JSON.parse(p) : p); } catch (_) { resolve({}); } },
        reject
      );
      try { Ext.downloadBatchAsync(id, JSON.stringify({ items: items, label: label || "" }), String(token == null ? "" : token)); }
      catch (e) { delete HPEND[id]; reject(e); }
    });
  }

  // ── متادیتا — همه از سرورِ ایران ─────────────────────────────────────────
  var _iranIdx = null, _manifest = null, _ofIdx = null;
  // true وقتی آخرین گرفتنِ فهرست به‌خاطرِ شبکه شکست خورد (نه چون چیزی نبود).
  var listFailed = false;

  /**
   * یک تلاشِ خام برای گرفتنِ iran-index.json. یک بدنه‌ی خالی/غیرقابل‌پارس (که getJson
   * آن را null برمی‌گرداند، نه reject می‌کند) دقیقاً همان چیزی است که یک قطعیِ موقتِ
   * شبکه/CDN تولید می‌کند — نه نبودِ واقعیِ ایندکس. اگر این را موفقیت بگیریم و در
   * _iranIdx کش کنیم، هر لودر/نسخه‌ای تا ری‌استارتِ کاملِ اپ «روی سرورِ ایران موجود
   * نیست» نشان داده می‌شود، حتی اگر شبکه چند ثانیه بعد برگردد — همان دسته‌باگی که
   * قبلاً در versionJson/installForgeLike پیدا و رفع شد (نگاه کن به isNetworkError)
   * ولی هیچ‌وقت اینجا اعمال نشده بود.
   */
  function iranIndexOnce() {
    return getJson(CDN + "/iran-index.json").then(function (j) {
      if (!j || !j.servers) throw new Error("empty iran-index response");
      return j;
    });
  }
  function iranIndex() {
    if (_iranIdx) return Promise.resolve(_iranIdx);
    var attempts = 3, delayMs = 1500;
    function tryOnce(n) {
      return iranIndexOnce().catch(function (e) {
        if (n >= attempts) {
          // چه reject واقعی (DNS/timeout) چه resolve-با-بدنه‌ی-خالی، بعد از ۳ تلاش
          // برای کاربر یک معنی دارد: نتوانستیم ایندکس را بگیریم.
          listFailed = true;
          throw e;
        }
        return new Promise(function (resolve) { setTimeout(resolve, delayMs); }).then(function () { return tryOnce(n + 1); });
      });
    }
    return tryOnce(1).then(function (j) { listFailed = false; _iranIdx = j; return _iranIdx; });
  }
  function iranList(section, kind) {
    return iranIndex().then(function (idx) {
      var s = idx && idx[section];
      var v = s && s[kind];
      return Array.isArray(v) ? v.slice() : [];
    });
  }
  /**
   * همان باگِ iranIndex (نگاه کن بالاتر)، در یک تابعِ خواهر که هیچ‌وقت رفع نشده بود:
   * یک بدنه‌ی خالی/غیرقابل‌پارس (قطعیِ موقتِ شبکه/CDN، نه نبودِ واقعیِ منیفست) در
   * _manifest کش می‌شد — و چون versionManifest() اول چک می‌کند «اگر _manifest از قبل
   * هست، همان را برگردان»، حتی retryِ خودِ vanilla() در mihan-polyfill.js (که ۲-۳ بار
   * versionManifest را دوباره صدا می‌زد) فقط همان کشِ خالی را برمی‌گرداند — یک تلاشِ
   * ناموفق، Forge/Fabric/Vanilla را تا ری‌استارتِ کاملِ اپ خراب می‌کرد، دقیقاً همان‌طور
   * که یک iranIndex ناموفق همه‌ی لودرها را خراب می‌کرد.
   */
  function versionManifestOnce() {
    return getJson(LOADERS + "/version_manifest_v2.json").then(function (m) {
      if (!m || !Array.isArray(m.versions) || !m.versions.length) throw new Error("empty version manifest response");
      return m;
    });
  }
  function versionManifest() {
    if (_manifest) return Promise.resolve(_manifest);
    var attempts = 3, delayMs = 1500;
    function tryOnce(n) {
      return versionManifestOnce().catch(function (e) {
        if (n >= attempts) { listFailed = true; throw e; }
        return new Promise(function (resolve) { setTimeout(resolve, delayMs); }).then(function () { return tryOnce(n + 1); });
      });
    }
    return tryOnce(1).then(function (m) { listFailed = false; _manifest = m; return _manifest; });
  }
  /** نام‌های یک پوشه‌ی CDN از autoindexِ Apache. */
  function dirEntries(rel) {
    return getText(CDN + "/" + String(rel).replace(/^\/+/, "")).then(function (html) {
      var out = [], re = /href="([^"]+)"/g, m;
      while ((m = re.exec(html))) {
        var name;
        try { name = decodeURIComponent(m[1].replace(/\/+$/, "")); } catch (_) { name = m[1]; }
        if (!name || name === ".." || name.charAt(0) === "?" || name.indexOf("/") >= 0) continue;
        out.push(name);
      }
      return out;
    }).catch(function (e) {
      // خطای شبکه را علامت بزن تا صداکننده بتواند پیامِ درست بدهد (نه «موجود نیست»).
      if (isNetworkError(e)) listFailed = true;
      return [];
    });
  }
  function forgeBuilds(mc) {
    return dirEntries("minecraft-loaders/loaders/forge/").then(function (names) {
      var pre = "forge-" + mc + "-", out = [];
      names.forEach(function (n) {
        if (n.indexOf(pre) !== 0 || !/-installer\.jar$/.test(n)) return;
        out.push(n.slice(pre.length).replace(/-installer\.jar$/, ""));
      });
      return uniq(out).sort(verCmpDesc);
    });
  }
  function neoforgeBuilds(mc) {
    return dirEntries("minecraft-loaders/loaders/neoforge/").then(function (names) {
      var out = [];
      names.forEach(function (n) {
        if (!/-installer\.jar$/.test(n) || n.indexOf("neoforge-") !== 0) return;
        var ver = n.replace(/^neoforge-/, "").replace(/-installer\.jar$/, "");
        // NeoForge drops Minecraft's leading "1.": MC 1.21.1 → 21.1.<build>, MC 1.21 → 21.0.<build>.
        // The trailing dot matters — a bare "21.1" prefix also matched 21.10.x and 21.11.x, so
        // asking for 1.21.1 offered builds for 1.21.10/1.21.11 and installed the wrong loader.
        if (mc) {
          var p = String(mc).split(".");
          var want = p[0] === "1" ? (p[1] || "0") + "." + (p[2] || "0") + "." : String(mc) + ".";
          if (ver.indexOf(want) !== 0) return;
        }
        out.push(ver);
      });
      return uniq(out).sort(verCmpDesc);
    });
  }
  /** نسخه‌های لودرِ fabric/quilt برای یک MC — از نامِ پوشه‌های versions/<kind>/. */
  function metaLoaderVersions(kind, mc) {
    if (!mc) return Promise.resolve([]);
    var prefix = kind + "-loader-", suffix = "-" + mc;
    return dirEntries("minecraft-loaders/versions/" + kind + "/").then(function (names) {
      var out = [];
      names.forEach(function (n) {
        if (n.indexOf(prefix) !== 0) return;
        if (n.length <= prefix.length + suffix.length) return;
        if (n.slice(n.length - suffix.length) !== suffix) return;
        out.push(n.slice(prefix.length, n.length - suffix.length));
      });
      return uniq(out).sort(verCmpDesc);
    });
  }
  /**
   * فهرستِ آپتی‌فاینِ «آماده» (درختِ از پیش ساخته‌شده روی CDN — بدونِ نیاز به اجرای
   * هیچ JVM روی گوشی). خروجی: [{mc, ver, id}]. اگر _index.json نبود، خالی.
   */
  function optifineIndex() {
    if (_ofIdx) return Promise.resolve(_ofIdx);
    return getJson(LOADERS + "/versions/optifine/_index.json").then(function (j) {
      _ofIdx = Array.isArray(j) ? j : [];
      return _ofIdx;
    }).catch(function () { _ofIdx = []; return _ofIdx; });
  }

  // ── حلِ نسخه ─────────────────────────────────────────────────────────────
  function localVersionJsonPath(id) { return J(MC, "versions", id, id + ".json"); }

  /** مسیرهای احتمالیِ json یک آیدی روی CDN (به ترتیبِ اولویت). */
  function cdnVersionJsonUrls(id) {
    var enc = encodeURIComponent(id);
    if (id.indexOf("fabric-loader-") === 0) return [LOADERS + "/versions/fabric/" + enc + "/" + enc + ".json"];
    if (id.indexOf("quilt-loader-") === 0) return [LOADERS + "/versions/quilt/" + enc + "/" + enc + ".json"];
    if (/OptiFine/i.test(id)) return [LOADERS + "/versions/optifine/" + enc + "/" + enc + ".json"];
    if (/-neoforge-/.test(id) || id.indexOf("neoforge-") === 0) return [LOADERS + "/versions/neoforge/" + enc + "/" + enc + ".json"];
    if (/-forge-/.test(id)) return [LOADERS + "/versions/forge/" + enc + "/" + enc + ".json"];
    return [LOADERS + "/versions/vanilla/" + enc + "/" + enc + ".json"];
  }

  /**
   * json یک نسخه: اول محلی، بعد CDN (و در آن صورت محلی هم نوشته می‌شود تا
   * استیجِ بعدی/لانچ آفلاین کار کند).
   */
  /**
   * یک خطا «قطعِ اینترنت» است یا واقعاً «نبودنِ فایل روی سرور»؟
   * تشخیصِ این دو برای کاربر حیاتی است: ده‌ها گزارش «نسخه دانلود نمی‌شود» در واقع
   * قطعیِ DNS/شبکه بوده، ولی پیامِ ما می‌گفت «روی سرورِ ایران موجود نیست» که یعنی
   * نسخه وجود ندارد — کاربر بی‌خود دنبالِ نسخه‌ی دیگری می‌گشت.
   */
  function isNetworkError(e) {
    var m = String((e && e.message) || e || "");
    return /Unable to resolve host|No address associated|ENETUNREACH|ECONNRESET|ETIMEDOUT|timed out|timeout|Connection refused|Network is unreachable|Failed to connect|SSLHandshake|Software caused connection abort/i.test(m);
  }
  var NET_MSG = "اتصال به اینترنت برقرار نشد — شبکه‌ات را بررسی کن و دوباره تلاش کن";

  function versionJson(id) {
    var local = readJson(localVersionJsonPath(id));
    if (local && local.id) return Promise.resolve(local);
    var urls = cdnVersionJsonUrls(id), i = 0, lastErr = null;
    function tryNext() {
      if (i >= urls.length) {
        // اگر حتی یکی از تلاش‌ها خطای شبکه بود، مشکل نبودنِ نسخه نیست.
        if (isNetworkError(lastErr)) return Promise.reject(new Error(NET_MSG));
        return Promise.reject(new Error("نسخه‌ی «" + id + "» روی سرورِ ایران موجود نیست"));
      }
      return getJson(urls[i++]).then(function (j) {
        if (!j || !j.id) throw new Error("bad json");
        mkdirs(J(MC, "versions", id));
        writeJson(localVersionJsonPath(id), j);
        return j;
      }).catch(function (e) {
        if (isNetworkError(e)) lastErr = e;
        return tryNext();
      });
    }
    return tryNext();
  }

  /** زنجیره‌ی inheritsFrom را از فرزند تا وانیلا برمی‌گرداند. */
  function resolveChain(id) {
    var chain = [], seen = {};
    function step(cur) {
      if (!cur || seen[cur]) return Promise.resolve(chain);
      seen[cur] = 1;
      return versionJson(cur).then(function (j) {
        chain.push(j);
        var parent = j.inheritsFrom;
        if (parent && typeof parent === "string" && parent !== cur) return step(parent);
        return chain;
      });
    }
    return step(id);
  }

  /** ادغامِ زنجیره به یک نمایِ واحد (فرزند اولویت دارد). */
  function mergeChain(chain) {
    var out = { id: chain[0].id, libraries: [], assetIndex: null, client: null, logging: null, javaMajor: 0, vanillaId: chain[chain.length - 1].id };
    chain.forEach(function (j) {
      if (Array.isArray(j.libraries)) {
        out.libraries = out.libraries.concat(j.libraries);
        j.libraries.forEach(function (l) {
          var m = l && l.name && String(l.name).match(/^org\.lwjgl:lwjgl:(\d+)\.(\d+)/);
          if (m && !out.lwjgl) out.lwjgl = { major: +m[1], minor: +m[2] };
        });
      }
      if (!out.assetIndex && j.assetIndex) out.assetIndex = j.assetIndex;
      if (!out.client && j.downloads && j.downloads.client) out.client = j.downloads.client;
      if (!out.logging && j.logging && j.logging.client && j.logging.client.file) out.logging = j.logging.client.file;
      if (!out.javaMajor && j.javaVersion && j.javaVersion.majorVersion) out.javaMajor = j.javaVersion.majorVersion | 0;
    });
    if (!out.javaMajor) out.javaMajor = guessJavaMajor(out.vanillaId);
    return out;
  }

  /**
   * فقط فال‌بک است — منبعِ اصلی javaVersion.majorVersion داخلِ خودِ json است.
   * ورودی حتماً آیدیِ وانیلا (نه نامِ پروفایل) است، وگرنه «fabric-loader-0.19.3-1.16.5»
   * به جاوای اشتباه نگاشت می‌شد (باگِ قبلی: نسخه‌های قدیمی جاوا ۲۱ می‌گرفتند).
   */
  function guessJavaMajor(mc) {
    var p = String(mc).split(".");
    var major = parseInt(p[0], 10), minor = parseInt(p[1], 10) || 0, patch = parseInt(p[2], 10) || 0;
    if (major !== 1) return 21;
    if (minor >= 21) return 21;
    if (minor === 20) return patch >= 5 ? 21 : 17;
    if (minor >= 17) return 17;
    return 8;
  }
  /** نزدیک‌ترین رانتایمی که واقعاً روی CDN داریم. */
  function javaMajorClamp(want) {
    var opts = [8, 17, 21, 25];
    for (var i = 0; i < opts.length; i++) if (want <= opts[i]) return opts[i];
    return opts[opts.length - 1];
  }

  // ── ساختِ پلن ────────────────────────────────────────────────────────────
  /** maven coordinate → مسیرِ نسبی زیرِ libraries/ (پورتِ forge_maven_path دسکتاپ). */
  function mavenRelPath(name) {
    var at = String(name).split("@");
    var ext = at.length > 1 ? at[1] : "jar";
    var p = at[0].split(":");
    if (p.length < 3) return null;
    var classifier = (p.length >= 4 && p[3]) ? "-" + p[3] : "";
    return p[0].replace(/\./g, "/") + "/" + p[1] + "/" + p[2] + "/" + p[1] + "-" + p[2] + classifier + "." + ext;
  }

  /**
   * وارونِ mavenRelPath: مسیرِ نسبیِ maven → مختصات.
   * "net/minecraftforge/fmlcore/1.20.1-47.4.20/fmlcore-1.20.1-47.4.20.jar"
   *   → "net.minecraftforge:fmlcore:1.20.1-47.4.20"
   * و اگر نامِ فایل پسوندِ اضافه داشته باشد (…-universal.jar) به classifier تبدیل می‌شود.
   */
  function mavenCoordFromPath(rel) {
    var p = String(rel).replace(/^\/+/, "").split("/");
    if (p.length < 4) return null;
    var file = p[p.length - 1];
    var version = p[p.length - 2];
    var artifact = p[p.length - 3];
    var group = p.slice(0, p.length - 3).join(".");
    if (!group || !artifact || !version) return null;
    var stem = file.replace(/\.jar$/, "");
    var prefix = artifact + "-" + version;
    if (stem.indexOf(prefix) !== 0) return null;
    var classifier = stem.slice(prefix.length).replace(/^-/, "");
    return group + ":" + artifact + ":" + version + (classifier ? ":" + classifier : "");
  }

  /**
   * true اگر این lib روی اندروید لازم نیست. عمداً محافظه‌کارانه: هر چیزی که مطمئن
   * نیستیم دانلود می‌شود (چند مگابایتِ اضافه بی‌ضرر است، یک libِ گم‌شده کرشِ لانچ).
   * org.lwjgl حذف می‌شود چون Pojav نسخه‌ی ARMِ خودش را تزریق می‌کند.
   */
  function skipLib(lib) {
    var n = String(lib.name || "");
    if (n.indexOf("org.lwjgl") !== 0) return false;
    // ...با یک استثنا: lwjgl-vulkan. Pojav فقط GLFW/OpenGL را shim می‌کند و هیچ کلاسی از
    // org.lwjgl.vulkan ندارد، پس این «جایگزینِ نسخه‌ی ARM» نیست، یک شکافِ واقعی است.
    // ماینکرفتِ ۲۶.x در Minecraft.<init> بی‌قید و شرط `new VulkanBackend()` می‌سازد (پیش از
    // اینکه اصلاً به تنظیمِ graphicsApi نگاه کند)، و بدونِ این jar با
    // NoClassDefFoundError: org/lwjgl/vulkan/VkPhysicalDeviceProperties2 می‌میرد.
    // خودِ jar جاوای خالص است — natives فقط برای macOS دارد که optionalLib کنارش می‌گذارد —
    // و هیچ نسخه‌ای پیش از ۲۶ اصلاً لیستش نمی‌کند، پس روی نسخه‌های فعلی بی‌اثر است.
    if (n.indexOf("org.lwjgl:lwjgl-vulkan") === 0 && !lib.natives) return false;
    return true;
  }
  /** libهایی که ممکن است روی CDN نباشند و نبودشان کشنده نیست (نیتیوهای دسکتاپ). */
  function optionalLib(lib) {
    if (lib.natives) return true;
    var rules = lib.rules;
    if (!Array.isArray(rules) || !rules.length) return false;
    // اگر هیچ قاعده‌ای linux را allow نمی‌کند، این lib مالِ ویندوز/مکِ دسکتاپ است.
    var allowsLinux = false;
    rules.forEach(function (r) {
      if (!r || r.action !== "allow") return;
      if (!r.os || !r.os.name || r.os.name === "linux") allowsLinux = true;
    });
    return !allowsLinux;
  }

  function libEntry(lib) {
    var art = lib.downloads && lib.downloads.artifact;
    var rel = (art && art.path) || mavenRelPath(lib.name);
    if (!rel) return null;
    return {
      url: LIBS + "/" + rel,
      dest: J(MC, "libraries", rel),
      sha1: (art && art.sha1) || lib.sha1 || "",
      size: (art && art.size) || lib.size || 0,
      opt: optionalLib(lib),
    };
  }

  /**
   * مقصدِ یک assetِ منفرد — دقیقاً مثلِ MinecraftDownloader.scheduleAssetDownloads:
   *   mapToResources → <MC>/resources/<name>
   *   virtual        → <MC>/assets/<name>
   *   وگرنه          → <MC>/assets/objects/<2hex>/<hash>
   * (URLِ CDN همیشه objects/<2hex>/<hash> است، مستقل از مقصد.)
   */
  function assetEntries(index) {
    var objects = index && index.objects;
    if (!objects) return [];
    var legacy = !!(index.virtual || index.map_to_resources || index.mapToResources);
    var toResources = !!(index.map_to_resources || index.mapToResources);
    var base = toResources ? J(MC, "resources") : J(MC, "assets");
    var out = [];
    Object.keys(objects).forEach(function (name) {
      var info = objects[name];
      if (!info || !info.hash) return;
      var h = info.hash, rel = h.substring(0, 2) + "/" + h;
      out.push({
        url: LOADERS + "/assets/objects/" + rel,
        dest: legacy ? J(base, name) : J(base, "objects", rel),
        sha1: legacy ? "" : h, // مسیرِ legacy با نام ذخیره می‌شود؛ هشِ محتوا همان است ولی مقصد یکتا نیست
        size: info.size || 0,
        opt: false,
      });
    });
    return out;
  }

  /**
   * پلنِ کاملِ یک نسخه. هر URL از روی مختصات/هش ساخته می‌شود — هرگز از فیلدِ `url`
   * داخلِ json (که به Mojang/maven اشاره می‌کند).
   */
  function buildPlan(merged) {
    var items = [];
    var vanillaId = merged.vanillaId;

    // ۱) jarِ وانیلا
    items.push({
      url: LOADERS + "/versions/vanilla/" + encodeURIComponent(vanillaId) + "/" + encodeURIComponent(vanillaId) + ".jar",
      dest: J(MC, "versions", vanillaId, vanillaId + ".jar"),
      sha1: (merged.client && merged.client.sha1) || "",
      size: (merged.client && merged.client.size) || 0,
      opt: false,
    });

    // ۲) کتابخانه‌ها (کلِ زنجیره) + jarهای processedِ فورج
    var extra = readJson(J(MC, "versions", merged.id, EXTRA_LIBS));
    var libs = merged.libraries.slice();
    if (Array.isArray(extra)) extra.forEach(function (coord) { libs.push({ name: coord }); });
    var seenDest = {};
    libs.forEach(function (lib) {
      if (!lib || !lib.name || skipLib(lib)) return;
      var e = libEntry(lib);
      if (!e || seenDest[e.dest]) return;
      seenDest[e.dest] = 1;
      items.push(e);
    });

    // ۳) لاگ‌کانفیگ (اختیاری — نبودش لانچ را نمی‌کشد)
    if (merged.logging && merged.logging.id) {
      items.push({
        url: LOADERS + "/assets/log_configs/" + encodeURIComponent(merged.logging.id),
        dest: J(MC, "assets", "log_configs", merged.logging.id),
        sha1: merged.logging.sha1 || "",
        size: merged.logging.size || 0,
        opt: true,
      });
    }
    return items;
  }

  // ── هسته: استیجِ یک نسخه ─────────────────────────────────────────────────
  /**
   * lwjgl-vulkan.jar را از حالتِ ماژولِ نام‌دار درمی‌آورد.
   *
   * فورجِ ۲۶.x با سیستمِ ماژولِ جاوا بوت می‌شود و این jar در module-info خودش
   * `requires org.lwjgl` دارد. روی این موتور ماژولی به نامِ org.lwjgl وجود ندارد — شیمِ GLFWِ
   * پوجاو یک jarِ معمولیِ کلاس‌پث است — پس رزالورِ فورج پیش از شروعِ بازی می‌میرد:
   *   FindException: Module org.lwjgl not found, required by org.lwjgl.vulkan
   * (روی دستگاهِ واقعی با فورج ۲۶.۲ دیده شد). با حذفِ module-info.class این jar به
   * automatic module تبدیل می‌شود، رزالو می‌شود، و کلاس‌هایش سرِ جایشان می‌مانند —
   * که لازم‌اند، چون ماینکرفتِ ۲۶ بی‌قید و شرط VulkanBackend می‌سازد.
   *
   * فبریک/کوییلت اصلاً از module path استفاده نمی‌کنند و این کار برایشان بی‌اثر است.
   * ایدمپوتنت: بارِ دوم چیزی برای حذف نیست و false برمی‌گرداند.
   */
  function stripVulkanModuleInfo() {
    if (!Ext || !Ext.zipStripEntry) return;
    var dir = J(MC, "libraries", "org", "lwjgl", "lwjgl-vulkan");
    var vers;
    try { vers = JSON.parse(Ext.list(dir) || "[]"); } catch (_) { return; }
    (vers || []).forEach(function (v) {
      if (!v || !v.is_dir) return;
      var jar = J(dir, v.name, "lwjgl-vulkan-" + v.name + ".jar");
      try {
        if (Ext.exists(jar) && Ext.zipStripEntry(jar, "module-info.class")) {
          dlog("vulkan_module_info_stripped", { jar: jar });
        }
      } catch (_) {}
    });
  }

  function markerPath(id) { return J(MC, "versions", id, STAGE_MARKER); }
  function isStaged(id) { return exists(markerPath(id)); }

  /**
   * یک نسخه را ۱۰۰٪ آماده‌ی اجرای آفلاین می‌کند و marker می‌نویسد.
   * idempotent: اگر marker باشد فوراً برمی‌گردد.
   */
  // موتورِ بازیِ داخلِ اپ (Pojav) نسخه‌ی خودش از LWJGL را تزریق می‌کند — یک بیلدِ ARM/gl4es
  // که نسخه‌اش ۳.۳.x است. ماینکرفتِ ۲۶.x به LWJGL 3.4+ نیاز دارد و با ۳.۳ مستقیم کرش
  // می‌کند: «NoSuchMethodError: GLFW.glfwPlatformSupported». این را نمی‌شود با دانلودِ
  // jarهای موجانگ حل کرد، چون آن‌ها natives دسکتاپ‌اند و روی ARM اجرا نمی‌شوند. پس
  // به‌جای اینکه کاربر ۵۰۰ مگ دانلود کند و بعد کرشِ نامفهوم بگیرد، همین اول شفاف بگو.
  var ENGINE_LWJGL = { major: 3, minor: 4 };  // ستِ ۳.۴.۱ حالا باندل است

  /**
   * آیا موتورِ فعلی می‌تواند این آیدیِ نسخه را اجرا کند؟
   *
   * ماینکرفت از ۲۰۲۶ به نام‌گذاریِ سال‌محور رفت (26.1 / 26.2 / 26w14a) و هم‌زمان به
   * LWJGL 3.4 پرید؛ موتورِ ARM/gl4es داخلِ اپ روی ۳.۳.۳ است، پس این نسخه‌ها همیشه با
   * «NoSuchMethodError: GLFW.glfwPlatformSupported» می‌میرند. اسنپ‌شات‌های قدیمی‌تر هم
   * قالبِ <سال>w<هفته> دارند (13w41a، 25w02a) ولی موتورِ قدیمی‌اند و سالم اجرا می‌شوند —
   * برای همین ملاک «سال ≥ ۲۶» است، نه صرفِ داشتنِ w.
   * نسخه‌های خیلی قدیمی (rd-/c0./inf-/a1./b1./1.x) اصلاً این قالب را ندارند و رد می‌شوند.
   */
  // ۲۶.x دیگر مسدود نیست: ستِ LWJGL 3.4.1 (به‌همراهِ vma/shaderc) کنارِ ۳.۳.۳ باندل شده و
  // ensureLwjglForProfile در mihan-polyfill.js موقعِ لانچ بینشان سوییچ می‌کند. عدد را
  // بالا می‌بریم به‌جای حذفِ کامل، چون سالِ بعدی ممکن است دوباره موتور را جلو ببرد و آن‌وقت
  // همین گارد با پیامِ شفافش لازم می‌شود.
  var ENGINE_MAX_YEAR = 27; // اولین سالی که پشتیبانی نمی‌شود
  // مسیرِ آزمایش: با `MihanExt.saveConfig` کلیدِ engine_gate_off=1 را ست کن تا هر دو گارد
  // (سال و LWJGL) رد شوند و بشود دید ۲۶.x واقعاً کجا می‌میرد. برای کاربر هیچ اثری ندارد —
  // پیش‌فرض خاموش است و پیامِ شفافِ ناسازگاری سرِ جایش می‌ماند.
  function gateOff() {
    try { return String((JSON.parse(Ext.config() || '{}') || {}).engine_gate_off || '') === '1'; }
    catch (_) { return false; }
  }
  function engineSupportsVersion(id) {
    if (gateOff()) return true;
    var m = String(id || "").match(/^(\d{2})[.w]/);
    if (!m) return true;
    return parseInt(m[1], 10) < ENGINE_MAX_YEAR;
  }
  function lwjglUnsupported(lw) {
    if (!lw || gateOff()) return false;
    if (lw.major > ENGINE_LWJGL.major) return true;
    return lw.major === ENGINE_LWJGL.major && lw.minor > ENGINE_LWJGL.minor;
  }

  function stageVersion(id, token, opts) {
    id = String(id || "");
    if (!id) return Promise.reject(new Error("نسخه مشخص نشده"));
    token = token || ("stage-" + id);
    var force = !!(opts && opts.force);
    clearCancel(token);

    if (!force) {
      var m = readJson(markerPath(id));
      if (m && m.id === id) return Promise.resolve(m);
      // ── آفلاین: نسخه‌ای که از قبل روی دیسک هست دوباره استیج نمی‌شود ──────────
      // stageVersion قبل از هر اجرا صدا زده می‌شود. نسخه‌های «پایه» (وانیلا) marker
      // ندارند چون marker به نسخه‌ی لودر داده شده، پس هر بار از نو استیج می‌شدند.
      // اندازه‌گیری روی دستگاه با شبکه‌ی قطع: نسخه‌ی marker-دار در ۴ms برمی‌گشت ولی
      // نسخه‌ی بدونِ marker ۱۶٬۳۰۴ms طول می‌کشید — کاربر دکمه‌ی اجرا را می‌زد و
      // لانچر تا نیم‌دقیقه روی «در حال نصب…» می‌ماند:
      //   «وقتی اینترنت وصل نیست لود نمیکنه پروفایل های بازیم رو که نصبشون کردم»
      // وقتی شبکه نیست، تلاش برای دانلود بی‌فایده است و فقط تایم‌اوت می‌خورد؛ اگر
      // json خودِ نسخه روی دیسک باشد یعنی نصب شده و باید همان اجرا شود.
      try {
        if (navigator.onLine === false && exists(localVersionJsonPath(id))) {
          return Promise.resolve({ id: id, offline: true, javaMajor: guessJavaMajor(id) });
        }
      } catch (_) {}
    }

    var merged = null;
    dlog("stage_start", { token: token, id: id });
    emit("download://status", { token: token, label: "خواندنِ اطلاعاتِ " + id + "…", pct: 1, state: "queued" });

    return resolveChain(id).then(function (chain) {
      merged = mergeChain(chain);
      if (lwjglUnsupported(merged.lwjgl)) {
        throw new Error("نسخه‌ی " + id + " با موتورِ فعلیِ بازی سازگار نیست (به LWJGL "
          + merged.lwjgl.major + "." + merged.lwjgl.minor + " نیاز دارد و موتور "
          + ENGINE_LWJGL.major + "." + ENGINE_LWJGL.minor + " دارد). فعلاً تا ماینکرفت ۱.۲۱.۱۱ پشتیبانی می‌شود.");
      }
      emit("download://status", { token: token, label: "آماده‌سازیِ فهرستِ فایل‌ها…", pct: 3, state: "downloading" });
      // اندیسِ assetها را جدا می‌گیریم چون خودش لیستِ هزاران فایلِ بعدی را می‌سازد.
      if (!merged.assetIndex || !merged.assetIndex.id) return null;
      var aid = merged.assetIndex.id;
      var dest = J(MC, "assets", "indexes", aid + ".json");
      return downloadBatch([{
        url: LOADERS + "/assets/indexes/" + encodeURIComponent(aid) + ".json",
        dest: dest,
        sha1: merged.assetIndex.sha1 || "",
        size: merged.assetIndex.size || 0,
        opt: false,
      }], "~" + token, "فهرستِ منابع").then(function () { return readJson(dest); });
    }).then(function (assetIndex) {
      var items = buildPlan(merged);
      if (assetIndex) items = items.concat(assetEntries(assetIndex));
      dlog("stage_plan", { token: token, id: id, files: items.length });
      return downloadBatch(items, token, "دانلودِ " + id);
    }).then(function (res) {
      // معادلِ MinecraftDownloader.ensureJarFileCopy — بدونِ این، کلاس‌پثِ لانچ برای
      // نسخه‌های مود‌شده خالی است و بازی همان اول می‌میرد.
      var vanillaJar = J(MC, "versions", merged.vanillaId, merged.vanillaId + ".jar");
      var ownJar = J(MC, "versions", id, id + ".jar");
      if (merged.vanillaId !== id && exists(vanillaJar) && !exists(ownJar)) {
        try { Ext.copyInto(vanillaJar, ownJar); } catch (_) {}
      }
      stripVulkanModuleInfo();
      var marker = {
        v: 1,
        id: id,
        mc: merged.vanillaId,
        javaMajor: merged.javaMajor,
        files: (res && res.total) || 0,
        ts: Date.now(),
      };
      mkdirs(J(MC, "versions", id));
      writeJson(markerPath(id), marker);
      dlog("stage_done", { token: token, id: id, mc: merged.vanillaId, java: merged.javaMajor });
      return marker;
    }).catch(function (e) {
      dlog("stage_error", { token: token, id: id, error: e && e.message });
      throw e;
    });
  }

  // ── جاوا ─────────────────────────────────────────────────────────────────
  // سه لایه، به ترتیب:
  //   ۱) رانتایمی که از قبل کامل نصب است (readyRuntimeFor)
  //   ۲) رانتایمِ باندل‌شده در خودِ APK (assets/components/jre*)
  //   ۳) همان رانتایم از CDN ایران (runtime/android/pojav/<component>/)
  // لایه‌ی ۳ حیاتی است: بیلدِ LITE که آپدیت‌کننده‌ی داخلِ اپ نصب می‌کند **همه‌ی ۱۴۹ مگ
  // assets/components/jre* را حذف می‌کند**، پس روی گوشی‌ای که آن نسخه‌ی جاوا را قبلاً باز
  // نکرده بود هیچ راهی برای گرفتنِ جاوا نبود و هر اجرا با «failed to autopick runtime»
  // می‌مرد. (جاوای قدیمیِ روی CDN — java17-arm64.tar.xz — یک OpenJDKِ گلیب‌سی بود که روی
  // اندروید اصلاً لود نمی‌شود؛ این‌ها بیلدِ Bionicِ خودِ Pojav‌اند، مستقیم از همان APK.)
  var JAVA_CDN = CDN + "/runtime/android/pojav";

  function javaReady(major) {
    try { if (Ext && Ext.readyRuntimeFor && Ext.readyRuntimeFor(major)) return true; } catch (_) {}
    try { if (Ext && Ext.internalJavaReady && Ext.internalJavaReady(major)) return true; } catch (_) {}
    return false;
  }

  /** رانتایم را از CDN ایران می‌گیرد و نصب می‌کند (فال‌بکِ بیلدِ LITE). */
  function installJavaFromCdn(major, tok) {
    var comp = (Ext && Ext.javaComponentName) ? Ext.javaComponentName(major) : "";
    if (!comp) return Promise.reject(new Error("نامِ بسته‌ی جاوا مشخص نشد"));
    var arch = (Ext && Ext.deviceArch) ? Ext.deviceArch() : "arm64";
    var dir = J(DATA, "tmp", "java-" + comp);
    mkdirs(dir);
    var uni = J(dir, "universal.tar.xz");
    var bin = J(dir, "bin-" + arch + ".tar.xz");
    emit("download://status", { token: tok, label: "دانلودِ جاوا " + major + " از سرورِ ایران…", pct: 20, state: "downloading" });
    return downloadBatch([
      { url: JAVA_CDN + "/" + comp + "/universal.tar.xz", dest: uni, sha1: "", size: 0, opt: false },
      { url: JAVA_CDN + "/" + comp + "/bin-" + arch + ".tar.xz", dest: bin, sha1: "", size: 0, opt: false },
    ], "~" + tok, "جاوا " + major).then(function () {
      emit("download://status", { token: tok, label: "نصبِ جاوا " + major + "…", pct: 80, state: "verifying" });
      return new Promise(function (resolve, reject) {
        if (!Ext || !Ext.installJavaBinpackAsync) { reject(new Error("پل بومی در دسترس نیست")); return; }
        var id = pending(resolve, reject);
        try { Ext.installJavaBinpackAsync(id, uni, bin, major); }
        catch (e) { delete HPEND[id]; reject(e); }
      });
    }).then(function (name) {
      try { Ext.del(dir); } catch (_) {}
      return name;
    });
  }

  // رانتایم‌های خرابِ به‌جامانده از مسیرِ قدیمیِ «جاوا از CDN» (mihan-java*) یک‌بار در
  // شروع پاک می‌شوند: libjvm.so دارند پس هر بررسیِ سلامتی قبولشان می‌کند، ولی روی اندروید
  // اصلاً لود نمی‌شوند و بازی با کدِ ۱- می‌میرد.
  var _purgedRuntimes = false;
  function purgeBrokenRuntimesOnce() {
    if (_purgedRuntimes) return;
    _purgedRuntimes = true;
    try {
      var n = Ext && Ext.purgeBrokenRuntimes ? Ext.purgeBrokenRuntimes() : 0;
      if (n) dlog("purged_broken_runtimes", { count: n });
    } catch (_) {}
  }

  function ensureJava(want, token) {
    purgeBrokenRuntimesOnce();
    var major = javaMajorClamp(want || 8);
    var tok = token || "java-install";
    // Pojav ممکن است هم‌زمان در startup رانتایمِ باندل‌شده را باز کرده باشد. فقط یک runtime
    // واقعاً کامل (marker + libjvm) را قبول می‌کنیم و از نصبِ دوباره/رقابت با bootstrap می‌پرهیزیم.
    if (javaReady(major)) return Promise.resolve(major);

    emit("download://status", { token: tok, label: "آماده‌سازیِ جاوا " + major + "…", pct: 10, state: "verifying" });

    var haveBundled = true;
    try { if (Ext && Ext.hasBundledJava) haveBundled = !!Ext.hasBundledJava(major); } catch (_) {}

    var install = haveBundled
      ? new Promise(function (resolve, reject) {
          if (!Ext || !Ext.installBundledJavaAsync) { reject(new Error("پل بومی در دسترس نیست")); return; }
          var id = pending(resolve, reject);
          try { Ext.installBundledJavaAsync(id, major); }
          catch (e) { delete HPEND[id]; reject(e); }
        }).catch(function (e) {
          // بیلدِ کامل هم ممکن است asset ناقص داشته باشد — باز هم CDN را امتحان کن.
          dlog("java_bundled_failed", { major: major, error: e && e.message });
          return installJavaFromCdn(major, tok);
        })
      : installJavaFromCdn(major, tok);

    return install.then(function () {
      if (!javaReady(major)) throw new Error("جاوا " + major + " نصب شد اما Runtime کامل و قابل اجرا پیدا نشد");
      emit("download://status", { token: tok, label: "جاوا آماده شد", pct: 100, state: "complete", done: true });
      return major;
    });
  }

  /** جاوای لازمِ یک نسخه — از markerِ استیج (دقیق)، وگرنه حدس از روی نامِ MC. */
  function ensureJavaFor(id, token) {
    var m = readJson(markerPath(id));
    var major = (m && m.javaMajor) || 0;
    if (!major) {
      var mc = (m && m.mc) || String(id).replace(/^.*?(\d+\.\d+(\.\d+)?).*$/, "$1");
      major = guessJavaMajor(mc);
    }
    return ensureJava(major, token || "launch-java").then(function (installed) {
      // javaDir را صریح روی همان رانتایمِ Internal ست می‌کنیم تا لانچر قطعاً همان را
      // بردارد (نه یک رانتایمِ خرابِ باقی‌مانده از نصب‌های قبلی). دقیقاً کاری که
      // کلاینتِ PvP برای Internal-8 می‌کند و اثبات‌شده کار می‌کند.
      try {
        var name = Ext.readyRuntimeFor ? Ext.readyRuntimeFor(major) : (Ext.internalRuntimeFor ? Ext.internalRuntimeFor(major) : "");
        if (name) pinProfileJava(id, name);
      } catch (_) {}
      return installed;
    });
  }

  /** javaDir یک پروفایل را روی یک رانتایمِ نام‌دار قفل می‌کند (pojav://<name>). */
  function pinProfileJava(versionId, runtimeName) {
    var lp = J(MC, "launcher_profiles.json");
    var obj = readJson(lp) || {};
    if (!obj.profiles) return;
    var changed = false;
    Object.keys(obj.profiles).forEach(function (k) {
      var p = obj.profiles[k];
      if (p && p.lastVersionId === versionId && p.javaDir !== "pojav://" + runtimeName) {
        p.javaDir = "pojav://" + runtimeName;
        changed = true;
      }
    });
    if (changed) Ext.writeText(lp, JSON.stringify(obj));
  }

  // ── پروفایل‌ها ───────────────────────────────────────────────────────────
  function writeProfile(versionId, extra) {
    var lp = J(MC, "launcher_profiles.json");
    var obj = readJson(lp) || {};
    if (typeof obj !== "object" || !obj) obj = {};
    if (!obj.profiles) obj.profiles = {};
    if (!obj.settings) obj.settings = {};
    if (!obj.version) obj.version = 3;
    var key = null;
    Object.keys(obj.profiles).forEach(function (k) {
      if (obj.profiles[k] && obj.profiles[k].lastVersionId === versionId) key = k;
    });
    if (!key) key = genUuid();
    var p = obj.profiles[key] || { name: versionId, lastVersionId: versionId };
    p.name = p.name || versionId;
    p.lastVersionId = versionId;
    if (extra) for (var k2 in extra) p[k2] = extra[k2];
    obj.profiles[key] = p;
    Ext.writeText(lp, JSON.stringify(obj));
    return key;
  }

  // ── نصب‌کننده‌ها ─────────────────────────────────────────────────────────
  function finish(token, id, makeProfile) {
    if (makeProfile !== false) writeProfile(id);
    // پروفایل از همان لحظه‌ی نصب به Runtime سالم قفل می‌شود؛ در نسخه‌ی قبلی این کار فقط
    // پیش از launch انجام می‌شد و اگر resolve شناسه شکست می‌خورد Pojav به autopick می‌افتاد.
    try {
      var marker = readJson(markerPath(id));
      var major = (marker && marker.javaMajor) || guessJavaMajor((marker && marker.mc) || id);
      var runtime = Ext.readyRuntimeFor ? Ext.readyRuntimeFor(major) : (Ext.internalRuntimeFor ? Ext.internalRuntimeFor(major) : "");
      if (runtime) pinProfileJava(id, runtime);
    } catch (_) {}
    emit("download://status", { token: token, label: "✓ " + id + " آماده است", pct: 100, state: "complete", done: true });
    return id;
  }

  /** وانیلا. */
  function installVanilla(a) {
    var id = String((a && (a.versionId || a.id)) || "");
    var token = (a && a.token) || ("ver-" + id);
    var makeProfile = !a || a.makeProfile !== false;
    if (!id) return Promise.reject(new Error("نسخه مشخص نشده"));
    clearCancel(token);
    return stageVersion(id, token).then(function (m) {
      return ensureJava(m.javaMajor, token);
    }).then(function () { return finish(token, id, makeProfile); });
  }

  /**
   * Forge / NeoForge. نصب‌کننده فقط برای بیرون‌کشیدنِ version.json و مختصاتِ
   * jarهای processed لازم است — هیچ processorی روی گوشی اجرا نمی‌شود (روی JVMِ
   * جاسازی‌شده‌ی Pojav قطعاً هنگ می‌کنند؛ خروجیِ آماده‌شان از قبل روی CDN است).
   */
  function installForgeLike(loader, mc, token, makeProfile, wantVer) {
    listFailed = false;
    var listFn = loader === "neoforge" ? neoforgeBuilds : forgeBuilds;
    var label = loader === "neoforge" ? "NeoForge" : "Forge";
    var ver = "", forgeId = "", installerPath = "";
    clearCancel(token);
    dlog("loader_install_start", { token: token, loader: loader, mc: mc });
    return listFn(mc).then(function (list) {
      if (!list.length) {
        // فهرستِ خالی می‌تواند «واقعاً نداریم» باشد یا «نتوانستیم فهرست را بگیریم».
        if (listFailed) throw new Error(NET_MSG);
        throw new Error(label + " برای نسخه‌ی " + mc + " روی سرورِ ایران موجود نیست");
      }
      ver = wantVer && list.indexOf(wantVer) >= 0 ? wantVer : list[0];
      var fileName = loader === "neoforge"
        ? ("neoforge-" + ver + "-installer.jar")
        : ("forge-" + mc + "-" + ver + "-installer.jar");
      installerPath = J(DATA, "cache", loader, fileName);
      mkdirs(J(DATA, "cache", loader));
      emit("download://status", { token: token, label: "دریافتِ اطلاعاتِ " + label + " " + ver + "…", pct: 5, state: "downloading" });
      if (exists(installerPath)) return null;
      return downloadFile(LOADERS + "/loaders/" + loader + "/" + fileName, installerPath, token, fileName, { silent: true });
    }).then(function () {
      var tmp = J(DATA, "cache", loader, "x-" + ver.replace(/[^A-Za-z0-9._-]/g, "_"));
      try { Ext.del(tmp); } catch (_) {}
      mkdirs(tmp);
      Ext.unzip(installerPath, tmp);
      var vjText = readText(J(tmp, "version.json"));
      if (!vjText) throw new Error("version.json داخلِ نصب‌کننده‌ی " + label + " پیدا نشد");
      var verJson = JSON.parse(vjText);
      forgeId = verJson.id;
      if (!forgeId) throw new Error("version.json " + label + " بدونِ id بود");
      mkdirs(J(MC, "versions", forgeId));
      Ext.writeText(J(MC, "versions", forgeId, forgeId + ".json"), vjText);

      // jarهای patch‌شده‌ی کلاینت (client-…-srg.jar / …-extra.jar / forge-…-client.jar)
      // در version.json.libraries **نیستند** — FML موقعِ اجرا از روی مسیرِ maven پیدایشان
      // می‌کند. مختصاتشان از install_profile.json (سمتِ client) درمی‌آید و کنارِ json
      // ذخیره می‌شود تا استیجِ بعدی هم بدونِ نصب‌کننده آن‌ها را بیاورد. نبودشان =
      // «Invalid paths argument» موقعِ لانچ.
      var coords = [];
      try {
        var ip = JSON.parse(readText(J(tmp, "install_profile.json")) || "{}");
        var d = ip.data || {};
        var patched = "";
        ["MC_SRG", "MC_EXTRA", "PATCHED"].forEach(function (k) {
          var side = d[k] && (d[k].client != null ? d[k].client : d[k]);
          var coord = side ? String(side).replace(/^\[+|\]+$/g, "").trim() : "";
          if (!coord || coord.indexOf(":") < 0) return;
          coords.push(coord);
          if (k === "PATCHED") patched = coord;
        });
        // خودِ jarِ «universal» لودر هم با مسیرِ maven پیدا می‌شود و در هیچ لیستی نیست.
        // فورج آن را داخلِ درختِ maven/ نصب‌کننده دارد، ولی نصب‌کننده‌ی نئوفورج اصلاً
        // maven/ ندارد — نبودش یعنی «Invalid paths argument … neoforge-…-universal.jar»
        // دقیقاً بعدِ صفحه‌ی «NeoForge loading». همان مختصاتِ PATCHED با classifierِ
        // universal، که برای هر دو لودر درست است.
        // ...ولی این اشتقاق فقط تا پیش از ۲۶ درست بود: آن‌جا PATCHED خودش
        // `net.neoforged:neoforge:<ver>` بود، پس افزودنِ classifier به jarِ درست می‌رسید.
        // در ۲۶.x نئوفورج PATCHED را به `net.neoforged:minecraft-client-patched:<ver>` عوض
        // کرده و همان اشتقاق به فایلی می‌رسد که اصلاً وجود ندارد:
        //   minecraft-client-patched-26.2.0.7-beta-universal.jar → HTTP 404
        // (روی دستگاهِ واقعی، نصبِ نئوفورجِ ۲۶.۲ همین‌جا شکست می‌خورد). jarِ واقعی همیشه
        // `net.neoforged:neoforge:<ver>:universal` است — از خودِ نسخه‌ی لودر، نه از PATCHED.
        if (loader === "neoforge" && ver) {
          var nfUni = "net.neoforged:neoforge:" + ver + ":universal";
          if (coords.indexOf(nfUni) < 0) coords.push(nfUni);
        } else if (patched) {
          var parts = patched.split(":");
          if (parts.length >= 3) {
            var universal = parts[0] + ":" + parts[1] + ":" + parts[2] + ":universal";
            if (coords.indexOf(universal) < 0) coords.push(universal);
          }
        }
      } catch (_) {}

      // ماژول‌های bootstrapِ FML (fmlcore / javafmllanguage / lowcodelanguage / mclanguage
      // و forge-…-universal) هم در version.json.libraries **نیستند** — فقط داخلِ درختِ
      // maven/ خودِ نصب‌کننده‌اند و FML موقعِ اجرا از روی مسیرِ maven پیدایشان می‌کند.
      // نبودشان همان «Invalid paths argument … fmlcore-…jar» است که فورج را درست بعد از
      // صفحه‌ی «Forge loading» می‌کشت. هم مستقیم از نصب‌کننده کپی‌شان می‌کنیم (آفلاین و
      // قطعی) و هم مختصاتشان را کنارِ json ذخیره می‌کنیم تا استیجِ بعدی از CDN بیاوردشان.
      try {
        JSON.parse(Ext.zipEntries(installerPath) || "[]").forEach(function (entry) {
          if (entry.indexOf("maven/") !== 0 || !/\.jar$/.test(entry)) return;
          var rel = entry.slice("maven/".length);
          try { Ext.copyInto(J(tmp, entry), J(MC, "libraries", rel)); } catch (_) {}
          var c = mavenCoordFromPath(rel);
          if (c && coords.indexOf(c) < 0) coords.push(c);
        });
      } catch (_) {}

      // …ولی نصب‌کننده‌های جدیدترِ فورج اصلاً درختِ maven/ ندارند. روی خودِ فایل تأیید شد:
      // forge-1.19.2-43.5.2-installer.jar دقیقاً صفر ورودیِ «maven/*.jar» دارد (در حالی که
      // ۱٫۲۰٫۱-۴۷٫۴٫۲۰ دارد). نتیجه‌اش این بود که حلقه‌ی بالا هیچ‌کدام از ماژول‌ها را پیدا
      // نمی‌کرد، EXTRA_LIBS فقط چهار مختصاتِ client/forge می‌گرفت، و لانچ با همان
      // «Invalid paths argument … fmlcore-1.19.2-43.5.2.jar» می‌مرد. نامِ این ماژول‌ها
      // کاملاً قابلِ ساخت از روی نسخه است و هر چهارتا روی CDNِ ایران موجودند، پس وقتی
      // نصب‌کننده ندارَدشان خودمان مختصات را می‌سازیم تا stageVersion از CDN بیاوردشان.
      // فقط برای فورجِ ماژولی (۱٫۱۷+، mainClass = BootstrapLauncher) — فورجِ قدیمیِ
      // LaunchWrapper چنین ماژول‌هایی ندارد و این مختصات برایش ۴۰۴ می‌شد.
      if (loader === "forge" && /bootstraplauncher/i.test(String(verJson.mainClass || ""))) {
        ["fmlcore", "javafmllanguage", "lowcodelanguage", "mclanguage"].forEach(function (mod) {
          var c = "net.minecraftforge:" + mod + ":" + mc + "-" + ver;
          if (coords.indexOf(c) < 0) coords.push(c);
        });
      }

      writeJson(J(MC, "versions", forgeId, EXTRA_LIBS), coords);
      try { Ext.del(tmp); } catch (_) {}
      return stageVersion(forgeId, token, { force: true });
    }).then(function (m) {
      return ensureJava(m.javaMajor, token);
    }).then(function () {
      dlog("loader_install_done", { token: token, loader: loader, mc: mc, id: forgeId });
      return finish(token, forgeId, makeProfile);
    }).catch(function (e) {
      dlog("loader_install_error", { token: token, loader: loader, mc: mc, error: e && e.message });
      throw e;
    });
  }

  /** Fabric / Quilt — پروفایلِ آماده روی CDN است، فقط استیج می‌شود. */
  function installMetaLoader(kind, mc, loaderVer, token, makeProfile) {
    if (!mc) return Promise.reject(new Error("نسخه مشخص نشده"));
    listFailed = false;
    clearCancel(token);
    var pick = loaderVer
      ? Promise.resolve(loaderVer)
      : metaLoaderVersions(kind, mc).then(function (vs) {
          if (!vs.length) {
            if (listFailed) throw new Error(NET_MSG);
            throw new Error(kind + " برای نسخه‌ی " + mc + " روی سرورِ ایران موجود نیست");
          }
          return vs[0];
        });
    return pick.then(function (lv) {
      var id = kind + "-loader-" + lv + "-" + mc;
      return stageVersion(id, token).then(function (m) {
        return ensureJava(m.javaMajor, token).then(function () {
          return finish(token, id, makeProfile);
        });
      });
    });
  }

  /**
   * OptiFine — درختِ از پیش ساخته‌شده روی CDN (versions/optifine/<id>/ + کتابخانه‌های
   * optifine/*). قبلاً نصب‌کننده‌ی رسمی داخلِ یک JVM روی گوشی اجرا می‌شد که کلِ پروسه‌ی
   * اپ را می‌بست (یک JVM در هر پروسه). حالا نصب صرفاً «دانلود» است: بدونِ JVM، بدونِ
   * بسته‌شدنِ اپ، بدونِ reconcileِ بعدی.
   */
  function installOptifine(mc, token, makeProfile) {
    clearCancel(token);
    return optifineIndex().then(function (list) {
      var entry = null;
      list.forEach(function (e) { if (e && e.mc === mc && !entry) entry = e; });
      if (!entry || !entry.id) {
        throw new Error("آپتی‌فاینِ آماده برای نسخه‌ی " + mc + " هنوز روی سرورِ ایران نیست");
      }
      return stageVersion(entry.id, token).then(function (m) {
        return ensureJava(m.javaMajor, token).then(function () {
          return finish(token, entry.id, makeProfile);
        });
      });
    });
  }

  // ── نسخه‌های نصب‌شده / یتیم ──────────────────────────────────────────────
  /** آیدیِ نسخه‌های موجود در .minecraft/versions (فارغ از استیج‌بودن). */
  function localVersionIds() {
    try {
      var entries = JSON.parse(Ext.list(J(MC, "versions")) || "[]");
      // ⚠ Ext.list ورودی‌ها را با کلیدِ is_dir برمی‌گرداند، نه dir. فیلترِ قبلی روی
      // e.dir بود که همیشه undefined است، پس این تابع همیشه آرایه‌ی خالی می‌داد —
      // اندازه‌گیری روی دستگاه: همان پوشه با list_installed بیست‌ونه نسخه داشت و
      // این‌جا صفر. نتیجه‌اش این بود که unstagedVersions() هیچ‌وقت چیزی پیدا نمی‌کرد و
      // scan_orphaned_versions همیشه خالی بود، یعنی نسخه‌های نیمه‌کاره/دستی هرگز
      // شناسایی و ترمیم نمی‌شدند.
      return entries.filter(function (e) { return e && e.is_dir; }).map(function (e) { return e.name; });
    } catch (_) { return []; }
  }
  /** نسخه‌هایی که json دارند ولی marker ندارند (نصبِ نیمه‌کاره یا واردشده با دست). */
  function unstagedVersions() {
    return localVersionIds().filter(function (id) {
      return exists(localVersionJsonPath(id)) && !isStaged(id);
    });
  }

  function cancel(token) {
    if (token == null) return false;
    CANCELLED[token] = true;
    var any = false;
    try { any = !!Ext.cancelDownload(String(token)); } catch (_) {}
    return any;
  }
  function isCancelled(token) { return token != null && !!CANCELLED[token]; }
  // Tokens are derived from version ids ("ver-1.20.1", "forge-install"), so a cancel flag
  // that is never cleared would poison that token for the rest of the session — the next
  // install of the same version would reject with "لغو شد" before sending a single byte.
  // Every entry point below starts by clearing its own token.
  function clearCancel(token) { if (token != null) delete CANCELLED[token]; }

  // ── صادرات ──────────────────────────────────────────────────────────────
  window.__MIHAN_DL__ = {
    CDN: CDN,
    LOADERS: LOADERS,
    LIBS: LIBS,
    MC: MC,
    DATA: DATA,

    // HTTP (تنها مالکِ پلِ بومی — polyfill از همین‌ها استفاده می‌کند)
    // ثبتِ یک کال‌بکِ بومی و گرفتنِ id — برای متدهای async جاوا که خارج از این
    // ماژول صدا زده می‌شوند (نصبِ جاوا ۸ باندل‌شده، دانلودِ APKِ آپدیت).
    pending: pending,
    httpError: httpError,
    javaHttp: javaHttp,
    getText: getText,
    getJson: getJson,
    postJson: postJson,
    downloadFile: downloadFile,
    downloadBatch: downloadBatch,
    rconCommand: rconCommand,

    // متادیتا
    iranIndex: iranIndex,
    iranList: iranList,
    versionManifest: versionManifest,
    // true اگر آخرین تلاش برای گرفتنِ یک فهرست (iranIndex/versionManifest/dirEntries)
    // به‌خاطرِ شبکه/CDN شکست خورد، نه چون واقعاً چیزی برای آن لودر نبود. app.js این را
    // بعدِ یک server_versions خالی چک می‌کند تا پیامِ درست (نه «پشتیبانی نمی‌شود») بدهد.
    didListFail: function () { return listFailed; },
    dirEntries: dirEntries,
    forgeBuilds: forgeBuilds,
    neoforgeBuilds: neoforgeBuilds,
    metaLoaderVersions: metaLoaderVersions,
    optifineIndex: optifineIndex,

    // هسته
    versionJson: versionJson,
    resolveChain: resolveChain,
    mergeChain: mergeChain,
    buildPlan: buildPlan,
    assetEntries: assetEntries,
    mavenRelPath: mavenRelPath,
    stageVersion: stageVersion,
    isStaged: isStaged,
    engineSupportsVersion: engineSupportsVersion,
    markerPath: markerPath,
    stripVulkanModuleInfo: stripVulkanModuleInfo,
    localVersionIds: localVersionIds,
    unstagedVersions: unstagedVersions,

    // جاوا
    ensureJava: ensureJava,
    ensureJavaFor: ensureJavaFor,
    guessJavaMajor: guessJavaMajor,

    // نصب
    installVanilla: installVanilla,
    installForgeLike: installForgeLike,
    installMetaLoader: installMetaLoader,
    installOptifine: installOptifine,
    writeProfile: writeProfile,

    // کنترل
    cancel: cancel,
    isCancelled: isCancelled,
    clearCancel: clearCancel,
    verCmpDesc: verCmpDesc,
    J: J,
    baseName: baseName,
  };
})();
