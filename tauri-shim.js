/* ═══════════════════════════════════════════════════════════
 *  tauri-shim.js — جایگزینِ window.__TAURI__ روی اندروید (WebView)
 *  invoke → پلِ بومیِ AndroidBridge ؛ event.listen → __mihanEmit
 *  این فایل باید قبل از app.js اجرا شود (در <head> به‌صورتِ classic script).
 * ═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var pending = new Map();
  var seq = 0;

  // بومی → وب: نتیجهٔ invoke
  window.__mihanResolve = function (id, jsonText) {
    var cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    var v = null;
    try { v = JSON.parse(jsonText); } catch (e) { v = null; }
    cb.resolve(v);
  };
  window.__mihanReject = function (id, msg) {
    var cb = pending.get(id);
    if (!cb) return;
    pending.delete(id);
    cb.reject(new Error(msg || "خطا"));
  };

  // رویدادها (install://progress و …)
  var listeners = new Map();
  window.__mihanEmit = function (event, payloadJson) {
    var set = listeners.get(event);
    if (!set) return;
    var payload;
    try { payload = JSON.parse(payloadJson); } catch (e) { payload = payloadJson; }
    set.forEach(function (fn) {
      try { fn({ event: event, payload: payload, id: 0 }); } catch (e) {}
    });
  };

  // Undo the launch-time transparency below. That hack blanks this WebView so the game's surface
  // shows through, and it used to be a non-issue because Pojav killed the whole ":launcher"
  // process moments later. The process now survives on purpose (see the MIHAN PATCH in
  // ContextAwareDoneListener.smali — the launcher stays up so Minecraft can be its own switchable
  // app), which turned that hack into a permanent blank screen: switching back from the game
  // showed the right Activity rendering a fully transparent page.
  //
  // Hooked to visibility rather than to game exit because there is no "game exited" signal on
  // this side at all now — the game lives in a different task AND a different process. Being
  // visible again is exactly the condition that matters, and it covers every route back (recents,
  // back button, launcher icon).
  window.__mihanRestoreUi = function () {
    try {
      document.documentElement.style.opacity = "";
      document.body.style.opacity = "";
      document.documentElement.style.background = "";
      document.body.style.background = "";
    } catch (e) {}
  };
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) window.__mihanRestoreUi();
  });
  window.addEventListener("pageshow", function () { window.__mihanRestoreUi(); });

  function invoke(cmd, args) {
    // JS polyfill layer first: commands the native Kotlin bridge doesn't handle
    // (mihan-polyfill.js). Everything else falls through to AndroidBridge.
    var poly = window.__MIHAN_POLY__ && window.__MIHAN_POLY__[cmd];
    if (poly) {
      var p = Promise.resolve().then(function () { return poly(args || {}); });
      if (cmd === "launch_game" || cmd === "pvp_launch" || cmd === "instance_launch") {
        p.then(function () {
          setTimeout(function () {
            document.documentElement.style.background = "transparent";
            document.body.style.background = "transparent";
            document.body.style.opacity = "0";
            document.documentElement.style.opacity = "0";
          }, 500);
        });
      }
      return p;
    }
    return new Promise(function (resolve, reject) {
      var id = "c" + (++seq);
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        if (!window.AndroidBridge || !window.AndroidBridge.invoke) {
          throw new Error("پلِ بومی در دسترس نیست.");
        }
        window.AndroidBridge.invoke(id, cmd, JSON.stringify(args || {}));
        if (cmd === "launch_game" || cmd === "pvp_launch" || cmd === "instance_launch") {
          var origResolve = resolve;
          pending.set(id, {
            resolve: function(v) {
              origResolve(v);
              setTimeout(function() {
                document.documentElement.style.background = "transparent";
                document.body.style.background = "transparent";
                document.body.style.opacity = "0";
                document.documentElement.style.opacity = "0";
              }, 500);
            },
            reject: reject
          });
        }
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  // مسیرِ مستقیم به پلِ بومی، بدونِ چکِ POLY — برای وقتی که خودِ POLY یک کامند
  // (مثلِ instance_launch) را override کرده ولی نیاز دارد پیاده‌سازیِ اصلیِ نیتیو را
  // هم صدا بزند؛ صدا زدنِ invoke() معمولی از داخلِ POLYِ خودش یک بازگشتِ بی‌نهایت
  // می‌ساخت (چون invoke() دوباره POLY را اول چک می‌کند).
  window.__mihanForceNative = function (cmd, args) {
    return new Promise(function (resolve, reject) {
      var id = "n" + (++seq);
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        if (!window.AndroidBridge || !window.AndroidBridge.invoke) {
          throw new Error("پلِ بومی در دسترس نیست.");
        }
        window.AndroidBridge.invoke(id, cmd, JSON.stringify(args || {}));
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  };

  function listen(event, cb) {
    var set = listeners.get(event);
    if (!set) { set = new Set(); listeners.set(event, set); }
    set.add(cb);
    return Promise.resolve(function () { set.delete(cb); });
  }

  function extMime(path) {
    var m = /\.([a-z0-9]+)(?:\?|$)/i.exec(String(path || "")) ;
    var ext = m ? m[1].toLowerCase() : "";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "webp") return "image/webp";
    if (ext === "gif") return "image/gif";
    if (ext === "svg") return "image/svg+xml";
    return "image/png";
  }
  function convertFileSrc(path, protocol) {
    if (!path) return path;
    if (/^(https?:|data:|blob:|content:)/.test(path)) return path;
    // فایل‌های محلیِ اندروید (اسکرین‌شات‌ها، آیکونِ سرور، پیش‌نمایشِ اسکین و …) —
    // چون MihanExt همزمان (synchronous) است، مستقیماً بایت‌ها را می‌خوانیم و یک
    // data-URI برمی‌گردانیم؛ قبلاً به یک هندلرِ asset اشاره می‌کرد که هرگز پیاده
    // نشده بود و همه‌ی این تصویرها را ۴۰۴ می‌کرد (گالری/بک‌آپ/آیکون خالی).
    try {
      if (window.MihanExt && window.MihanExt.readB64) {
        var b64 = window.MihanExt.readB64(path);
        if (b64) return "data:" + extMime(path) + ";base64," + b64;
      }
    } catch (e) {}
    return "https://appassets.androidplatform.net/localfs/" + encodeURIComponent(path);
  }

  // پنجرهٔ مجازی — روی موبایل دکمه‌های min/max/close بی‌معنی‌اند (no-op).
  function fakeWindow() {
    var noop = function () { return Promise.resolve(); };
    return {
      minimize: noop, maximize: noop, unmaximize: noop, toggleMaximize: noop,
      close: noop, destroy: noop, hide: noop, show: noop,
      startDragging: noop, setTitle: noop, setFocus: noop, center: noop,
      isMaximized: function () { return Promise.resolve(false); },
      isFullscreen: function () { return Promise.resolve(true); },
      setFullscreen: noop,
      listen: function () { return Promise.resolve(function () {}); },
      once: function () { return Promise.resolve(function () {}); },
      onResized: function () { return Promise.resolve(function () {}); },
      onDragDropEvent: function () { return Promise.resolve(function () {}); },
      emit: noop,
    };
  }

  window.__TAURI__ = {
    core: { invoke: invoke, convertFileSrc: convertFileSrc },
    event: {
      listen: listen,
      once: function (ev, cb) { return listen(ev, cb); },
      emit: function () { return Promise.resolve(); },
    },
    window: {
      getCurrentWindow: fakeWindow,
      getCurrent: fakeWindow,
      appWindow: fakeWindow(),
    },
    app: {
      getName: function () { return Promise.resolve("میهن کرفت"); },
      getVersion: function () { return Promise.resolve("1.0.0"); },
    },
    // پلاگینِ opener روی دسکتاپ لینک را با مرورگرِ سیستم باز می‌کند. این‌جا از Intent
    // ردش می‌کنیم (MihanExt.openExternal).
    // ⚠ قبلاً این‌جا window.open(url,"_blank") بود با این توضیح که ChromeClient آن را
    // بیرون می‌فرستد — ولی onCreateWindow و setSupportMultipleWindows هیچ‌وقت وجود نداشتند،
    // پس window.open فقط همین WebView را می‌برد به آن آدرس. صفحه‌ی پرداختِ زیبال این‌طوری
    // داخلِ خودِ اپ باز می‌شد و درگاه با «دامنه غیرمجاز» ردش می‌کرد.
    opener: {
      openUrl: function (url) {
        try {
          if (window.MihanExt && window.MihanExt.openExternal && window.MihanExt.openExternal(String(url))) {
            return Promise.resolve();
          }
          window.open(String(url), "_blank");
        } catch (e) { return Promise.reject(e); }
        return Promise.resolve();
      },
      openPath: function (p) {
        try {
          if (window.MihanExt && window.MihanExt.openExternal && window.MihanExt.openExternal(String(p))) {
            return Promise.resolve();
          }
          window.open(String(p), "_blank");
        } catch (e) { return Promise.reject(e); }
        return Promise.resolve();
      },
    },
  };

  // برخی کدها به window.__TAURI_INTERNALS__ دست می‌زنند
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || { invoke: invoke };

  window.__MIHAN_MOBILE__ = true;

  // Early BACK-button fallback: the native MihanBackCallback calls window.__mihanBack() on every
  // hardware back press. This shim loads before app.js, so during the brief window before app.js
  // installs the full layered handler, a back press should just exit the app (nothing is open yet
  // anyway). app.js overwrites window.__mihanBack with the real popup/tab-unwinding version.
  if (!window.__mihanBack) {
    window.__mihanBack = function () {
      try { if (window.MihanExt && window.MihanExt.exitApp) window.MihanExt.exitApp(); } catch (e) {}
      return false;
    };
  }
})();
