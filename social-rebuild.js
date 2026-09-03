// Social Rebuild — an isolated product surface that replaces the retired
// social presentation while preserving the launcher's working data transports.
// پول‌هایِ رابطِ کاربری وقتی لانچر مخفی است یا بازی بالاست نباید CPU/شبکه بخورند.
import { setIntervalWhenActive } from "./pro-motion-gate.js?v=1";

export function installSocialRebuild(ctx) {
  const {
    Pages, Messages, Chat, State, invoke, icon, go, toast, avatarUrl,
    wrapProRing, noteProCosmetics, styledName,
    openImageOverlay, pickImageFile, pickFile, compressImageFile, openCropEditor, onPageLeave,
    nameplatePresets, makeNameplate,
    openEditProfileDialog, startDmCall, joinDmCall, openNotificationsPrefsDialog,
    confirmDialog, openReportDialog, feedShareDialog,
    setCfg,
    getActivePage,
    getProfileTarget, setProfileTarget, getHashtagTarget, setHashtagTarget,
  } = ctx;

  // پنلِ گروه یک go(view) محلیِ خودش دارد که این را سایه می‌اندازد، پس هر جا از داخلِ
  // آن پنل بخواهیم به یک صفحه‌ی لانچر برویم (مثلِ صفحه‌ی اشتراکِ طلایی) باید از این
  // نسخه‌ی نگه‌داشته‌شده استفاده کنیم، نه از goیِ در دسترس.
  const goPage = go;

  // موقتاً برداشته‌شده تا گیتِ تعدیلِ محتوا برایِ گیف/استیکر/ایموجی مستقر شود.
  // هم‌تایِ STICKERS_ENABLED در app.js — هر دو باید با هم true شوند. هیچ کدی حذف
  // نشده: openStickerPicker و مسیرِ ارسالِ sticker دست‌نخورده‌اند.
  const STICKERS_ENABLED = false;

  const liveChatPage = Pages.chat;
  let focusComposer = false;
  let focusInboxSearch = false;
  const seenFriendRequests = new Set();
  const followedBackUsers = new Set();
  const repliedDemoNotifications = new Set();
  let demoNotificationsSeen = false;

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (key === "disabled" || key === "checked") node[key] = !!value;
      else node.setAttribute(key, value === true ? "" : String(value));
    });
    children.flat(Infinity).forEach((child) => {
      if (child == null || child === false) return;
      node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  const i = (name, size = 18) => icon(name, size);
  const call = async (command, args) => invoke(command, args);
  const clear = (node, ...children) => { node.replaceChildren(...children.filter(Boolean)); return node; };
  // در سطحِ ماژول تعریف می‌شود چون هم کامپوزرِ پست لازمش دارد و هم کامپوزرِ چت.
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("خواندنِ فایل ناموفق بود"));
    reader.readAsDataURL(blob);
  });

  // ── صدا: یک تصمیم برایِ همه‌ی ویدیوها ──
  // قبلاً هر ویدیو صدایِ خودش را داشت و با هر بار برگشتن به بخشِ اجتماعی هم صفر
  // می‌شد. حالا یک وضعیتِ مشترک است که در کانفیگِ لانچر ذخیره می‌شود.
  const _videoEls = new Set();
  let _videoMuted = !(State.cfg && State.cfg.social_video_sound === true);
  function registerVideo(v) {
    _videoEls.add(v);
    v.muted = _videoMuted;
    onPageLeave(() => _videoEls.delete(v));
  }
  function setVideoMuted(muted) {
    _videoMuted = !!muted;
    _videoEls.forEach((v) => { v.muted = _videoMuted; });
    document.querySelectorAll(".nx-post-video-wrap").forEach((w) =>
      w.classList.toggle("is-muted", _videoMuted));
    try { setCfg("social_video_sound", !_videoMuted); } catch (_) {}
  }

  // ── پنلِ قدم‌به‌قدمِ بارگذاری ──
  // آپلود از دیدِ کاربر یک جعبه‌ی سیاه بود: چند ده ثانیه هیچ‌چیز، بعد یا موفق یا
  // یک «قبول نشد»ِ بی‌توضیح. حالا هر مرحله جدا دیده می‌شود و اگر رد شد، دقیقاً
  // می‌گوید کدام بخش گیر داد، با چه نمره‌ای، و برایِ ویدیو کدام لحظه.
  const MOD_STEPS = [
    ["read", "خواندنِ فایل"],
    ["upload", "فرستادن به سرور"],
    ["scan", "بررسیِ محتوا"],
    ["done", "پایان"],
  ];
  function uploadProgress(host, opts = {}) {
    const rows = new Map();
    const list = h("div", { class: "nx-up-steps" });
    MOD_STEPS.forEach(([key, label]) => {
      const mark = h("span", { class: "nx-up-mark" });
      const note = h("small", { class: "nx-up-note" });
      const row = h("div", { class: "nx-up-step" }, mark,
        h("span", { class: "nx-up-label", text: label }), note);
      rows.set(key, { row, mark, note });
      list.appendChild(row);
    });
    const bar = h("i");
    const barWrap = h("div", { class: "nx-up-bar" }, bar);
    const timer = h("small", { class: "nx-up-timer" });
    const box = h("div", { class: "nx-up-panel" }, list, barWrap, timer);
    clear(host, box);

    const startedAt = Date.now();
    let tick = null, estimate = opts.estimate || 0;
    const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`
      .replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
    const paint = () => {
      const el = (Date.now() - startedAt) / 1000;
      timer.textContent = estimate
        ? `${fmt(el)} گذشته — تخمینِ کل حدودِ ${fmt(estimate)}`
        : `${fmt(el)} گذشته`;
      if (estimate) bar.style.width = Math.min(97, (el / estimate) * 100) + "%";
    };
    const api = {
      step(key, state, note) {
        const r = rows.get(key);
        if (!r) return;
        r.row.classList.remove("is-active", "is-done", "is-fail");
        if (state) r.row.classList.add("is-" + state);
        clear(r.mark, state === "done" ? i("check", 13)
          : state === "fail" ? i("x", 13) : h("i", { class: "nx-up-spin" }));
        r.note.textContent = note || "";
        paint();
      },
      setEstimate(sec) { estimate = sec; paint(); },
      progress(pct) { if (!estimate) bar.style.width = Math.max(0, Math.min(100, pct)) + "%"; },
      stop() { if (tick) clearInterval(tick); tick = null; },
      box,
    };
    tick = setIntervalWhenActive(paint, 250);
    onPageLeave(api.stop);
    paint();
    return api;
  }

  // خطاهایِ مسیرِ آپلود کلِ بدنه‌ی JSON را می‌آورند (نه فقط متن) تا بشود گفت کجا رد شد.
  function parseUploadError(err) {
    const raw = String(err && err.message ? err.message : err || "");
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object") return { text: j.error || raw, mod: j.moderation || null };
    } catch (_) { /* متنِ ساده */ }
    return { text: raw, mod: null };
  }

  // گزارشِ ردشدن: کدام مرحله، چه نمره‌ای، و برایِ ویدیو همان فریم را از خودِ فایل
  // می‌کِشد بیرون (سرور فریم نمی‌فرستد و لازم هم نیست — فایل دستِ خودمان است).
  /**
   * پیامِ ردِ بررسیِ محتوا. عمداً فقط همان یک جمله را نشان می‌دهد.
   *
   * قبلاً یک پنلِ تشخیصیِ کامل می‌کشید: کدام مرحله/مدل گیر داد، دسته‌ی محتوا، نمره‌ی
   * اطمینان، شماره‌ی فریم و ثانیه‌ی دقیق — و بعد با همان شماره‌ی فریم، همان لحظه‌ی
   * ویدیو را روی canvas رندر می‌کرد. یعنی محتوایی که همین حالا رد شده بود دوباره به
   * کاربر نشان داده می‌شد، و در کنارش دقیقاً گفته می‌شد چه چیزی او را گرفت و با چه
   * اطمینانی — که برای کسی که دنبالِ ردشدن از فیلتر است یک حلقه‌ی آزمون‌وخطای آماده بود.
   *
   * سرور هم دیگر آن جزئیات را نمی‌فرستد (mod_public در auth-server). این‌جا دوباره
   * محدود می‌شود تا نسخه‌ی قدیمی‌ترِ سرور یا فیلدی که بعداً اضافه شود هم چیزی لو ندهد:
   * تنها استثناء «ویدیو بلند است» است، که خبرِ محتوایی نیست و به کاربر می‌گوید چه‌قدر
   * باید کوتاهش کند.
   */
  async function moderationReport(host, info, file) {
    const mod = info.mod;
    const box = h("div", { class: "nx-modfail" },
      h("div", { class: "nx-modfail-head" }, i("warn", 17),
        h("strong", { text: info.text || "بارگذاری نشد" })));
    if (mod && mod.reason === "too_long" && mod.limit) {
      box.appendChild(h("div", { class: "nx-modfail-row" },
        h("span", { text: "سقفِ مجاز" }), h("b", { text: `${mod.limit} ثانیه` })));
      if (mod.duration) {
        box.appendChild(h("div", { class: "nx-modfail-row" },
          h("span", { text: "مدتِ این ویدیو" }), h("b", { text: `${mod.duration} ثانیه` })));
      }
    }
    clear(host, box);
    return box;
  }

  const proName = (username, label = username, className = "") => styledName
    ? styledName(username, className, "", label)
    : h("span", { class: className, text: label || username || "" });

  // حلقه/افکتِ پرو باید هر جا که آواتار هست دیده شود، نه فقط صفحه‌ی پروفایل.
  // wrapProRing برایِ کاربرِ بدونِ افکت خودِ آواتار را برمی‌گرداند، پس هزینه‌ای ندارد.
  function avatar(username, raw, size = 42, showRing = true) {
    const box = h("span", { class: "nx-avatar", style: `--nx-avatar:${size}px` });
    const src = avatarUrl(raw);
    if (!src) box.textContent = (username || "?").slice(0, 1).toUpperCase();
    else {
      const image = h("img", { src, alt: "", loading: "lazy" });
      image.addEventListener("error", () => {
        image.remove();
        box.textContent = (username || "?").slice(0, 1).toUpperCase();
        // عکس نیامد → دیگر تمام‌صفحه نشود، وگرنه کلیک یک نمایشگرِ خالی باز می‌کرد
        box.classList.remove("is-zoomable");
      });
      box.appendChild(image);
      // هر عکسِ پروفایل در هر جایِ بخشِ اجتماعی با کلیک تمام‌صفحه می‌شود.
      // stopPropagation لازم است چون آواتار معمولاً داخلِ یک ردیف/دکمه‌ی کلیک‌پذیر است.
      box.classList.add("is-zoomable");
      box.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        openImageOverlay(src, "image");
      });
    }
    return showRing && wrapProRing ? wrapProRing(box, username, size) : box;
  }

  function button(label, glyph, kind = "ghost", handler) {
    return h("button", { class: `nx-button nx-${kind}`, type: "button", onclick: handler }, glyph ? i(glyph, 17) : null, h("span", { text: label }));
  }

  function loading(label = "در حال بارگذاری…") {
    return h("div", { class: "nx-loading" }, h("span", { class: "nx-loader" }), h("span", { text: label }));
  }

  function blank(title, detail = "", glyph = "messageCircle") {
    return h("div", { class: "nx-blank" }, h("span", { class: "nx-blank-icon" }, i(glyph, 25)), h("strong", { text: title }), detail ? h("p", { text: detail }) : null);
  }

  function relativeTime(raw) {
    if (!raw) return "";
    const value = Number(raw);
    const date = new Date(value < 1e12 ? value * 1000 : value);
    if (Number.isNaN(date.getTime())) return "";
    const diff = Math.max(0, Date.now() - date.getTime());
    if (diff < 60000) return "همین الان";
    if (diff < 3600000) return `${Math.floor(diff / 60000)} دقیقه`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ساعت`;
    return new Intl.DateTimeFormat("fa-IR", { month: "short", day: "numeric" }).format(date);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  ناوبریِ برگشت — بخشِ اجتماعی هیچ راهی برایِ برگشتن نداشت؛ با بازکردنِ پروفایلِ
  //  یک نفر یا رفتن به هشتگ، تنها راه زدنِ دستیِ تب بود. این‌جا یک استکِ ساده نگه
  //  می‌داریم و دکمه‌ی برگشت فقط وقتی جایی برایِ برگشتن هست دیده می‌شود.
  // ─────────────────────────────────────────────────────────────────────────
  const _navStack = [];
  let _navGoingBack = false;
  const _snapshot = (route) => ({ route, profile: getProfileTarget(), tag: getHashtagTarget() });
  function navPush(fromRoute) {
    if (_navGoingBack) return;
    const snap = _snapshot(fromRoute);
    const top = _navStack[_navStack.length - 1];
    if (top && top.route === snap.route && top.profile === snap.profile && top.tag === snap.tag) return;
    _navStack.push(snap);
    if (_navStack.length > 30) _navStack.shift();
  }
  function navBack() {
    const prev = _navStack.pop();
    if (!prev) return;
    _navGoingBack = true;
    try {
      setProfileTarget(prev.profile || null);
      setHashtagTarget(prev.tag || null);
      go(prev.route);
    } finally {
      setTimeout(() => { _navGoingBack = false; }, 0);
    }
  }
  const navCanGoBack = () => _navStack.length > 0;

  function openUser(username) {
    if (!username) return;
    navPush(getActivePage());
    setProfileTarget(username);
    go("profile");
  }

  function openTag(tag) {
    navPush(getActivePage());
    if (!tag) return;
    setHashtagTarget(String(tag).replace(/^#/, ""));
    go("hashtag");
  }

  // \u0647\u0634\u062a\u06af/\u0645\u0646\u0634\u0646/\u0644\u06cc\u0646\u06a9\u0650 \u062e\u0648\u062f\u06a9\u0627\u0631 \u2014 \u0644\u0627\u06cc\u0647\u200c\u06cc \u067e\u0627\u06cc\u0647\u200c\u0627\u06cc \u06a9\u0647 \u0642\u0627\u0644\u0628\u200c\u0628\u0646\u062f\u06cc \u0631\u0648\u06cc \u0622\u0646 \u0633\u0648\u0627\u0631 \u0645\u06cc\u200c\u0634\u0648\u062f.
  // ── اموجیِ داخلِ متن ──
  // نقشه‌ی کاراکتر→خانه‌ی اسپرایت، تا اموجیِ پیام‌ها و پست‌ها هم همان تصاویرِ اپل
  // باشد نه فونتِ سیستم. ایندکس یک‌بار ساخته می‌شود.
  let _emojiByChar = null, _emojiLens = null;
  const buildEmojiIndex = () => {
    if (_emojiByChar || !_emojiData) return;
    _emojiByChar = new Map();
    const lens = new Set();
    _emojiData.groups.forEach(([, cells]) => cells.forEach((cell) => {
      _emojiByChar.set(cell.ch, cell);
      lens.add(cell.ch.length);
    }));
    // بلندترین اول: «👨‍👩‍👧» باید قبل از «👨» تطبیق بخورد وگرنه خانواده سه‌تکه می‌شود.
    _emojiLens = Array.from(lens).sort((a, b) => b - a);
  };
  // پیش‌بررسیِ ارزان: اگر رشته اصلاً کاراکترِ خارج از BMP یا نشانه‌ی اموجی ندارد،
  // اسکنر را اجرا نمی‌کنیم (اکثرِ پیام‌ها فارسیِ ساده‌اند).
  const MAYBE_EMOJI = /[\u203C-\u3299\uD800-\uDBFF\uFE0F\u20E3]/;
  const emojiText = (str, size = 18) => {
    const frag = document.createDocumentFragment();
    if (!str) return frag;
    buildEmojiIndex();
    if (!_emojiByChar || !MAYBE_EMOJI.test(str)) { frag.append(str); return frag; }
    let buf = "";
    for (let idx = 0; idx < str.length;) {
      let hit = null;
      for (const len of _emojiLens) {
        const cell = _emojiByChar.get(str.substr(idx, len));
        if (cell) { hit = { cell, len }; break; }
      }
      if (hit) {
        if (buf) { frag.append(buf); buf = ""; }
        frag.appendChild(emojiSprite(hit.cell, size));
        idx += hit.len;
      } else { buf += str[idx]; idx++; }
    }
    if (buf) frag.append(buf);
    return frag;
  };

  function linkify(raw) {
    const value = String(raw || "");
    const fragment = document.createDocumentFragment();
    // \u0622\u062f\u0631\u0633\u0650 \u0628\u062f\u0648\u0646\u0650 //:http \u0647\u0645 \u0644\u06cc\u0646\u06a9 \u0645\u06cc\u200c\u0634\u0648\u062f (\u06a9\u0627\u0631\u0628\u0631\u0647\u0627 \u00abmihancraft.com\u00bb \u0645\u06cc\u200c\u0646\u0648\u06cc\u0633\u0646\u062f)
    const matcher = /(#[\w\u0600-\u06ff]+)|(@[A-Za-z0-9_]{3,24})|(https?:\/\/[^\s]+|(?:www\.|(?<![\w@.])(?=[a-z0-9-]+\.[a-z]{2,12}(?:[\/?#]|\b)))[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,12}(?:[\/?#][^\s]*)?)/gi;
    const NOT_TLD = new Set(["zip", "rar", "jar", "json", "txt", "png", "jpg", "jpeg", "gif", "webp",
      "exe", "msi", "apk", "log", "cfg", "toml", "yml", "yaml", "properties", "dat", "7z", "tar", "gz",
      "mp3", "mp4", "wav", "ogg", "js", "css", "html", "py", "java", "class", "bat", "sh"]);
    let cursor = 0;
    for (const match of value.matchAll(matcher)) {
      if (match.index > cursor) fragment.appendChild(emojiText(value.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith("#")) fragment.appendChild(h("button", { class: "nx-text-link", type: "button", text: token, onclick: () => openTag(token.slice(1)) }));
      else if (token.startsWith("@")) fragment.appendChild(h("button", { class: "nx-text-link", type: "button", text: token, onclick: () => openUser(token.slice(1)) }));
      else {
        const bare = !/^https?:\/\//i.test(token);
        const ext = bare ? (token.split(/[\/?#]/)[0].split(".").pop() || "").toLowerCase() : "";
        if (bare && NOT_TLD.has(ext)) fragment.appendChild(emojiText(token));
        else fragment.appendChild(h("a", { class: "nx-text-link", href: bare ? "https://" + token : token, target: "_blank", rel: "noopener noreferrer", title: token, text: token }));
      }
      cursor = match.index + token.length;
    }
    if (cursor < value.length) fragment.appendChild(emojiText(value.slice(cursor)));
    return fragment;
  }

  // \u0642\u0627\u0644\u0628\u200c\u0628\u0646\u062f\u06cc\u0650 \u0645\u062a\u0646 \u0628\u0647 \u0633\u0628\u06a9\u0650 \u062a\u0644\u06af\u0631\u0627\u0645. \u0639\u0645\u062f\u0627\u064b \u0627\u0632 innerHTML \u0627\u0633\u062a\u0641\u0627\u062f\u0647 \u0646\u0645\u06cc\u200c\u0634\u0648\u062f \u2014 \u0647\u0631 \u062a\u06a9\u0647 \u06cc\u06a9 \u06af\u0631\u0647\u0650 \u0645\u062a\u0646\u06cc\u0650
  // \u0648\u0627\u0642\u0639\u06cc \u0627\u0633\u062a\u060c \u067e\u0633 \u0647\u06cc\u0686 \u0645\u062a\u0646\u0650 \u06a9\u0627\u0631\u0628\u0631 \u0646\u0645\u06cc\u200c\u062a\u0648\u0627\u0646\u062f \u0628\u0647 HTML \u062a\u0628\u062f\u06cc\u0644 \u0634\u0648\u062f (\u0628\u062f\u0648\u0646\u0650 \u0631\u06cc\u0633\u06a9\u0650 \u062a\u0632\u0631\u06cc\u0642).
  //   **\u067e\u0631\u0686\u0631\u0628**  __\u0627\u06cc\u062a\u0627\u0644\u06cc\u06a9__  ~~\u062e\u0637\u200c\u062e\u0648\u0631\u062f\u0647~~  `\u06a9\u062f`  ```\u0628\u0644\u0648\u06a9\u0650 \u06a9\u062f```  ||\u0627\u0633\u067e\u0648\u06cc\u0644\u0631||  [\u0645\u062a\u0646](\u0644\u06cc\u0646\u06a9)
  const FORMAT_RULES = [
    { re: /```([\s\S]+?)```/, tag: "pre", cls: "nx-fmt-pre", raw: true },
    { re: /`([^`\n]+?)`/, tag: "code", cls: "nx-fmt-code", raw: true },
    { re: /\*\*([\s\S]+?)\*\*/, tag: "strong", cls: "nx-fmt-bold" },
    { re: /__([\s\S]+?)__/, tag: "em", cls: "nx-fmt-italic" },
    { re: /~~([\s\S]+?)~~/, tag: "s", cls: "nx-fmt-strike" },
    { re: /\|\|([\s\S]+?)\|\|/, tag: "span", cls: "nx-fmt-spoiler", spoiler: true },
  ];

  // زودهنگام بارگذاری می‌شود تا اولین رندرِ فید/چت هم اموجیِ تصویری داشته باشد
  setTimeout(() => { try { loadEmojiData(); } catch (_) {} }, 0);

  function richText(raw) {
    const value = String(raw || "");
    // \u0644\u06cc\u0646\u06a9\u0650 \u0628\u0631\u0686\u0633\u0628\u200c\u062f\u0627\u0631 [\u0645\u062a\u0646](\u0622\u062f\u0631\u0633) \u0627\u0648\u0644 \u062c\u062f\u0627 \u0645\u06cc\u200c\u0634\u0648\u062f \u062a\u0627 \u067e\u0631\u0627\u0646\u062a\u0632/\u06a9\u0631\u0648\u0634\u0647 \u0628\u0627 \u0628\u0642\u06cc\u0647\u200c\u06cc \u0642\u0648\u0627\u0639\u062f \u0642\u0627\u0637\u06cc \u0646\u0634\u0648\u062f.
    const labelled = /\[([^\]\n]{1,80})\]\((https?:\/\/[^\s)]+)\)/;
    const lm = value.match(labelled);
    if (lm) {
      const fragment = document.createDocumentFragment();
      fragment.append(richText(value.slice(0, lm.index)));
      fragment.appendChild(h("a", { class: "nx-text-link", href: lm[2], target: "_blank",
        rel: "noopener noreferrer", text: lm[1] }));
      fragment.append(richText(value.slice(lm.index + lm[0].length)));
      return fragment;
    }
    let best = null;
    for (const rule of FORMAT_RULES) {
      const m = value.match(rule.re);
      if (m && (!best || m.index < best.m.index)) best = { rule, m };
    }
    if (!best) return linkify(value);
    const { rule, m } = best;
    const fragment = document.createDocumentFragment();
    fragment.append(richText(value.slice(0, m.index)));
    const inner = rule.raw
      ? document.createTextNode(m[1])            // \u062f\u0627\u062e\u0644\u0650 \u06a9\u062f \u0647\u06cc\u0686 \u0642\u0627\u0644\u0628\u200c\u0628\u0646\u062f\u06cc/\u0644\u06cc\u0646\u06a9\u06cc \u0627\u0639\u0645\u0627\u0644 \u0646\u0645\u06cc\u200c\u0634\u0648\u062f
      : richText(m[1]);
    const node = h(rule.tag, { class: rule.cls });
    node.appendChild(inner);
    if (rule.spoiler) {
      // \u0627\u0633\u067e\u0648\u06cc\u0644\u0631: \u0628\u0627 \u06cc\u06a9 \u06a9\u0644\u06cc\u06a9 \u0628\u0627\u0632 \u0645\u06cc\u200c\u0634\u0648\u062f (\u0645\u062b\u0644\u0650 \u062a\u0644\u06af\u0631\u0627\u0645) \u0648 \u062f\u06cc\u06af\u0631 \u0628\u0633\u062a\u0647 \u0646\u0645\u06cc\u200c\u0634\u0648\u062f.
      node.setAttribute("role", "button");
      node.setAttribute("tabindex", "0");
      node.title = "\u0628\u0631\u0627\u06cc\u0650 \u062f\u06cc\u062f\u0646 \u0628\u0632\u0646";
      const reveal = () => node.classList.add("is-open");
      node.addEventListener("click", reveal);
      node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") reveal(); });
    }
    fragment.appendChild(node);
    fragment.append(richText(value.slice(m.index + m[0].length)));
    return fragment;
  }

  async function createPost() {
    const info = await call("chat_info").catch(() => null);
    if (!info || !info.logged_in) return toast("برای ساختِ پست اول وارد حسابت شو.", "error");
    const scrim = h("div", { class: "nx-pop-scrim" });
    const body = h("div", { class: "nx-newpost-body" }, loading());
    const panel = h("section", { class: "nx-newpost", role: "dialog", "aria-modal": "true",
      "aria-label": "پستِ تازه" },
      h("header", { class: "nx-newpost-head" },
        h("strong", { text: "پستِ تازه" }),
        h("button", { class: "nx-gm-close", type: "button", title: "بستن", "aria-label": "بستن",
          onclick: () => close() }, i("x", 17))),
      body);
    const close = () => {
      document.removeEventListener("keydown", onKey);
      scrim.remove(); panel.remove();
      if (window.__restackScrims) window.__restackScrims();
    };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    scrim.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.append(scrim, panel);
    if (window.__restackScrims) window.__restackScrims();   // تیرگیِ پرده دو برابر نشود
    // بنرِ سهمیه‌ی روزانه برداشته شد — کاربر نمی‌خواهد هر بار یادآوری شود.
    focusComposer = true;
    const onPublished = () => { close(); if (getActivePage() === "feed") go("feed"); };
    clear(body,
      composer(info, null, onPublished));
  }

  function notificationsControl(info, options = {}) {
    const persistent = options.persistent === true;
    const badge = h("b", { class: "nx-notifications-badge", text: "" });
    const trigger = h("button", { class: "nx-icon-button nx-notifications-trigger", type: "button", title: "اعلان‌ها", "aria-label": "اعلان‌ها" }, i("bell", 19), badge);
    const popover = h("section", { class: "nx-notifications-popover", hidden: true });
    const wrap = h("div", { class: "nx-notifications-menu" }, trigger, popover);
    const labels = { follow: "دنبالت کرد", like: "پستت را پسندید", comment: "برای پستت کامنت گذاشت", mention: "در یک پست منشنت کرد" };
    // تبِ اعلان‌ها با آیکون نشان داده می‌شود (پنج برچسبِ متنی نوار را می‌شکست)؛
    // نامِ بخش موقعِ فعال‌بودن و در tooltip دیده می‌شود.
    const tabs = [["all", "همه", "bell"], ["requests", "درخواست‌ها", "userPlus"],
                  ["follow", "فالوها", "users"]];
    // اعلانِ لایک و کامنت از پنل برداشته شده. فیلتر سرِ منبع (هنگامِ ساختِ notices) اعمال
    // می‌شود تا شمارنده‌ی نشان، تبِ «همه» و تعدادِ هر تب همگی خودبه‌خود هماهنگ بمانند؛
    // رندرِ خودِ این دو نوع (از جمله جعبه‌ی پاسخ به کامنت) دست‌نخورده مانده تا اگر بعداً
    // برگشتند، فقط همین مجموعه خالی شود.
    const HIDDEN_NOTICE_TYPES = new Set(["like", "comment"]);
    const normalizeType = (raw) => {
      const type = String(raw || "").toLowerCase();
      if (type.includes("follow")) return "follow";
      if (type.includes("like")) return "like";
      if (type.includes("comment")) return "comment";
      if (type.includes("mention")) return "mention";
      return type || "other";
    };
    let active = "all";
    let incoming = [];
    let notices = [];
    const eventTimestamp = (item) => {
      const raw = item && (item.created_at ?? item.requested_at ?? item.sent_at ?? item.timestamp ?? item.updated_at);
      if (raw == null || raw === "") return 0;
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
      const parsed = Date.parse(String(raw));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    // ⚠️ seenFriendRequests فقط در حافظه بود، پس ۵۰ درخواستِ دوستیِ در انتظار با هر
    // بار باز شدنِ لانچر دوباره شمرده می‌شدند و عدد هیچ‌وقت پاک نمی‌شد. حالا زمانِ
    // آخرین دیدن در کانفیگِ لانچر ذخیره می‌شود و فقط چیزهایِ تازه‌تر شمرده می‌شوند.
    const seenAt = () => Number((State.cfg && State.cfg.notif_seen_at) || 0);
    const isNew = (item) => {
      const ts = eventTimestamp(item);
      return !ts || ts > seenAt() * 1000;
    };
    const unreadCount = () =>
      incoming.filter((user) => !seenFriendRequests.has(user.username) && isNew(user)).length
      + notices.filter((notice) => !notice.read && isNew(notice)).length;
    const syncBadge = () => {
      const count = unreadCount();
      badge.textContent = count > 99 ? "99+" : count ? String(count) : "";
      badge.hidden = !count;
      trigger.classList.toggle("has-notifications", !!count);
    };
    const respond = async (user, accept) => {
      try {
        await call("friend_respond", { username: user.username, accept });
        toast(accept ? "درخواست پذیرفته شد" : "درخواست رد شد", "success");
        await load(false);
      } catch (error) { toast(String(error), "error"); }
    };
    const requestItem = (user) => h("div", { class: "nx-request-row nx-notification-request" }, avatar(user.username, user.avatar, 41),
      h("span", { class: "nx-row-copy" }, h("strong", { text: user.username }),
        h("small", { text: `درخواست دوستی${eventTimestamp(user) ? ` · ${relativeTime(eventTimestamp(user))}` : ""}` })),
      h("span", { class: "nx-request-actions" },
        h("button", { class: "nx-request-yes", type: "button", title: "قبول", "aria-label": `قبول درخواست ${user.username}`, onclick: () => respond(user, true) }, i("check", 15)),
        h("button", { class: "nx-request-no", type: "button", title: "رد", "aria-label": `رد درخواست ${user.username}`, onclick: () => respond(user, false) }, i("x", 15))));
    const followBack = async (notice) => {
      if (followedBackUsers.has(notice.username)) return;
      try {
        if (!notice.demo) await call("follow_user", { username: notice.username });
        followedBackUsers.add(notice.username);
        toast(notice.demo ? "فالو‌بک آزمایشی انجام شد" : `${notice.username} را فالو کردی`, "success");
        render();
      } catch (error) { toast("فالو‌بک انجام نشد: " + error, "error"); }
    };
    const sendCommentReply = async (notice, input) => {
      const text = input.value.trim();
      if (!text) return input.focus();
      const postId = notice.post_id ?? notice.postId;
      try {
        if (notice.demo) {
          repliedDemoNotifications.add(notice.id);
        } else {
          if (!postId) throw new Error("شناسهٔ پست در اعلان موجود نیست");
          await call("social_comment", { postId, text: `@${notice.username} ${text}` });
        }
        notice._replyOpen = false;
        toast(notice.demo ? "پاسخ آزمایشی ثبت شد" : "پاسخت زیر همان پست ارسال شد", "success");
        render();
      } catch (error) { toast("پاسخ ارسال نشد: " + error, "error"); }
    };
    const noticeItem = (notice) => {
      const row = h("div", { class: "nx-notification-row" + (notice.read ? "" : " is-unread") });
      const main = h("button", { class: "nx-notification-main", type: "button", onclick: () => notice.demo ? null : openUser(notice.username) },
        avatar(notice.username, notice.avatar, 41),
        h("span", { class: "nx-row-copy" },
          h("strong", {}, notice.username, h("span", { text: ` ${labels[notice.type] || "یک اعلان جدید برایت فرستاد"}` }), notice.demo ? h("em", { text: "نمونه" }) : null),
          notice.type === "comment" && notice.comment_text ? h("small", { text: `«${notice.comment_text}»` }) : h("small", { text: relativeTime(notice.created_at) })));
      row.appendChild(main);
      if (notice.type === "follow") {
        const followed = followedBackUsers.has(notice.username);
        row.appendChild(h("button", {
          class: "nx-notification-action" + (followed ? " is-done" : ""),
          type: "button", disabled: followed, title: followed ? "فالو شد" : "فالو‌بک", "aria-label": followed ? `${notice.username} فالو شد` : `فالو‌بک ${notice.username}`,
          onclick: () => followBack(notice),
        }, i(followed ? "check" : "userPlus", 15)));
      }
      if (notice.type === "comment") {
        const replied = notice.demo && repliedDemoNotifications.has(notice.id);
        row.appendChild(h("button", {
          class: "nx-notification-action" + (replied ? " is-done" : ""),
          type: "button", disabled: replied, title: replied ? "پاسخ داده شد" : "پاسخ", "aria-label": replied ? `به ${notice.username} پاسخ داده شد` : `پاسخ به ${notice.username}`,
          onclick: () => { notice._replyOpen = !notice._replyOpen; render(); },
        }, i(replied ? "check" : "reply", 15)));
        if (notice._replyOpen && !replied) {
          const replyInput = h("textarea", { class: "nx-notification-reply-input", placeholder: `پاسخ به ${notice.username}…`, maxlength: "500", rows: "2" });
          const resizeReply = () => {
            replyInput.style.height = "auto";
            replyInput.style.height = Math.min(124, Math.max(58, replyInput.scrollHeight)) + "px";
          };
          replyInput.addEventListener("input", resizeReply);
          const submit = h("button", { class: "nx-notification-reply-send", type: "button", title: "ارسال پاسخ", onclick: () => sendCommentReply(notice, replyInput) }, i("send", 15));
          replyInput.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendCommentReply(notice, replyInput); } });
          row.appendChild(h("div", { class: "nx-notification-reply" }, replyInput, submit));
          requestAnimationFrame(() => { resizeReply(); replyInput.focus(); });
        }
      }
      return row;
    };
    const tabCount = (id) => {
      if (id === "all") return incoming.length + notices.length;
      if (id === "requests") return incoming.length;
      return notices.filter((notice) => notice.type === id).length;
    };
    const render = () => {
      const visibleNotices = active === "all" ? notices : active === "requests" ? [] : notices.filter((notice) => notice.type === active);
      const visibleRequests = active === "all" || active === "requests" ? incoming : [];
      const total = visibleRequests.length + visibleNotices.length;
      const listContent = active === "all"
        ? [
            ...visibleNotices.map((item, order) => ({ kind: "notice", item, order, time: eventTimestamp(item) })),
            ...visibleRequests.map((item, order) => ({ kind: "request", item, order: visibleNotices.length + order, time: eventTimestamp(item) })),
          ].sort((a, b) => (b.time - a.time) || (a.order - b.order))
            .map((entry) => entry.kind === "request" ? requestItem(entry.item) : noticeItem(entry.item))
        : [visibleRequests.map(requestItem), visibleNotices.map(noticeItem)];
      clear(popover,
        h("header", { class: "nx-notifications-head" },
          h("div", {}, h("strong", { text: "اعلان‌ها" }), h("small", { text: unreadCount() ? `${unreadCount()} مورد تازه` : "همه‌چیز را دیده‌ای" })),
          h("button", {
            class: "nx-icon-button nx-notifications-settings", type: "button",
            title: "تنظیمات اعلان‌ها", "aria-label": "تنظیمات اعلان‌ها",
            onclick: (event) => { event.stopPropagation(); if (openNotificationsPrefsDialog) openNotificationsPrefsDialog(); },
          }, i("settings", 18))),
        h("nav", { class: "nx-notifications-tabs", "aria-label": "دسته‌بندی اعلان‌ها" },
          tabs.map(([id, label, glyph]) => h("button", {
            class: "nx-notifications-tab" + (active === id ? " is-active" : ""),
            type: "button", title: label, "aria-label": label,
            onclick: () => { active = id; render(); },
          }, i(glyph, 16),
             tabCount(id) ? h("b", { text: String(tabCount(id)) }) : null))),
        // نامِ بخش زیرِ تب‌ها می‌آید، نه روی خودِ تبِ فعال
        h("div", { class: "nx-notifications-section" },
          h("strong", { text: (tabs.find(([id]) => id === active) || [null, ""])[1] })),
        h("div", { class: "nx-notifications-list" },
          total
            ? listContent
            : blank("اعلانی در این بخش نیست", "اتفاق‌های تازه همین‌جا نمایش داده می‌شوند.", active === "requests" ? "userPlus" : "bell")));
    };
    const load = async (markRead = false) => {
      if (!popover.hidden) clear(popover, loading("اعلان‌ها…"));
      const [friendResult, notificationResult] = await Promise.all([
        call("friend_list").catch(() => ({ incoming: [] })),
        call("notifications_list").catch(() => ({ notifications: [] })),
      ]);
      incoming = friendResult.incoming || [];
      const notificationItems = notificationResult.notifications || notificationResult.items || (notificationResult.data && (notificationResult.data.notifications || notificationResult.data)) || [];
      const realNotices = Array.isArray(notificationItems) ? notificationItems.map((notice) => ({ ...notice, type: normalizeType(notice.type) })) : [];
      const now = Math.floor(Date.now() / 1000);
      // اعلان‌های نمونه از رابط برداشته شدند — کدشان می‌ماند و با
      // includeDemo: true برمی‌گردند، ولی دیگر پیش‌فرض نیستند.
      const demoNotices = options.includeDemo !== true ? [] : [
        { id: "demo-follow", type: "follow", username: "SinaCraft", created_at: now - 45, read: demoNotificationsSeen, demo: true },
        { id: "demo-comment-1", type: "comment", username: "NiloofarMC", comment_text: "این مپ رو خودت ساختی؟ خیلی تمیز شده!", post_id: "demo-post-1", created_at: now - 120, read: demoNotificationsSeen, demo: true },
        { id: "demo-like-1", type: "like", username: "ArminPvP", created_at: now - 210, read: demoNotificationsSeen, demo: true },
        { id: "demo-comment-2", type: "comment", username: "CreeperGirl", comment_text: "نسخهٔ این شیدر رو هم می‌گی؟", post_id: "demo-post-2", created_at: now - 340, read: demoNotificationsSeen, demo: true },
        { id: "demo-like-2", type: "like", username: "RezaBuilder", created_at: now - 460, read: demoNotificationsSeen, demo: true },
      ];
      notices = [...demoNotices, ...realNotices].filter((n) => !HIDDEN_NOTICE_TYPES.has(n.type));
      if (markRead) {
        incoming.forEach((user) => seenFriendRequests.add(user.username));
        notices = notices.map((notice) => ({ ...notice, read: true }));
        demoNotificationsSeen = true;
      }
      syncBadge();
      render();
      if (markRead) {
        call("notifications_read").catch(() => {});
        try { setCfg("notif_seen_at", Math.floor(Date.now() / 1000)); } catch (_) {}
      }
    };
    // پاپ‌آپ با position: fixed جای می‌گیرد، نه absolute داخلِ نوار — این‌طور هم
    // دقیقاً زیرِ هدر و هم‌راستایِ لبه‌ی چپِ آن می‌نشیند، و هم می‌شود ارتفاعش را
    // به فضایِ باقی‌مانده‌ی پنجره محدود کرد تا از پایین بیرون نزند.
    const placePopover = () => {
      const bar = document.querySelector(options.launcher ? ".topbar" : ".nx-bar");
      const app = document.querySelector(options.launcher ? ".main" : ".nx-app") || document.body;
      if (!bar) return;
      const br = bar.getBoundingClientRect();
      const ar = app.getBoundingClientRect();
      popover.style.position = "fixed";
      popover.style.top = Math.round(br.bottom) + "px";
      popover.style.insetInlineEnd = "auto";
      if (options.launcher) {
        const tr = trigger.getBoundingClientRect();
        const width = Math.min(390, Math.max(0, window.innerWidth - 28));
        const left = Math.max(14, Math.min(window.innerWidth - width - 14, tr.left));
        popover.style.left = Math.round(left) + "px";
      } else {
        popover.style.left = Math.round(ar.left) + "px";
      }
      popover.style.right = "auto";
      popover.style.maxHeight = Math.max(180, Math.round(window.innerHeight - br.bottom - 14)) + "px";
    };
    window.addEventListener("resize", placePopover);
    if (!persistent) onPageLeave(() => window.removeEventListener("resize", placePopover));

    trigger.addEventListener("click", async (event) => {
      event.stopPropagation(); popover.hidden = !popover.hidden;
      if (!popover.hidden) placePopover();
      trigger.classList.toggle("is-active", !popover.hidden);
      if (!popover.hidden) await load(true);
    });
    const close = (event) => { if (!wrap.contains(event.target)) { popover.hidden = true; trigger.classList.remove("is-active"); } };
    document.addEventListener("pointerdown", close, true);
    if (!persistent) onPageLeave(() => document.removeEventListener("pointerdown", close, true));
    load(false);
    return wrap;
  }

  // ── نوارِ واحدِ بخشِ اجتماعی ────────────────────────────────
  // قبلاً دو ردیفِ هدر روی هم بود (نوارِ لانچر مخفی + یک نوارِ ۷۲ پیکسلیِ تقریباً خالی که فقط
  // چهار تب و یک دکمه داشت). حالا همه‌چیز در یک ردیفِ ۵۴ پیکسلی است: عنوان، تب‌ها، جست‌وجو،
  // اعلان‌ها و کنشِ اصلی — تا ارتفاعِ بیشتری برای خودِ محتوا بماند.
  // ── فید فعلاً کنار گذاشته شده ──
  // کدش دست‌نخورده می‌ماند؛ فقط از رابط برداشته می‌شود. برایِ برگرداندن کافی است
  // این را true کنی — تب، دکمه‌ی «پستِ تازه» و مسیرها همه با همین یک کلید برمی‌گردند.
  const FEED_ENABLED = false;

  // ── پست‌های پروفایل هم فعلاً کنار گذاشته شده ──
  // همان قرارِ بالا: کدِ ساختِ کاشی‌ها، بازکردنِ پست و شمارنده دست‌نخورده می‌ماند و
  // فقط از رابط برداشته می‌شود. برایِ برگرداندن این را true کن.
  const PROFILE_POSTS_ENABLED = false;

  const SOCIAL_TABS = [
    ...(FEED_ENABLED ? [["feed", "فید", "newspaper"]] : []),
    ["social", "پیام‌ها", "messageSquare"],
    ["profile", "پروفایل", "user"],
  ];

  // جست‌وجوی سراسریِ بخشِ اجتماعی: بازیکن + هشتگ، با نتیجه‌ی زنده زیرِ همان فیلد.
  function searchControl() {
    const input = h("input", { class: "nx-search-input", type: "text", placeholder: "بازیکن یا #هشتگ…", "aria-label": "جست‌وجوی بازیکن یا هشتگ", autocomplete: "off" });
    const results = h("div", { class: "nx-search-results", hidden: true });
    const box = h("div", { class: "nx-bar-search" }, h("span", { class: "nx-search-icon" }, i("search", 16)), input, results);
    let timer = null;
    const close = () => { results.hidden = true; };
    const pick = (run) => { close(); input.value = ""; run(); };
    const row = (glyph, title, detail, run) => h("button", { class: "nx-search-row", type: "button", onclick: () => pick(run) },
      glyph, h("span", { class: "nx-row-copy" }, h("strong", { text: title }), h("small", { text: detail })));
    const render = (query, users) => {
      const tag = query.replace(/^#/, "").trim();
      clear(results,
        tag ? row(h("span", { class: "nx-search-glyph" }, i("hash", 15)), "#" + tag, "دیدنِ پست‌های این هشتگ", () => openTag(tag)) : null,
        ...users.slice(0, 6).map((user) => row(avatar(user.username, user.avatar, 30), user.username, "دیدنِ پروفایل", () => openUser(user.username))),
        users.length ? null : h("p", { class: "nx-search-empty", text: "بازیکنی با این نام پیدا نشد." }));
      results.hidden = false;
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const query = input.value.trim();
      if (!query) return close();
      timer = setTimeout(async () => {
        if (input.value.trim() !== query) return;
        const result = await call("dm_users", { q: query.replace(/^[#@]/, "") }).catch(() => null);
        render(query, (result && result.users) || []);
      }, 220);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { input.value = ""; close(); input.blur(); }
      else if (event.key === "Enter") {
        const first = results.querySelector(".nx-search-row");
        if (!results.hidden && first) first.click();
      }
    });
    input.addEventListener("focus", () => { if (results.children.length && input.value.trim()) results.hidden = false; });
    const away = (event) => { if (!box.contains(event.target)) close(); };
    document.addEventListener("pointerdown", away, true);
    onPageLeave(() => { clearTimeout(timer); document.removeEventListener("pointerdown", away, true); });
    return box;
  }

  function socialShell(root, route, info, wide = false) {
    let normalized = route === "messages" || route === "chat" ? "social"
      : (route === "hashtag" || route === "explore" ? "feed" : route);
    // با خاموش‌بودنِ فید، هر مسیرِ مربوط به آن به پیام‌ها می‌افتد.
    if (!FEED_ENABLED && normalized === "feed") normalized = "social";
    root.classList.add("nx-route");
    const shell = h("section", { class: "nx-app" + (wide ? " nx-wide" : "") });
    const stage = h("main", { class: "nx-stage" });
    const tabs = h("nav", { class: "nx-tabs", "aria-label": "بخش‌های اجتماعی" });
    const badges = new Map();
    SOCIAL_TABS.forEach(([id, label, glyph]) => {
      const badge = h("b", { class: "nx-tab-badge", hidden: true });
      badges.set(id, badge);
      tabs.appendChild(h("button", {
        class: "nx-tab" + (normalized === id ? " is-active" : ""),
        type: "button", title: label, "aria-label": label, "aria-current": normalized === id ? "page" : null,
        onclick: () => { if (id === "social") Messages.active = null; _navStack.length = 0; go(id); },
      }, i(glyph, 17), h("span", { text: label }), badge));
    });
    const backBtn = h("button", {
      class: "nx-bar-back", type: "button", title: "برگشت", "aria-label": "برگشت",
      hidden: !navCanGoBack(), onclick: () => navBack(),
    }, i("arrowRight", 17));
    // ریلِ ناوبری در حالتِ اجتماعی فقط آیکون است؛ این دکمه دوباره بازش می‌کند.
    // انتخابِ کاربر ذخیره می‌شود تا با هر بار رفتن به این بخش دوباره جمع نشود.
    const syncNav = () => {
      const open = !!(State.cfg && State.cfg.social_nav_open);
      document.body.classList.toggle("social-nav-open", open);
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      menuBtn.title = open ? "جمع کردنِ منو" : "بازکردنِ منو";
    };
    const menuBtn = h("button", {
      class: "nx-bar-menu", type: "button", "aria-label": "منو",
      onclick: () => { setCfg("social_nav_open", !(State.cfg && State.cfg.social_nav_open)); syncNav(); },
    }, i("list", 17));
    syncNav();
    const bar = h("header", { class: "nx-bar" },
      backBtn,
      menuBtn,
      h("div", { class: "nx-bar-brand" }, h("span", { class: "nx-bar-mark" }, i("users", 17)), h("strong", { text: "اجتماعی" })),
      tabs,
      h("span", { class: "nx-bar-gap" }));
    // در صفحه‌ی پروفایل جست‌وجو لازم نیست — آن‌جا داری پروفایلِ خودت را می‌بینی/می‌سازی.
    if (info && info.logged_in) {
      // Element.append مقدارِ null را به رشته‌ی «null» تبدیل می‌کند و به‌عنوان متن درج
      // می‌کند — در صفحه‌ی پروفایل کلمه‌ی null کنارِ زنگ دیده می‌شد. پس صریحاً حذفش می‌کنیم.
      if (normalized !== "profile") bar.append(searchControl());
      // «پستِ تازه» اول (فقط آیکون) و بعد زنگِ اعلان — جایشان عوض شد و متنِ دکمه رفت
      const newPostBtn = (!FEED_ENABLED || normalized === "social") ? null : h("button", {
        class: "nx-button nx-primary nx-newpost-btn", type: "button",
        title: "پستِ تازه", "aria-label": "پستِ تازه", onclick: createPost,
      }, i("plus", 18));
      bar.append(h("div", { class: "nx-bar-actions" },
        newPostBtn,
        notificationsControl(info)));
      // نشانِ پیام‌های خوانده‌نشده روی تبِ «پیام‌ها» — تا لازم نباشد برای فهمیدنِ اینکه پیامِ تازه
      // داری، حتماً واردِ آن صفحه شوی.
      if (normalized !== "social") {
        call("dm_threads").then((result) => {
          const unread = ((result && result.threads) || []).reduce((sum, thread) => sum + (Number(thread.unread) || 0), 0);
          const badge = badges.get("social");
          if (!badge || !badge.isConnected || !unread) return;
          badge.textContent = unread > 99 ? "99+" : String(unread);
          badge.hidden = false;
        }).catch(() => {});
      }
    }
    shell.append(bar, stage); root.appendChild(shell);
    return stage;
  }

  function loginRequired(stage) {
    stage.appendChild(h("section", { class: "nx-login" }, h("span", {}, i("users", 31)), h("h1", { text: "وارد جمع شو" }), h("p", { text: "پست‌ها، دوستان و گفتگوهای ماینکرفتی‌ات بعد از ورود همین‌جا منتظرت هستند." }), button("ورود یا ساخت حساب", "logIn", "primary", () => go("profiles"))));
  }

  function commentRow(comment, opts = {}) {
    return h("div", {
      class: "nx-comment" + (opts.reply ? " is-reply" : ""),
      "data-comment-id": comment.id || "",
    },
    avatar(comment.username, comment.avatar, opts.reply ? 24 : 29),
    h("div", { class: "nx-comment-body" },
      h("div", { class: "nx-comment-author-line" },
        h("button", { class: "nx-comment-user", type: "button", text: comment.username, onclick: () => openUser(comment.username) }),
        comment.created_at ? h("time", { text: relativeTime(comment.created_at) }) : null),
      opts.replyToUsername ? h("div", { class: "nx-comment-relation" },
        i("reply", 11),
        h("span", { text: "در پاسخ به" }),
        h("button", {
          type: "button",
          text: `@${opts.replyToUsername}`,
          onclick: () => openUser(opts.replyToUsername),
        })) : null,
      h("p", { class: "nx-comment-copy" }, richText(comment.text)),
      opts.onReply ? h("div", { class: "nx-comment-meta" },
        h("button", {
          class: "nx-comment-reply-btn",
          type: "button",
          text: "پاسخ",
          onclick: (event) => opts.onReply(comment, event.currentTarget, event.currentTarget.closest(".nx-comment")),
        })) : null));
  }

  // بازکردنِ خودِ پست (متن، عکس، لایک، کامنت‌ها) — قبلاً کلیک روی پستِ پروفایل فقط
  // عکس را تمام‌صفحه می‌کرد و پستِ متنی اصلاً هیچ واکنشی نداشت.
  // کاشیِ پست یک <button> است، پس کشیدن رویِ متن به کلیک ختم می‌شد و به‌جایِ انتخابِ
  // متن، پنجره‌ی پست باز می‌شد (حبابِ کپی هم می‌رفت رویِ همان پنجره). اگر کاربر واقعاً
  // چیزی انتخاب کرده، کلیک را نادیده می‌گیریم.
  // سقفِ سراسریِ مدتِ ویدیو: هیچ ویدیوی بلندتر از ۱ دقیقه در هیچ جایِ لانچر
  // آپلود نمی‌شود. مدت را از خودِ فایل می‌خوانیم (بدونِ آپلود کردن).
  const MAX_VIDEO_SECONDS = 60;
  function videoDurationOf(file) {
    return new Promise((resolve) => {
      let url = null;
      try { url = URL.createObjectURL(file); } catch (_) { return resolve(null); }
      const v = document.createElement("video");
      v.preload = "metadata";
      const done = (val) => { try { URL.revokeObjectURL(url); } catch (_) {} resolve(val); };
      v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
      v.onerror = () => done(null);
      setTimeout(() => done(null), 6000);   // متادیتا نیامد → جلوی کاربر را نگیر
      v.src = url;
    });
  }
  async function videoTooLong(file) {
    const dur = await videoDurationOf(file);
    if (dur != null && dur > MAX_VIDEO_SECONDS + 0.5) {
      toast(`ویدیو نباید بلندتر از ۱ دقیقه باشد (این ${Math.round(dur)} ثانیه است).`, "error");
      return true;
    }
    return false;
  }

  // اموجی‌ها به‌صورتِ تصویرِ اپل کشیده می‌شوند، نه با فونتِ سیستم: ویندوز فونتِ
  // Apple Color Emoji ندارد و شکلِ تختِ Segoe را نشان می‌داد. یک اسپرایتِ واحد
  // (۶۱×۶۲ خانه) + یک نقشه‌ی ۲۴ کیلوبایتی، به‌جایِ ۱۹۰۰ فایلِ جدا.
  const EMOJI_SHEET = "assets/emoji/apple-emoji.png";
  let _emojiData = null, _emojiLoading = null;
  const loadEmojiData = () => {
    if (_emojiData) return Promise.resolve(_emojiData);
    if (!_emojiLoading) {
      _emojiLoading = fetch("assets/emoji/apple-emoji.json")
        .then((r) => r.json())
        .then((raw) => {
          // فرمتِ فشرده: هر گروه یک رشته‌ی «کاراکتر,x,y|…» است تا JSON کوچک بماند.
          const groups = raw.cats.map(([label, blob]) => [label, blob.split("|").map((cell) => {
            const at = cell.lastIndexOf(",");
            const at2 = cell.lastIndexOf(",", at - 1);
            return { ch: cell.slice(0, at2), x: +cell.slice(at2 + 1, at), y: +cell.slice(at + 1) };
          })]);
          _emojiData = { cols: raw.cols, rows: raw.rows, groups };
          return _emojiData;
        })
        .catch(() => { _emojiData = { cols: 1, rows: 1, groups: [] }; return _emojiData; });
    }
    return _emojiLoading;
  };
  // یک خانه‌ی اسپرایت. background-size بر حسبِ درصد است تا مستقل از اندازه‌ی نمایش
  // درست بیفتد؛ position هم درصدیِ (n / (تعداد-۱)) که فرمولِ استانداردِ شیت است.
  const emojiSprite = (cell, size = 24) => {
    const data = _emojiData || { cols: 1, rows: 1 };
    const px = (data.cols - 1) ? (cell.x / (data.cols - 1)) * 100 : 0;
    const py = (data.rows - 1) ? (cell.y / (data.rows - 1)) * 100 : 0;
    return h("span", {
      class: "nx-emoji-img", role: "img", "aria-label": cell.ch, title: cell.ch,
      style: `width:${size}px;height:${size}px;`
        + `background-image:url("${EMOJI_SHEET}");`
        + `background-size:${data.cols * 100}% ${data.rows * 100}%;`
        + `background-position:${px}% ${py}%;`,
    });
  };

  const swallowedBySelection = (el) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !String(sel).trim()) return false;
    const node = sel.anchorNode;
    const host = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(host && el.contains(host));
  };

  // siblings: اگر داده شود، پنجره مثلِ فید می‌شود — از همان پستِ کلیک‌شده شروع
  // و می‌شود در همان‌جا بین بقیه‌ی پست‌ها اسکرول کرد (خواسته‌ی «کشف مثلِ فید»).
  // opts.fullPage: به‌جایِ پاپ‌آپِ شناور، یک صفحه‌ی تمام‌قد با دکمه‌ی برگشت باز می‌شود
  // (خواسته‌ی کاربر برایِ پست‌هایِ پروفایل — پاپ‌آپ برایِ اسکرولِ طولانی بد بود).
  function openPostDetail(post, siblings, opts = {}) {
    const markViewed = (p) => {
      if (p && p.id && !p.demo) call("post_view", { postId: p.id }).catch(() => {});
    };
    markViewed(post);
    const fullPage = !!opts.fullPage;
    const scrim = fullPage ? null : h("div", { class: "nx-pop-scrim" });
    const list = Array.isArray(siblings) && siblings.length ? siblings : [post];
    const startIndex = Math.max(0, list.indexOf(post));
    const feed = h("div", { class: "nx-post-detail-feed" });
    const cards = list.map((p) => {
      const card = postCard(p);
      card.dataset.postId = String(p.id || "");
      feed.appendChild(card);
      return card;
    });
    // بازدیدِ پست‌هایی که حینِ اسکرول واقعاً دیده می‌شوند هم ثبت شود
    if (cards.length > 1 && "IntersectionObserver" in window) {
      const seen = new Set([startIndex]);
      const io = new IntersectionObserver((ents) => {
        ents.forEach((en) => {
          if (!en.isIntersecting) return;
          const idx = cards.indexOf(en.target);
          if (idx < 0 || seen.has(idx)) return;
          seen.add(idx); markViewed(list[idx]);
        });
      }, { threshold: 0.6 });
      cards.forEach((c) => io.observe(c));
      onPageLeave(() => { try { io.disconnect(); } catch (_) {} });
    }
    const panel = h("section", { class: "nx-post-detail" + (cards.length > 1 ? " is-feed" : ""),
      role: fullPage ? "region" : "dialog", "aria-modal": fullPage ? null : "true", "aria-label": "پست" },
      h("button", { class: fullPage ? "nx-post-detail-back" : "nx-post-detail-close", type: "button",
        title: fullPage ? "برگشت" : "بستن", "aria-label": fullPage ? "برگشت" : "بستن",
        onclick: () => close() }, fullPage ? i("arrowRight", 18) : i("x", 17)),
      feed);
    if (fullPage) panel.classList.add("is-page");
    // روی همان پستی باز شود که کاربر زده، نه از اولِ فهرست
    if (startIndex > 0) setTimeout(() => {
      try { cards[startIndex].scrollIntoView({ block: "start" }); } catch (_) {}
    }, 0);
    const close = () => {
      document.removeEventListener("keydown", onKey);
      if (scrim) scrim.remove();
      panel.remove();
      if (window.__restackScrims) window.__restackScrims();
    };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    if (scrim) scrim.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    if (scrim) document.body.append(scrim, panel); else document.body.appendChild(panel);
    if (window.__restackScrims) window.__restackScrims();   // تیرگیِ پرده دو برابر نشود
    return { close };
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  پست‌هایِ نمایشی — فقط برایِ دیدنِ طراحی. هرگز به سرور نمی‌روند و با هر رفرش
  //  از نو ساخته می‌شوند. برایِ خاموش‌کردن، DEMO_POSTS را false کن.
  // ─────────────────────────────────────────────────────────────────────────
  // پست‌های نمونه هم مثل بقیه‌ی محتوای نمایشی از رابط برداشته شدند؛ کدشان
  // دست‌نخورده می‌ماند و با true‌کردنِ همین کلید برمی‌گردد.
  const DEMO_POSTS = false;
  const _demoPosts = () => {
    const now = Math.floor(Date.now() / 1000);
    const mk = (id, username, text, mins, likes, comments, extra) => Object.assign({
      id: "demo-" + id, username, avatar: null, text, image: null, video: null,
      created_at: now - mins * 60, likes, comments, liked: false, mine: false,
      sensitive: false, demo: true,
    }, extra || {});
    return [
      mk(1, "kasra_combo", "سرور جدید رو زدیم بالا 🎮 هر کی می‌خواد بیاد، آی‌پی تو کانال هست. امشب ساعت ۹ ایونت داریم! #میهن‌کرفت", 4, 128, 19, {
        demoComments: [
          { username: "amirstar2026", text: "منم هستم! رنک چی می‌گیریم؟", mins: 3 },
          { username: "mahdiar45", text: "آی‌پی رو تو دایرکت بفرست دادا", mins: 2 },
          { username: "UKUYFI", text: "ساعت ۹ دقیق؟", mins: 1 },
        ],
      }),
      mk(2, "amirstar2026", "بعد از سه هفته بالاخره خونه‌ی زیردریایی‌م تموم شد 🌊 ۴۰ هزار تا بلاک شیشه‌ای مصرف شد و دو بار هم کل سازه ترکید.", 37, 402, 64, {
        image: "assets/demo/demo-shot.jpg",
        demoComments: [
          { username: "kasra_combo", text: "این دیگه شاهکاره واقعاً 😍", mins: 30 },
          { username: "NoobSlayer", text: "چند ساعت طول کشید؟", mins: 22 },
        ],
      }),
      mk(3, "mahdiar45", "یه تیکه از گیم‌پلی دیشب — این کریپر نزدیک بود کل فارمم رو بترکونه 😅", 95, 231, 41, {
        video: "assets/demo/demo-clip.mp4",
        demoComments: [
          { username: "Freddy", text: "ری‌اکشنت عالی بود 😂", mins: 80 },
        ],
      }),
      mk(4, "UKUYFI", "یه سوال: برای فارم آهن، کدوم دیزاین رو پیشنهاد می‌دید؟ اونی که سه تا ویلیجر می‌خواد یا نسخه‌ی جدیده؟", 180, 51, 28, {
        demoComments: [
          { username: "SPID", text: "نسخه‌ی جدید خیلی بهینه‌تره", mins: 150 },
        ],
      }),
    ];
  };

  function postCard(post) {
    const card = h("article", { class: "nx-post" });
    const more = h("button", { class: "nx-icon-button", type: "button", title: post.mine ? "حذف پست" : "گزارش پست", onclick: () => {
      if (post.mine) confirmDialog("حذف پست", "این پست برای همیشه حذف شود؟", async () => {
        try { await call("social_delete", { postId: post.id }); card.remove(); toast("پست حذف شد", "success"); } catch (error) { toast("حذف نشد: " + error, "error"); }
      });
      else openReportDialog("post", post.id);
    } }, i("moreHorizontal", 19));
    card.appendChild(h("header", { class: "nx-post-head" },
      h("button", { class: "nx-post-person", type: "button", onclick: () => openUser(post.username) }, avatar(post.username, post.avatar, 44),
        h("span", {}, h("strong", { text: post.display_name || post.username }), h("small", { text: `@${post.username} · ${relativeTime(post.created_at)}` }))), more));
    if (post.text) card.appendChild(h("div", { class: "nx-post-copy" }, richText(post.text)));
    // پستِ ویدیویی: تا حالا postCard فقط <img> می‌ساخت، پس ویدیو اصلاً نمایش داده نمی‌شد.
    // avatarUrl عمداً هر مسیری که با / شروع نشود را رد می‌کند (ضدِ هاستِ مهاجم). پستِ نمایشی
    // از فایلِ محلیِ خودِ لانچر می‌خواند، پس فقط برایِ همان دور زده می‌شود — نه برایِ پستِ واقعی.
    const demoSrc = (v) => (post.demo && v ? v : avatarUrl(v));
    const videoUrl = demoSrc(post.video);
    if (videoUrl) {
      // پخش‌کننده‌ی سبکِ اینستاگرام: کنترل‌های بومیِ مرورگر حذف می‌شوند — کلیک روی خودِ
      // ویدیو پخش/توقف است و تنها دکمه، قطع و وصلِ صداست.
      const video = h("video", {
        class: "nx-post-video", src: videoUrl, playsinline: true, loop: true,
        muted: true, preload: "metadata",
        poster: post.image ? demoSrc(post.image) : null,
      });
      registerVideo(video);
      const soundBtn = h("button", { class: "nx-video-sound", type: "button",
        title: "صدا", "aria-label": "قطع و وصلِ صدا" }, i("volumeX", 16));
      const syncSound = () => {
        clear(soundBtn, i(video.muted ? "volumeX" : "volume2", 16));
        soundBtn.title = video.muted ? "روشن‌کردنِ صدا" : "قطعِ صدا";
      };
      // تصمیمِ صدا همگانی است: روی هر ویدیویی بزنی، همه‌ی ویدیوها همان می‌شوند
      // و دفعه‌ی بعد هم که به بخشِ اجتماعی برگردی همان حالت است.
      soundBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        setVideoMuted(!video.muted);
        if (!video.muted && video.paused) video.play().catch(() => {});
        document.querySelectorAll(".nx-video-sound").forEach((b) => {
          clear(b, i(_videoMuted ? "volumeX" : "volume2", 16));
          b.title = _videoMuted ? "روشن‌کردنِ صدا" : "قطعِ صدا";
        });
      });
      const playIcon = h("span", { class: "nx-video-play" }, i("play", 26));
      // آیکونِ پخش فقط وقتی معنی دارد که ویدیو ایستاده باشد (یا موس رویش برود) —
      // قبلاً حینِ اسکرول و پخشِ خودکار هم وسطِ تصویر می‌ماند.
      const syncPlay = () => {
        playIcon.classList.toggle("is-hidden", !video.paused);
        if (video.parentElement) video.parentElement.classList.toggle("is-playing", !video.paused);
      };
      video.addEventListener("play", syncPlay);
      video.addEventListener("pause", syncPlay);
      // ── نوارِ سکانس: تا حالا هیچ راهی برایِ جلو/عقب بردنِ ویدیو نبود ──
      const seek = h("input", { class: "nx-video-seek", type: "range", min: "0", max: "1000", value: "0" });
      const timeLbl = h("span", { class: "nx-video-time", text: "۰:۰۰" });
      const bar = h("div", { class: "nx-video-bar" }, seek, timeLbl);
      const fmt = (sec) => {
        if (!isFinite(sec)) return "۰:۰۰";
        const m = Math.floor(sec / 60), r = Math.floor(sec % 60);
        return `${m}:${String(r).padStart(2, "0")}`.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
      };
      let scrubbing = false;
      const paintSeek = () => seek.style.setProperty("--nx-seek", (Number(seek.value) / 10) + "%");
      video.addEventListener("timeupdate", () => {
        if (scrubbing || !video.duration) return;
        seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
        paintSeek();
        timeLbl.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
      });
      video.addEventListener("loadedmetadata", () => { timeLbl.textContent = `۰:۰۰ / ${fmt(video.duration)}`; });
      // قفل باید با *هر* تعاملی گرفته شود، نه فقط pointerdown: با یک کلیکِ ساده روی
      // نوار، timeupdate بینِ input و change مقدار را به جایِ قبلی برمی‌گرداند و
      // ویدیو عملاً به همان‌جا (یا اولش) می‌پرید.
      const lockScrub = () => { scrubbing = true; };
      seek.addEventListener("pointerdown", lockScrub);
      seek.addEventListener("keydown", lockScrub);
      seek.addEventListener("input", () => {
        scrubbing = true;
        paintSeek();
        if (!video.duration) return;
        timeLbl.textContent = `${fmt((Number(seek.value) / 1000) * video.duration)} / ${fmt(video.duration)}`;
      });
      // پرشِ به اولِ ویدیو: کلیک روی نوار، «click» را تا خودِ shell بالا می‌برد و
      // آن هندلر play/pause را می‌زد؛ ضمناً scrubbing قبل از اعمالِ زمان صفر می‌شد و
      // timeupdate بلافاصله نوار را به مقدارِ قدیمی برمی‌گرداند. حالا اول زمان
      // اعمال می‌شود، بعد قفلِ scrubbing باز می‌شود.
      // اگر منبع بدونِ پشتیبانیِ HTTP Range سرو شود، مرورگر اصلاً نمی‌تواند جابه‌جا
      // شود و currentTime را بی‌صدا صفر می‌کند — همان «می‌زنم جلو، برمی‌گردد اول».
      // در آن حالت نوار را غیرفعال می‌کنیم تا کاربر با کنترلی که کار نمی‌کند ور نرود.
      const canSeek = () => {
        if (!video.duration || !Number.isFinite(video.duration)) return false;
        const sk = video.seekable;
        return !!(sk && sk.length && sk.end(sk.length - 1) > 0.05);
      };
      // اگر سرور Range ندارد، یک‌بار کلِ فایل را می‌گیریم و به blob: تبدیل می‌کنیم؛
      // منبعِ blob همیشه کاملاً قابلِ جابه‌جایی است. سقفِ آپلود ۱ دقیقه است، پس
      // حجمش ناچیز می‌ماند. فقط یک‌بار تلاش می‌شود تا حلقه نشود.
      let blobTried = false, blobUrl = null;
      const rescueSeek = async () => {
        if (blobTried) return;
        const src = video.currentSrc || video.src || "";
        if (!/^https?:/i.test(src)) return;
        blobTried = true;
        try {
          const res = await fetch(src);
          if (!res.ok) return;
          const at = video.currentTime, wasPlaying = !video.paused;
          blobUrl = URL.createObjectURL(await res.blob());
          video.src = blobUrl;
          video.addEventListener("loadedmetadata", () => {
            if (at) { try { video.currentTime = at; } catch (_) {} }
            if (wasPlaying) video.play().catch(() => {});
            syncSeekable();
          }, { once: true });
        } catch (_) { /* آفلاین یا مسدود — نوار غیرفعال می‌ماند */ }
      };
      onPageLeave(() => { if (blobUrl) URL.revokeObjectURL(blobUrl); });
      const syncSeekable = () => {
        const ok = canSeek();
        seek.disabled = !ok;
        bar.classList.toggle("is-nosek", !ok);
        bar.title = ok ? "" : "در حالِ آماده‌سازیِ نوارِ جابه‌جایی…";
        if (!ok && video.duration && Number.isFinite(video.duration)) rescueSeek();
      };
      video.addEventListener("loadeddata", syncSeekable);
      video.addEventListener("progress", syncSeekable);
      video.addEventListener("canplay", syncSeekable);
      const commitSeek = (e) => {
        if (e) e.stopPropagation();
        if (canSeek()) {
          video.currentTime = (Number(seek.value) / 1000) * video.duration;
        }
        requestAnimationFrame(() => { scrubbing = false; });
      };
      seek.addEventListener("pointerup", commitSeek);
      seek.addEventListener("change", commitSeek);
      seek.addEventListener("click", (e) => e.stopPropagation());
      bar.addEventListener("click", (e) => e.stopPropagation());
      const shell = h("div", { class: "nx-post-video-wrap" + (_videoMuted ? " is-muted" : "") },
        video, playIcon, soundBtn, bar);
      shell.addEventListener("click", () => {
        if (video.paused) video.play().catch(() => {}); else video.pause();
      });
      // ── پخشِ خودکار حینِ اسکرول، توقف وقتی از دید بیرون رفت ──
      if ("IntersectionObserver" in window) {
        const vio = new IntersectionObserver((ents) => ents.forEach((en) => {
          if (en.isIntersecting) video.play().catch(() => {});
          else video.pause();
        }), { threshold: 0.55 });
        vio.observe(video);
        onPageLeave(() => { try { vio.disconnect(); } catch (_) {} });
      }
      syncSound(); syncPlay();
      card.appendChild(shell);
    }
    const mediaUrl = videoUrl ? null : demoSrc(post.image);
    if (mediaUrl) {
      const media = h("img", { class: "nx-post-media" + (post.sensitive ? " is-sensitive" : ""), src: mediaUrl, alt: "تصویر پست", loading: "lazy" });
      media.addEventListener("click", () => { if (media.classList.contains("is-sensitive")) media.classList.remove("is-sensitive"); else openImageOverlay(mediaUrl); });
      card.appendChild(media);
    }

    const comments = h("section", { class: "nx-comments", hidden: true });
    const commentList = h("div", { class: "nx-comment-list" });
    const input = h("input", { class: "nx-comment-input", placeholder: "دیدگاهت را بنویس…", maxlength: "500" });
    const count = h("span", { text: String(post.comments || 0) });
    const replyContextName = h("strong");
    const replyInput = h("input", { class: "nx-comment-input nx-inline-reply-input", maxlength: "500" });
    const replyComposer = h("div", { class: "nx-inline-reply", hidden: true },
      h("div", { class: "nx-comment-reply-context" },
        h("span", {}, i("reply", 13), "در پاسخ به ", replyContextName),
        h("button", { class: "nx-comment-reply-cancel", type: "button", title: "لغو پاسخ", "aria-label": "لغو پاسخ", onclick: clearReplyTarget }, i("x", 14))),
      h("div", { class: "nx-comment-form nx-inline-reply-form" },
        replyInput,
        h("button", { class: "nx-comment-send", type: "button", title: "ارسال پاسخ", "aria-label": "ارسال پاسخ", onclick: () => sendReply() }, i("send", 15))));
    const commentThreads = new Map();
    let replyTarget = null;
    let activeReplyAction = null;
    let loaded = false;
    function clearReplyTarget() {
      replyTarget = null;
      replyInput.value = "";
      replyComposer.hidden = true;
      replyComposer.remove();
      if (activeReplyAction) activeReplyAction.classList.remove("is-active");
      activeReplyAction = null;
    }
    function beginReply(comment, rootId, action, row) {
      if (!row) return;
      if (activeReplyAction) activeReplyAction.classList.remove("is-active");
      activeReplyAction = action;
      if (activeReplyAction) activeReplyAction.classList.add("is-active");
      replyTarget = { rootId, commentId: comment.id, username: comment.username };
      replyContextName.textContent = comment.username;
      replyInput.placeholder = `پاسخ به ${comment.username}…`;
      row.insertAdjacentElement("afterend", replyComposer);
      replyComposer.hidden = false;
      requestAnimationFrame(() => {
        replyComposer.scrollIntoView({ behavior: "smooth", block: "nearest" });
        replyInput.focus();
      });
    }
    function bumpCommentCount(result) {
      post.comments = typeof result.comments === "number" ? result.comments : (post.comments || 0) + 1;
      count.textContent = String(post.comments);
    }
    // یک ریشه + پاسخ‌هایش را می‌سازد؛ پاسخ‌ها مثلِ اینستاگرام تا زدنِ «نمایش پاسخ‌ها» جمع‌شده می‌مانند.
    function appendCommentThread(comment, replies) {
      const repliesBox = h("div", { class: "nx-comment-replies", hidden: true });
      const toggle = h("button", { class: "nx-comment-replies-toggle", type: "button", hidden: !replies.length });
      const appendReply = (reply) => repliesBox.appendChild(commentRow(reply, {
        reply: true,
        replyToUsername: reply.reply_to_username || comment.username,
        onReply: (selected, action, row) => beginReply(selected, comment.id, action, row),
      }));
      replies.forEach(appendReply);
      const setToggleLabel = () => {
        toggle.hidden = !replies.length;
        if (!replies.length) return;
        toggle.textContent = repliesBox.hidden ? `مشاهده ${replies.length} پاسخ` : "پنهان کردن پاسخ‌ها";
        toggle.setAttribute("aria-expanded", String(!repliesBox.hidden));
      };
      setToggleLabel();
      toggle.addEventListener("click", () => { repliesBox.hidden = !repliesBox.hidden; setToggleLabel(); });
      const row = commentRow(comment, {
        onReply: (selected, action, selectedRow) => beginReply(selected, comment.id, action, selectedRow),
      });
      const threadNode = h("div", { class: "nx-comment-thread" }, row, toggle, repliesBox);
      commentThreads.set(String(comment.id), { replies, repliesBox, appendReply, setToggleLabel });
      commentList.appendChild(threadNode);
    }
    const toggleComments = async () => {
      comments.hidden = !comments.hidden;
      if (comments.hidden && replyTarget) clearReplyTarget();
      if (comments.hidden || loaded) return;
      loaded = true; clear(commentList, loading("دیدگاه‌ها…"));
      if (post.demo) {
        const now = Math.floor(Date.now() / 1000);
        const list = (post.demoComments || []).map((c) => ({
          id: "demo-c-" + c.username, username: c.username, avatar: null,
          text: c.text, created_at: now - (c.mins || 1) * 60, mine: false, demo: true,
        }));
        clear(commentList, ...list.map((c) => {
          const thread = h("div", { class: "nx-comment-thread" });
          const row = commentRow(c, {
            // پستِ نمایشی به سرور وصل نیست، ولی رفتارش باید *دقیقاً* مثلِ پستِ واقعی
            // باشد: کادرِ پاسخ درون‌خطی زیرِ همان کامنت، نه یک پاپ‌آپ. (قبلاً
            // promptDialog باز می‌شد و در پنجره‌ی کشف همین دیده می‌شد.)
            onReply: (selected, action, selectedRow) => {
              const row2 = selectedRow || thread.firstElementChild;
              const box = h("div", { class: "nx-inline-reply nx-demo-reply" });
              const inp = h("input", { class: "nx-comment-input nx-inline-reply-input",
                placeholder: `پاسخ به ${c.username}…`, maxlength: "500" });
              const submit = () => {
                const text = inp.value.trim();
                if (!text) return;
                thread.appendChild(commentRow({
                  id: "demo-r-" + Date.now(), username: Chat.username || "you",
                  avatar: State.myAvatar || null, text,
                  created_at: Math.floor(Date.now() / 1000), demo: true,
                }, { reply: true, replyToUsername: c.username }));
                box.remove();
              };
              box.append(inp,
                h("button", { class: "nx-comment-send", type: "button", title: "ارسال پاسخ",
                  onclick: submit }, i("send", 15)),
                h("button", { class: "nx-comment-reply-cancel", type: "button", title: "لغو",
                  onclick: () => box.remove() }, i("x", 14)));
              inp.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); submit(); }
                if (e.key === "Escape") box.remove();
              });
              thread.querySelectorAll(".nx-demo-reply").forEach((n) => n.remove());
              row2.insertAdjacentElement("afterend", box);
              setTimeout(() => inp.focus(), 30);
            },
          });
          thread.appendChild(row);
          return thread;
        }));
        if (!list.length) commentList.appendChild(h("p", { class: "nx-comment-empty", text: "هنوز دیدگاهی نیست." }));
        return;
      }
      try {
        const result = await call("social_comments", { postId: post.id });
        const all = (result && result.comments) || [];
        clear(commentList);
        const byParent = new Map();
        all.filter((c) => c.parent_id).forEach((c) => {
          const parentKey = String(c.parent_id);
          if (!byParent.has(parentKey)) byParent.set(parentKey, []);
          byParent.get(parentKey).push(c);
        });
        all.filter((c) => !c.parent_id).forEach((c) => appendCommentThread(c, byParent.get(String(c.id)) || []));
        if (!commentList.children.length) commentList.appendChild(h("p", { class: "nx-muted", text: "هنوز دیدگاهی نیست." }));
      } catch (_) { clear(commentList, h("p", { class: "nx-muted", text: "دیدگاه‌ها بارگذاری نشدند." })); }
    };
    const sendComment = async () => {
      const text = input.value.trim(); if (!text) return;
      input.disabled = true;
      try {
        const result = await call("social_comment", { postId: post.id, text });
        if (result && result.comment) appendCommentThread(result.comment, []);
        bumpCommentCount(result); input.value = "";
      } catch (error) { toast("دیدگاه ثبت نشد: " + error, "error"); }
      input.disabled = false; input.focus();
    };
    const sendReply = async () => {
      const text = replyInput.value.trim();
      const target = replyTarget ? { ...replyTarget } : null;
      if (!text || !target) return;
      replyInput.disabled = true;
      try {
        const result = await call("social_comment", {
          postId: post.id,
          text,
          parentId: target.rootId,
          replyToId: target.commentId,
        });
        if (result && result.comment) {
          const thread = commentThreads.get(String(target.rootId));
          if (thread) {
            result.comment.reply_to_username = result.comment.reply_to_username || target.username;
            thread.replies.push(result.comment);
            thread.appendReply(result.comment);
            thread.repliesBox.hidden = false;
            thread.setToggleLabel();
          }
        }
        bumpCommentCount(result);
        clearReplyTarget();
      } catch (error) { toast("پاسخ ثبت نشد: " + error, "error"); }
      replyInput.disabled = false;
    };
    input.addEventListener("focus", () => { if (replyTarget) clearReplyTarget(); });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); sendComment(); } });
    replyInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); clearReplyTarget(); }
      else if (event.key === "Enter") { event.preventDefault(); sendReply(); }
    });
    comments.append(commentList,
      h("div", { class: "nx-comment-form" }, input, h("button", { class: "nx-comment-send", type: "button", title: "ارسال", "aria-label": "ارسال دیدگاه", onclick: sendComment }, i("send", 16))));

    const likeCount = h("span", { text: String(post.likes || 0) });
    const likeButton = h("button", { class: "nx-post-action" + (post.liked ? " is-liked" : ""), type: "button", onclick: async () => {
      // پستِ نمایشی idِ واقعی ندارد — لایکش فقط محلی است و به سرور نمی‌رود.
      if (post.demo) {
        post.liked = !post.liked; post.likes = (post.likes || 0) + (post.liked ? 1 : -1);
        likeButton.classList.toggle("is-liked", post.liked); likeCount.textContent = String(post.likes);
        return;
      }
      likeButton.disabled = true;
      try {
        const result = await call("social_like", { postId: post.id });
        post.liked = !!result.liked; post.likes = result.likes || 0;
        likeButton.classList.toggle("is-liked", post.liked); likeCount.textContent = String(post.likes);
      } catch (error) { toast("پسند ثبت نشد: " + error, "error"); }
      likeButton.disabled = false;
    } }, i("heart", 18), likeCount, h("span", { text: "پسند" }));
    // آمارِ پسند/بازدید فقط با راست‌کلیک رویِ خودِ قلب — خطِ آمارِ همیشگی حذف شد
    // چون هر پست را یک ردیف بلندتر می‌کرد.
    likeButton.title = "راست‌کلیک: چه کسانی پسندیده‌اند و چند بازدید";
    likeButton.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      if (post.demo) return toast("این پستِ نمایشی است.", "info");
      openLikersSheet(post.id, post.views || 0);
    });
    card.append(h("footer", { class: "nx-post-actions" }, likeButton,
      h("button", { class: "nx-post-action", type: "button", onclick: toggleComments }, i("messageCircle", 18), count, h("span", { text: "دیدگاه" })),
      h("button", { class: "nx-post-action", type: "button",
        // پستِ نمایشی id واقعی ندارد، پس به‌جایِ postId متنش فرستاده می‌شود —
        // این‌طور می‌شود کلِ مسیرِ «فرستادن» را با همین پست‌ها تست کرد.
        onclick: () => openSendSheet(post.demo
          ? { text: (post.text || "").trim() || "(پستِ نمایشی)", origin: post.username }
          : { postId: post.id, origin: post.username }) },
        i("send", 18), h("span", { text: "فرستادن" }))), comments);
    return card;
  }

  function composer(info, list, onPublished) {
    const input = h("textarea", { class: "nx-compose-input", rows: "2", maxlength: "2000", placeholder: "توی دنیای ماینکرفتت چه خبر است؟" });
    const preview = h("div", { class: "nx-compose-preview" });
    let imageData = null;
    // یک دکمه برایِ هر دو: نوعِ فایل خودش مسیر را تعیین می‌کند. عکس به برشگر
    // می‌رود و ویدیو مستقیم آپلود می‌شود.
    // سقف‌ها هم‌ترازِ اینستاگرام: عکس تا ۸ مگابایت، ویدیو تا ۶۰ ثانیه.
    // سقفِ بایتِ ویدیو ۲۰ مگابایت است چون مسیرِ آپلود JSON/base64 است — نه انتخابِ
    // سلیقه‌ای، محدودیتِ همان مسیر.
    const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
    const chooseMedia = async () => {
      const file = await pickFile("image/*,video/*");
      if (!file) return;
      const lower = (file.name || "").toLowerCase();
      const isVideo = (file.type || "").startsWith("video/") || /\.(mp4|webm|mov|mkv)$/.test(lower);
      if (isVideo) return startVideo(file);
      if (file.size > MAX_IMAGE_BYTES) {
        return toast("حجمِ عکس زیاد است (حداکثر ۸ مگابایت).", "error");
      }
      chooseImage(file);
    };

    // ویدیو: قبلاً هیچ راهی برایِ گذاشتنِ ویدیو در پست نبود — کامپوزر فقط دکمه‌ی
    // عکس داشت و سرور هم فقط image_data می‌گرفت. آپلود از همان مسیرِ chat_upload
    // می‌رود تا سقفِ حجم و بررسیِ محتوا یک‌بار و در یک جا اعمال شود.
    let videoUrl = null;
    const startVideo = async (file) => {
      if (await videoTooLong(file)) return;
      if (file.size > MAX_VIDEO_BYTES) {
        return toast("حجمِ ویدیو زیاد است (حداکثر ۲۰ مگابایت).", "error");
      }
      const prog = uploadProgress(preview);
      prog.step("read", "active");
      try {
        const dataUrl = await blobToDataUrl(file);
        prog.step("read", "done", `${(file.size / 1048576).toFixed(1)} مگابایت`);
        // تخمین از رویِ اندازه‌گیریِ واقعی: اسکنِ فریم‌به‌فریم حدودِ ۰٫۶ ثانیه به‌ازای
        // هر ثانیه ویدیو طول می‌کشد، به‌علاوه‌ی زمانِ فرستادن.
        const dur = await videoDurationOf(file).catch(() => 0);
        prog.setEstimate(Math.max(8, dur * 0.65 + file.size / 700000));
        prog.step("upload", "active");
        prog.step("scan", "active", "هر فریم جداگانه بررسی می‌شود");
        const up = await call("chat_upload", { data: dataUrl, kind: "video", name: file.name });
        prog.step("upload", "done");
        prog.step("scan", "done", "مشکلی پیدا نشد");
        prog.step("done", "done");
        prog.stop();
        videoUrl = up.url;
        imageData = null;
        // کنترلِ پیش‌فرضِ مرورگر با بقیه‌ی رابط جور نبود؛ همان پخش‌کننده‌ای که
        // در فید استفاده می‌شود این‌جا هم به کار می‌رود.
        // کنترلِ پیش‌فرضِ مرورگر با بقیه‌ی رابط جور نبود: کلیک روی خودِ تصویر
        // پخش/توقف است و آیکون فقط موقعِ ایستادن دیده می‌شود.
        const pv = h("video", { class: "nx-preview-video", src: avatarUrl(videoUrl),
          playsinline: true, loop: true, preload: "metadata" });
        registerVideo(pv);
        const pIcon = h("span", { class: "nx-video-play" }, i("play", 24));
        const pWrap = h("div", { class: "nx-preview-videowrap" }, pv, pIcon);
        const syncP = () => {
          pIcon.classList.toggle("is-hidden", !pv.paused);
          pWrap.classList.toggle("is-playing", !pv.paused);
        };
        pv.addEventListener("play", syncP);
        pv.addEventListener("pause", syncP);
        pWrap.addEventListener("click", () => {
          if (pv.paused) pv.play().catch(() => {}); else pv.pause();
        });
        syncP();
        clear(preview, pWrap,
          h("button", { class: "nx-preview-close", type: "button",
            onclick: () => { videoUrl = null; clear(preview); } }, i("x", 15)));
      } catch (error) {
        prog.stop();
        const info = parseUploadError(error);
        prog.step("upload", "done");
        // بدونِ برچسب: stage_fa نامِ مرحله/مدلی بود که محتوا را گرفت، و همان چیزی است
        // که در پنلِ جزئیات هم حذف شد. «رد شد» همه‌ی چیزی است که کاربر لازم دارد بداند.
        prog.step("scan", "fail", "");
        await moderationReport(preview, info, file);
      }
    };

    // قبلاً عکس بدونِ برش آپلود می‌شد و فقط با object-fit «بریده به‌نظر می‌رسید»؛
    // یعنی فایلِ ذخیره‌شده کاملِ عکس بود. حالا خروجیِ خودِ برشگر آپلود می‌شود.
    const chooseImage = (preFile) => {
      openCropEditor({
        file: preFile || null,
        title: "برشِ تصویرِ پست", aspectW: 4, aspectH: 5, outW: 1080, outH: 1350,
        pickFirst: true,
        onDone: (dataUrl) => {
          imageData = dataUrl;
          videoUrl = null;
          clear(preview, h("img", { src: imageData, alt: "پیش‌نمایش" }),
            h("button", { class: "nx-preview-close", type: "button",
              onclick: () => { imageData = null; clear(preview); } }, i("x", 15)));
        },
      });
    };
    const publish = button("انتشار", "send", "primary", async () => {
      const text = input.value.trim();
      // ویدیو هم مثلِ عکس به‌تنهایی کافی است — قبلاً فقط imageData دیده می‌شد و
      // پستِ ویدیوییِ بدونِ متن با پیامِ «متن یا تصویر اضافه کن» رد می‌شد.
      if (!text && !imageData && !videoUrl) {
        return toast("یک متن، عکس یا ویدیو اضافه کن.", "error");
      }
      publish.disabled = true;
      try {
        const result = await call("social_post", { text: text || null, imageData, video: videoUrl, sensitive: false });
        if (result && result.post && list) list.prepend(postCard(result.post));
        input.value = ""; imageData = null; videoUrl = null; clear(preview);
        toast("پست منتشر شد", "success");
        if (typeof onPublished === "function") onPublished();
      } catch (error) { toast("انتشار انجام نشد: " + error, "error"); }
      publish.disabled = false;
    });
    // chat_info فقط توکن/نام را دارد و avatarش خالی است؛ عکسِ واقعی از user_profile می‌آید
    // و کمی بعد می‌رسد. پس این‌جا جای‌گیر می‌گذاریم و بعداً جایش را می‌گیریم.
    const composerAvatar = h("span", { class: "nx-compose-avatar" }, avatar(info.username, info.avatar, 44));
    const box = h("section", { class: "nx-composer" }, h("div", { class: "nx-compose-main" }, composerAvatar, input), preview,
      h("div", { class: "nx-compose-tools" },
        button("عکس یا ویدیو", "image", "quiet", chooseMedia),
        h("span", { class: "nx-flex" }), publish));
    if (focusComposer) { focusComposer = false; setTimeout(() => input.focus(), 60); }
    return box;
  }

  async function feedPage(root) {
    const info = await call("chat_info").catch(() => null);
    const stage = socialShell(root, "feed", info);
    if (!info || !info.logged_in) return loginRequired(stage);
    // ستونِ کناریِ فید (پروفایل، موضوع‌های داغ، دوستانِ آنلاین) برداشته شد؛
    // فید تمام‌عرض می‌شود.
    const layout = h("div", { class: "nx-feed-layout is-solo" });
    const center = h("div", { class: "nx-feed" });
    const list = h("div", { class: "nx-feed-list" }, loading("فیدت در حال آماده شدن است…"));
    // کامپوزر از فید برداشته شد — ساختِ پست حالا صفحه‌ی خودش را دارد و فقط با
    // دکمه‌ی «پستِ تازه» باز می‌شود.
    center.append(list);
    layout.append(center); stage.appendChild(layout);



    // صفحه‌ی جدای «کشف» حذف شد؛ همه‌چیز در همین یک فید است:
    // اول پستِ کسانی که دنبال می‌کنی، بعد دکمه‌ی دیدنِ همه‌ی فعالیتِ آنها،
    // و زیرِ آن پیشنهادِ محبوب‌هایِ دیده‌نشده که با اسکرول ادامه پیدا می‌کند.
    const FOLLOW_HEAD = 3;
    let sugOffset = 0, sugBusy = false, sugDone = false;
    const seen = new Set();                    // ضدِ تکرار در همین نشست
    const sugList = h("div", { class: "nx-feed-suggested" });
    const sugFoot = h("div", { class: "nx-feed-more" });

    const addPosts = (target, posts) => {
      let added = 0;
      posts.forEach((post) => {
        const key = String(post.id);
        if (seen.has(key)) return;
        seen.add(key);
        target.appendChild(postCard(post));
        added++;
      });
      return added;
    };

    const loadMoreSuggested = async () => {
      if (sugBusy || sugDone) return;
      sugBusy = true;
      clear(sugFoot, loading("پیشنهادهای بیشتر…"));
      try {
        const more = await call("feed_home", { offset: sugOffset, followLimit: 0 });
        const posts = (more && more.suggested) || [];
        sugOffset += posts.length;
        const added = addPosts(sugList, posts);
        // کمتر از یک صفحه‌ی کامل یعنی تهِ فهرست؛ صفرِ تازه هم یعنی همه تکراری بود.
        if (posts.length < 20 || !added) sugDone = true;
        clear(sugFoot);
        if (sugDone) sugFoot.appendChild(h("p", { class: "nx-feed-end",
          text: "فعلاً همین بود — بعداً دوباره سر بزن." }));
      } catch (error) {
        clear(sugFoot, h("p", { class: "nx-feed-end", text: "پیشنهادها نیامدند: " + error }));
        sugBusy = false; return;
      }
      sugBusy = false;
    };

    try {
      const result = await call("feed_home", { offset: 0, followLimit: FOLLOW_HEAD });
      const followPosts = (result && result.following) || [];
      const suggested = (result && result.suggested) || [];
      sugOffset = suggested.length;
      clear(list);

      const followBox = h("div", { class: "nx-feed-following" });
      const nFollow = addPosts(followBox, followPosts);
      if (nFollow) {
        list.append(h("h3", { class: "nx-feed-sectitle", text: "تازه‌هایِ تو و دنبال‌کرده‌ها" }), followBox);
        list.appendChild(h("button", { class: "nx-feed-allfollow", type: "button",
          onclick: () => openFollowingFeed() },
          i("users", 16), h("span", { text: "دیدنِ همه‌ی فعالیتِ تو و دنبال‌کرده‌ها" }), i("chevronLeft", 15)));
      }

      list.append(h("h3", { class: "nx-feed-sectitle", text: "پیشنهاد برایِ تو" }), sugList, sugFoot);
      const nSug = addPosts(sugList, suggested);
      if (suggested.length < 20) sugDone = true;

      if (DEMO_POSTS) addPosts(sugList, _demoPosts());
      if (!nFollow && !nSug && !DEMO_POSTS) {
        clear(list, blank("هنوز پستی نیست", "اولین پست این جمع را تو منتشر کن.", "newspaper"));
        return;
      }

      // اسکرولِ بی‌پایان: وقتی پایانِ فهرست دیده شد، دسته‌ی بعدی می‌آید.
      if ("IntersectionObserver" in window) {
        const io2 = new IntersectionObserver((ents) => {
          if (ents.some((en) => en.isIntersecting)) loadMoreSuggested();
        }, { rootMargin: "400px" });
        io2.observe(sugFoot);
        onPageLeave(() => io2.disconnect());
      }
    } catch (error) { clear(list, blank("فید بارگذاری نشد", String(error), "warn")); }
  }

  // فهرستِ کاملِ فعالیتِ دنبال‌کرده‌ها — همان پست‌کارتِ فید، فقط بدونِ پیشنهاد.
  function openFollowingFeed() {
    const box = h("div", { class: "nx-followfeed" }, loading("فعالیتِ دنبال‌کرده‌ها…"));
    const dlg = sheetDialog("فعالیتِ دنبال‌کرده‌ها", [box], () => dlg.close());
    let before = 0, busy = false, done = false, first = true;
    const seen = new Set();
    const load = async () => {
      if (busy || done) return;
      busy = true;
      try {
        const res = await call("feed_following", { before });
        const posts = (res && res.posts) || [];
        if (first) { clear(box); first = false; }
        posts.forEach((post) => {
          if (seen.has(String(post.id))) return;
          seen.add(String(post.id));
          box.appendChild(postCard(post));
        });
        if (posts.length) before = posts[posts.length - 1].id;
        if (posts.length < 20) {
          done = true;
          box.appendChild(seen.size
            ? h("p", { class: "nx-feed-end", text: "پایانِ فهرست." })
            : blank("هنوز چیزی نیست", "کسانی که دنبال می‌کنی هنوز پستی نگذاشته‌اند.", "users"));
        }
      } catch (error) { clear(box, blank("بارگذاری نشد", String(error), "warn")); done = true; }
      busy = false;
    };
    box.addEventListener("scroll", () => {
      if (box.scrollTop + box.clientHeight > box.scrollHeight - 500) load();
    }, { passive: true });
    load();
    return dlg;
  }

  // خلاصه‌ی آخرین پیام در فهرستِ گفتگوها. سرور برایِ تماس فقط نشانه‌ی [[call:CODE]] و
  // برایِ رسانه فقط مسیرِ فایل را می‌دهد؛ بدونِ این تبدیل، کاربر در لیست همان متنِ خام
  // را می‌دید. (رابطِ قدیمی این کار را می‌کرد، این یکی نه.)
  const MEDIA_LABEL = [
    [/\.(mp4|webm|mov|m4v)$/i, "🎬 ویدیو"],
    [/\.(webm|ogg|mp3|wav|m4a)$/i, "🎤 پیامِ صوتی"],
    [/\.(png|jpe?g|gif|webp|bmp)$/i, "🖼 عکس"],
  ];
  function threadPreview(raw) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return "پیامِ خصوصی";
    if (/^\[\[call:[A-Za-z0-9]{4,24}\]\]$/.test(text)) return "📞 تماسِ صوتی";
    // مسیرِ رسانه (نه یک متنِ واقعی) — سرور متنِ پیام‌های رسانه‌ای را همان مسیر می‌گذارد
    if (/^\/?media\//i.test(text) || /^https?:\/\/\S+$/i.test(text)) {
      for (const [re, label] of MEDIA_LABEL) if (re.test(text.split(/[?#]/)[0])) return label;
      return "📎 فایل";
    }
    return text;
  }

  // این سه گفتگو pref سروری ندارند و پیش‌فرض سنجاق‌شده‌اند، پس وضعیتشان محلی خوانده می‌شود.
  const localPinFlag = (kind, target) =>
    (kind === "channel" && String(target) === "0") ? "public_chat_unpinned"
      : kind === "saved" ? "saved_unpinned"
      : null;
  const pinnedLocally = (kind, target) => {
    const key = localPinFlag(kind, target);
    return key ? !(State.cfg && State.cfg[key]) : false;
  };

  // پلاکِ پس‌زمینه‌ی ردیف. proName یک span می‌سازد که اگر کاربر پلاک داشته باشد
  // کلاسِ pro-nameplate می‌گیرد؛ اگر نداشته باشد چیزی برنمی‌گردانیم تا ردیف عادی بماند.
  // برچسبِ فارسیِ هر پلاک — برایِ انتخابگرِ گروه. (فهرستِ اصلی در app.js است؛
  // این‌جا فقط نام‌ها لازم است، نه تعریفِ رِیگ.)
  const NAMEPLATE_FA = {
    "crimson-lowrider": "ویرانم ولی میرانم", "death-skeleton": "اسکلت چایی خور",
    "hello-kitty": "هلو کیتی", "rainy-forest": "حوضِ جنگلی",
    "flower-farm": "مزرعهٔ گل", "naruto-meadow": "دشت ناروتو",
    "moonlit-sky": "آسمان مهتابی", "lantern-meadow": "دشت فانوس‌ها",
    "xp-golem-chase": "استیو روی تپه XP",
  };

  function rowNameplate(username, preset) {
    // گروه و کانال کاربرِ متناظر ندارند، پس پلاکشان صریح می‌آید و مستقیم ساخته می‌شود.
    if (preset && preset !== "none") {
      const plate = makeNameplate("", preset);
      if (plate && plate.classList && plate.classList.contains("pro-nameplate")) {
        plate.classList.add("nx-row-plate");
        plate.setAttribute("aria-hidden", "true");
        return plate;
      }
      return null;
    }
    if (!username) return null;
    const probe = proName(username, "");
    if (!probe || !probe.classList || !probe.classList.contains("pro-nameplate")) return null;
    probe.classList.add("nx-row-plate");
    probe.setAttribute("aria-hidden", "true");
    return probe;
  }

  // ⚠ این‌جا قبلاً روی موبایل، رِگِ زندهٔ ردیف با یک پوسترِ ثابت عوض می‌شد
  // (‎assets/nameplates/posters/*.png‎ با ‎object-fit: cover‎). دلیلش کارایی بود و
  // اندازه‌گیریِ ثبت‌شده‌اش این بود: فهرستِ گروه‌های عمومی، ۱۸۶ ردیف که فقط ۲ تایش
  // پلاک داشت — با پلاکِ زنده ۳۴fps و بدترین فریم ۱۳۵۵ms، با پوستر ۴۹fps و ۳۹۲ms.
  //
  // ولی پوستر «همان فریمِ اول» نبود: یک تصویرِ ۲۴۶×۵۹ بود که روی ردیفِ تا ۳۰۸px
  // کشیده و بریده می‌شد، پس چیدمان و اندازه‌ی اجزای هر طرح با دسکتاپ فرق می‌کرد.
  // خواسته‌ی صریح این است که موبایل عیناً همان چیزی را نشان دهد که دسکتاپ می‌دهد،
  // پس همان مسیرِ دسکتاپ (‎rowNameplate‎) برمی‌گردد. اگر افتِ کارایی روی فهرست‌های
  // بلند آزاردهنده شد، راهِ درستش کاهشِ تعدادِ ردیف‌های پلاک‌دار یا مجازی‌سازیِ
  // فهرست است، نه عوض‌کردنِ ظاهرِ طرح.
  function rowPlate(username, preset) {
    return rowNameplate(username, preset);
  }

  function inboxRow({ title, subtitle, username, image, glyph, badge, live, active, onclick,
                      pref, org, kind, target, menu, extraMenu, plate }) {
    const row = h("button", { class: "nx-inbox-row" + (active ? " is-active" : "")
        + (pref && pref.pinned ? " is-pinned" : "") + (pref && pref.unread ? " is-unread" : ""),
      type: "button", onclick },
      glyph ? h("span", { class: "nx-row-glyph" }, i(glyph, 20)) : avatar(username || title, image, 45),
      // نیم‌پلیت پس‌زمینه‌ی کلِ ردیف است (هم‌اندازه‌ی کادرِ انتخاب)، نه یک برچسبِ
      // کوچک کنارِ نام. برایِ همین فرزندِ مستقیمِ ردیف است و با position مطلق کلِ
      // آن را می‌پوشاند؛ عکس و متن رویش می‌نشینند.
      rowPlate(username, plate),
      h("span", { class: "nx-row-copy" },
        h("strong", { text: title }),
        h("small", { text: subtitle || "" })),
      h("span", { class: "nx-row-tail" },
        (pref && pref.pinned) || pinnedLocally(kind, target)
          ? h("i", { class: "nx-row-pin", title: "سنجاق‌شده" }, i("pin", 12)) : null,
        pref && pref.unread ? h("i", { class: "nx-row-unread", title: "خوانده‌نشده" }) : null,
        live ? h("i", { class: "nx-live" }) : null,
        badge ? h("b", { text: String(badge) }) : null));
    // منویِ سنجاق/آرشیو/خوانده‌نشده/پوشه. راست‌کلیک تنها کافی نبود — هیچ نشانه‌ای نداشت و
    // کاربر اصلاً نمی‌فهمید وجود دارد. حالا یک دکمه‌ی «…» همیشه دیده می‌شود و راست‌کلیک
    // هم به‌عنوانِ میان‌بر باقی می‌ماند.
    if (!menu && (!kind || target === undefined)) return row;
    const openMenu = menu || (() => openChatPrefMenu({
      kind, target: String(target), title, pref, folders: (org && org.folders) || [], extraMenu,
    }));
    row.addEventListener("contextmenu", (event) => { event.preventDefault(); openMenu(); });
    const more = h("button", {
      class: "nx-row-more", type: "button",
      title: "کارهایِ این گفتگو", "aria-label": `کارهایِ ${title}`,
      onclick: (event) => { event.stopPropagation(); openMenu(); },
    }, i("moreHorizontal", 16));
    // دکمه بیرونِ <button>ِ ردیف می‌نشیند (دکمه داخلِ دکمه HTMLِ نامعتبر است) ولی روی آن
    // شناور می‌شود؛ کلاسِ .nx-inbox-row عمداً روی همان دکمه‌ی قبلی می‌ماند تا CSS و
    // querySelectorهایِ موجود نشکنند.
    return h("div", { class: "nx-inbox-rowwrap" }, row, more);
  }

  // منویِ وضعیتِ یک گفتگو (شخصی — روی بقیه‌ی اعضا اثری ندارد).
  // انتخابگرِ مقصدِ فوروارد — قبلاً فقط «به همین گفتگو» ممکن بود که عملاً بی‌فایده بود.
  // «پیام‌هایِ ذخیره‌شده» از مسیرِ save_message می‌رود (دفترچه‌ی شخصی کانال نیست).
  let _forwardThreads = [];
  // message می‌تواند سه چیز باشد:
  //   • پیامِ گفتگویِ زنده/گروه → id دارد، پس forward_messageِ سرور استفاده می‌شود
  //   • پیامِ خصوصی یا یک پست → id قابلِ فوروارد ندارد، پس متنش دوباره فرستاده می‌شود
  // `origin` فقط برایِ نوشتنِ «↪ از …» در حالتِ دوم است.
  // انتخابگرِ آدم‌ها با همان اولویتِ همیشگی: دوستان ← کسانی که باهاشان پیامِ خصوصی
  // رد و بدل شده ← دنبال‌کننده‌ها ← دنبال‌شونده‌ها. جست‌وجو هم دارد.
  async function openPeoplePicker(title, onPick, excludeNames) {
    const exclude = new Set((excludeNames || []).map((n) => String(n).toLowerCase()));
    const search = h("input", { class: "nx-gm-input", placeholder: "جست‌وجوی بازیکن…" });
    const listBox = h("div", { class: "nx-userlist" }, loading("در حال بارگذاری…"));
    const dlg = sheetDialog(title, [search, listBox], () => dlg.close());
    const rowFor = (u) => {
      const b = h("button", { class: "nx-gm-row", type: "button", onclick: () => { dlg.close(); onPick(u.username); } },
        h("span", { class: "nx-gm-row-icon" }, avatar(u.username, u.avatar, 30)),
        h("span", { class: "nx-gm-row-copy" }, h("strong", { text: u.username })));
      return b;
    };
    const render = (users, emptyText) => {
      if (!users.length) return clear(listBox, h("p", { class: "nx-gm-hint", text: emptyText }));
      clear(listBox, ...users.map(rowFor));
    };
    let suggested = [];
    try {
      const [fr, dm, fo] = await Promise.all([
        call("friend_list").catch(() => null),
        call("dm_threads").catch(() => null),
        call("follow_of", { username: "" }).catch(() => null),
      ]);
      const seen = new Set();
      const push = (arr) => (arr || []).forEach((u) => {
        const n = u && u.username;
        if (!n || seen.has(n.toLowerCase()) || exclude.has(n.toLowerCase())) return;
        seen.add(n.toLowerCase());
        suggested.push({ username: n, avatar: u.avatar || null });
      });
      push(fr && fr.friends);
      push(dm && dm.threads);
      push(fo && fo.followers);
      push(fo && fo.following);
    } catch (_) {}
    render(suggested.slice(0, 30), "کسی برایِ پیشنهاد نبود — نامِ بازیکن را جست‌وجو کن.");
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (!q) return render(suggested.slice(0, 30), "کسی برایِ پیشنهاد نبود.");
      timer = setTimeout(async () => {
        try {
          const r = await call("dm_users", { q });
          const users = ((r && r.users) || []).filter((u) => !exclude.has(String(u.username).toLowerCase()));
          render(users, "بازیکنی پیدا نشد.");
        } catch (_) {}
      }, 260);
    });
    setTimeout(() => search.focus(), 60);
  }

  // فهرستِ کاربرها در یک شیت — برایِ دنبال‌کننده/دنبال‌کرده و پسندکننده‌هایِ پست.
  async function openUserListSheet(title, loader, emptyText) {
    const box = h("div", { class: "nx-userlist" }, loading("در حال بارگذاری…"));
    const dlg = sheetDialog(title, [box], () => dlg.close());
    let users = [];
    try { users = (await loader()) || []; }
    catch (error) { return clear(box, h("p", { class: "nx-gm-hint", text: "بارگذاری نشد: " + error })); }
    if (!users.length) return clear(box, h("p", { class: "nx-gm-hint", text: emptyText }));
    clear(box, ...users.map((u) => {
      const row = h("button", { class: "nx-gm-row", type: "button", onclick: () => { dlg.close(); openUser(u.username); } },
        h("span", { class: "nx-gm-row-icon" }, avatar(u.username, u.avatar, 30)),
        h("span", { class: "nx-gm-row-copy" }, h("strong", { text: u.username })),
        i("chevronLeft", 14));
      return row;
    }));
  }

  const openFollowSheet = (username, which) => openUserListSheet(
    which === "followers" ? "دنبال‌کننده‌ها" : "دنبال‌کرده‌ها",
    async () => {
      const r = await call("follow_of", { username: username || "" });
      return (r && r[which]) || [];
    },
    which === "followers" ? "هنوز کسی دنبالش نکرده." : "هنوز کسی را دنبال نکرده.");

  const openLikersSheet = (postId, views) => openUserListSheet(
    `پسندیده‌اند · ${(views || 0).toLocaleString("fa-IR")} بازدید`,
    async () => { const r = await call("post_likers", { postId }); return (r && r.users) || []; },
    "هنوز کسی این پست را نپسندیده.");

  // ── «فرستادن» یکپارچه ──────────────────────────────────────────────────
  // قبلاً دو چیز جدا بود: «فرستادن» (فقط پست، فقط DM) و «فوروارد» (فقط متن،
  // بخش‌بندی‌شده، بدون عکس و بدون جست‌وجو). حالا یک شیت است که:
  //   • عکسِ پروفایلِ همه را نشان می‌دهد (آدم، گروه، کانال)
  //   • بخش‌بندی ندارد؛ ترتیب بر اساسِ میزانِ تعاملِ خودت است
  //   • جست‌وجو دارد
  //   • می‌شود پیامِ ضمیمه نوشت
  // payload یکی از این‌هاست: { postId } یا { text } (یا هر دو).
  let _sendTargetsCache = null;
  async function buildSendTargets() {
    const out = [];
    const seen = new Set();
    const add = (t) => {
      const key = t.kind + ":" + String(t.id ?? t.username).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key); out.push(t);
    };
    const [threads, friends, follows] = await Promise.all([
      call("dm_threads").catch(() => null),
      call("friend_list").catch(() => null),
      call("follow_of", { username: "" }).catch(() => null),
    ]);
    // ── امتیازِ تعامل: هرچه بیشتر با کسی حرف زده‌ای، بالاتر ──
    // پیامِ خصوصی (تازه‌ترین اول) > دوست > کسی که دنبالت می‌کند > کسی که دنبالش می‌کنی
    // «چقدر با این آدم حرف زده‌ام» = تعدادِ پیام‌هایِ رد و بدل‌شده (t.messages از سرور).
    // تازگیِ آخرین پیام فقط تفکیک‌کننده‌ی گره‌هاست، نه معیارِ اصلی.
    ((threads && threads.threads) || []).forEach((t, idx) => add({
      kind: "dm", username: t.username, avatar: t.avatar, label: t.username,
      // حجمِ گفتگو معیارِ اصلی است؛ تازگی فقط گره‌ها را باز می‌کند
      score: 1000 + (Number(t.messages) || 0) * 100 + Math.max(0, 100 - idx),
    }));
    // ⚠️ این‌ها باید *زیرِ* هر کسی باشند که واقعاً باهاش حرف زده‌ای. قبلاً عددِ ثابتِ
    // بزرگ داشتند (۵۰۰۰/۲۰۰۰/۱۰۰۰) و بعد از اینکه امتیازِ گفتگوها به مقیاسِ «تعدادِ
    // پیام» رفت، همین‌ها بالای همه می‌نشستند — علتِ «درست ساجست نمی‌کند».
    ((friends && friends.friends) || []).forEach((f) => add({
      kind: "dm", username: f.username, avatar: f.avatar, label: f.username, score: 3,
    }));
    ((follows && follows.followers) || []).forEach((f) => add({
      kind: "dm", username: f.username, avatar: f.avatar, label: f.username, score: 2,
    }));
    ((follows && follows.following) || []).forEach((f) => add({
      kind: "dm", username: f.username, avatar: f.avatar, label: f.username, score: 1,
    }));
    // گروه‌ها و کانال‌ها در همان فهرست، با عکسِ خودشان.
    // در صفحه‌ی فید هنوز فهرستِ گروه‌ها نرسیده (سوکتِ چت تازه وصل شده)، پس اگر خالی
    // بود یک‌بار صریح می‌پرسیم — وگرنه «فرستادن» فقط آدم‌ها را نشان می‌داد.
    if (!(Chat.groups || []).length && wsLive()) {
      const fresh = await wsAsk({ t: "groups" }, "groups", null, 2500);
      if (fresh && Array.isArray(fresh.groups)) Chat.groups = fresh.groups;
    }
    (Chat.groups || []).filter((g) => g.joined).forEach((g) => {
      const ch = (g.channels || [])[0];
      if (!ch) return;
      // گروه با همان مقیاسِ «تعدادِ پیام» سنجیده می‌شود تا کنارِ گفتگوهای خصوصی
      // منصفانه مرتب شود؛ اگر سرور شمارش نداد، تعدادِ عضو تخمینِ جایگزین است.
      // my_messages = تعدادِ پیام‌هایی که خودم در این گروه داده‌ام (از سرور).
      // دقیقاً همان مقیاسِ گفتگویِ خصوصی، پس گروه و آدم منصفانه کنارِ هم مرتب می‌شوند.
      const gMsgs = Number(g.my_messages) || 0;
      add({ kind: "channel", id: ch.id, label: g.name, photo: g.photo,
            isChannel: g.kind === "channel",
            // گروه با همان واحدِ گفتگویِ خصوصی سنجیده می‌شود تا کنارِ هم منصفانه بنشینند
      score: (gMsgs ? 1000 + gMsgs * 100 : 500) + (g.members || 0) });
    });
    add({ kind: "channel", id: 0, label: "چتِ همگانی", glyph: "globe", score: 400 });
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  async function openSendSheet(payload) {
    const search = h("input", { class: "nx-gm-input nx-send-search", placeholder: "جست‌وجوی بازیکن، گروه یا کانال…" });
    const note = h("input", { class: "nx-gm-input nx-send-note", maxlength: "300",
      placeholder: "پیامِ ضمیمه (اختیاری)…" });
    const listBox = h("div", { class: "nx-send-list" }, loading("در حال بارگذاری…"));
    const dlg = sheetDialog("فرستادن به…", [search, listBox,
      h("label", { class: "nx-gm-field" }, h("span", { text: "پیامِ ضمیمه" }), note)], () => dlg.close());

    const sendTo = async (t) => {
      const extra = note.value.trim();
      try {
        if (t.kind === "dm") {
          if (payload.postId) {
            // pass postId so the DM renders the real post card, not a text blob
            await call("dm_send", { to: t.username, postId: payload.postId, text: extra || undefined });
          } else {
            const body = [payload.text, extra].filter(Boolean).join("\n");
            if (!body) return toast("چیزی برایِ فرستادن نیست.", "error");
            await call("dm_send", { to: t.username, text: body });
          }
        } else {
          const body = [payload.text || (payload.postId ? postPermalink(payload.postId) : ""), extra]
            .filter(Boolean).join("\n");
          if (!body) return toast("چیزی برایِ فرستادن نیست.", "error");
          if (!wsSend({ t: "forward_text", to: t.id, text: body, origin: payload.origin || "" })) return;
        }
        toast(`به «${t.label}» فرستاده شد.`, "success");
        dlg.close();
      } catch (error) { toast("فرستاده نشد: " + error, "error"); }
    };

    const rowFor = (t) => h("button", { class: "nx-send-row", type: "button", onclick: () => sendTo(t) },
      h("span", { class: "nx-send-av" },
        t.kind === "dm" ? avatar(t.username, t.avatar, 34)
          : (t.photo ? h("img", { class: "nx-send-photo", src: avatarUrl(t.photo), alt: "" })
             : h("span", { class: "nx-send-glyph" }, i(t.glyph || (t.isChannel ? "megaphone" : "users"), 17)))),
      h("span", { class: "nx-send-copy" }, h("strong", { text: t.label })),
      i("send", 15));

    let all = [];
    try { all = _sendTargetsCache = await buildSendTargets(); }
    catch (error) { return clear(listBox, h("p", { class: "nx-gm-hint", text: "فهرست نیامد: " + error })); }
    const render = (items, empty) => items.length
      ? clear(listBox, ...items.map(rowFor))
      : clear(listBox, h("p", { class: "nx-gm-hint", text: empty }));
    // بدونِ سقف: قبلاً slice(0,40) بود و چون هر گفتگویِ خصوصی امتیازِ ~۱۰۰۰۰ می‌گیرد،
    // چهل ردیفِ اول همه DM بودند و گروه/کانال/چتِ همگانی اصلاً دیده نمی‌شدند.
    // خودِ فهرست اسکرول دارد، پس نمایشِ کامل مشکلی ندارد.
    render(all, "کسی برایِ فرستادن نیست.");
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      const q = search.value.trim().toLowerCase();
      if (!q) return render(all, "کسی برایِ فرستادن نیست.");
      const local = all.filter((t) => String(t.label).toLowerCase().includes(q));
      render(local, "چیزی پیدا نشد — کمی صبر کن…");
      // بازیکن‌هایی که در فهرستِ تعاملِ تو نیستند از سرور می‌آیند
      timer = setTimeout(async () => {
        try {
          const r = await call("dm_users", { q });
          const extra = ((r && r.users) || [])
            .filter((u) => !all.some((t) => t.kind === "dm" && t.username.toLowerCase() === u.username.toLowerCase()))
            .map((u) => ({ kind: "dm", username: u.username, avatar: u.avatar, label: u.username, score: 0 }));
          render(local.concat(extra), "چیزی پیدا نشد.");
        } catch (_) {}
      }, 260);
    });
    setTimeout(() => search.focus(), 60);
  }

  // پستِ اشتراکی از دایرکت: خودِ پست + بقیه‌ی پست‌هایِ کشف زیرش، تا بشود ادامه داد.
  async function openSharedPost(postId) {
    // ⚠️ social_post پستِ *تازه می‌سازد* و گرفتنِ یک پست نیست — اشتباهاً صدا زدنش
    // پستِ خالی منتشر می‌کرد. پس پست را از فهرست‌هایی می‌گیریم که فقط می‌خوانند.
    let siblings = [];
    try {
      const ex = await call("feed_explore", { offset: 0 });
      siblings = (ex && ex.posts) || [];
    } catch (_) {}
    let post = siblings.find((p) => Number(p.id) === Number(postId)) || null;
    if (!post) {
      try {
        const fd = await call("social_feed", { before: null });
        const feedPosts = (fd && fd.posts) || [];
        post = feedPosts.find((p) => Number(p.id) === Number(postId)) || null;
        if (post && !siblings.length) siblings = feedPosts;
      } catch (_) {}
    }
    if (!post) return toast("پست پیدا نشد — شاید پاک شده باشد.", "error");
    const rest = siblings.filter((p) => Number(p.id) !== Number(post.id));
    openPostDetail(post, [post, ...rest]);
  }

  // لینکِ داخلیِ یک پست تا وقتی به کانال می‌رود قابلِ کلیک بماند
  const postPermalink = (id) => `[[post:${id}]]`;

  function openForwardPicker(message) {
    const canServerForward = message.serverForwardable !== false && message.id != null;
    const bodyText = (message.text || "").trim();
    const originLabel = message.from || message.username || "";
    const targets = [];
    // چتِ همگانی (کانالِ ۰) هم یک مقصدِ واقعی است
    targets.push({ id: 0, label: "چتِ همگانی", glyph: "globe" });
    (Chat.groups || []).filter((g) => g.joined).forEach((g) =>
      (g.channels || []).forEach((ch) => targets.push({
        id: ch.id,
        // نامِ کانال دیگر نشان داده نمی‌شود؛ هر گروه یک کانال دارد و این فقط شلوغی بود
        label: g.name,
        glyph: ch.type === "broadcast" ? "megaphone" : "messageCircle",
      })));
    const rows = [];
    if (canServerForward) {
      rows.push(h("button", { class: "nx-gm-row", type: "button", onclick: () => {
        if (wsSend({ t: "save_message", message: message.id })) {
          toast("در پیام‌هایِ ذخیره‌شده ثبت شد.", "success");
          dlg.close();
        }
      } },
      h("span", { class: "nx-gm-row-icon" }, i("bookmark", 16)),
      h("span", { class: "nx-gm-row-copy" }, h("strong", { text: "پیام‌هایِ ذخیره‌شده" }),
        h("small", { text: "دفترچه‌ی شخصیِ خودت" }))));
    }
    // پیامِ خصوصی از HTTPِ auth-server می‌رود نه این WebSocket، پس فوروارد به DM یعنی
    // ارسالِ دوباره‌ی همان محتوا با dm_send (با ذکرِ منبع، چون DM فیلدِ forward ندارد).
    const dmTargets = (Messages.threads || _forwardThreads || []).slice(0, 40);
    if (dmTargets.length) {
      rows.push(h("div", { class: "nx-gm-section" }, h("strong", { text: "پیام‌های خصوصی" })));
      dmTargets.forEach((t) => rows.push(h("button", { class: "nx-gm-row", type: "button", onclick: async () => {
        const body = bodyText;
        if (!body) return toast("این پیام متنی ندارد که به گفتگوی خصوصی فوروارد شود.", "error");
        try {
          await call("dm_send", { to: t.username, text: `↪ از ${originLabel}:
${body}` });
          toast(`به «${t.username}» فرستاده شد.`, "success");
          dlg.close();
        } catch (error) { toast("فوروارد نشد: " + error, "error"); }
      } },
      h("span", { class: "nx-gm-row-icon" }, i("messageSquare", 16)),
      h("span", { class: "nx-gm-row-copy" }, h("strong", { text: t.username })))));
    }
    if (targets.length) rows.push(h("div", { class: "nx-gm-section" }, h("strong", { text: "گروه‌ها و کانال‌ها" })));

    targets.forEach((t) => rows.push(h("button", { class: "nx-gm-row", type: "button", onclick: () => {
      // پست/DM idِ قابلِ فوروارد ندارند → forward_text؛ پیامِ خودِ گفتگو → forward_message
      if (!canServerForward) {
        if (!bodyText) return toast("این مورد متنی ندارد که فوروارد شود.", "error");
        if (wsSend({ t: "forward_text", to: t.id, text: bodyText, origin: originLabel })) {
          toast(`به «${t.label}» فرستاده شد.`, "success");
          dlg.close();
        }
        return;
      }
      if (wsSend({ t: "forward_message", message: message.id, to: t.id })) {
        toast(`به «${t.label}» فوروارد شد.`, "success");
        dlg.close();
      }
    } },
    h("span", { class: "nx-gm-row-icon" }, i(t.glyph, 16)),
    h("span", { class: "nx-gm-row-copy" }, h("strong", { text: t.label })))));
    if (!targets.length) {
      rows.push(h("p", { class: "nx-gm-hint", text: "هنوز گروه یا کانالی نداری که بشود به آن فوروارد کرد." }));
    }
    const dlg = sheetDialog("فوروارد به…", rows, () => dlg.close());
  }

  const dangerRow = (label, glyph, run) => h("button", { class: "nx-gm-row nx-gm-row-danger", type: "button", onclick: run },
    h("span", { class: "nx-gm-row-icon" }, i(glyph, 16)),
    h("span", { class: "nx-gm-row-copy" }, h("strong", { text: label })));

  // این دو ردیفِ اضافه ته منویِ استانداردِ گفتگو می‌نشینند، تا سنجاق/پوشه/آرشیوِ
  // معمولی را هم از دست ندهند.
  const openSavedMenu = (close) => dangerRow("پاک کردنِ همه‌ی ذخیره‌شده‌ها", "trash", () => {
    confirmDialog("پاک کردنِ ذخیره‌شده‌ها", "همه‌ی پیام‌هایِ ذخیره‌شده پاک شوند؟ این کار برگشت ندارد.", async () => {
      const data = await wsAsk({ t: "list_saved" }, "saved_list");
      const items = (data && data.saved) || [];
      if (!items.length) { toast("چیزی برایِ پاک کردن نیست.", "info"); return close(); }
      // سرور فقط حذفِ تکی دارد، پس یکی‌یکی فرستاده می‌شود
      items.forEach((item) => wsSend({ t: "unsave_message", id: item.id }));
      toast(`${items.length.toLocaleString("fa-IR")} مورد پاک شد.`, "success");
      close();
    });
  });

  const PIN_LIMIT_FREE = 5, PIN_LIMIT_PRO = 10;
  // سقفِ سنجاق: رایگان ۵، پرو ۱۰. سه گفتگویِ پیش‌فرضِ سنجاق‌شده هم شمرده می‌شوند،
  // وگرنه کاربر عملاً سقفِ بیشتری می‌گرفت.
  // شمارش از رویِ همان چیزی که واقعاً رندر شده. تلاشِ قبلی از model.org.prefs می‌خواند
  // ولی آن شیء با modelِ فهرست یکی نبود و همیشه خالی می‌ماند، پس سقف هیچ‌وقت فعال نمی‌شد
  // (کاربرِ رایگان تا ۷ تا هم سنجاق می‌کرد). نشانِ .nx-row-pin دقیقاً منبعِ حقیقت است.
  function currentPinCount() {
    return document.querySelectorAll(".nx-inbox-list .nx-row-pin").length;
  }
  function countPinsOk() {
    const limit = State.isPro ? PIN_LIMIT_PRO : PIN_LIMIT_FREE;
    if (currentPinCount() < limit) return true;
    toast(State.isPro
      ? `بیشتر از ${limit.toLocaleString("fa-IR")} گفتگو نمی‌توانی سنجاق کنی.`
      : `رایگان تا ${limit.toLocaleString("fa-IR")} سنجاق — با اشتراکِ طلایی تا ${PIN_LIMIT_PRO.toLocaleString("fa-IR")} تا.`, "error");
    return false;
  }

  function openChatPrefMenu({ kind, target, title, pref, folders, extraMenu }) {
    const isPublicChat = kind === "channel" && String(target) === "0";
    // این سه گفتگو پیش‌فرض سنجاق‌شده‌اند و بخشِ جدا ندارند؛ تصمیمِ صریحِ کاربر باید
    // محلی ثبت شود چون سرور «آن‌پین» را از «pref ساخته‌شده به‌خاطرِ آرشیو/پوشه» تفکیک نمی‌کند.
    const localPinKey = localPinFlag(kind, target);
    const set = (fields) => {
      if ("pinned" in fields && fields.pinned && !countPinsOk()) return;
      if (localPinKey && "pinned" in fields) setCfg(localPinKey, !fields.pinned);
      if (wsSend(Object.assign({ t: "set_chat_pref", kind, target }, fields))) dlg.close();
    };
    const p = pref || {};
    const pinnedNow = localPinKey ? !(State.cfg && State.cfg[localPinKey]) : !!p.pinned;
    const rows = [
      [pinnedNow ? "برداشتنِ سنجاق" : "سنجاق به بالا", "pin", () => set({ pinned: !pinnedNow })],
      [p.archived ? "بیرون‌آوردن از آرشیو" : "بردن به آرشیو", "archive", () => set({ archived: !p.archived })],
      [p.unread ? "علامتِ خوانده‌شده" : "علامتِ خوانده‌نشده", "check", () => set({ unread: !p.unread })],
    ].map(([label, glyph, run]) => h("button", { class: "nx-gm-row", type: "button", onclick: run },
      h("span", { class: "nx-gm-row-icon" }, i(glyph, 16)),
      h("span", { class: "nx-gm-row-copy" }, h("strong", { text: label }))));
    if (folders.length) {
      rows.push(h("div", { class: "nx-gm-section" }, h("strong", { text: "پوشه" })));
      folders.forEach((f) => rows.push(h("button", { class: "nx-gm-row", type: "button",
        onclick: () => set({ folder_id: p.folder_id === f.id ? null : f.id }) },
        h("span", { class: "nx-gm-row-icon" }, i(p.folder_id === f.id ? "check" : "folder", 16)),
        h("span", { class: "nx-gm-row-copy" }, h("strong", { text: f.name })))));
    }
    // ── حذف ──
    // چتِ همگانی (target=0) عمداً حذف ندارد؛ سرور هم ردش می‌کند.
    const isPublic = String(target) === "0";
    if (kind === "saved") {
      // حذفِ اختصاصیِ خودشان از extraMenu می‌آید
    } else if (kind === "channel" && !isPublic) {
      rows.push(dangerRow("پاک کردنِ تاریخچه", "trash", () => {
        confirmDialog("پاک کردنِ تاریخچه",
          `همه‌ی پیام‌هایِ «${title || "این گفتگو"}» برایِ همه پاک شود؟ این کار برگشت ندارد.`,
          () => { if (wsSend({ t: "clear_history", channel: Number(target) })) { toast("تاریخچه پاک شد.", "success"); dlg.close(); } });
      }));
    } else if (kind === "dm") {
      rows.push(dangerRow("پاک کردنِ گفتگو", "trash", () => {
        confirmDialog("پاک کردنِ گفتگو",
          `کلِ گفتگو با «${title || target}» فقط برایِ خودت پاک شود؟ طرفِ مقابل همچنان پیام‌ها را دارد.`,
          async () => {
            try {
              await call("dm_delete_thread", { username: String(target) });
              toast("گفتگو پاک شد.", "success");
              dlg.close();
              go("messages");
            } catch (e) { toast("پاک نشد: " + e, "error"); }
          });
      }));
    }
    // «پاک کردنِ همه‌ی ذخیره‌شده‌ها» ته همین منو می‌آید
    if (typeof extraMenu === "function") {
      const extra = extraMenu(() => dlg.close());
      (Array.isArray(extra) ? extra : [extra]).forEach((r) => r && rows.push(r));
    }
    const dlg = sheetDialog(title || "این گفتگو", rows, () => dlg.close());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  مدیریتِ گروه/کانال به سبکِ تلگرام
  //  سرور (chat-server/chat.py) همه‌ی این دستورها را دارد؛ این‌جا فقط رابطش ساخته می‌شود.
  //  همه‌ی پنجره‌ها روی document.body می‌نشینند — توکن‌های --nx-* روی :root تعریف شده‌اند
  //  تا این‌ها هم رنگ/حاشیه‌ی درست بگیرند (وگرنه شفافِ کامل می‌شوند).
  // ═══════════════════════════════════════════════════════════════════════════

  const wsLive = () => (Chat.ws && Chat.ws.readyState === 1 ? Chat.ws : null);

  const wsSend = (payload) => {
    const ws = wsLive();
    if (!ws) { toast("هنوز به سرویسِ گفتگو وصل نشده‌ای", "error"); return false; }
    ws.send(JSON.stringify(payload));
    return true;
  };

  // درخواست/پاسخ روی همان WSِ مشترک: به پیامِ نوعِ خواسته‌شده گوش می‌دهیم و اولین
  // «رشته»ی پیام = پیام‌های پشتِ‌سرِ همِ یک فرستنده. CSS نمی‌تواند نامِ فرستنده‌ی دو
  // پیامِ کنارِ هم را با هم مقایسه کند، پس قواعدِ فاصله و آواتار با
  // «:not(.is-mine) + :not(.is-mine)» نوشته شده بودند — که در گفتگوی دونفره درست
  // است ولی در چتِ همگانی یعنی پیامِ آدم‌های مختلف هم یک رشته‌ی پیوسته حساب می‌شود:
  // فاصله‌شان به ۲px می‌افتاد («پیام‌ها بهم چسبیده») و آواتارِ همه جز آخری پنهان
  // می‌شد. این‌جا رشته را از روی data-from علامت می‌زنیم تا CSS واقعیت را ببیند.
  const markMessageRuns = (list) => {
    if (!list) return;
    let prevFrom = null;
    for (const node of list.children) {
      if (!node.classList || !node.classList.contains("nx-chat-message")) { prevFrom = null; continue; }
      const from = node.dataset.from || "";
      node.classList.toggle("is-run", !!from && from === prevFrom);
      prevFrom = from;
    }
  };

  // پاسخِ مطابق را برمی‌گردانیم. خطاهایِ سرور هم همین‌جا گرفته می‌شوند تا هر صفحه
  // مجبور نباشد خودش error را هندل کند.
  const wsAsk = (payload, type, pred, ms = 5000) => new Promise((resolve) => {
    const ws = wsLive();
    if (!ws) { toast("هنوز به سرویسِ گفتگو وصل نشده‌ای", "error"); return resolve(null); }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ws.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve(value);
    };
    const onMsg = (event) => {
      let data; try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data.t === type && (!pred || pred(data))) finish(data);
      else if (data.t === "error") { toast(data.msg || "خطا", "error"); finish(null); }
    };
    const timer = setTimeout(() => finish(null), ms);
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify(payload));
  });

  const freshGroup = (id) => (Chat.groups || []).find((g) => Number(g.id) === Number(id)) || null;
  // وضعیتِ بی‌صدا روی خودِ گروه نمی‌آید؛ سرور آن را در فریمِ جدایِ chat_mutes می‌فرستد.
  const _chatMutes = new Map();          // groupId -> mutedUntil (ثانیه‌ی یونیکس)
  const isGroupMuted = (gid) => {
    const until = _chatMutes.get(Number(gid));
    return !!until && until > Math.floor(Date.now() / 1000);
  };
  const noteChatMutes = (list) => {
    _chatMutes.clear();
    (list || []).forEach((m) => {
      if (!Number(m.channel)) _chatMutes.set(Number(m.group), Number(m.until || m.muted_until || 0));
    });
  };

  // گروهِ صاحبِ یک کانال (از همان Chat.groupsِ کش‌شده) — چتِ همگانی (0) گروه ندارد.
  const _channelGroupId = (channelId) => {
    if (!channelId) return null;
    for (const group of (Chat.groups || [])) {
      if ((group.channels || []).some((c) => Number(c.id) === Number(channelId))) return group.id;
    }
    return null;
  };

  const MEMBER_PERM_LABELS = {
    send_messages: "ارسالِ پیام", send_media: "ارسالِ عکس و ویدیو و فایل",
    send_stickers: "ارسالِ گیف و استیکر", send_polls: "ساختِ نظرسنجی",
    add_users: "افزودنِ عضوِ جدید", pin_messages: "پین‌کردنِ پیام",
    change_info: "تغییرِ اطلاعاتِ گروه/کانال",
  };
  const ADMIN_PERM_LABELS = {
    kick: "اخراجِ عضو", ban: "بن‌کردنِ عضو", mute: "سکوت‌کردنِ عضو", pin: "پین‌کردنِ پیام",
    add_member: "افزودنِ عضو و تأییدِ درخواست",
    manage_invites: "مدیریتِ لینک‌هایِ دعوت", change_info: "تغییرِ اطلاعات و تنظیمات",
    delete_messages: "حذفِ پیامِ دیگران",
  };
  const ADMIN_LOG_LABELS = {
    edit_info: "تغییرِ اطلاعات", settings: "تغییرِ تنظیمات", pin: "پین‌کردنِ پیام",
    unpin: "برداشتنِ پین", transfer_owner: "واگذاریِ مالکیت", leave: "ترکِ گروه",
    approve_join: "تأییدِ عضویت", decline_join: "ردِ درخواست", revoke_invite: "ابطالِ لینکِ دعوت",
    rename_channel: "تغییرِ نامِ کانال", delete_channel: "حذفِ کانال", link_discussion: "گروهِ بحث",
  };
  const SLOW_MODE_CHOICES = [[0, "خاموش"], [10, "۱۰ ثانیه"], [30, "۳۰ ثانیه"], [60, "۱ دقیقه"],
                             [300, "۵ دقیقه"], [900, "۱۵ دقیقه"], [3600, "۱ ساعت"]];
  const AUTO_DELETE_CHOICES = [[0, "خاموش"], [86400, "۱ روز"], [604800, "۱ هفته"], [2678400, "۱ ماه"]];

  const isChannel = (group) => !!group && group.kind === "channel";
  const canManage = (group) => ["owner", "admin"].includes(group && group.role);
  const isOwner = (group) => group && group.role === "owner";
  // اختیاراتِ سفارشیِ مدیر سمتِ سرور اعمال می‌شود؛ این‌جا فقط برایِ پنهان‌کردنِ دکمه‌هاست.
  const mayDo = (group, perm) => isOwner(group) || (group && group.role === "admin");

  function openGroupManager(groupId, initialView = "main") {
    let view = initialView;
    let group = freshGroup(groupId);
    if (!group) return toast("گروه پیدا نشد.", "error");

    const body = h("div", { class: "nx-gm-body" });
    const title = h("strong", { class: "nx-gm-title", text: group.name });
    const backBtn = h("button", { class: "nx-gm-back", type: "button", title: "برگشت",
      onclick: () => go("main") }, i("arrowRight", 16));
    const panel = h("section", { class: "nx-gm-panel", role: "dialog", "aria-modal": "true",
      "aria-label": "مدیریتِ گروه" },
      h("header", { class: "nx-gm-head" }, backBtn, title,
        h("button", { class: "nx-gm-close", type: "button", title: "بستن", "aria-label": "بستن",
          onclick: () => close() }, i("x", 17))),
      body);
    const scrim = h("div", { class: "nx-pop-scrim nx-gm-scrim" });
    const close = () => {
      document.removeEventListener("keydown", onKey);
      if (Chat.ws) Chat.ws.removeEventListener("message", onPush);
      scrim.remove(); panel.remove();
      if (window.__restackScrims) window.__restackScrims();
    };
    const onKey = (event) => { if (event.key === "Escape") (view === "main" ? close() : go("main")); };
    scrim.addEventListener("click", close);
    document.addEventListener("keydown", onKey);

    // هر به‌روزرسانیِ گروه از سرور باید همین پنجره را هم تازه کند، وگرنه کاربر بعدِ یک تغییر
    // داده‌ی بیات می‌بیند و فکر می‌کند کار نکرد.
    const onPush = (event) => {
      let data; try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data.t !== "groups") return;
      const next = freshGroup(groupId);
      if (!next) return close();     // گروه حذف شد یا از آن بیرون آمدیم
      group = next;
      title.textContent = group.name;
      render();
    };
    if (Chat.ws) Chat.ws.addEventListener("message", onPush);

    const go = (next) => { view = next; render(); };

    const row = (glyph, label, detail, onclick, opts = {}) => h("button", {
      class: "nx-gm-row" + (opts.danger ? " is-danger" : ""), type: "button", onclick,
    },
    h("span", { class: "nx-gm-row-icon" }, i(glyph, 17)),
    h("span", { class: "nx-gm-row-copy" }, h("strong", { text: label }),
      detail ? h("small", { text: detail }) : null),
    opts.badge ? h("span", { class: "nx-gm-badge", text: String(opts.badge) }) : null,
    opts.chevron === false ? null : i("chevronLeft", 15));

    const toggleRow = (label, detail, checked, onchange) => {
      const box = h("input", { type: "checkbox", class: "nx-gm-check" });
      box.checked = !!checked;
      box.addEventListener("change", () => onchange(box.checked));
      return h("label", { class: "nx-gm-toggle" },
        h("span", { class: "nx-gm-row-copy" }, h("strong", { text: label }),
          detail ? h("small", { text: detail }) : null),
        box);
    };

    const choiceRow = (label, choices, current, onpick) => {
      const select = h("select", { class: "nx-gm-select" },
        ...choices.map(([value, text]) => h("option", { value: String(value), text })));
      select.value = String(current || 0);
      select.addEventListener("change", () => onpick(Number(select.value)));
      return h("label", { class: "nx-gm-field" }, h("span", { text: label }), select);
    };

    const sectionTitle = (text, note) => h("div", { class: "nx-gm-section" },
      h("strong", { text }), note ? h("small", { text: note }) : null);

    // ── نمایِ اصلی ──
    const renderMain = () => {
      const manage = canManage(group);
      const pending = group.join_requests && manage;
      clear(body,
        h("div", { class: "nx-gm-hero" },
          h("div", { class: "nx-gm-photo" }, group.photo
            ? h("img", { src: avatarUrl(group.photo), alt: group.name })
            : i(isChannel(group) ? "megaphone" : "users", 30)),
          h("div", { class: "nx-gm-hero-copy" },
            h("h3", { text: group.name }),
            h("small", { text: `${group.members || 1} عضو${group.username ? " · @" + group.username : ""}` }),
            group.about ? h("p", { class: "nx-gm-about", text: group.about }) : null)),
        h("div", { class: "nx-gm-quick" },
          button("جست‌وجو", "search", "ghost", () => go("search")),
          button("پین‌شده‌ها", "pin", "ghost", () => go("pins")),
          button("بی‌صدا", "bell", "ghost", () => go("mute")),
          group.username ? button("کپیِ لینک", "link", "ghost", () => {
            const link = `mihancraft://group/${group.username}`;
            try { navigator.clipboard.writeText(link); toast("لینکِ گروه کپی شد.", "success"); }
            catch (_) { toast(link, "info"); }
          }) : null),
        sectionTitle(isChannel(group) ? "کانال" : "گروه"),
        row("users", "اعضا", `${group.members || 1} نفر`, () => go("members")),
        // «کانالِ داخلِ گروه» حذف شد: گروه و کانال دو چیزِ جدا هستند و در عمل هم هر
        // گروه دقیقاً یک کانال داشت (۵ گروه / ۵ کانال روی سرور)، پس این لایه فقط
        // یک سطحِ ناوبریِ بی‌فایده بود.
        manage ? row("pencil", isChannel(group) ? "ویرایشِ اطلاعاتِ کانال" : "ویرایشِ اطلاعاتِ گروه", "نام، توضیحات، عکس، هندلِ عمومی", () => go("edit")) : null,
        manage ? row("sliders", "تنظیمات", "حالتِ آهسته، حذفِ خودکار، تأییدِ عضویت", () => go("settings")) : null,
        // بخشِ جدا: قبلاً تهِ صفحه‌ی تنظیمات بود و زیرنویسِ آن ردیف هم اسمی ازش نمی‌برد،
        // پس عملاً پیدا نمی‌شد.
        manage ? row("palette", "افکتِ پشتِ کادر",
          isChannel(group) ? "قابِ متحرکِ پشتِ کانال در فهرستِ پیام‌ها"
                           : "قابِ متحرکِ پشتِ گروه در فهرستِ پیام‌ها", () => go("plates")) : null,
        manage ? row("shield", "مجوزهایِ اعضا", "چه کاری برایِ اعضایِ عادی باز باشد", () => go("permissions")) : null,
        pending ? row("userPlus", "درخواست‌هایِ عضویت", "در انتظارِ تأیید", () => go("requests")) : null,
        manage ? row("link", "لینک‌هایِ دعوت", "ساخت، فهرست، ابطال", () => go("invites")) : null,
        manage ? row("list", "اقداماتِ اخیرِ مدیران", "لاگِ کاملِ تغییرات", () => go("log")) : null,
        row("clock", "پریدن به تاریخ", "اولین پیامِ یک روزِ مشخص", () => {
          close(); openJumpToDate(Chat.currentChannel || (group.channels || [])[0]?.id || 0, group.created_at);
        }, { chevron: false }),
        mayDo(group, "delete_messages") ? row("trash", `پاک‌کردنِ تاریخچه‌ی این ${isChannel(group) ? "کانال" : "گروه"}`,
          "همه‌ی پیام‌هایش برایِ همه پاک می‌شود", async () => {
            const cid = Chat.currentChannel || (group.channels || [])[0]?.id;
            if (!cid) return toast("اول این گفتگو را باز کن.", "error");
            const yes = await confirmDialog(`کلِ تاریخچه‌ی این ${isChannel(group) ? "کانال" : "گروه"} پاک شود؟`, "برگشت ندارد.");
            if (yes && wsSend({ t: "clear_history", channel: cid })) { toast("تاریخچه پاک شد.", "success"); close(); }
          }, { danger: true, chevron: false }) : null,
        sectionTitle("خودم"),
        isOwner(group)
          ? row("crown", "واگذاریِ مالکیت", "مالکِ جدید را انتخاب کن", () => go("transfer"))
          : null,
        row("logIn", isChannel(group) ? "ترکِ کانال" : "ترکِ گروه",
            isOwner(group)
              ? "مالکیت برایِ خودت محفوظ می‌ماند"
              : (isChannel(group) ? "دیگر پیام‌هایِ این کانال را نمی‌گیری" : "دیگر پیام‌هایِ این گروه را نمی‌گیری"),
            () => leaveGroup(), { danger: true, chevron: false }),
        isOwner(group)
          ? row("trash", isChannel(group) ? "حذفِ کانال" : "حذفِ گروه",
                "برایِ همه پاک می‌شود و برنمی‌گردد", () => deleteGroup(), { danger: true, chevron: false })
          : null);
    };

    const leaveGroup = async () => {
      const what = isChannel(group) ? "کانال" : "گروه";
      const yes = isOwner(group)
        ? await confirmDialog(`از «${group.name}» بیرون بروم؟`,
            `تو از این ${what} خارج می‌شوی، ولی هر وقت برگردی مالکیتش را پس می‌گیری. سفر به خیر! ✈️`)
        : await confirmDialog(`از «${group.name}» بیرون بروم؟`, `دیگر پیام‌هایِ این ${what} را نمی‌گیری.`);
      if (!yes) return;
      if (wsSend({ t: "leave_group", group: group.id })) {
        toast(isOwner(group) ? "بیرون آمدی — مالکیت برایت محفوظ است. سفر به خیر! ✈️" : `از ${what} بیرون آمدی.`, "success");
        close();
      }
    };

    // حذفِ گروه برگشت‌ناپذیر است و قبلاً با یک «بله» انجام می‌شد — یعنی یک کلیکِ اشتباه
    // می‌توانست همه‌ی کانال‌ها و پیام‌ها را از بین ببرد. مثلِ تلگرام، حالا باید نامِ گروه
    // دقیقاً تایپ شود تا دکمه فعال شود.
    const deleteGroup = () => {
      const nameEcho = h("strong", { class: "nx-danger-name", text: group.name });
      const input = h("input", { class: "nx-gm-input", placeholder: "نامِ گروه را این‌جا بنویس",
        autocomplete: "off", spellcheck: "false" });
      const warn = h("p", { class: "nx-gm-hint nx-gm-hint-danger", text:
        isChannel(group)
          ? "همه‌ی پیام‌هایِ این کانال برایِ همه‌ی دنبال‌کننده‌ها پاک می‌شود. این کار برگشت ندارد."
          : "همه‌ی پیام‌هایِ این گروه برایِ همه‌ی اعضا پاک می‌شود. این کار برگشت ندارد." });
      const okBtn = h("button", { class: "nx-button nx-danger", type: "button", disabled: true,
        text: "حذفِ همیشگیِ گروه" });
      const cancelBtn = h("button", { class: "nx-button", type: "button", text: "انصراف" });
      const match = () => input.value.trim() === String(group.name || "").trim();
      input.addEventListener("input", () => { okBtn.disabled = !match(); });
      const pop = h("div", { class: "nx-sticker-pop nx-prompt-pop nx-danger-pop", role: "dialog",
        "aria-modal": "true" },
        h("div", { class: "nx-sticker-pop-head" }, h("strong", { text: "حذفِ گروه" })),
        h("p", { class: "nx-gm-hint" }, h("span", { text: "برایِ تأیید، نامِ گروه را بنویس: " }), nameEcho),
        warn, input,
        h("div", { class: "nx-gm-actions" }, okBtn, cancelBtn));
      const scrim = h("div", { class: "nx-pop-scrim" });
      const shut = () => { document.removeEventListener("keydown", onEsc); scrim.remove(); pop.remove(); };
      const onEsc = (event) => { if (event.key === "Escape") shut(); };
      scrim.addEventListener("click", shut);
      cancelBtn.addEventListener("click", shut);
      document.addEventListener("keydown", onEsc);
      okBtn.addEventListener("click", () => {
        if (!match()) return;
        shut();
        if (wsSend({ t: "delete_group", group: group.id })) { toast("گروه حذف شد.", "success"); close(); }
      });
      document.body.append(scrim, pop);
      setTimeout(() => input.focus(), 30);
    };

    // ── ویرایشِ اطلاعات ──
    const renderEdit = () => {
      const nameInput = h("input", { class: "nx-gm-input", maxlength: "40", value: group.name || "" });
      const aboutInput = h("textarea", { class: "nx-gm-input nx-gm-textarea", maxlength: "255",
        rows: "3", placeholder: "این گروه درباره‌ی چیست؟" });
      aboutInput.value = group.about || "";
      const userInput = h("input", { class: "nx-gm-input", maxlength: "32", dir: "ltr",
        placeholder: "mihansquad", value: group.username || "" });
      const photoPreview = h("div", { class: "nx-gm-photo nx-gm-photo-edit" }, group.photo
        ? h("img", { src: avatarUrl(group.photo), alt: "" }) : i("image", 26));
      let photoUrl = group.photo || null;
      clear(body,
        sectionTitle("عکسِ گروه"),
        h("div", { class: "nx-gm-photo-pick" }, photoPreview,
          button("انتخابِ عکس", "upload", "ghost", async () => {
            const file = await pickImageFile(); if (!file) return;
            try {
              const dataUrl = await compressImageFile(file);
              const uploaded = await call("chat_upload", { data: dataUrl, kind: "image", name: file.name });
              photoUrl = uploaded.url;
              clear(photoPreview, h("img", { src: avatarUrl(photoUrl), alt: "" }));
              toast("عکس آماده است — ذخیره را بزن.", "info");
            } catch (error) { toast("بارگذاریِ عکس نشد: " + error, "error"); }
          }),
          photoUrl ? button("حذفِ عکس", "trash", "ghost", () => {
            photoUrl = ""; clear(photoPreview, i("image", 26));
          }) : null),
        sectionTitle("نام و توضیحات"),
        h("label", { class: "nx-gm-field" }, h("span", { text: "نامِ گروه" }), nameInput),
        h("label", { class: "nx-gm-field" }, h("span", { text: "توضیحات" }), aboutInput),
        sectionTitle("هندلِ عمومی", "با هندل، گروه عمومی می‌شود و هر کسی می‌تواند پیدایش کند."),
        h("label", { class: "nx-gm-field" }, h("span", { text: "@" }), userInput),
        h("div", { class: "nx-gm-actions" },
          button("ذخیره", "check", "primary", () => {
            const payload = { t: "set_group_info", group: group.id,
              name: nameInput.value.trim(), about: aboutInput.value.trim(),
              username: userInput.value.trim().replace(/^@/, "") };
            if (photoUrl !== group.photo) payload.photo = photoUrl || "";
            if (wsSend(payload)) { toast("ذخیره شد.", "success"); go("main"); }
          }),
          button("انصراف", null, "ghost", () => go("main"))));
    };

    // ── تنظیمات ──
    const renderSettings = () => {
      const set = (fields) => wsSend(Object.assign({ t: "set_group_settings", group: group.id }, fields));
      clear(body,
        sectionTitle("حالتِ آهسته", "هر عضو تا این فاصله نمی‌تواند پیامِ بعدی را بفرستد. مدیران معاف‌اند."),
        choiceRow("فاصله", SLOW_MODE_CHOICES, group.slow_mode, (v) => set({ slow_mode: v })),
        sectionTitle("حذفِ خودکارِ پیام", "پیام‌هایِ قدیمی‌تر از این مدت خودکار پاک می‌شوند."),
        choiceRow("مدت", AUTO_DELETE_CHOICES, group.auto_delete, (v) => set({ auto_delete: v })),
        sectionTitle("عضویت و انتشار"),
        toggleRow("تأییدِ عضویت", "هر کسی بخواهد عضو شود، اول باید مدیر تأیید کند.",
          group.join_requests, (v) => set({ join_requests: v })),
        toggleRow("امضایِ نامِ نویسنده", "در کانال‌هایِ اطلاع‌رسانی، نامِ نویسنده زیرِ پیام دیده شود.",
          group.sign_messages, (v) => set({ sign_messages: v })),
        toggleRow("گروهِ عمومی", "گروهِ عمومی در فهرستِ همه دیده می‌شود؛ خصوصی فقط با لینکِ دعوت.",
          group.is_public, (v) => wsSend({ t: "set_group_public", group: group.id, is_public: v })),
        );
    };

    // ── افکتِ پشتِ کادر (صفحه‌ی جدا) ──
    // همه می‌بینند و آزادانه پیش‌نمایش می‌گیرند؛ فقط *ثبت* امتیازِ پروست و گیتِ واقعی
    // همچنان سمتِ سرور است.
    const renderPlates = () => {
      const set = (fields) => wsSend(Object.assign({ t: "set_group_settings", group: group.id }, fields));
      const word = isChannel(group) ? "کانال" : "گروه";
      clear(body,
        sectionTitle(`افکتِ پشتِ کادرِ ${word}`,
          State.isPro
            ? `پس‌زمینه‌ی ردیفِ این ${word} در فهرستِ پیام‌ها.`
            : `پس‌زمینه‌ی ردیفِ این ${word} در فهرستِ پیام‌ها. هر کدام را بزنی پیش‌نمایشش را می‌بینی؛ برای ثبت اشتراکِ طلایی لازم است.`),
        nameplatePicker(group, set));
    };

    // انتخابگرِ نیم‌پلیت — همان قالبِ گریدِ تنظیماتِ پرو، ولی برایِ گروه، به‌علاوه‌ی
    // یک پیش‌نمایشِ زنده از خودِ همین گروه.
    const nameplatePicker = (grp, set) => {
      const saved = grp.nameplate || "none";
      let current = saved;            // انتخابِ در حالِ پیش‌نمایش (لزوماً ذخیره‌شده نیست)
      const options = ["none"].concat(nameplatePresets());
      const buttons = new Map();

      // پیش‌نمایش با همان inboxRowِ فهرستِ پیام‌ها ساخته می‌شود، نه یک شبیه‌سازیِ
      // جداگانه — پس هرچه این‌جا دیده می‌شود دقیقاً همان چیزی است که بعداً در
      // فهرست ظاهر می‌شود و با تغییرِ استایلِ ردیف هم خودبه‌خود هم‌گام می‌ماند.
      const previewBox = h("div", { class: "nx-plate-preview" });
      const renderPreview = () => {
        const unsaved = !State.isPro && current !== saved;
        clear(previewBox, inboxRow({
          title: grp.name || (isChannel(grp) ? "کانالِ من" : "گروهِ من"),
          subtitle: unsaved ? "پیش‌نمایش — هنوز ذخیره نشده" : "همین شکلی در فهرستِ پیام‌ها دیده می‌شود",
          username: grp.name,
          image: grp.photo || null,
          glyph: grp.photo ? null : (isChannel(grp) ? "megaphone" : "users"),
          onclick: () => {},
          plate: current,
        }));
      };
      renderPreview();

      const grid = h("div", { class: "pro-nameplate-grid" });
      options.forEach((id) => {
        const visual = id === "none"
          ? h("span", { class: "pro-nameplate-visual pro-nameplate-visual-thumb" })
          : makeNameplate("", id);
        if (id !== "none") visual.classList.add("pro-nameplate-visual", "pro-nameplate-visual-thumb");
        visual.setAttribute("aria-hidden", "true");
        const option = h("button", {
          class: "pro-nameplate-option" + (current === id ? " active" : ""), type: "button",
          onclick: () => {
            current = id;
            buttons.forEach((node, key) => node.classList.toggle("active", key === current));
            renderPreview();
            // کاربرِ عادی: فقط پیش‌نمایش. چیزی به سرور نمی‌فرستیم تا به‌جای این پیامِ
            // روشن، خطای خامِ «فقط برایِ کاربرانِ پرو» را نگیرد.
            if (!State.isPro) {
              toast("پیش‌نمایش است — برای ثبت اشتراکِ طلایی لازم است.", "info");
              return;
            }
            grp.nameplate = id;
            if (set({ nameplate: id })) toast("افکتِ پشتِ کادرِ گروه ذخیره شد.", "success");
          },
        }, visual, h("span", { class: "pro-nameplate-option-copy" },
          h("strong", { text: id === "none" ? "بدونِ افکت" : (NAMEPLATE_FA[id] || id) })));
        buttons.set(id, option);
        grid.appendChild(option);
      });

      return h("div", { class: "nx-plate-picker" }, previewBox, grid,
        State.isPro ? null : h("div", { class: "nx-plate-cta" },
          h("small", { text: "با اشتراکِ طلایی همین افکت روی گروهت ثبت می‌شود." }),
          button("گرفتنِ اشتراکِ طلایی", "star", "primary", () => goPage("pro"))));
    };

    // ── مجوزهایِ پیش‌فرضِ اعضا ──
    const renderPermissions = () => {
      // NULL سمتِ سرور یعنی «هیچ محدودیتی»؛ در UI همه تیک‌خورده نشان داده می‌شود.
      const current = group.default_permissions;
      const boxes = {};
      const rows = Object.keys(MEMBER_PERM_LABELS).map((key) => {
        const box = h("input", { type: "checkbox", class: "nx-gm-check" });
        box.checked = current ? !!current[key] : true;
        boxes[key] = box;
        return h("label", { class: "nx-gm-toggle" },
          h("span", { class: "nx-gm-row-copy" }, h("strong", { text: MEMBER_PERM_LABELS[key] })), box);
      });
      clear(body,
        sectionTitle("اعضایِ عادی چه کاری می‌توانند بکنند؟",
          "مدیران و مالک از این محدودیت‌ها معاف‌اند."),
        ...rows,
        h("div", { class: "nx-gm-actions" },
          button("ذخیره", "check", "primary", () => {
            const permissions = {};
            Object.keys(boxes).forEach((key) => { permissions[key] = boxes[key].checked; });
            if (wsSend({ t: "set_group_settings", group: group.id, default_permissions: permissions })) {
              toast("مجوزها ذخیره شد.", "success");
            }
          }),
          button("برداشتنِ همه‌ی محدودیت‌ها", null, "ghost", () => {
            if (wsSend({ t: "set_group_settings", group: group.id, default_permissions: null })) {
              toast("محدودیت‌ها برداشته شد.", "success");
            }
          })));
    };

    // ── اعضا ──
    const renderMembers = async () => {
      clear(body, loading("فهرستِ اعضا…"));
      const data = await wsAsk({ t: "list_members", group: group.id }, "members_list",
        (m) => Number(m.group) === Number(group.id));
      if (!data) return clear(body, blank("فهرستِ اعضا نیامد", "اتصالت را بررسی کن و دوباره باز کن.", "users"));
      const manage = canManage(group);
      // سرورِ چت آواتار ندارد (عکس‌ها در سرورِ احرازِ هویت‌اند)، پس با یک
      // درخواستِ دسته‌ای پرشان می‌کنیم — وگرنه همه‌ی اعضا فقط حرفِ اولِ نام می‌شدند.
      const avatarBoxes = new Map();
      const fillAvatars = async (names) => {
        if (!names.length) return;
        try {
          const res = await call("user_avatars", { usernames: names });
          const map = (res && res.avatars) || {};
          Object.keys(map).forEach((name) => {
            const box = avatarBoxes.get(String(name).toLowerCase());
            if (box) box.replaceWith(avatar(name, map[name], 34));
          });
        } catch (_) { /* عکس نیامد — حرفِ اول می‌ماند */ }
      };
      const memberRow = (mem) => {
        const roleLabel = mem.role === "owner" ? "مالک" : mem.role === "admin" ? "مدیر" : "عضو";
        const actions = [];
        const me = String(Chat.username || "").toLowerCase() === String(mem.username).toLowerCase();
        if (manage && !me && mem.role !== "owner") {
          if (isOwner(group)) {
            actions.push(button(mem.role === "admin" ? "تنزل به عضو" : "ارتقا به مدیر",
              mem.role === "admin" ? "userMinus" : "shield", "ghost",
              () => wsSend({ t: "set_member_role", group: group.id, username: mem.username,
                             role: mem.role === "admin" ? "member" : "admin" })));
            if (mem.role === "admin") {
              actions.push(button("اختیارات", "key", "ghost", () => openAdminPermissions(group, mem)));
            }
            actions.push(button("واگذاریِ مالکیت", "crown", "ghost", async () => {
              const yes = await confirmDialog(`مالکیت به «${mem.username}» داده شود؟`,
                "تو مدیر می‌شوی و او مالکِ گروه. این کار را فقط خودش می‌تواند برگرداند.");
              if (yes) wsSend({ t: "transfer_ownership", group: group.id, username: mem.username });
            }));
          }
          actions.push(button(mem.muted ? "رفعِ سکوت" : "سکوت", mem.muted ? "volumeX" : "micOff", "ghost",
            () => wsSend({ t: mem.muted ? "unmute_member" : "mute_member", group: group.id,
                           username: mem.username, seconds: 3600 })));
          actions.push(button("اخراج", "userMinus", "ghost",
            () => wsSend({ t: "kick_member", group: group.id, username: mem.username })));
          actions.push(button("بن", "ban", "ghost", async () => {
            const yes = await confirmDialog(`«${mem.username}» بن شود؟`, "دیگر نمی‌تواند عضو شود.");
            if (yes) wsSend({ t: "ban_member", group: group.id, username: mem.username });
          }));
        }
        const av = avatar(mem.username, null, 34);
        avatarBoxes.set(String(mem.username).toLowerCase(), av);
        return h("div", { class: "nx-gm-member" },
          h("button", { class: "nx-gm-member-main", type: "button", onclick: () => openUser(mem.username) },
            av,
            h("span", { class: "nx-gm-row-copy" },
              h("strong", { text: mem.username }),
              h("small", { text: roleLabel + (mem.muted ? " · سکوت‌شده" : "") }))),
          actions.length ? h("div", { class: "nx-gm-member-actions" }, ...actions) : null);
      };
      clear(body,
        manage ? h("div", { class: "nx-gm-actions" },
          button("افزودنِ عضو", "userPlus", "primary", () => {
            // قبلاً فقط یک فیلدِ خالی بود و باید نامِ دقیق را از حفظ می‌نوشتی.
            openPeoplePicker("افزودنِ عضو", (username) =>
              wsSend({ t: "add_member", group: group.id, username }),
              (data.members || []).map((m) => m.username));
          })) : null,
        sectionTitle("اعضا", `${(data.members || []).length} نفر`),
        ...(data.members || []).map(memberRow),
        (data.bans || []).length ? sectionTitle("بن‌شده‌ها", `${data.bans.length} نفر`) : null,
        ...(data.bans || []).map((b) => h("div", { class: "nx-gm-member" },
          h("div", { class: "nx-gm-member-main" }, avatar(b.username, null, 34),
            h("span", { class: "nx-gm-row-copy" }, h("strong", { text: b.username }),
              h("small", { text: b.reason || "بن‌شده" }))),
          manage ? h("div", { class: "nx-gm-member-actions" },
            button("رفعِ بن", "userCheck", "ghost",
              () => wsSend({ t: "unban_member", group: group.id, username: b.username }))) : null)));
      // ردیف‌ها اول با حرفِ اول رسم می‌شوند، بعد عکس‌ها جایشان را می‌گیرند —
      // این‌طور فهرست منتظرِ یک درخواستِ دیگر نمی‌ماند.
      fillAvatars((data.members || []).map((m) => m.username));
    };

    // ── درخواست‌هایِ عضویت ──
    const renderRequests = async () => {
      clear(body, loading("درخواست‌ها…"));
      const data = await wsAsk({ t: "list_join_requests", group: group.id }, "join_requests_list",
        (m) => Number(m.group) === Number(group.id));
      if (!data) return clear(body, blank("درخواستی نیامد", "", "userPlus"));
      const items = data.requests || [];
      if (!items.length) return clear(body, blank("درخواستی در انتظار نیست", "هر وقت کسی بخواهد عضو شود این‌جا می‌آید.", "userPlus"));
      const resolve = (username, approve) => wsSend({ t: "resolve_join_request", group: group.id, username, approve });
      clear(body, sectionTitle("در انتظارِ تأیید", `${items.length} نفر`),
        ...items.map((req) => h("div", { class: "nx-gm-member" },
          h("button", { class: "nx-gm-member-main", type: "button", onclick: () => openUser(req.username) },
            avatar(req.username, null, 34),
            h("span", { class: "nx-gm-row-copy" }, h("strong", { text: req.username }),
              h("small", { text: relativeTime(req.created_at) }))),
          h("div", { class: "nx-gm-member-actions" },
            button("تأیید", "check", "primary", () => { resolve(req.username, true); renderRequests(); }),
            button("رد", "x", "ghost", () => { resolve(req.username, false); renderRequests(); })))));
    };

    // ── لینک‌هایِ دعوت ──
    const renderInvites = async () => {
      clear(body, loading("لینک‌هایِ دعوت…"));
      const data = await wsAsk({ t: "list_invites", group: group.id }, "invites_list",
        (m) => Number(m.group) === Number(group.id));
      if (!data) return clear(body, blank("فهرستِ لینک‌ها نیامد", "", "link"));
      const items = data.invites || [];
      const makeLink = () => {
        const expiry = h("select", { class: "nx-gm-select" },
          ...[[0, "بی‌پایان"], [3600, "۱ ساعت"], [86400, "۱ روز"], [604800, "۱ هفته"]]
            .map(([v, t]) => h("option", { value: String(v), text: t })));
        const uses = h("select", { class: "nx-gm-select" },
          ...[[0, "بی‌شمار"], [1, "۱ نفر"], [5, "۵ نفر"], [25, "۲۵ نفر"], [100, "۱۰۰ نفر"]]
            .map(([v, t]) => h("option", { value: String(v), text: t })));
        const dlg = sheetDialog("لینکِ دعوتِ جدید", [
          h("label", { class: "nx-gm-field" }, h("span", { text: "انقضا" }), expiry),
          h("label", { class: "nx-gm-field" }, h("span", { text: "سقفِ استفاده" }), uses),
        ], () => {
          const payload = { t: "create_invite", group: group.id };
          if (Number(expiry.value)) payload.expires_in = Number(expiry.value);
          if (Number(uses.value)) payload.max_uses = Number(uses.value);
          if (wsSend(payload)) setTimeout(renderInvites, 400);
          dlg.close();
        });
      };
      clear(body,
        h("div", { class: "nx-gm-actions" }, button("ساختِ لینکِ جدید", "plus", "primary", makeLink)),
        sectionTitle("لینک‌هایِ فعال", `${items.length} لینک`),
        ...(items.length ? items.map((inv) => h("div", { class: "nx-gm-invite" },
          h("code", { class: "nx-gm-token", dir: "ltr", text: inv.token }),
          h("small", { text: [
            inv.max_uses ? `${inv.uses}/${inv.max_uses} استفاده` : `${inv.uses} استفاده`,
            inv.expires_at ? "انقضا " + relativeTime(inv.expires_at) : "بی‌پایان",
            "ساختِ " + inv.created_by,
          ].join(" · ") }),
          h("div", { class: "nx-gm-member-actions" },
            button("کپی", "copy", "ghost", () => {
              try { navigator.clipboard.writeText(inv.token); toast("کد کپی شد.", "success"); }
              catch (_) { toast(inv.token, "info"); }
            }),
            button("ابطال", "trash", "ghost", () => {
              wsSend({ t: "revoke_invite", group: group.id, token: inv.token });
              setTimeout(renderInvites, 400);
            }))))
          : [blank("لینکی نساخته‌ای", "با دکمه‌ی بالا اولین لینکِ دعوت را بساز.", "link")]));
    };

    // ── پیام‌هایِ پین‌شده ──
    const renderPins = async () => {
      clear(body, loading("پین‌شده‌ها…"));
      const data = await wsAsk({ t: "list_pins", group: group.id }, "pins_list",
        (m) => Number(m.group) === Number(group.id));
      if (!data) return clear(body, blank("فهرستِ پین‌ها نیامد", "", "pin"));
      const items = data.pins || [];
      if (!items.length) return clear(body, blank("پیامِ پین‌شده‌ای نیست", "پیام‌هایِ مهم را پین کن تا این‌جا بمانند.", "pin"));
      clear(body, sectionTitle("پین‌شده‌ها", `${items.length} پیام`),
        ...items.map((pin) => h("div", { class: "nx-gm-pin" },
          h("div", { class: "nx-gm-row-copy" },
            h("strong", { text: pin.from || "?" }),
            h("small", { text: (pin.text || "").slice(0, 140) || "(بدونِ متن)" }),
            h("small", { class: "nx-gm-dim", text: `پین‌شده توسطِ ${pin.pinned_by} · ${relativeTime(pin.created_at)}` })),
          mayDo(group, "pin") ? button("برداشتن", "x", "ghost", () => {
            wsSend({ t: "unpin_message", group: group.id, message: pin.id });
            setTimeout(renderPins, 400);
          }) : null)));
    };

    // ── جست‌وجو داخلِ گفتگو ──
    const renderSearch = () => {
      const input = h("input", { class: "nx-gm-input", placeholder: "متنی که دنبالش هستی…" });
      const results = h("div", { class: "nx-gm-results" });
      const channels = group.channels || [];
      const picker = h("select", { class: "nx-gm-select" },
        ...channels.map((c) => h("option", { value: String(c.id), text: c.name })));
      const run = async () => {
        const query = input.value.trim();
        if (query.length < 2) return clear(results, h("p", { class: "nx-inbox-note", text: "حداقل ۲ حرف بنویس." }));
        clear(results, loading("جست‌وجو…"));
        const data = await wsAsk({ t: "search_messages", channel: Number(picker.value), query },
          "search_results", (m) => Number(m.channel) === Number(picker.value));
        if (!data) return clear(results, blank("نتیجه‌ای نیامد", "", "search"));
        const found = data.messages || [];
        if (!found.length) return clear(results, blank("چیزی پیدا نشد", "عبارتِ دیگری را امتحان کن.", "search"));
        clear(results, sectionTitle("نتیجه‌ها", `${found.length} پیام`),
          ...found.map((m) => h("div", { class: "nx-gm-pin" },
            h("div", { class: "nx-gm-row-copy" }, h("strong", { text: m.from }),
              h("small", { text: (m.text || "").slice(0, 160) }),
              h("small", { class: "nx-gm-dim", text: relativeTime(m.ts) })))));
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
      clear(body,
        sectionTitle("جست‌وجو در گفتگو"),
        null,
        h("div", { class: "nx-gm-search-row" }, input, button("بگرد", "search", "primary", run)),
        results);
    };

    // ── بی‌صداکردنِ اعلان ──
    const renderMute = () => {
      const pick = (seconds, label) => button(label, "bell", "ghost", () => {
        if (wsSend({ t: "mute_chat", group: group.id, channel: 0, seconds })) {
          toast(seconds ? "بی‌صدا شد." : "صدا برگشت.", "success");
          go("main");
        }
      });
      clear(body,
        sectionTitle("اعلانِ این گروه", "بی‌صداکردن فقط برایِ خودت است و به بقیه ربطی ندارد."),
        h("div", { class: "nx-gm-actions nx-gm-actions-wrap" },
          pick(3600, "۱ ساعت"), pick(28800, "۸ ساعت"), pick(86400, "۱ روز"),
          pick(604800, "۱ هفته"), pick(-1, "تا همیشه"), pick(0, "رفعِ بی‌صدایی")));
    };

    // ── لاگِ مدیران ──
    const renderLog = async () => {
      clear(body, loading("اقداماتِ اخیر…"));
      const data = await wsAsk({ t: "admin_log", group: group.id }, "admin_log",
        (m) => Number(m.group) === Number(group.id));
      if (!data) return clear(body, blank("لاگ نیامد", "", "list"));
      const items = data.actions || [];
      if (!items.length) return clear(body, blank("هنوز اقدامی ثبت نشده", "", "list"));
      clear(body, sectionTitle("اقداماتِ اخیر", `${items.length} مورد`),
        ...items.map((a) => h("div", { class: "nx-gm-pin" },
          h("div", { class: "nx-gm-row-copy" },
            h("strong", { text: ADMIN_LOG_LABELS[a.action] || a.action }),
            h("small", { text: [a.actor, a.target, a.detail].filter(Boolean).join(" → ") }),
            h("small", { class: "nx-gm-dim", text: relativeTime(a.created_at) })))));
    };

    // ── واگذاریِ مالکیت ──
    const renderTransfer = async () => {
      clear(body, loading("اعضا…"));
      const data = await wsAsk({ t: "list_members", group: group.id }, "members_list",
        (m) => Number(m.group) === Number(group.id));
      if (!data) return clear(body, blank("فهرستِ اعضا نیامد", "", "users"));
      const others = (data.members || []).filter((m) => m.role !== "owner");
      if (!others.length) return clear(body, blank("عضوِ دیگری نیست", "اول کسی را به گروه اضافه کن.", "users"));
      clear(body,
        sectionTitle("مالکِ جدید", "تو بعد از این مدیر می‌شوی، نه مالک. برگشتش دستِ خودت نیست."),
        ...others.map((mem) => h("div", { class: "nx-gm-member" },
          h("div", { class: "nx-gm-member-main" }, avatar(mem.username, null, 34),
            h("span", { class: "nx-gm-row-copy" }, h("strong", { text: mem.username }),
              h("small", { text: mem.role === "admin" ? "مدیر" : "عضو" }))),
          h("div", { class: "nx-gm-member-actions" },
            button("واگذاری", "crown", "ghost", async () => {
              const yes = await confirmDialog(`مالکیت به «${mem.username}» داده شود؟`, "این کار برگشت ندارد.");
              if (yes && wsSend({ t: "transfer_ownership", group: group.id, username: mem.username })) go("main");
            })))));
    };

    const VIEWS = {
      main: renderMain, edit: renderEdit, settings: renderSettings, plates: renderPlates,
      permissions: renderPermissions,
      members: renderMembers, requests: renderRequests, invites: renderInvites, pins: renderPins,
      search: renderSearch, mute: renderMute, log: renderLog,
      transfer: renderTransfer,
    };
    const VIEW_TITLES = {
      main: null, edit: "ویرایشِ اطلاعات", settings: "تنظیمات", plates: "افکتِ پشتِ کادر",
      permissions: "مجوزهایِ اعضا",
      members: "اعضا", requests: "درخواست‌هایِ عضویت", invites: "لینک‌هایِ دعوت",
      pins: "پیام‌هایِ پین‌شده", search: "جست‌وجو", mute: "اعلان",
      log: "اقداماتِ اخیر", transfer: "واگذاریِ مالکیت",
    };

    function render() {
      backBtn.hidden = view === "main";
      title.textContent = VIEW_TITLES[view] || group.name;
      (VIEWS[view] || renderMain)();
    }

    document.body.append(scrim, panel);
    if (window.__restackScrims) window.__restackScrims();   // تیرگیِ پرده دو برابر نشود
    render();
  }

  // پاپ‌آپِ ساده‌ی گرفتنِ یک نام/کد — برایِ ساختِ گروه/کانال و پیوستن با کدِ دعوت.
  const promptDialog = (title, placeholder, onSubmit, initial = "") => {
    // maxlength=40 برایِ نامِ گروه/کانال بس است، ولی ویرایشِ متنِ پیام باید بلند باشد.
    const input = h("input", { class: "nx-prompt-input", placeholder, maxlength: initial ? "300" : "40" });
    if (initial) input.value = initial;
    const closeBtn = h("button", { class: "nx-sticker-close", type: "button", title: "بستن" }, i("x", 14));
    const submitBtn = h("button", { class: "nx-button nx-primary", type: "button", text: "تأیید" });
    const pop = h("div", { class: "nx-sticker-pop nx-prompt-pop" }, h("div", { class: "nx-sticker-pop-head" }, h("strong", { text: title }), closeBtn), input, submitBtn);
    // بدونِ این پرده، دیالوگ وسطِ صفحه «رویِ هوا» می‌ماند و معلوم نیست بقیه‌ی رابط غیرفعال است.
    const scrim = h("div", { class: "nx-pop-scrim" });
    const close = () => { document.removeEventListener("keydown", onEsc); scrim.remove(); pop.remove(); };
    scrim.addEventListener("click", close);
    const onEsc = (event) => { if (event.key === "Escape") close(); };
    closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", onEsc);
    const submit = () => { const v = input.value.trim(); if (!v) return; close(); onSubmit(v); };
    submitBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
    document.body.append(scrim, pop);
    setTimeout(() => input.focus(), 30);
  };

  // ── تقویمِ شمسی + انتخابگرِ دوستانه ───────────────────────────────────────
  // ورودی‌هایِ بومیِ <input type="date"> و "datetime-local" در WebView تقویمِ میلادیِ
  // سیستم را باز می‌کنند: انگلیسی، روشن (حتی در تمِ تیره) و کاملاً بیگانه با بقیه‌ی
  // رابط. جایشان با سه فهرستِ کشویی‌ (روز/ماه/سال) به تقویمِ شمسی عوض شد.
  const _div = (a, b) => Math.trunc(a / b);
  const JMONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
                   "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
  const jIsLeap = (jy) => [1, 5, 9, 13, 17, 22, 26, 30].indexOf((jy + 12) % 33) !== -1;
  const jMonthLen = (jy, jm) => (jm <= 6 ? 31 : jm <= 11 ? 30 : (jIsLeap(jy) ? 30 : 29));
  function toJalali(gy, gm, gd) {
    const gdm = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let jy = gy <= 1600 ? 0 : 979;
    gy -= gy <= 1600 ? 621 : 1600;
    const gy2 = gm > 2 ? gy + 1 : gy;
    let days = 365 * gy + _div(gy2 + 3, 4) - _div(gy2 + 99, 100) + _div(gy2 + 399, 400) - 80 + gd + gdm[gm - 1];
    jy += 33 * _div(days, 12053); days %= 12053;
    jy += 4 * _div(days, 1461); days %= 1461;
    if (days > 365) { jy += _div(days - 1, 365); days = (days - 1) % 365; }
    const jm = days < 186 ? 1 + _div(days, 31) : 7 + _div(days - 186, 30);
    const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
    return [jy, jm, jd];
  }
  function toGregorian(jy, jm, jd) {
    let gy = jy <= 979 ? 621 : 1600;
    jy -= jy <= 979 ? 0 : 979;
    let days = 365 * jy + _div(jy, 33) * 8 + _div((jy % 33) + 3, 4) + 78 + jd
      + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
    gy += 400 * _div(days, 146097); days %= 146097;
    if (days > 36524) { days--; gy += 100 * _div(days, 36524); days %= 36524; if (days >= 365) days++; }
    gy += 4 * _div(days, 1461); days %= 1461;
    if (days > 365) { gy += _div(days - 1, 365); days = (days - 1) % 365; }
    let gd = days + 1;
    const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
    const len = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let gm = 1;
    while (gm <= 12 && gd > len[gm]) { gd -= len[gm]; gm++; }
    return [gy, gm, gd];
  }
  const faNum = (n, pad) => String(pad ? String(n).padStart(pad, "0") : n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);

  // تقویمِ واقعی به‌جایِ سه اسپینر. قبلاً روز/ماه/سال هرکدام دو فلش
  // داشتند و با ساعت می‌شد ۱۰ فلش در یک پنجره‌ی کوچک؛ هم شلوغ بود و هم
  // چون عوض‌کردنِ سال/ماه روز را clamp می‌کرد، به‌نظر می‌رسید فلشِ روز خودبه‌خود
  // تکان می‌خورد. در تقویم، روز را مستقیم انتخاب می‌کنی و فقط دو فلشِ ماه مانده.
  const JWEEK = ["ش", "ی", "د", "س", "چ", "پ", "ج"];
  function persianDatePicker({ withTime = false, initial, min, max } = {}) {
    const now = initial instanceof Date ? initial : new Date();
    // مرزها به نیمه‌شبِ همان روز گرد می‌شوند تا خودِ روزِ مرزی قابلِ انتخاب بماند.
    const dayStart = (d) => (d instanceof Date ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() : null);
    const minAt = dayStart(min), maxAt = dayStart(max);
    const inRange = (jy, jm, jd) => {
      const [gy, gm, gd] = toGregorian(jy, jm, jd);
      const at = new Date(gy, gm - 1, gd).getTime();
      if (minAt !== null && at < minAt) return false;
      if (maxAt !== null && at > maxAt) return false;
      return true;
    };
    const [jy0, jm0, jd0] = toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const today = toJalali(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate());
    // ماهِ در‌حالِ‌نمایش و روزِ انتخاب‌شده جدا نگه داشته می‌شوند تا ورق‌زدنِ
    // ماه انتخاب را نپراند.
    let vy = jy0, vm = jm0;
    let sy = jy0, sm = jm0, sd = jd0;

    const title = h("strong", { class: "nx-cal-title" });
    const prev = h("button", { class: "nx-cal-nav", type: "button", "aria-label": "ماهِ قبل" }, i("chevronRight", 16));
    const next = h("button", { class: "nx-cal-nav", type: "button", "aria-label": "ماهِ بعد" }, i("chevronLeft", 16));
    const grid = h("div", { class: "nx-cal-grid" });
    const head = h("div", { class: "nx-cal-head" }, prev, title, next);
    const week = h("div", { class: "nx-cal-week" }, ...JWEEK.map((d) => h("span", { text: d })));

    const paint = () => {
      title.textContent = JMONTHS[vm - 1] + " " + faNum(vy);
      clear(grid);
      const [gy, gm, gd] = toGregorian(vy, vm, 1);
      // هفته‌ی شمسی از شنبه شروع می‌شود؛ getDay() یکشنبه را ۰ می‌داند.
      const lead = (new Date(gy, gm - 1, gd).getDay() + 1) % 7;
      for (let k = 0; k < lead; k++) grid.appendChild(h("span", { class: "nx-cal-pad" }));
      const len = jMonthLen(vy, vm);
      for (let d = 1; d <= len; d++) {
        const isSel = d === sd && vm === sm && vy === sy;
        const isToday = vy === today[0] && vm === today[1] && d === today[2];
        const ok = inRange(vy, vm, d);
        const cell = h("button", {
          class: "nx-cal-day" + (isSel ? " is-sel" : "") + (isToday ? " is-today" : ""),
          type: "button", text: faNum(d),
        });
        cell.disabled = !ok;
        if (!ok) cell.title = "خارج از بازه‌ی این گفتگوست";
        cell.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          if (!ok) return;
          sy = vy; sm = vm; sd = d; paint();
        });
        grid.appendChild(cell);
      }
      // ماه‌هایِ ۲۹ تا ۳۱ روزه بینِ ۵ و ۶ سطر جابه‌جا می‌شدند و پاپ‌آپ با هر ورق‌زدن
      // بالا‌پایین می‌پرید. همیشه ۶ سطر (۴۲ خانه) پر می‌کنیم تا ارتفاع ثابت بماند.
      for (let k = lead + len; k < 42; k++) grid.appendChild(h("span", { class: "nx-cal-pad" }));
      syncNav();
    };
    // اگر هیچ روزی از ماهِ مقصد در بازه نباشد، فلش غیرفعال می‌شود.
    const monthHasAny = (y, m) => {
      const len = jMonthLen(y, m);
      return inRange(y, m, 1) || inRange(y, m, len);
    };
    const stepOf = (dir) => {
      let y = vy, m = vm + dir;
      if (m < 1) { m = 12; y--; }
      if (m > 12) { m = 1; y++; }
      return [y, m];
    };
    const syncNav = () => {
      const [py, pm] = stepOf(-1), [ny, nm] = stepOf(1);
      prev.disabled = !monthHasAny(py, pm);
      next.disabled = !monthHasAny(ny, nm);
    };
    const shift = (dir) => {
      const [y, m] = stepOf(dir);
      if (!monthHasAny(y, m)) return;
      vy = y; vm = m;
      paint();
    };
    prev.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); shift(-1); });
    next.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); shift(1); });

    let hourSel = null, minSel = null;
    if (withTime) {
      const opt = (v, t) => h("option", { value: String(v), text: t });
      hourSel = h("select", { class: "nx-gm-select nx-cal-time" });
      minSel = h("select", { class: "nx-gm-select nx-cal-time" });
      for (let x = 0; x < 24; x++) hourSel.appendChild(opt(x, faNum(x, 2)));
      for (let x = 0; x < 60; x += 5) minSel.appendChild(opt(x, faNum(x, 2)));
      hourSel.value = String(now.getHours());
      minSel.value = String(Math.round(now.getMinutes() / 5) * 5 % 60);
    }

    const node = h("div", { class: "nx-cal" }, head, week, grid,
      withTime ? h("div", { class: "nx-cal-timerow" },
        h("span", { class: "nx-cal-timelabel", text: "ساعت" }),
        hourSel, h("span", { class: "nx-cal-colon", text: ":" }), minSel) : null);
    paint();

    const getDate = () => {
      const [gy, gm, gd] = toGregorian(sy, sm, sd);
      return new Date(gy, gm - 1, gd, hourSel ? Number(hourSel.value) : 0,
        minSel ? Number(minSel.value) : 0, 0, 0);
    };
    return { node, getDate };
  }

  // «پریدن به پیام» از سه جا صدا زده می‌شود: پریدن به تاریخ، نوارِ پیامِ پین‌شده و
  // نتایجِ جست‌وجو. تا حالا هیچ‌جا تعریف نشده بود و هر سه ReferenceError می‌دادند.
  // خودِ کار باید داخلِ صفحه‌ی پیام‌ها انجام شود (openLive و findMessageNode آن‌جایند)،
  // پس آن صفحه یک قلاب این‌جا می‌گذارد و این تابع فقط واسط است.
  let _jumpHook = null;
  function jumpToMessage(channelId, messageId) {
    if (_jumpHook) return _jumpHook(channelId, messageId);
    toast("اول بخشِ پیام‌ها را باز کن.", "error");
  }

  // ── مرورگرِ گروه‌هایِ عمومی ──
  // همه‌ی گروه‌هایِ عمومی در Chat.groups هستند (سرور آن‌ها را برایِ همه می‌فرستد،
  // چه عضو باشی چه نه)، پس این‌جا فقط فیلتر و مرتب‌سازی می‌شود.
  function openPublicGroups() {
    const SORTS = [
      ["members", "بیشترین عضو", (a, b) => (b.members || 0) - (a.members || 0)],
      ["new", "جدیدترین", (a, b) => (b.created_at || 0) - (a.created_at || 0)],
      ["old", "قدیمی‌ترین", (a, b) => (a.created_at || 0) - (b.created_at || 0)],
    ];
    let sortKey = "members";
    const search = h("input", { class: "nx-gm-input", placeholder: "نامِ گروه…" });
    const chips = h("div", { class: "nx-dt-quick nx-pubgroups-sorts" });
    const listBox = h("div", { class: "nx-pubgroups-list" });

    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const sorter = (SORTS.find((x) => x[0] === sortKey) || SORTS[0])[2];
      const items = (Chat.groups || [])
        // کانال‌ها گفتگویِ دیگری‌اند و این‌جا جا ندارند؛ «ذخیره‌شده‌ها» هم گروه نیست.
        .filter((g) => g.is_public && g.kind !== "channel" && g.kind !== "saved")
        .filter((g) => !q || String(g.name || "").toLowerCase().includes(q)
                          || String(g.username || "").toLowerCase().includes(q))
        .sort(sorter);
      clear(listBox);
      if (!items.length) {
        listBox.appendChild(blank(q ? "چیزی پیدا نشد" : "هنوز گروهِ عمومی‌ای نیست",
          q ? "عبارتِ دیگری را امتحان کن." : "اولین گروهِ عمومی را تو بساز.", "users"));
        return;
      }
      items.forEach((group) => {
        const joined = !!group.joined;
        const act = h("button", {
          class: "nx-pubgroups-act" + (joined ? " is-in" : ""), type: "button",
          text: joined ? "بازکردن" : "پیوستن",
          onclick: (e) => {
            e.stopPropagation();
            if (!Chat.ws || Chat.ws.readyState !== 1) {
              return toast("هنوز به سرویسِ گفتگو وصل نشده‌ای", "error");
            }
            if (joined) {
              const channel = (group.channels || [])[0];
              dlg.close();
              if (channel) openLive(channel.id);
              return;
            }
            Chat.ws.send(JSON.stringify({ t: "join_group", group: group.id }));
            act.textContent = "در حالِ پیوستن…";
            act.disabled = true;
          },
        });
        // افکتِ پشتِ کادرِ گروه — اگر گروه پلاک داشته باشد، پس‌زمینهٔ ردیف می‌شود.
        // ‎nameplate‎ از قبل در payloadِ ‎db_groups‎ هست، پس چیزِ تازه‌ای از سرور لازم نیست.
        // ‎nx-plate-row‎ همان قراردادِ آمادهٔ styles.css است: هم ‎position: relative‎ می‌دهد
        // (بدونش پلاکِ ‎position: absolute‎ از ردیف فرار می‌کرد) و هم هندسهٔ پلاک و
        // لایهٔ تیرهٔ پشتِ متن را — دقیقاً مثلِ ردیف‌های صندوقِ پیام.
        const plate = rowPlate(null, group.nameplate);
        listBox.appendChild(h("div", { class: "nx-pubgroups-row" + (plate ? " nx-plate-row" : "") },
          plate,
          avatar(group.name, group.photo || null, 40),
          h("span", { class: "nx-gm-row-copy" },
            h("strong", { text: group.name }),
            h("small", { text: `${(group.members || 1).toLocaleString("fa-IR")} عضو`
              + (group.created_at ? " · ساخته‌شده " + relativeTime(group.created_at) : "") }),
            group.about ? h("small", { class: "nx-gm-dim", text: String(group.about).slice(0, 90) }) : null),
          act));
      });
    };

    SORTS.forEach(([key, label]) => {
      const chip = h("button", { class: "nx-dt-chip" + (key === sortKey ? " is-on" : ""),
        type: "button" }, h("span", { text: label }));
      chip.addEventListener("click", () => {
        sortKey = key;
        [...chips.children].forEach((c) => c.classList.toggle("is-on", c === chip));
        paint();
      });
      chips.appendChild(chip);
    });
    search.addEventListener("input", paint);
    paint();

    const dlg = sheetDialog("گروه‌هایِ عمومی", [
      h("label", { class: "nx-gm-field" }, h("span", { text: "جست‌وجو" }), search),
      h("label", { class: "nx-gm-field" }, h("span", { text: "مرتب‌سازی" }), chips),
      listBox,
    ], () => dlg.close());
    // وقتی سرور فهرستِ تازه فرستاد (مثلاً بعد از پیوستن) خودکار نو می‌شود
    const onPush = (event) => {
      let data; try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data && data.t === "groups") paint();
    };
    if (Chat.ws) {
      Chat.ws.addEventListener("message", onPush);
      const oldClose = dlg.close;
      dlg.close = () => { Chat.ws.removeEventListener("message", onPush); oldClose(); };
    }
    return dlg;
  }

  // ── پریدن به تاریخ ──
  function openJumpToDate(channelId, startedAt) {
    // بازه‌ی مجاز: از روزِ ساخته‌شدنِ گفتگو تا امروز. رفتن به آینده یا به پیش از
    // شروعِ گفتگو همیشه بی‌نتیجه بود و فقط پیامِ خطا می‌داد.
    const minDate = startedAt ? new Date(Number(startedAt) * 1000) : null;
    const picker = persianDatePicker({ min: minDate, max: new Date() });
    // میان‌برهایِ پرکاربرد تا در حالتِ عادی اصلاً لازم نباشد با کشویی‌ها ور بروی
    const quick = [["امروز", 0], ["دیروز", 1], ["یک هفته پیش", 7], ["یک ماه پیش", 30]];
    const jump = async (at, close) => {
      close();
      const data = await wsAsk({ t: "history_around", channel: Number(channelId) || 0, at }, "history_around");
      if (!data || !data.anchor) return toast("پیامی برای آن تاریخ پیدا نشد.", "error");
      jumpToMessage(channelId, data.anchor);
    };
    const quickRow = h("div", { class: "nx-dt-quick" }, ...quick.map(([label, back]) =>
      h("button", { class: "nx-dt-chip", type: "button", onclick: () => {
        const d = new Date(); d.setDate(d.getDate() - back); d.setHours(0, 0, 0, 0);
        // میان‌بری که از شروعِ گفتگو عقب‌تر برود را به خودِ روزِ شروع می‌بریم.
        const at = minDate && d < minDate ? minDate : d;
        jump(Math.floor(at.getTime() / 1000), () => dlg.close());
      } }, h("span", { text: label }))));
    const dlg = sheetDialog("پریدن به تاریخ", [
      h("small", { class: "nx-gm-dim", text: "به اولین پیامِ آن روز می‌رویم." }),
      quickRow,
      h("label", { class: "nx-gm-field" }, h("span", { text: "یا یک تاریخِ دلخواه" }), picker.node),
    ], async () => {
      const at = Math.floor(picker.getDate().getTime() / 1000);
      dlg.close();
      const data = await wsAsk({ t: "history_around", channel: Number(channelId) || 0, at },
        "history_around");
      if (!data || !data.anchor) return toast("پیامی برای آن تاریخ پیدا نشد.", "error");
      jumpToMessage(channelId, data.anchor);
    });
  }

  // دیالوگِ کوچکِ چند-فیلدی (برایِ ساختِ لینکِ دعوت و مانندش)
  function sheetDialog(titleText, fields, onConfirm) {
    const scrim = h("div", { class: "nx-pop-scrim" });
    // فیلدها داخلِ ناحیه‌ی اسکرول‌شونده — پنجره max-height دارد ولی overflow نداشت،
    // پس فرمِ بلند (مثلِ ساختِ گروه) از کفِ کادر بیرون می‌ریخت.
    const pop = h("div", { class: "nx-sticker-pop nx-prompt-pop" },
      h("div", { class: "nx-sticker-pop-head" }, h("strong", { text: titleText }),
        h("button", { class: "nx-sticker-close", type: "button", title: "بستن",
          onclick: () => api.close() }, i("x", 14))),
      h("div", { class: "nx-sheet-body" }, ...fields),
      h("button", { class: "nx-button nx-primary", type: "button", text: "تأیید", onclick: () => onConfirm() }));
    const api = { close: () => { scrim.remove(); pop.remove(); document.removeEventListener("keydown", onEsc); } };
    const onEsc = (event) => { if (event.key === "Escape") api.close(); };
    document.addEventListener("keydown", onEsc);
    scrim.addEventListener("click", api.close);
    document.body.append(scrim, pop);
    return api;
  }

  // اختیاراتِ یک مدیرِ خاص — فقط مالک می‌بیند.
  function openAdminPermissions(group, mem) {
    const current = mem.permissions;
    const boxes = {};
    const fields = Object.keys(ADMIN_PERM_LABELS).map((key) => {
      const box = h("input", { type: "checkbox", class: "nx-gm-check" });
      box.checked = current ? !!current[key] : true;   // null = همه‌ی اختیارات
      boxes[key] = box;
      return h("label", { class: "nx-gm-toggle" },
        h("span", { class: "nx-gm-row-copy" }, h("strong", { text: ADMIN_PERM_LABELS[key] })), box);
    });
    const dlg = sheetDialog(`اختیاراتِ «${mem.username}»`, fields, () => {
      const permissions = {};
      Object.keys(boxes).forEach((key) => { permissions[key] = boxes[key].checked; });
      if (wsSend({ t: "set_member_permissions", group: group.id, username: mem.username, permissions })) {
        toast("اختیارات ذخیره شد.", "success");
      }
      dlg.close();
    });
  }

  async function inboxPage(root, initial = null) {
    const info = await call("chat_info").catch(() => null);
    const stage = socialShell(root, "social", info, true);
    root.classList.add("nx-inbox-route");
    if (!info || !info.logged_in) return loginRequired(stage);
    Messages._alive = true;
    onPageLeave(() => { Messages._alive = false; if (Messages.stopPoll) Messages.stopPoll(); });
    // بخشِ دائمیِ گروه‌ها/کانال‌ها — زیرِ جست‌وجویِ کاربر، همیشه دیده می‌شود (نه یه پاپ‌آپِ پنهان).
    // پروتکلِ کاملش قبلاً تویِ سرور (chat-server/chat.py) بود، فقط UIِ ساختن/پیوستن/سوییچ رو نداشتیم.
    // اتصال به گفتگویِ زنده مرحله‌ای است (WSِ باز شدن ≠ handshakeِ hello/welcome تمام‌شده)؛
    // Chat.connected فقط بعدِ اولین پیامِ سرور true می‌شود — تا اون موقع یه حالتِ لودینگ نشون می‌دیم.
    // (تعریفش عمداً همین‌جا، قبلِ ساختِ frame/model است — نقطه‌ی صدازدنش پایین‌تره، بعدِ model؛
    // چون const hoist نمی‌شود، تعریف باید همیشه قبلِ اولین صدازدن باشد وگرنه کلِ صفحه لود نمی‌شود.)
    // گروه‌ها/کانال‌ها دیگر یک آکاردئونِ جداگانه بالای فهرست نیستند (که هم جا می‌گرفت و هم
    // گفتگوها را به یک پنجره‌ی کوچکِ اسکرول‌شونده می‌فشرد)؛ حالا مستقیم داخلِ همان یک فهرستِ
    // گفتگوها رندر می‌شوند. این تکه فقط داده را از WS می‌گیرد و renderList را صدا می‌زند.
    const buildGroupsModel = (onChange) => {
      const state = { ready: false };
      const onMsg = (event) => {
        let data; try { data = JSON.parse(event.data); } catch (_) { return; }
        if (data.t === "groups" || data.t === "group_created" || data.t === "channel_created" || data.t === "group_joined") onChange();
        else if (data.t === "error" && frame.isConnected) toast(data.msg || "خطا", "error");
      };
      let listening = false;
      const ready = () => Chat.ws && Chat.ws.readyState === 1 && Chat.connected;
      const proceed = () => {
        if (!frame.isConnected || listening) return;
        listening = true;
        state.ready = true;
        Chat.ws.addEventListener("message", onMsg);
        onChange();
        // فرمانِ سرور برایِ فهرستِ گروه‌ها/کانال‌ها «groups» است، نه «list» (ر.ک. chat-server/chat.py).
        // با نامِ اشتباه سرور هیچ پاسخی نمی‌داد و Chat.groups همیشه خالی می‌ماند — برایِ همین نه
        // گروهی تو فهرست دیده می‌شد و نه «کانالِ جدید» گروهی برایِ انتخاب پیدا می‌کرد.
        Chat.ws.send(JSON.stringify({ t: "groups" }));
      };
      if (ready()) proceed();
      const waitTimer = setInterval(() => {
        if (!frame.isConnected) { clearInterval(waitTimer); return; }
        if (ready()) { proceed(); clearInterval(waitTimer); }
      }, 400);
      const stop = () => { clearInterval(waitTimer); if (listening && Chat.ws) Chat.ws.removeEventListener("message", onMsg); };
      return { state, refresh: () => { if (listening) onChange(); }, stop };
    };

    const buildChatCreateMenu = () => {
      // دکمه‌ی «گفتگوی جدید» حالا داخلِ هدرِ فهرست است، نه یک FABِ شناور که روی ردیف‌های
      // پایینِ فهرست می‌افتاد و آن‌ها را می‌پوشاند.
      const fab = h("button", {
        class: "nx-inbox-new",
        type: "button",
        title: "گفتگوی جدید",
        "aria-label": "ساخت گروه یا کانال",
        "aria-expanded": "false",
      }, i("plus", 17), h("span", { text: "جدید" }));
      const menu = h("div", { class: "nx-chat-create-menu" });
      const overlay = h("div", {
        class: "nx-chat-create-overlay",
        hidden: true,
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "ساخت گروه یا کانال",
      },
      h("section", { class: "nx-chat-create-page" },
        h("button", {
          class: "nx-chat-create-close",
          type: "button",
          title: "بستن",
          "aria-label": "بستن",
          onclick: () => close(),
        }, i("x", 18)),
        menu));
      const send = (payload) => {
        if (!Chat.ws || Chat.ws.readyState !== 1) {
          toast("هنوز به سرویس گفتگو وصل نشده‌ای", "error");
          return false;
        }
        Chat.ws.send(JSON.stringify(payload));
        return true;
      };
      const close = () => {
        overlay.hidden = true;
        fab.classList.remove("is-open");
        fab.setAttribute("aria-expanded", "false");
      };
      const menuItem = (iconName, title, subtitle, onclick) => h("button", {
        class: "nx-chat-create-item",
        type: "button",
        onclick,
      },
      h("span", { class: "nx-chat-create-icon" }, i(iconName, 18)),
      h("span", { class: "nx-chat-create-copy" }, h("strong", { text: title }), h("small", { text: subtitle })),
      i("chevronLeft", 15));
      // کانالِ مستقل — هیچ گروهی لازم نیست.
      const createChannel = () => { close(); openCreateForm("channel"); };
      // ساختِ گروه/کانال مثلِ تلگرام مرحله‌به‌مرحله است: اول هویت (عکس/نام/توضیحات)،
      // بعد نوع و لینک. یک‌جا ریختنِ همه‌ی فیلدها کادر را شلوغ و طولانی می‌کرد.
      const openCreateForm = (kind) => {
        const isChan = kind === "channel";
        const word = isChan ? "کانال" : "گروه";
        const STEPS = [`${word}ِ جدید`, `نوعِ ${word}`];
        let step = 0;
        let photoUrl = null;
        let isPublic = false;

        // ── مرحله ۱: هویت ──
        const photoPreview = h("div", { class: "nx-gm-photo nx-gm-photo-edit" }, i("image", 26));
        const pickPhoto = async () => {
          const file = await pickImageFile(); if (!file) return;
          try {
            const dataUrl = await compressImageFile(file);
            const uploaded = await call("chat_upload", { data: dataUrl, kind: "image", name: file.name });
            photoUrl = uploaded.url;
            clear(photoPreview, h("img", { src: avatarUrl(photoUrl), alt: "" }));
          } catch (error) { toast("بارگذاریِ عکس نشد: " + error, "error"); }
        };
        photoPreview.addEventListener("click", pickPhoto);
        const nameInput = h("input", { class: "nx-gm-input", maxlength: "40",
          placeholder: isChan ? "نامِ کانال" : "نامِ گروه" });
        const aboutInput = h("textarea", { class: "nx-gm-input nx-gm-textarea", maxlength: "255", rows: "3",
          placeholder: `این ${word} درباره‌ی چیست؟` });
        const stepOne = () => h("div", { class: "nx-wiz-step" },
          h("div", { class: "nx-gm-photo-pick nx-create-photo" }, photoPreview,
            button("انتخابِ عکس", "upload", "ghost", pickPhoto)),
          h("label", { class: "nx-gm-field" }, h("span", { text: `نامِ ${word}` }), nameInput),
          h("label", { class: "nx-gm-field" }, h("span", { text: "توضیحات (اختیاری)" }), aboutInput));

        // ── مرحله ۲: نوع و لینک ──
        const handleInput = h("input", { class: "nx-gm-input", maxlength: "32", dir: "ltr",
          placeholder: "mihansquad", disabled: true });
        const handleField = h("label", { class: "nx-gm-field nx-create-handle" },
          h("span", { text: "@" }), handleInput);
        let typeRows = [];
        const syncType = () => {
          handleInput.disabled = !isPublic;
          handleField.classList.toggle("is-off", !isPublic);
          typeRows.forEach((r) => r.el.classList.toggle("is-on", r.value === isPublic));
        };
        const typeRow = (value, glyph, title, desc) => {
          const el = h("button", { class: "nx-create-type", type: "button",
            onclick: () => { isPublic = value; syncType(); } },
            h("span", { class: "nx-gm-row-icon" }, i(glyph, 17)),
            h("span", { class: "nx-gm-row-copy" }, h("strong", { text: title }), h("small", { text: desc })),
            h("i", { class: "nx-create-tick" }, i("check", 14)));
          return { el, value };
        };
        const stepTwo = () => {
          typeRows = [
            typeRow(false, "lock", `${word}ِ خصوصی`, "فقط با لینکِ دعوت می‌شود عضو شد"),
            typeRow(true, "globe", `${word}ِ عمومی`, "هر کسی می‌تواند پیدایش کند و عضو شود"),
          ];
          const node = h("div", { class: "nx-wiz-step" },
            ...typeRows.map((r) => r.el),
            h("div", { class: "nx-gm-section" }, h("strong", { text: "لینکِ عمومی" })),
            handleField,
            h("p", { class: "nx-gm-hint", text: "بدونِ لینک هم می‌توانی بسازی و بعداً اضافه کنی." }));
          syncType();
          return node;
        };

        const create = async () => {
          const name = nameInput.value.trim();
          const handle = handleInput.value.trim().replace(/^@/, "");
          // باید دقیقاً با USERNAME_RE سمتِ سرور یکی باشد (۵ تا ۳۲ نویسه، شروع با حرف).
          // قبلاً این‌جا {4,32} بود و شروع با عدد را هم می‌پذیرفت، پس هندلی مثلِ «1abc»
          // از این‌جا رد می‌شد و بعد سرور با پیامِ دیگری ردش می‌کرد.
          if (isPublic && handle && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(handle)) {
            return toast("هندل باید ۵ تا ۳۲ نویسه‌ی انگلیسی/عدد/زیرخط باشد و با حرف شروع شود.", "error");
          }
          api.close();
          const created = await wsAsk(
            isChan ? { t: "create_group", name, kind: "channel" } : { t: "create_group", name },
            "group_created");
          if (!created || !created.group) return toast(`${word} ساخته نشد.`, "error");
          const info = { t: "set_group_info", group: created.group, name, about: aboutInput.value.trim() };
          if (photoUrl) info.photo = photoUrl;
          if (isPublic && handle) info.username = handle;
          wsSend(info);
          if (isPublic) wsSend({ t: "set_group_public", group: created.group, is_public: true });
          toast(`${word}ِ «${name}» ساخته شد 🎉`, "success");
        };

        // ── قابِ ویزارد ──
        const title = h("strong", { text: STEPS[0] });
        const bodyBox = h("div", { class: "nx-sheet-body" });
        const dots = h("div", { class: "nx-wiz-dots" },
          ...STEPS.map(() => h("i", { class: "nx-wiz-dot" })));
        const backBtn = h("button", { class: "nx-button", type: "button", text: "برگشت", hidden: true });
        const nextBtn = h("button", { class: "nx-button nx-primary", type: "button", text: "بعدی" });
        const render = () => {
          title.textContent = STEPS[step];
          clear(bodyBox, step === 0 ? stepOne() : stepTwo());
          [...dots.children].forEach((d, idx) => d.classList.toggle("is-on", idx <= step));
          backBtn.hidden = step === 0;
          nextBtn.textContent = step === STEPS.length - 1 ? `ساختِ ${word}` : "بعدی";
          if (step === 0) setTimeout(() => nameInput.focus(), 40);
        };
        backBtn.addEventListener("click", () => { if (step > 0) { step--; render(); } });
        nextBtn.addEventListener("click", () => {
          if (step === 0) {
            // نام تنها چیزِ اجباری است؛ جلوترنرفتن بدونِ آن یعنی گروهِ بی‌نام
            if (nameInput.value.trim().length < 2) return toast(`نامِ ${word} حداقل ۲ حرف باشد.`, "error");
            step = 1; render(); return;
          }
          create();
        });

        const scrim = h("div", { class: "nx-pop-scrim" });
        const pop = h("div", { class: "nx-sticker-pop nx-prompt-pop nx-wiz-pop" },
          h("div", { class: "nx-sticker-pop-head" }, title,
            h("button", { class: "nx-sticker-close", type: "button", title: "بستن",
              onclick: () => api.close() }, i("x", 14))),
          dots, bodyBox,
          h("div", { class: "nx-wiz-actions" }, backBtn, nextBtn));
        const api = { close: () => { scrim.remove(); pop.remove(); document.removeEventListener("keydown", onEsc); } };
        const onEsc = (event) => { if (event.key === "Escape") api.close(); };
        document.addEventListener("keydown", onEsc);
        scrim.addEventListener("click", api.close);
        document.body.append(scrim, pop);
        render();
      };
      const createGroup = () => { close(); openCreateForm("group"); };
      const renderMain = () => {
        clear(menu,
          h("div", { class: "nx-chat-create-head" },
            h("strong", { text: "گفتگوی جدید" }),
            h("small", { text: "چه چیزی می‌خواهی بسازی؟" })),
          menuItem("users", "گروه جدید", "گفتگوی چندنفره — همه پیام می‌دهند", createGroup),
          // کانال دیگر به گروه وابسته نیست: سرور با kind:"channel" یک کانالِ مستقل می‌سازد.
          // قبلاً این‌جا اجبار می‌کرد «اول یک گروه بساز» که هیچ دلیلِ کاربردی نداشت.
          menuItem("megaphone", "کانال جدید", "انتشار برای دنبال‌کننده‌ها — فقط تو می‌نویسی", createChannel),
          // ساختِ پوشه از دکمه‌ی ریزِ کنارِ تب‌ها به این‌جا آمد — آن‌جا یک «+»ِ
          // ۱۳ پیکسلیِ بی‌برچسب بود که عملاً کسی پیدایش نمی‌کرد.
          menuItem("folder", "پوشه‌ی جدید", "گفتگوها را دسته‌بندی کن", () => {
            close();
            promptDialog("پوشه‌ی جدید", "نامِ پوشه", (name) => wsSend({ t: "create_folder", name }));
          }),
          menuItem("link", "ورود با کد دعوت", "پیوستن با کدی که گرفته‌ای", () => {
            close();
            promptDialog("پیوستن با کدِ دعوت", "کد دعوت را وارد کن", (token) => send({ t: "join_by_invite", token }));
          }),
          // «کانال داخلِ یک گروه» کاملاً برداشته شد: کانال یک گفتگویِ مستقل است،
          // نه زیرمجموعه‌ی گروه. نگه‌داشتنش فقط دو مفهومِ موازیِ گیج‌کننده می‌ساخت.
          );
      };
      fab.addEventListener("click", () => {
        const open = overlay.hidden;
        if (open) renderMain();
        overlay.hidden = !open;
        fab.classList.toggle("is-open", open);
        fab.setAttribute("aria-expanded", String(open));
      });
      const onKey = (event) => { if (event.key === "Escape") close(); };
      document.addEventListener("keydown", onKey);
      const stop = () => {
        document.removeEventListener("keydown", onKey);
      };
      return { trigger: fab, overlay, stop };
    };

    const frame = h("div", { class: "nx-messenger nx-chat-hub" });
    const sidebar = h("aside", { class: "nx-inbox" });
    const conversation = h("section", { class: "nx-conversation" });
    const search = h("input", { class: "nx-inbox-search", placeholder: "جست‌وجوی گفتگو یا بازیکن…", "aria-label": "جست‌وجوی گفتگو" });
    const list = h("div", { class: "nx-inbox-list" }, loading("گفتگوها…"));
    const searchBox = h("label", { class: "nx-inbox-searchbox" }, i("search", 16), search);
    const model = { filter: "all", selected: null, threads: [], friends: [], search: [], liveUnread: 0, liveSeenCount: Chat.msgs.length };
    // فیلترِ افقی جایگزینِ بخش‌های تودرتوی قبلی شد: یک فهرست، سه نما.
    // نوارِ فیلتر دیگر ثابت نیست: پوشه‌هایِ کاربر و «آرشیو» هم به آن اضافه می‌شوند (سبکِ تلگرام)،
    // پس هر بار که پوشه‌ها عوض شوند دوباره ساخته می‌شود.
    const filters = h("div", { class: "nx-inbox-filters", role: "tablist" });
    model.org = { folders: [], prefs: [] };
    const prefOf = (kind, target) => model.org.prefs.find(
      (p) => p.kind === kind && String(p.target).toLowerCase() === String(target).toLowerCase()) || null;
    const renderFilters = () => {
      const tabs = [["all", "همه"], ["private", "مستقیم"], ["groups", "گروه‌ها"]];
      model.org.folders.forEach((f) => tabs.push(["folder:" + f.id, f.name]));
      const archivedCount = model.org.prefs.filter((p) => p.archived).length;
      if (archivedCount) tabs.push(["archive", `آرشیو (${archivedCount})`]);
      // اگر پوشه‌ی فعال حذف شده باشد، به «همه» برگرد وگرنه فهرست خالی می‌ماند بدونِ توضیح.
      if (!tabs.some(([id]) => id === model.filter)) model.filter = "all";
      clear(filters, ...tabs.map(([id, label]) => {
        const isFolder = String(id).startsWith("folder:");
        const tab = h("button", {
          class: "nx-inbox-filter" + (model.filter === id ? " is-active" : ""),
          type: "button", role: "tab", "aria-selected": model.filter === id ? "true" : "false",
          onclick: (event) => {
            // کلیکِ دوباره روی پوشه‌ی همین‌حالا-فعال = بازکردنِ منویِ نام/حذف.
            if (isFolder && model.filter === id) return openFolderMenu(event);
            model.filter = id; renderFilters(); renderList();
          },
        }, h("span", { class: "nx-inbox-filter-label", text: label }));
        let openFolderMenu = () => {};
        // تغییرِ نام/حذفِ پوشه — سرور هر دو را دارد ولی هیچ راهی برایِ رسیدن به آن‌ها نبود،
        // یعنی پوشه‌ی ساخته‌شده برایِ همیشه می‌ماند. مثلِ تلگرام رویِ خودِ تبِ پوشه است.
        if (String(id).startsWith("folder:")) {
          const fid = Number(String(id).slice(7));
          tab.title = "برایِ تغییرِ نام یا حذف، روی همین تب دوباره بزن";
          // تبِ فعال یک آیکونِ ✎ نشان می‌دهد و کلیکِ دوباره منو را باز می‌کند — راست‌کلیک
          // به‌تنهایی نامرئی بود و کسی پیدایش نمی‌کرد.
          // مداد قبلاً چسبیده به متن بود و نامِ پوشه را هل می‌داد؛ حالا در جایگاهِ
          // ثابتِ خودش کنارِ لبه‌ی تب می‌نشیند تا متن مستقل از آن کوتاه شود.
          if (model.filter === id) {
            tab.classList.add("has-manage");
            const manage = h("span", { class: "nx-inbox-filter-manage", title: "تغییرِ نام یا حذفِ پوشه" }, i("pencil", 11));
            tab.appendChild(manage);
          }
          openFolderMenu = (event) => {
            if (event && event.preventDefault) event.preventDefault();
            const row = (text, glyph, run) => h("button", { class: "nx-gm-row", type: "button", onclick: run },
              h("span", { class: "nx-gm-row-icon" }, i(glyph, 16)),
              h("span", { class: "nx-gm-row-copy" }, h("strong", { text })));
            const dlg = sheetDialog(label, [
              row("تغییرِ نامِ پوشه", "pencil", () => {
                dlg.close();
                promptDialog("نامِ تازه‌ی پوشه", "نامِ پوشه", (name) => wsSend({ t: "rename_folder", id: fid, name }));
              }),
              // گفتگوها پاک نمی‌شوند؛ فقط همین دسته‌بندی برداشته می‌شود.
              row("حذفِ پوشه", "trash", () => { dlg.close(); wsSend({ t: "delete_folder", id: fid }); }),
            ], () => dlg.close());
          };
          tab.addEventListener("contextmenu", openFolderMenu);   // میان‌بر، نه تنها راه
        }
        return tab;
      }),
      );
    };
    // پوشه‌ها/وضعیت‌ها روی همان WSِ مشترک می‌آیند و با هر تغییری دوباره پخش می‌شوند.
    const buildOrgModel = () => {
      const onMsg = (event) => {
        let data; try { data = JSON.parse(event.data); } catch (_) { return; }
        if (data.t !== "chat_org") return;
        model.org = { folders: data.folders || [], prefs: data.prefs || [] };
        renderFilters(); renderList();
      };
      let attached = false;
      const tryAttach = () => {
        if (attached || !frame.isConnected) return;
        const ws = wsLive();
        if (!ws || !Chat.connected) return;
        attached = true;
        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ t: "list_chat_org" }));
      };
      tryAttach();
      const timer = setInterval(() => { if (!frame.isConnected) { clearInterval(timer); return; } tryAttach(); }, 500);
      return { stop: () => { clearInterval(timer); if (attached && Chat.ws) Chat.ws.removeEventListener("message", onMsg); } };
    };
    const groupsModel = buildGroupsModel(() => renderList());
    const orgModel = buildOrgModel();
    renderFilters();
    const createMenu = buildChatCreateMenu();
    // بعد از createMenu ساخته می‌شود: const تا خطِ تعریفش در TDZ است و ارجاعِ زودتر
    // ReferenceError می‌دهد.
    const inboxHead = h("header", { class: "nx-inbox-head" }, h("h2", { text: "گفتگوها" }), createMenu.trigger);
    onPageLeave(groupsModel.stop);
    onPageLeave(orgModel.stop);
    onPageLeave(createMenu.stop);
    // عنوان + جست‌وجو + تب‌ها یک واحدند و مثلِ هدرِ سایت‌ها روی لیست شناورند:
    // با اسکرولِ پایین کاملاً به بالا سُر می‌خورند و با اسکرولِ بالا برمی‌گردند.
    // جمع‌کردنِ ارتفاع را کنار گذاشتیم چون خودِ لیست را هم بالا/پایین می‌پراند.
    const headWrap = h("div", { class: "nx-inbox-headwrap" }, inboxHead, searchBox, filters);
    let _lastTop = 0, _tucked = false;
    // فضایِ زیرِ هدر با padding نگه داشته می‌شود تا اولین گفتگو زیرِ هدر پنهان نشود.
    // ⚠️ یک‌بار اندازه‌گیری کافی نیست: نوارِ فیلترها بعداً (وقتی پوشه‌هایِ
    // کاربر می‌رسند) بلندتر می‌شود و هدر رویِ ردیف‌ها می‌افتاد. با ResizeObserver
    // هر تغییرِ ارتفاع فوراً در padding منعکس می‌شود.
    const measureHead = () => {
      const full = headWrap.offsetHeight;
      if (full) {
        list.style.paddingTop = full + "px";
        headWrap.style.setProperty("--nx-head-h", full + "px");
      }
    };
    requestAnimationFrame(measureHead);
    if ("ResizeObserver" in window) {
      const ro = new ResizeObserver(measureHead);
      ro.observe(headWrap);
      onPageLeave(() => ro.disconnect());
    } else {
      window.addEventListener("resize", measureHead);
      onPageLeave(() => window.removeEventListener("resize", measureHead));
    }
    const setTuck = (on) => {
      if (on === _tucked) return;
      _tucked = on;
      headWrap.classList.toggle("is-tucked", on);
    };
    list.addEventListener("scroll", () => {
      const top = list.scrollTop;
      // آستانه‌ی کوچک تا لرزشِ اسکرول باعثِ پرش نشود
      if (Math.abs(top - _lastTop) < 12) return;
      setTuck(top > _lastTop && top > 24);
      _lastTop = top;
    }, { passive: true });
    sidebar.append(headWrap, list);
    frame.append(sidebar, conversation, createMenu.overlay); stage.appendChild(frame);
    const welcome = () => h("div", { class: "nx-conversation-blank" },
      h("span", { class: "nx-welcome-icon" }, i("messageSquare", 28)),
      h("h2", { text: "یک گفتگو را انتخاب کن" }),
      h("p", { text: "گفتگوها و کانال‌ها سمتِ راست هستند؛ برای شروعِ گفتگوی تازه نامِ بازیکن را جست‌وجو کن." }),
      h("div", { class: "nx-welcome-actions" },
        h("button", { class: "nx-welcome-primary", type: "button", onclick: () => openLive(0) }, i("globe", 17), h("span", { text: "چتِ همگانی" })),
        h("button", { class: "nx-welcome-secondary", type: "button", onclick: () => search.focus() }, i("search", 17), h("span", { text: "جست‌وجوی بازیکن" }))));
    let stopConversation = () => {};
    const cleanupConversation = () => { stopConversation(); stopConversation = () => {}; };
    const mobileBack = () => { cleanupConversation(); frame.classList.remove("has-open"); model.selected = null; renderList(); groupsModel.refresh(); clear(conversation, welcome()); };
    onPageLeave(cleanupConversation);

    const scrollLatest = (list, force = false) => {
      const apply = () => {
        if (!list.isConnected) return;
        if (force || list.scrollHeight - list.scrollTop - list.clientHeight < 130) list.scrollTop = list.scrollHeight;
      };
      apply(); requestAnimationFrame(() => { apply(); requestAnimationFrame(apply); });
    };
    const keepFocus = (input) => {
      try { input.focus({ preventScroll: true }); } catch (_) { input.focus(); }
    };
    // فایل‌هایِ بزرگ (تا ۵۰۰ مگ برایِ پرو) هرگز نباید یک‌جا base64 بشن (فشارِ حافظه + IPC) —
    // به تکه‌هایِ ۴ مگابایتی می‌شکنیم و هر تکه را جدا با chat_file_chunk می‌فرستیم.
    const arrayBufferToBase64 = (buf) => {
      const bytes = new Uint8Array(buf);
      let binary = "";
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      return btoa(binary);
    };
    const uploadLargeFile = async (file, onProgress) => {
      const uploadId = (self.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, "") : String(Date.now()) + Math.random().toString(36).slice(2);
      const chunkSize = 4 * 1024 * 1024;
      try {
        for (let offset = 0; offset < file.size; offset += chunkSize) {
          const slice = file.slice(offset, offset + chunkSize);
          const buf = await slice.arrayBuffer();
          await invoke("chat_file_chunk", { uploadId, chunkB64: arrayBufferToBase64(buf) });
          if (onProgress) onProgress(Math.min(1, (offset + slice.size) / file.size));
        }
        return await invoke("chat_file_finish", { uploadId, fileName: file.name });
      } catch (error) {
        invoke("chat_file_abort", { uploadId }).catch(() => {});
        throw error;
      }
    };
    const fmtBytes = (n) => { n = +n || 0; if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`; return `${(n / 1048576).toFixed(1)} MB`; };
    const fmtDur = (s) => { s = Math.max(0, +s || 0); const m = Math.floor(s / 60), r = s % 60; return `${m}:${String(r).padStart(2, "0")}`; };
    // فیلدهایِ رسانه در DM (روی خودِ text/vdur) و در چتِ زنده (داخلِ extra) شکلِ متفاوتی دارند؛
    // این تابع هر دو را به یک شکلِ یکسان درمی‌آورد.
    const mediaMeta = (message, live) => live
      ? { url: (message.extra && message.extra.media) || "", name: (message.extra && message.extra.name) || "", size: (message.extra && message.extra.size) || 0, duration: (message.extra && message.extra.duration) || 0 }
      : { url: message.text || "", name: "", size: 0, duration: message.vdur || 0 };
    const messageText = (message, live = false) => {
      if ((message.kind || "text") === "poll") return "📊 نظرسنجی";
      return String(message.text || (live && message.extra && message.extra.text) || "");
    };
    // بدنه‌ی واقعیِ پیام: عکس/ویدیو/ویس/فایل به‌صورتِ رسانه‌ی قابل‌پخش، نه فقط متنِ جایگزین.
    const messageBody = (message, live) => {
      const kind = message.kind || "text";
      // پستِ به‌اشتراک‌گذاشته‌شده: سرور پیش‌نمایشش را در message.post می‌فرستد ولی
      // کلاینت هیچ‌وقت رندرش نمی‌کرد و فقط یک حبابِ خالی می‌ماند. حالا همان کارتِ
      // فید را می‌سازد و کلیک رویش پست را در کشف باز می‌کند.
      if (kind === "post" && message.post) {
        const pv = message.post;
        if (pv.deleted) return h("p", { class: "nx-dm-post-gone", text: "این پست پاک شده است." });
        const media = avatarUrl(pv.image);
        const cardEl = h("button", { class: "nx-dm-post", type: "button",
          title: "بازکردنِ این پست",
          onclick: () => openSharedPost(pv.id) },
          h("span", { class: "nx-dm-post-head" },
            avatar(pv.username, null, 24),
            h("strong", { text: pv.username })),
          // پستِ ویدیویی باید ویدیو نشان دهد، نه <img>ِ خراب.
          pv.video ? h("video", { class: "nx-dm-post-img", src: avatarUrl(pv.video),
                                  muted: true, playsinline: true, preload: "metadata" })
            : (media ? h("img", { class: "nx-dm-post-img" + (pv.sensitive ? " is-sensitive" : ""),
                                  src: media, alt: "", loading: "lazy" }) : null),
          pv.text ? h("span", { class: "nx-dm-post-text", text: pv.text.slice(0, 180) }) : null,
          h("span", { class: "nx-dm-post-cta" }, i("chevronLeft", 13), h("span", { text: "دیدنِ پست" })));
        return cardEl;
      }
      if (kind === "image" || kind === "gif") {
        const { url } = mediaMeta(message, live);
        const img = h("img", { class: "nx-chat-media-img" + (kind === "gif" ? " nx-chat-sticker-img" : ""), src: avatarUrl(url), alt: "", loading: "lazy" });
        img.addEventListener("click", () => openImageOverlay(avatarUrl(url)));
        return img;
      }
      if (kind === "video") {
        const { url } = mediaMeta(message, live);
        return h("video", { class: "nx-chat-media-video", src: avatarUrl(url), controls: true, preload: "metadata" });
      }
      // پیامِ ویدیوییِ گِرد — در تلگرام بی‌صدا شروع می‌شود و با کلیک صدا می‌گیرد.
      if (kind === "videonote") {
        const { url, duration } = mediaMeta(message, live);
        const video = h("video", { class: "nx-chat-videonote", src: avatarUrl(url),
          muted: true, loop: true, autoplay: true, playsinline: true, preload: "metadata" });
        video.addEventListener("click", () => { video.muted = !video.muted; video.classList.toggle("is-live", !video.muted); });
        return h("div", { class: "nx-chat-videonote-wrap" }, video,
          duration ? h("small", { class: "nx-chat-videonote-dur", text: fmtDur(duration) }) : null);
      }
      if (kind === "voice") {
        const { url, duration } = mediaMeta(message, live);
        return h("div", { class: "nx-chat-voice" }, i("mic", 15), h("audio", { src: avatarUrl(url), controls: true }), duration ? h("small", { text: fmtDur(duration) }) : null);
      }
      if (kind === "file") {
        const { url, name, size } = mediaMeta(message, live);
        return h("a", { class: "nx-chat-file", href: avatarUrl(url), target: "_blank", rel: "noreferrer" },
          i("file", 17), h("span", {}, h("strong", { text: name || "فایل" }), size ? h("small", { text: fmtBytes(size) }) : null), i("download", 15));
      }
      // پیامِ تماس: سرور فقط نشانه‌ی [[call:CODE]] را ذخیره می‌کند. رابطِ قدیمی آن را
      // به کارتِ تماس تبدیل می‌کرد ولی این رابط نه، پس کاربر متنِ خام را می‌دید.
      const raw = messageText(message, live);
      const call = /^\s*\[\[call:([A-Za-z0-9]{4,24})\]\]\s*$/.exec(String(raw || ""));
      if (call) {
        const join = h("button", { class: "nx-call-join", type: "button",
          onclick: () => { if (joinDmCall) joinDmCall(call[1]); } }, i("phone", 14), h("span", { text: "پیوستن به تماس" }));
        return h("div", { class: "nx-call-card" },
          h("span", { class: "nx-call-icon" }, i("phone", 17)),
          h("span", { class: "nx-call-copy" },
            h("strong", { text: "تماسِ صوتی" }),
            h("small", { text: "کد: " + call[1] })),
          join);
      }
      return h("p", {}, richText(raw));
    };
    const findMessageNode = (id) => {
      if (!id) return null;
      return Array.from(document.querySelectorAll(".nx-chat-message[data-message-id]"))
        .find((node) => node.getAttribute("data-message-id") === String(id)) || null;
    };
    const revealReplyTarget = (reply) => {
      const target = findMessageNode(reply && (reply.to || reply.id));
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.remove("is-reply-ping");
      requestAnimationFrame(() => {
        target.classList.add("is-reply-ping");
        setTimeout(() => target.classList.remove("is-reply-ping"), 1500);
      });
    };
    const replyQuote = (message) => {
      if (!message.reply) return null;
      const canJump = !!findMessageNode(message.reply.to || message.reply.id);
      return h("button", {
        class: "nx-chat-reply-quote" + (canJump ? " is-clickable" : ""),
        type: "button",
        disabled: !canJump,
        title: canJump ? "رفتن به پیام اصلی" : "",
        onclick: () => revealReplyTarget(message.reply),
      },
      h("span", { class: "nx-chat-reply-quote-icon" }, i("reply", 14)),
      h("span", { class: "nx-chat-reply-quote-copy" },
        h("strong", { text: `پاسخ به ${message.reply.from || "پیام"}` }),
        h("small", { text: message.reply.text || "پیام رسانه‌ای" })),
      canJump ? i("chevronLeft", 13) : null);
    };

    // پاپ‌آپ‌ها (استیکر/گروه‌ها/...) پیش‌فرض وسطِ صفحه‌اند (ر.ک. CSSِ nx-sticker-pop)؛ وقتی یک دکمه‌ی
    // anchor داریم، همین‌جا نزدیکِ همان دکمه جابه‌جا می‌شود — وگرنه (بدونِ anchor) همون وسط می‌ماند
    // که خودش دقیقاً شکلِ درستِ یه دیالوگِ ساده‌ی متنی (مثلِ promptDialog) است.
    const positionPopoverNear = (pop, anchorEl) => {
      if (!anchorEl) return;
      requestAnimationFrame(() => {
        if (!pop.isConnected) return;
        const r = anchorEl.getBoundingClientRect();
        const pr = pop.getBoundingClientRect();
        let top = r.bottom + 10;
        if (top + pr.height > window.innerHeight - 10) top = Math.max(10, r.top - pr.height - 10);
        let end = window.innerWidth - r.right;
        if (end + pr.width > window.innerWidth - 10) end = Math.max(10, window.innerWidth - pr.width - 10);
        pop.style.transform = "none";
        pop.style.top = top + "px";
        // end از لبه‌ی راستِ پنجره اندازه گرفته شده، پس باید روی rightِ فیزیکی بنشیند؛
        // insetInlineEnd زیرِ dir=rtlِ body به left ترجمه می‌شد و پاپ‌آپ را آینه می‌کرد.
        pop.style.left = "auto";
        pop.style.right = end + "px";
      });
    };

    // اموجی/استیکرِ ویدیویی-عکسی: کتابخانه‌ی سراسری (gif_library) روی همان WSِ گفتگوی زنده زندگی
    // می‌کند؛ برایِ همین حتی از داخلِ DM هم با همان Chat.ws پرس‌وجو می‌شود.
    //
    // ── سوییچِ موقتِ اموجیِ اختصاصیِ کانال ──
    // از رابطِ کاربری برداشته شده و دیگر جزوِ امتیازهایِ پرو تبلیغ نمی‌شود. هیچ کدی حذف
    // نشده: دکمه‌ی ساخت، آپلود و مسیرِ add_gif با scope="channel" همگی دست‌نخورده‌اند و
    // با true شدنِ همین یک ثابت دقیقاً برمی‌گردند. سمتِ سرور (chat.py) هم دست نخورده،
    // پس اموجی‌هایِ اختصاصیِ ساخته‌شده‌ی قبلی همچنان نمایش داده می‌شوند.
    const CUSTOM_EMOJI_ENABLED = false;

    const openStickerPicker = (anchorBtn, onPick) => {
      if (!Chat.ws || Chat.ws.readyState !== 1) return toast("برایِ اموجی باید به گفتگویِ زنده وصل باشی", "error");
      const grid = h("div", { class: "nx-sticker-grid" }, loading("در حالِ بارگذاریِ اموجی‌ها…"));
      const closeBtn = h("button", { class: "nx-sticker-close", type: "button", title: "بستن" }, i("x", 14));
      // ── تبِ اموجی: صفحه‌کلیدِ کاملِ یونیکد (همان‌هایی که آیفون نشان می‌دهد) ──
      const emojiPane = h("div", { class: "nx-emoji-pane" });
      const emojiSearch = h("input", { class: "nx-gm-input nx-emoji-search", placeholder: "جست‌وجوی اموجی…" });
      const emojiGrid = h("div", { class: "nx-emoji-grid" });
      const renderEmoji = (filter) => {
        clear(emojiGrid);
        const data = _emojiData;
        if (!data) { emojiGrid.appendChild(loading("در حالِ بارگذاریِ اموجی‌ها…")); return; }
        const needle = String(filter || "").trim();
        data.groups.forEach(([label, cells]) => {
          const hit = needle ? (label.includes(needle) ? cells : []) : cells;
          if (!hit.length) return;
          emojiGrid.appendChild(h("div", { class: "nx-emoji-cat", text: label }));
          hit.forEach((cell) => {
            const b = h("button", { class: "nx-emoji-cell", type: "button", title: cell.ch },
              emojiSprite(cell, 26));
            b.addEventListener("click", () => { onPick({ emoji: cell.ch }); close(); });
            emojiGrid.appendChild(b);
          });
        });
        if (!emojiGrid.children.length) emojiGrid.appendChild(h("p", { class: "nx-gm-hint", text: "چیزی پیدا نشد." }));
      };
      loadEmojiData().then(() => renderEmoji(emojiSearch.value.trim()));
      emojiSearch.addEventListener("input", () => renderEmoji(emojiSearch.value.trim()));
      emojiPane.append(emojiSearch, emojiGrid);
      const gifPane = h("div", { class: "nx-gif-pane" }, grid);
      gifPane.hidden = true;
      const tabEmoji = h("button", { class: "nx-sticker-tab is-active", type: "button", text: "اموجی" });
      const tabGif = h("button", { class: "nx-sticker-tab", type: "button", text: "گیف و استیکر" });
      const showPane = (which) => {
        const isEmoji = which === "emoji";
        emojiPane.hidden = !isEmoji; gifPane.hidden = isEmoji;
        tabEmoji.classList.toggle("is-active", isEmoji);
        tabGif.classList.toggle("is-active", !isEmoji);
        if (isEmoji) setTimeout(() => emojiSearch.focus(), 30);
      };
      tabEmoji.addEventListener("click", () => showPane("emoji"));
      tabGif.addEventListener("click", () => showPane("gif"));
      renderEmoji("");
      const pop = h("div", { class: "nx-sticker-pop nx-emoji-pop" },
        h("div", { class: "nx-sticker-pop-head" },
          h("div", { class: "nx-sticker-tabs" }, tabEmoji, tabGif), closeBtn),
        emojiPane, gifPane);
      const close = () => { Chat.ws.removeEventListener("message", onMsg); document.removeEventListener("keydown", onEsc); pop.remove(); };
      const onEsc = (event) => { if (event.key === "Escape") close(); };
      closeBtn.addEventListener("click", close);
      document.addEventListener("keydown", onEsc);
      const onMsg = (event) => {
        let data; try { data = JSON.parse(event.data); } catch (_) { return; }
        if (data.t === "gif_results") {
          clear(grid, ...data.gifs.map((g) => {
            const ext = (g.url.split(".").pop() || "").toLowerCase();
            const isVid = ext === "mp4" || ext === "webm";
            const thumb = isVid
              ? h("video", { src: avatarUrl(g.url), muted: true, loop: true, autoplay: true, playsinline: true })
              : h("img", { src: avatarUrl(g.url), alt: g.name || "", loading: "lazy" });
            const cell = h("button", { class: "nx-sticker-cell", type: "button", title: g.name || "" }, thumb);
            cell.addEventListener("click", () => { onPick({ url: g.url, kind: isVid ? "video" : (ext === "gif" ? "gif" : "image"), name: g.name }); close(); });
            return cell;
          }));
          // متنِ «یکی اضافه کن» با برداشتنِ دکمه‌ی ساخت بی‌معنا می‌شد.
          if (!data.gifs.length) clear(grid, h("p", { class: "nx-muted",
            text: CUSTOM_EMOJI_ENABLED ? "هنوز اموجی‌ای نیست — یکی اضافه کن." : "هنوز اموجی‌ای نیست." }));
        } else if (data.t === "gif_added") {
          Chat.ws.send(JSON.stringify({ t: "gifs" }));
        } else if (data.t === "error" && pop.isConnected) {
          toast(data.msg || "خطا", "error");
        }
      };
      Chat.ws.addEventListener("message", onMsg);
      Chat.ws.send(JSON.stringify({ t: "gifs" }));
      if (CUSTOM_EMOJI_ENABLED && State.isPro) {
        const addBtn = h("button", { class: "nx-sticker-add", type: "button" }, i("plus", 14), h("span", { text: "ساختِ اموجیِ اختصاصیِ این کانال (پرو)" }));
        addBtn.addEventListener("click", async () => {
          const file = await pickFile("image/*,video/mp4,video/webm"); if (!file) return;
          const lower = file.name.toLowerCase();
          const isVideo = file.type.startsWith("video/") || /\.(mp4|webm)$/.test(lower);
          const kind = isVideo ? "video" : (/\.gif$/i.test(lower) ? "gif" : "image");
          if (isVideo && await videoTooLong(file)) return;
          const limit = isVideo ? 8 * 1024 * 1024 : 4 * 1024 * 1024;
          if (file.size > limit) return toast(`حجمِ اموجی زیاد است (حداکثر ${Math.round(limit / 1024 / 1024)} مگابایت).`, "error");
          try {
            const dataUrl = await blobToDataUrl(file);
            const uploaded = await call("chat_upload", { data: dataUrl, kind, name: file.name });
            Chat.ws.send(JSON.stringify({ t: "add_gif", url: uploaded.url, name: file.name.replace(/\.[a-z0-9]+$/i, ""), scope: "channel" }));
            toast("اموجیِ اختصاصیِ کانال اضافه شد", "success");
          } catch (error) { toast("افزودنِ اموجی ناموفق بود: " + error, "error"); }
        });
        pop.appendChild(addBtn);
      }
      document.body.appendChild(pop);
      positionPopoverNear(pop, anchorBtn);
    };
    const composer = (placeholder, send) => {
      // send(payload): {type:"text", text, replyTo} | {type:"media", kind, dataUrl, name, size, replyTo} | {type:"voice", dataUrl, duration, replyTo} | {type:"sticker", kind, url, name, replyTo} | {type:"file", file, replyTo}
      let replyTarget = null;
      let replySourceNode = null;
      const quoteBar = h("div", { class: "nx-chat-reply-bar", hidden: true, "aria-live": "polite" });
      const replyPreviewText = (message) => {
        const kind = message.kind || "text";
        if (kind === "image" || kind === "gif") return "تصویر";
        if (kind === "video") return "ویدیو";
        if (kind === "voice") return "پیام صوتی";
        if (kind === "file") return "فایل";
        return messageText(message, true).trim() || "پیام";
      };
      const setReply = (message) => {
        if (replySourceNode) replySourceNode.classList.remove("is-reply-source");
        replySourceNode = null;
        replyTarget = message;
        if (!message) { quoteBar.hidden = true; clear(quoteBar); return; }
        const mine = !!message.mine || (message.from && Chat.username && message.from === Chat.username);
        const author = mine ? "خودت" : (message.from || message.username || "این پیام");
        replySourceNode = findMessageNode(message.id);
        if (replySourceNode) replySourceNode.classList.add("is-reply-source");
        clear(quoteBar,
          h("span", { class: "nx-chat-reply-bar-icon" }, i("reply", 16)),
          h("div", { class: "nx-chat-reply-bar-copy" },
            h("strong", { text: `پاسخ به ${author}` }),
            h("small", { text: replyPreviewText(message).slice(0, 110) })),
          h("button", { class: "nx-chat-reply-bar-x", type: "button", title: "لغو پاسخ", "aria-label": "لغو پاسخ", onclick: () => setReply(null) }, i("x", 15)));
        quoteBar.hidden = false;
        quoteBar.classList.remove("is-entering");
        requestAnimationFrame(() => {
          quoteBar.classList.add("is-entering");
          keepFocus(input);
          input.setSelectionRange(input.value.length, input.value.length);
        });
      };
      const input = h("textarea", { class: "nx-chat-input", placeholder, maxlength: "1000", rows: "1" });
      // کفِ ارتفاع باید دقیقاً برابرِ بقیه‌ی کنترل‌هایِ ردیف (۴۰) باشد؛ ۴۲ باعث می‌شد فیلدِ متن
      // دو پیکسل از بغلی‌هایش بلندتر و «بالاتر» بیفتد.
      const resize = () => { input.style.height = "auto"; input.style.height = Math.min(116, Math.max(40, input.scrollHeight)) + "px"; };
      input.addEventListener("input", resize);
      // راهنمای کلید و شمارشِ معکوسِ ضبط، شناور بالای کادر می‌نشیند (نه یک خطِ دائمی داخلِ آن)
      // تا ارتفاعِ نوارِ نوشتن کم بماند و همه‌ی فضا به خودِ پیام‌ها برسد.
      // همین عنصر موقعِ ضبطِ صدا شمارشِ معکوس را نشان می‌دهد، پس حذف نمی‌شود — فقط
      // متنِ راهنمایِ همیشگی‌اش برداشته شد.
      const hint = h("small", { text: "" });
      const takeReplyTo = () => { const id = replyTarget ? (replyTarget.id || 0) : 0; setReply(null); return id; };
      const submitText = () => {
        const text = input.value.trim(); if (!text) return keepFocus(input);
        input.value = ""; resize(); keepFocus(input);
        try { localStorage.removeItem("nx-draft:" + placeholder); } catch (_) {}
        send({ type: "text", text, replyTo: takeReplyTo(), silent: silentMode });
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && replyTarget) { event.preventDefault(); setReply(null); }
        else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitText(); }
      });
      const toolMenu = h("details", { class: "nx-chat-tools" });
      const closeToolMenu = () => { toolMenu.open = false; };
      const emoji = h("button", { class: "nx-chat-emoji", type: "button", title: "افزودن شکلک", "aria-label": "افزودن شکلک", onclick: () => { closeToolMenu(); input.setRangeText("🙂", input.selectionStart, input.selectionEnd, "end"); resize(); keepFocus(input); } }, i("smile", 18), h("span", { text: "شکلک" }));
      const stickerBtn = h("button", { class: "nx-chat-sticker", type: "button", title: "اموجی/استیکرِ ویدیویی-عکسی", "aria-label": "اموجی/استیکر" }, i("image", 18), h("span", { text: "استیکر" }));
      stickerBtn.addEventListener("click", () => {
        openStickerPicker(stickerBtn, (picked) => {
          // اموجیِ متنی داخلِ کادرِ نوشتن می‌رود؛ گیف/استیکر به‌عنوانِ پیام فرستاده می‌شود
          if (picked && picked.emoji) {
            input.setRangeText(picked.emoji, input.selectionStart, input.selectionEnd, "end");
            resize(); keepFocus(input);
            return;
          }
          send({ type: "sticker", kind: picked.kind, url: picked.url, name: picked.name, replyTo: takeReplyTo() });
        });
        setTimeout(closeToolMenu, 0);
      });
      const attachBtn = h("button", { class: "nx-chat-attach", type: "button", title: "پیوستِ عکس/ویدیو/فایل", "aria-label": "پیوست", onclick: async () => {
        closeToolMenu();
        const file = await pickFile("*/*"); if (!file) return;
        const lower = file.name.toLowerCase();
        const isVideo = file.type.startsWith("video/") || /\.(mp4|webm)$/.test(lower);
        const isImage = file.type.startsWith("image/") && !/\.gif$/i.test(lower);
        const kind = isVideo ? "video" : (isImage ? "image" : "file");
        if (isVideo && await videoTooLong(file)) return;
        if (kind === "file") {
          // فایلِ عمومی: از مسیرِ آپلودِ chunked (نه base64) رد می‌شود چون سقفِ پرو (۵۰۰ مگ) با
          // base64-in-JSON اصلاً جا نمی‌شود.
          const limitMb = State.isPro ? 500 : 25;
          if (file.size > limitMb * 1024 * 1024) {
            return toast(`حجمِ فایل زیاد است (حداکثر ${limitMb} مگابایت${State.isPro ? "" : " — با اشتراکِ طلایی تا ۵۰۰ مگابایت"}).`, "error");
          }
          send({ type: "file", file, replyTo: takeReplyTo() });
          return;
        }
        const limit = isVideo ? 20 * 1024 * 1024 : 6 * 1024 * 1024;
        if (file.size > limit) return toast(`حجمِ فایل زیاد است (حداکثر ${Math.round(limit / 1024 / 1024)} مگابایت).`, "error");
        try {
          const dataUrl = await blobToDataUrl(file);
          send({ type: "media", kind, dataUrl, name: file.name, size: file.size, replyTo: takeReplyTo() });
        } catch (_) { toast("خواندنِ فایل ناموفق بود.", "error"); }
      } }, i("paperclip", 18), h("span", { text: "فایل یا تصویر" }));
      let recorder = null;
      let recTimer = null;
      const micBtn = h("button", { class: "nx-chat-mic", type: "button", title: "پیامِ صوتی", "aria-label": "پیامِ صوتی" }, i("mic", 18));
      micBtn.addEventListener("click", async () => {
        if (recorder) { recorder.stop(); return; }
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch (_) { return toast("دسترسی به میکروفون داده نشد.", "error"); }
        // سقفِ مدتِ پیامِ صوتی: ۱ دقیقه رایگان، ۵ دقیقه پرو — با شمارشِ معکوسِ زنده و قطعِ خودکار.
        const maxDur = State.isPro ? 300 : 60;
        const chunks = []; const startedAt = Date.now();
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (event) => { if (event.data && event.data.size) chunks.push(event.data); };
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop());
          if (recTimer) { clearInterval(recTimer); recTimer = null; }
          recorder = null; micBtn.classList.remove("is-recording"); node.classList.remove("is-recording");
          hint.textContent = "";
          const duration = Math.min(maxDur, Math.round((Date.now() - startedAt) / 1000));
          if (duration < 1 || !chunks.length) return;
          try {
            const blob = new Blob(chunks, { type: "audio/webm" });
            const dataUrl = await blobToDataUrl(blob);
            // ضبط دیگر مستقیم فرستاده نمی‌شود: اول پیش‌نمایش می‌آید تا بشنوی و
            // تصمیم بگیری بفرستی یا دور بیندازی.
            showVoicePreview(dataUrl, duration);
          } catch (_) { toast("ضبطِ پیامِ صوتی ناموفق بود.", "error"); }
        };
        recorder.start();
        micBtn.classList.add("is-recording"); node.classList.add("is-recording");
        const tick = () => {
          const left = maxDur - Math.floor((Date.now() - startedAt) / 1000);
          if (left <= 0) { if (recorder) recorder.stop(); return; }
          hint.textContent = `در حالِ ضبط… ${left} ثانیه مانده (برای پایانِ زودتر دوباره بزن)`;
        };
        tick(); recTimer = setInterval(tick, 1000);
      });
      // ── پیامِ ویدیوییِ گِرد (video note) ──
      // ── پیش‌نمایشِ پیامِ صوتی پیش از ارسال ──
      const voiceBar = h("div", { class: "nx-voice-preview", hidden: true });
      const clearVoicePreview = () => { voiceBar.hidden = true; clear(voiceBar); };
      const showVoicePreview = (dataUrl, duration) => {
        const audio = h("audio", { class: "nx-voice-audio", src: dataUrl, controls: true, preload: "metadata" });
        const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`
          .replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
        clear(voiceBar,
          h("span", { class: "nx-voice-icon" }, i("mic", 16)),
          audio,
          h("small", { class: "nx-voice-dur", text: fmt(duration) }),
          h("button", { class: "nx-voice-send", type: "button", title: "ارسالِ پیامِ صوتی",
            onclick: () => {
              send({ type: "voice", dataUrl, duration, replyTo: takeReplyTo() });
              clearVoicePreview();
            } }, i("send", 16)),
          h("button", { class: "nx-voice-drop", type: "button", title: "دورانداختن",
            onclick: clearVoicePreview }, i("trash", 15)));
        voiceBar.hidden = false;
      };
      const silentMode = false;   // «ارسالِ بی‌صدا» حذف شد؛ همه‌ی پیام‌ها عادی می‌روند
      const submit = h("button", { class: "nx-chat-send", type: "button", title: "ارسال پیام", "aria-label": "ارسال پیام", onclick: submitText }, i("send", 18));
      const field = h("div", { class: "nx-chat-input-wrap" }, input, hint);
      // «+» و منویِ کشویی‌اش حذف شد: حالا یک گیره‌ی مستقیم برایِ عکس/ویدیو/فایل و
      // کنارش یک دکمه‌ی اموجی که شکلک و استیکر و گیف را یک‌جا می‌دهد.
      const clipBtn = h("button", { class: "nx-chat-clip", type: "button",
        title: "پیوستِ عکس، ویدیو یا فایل", "aria-label": "پیوست" }, i("paperclip", 19));
      clipBtn.addEventListener("click", () => attachBtn.click());
      const emojiBtn = h("button", { class: "nx-chat-emoji-btn", type: "button",
        title: "اموجی، استیکر و گیف", "aria-label": "اموجی و استیکر" }, i("smile", 19));
      emojiBtn.addEventListener("click", () => stickerBtn.click());
      // .nx-chat-composer یک گریدِ چهارستونیِ ثابت است (40px | 1fr | 40px | 44px). دکمه‌های تازه
      // نباید مستقیم فرزندش شوند وگرنه به ردیف‌های ضمنی سرریز می‌کنند و ستونِ متن به ۴۰ پیکسل
      // می‌چسبد (همان «بهم‌ریختگی»). پس همه‌شان داخلِ یک جعبه‌ی واحد در ستونِ سومِ گرید می‌نشینند.
      // نوارِ قالب‌بندی هم بیرونِ input-wrap و بالای کلِ ردیف است تا افقی و تمام‌عرض بماند.
      const actions = h("div", { class: "nx-chat-actions" }, micBtn);
      const node = h("footer", { class: "nx-chat-composer-wrap" }, quoteBar, voiceBar,
        h("div", { class: "nx-chat-composer" },
          // emojiBtn (که شکلک و استیکر و گیف را یک‌جا می‌دهد) موقتاً به نوار اضافه
          // نمی‌شود؛ خودِ دکمه و شنونده‌اش بالا دست‌نخورده ساخته می‌شوند.
          h("div", { class: "nx-chat-lead" }, clipBtn, ...(STICKERS_ENABLED ? [emojiBtn] : [])),
          field, actions, submit));
      // پیامِ نیمه‌نوشته نباید با عوض‌کردنِ گفتگو بپرد (درافتِ تلگرام). کلیدِ درافت به گفتگو
      // بسته است تا هر چت درافتِ خودش را داشته باشد.
      const draftKey = "nx-draft:" + placeholder;
      try {
        const saved = localStorage.getItem(draftKey);
        if (saved) { input.value = saved; setTimeout(resize, 0); }
      } catch (_) {}
      input.addEventListener("input", () => {
        try {
          if (input.value.trim()) localStorage.setItem(draftKey, input.value);
          else localStorage.removeItem(draftKey);
        } catch (_) {}
      });
      const clearDraft = () => { try { localStorage.removeItem(draftKey); } catch (_) {} };
      return { node, input, resize, setReply, clearDraft, isSilent: () => silentMode };
    };
    const messageReplyAction = (message, onReply) => onReply
      ? h("button", {
          class: "nx-message-reply-action",
          type: "button",
          title: "پاسخ",
          "aria-label": "پاسخ به این پیام",
          onclick: () => onReply(message),
        }, i("reply", 16))
      : null;
    // منویِ کارهایِ یک پیامِ خصوصی. گفتگویِ زنده/گروه این را داشت ولی DM فقط «پاسخ»
    // می‌داد — یعنی نمی‌شد پیامِ خودت را ویرایش یا حذف کنی، با اینکه سرور
    // dm_edit و dm_delete را دارد.
    const openDmMessageMenu = (message, user, onDone) => {
      const mine = !!message.mine;
      const isText = !message.kind || message.kind === "text";
      const row = (label, glyph, run, danger) => h("button", {
        class: "nx-gm-row" + (danger ? " is-danger" : ""), type: "button", onclick: run },
        h("span", { class: "nx-gm-row-icon" }, i(glyph, 16)),
        h("span", { class: "nx-gm-row-copy" }, h("strong", { text: label })));
      const rows = [];
      if (isText && (message.text || "").trim()) {
        rows.push(row("کپیِ متن", "copy", () => {
          try { navigator.clipboard.writeText(message.text || ""); toast("متن کپی شد.", "success"); }
          catch (_) { toast("کپی نشد.", "error"); }
          dlg.close();
        }));
      }
      if (mine && isText) {
        rows.push(row("ویرایشِ پیام", "pencil", () => {
          dlg.close();
          promptDialog("ویرایشِ پیام", "متنِ تازه", async (text) => {
            const next = String(text || "").trim();
            if (!next) return toast("متن نمی‌تواند خالی باشد.", "error");
            try { await call("dm_edit", { messageId: message.id, text: next }); toast("ویرایش شد.", "success"); if (onDone) onDone(); }
            catch (e) { toast("ویرایش نشد: " + e, "error"); }
          }, message.text || "");
        }));
      }
      rows.push(row("فرستادن به…", "send", () => {
        dlg.close();
        openSendSheet({ text: message.text || "", origin: mine ? Chat.username : user.username });
      }));
      if (mine) {
        rows.push(row("حذف برایِ همه", "trash", async () => {
          dlg.close();
          if (!(await confirmDialog("حذفِ پیام", "این پیام برایِ هر دو طرف پاک شود؟"))) return;
          try { await call("dm_delete", { messageId: message.id, forEveryone: true }); toast("پیام حذف شد.", "success"); if (onDone) onDone(); }
          catch (e) { toast("حذف نشد: " + e, "error"); }
        }, true));
      }
      rows.push(row("حذف برایِ خودم", "x", async () => {
        dlg.close();
        try { await call("dm_delete", { messageId: message.id, forEveryone: false }); toast("از گفتگویِ تو پاک شد.", "success"); if (onDone) onDone(); }
        catch (e) { toast("حذف نشد: " + e, "error"); }
      }, true));
      const dlg = sheetDialog("کارهایِ پیام", rows, () => dlg.close());
    };

    // ── چیدمانِ تلگرامیِ حباب (فقط موبایل) ────────────────────────────────
    // تلگرام نام را در چتِ دونفره تکرار نمی‌کند و ساعت و تیک‌ها را داخلِ گوشه‌ی
    // پایینِ خودِ حباب می‌گذارد، نه در یک سطرِ جدا بالای متن. این‌جا همان «مُهر» ساخته
    // می‌شود و ساعت از سطرِ بالا برداشته می‌شود؛ نام می‌ماند ولی CSS در چتِ دونفره
    // پنهانش می‌کند (در گروه لازم است).
    // ⚠ فقط روی موبایل؛ دسکتاپ همان چیدمانِ قبلی را نگه می‌دارد.
    const NX_TG = document.documentElement.classList.contains("mobile-ui");
    const chatStamp = (timeText, editedAt, mine, read) => h("div", { class: "nx-chat-stamp" },
      editedAt ? h("small", { class: "nx-chat-edited", text: "ویرایش‌شده" }) : null,
      h("time", { text: timeText }),
      mine ? h("small", { class: "nx-chat-read", text: read ? "✓✓" : "✓" }) : null);

    const privateLine = (message, user, onReply, onDone) => {
      const mine = !!message.mine;
      const bubble = NX_TG
        ? h("div", { class: "nx-chat-bubble" },
            h("div", { class: "nx-chat-message-meta" },
              h("strong", { text: mine ? "تو" : user.username })),
            replyQuote(message),
            messageBody(message, false),
            chatStamp(relativeTime(message.created_at), message.edited_at, mine, message.read))
        : h("div", { class: "nx-chat-bubble" },
            h("div", { class: "nx-chat-message-meta" },
              h("strong", { text: mine ? "تو" : user.username }),
              h("time", { text: relativeTime(message.created_at) }),
              message.edited_at ? h("small", { class: "nx-chat-edited", text: "ویرایش‌شده" }) : null),
            replyQuote(message),
            messageBody(message, false),
            mine ? h("div", { class: "nx-chat-bubble-foot" }, h("small", { class: "nx-chat-read", text: message.read ? "✓✓ خوانده شد" : "✓ ارسال شد" })) : null);
      return h("article", { class: "nx-chat-message" + (mine ? " is-mine" : ""), "data-message-id": message.id || "", "data-from": message.from || "" },
        mine ? null : avatar(user.username, user.avatar || Messages.activeAvatar, 30),
        h("div", { class: "nx-chat-bubble-wrap" }, bubble,
          messageReplyAction(message, onReply),
          message.id ? h("button", {
            class: "nx-message-more-action", type: "button", title: "کارهایِ پیام",
            "aria-label": "کارهایِ پیام", onclick: () => openDmMessageMenu(message, user, onDone),
          }, i("moreHorizontal", 16)) : null));
    };
    // نشانِ «فوروارد‌شده» — تلگرام منبع را بالایِ حباب می‌گذارد، نه داخلِ متن.
    const forwardBadge = (message) => message.forward_from
      ? h("div", { class: "nx-chat-forward" }, i("share", 13),
          h("small", { text: `فوروارد از ${message.forward_from}${message.forward_chat ? " · " + message.forward_chat : ""}` }))
      : null;

    // sheetDialog یک api برمی‌گرداند؛ برایِ بستن از داخلِ آیتم‌ها به همان ارجاع نیاز داریم.
    let dlgRef = { close: () => {} };
    const openMessageMenu = (message) => {
      const mine = message.from && Chat.username && message.from === Chat.username;
      const gid = _channelGroupId(Chat.currentChannel);
      const group = gid ? freshGroup(gid) : null;
      const items = [];
      if (mine && (message.kind || "text") === "text") {
        items.push(["pencil", "ویرایش", () => promptDialog("ویرایشِ پیام", "متنِ تازه",
          (text) => wsSend({ t: "edit_message", message: message.id, text }), message.text || "")]);
      }
      items.push(["send", "فرستادن به…", () => openSendSheet({ text: message.text || "", origin: message.from })]);
      items.push(["bookmark", "ذخیره در دفترچه", () => {
        if (wsSend({ t: "save_message", message: message.id })) toast("در پیام‌هایِ ذخیره‌شده ثبت شد.", "success");
      }]);
      items.push(["copy", "کپیِ متن", () => {
        try { navigator.clipboard.writeText(message.text || ""); toast("متن کپی شد.", "success"); }
        catch (_) { toast("کپی نشد.", "error"); }
      }]);
      if (group && canManage(group)) {
        items.push(["pin", "پین‌کردن", () => wsSend({ t: "pin_message", group: gid, message: message.id })]);
      }
      if (mine) {
        items.push(["trash", "حذف", async () => {
          const yes = await confirmDialog("این پیام حذف شود؟", "برایِ همه پاک می‌شود.");
          if (yes) wsSend({ t: "delete_message", message: message.id });
        }]);
      }
      const rows = items.map(([glyph, label, run]) => h("button", {
        class: "nx-gm-row", type: "button", onclick: () => { dlgRef.close(); run(); },
      }, h("span", { class: "nx-gm-row-icon" }, i(glyph, 16)),
         h("span", { class: "nx-gm-row-copy" }, h("strong", { text: label }))));
      dlgRef = sheetDialog("کارهایِ پیام", rows, () => dlgRef.close());
    };

    // شبکه‌ی آلبوم — چیدمانِ تلگرام: ۱ تصویرِ بزرگ، ۲ ستونی، ۳+ شبکه‌ای.
    const albumGrid = (items) => {
      const grid = h("div", { class: "nx-chat-album nx-chat-album-" + Math.min(items.length, 4) });
      items.forEach((item) => {
        const media = (item.extra && item.extra.media) || "";
        if (!media) return;
        const isVideo = item.kind === "video" || /\.(mp4|webm)$/i.test(media);
        const cell = isVideo
          ? h("video", { class: "nx-chat-album-cell", src: avatarUrl(media), preload: "metadata", muted: true })
          : h("img", { class: "nx-chat-album-cell", src: avatarUrl(media), alt: "", loading: "lazy" });
        cell.addEventListener("click", () => openImageOverlay(avatarUrl(media), isVideo ? "video" : "image"));
        grid.appendChild(cell);
      });
      return grid;
    };

    // پیامِ سیستمی (مثلِ «گروهِ … ساخته شد») حباب و آواتار ندارد — یک نوارِ وسط‌چین.
    const systemLine = (message) =>
      h("div", { class: "nx-chat-system" }, h("span", { text: messageText(message, true) }));
    const liveLine = (message, onReply, album = null) => {
      if (message.kind === "system" || message.from === "system") return systemLine(message);
      const mine = message.from && Chat.username && message.from === Chat.username;
      const caption = album ? (album.find((x) => x.text) || {}).text : null;
      const bubble = h("div", { class: "nx-chat-bubble" },
        h("div", { class: "nx-chat-message-meta" },
          h("strong", { text: mine ? "تو" : (message.from || "کاربر") }),
          NX_TG ? null : h("time", { text: relativeTime(message.ts) }),
          NX_TG ? null : (message.edited_at ? h("small", { class: "nx-chat-edited", text: "ویرایش‌شده" }) : null),
          album && album.length > 1 ? h("small", { class: "nx-chat-edited", text: `${album.length} رسانه` }) : null),
        forwardBadge(message),
        replyQuote(message),
        album && album.length > 1 ? albumGrid(album) : messageBody(message, true),
        album && album.length > 1 && caption ? h("p", {}, richText(caption)) : null,
        NX_TG ? chatStamp(relativeTime(message.ts), message.edited_at, false, false) : null);
      return h("article", { class: "nx-chat-message" + (mine ? " is-mine" : ""), "data-message-id": message.id || "", "data-from": message.from || "" },
        mine ? null : avatar(message.from, message.avatar, 30),
        h("div", { class: "nx-chat-bubble-wrap" }, bubble,
          messageReplyAction(message, onReply),
          message.id ? h("button", {
            class: "nx-message-more-action", type: "button", title: "کارهایِ پیام",
            "aria-label": "کارهایِ پیام", onclick: () => openMessageMenu(message),
          }, i("moreHorizontal", 16)) : null));
    };

    async function openDm(user) {
      cleanupConversation();
      if (Messages.stopPoll) Messages.stopPoll();
      model.selected = "dm:" + user.username; Messages.active = user.username; Messages.activeAvatar = user.avatar;
      const selectedThread = model.threads.find((thread) => thread.username === user.username);
      if (selectedThread) selectedThread.unread = 0;
      frame.classList.add("has-open"); renderList(); groupsModel.refresh(); clear(conversation);
      const list = h("div", { class: "nx-native-chat-list" }, loading("پیام‌ها…"));
      const head = h("header", { class: "nx-native-chat-head" },
        h("button", { class: "nx-chat-back", type: "button", title: "برگشت", onclick: mobileBack }, i("arrowRight", 18)),
        h("button", { class: "nx-chat-peer", type: "button", title: `پروفایلِ ${user.username}`, onclick: () => openUser(user.username) },
          avatar(user.username, user.avatar, 34),
          h("span", {}, h("strong", { text: user.username }), h("small", { text: "پیامِ خصوصی" }))),
        h("button", { class: "nx-chat-call", type: "button", title: "تماسِ صوتی", "aria-label": "تماسِ صوتی", onclick: () => startDmCall(user.username) }, i("phone", 17)));
      let destroyed = false;
      let loadingHistory = false;
      let loadingOlder = false;
      let firstLoad = true;
      let lastId = 0;
      let firstId = 0;        // قدیمی‌ترین idِ بارگذاری‌شده — برای صفحه‌بندی به‌عقب هنگامِ اسکرول به بالا
      let noMoreOlder = false;
      const seen = new Set();
      const onReply = (message) => compose.setReply({
        ...message,
        username: message.mine ? Chat.username : user.username,
      });
      const appendMessages = (messages, forceScroll = false) => {
        const ordered = messages.slice().sort((a, b) => Number(a.id || a.created_at || 0) - Number(b.id || b.created_at || 0));
        if (firstLoad) clear(list);
        ordered.forEach((message) => {
          const key = String(message.id || `${message.created_at}:${message.text}`);
          if (seen.has(key)) return;
          const idn = Number(message.id || 0);
          seen.add(key); lastId = Math.max(lastId, idn);
          if (idn) firstId = firstId ? Math.min(firstId, idn) : idn;
          list.appendChild(privateLine(message, user, onReply, refreshThread));
        });
        if (!list.children.length) list.appendChild(blank("هنوز پیامی نیست", "اولین پیام را تو بفرست.", "messageCircle"));
        markMessageRuns(list);
        scrollLatest(list, forceScroll || firstLoad);
        firstLoad = false;
      };
      // بارگذاریِ تاریخچه افزایشی است (after: lastId)، پس بعد از حذف/ویرایش باید
      // وضعیت را ری‌ست کرد وگرنه ردیفِ پاک‌شده روی صفحه می‌ماند.
      const refreshThread = () => {
        firstLoad = true; lastId = 0; firstId = 0; noMoreOlder = false; seen.clear();
        loadHistory();
      };
      const loadHistory = async () => {
        if (destroyed || loadingHistory) return;
        loadingHistory = true;
        try {
          const result = await call("dm_history", { withUser: user.username, after: firstLoad ? 0 : lastId });
          if (result && result.avatar) { user.avatar = result.avatar; Messages.activeAvatar = result.avatar; }
          if (result) noteProCosmetics(
            user.username, result.color, result.ring, result.nameplate);
          appendMessages((result && result.messages) || [], firstLoad);
        } catch (error) {
          if (firstLoad) clear(list, blank("پیام‌ها بارگذاری نشدند", String(error), "warn"));
        } finally { loadingHistory = false; }
      };
      // پیام‌های قدیمی‌تر را بالای لیست اضافه می‌کند (اسکرول به بالا). موقعیتِ اسکرول را حفظ می‌کند تا نپرد.
      const prependOlder = (messages) => {
        const ordered = messages.slice().sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
        const frag = document.createDocumentFragment();
        let added = 0;
        ordered.forEach((message) => {
          const key = String(message.id || `${message.created_at}:${message.text}`);
          if (seen.has(key)) return;
          seen.add(key); added++;
          const idn = Number(message.id || 0);
          if (idn) firstId = firstId ? Math.min(firstId, idn) : idn;
          frag.appendChild(privateLine(message, user, onReply, refreshThread));
        });
        if (added) { list.insertBefore(frag, list.firstChild); markMessageRuns(list); }
        return added;
      };
      const loadOlder = async () => {
        if (destroyed || loadingOlder || noMoreOlder || !firstId) return;
        loadingOlder = true;
        const prevH = list.scrollHeight, prevTop = list.scrollTop;
        const prevBehavior = list.style.scrollBehavior;
        list.style.scrollBehavior = "auto";   // پرشِ نرم نمی‌خواهیم؛ فقط موقعیت را حفظ کن
        try {
          const result = await call("dm_history", { withUser: user.username, before: firstId });
          const older = (result && result.messages) || [];
          if (!older.length) { noMoreOlder = true; return; }
          if (!prependOlder(older)) { noMoreOlder = true; return; }
          list.scrollTop = prevTop + (list.scrollHeight - prevH);   // همان پیام زیرِ دید بماند
        } catch (_) {
        } finally { loadingOlder = false; list.style.scrollBehavior = prevBehavior; }
      };
      const send = async (payload) => {
        try {
          let result;
          if (payload.type === "voice") {
            result = await call("dm_send", { to: user.username, audio: payload.dataUrl, vdur: payload.duration, replyTo: payload.replyTo || 0 });
          } else if (payload.type === "sticker") {
            result = await call("dm_send", { to: user.username, media: payload.url, kind: payload.kind, replyTo: payload.replyTo || 0 });
          } else if (payload.type === "file") {
            const uploaded = await uploadLargeFile(payload.file);
            result = await call("dm_send", { to: user.username, media: uploaded.url, kind: "file", replyTo: payload.replyTo || 0 });
          } else if (payload.type === "media") {
            const uploaded = await call("chat_upload", { data: payload.dataUrl, kind: payload.kind, name: payload.name });
            result = await call("dm_send", { to: user.username, media: uploaded.url, kind: uploaded.type || payload.kind, replyTo: payload.replyTo || 0 });
          } else {
            result = await call("dm_send", { to: user.username, text: payload.text, replyTo: payload.replyTo || 0 });
          }
          if (result && result.message) appendMessages([result.message], true);
          else await loadHistory();
        } catch (error) { toast("پیام ارسال نشد: " + error, "error"); }
      };
      const compose = composer(`پیام به ${user.username}…`, send);
      conversation.appendChild(h("section", { class: "nx-native-chat" }, head, list, compose.node));
      // اسکرول به بالای گفتگو → پیام‌های قدیمی‌تر را بیاور (صفحه‌بندیِ بی‌نهایتِ رو‌به‌بالا).
      list.addEventListener("scroll", () => { if (list.scrollTop < 120) loadOlder(); });
      await loadHistory();
      const poll = setIntervalWhenActive(loadHistory, 1800);
      stopConversation = () => { destroyed = true; clearInterval(poll); };
      reload();
    }

    // «پیام‌هایِ ذخیره‌شده» یک گفتگویِ واقعی است، نه پنجره‌ی جدا — پس مثلِ بقیه‌ی چت‌ها
    // حباب، رسانه، ریپلای، جست‌وجو و اسکرول دارد (رفتارِ تلگرام). این‌جا تعریف می‌شود
    // چون openLive داخلِ همین تابع است و از بیرون دیده نمی‌شود.
    let savedChannelId = 0;
    async function openSavedChat() {
      if (!savedChannelId) {
        // اگر همان اولِ باز شدنِ لانچر رویش بزنی، هنوز WS دست‌دادنش تمام نشده و پاسخ نمی‌آید.
        // به‌جای خطا دادن، تا ۶ ثانیه منتظرِ اتصال می‌مانیم و بعد می‌پرسیم.
        const deadline = Date.now() + 6000;
        while (!(Chat.ws && Chat.ws.readyState === 1 && Chat.connected) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const data = await wsAsk({ t: "saved_chat" }, "saved_chat");
        if (!data || !data.channel) return toast("دفترچه باز نشد؛ اتصالت را بررسی کن.", "error");
        savedChannelId = data.channel;
      }
      openLive(savedChannelId);
    }

    async function openLive(channelId) {
      cleanupConversation();
      if (Messages.stopPoll) Messages.stopPoll();
      model.selected = "live"; model.liveUnread = 0; model.liveSeenCount = Chat.msgs.length;
      frame.classList.add("has-open"); renderList(); clear(conversation);
      // channelId فقط وقتی از یه ردیفِ کانال تو بخشِ گروه‌ها میاد یه عددِ واقعیه؛ اگه مستقیم به‌عنوانِ
      // onclick صدا زده بشه (مثلِ ردیفِ «گفتگویِ زنده»)، آرگومان خودِ Eventِ کلیک است — Number(...) روش NaN
      // می‌شه و با || 0 امن به چتِ همگانی برمی‌گرده.
      const targetChannel = Number(channelId) || 0;
      if (Chat.currentChannel !== targetChannel) {
        Chat.currentChannel = targetChannel; Chat.currentTopic = 0; Chat.msgs = []; Chat.seenIds = new Set();
      }
      const bootstrap = h("div", { class: "nx-chat-bootstrap", hidden: true });
      const list = h("div", { class: "nx-native-chat-list" }, loading("اتصال به گفتگوی زنده…"));
      const status = h("small", { text: "در حال اتصال…" });
      const chTitle = h("strong", { text: "چتِ همگانی" });
      // عنوانِ گفتگو کلیک‌پذیر است و مدیریت/اطلاعاتِ همان گروه یا کانال را باز می‌کند —
      // همان‌جایی که تلگرام گذاشته. چتِ همگانی گروه ندارد، پس آن‌جا کلیک‌پذیر نیست.
      const headGroupId = () => _channelGroupId(Chat.currentChannel);
      const headIcon = h("span", { class: "nx-live-chat-icon" }, i("globe", 18));
      const headBtn = h("button", { class: "nx-chat-head-open", type: "button" },
        headIcon,
        h("div", { class: "nx-chat-head-copy" }, chTitle, status));
      // مداد فقط برایِ مدیر — میان‌برِ ویرایشِ اطلاعاتِ گروه/کانال
      // بی‌صدا: یک تاگلِ ساده در هدر. منویِ «۱ ساعت / ۳ ساعت / …» فقط با راست‌کلیک
      // می‌آید — قبلاً هر بار مجبور بودی از آن منو یک مدت انتخاب کنی.
      const headMute = h("button", { class: "nx-chat-head-mute", type: "button", hidden: true,
        "aria-label": "بی‌صدا" }, i("bell", 16));
      const syncMute = () => {
        const gid = headGroupId();
        const g = gid ? freshGroup(gid) : null;
        const muted = gid ? isGroupMuted(gid) : false;
        headMute.hidden = !g;
        headMute.classList.toggle("is-muted", muted);
        clear(headMute, i("bell", 16));
        headMute.title = muted ? "بی‌صدا است — برایِ برگرداندنِ صدا بزن" : "بی‌صدا کردن (راست‌کلیک: مدت)";
      };
      headMute.addEventListener("click", (e) => {
        e.stopPropagation();
        const gid = headGroupId(); if (!gid) return;
        const nowMuted = isGroupMuted(gid);
        if (wsSend({ t: "mute_chat", group: gid, channel: 0, seconds: nowMuted ? 0 : -1 })) {
          // خوش‌بینانه به‌روزرسانی می‌شود؛ فریمِ chat_mutes سرور بعداً تأییدش می‌کند
          _chatMutes.set(Number(gid), nowMuted ? 0 : Math.floor(Date.now() / 1000) + 10 * 365 * 86400);
          syncMute();
          toast(nowMuted ? "صدا برگشت." : "بی‌صدا شد.", "success");
        }
      });
      headMute.addEventListener("contextmenu", (e) => {
        e.preventDefault(); e.stopPropagation();
        const gid = headGroupId(); if (!gid) return;
        const opt = (seconds, label) => h("button", { class: "nx-gm-row", type: "button", onclick: () => {
          if (wsSend({ t: "mute_chat", group: gid, channel: 0, seconds })) {
            _chatMutes.set(Number(gid), seconds === 0 ? 0
              : Math.floor(Date.now() / 1000) + (seconds < 0 ? 10 * 365 * 86400 : seconds));
            syncMute();
            toast(seconds ? "بی‌صدا شد." : "صدا برگشت.", "success");
          }
          dlg.close();
        } }, h("span", { class: "nx-gm-row-icon" }, i("clock", 16)),
           h("span", { class: "nx-gm-row-copy" }, h("strong", { text: label })));
        const dlg = sheetDialog("بی‌صدا کردن", [
          opt(3600, "۱ ساعت"), opt(10800, "۳ ساعت"), opt(86400, "۱ روز"),
          opt(604800, "۱ هفته"), opt(-1, "تا همیشه"), opt(0, "رفعِ بی‌صدایی"),
        ], () => dlg.close());
      });
      // مدادِ هدر منویِ کاملِ مدیریت را باز می‌کند، نه فقط فرمِ اطلاعات. قبلاً مستقیم
      // به view=edit می‌رفت و راهی به تنظیمات/مجوزها/دعوت‌ها از این‌جا نبود.
      const headEdit = h("button", { class: "nx-chat-head-edit", type: "button", hidden: true,
        title: "مدیریتِ گروه", "aria-label": "مدیریتِ گروه" }, i("pencil", 16));
      headEdit.addEventListener("click", (e) => {
        e.stopPropagation();
        const gid = headGroupId();
        if (gid) openGroupManager(gid);
      });
      const syncHeadAffordance = () => {
        const gid = headGroupId();
        headBtn.disabled = !gid;
        headBtn.title = gid ? "اطلاعات و مدیریتِ این گفتگو" : "";
        headBtn.classList.toggle("is-openable", !!gid);
      };
      headBtn.addEventListener("click", () => {
        const gid = headGroupId();
        if (gid) openGroupManager(gid);
      });
      const head = h("header", { class: "nx-native-chat-head" },
        h("button", { class: "nx-chat-back", type: "button", title: "برگشت", onclick: mobileBack }, i("arrowRight", 18)),
        headBtn, headMute, headEdit);
      // ── پیامِ پین‌شده زیرِ هدر (سبکِ تلگرام) ──
      // گروه‌ها فیلدِ pinned را در همان payloadِ groups دارند، پس درخواستِ جدا لازم نیست.
      const pinBar = h("div", { class: "nx-chat-pinbar", hidden: true });
      const syncPinBar = () => {
        const gid = headGroupId();
        const g = gid ? freshGroup(gid) : null;
        const pin = g && g.pinned;
        if (!pin) { pinBar.hidden = true; return; }
        clear(pinBar,
          h("span", { class: "nx-chat-pinbar-mark" }, i("pin", 14)),
          h("span", { class: "nx-chat-pinbar-copy" },
            h("strong", { text: "پیامِ پین‌شده" }),
            h("small", { text: (pin.text || "").slice(0, 120) || "(بدونِ متن)" })),
          canManage(g) ? h("button", { class: "nx-chat-pinbar-x", type: "button", title: "برداشتنِ پین",
            onclick: (e) => {
              e.stopPropagation();
              if (wsSend({ t: "unpin_message", group: gid, message: pin.id })) {
                g.pinned = null; syncPinBar();
              }
            } }, i("x", 14)) : null);
        // کلیک روی نوار به همان پیام می‌پرد
        pinBar.onclick = () => { if (pin.id) jumpToMessage(Chat.currentChannel, pin.id); };
        pinBar.hidden = false;
      };
      let destroyed = false;
      let signature = "";
      const onReply = (message) => compose.setReply(message);
      const renderLive = (force = false) => {
        if (destroyed) return;
        const messages = Chat.msgs.slice().sort((a, b) => Number(a.id || a.ts || 0) - Number(b.id || b.ts || 0));
        const nextSignature = `${messages.length}:${messages.length ? messages[messages.length - 1].id || messages[messages.length - 1].ts : 0}:${Chat.currentChannel || 0}`;
        if (!Chat.currentChannel) {
          chTitle.textContent = "چتِ همگانی";
          // فقط چتِ همگانی واقعاً «همه‌ی آنلاین‌ها» را دارد؛ Chat.online یک شمارنده‌ی
          // سراسری است و گذاشتنش روی گروه/کانال عددِ غلط نشان می‌داد.
          status.textContent = Chat.connected ? `${(Chat.online || 0).toLocaleString("fa-IR")} نفر آنلاین` : "در حال اتصال…";
          clear(headIcon, i("globe", 18));
          headEdit.hidden = true;
          headMute.hidden = true;
          pinBar.hidden = true;
        } else {
          let found = null, ownerGroup = null;
          (Chat.groups || []).forEach((g) => (g.channels || []).forEach((chn) => {
            if (Number(chn.id) === Number(Chat.currentChannel)) { found = chn; ownerGroup = g; }
          }));
          const isSaved = savedChannelId && Number(Chat.currentChannel) === Number(savedChannelId);
          // نامِ گروه مقدم است: کاربر گروه را می‌شناسد، نه نامِ کانالِ داخلش.
          chTitle.textContent = ownerGroup ? ownerGroup.name
            : (found ? found.name : (isSaved ? "پیام‌هایِ ذخیره‌شده" : "گفتگوی زنده"));
          // عکسِ گروه به‌جای آیکونِ عمومی
          clear(headIcon, ownerGroup && ownerGroup.photo
            ? h("img", { class: "nx-chat-head-photo", src: avatarUrl(ownerGroup.photo), alt: "" })
            : i(ownerGroup && ownerGroup.kind === "channel" ? "megaphone" : (isSaved ? "bookmark" : "users"), 18));
          const members = ownerGroup ? (ownerGroup.members || 1) : 0;
          // online از سرورِ تازه می‌آید؛ سرورِ قدیمی این فیلد را ندارد و آن‌وقت فقط
          // تعدادِ عضو نشان داده می‌شود (نه عددِ سراسریِ غلطِ قبلی).
          const onlineNow = ownerGroup && Number.isFinite(Number(ownerGroup.online))
            ? Number(ownerGroup.online) : null;
          const sub = ownerGroup
            ? (onlineNow !== null
                ? `${members.toLocaleString("fa-IR")} عضو · ${onlineNow.toLocaleString("fa-IR")} آنلاین`
                : `${members.toLocaleString("fa-IR")} عضو`)
  
            : (isSaved ? "دفترچه‌ی شخصیِ خودت" : "");
          status.textContent = Chat.connected ? sub : "در حال اتصال…";
          headEdit.hidden = !(ownerGroup && canManage(ownerGroup));
          syncMute(); syncPinBar();
        }
        syncHeadAffordance();
        if (signature === nextSignature) return;
        const near = list.scrollHeight - list.scrollTop - list.clientHeight < 130;
        // آلبوم: چند رسانه با album یکسان باید یک حبابِ واحد با شبکه‌ی عکس شوند، نه چند پیامِ
        // پشتِ‌سرِهم. اولین عضوِ هر آلبوم نماینده می‌شود و بقیه داخلش می‌روند.
        signature = nextSignature;
        // پاسِ اول فقط گروه‌بندی می‌کند (بدونِ رندر) — وگرنه آلبومی که اعضایش بعداً می‌آیند
        // با یک عضو رندر می‌شد. پاسِ دوم رندر می‌کند.
        const albums = new Map();
        messages.forEach((message) => {
          if (!message.album) return;
          if (!albums.has(message.album)) albums.set(message.album, []);
          albums.get(message.album).push(message);
        });
        const doneAlbums = new Set();
        const rendered = [];
        messages.forEach((message) => {
          if (!message.album) { rendered.push(liveLine(message, onReply)); return; }
          if (doneAlbums.has(message.album)) return;
          doneAlbums.add(message.album);
          rendered.push(liveLine(message, onReply, albums.get(message.album)));
        });
        clear(list, ...rendered);
        markMessageRuns(list);
        if (!messages.length) list.appendChild(blank("هنوز پیامی نیست", "اولین پیام زنده را تو بفرست.", "messageCircle"));
        scrollLatest(list, force || near);
        model.liveSeenCount = messages.length; model.liveUnread = 0; renderList();
      };
      const send = async (payload) => {
        if (!Chat.ws || Chat.ws.readyState !== 1) return toast("هنوز به گفتگوی زنده وصل نشده‌ای", "error");
        try {
          const quiet = payload.silent || undefined;   // ارسالِ بی‌صدا
          if (payload.type === "voice") {
            const uploaded = await call("chat_upload", { data: payload.dataUrl, kind: "voice", name: "voice.webm" });
            Chat.ws.send(JSON.stringify({ t: "msg", kind: "voice", media: uploaded.url, media_size: uploaded.size, duration: payload.duration, reply_to: payload.replyTo || undefined, silent: quiet }));
          } else if (payload.type === "videonote") {
            // ویدیوی گِرد به‌عنوانِ webm بالا می‌رود؛ سرور همان mp4/webm را برایِ videonote می‌پذیرد.
            const uploaded = await call("chat_upload", { data: payload.dataUrl, kind: "video", name: "videonote.webm" });
            Chat.ws.send(JSON.stringify({ t: "msg", kind: "videonote", media: uploaded.url, media_size: uploaded.size, duration: payload.duration, reply_to: payload.replyTo || undefined, silent: quiet }));
          } else if (payload.type === "file") {
            const uploaded = await uploadLargeFile(payload.file);
            Chat.ws.send(JSON.stringify({ t: "msg", kind: "file", media: uploaded.url, media_name: payload.file.name, media_size: uploaded.size, reply_to: payload.replyTo || undefined }));
          } else if (payload.type === "media") {
            const uploaded = await call("chat_upload", { data: payload.dataUrl, kind: payload.kind, name: payload.name });
            Chat.ws.send(JSON.stringify({ t: "msg", kind: uploaded.type || payload.kind, media: uploaded.url, media_name: payload.name, media_size: uploaded.size, reply_to: payload.replyTo || undefined }));
          } else {
            Chat.ws.send(JSON.stringify({ t: "msg", text: payload.text.slice(0, 300), reply_to: payload.replyTo || undefined, silent: quiet }));
          }
        } catch (error) { toast("ارسال ناموفق: " + error, "error"); }
      };
      const compose = composer("پیامت را برای همه بنویس…", send);
      conversation.append(bootstrap, h("section", { class: "nx-native-chat" }, head, pinBar, list, compose.node));
      await liveChatPage(bootstrap, { embedded: true, info, onBack: mobileBack });
      if (Chat.ws && Chat.ws.readyState === 1) Chat.ws.send(JSON.stringify({ t: "switch_channel", channel: targetChannel }));
      groupsModel.refresh();
      renderLive(true);
      // «چت بیشتر لود نمی‌کند»: بارگذاریِ اولیه فقط ۱۰۰ پیامِ آخر است و بقیه باید با
      // اسکرول به بالا بیاید — ولی آن هندلر فقط در رابطِ قدیمیِ چت وجود داشت
      // (app.js، روی .gc-list) و این لیست هیچ‌وقت چیزی درخواست نمی‌کرد. پس گفتگو
      // روی همان صد پیام گیر می‌کرد. گفتگوی مستقیم صفحه‌بندی داشت؛ فقط همین‌جا نبود.
      let loadingOlder = false;
      const loadOlderLive = async () => {
        if (destroyed || loadingOlder || Chat.noMoreHistory) return;
        if (!Chat.oldestId || !Chat.ws || Chat.ws.readyState !== 1) return;
        loadingOlder = true;
        const before = Chat.oldestId;
        const prevHeight = list.scrollHeight;
        const prevTop = list.scrollTop;
        // chatOnHistory در app.js خودش پاسخ را در Chat.msgs ادغام می‌کند؛ wsAsk فقط
        // ناظر است و پیام را مصرف نمی‌کند، پس این‌جا فقط منتظرِ رسیدنش می‌مانیم.
        await wsAsk({ t: "history", before }, "history",
          (m) => Number(m.before || 0) === Number(before), 8000);
        if (!destroyed) {
          renderLive();
          // لیست کاملاً بازساخته می‌شود و پیام‌های تازه بالایِ محتوایِ فعلی می‌نشینند؛
          // بدونِ این جبران، نما به‌اندازه‌ی همان محتوایِ اضافه‌شده می‌پرید.
          list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
        }
        loadingOlder = false;
      };
      list.addEventListener("scroll", () => { if (list.scrollTop < 120) loadOlderLive(); }, { passive: true });
      const livePoll = setIntervalWhenActive(renderLive, 300);
      stopConversation = () => { destroyed = true; clearInterval(livePoll); bootstrap.remove(); };
    }

    // یک فهرستِ واحد: فضای عمومی، کانال‌های گروه‌ها، پیام‌های مستقیم و دوستان — همه با یک
    // ریتمِ بصری و بدونِ آکاردئون/پاپ‌آپِ تودرتو، تا کلِ ارتفاعِ ستون صرفِ خودِ گفتگوها شود.
    // text می‌تواند رشته باشد یا یک المانِ آماده (مثلِ نامِ کلیک‌پذیرِ گروه).
    const sectionLabel = (text, action) => h("div", { class: "nx-inbox-section-label" },
      (text && text.nodeType) ? text : h("span", { text }), action || null);
    // فیلترِ فعال یک پوشه است؟ (folder:<id>)
    const activeFolderId = () => (String(model.filter).startsWith("folder:")
      ? Number(String(model.filter).split(":")[1]) : null);
    // آیا این گفتگو با فیلترِ فعلی باید دیده شود؟ آرشیو فقط در تبِ آرشیو، و پوشه فقط در تبِ خودش.
    const passesOrg = (kind, target) => {
      const pref = prefOf(kind, String(target));
      const folder = activeFolderId();
      if (model.filter === "archive") return !!(pref && pref.archived);
      if (pref && pref.archived) return false;
      if (folder) return !!(pref && pref.folder_id === folder);
      return true;
    };
    // سنجاق‌شده‌ها بالا می‌آیند (ترتیبِ بقیه دست‌نخورده می‌ماند).
    // سازنده‌ی ردیفِ کانال و ردیفِ پیامِ خصوصی — یک‌جا تعریف می‌شوند تا هم بخشِ «سنجاق‌شده»ی
    // بالایِ فهرست و هم بخشِ عادیِ خودشان از همین یکی بسازند و از هم واگرا نشوند.
    // با حذفِ سرگروه‌ها، نام و عکسِ گروه از فهرست غایب شده بود — ردیف فقط نامِ کانال و
    // یک آیکونِ ثابت داشت. حالا هویتِ خودِ گروه را نشان می‌دهد؛ نامِ کانال فقط وقتی به
    // زیرعنوان اضافه می‌شود که گروه بیش از یک کانال داشته باشد (وگرنه تکراری است).
    const channelRowOf = (group, channel) => {
      const parts = [];
      if (channel.type === "broadcast") parts.push("کانالِ اطلاع‌رسانی");
      const onlineNow = Number.isFinite(Number(group.online)) ? Number(group.online) : null;
      parts.push(`${(group.members || 1).toLocaleString("fa-IR")} عضو`);
      if (onlineNow) parts.push(`${onlineNow.toLocaleString("fa-IR")} آنلاین`);
      return inboxRow({
        live: !!onlineNow,
        title: group.name || channel.name,
        subtitle: parts.join(" · "),
        // عکسِ گروه؛ اگر نداشت avatar خودش حرفِ اولِ نام را می‌کشد
        image: group.photo || null,
        username: group.name || channel.name,
        glyph: group.photo ? null : (group.kind === "channel" || channel.type === "broadcast" ? "megaphone" : "users"),
        active: model.selected === "live" && Number(Chat.currentChannel) === Number(channel.id),
        onclick: () => openLive(channel.id),
        kind: "channel", target: channel.id, pref: prefOf("channel", String(channel.id)), org: model.org,
        plate: group.nameplate,
      });
    };
    const dmRowOf = (thread) => inboxRow({
      title: thread.username,
      subtitle: (thread.last_mine ? "تو: " : "") + threadPreview(thread.last_text),
      username: thread.username, image: thread.avatar, badge: thread.unread,
      active: model.selected === "dm:" + thread.username, onclick: () => openDm(thread),
      kind: "dm", target: thread.username, pref: prefOf("dm", thread.username), org: model.org,
    });
    const isPinned = (kind, target) => {
      const pref = prefOf(kind, String(target));
      // چتِ همگانی بخشِ جدا ندارد، پس پیش‌فرض سنجاق‌شده است. «آن‌پین کرده یا نه» را
      // نمی‌شود از pref سرور فهمید (ردیفِ pref با pinned=0 هم موقعِ آرشیو/پوشه ساخته
      // می‌شود)، پس تصمیمِ صریحِ کاربر جدا در کانفیگِ خودِ لانچر نگه داشته می‌شود.
      if (kind === "channel" && String(target) === "0") {
        return !(State.cfg && State.cfg.public_chat_unpinned);
      }
      // دفترچه‌ی شخصی بخشِ جدا ندارد، پس پیش‌فرض سنجاق‌شده است.
      if (kind === "saved") return !(State.cfg && State.cfg.saved_unpinned);
      return !!(pref && pref.pinned);
    };
    // هر بار که جست‌وجو دوباره اجرا شود این بالا می‌رود؛ پاسخِ کهنه دور ریخته می‌شود.
    let _msgSearchToken = 0;
    // renderList هر چند ثانیه (با رسیدنِ پیام یا نوشدنِ گفتگوها) دوباره صدا می‌شود؛
    // بدونِ کش، هر بار یک search_all تازه به سرور می‌رفت و فهرست هم می‌پرید.
    let _msgSearchCache = { query: null, rows: null };
    function renderList() {
      clear(list);
      const inFolderView = model.filter === "archive" || activeFolderId() !== null;
      const show = (kind) => model.filter === "all" || model.filter === kind || inFolderView;
      if (search.value.trim()) {
        const query = search.value.trim();
        const needle = query.toLowerCase();
        // ── یک فهرستِ ترکیبی، سبکِ تلگرام ──
        // قبلاً سه بخشِ جدا با عنوان بود؛ کاربر یک فهرستِ یکدست می‌خواهد.
        // چتِ همگانی هم عمداً بیرون است: هزاران پیامِ عمومیِ بی‌ربط نتیجه را بی‌فایده می‌کرد.
        const seenRow = new Set();

        // ۱) گفتگوها — نامِ گروه، نامِ کانال یا هندلِ عمومی
        (Chat.groups || []).forEach((group) => {
          const gName = String(group.name || "").toLowerCase();
          const gUser = String(group.username || "").toLowerCase();
          (group.channels || []).forEach((channel) => {
            if (!Number(channel.id)) return;              // چتِ همگانی نه
            const cName = String(channel.name || "").toLowerCase();
            if (!(gName.includes(needle) || gUser.includes(needle) || cName.includes(needle))) return;
            const key = "ch:" + channel.id;
            if (seenRow.has(key)) return;
            seenRow.add(key);
            if (group.joined) return list.appendChild(channelRowOf(group, channel));
            list.appendChild(inboxRow({
              title: group.name || channel.name,
              subtitle: `${(group.members || 1).toLocaleString("fa-IR")} عضو · برای پیوستن بزن`,
              image: group.photo || null, username: group.name || channel.name,
              glyph: group.photo ? null : "userPlus",
              onclick: () => {
                if (!Chat.ws || Chat.ws.readyState !== 1) return toast("هنوز به سرویسِ گفتگو وصل نشده‌ای", "error");
                Chat.ws.send(JSON.stringify({ t: "join_group", group: group.id }));
              },
            }));
          });
        });

        // ۲) گفتگوهایِ خصوصیِ موجود، بعد بازیکن‌هایِ تازه
        model.threads.filter((t) => String(t.username || "").toLowerCase().includes(needle))
          .forEach((thread) => {
            seenRow.add("dm:" + String(thread.username).toLowerCase());
            list.appendChild(dmRowOf(thread));
          });
        model.search.forEach((user) => {
          if (seenRow.has("dm:" + String(user.username).toLowerCase())) return;
          list.appendChild(inboxRow({ title: user.username, subtitle: "شروعِ پیامِ خصوصی",
            username: user.username, image: user.avatar, onclick: () => openDm(user) }));
        });

        // ۳) متنِ پیام‌ها — در همان فهرست، بدونِ عنوانِ بخش
        const msgBox = h("div", { class: "nx-searchmsgs" });
        list.appendChild(msgBox);
        const paintMsgs = (found) => {
          clear(msgBox);
          // چتِ همگانی (کانالِ ۰) از نتایج بیرون می‌ماند
          const rows = found.filter((m) => m.dm || Number(m.channel));
          if (!rows.length) {
            if (!list.querySelector(".nx-inbox-rowwrap")) {
              msgBox.appendChild(blank("چیزی پیدا نشد", "نامِ گفتگو، بازیکن یا متنِ دیگری را امتحان کن.", "search"));
            }
            return;
          }
          rows.slice(0, 40).forEach((m) => {
            // دایرکت: مقصدش خودِ گفتگویِ خصوصی است، نه یک کانال.
            const where = m.dm
              ? `پیامِ خصوصی · ${m.partner}`
              : (m.group_name ? `${m.group_name} · ${m.channel_name}` : (m.channel_name || "گفتگو"));
            msgBox.appendChild(h("button", { class: "nx-searchmsg", type: "button",
              onclick: () => (m.dm
                ? openDm({ username: m.partner, avatar: m.partner_avatar || null })
                : jumpToMessage(m.channel, m.id)) },
              h("span", { class: "nx-searchmsg-copy" },
                h("strong", { text: `${m.from} · ${where}` }),
                h("small", { text: (m.text || "پیامِ رسانه‌ای").slice(0, 140) })),
              h("small", { class: "nx-searchmsg-time", text: relativeTime(m.ts) })));
          });
        };
        if (query.length < 2) {
          if (!list.querySelector(".nx-inbox-rowwrap")) {
            msgBox.appendChild(h("p", { class: "nx-inbox-note", text: "کمی بیشتر بنویس…" }));
          }
        } else if (_msgSearchCache.query === query && _msgSearchCache.rows) {
          paintMsgs(_msgSearchCache.rows);
        } else {
          const token = ++_msgSearchToken;
          msgBox.appendChild(loading("جست‌وجو در پیام‌ها…"));
          // دو منبعِ جدا: کانال‌هایِ گروهی از سرورِ چت، دایرکت‌ها از سرورِ حساب.
          // با هم پرسیده و بعد بر اساسِ زمان یکجا مرتب می‌شوند.
          Promise.all([
            wsAsk({ t: "search_all", query }, "search_all_results", null, 6000)
              .then((d) => (d && d.messages) || []).catch(() => []),
            call("dm_search", { query })
              .then((d) => ((d && d.messages) || []).map((m) => Object.assign({ dm: true }, m)))
              .catch(() => []),
          ]).then(([channels, dms]) => {
            if (token !== _msgSearchToken || !msgBox.isConnected) return;
            const found = channels.concat(dms).sort((a, b) => (b.ts || 0) - (a.ts || 0));
            _msgSearchCache = { query, rows: found };
            paintMsgs(found);
          }).catch(() => {
            if (token !== _msgSearchToken || !msgBox.isConnected) return;
            clear(msgBox);
          });
        }
        return;
      }
      // ── سنجاق‌شده‌ها بالایِ همه‌چیز ──
      // تلگرام گفتگویِ سنجاق‌شده را بالایِ کلِ فهرست می‌برد، نه فقط بالایِ بخشِ خودش. قبلاً
      // مرتب‌سازی داخلِ هر گروه انجام می‌شد و سنجاق عملاً دیده نمی‌شد.
      // در تبِ «گروه‌ها» یک درگاه به فهرستِ همه‌ی گروه‌هایِ عمومی می‌گذاریم.
      // داده‌اش همان چیزی است که سرور از قبل می‌فرستد (db_groups گروه‌هایِ عمومی را
      // برایِ همه می‌فرستد)، پس درخواستِ تازه‌ای لازم نیست.
      // (شاخه‌ی جست‌وجو بالاتر return کرده، پس این‌جا قطعاً جست‌وجویی در جریان نیست)
      if (model.filter === "groups" && !inFolderView) {
        list.appendChild(h("button", { class: "nx-pubgroups-cta", type: "button",
          onclick: () => openPublicGroups() },
          h("span", { class: "nx-pubgroups-cta-icon" }, i("compass", 18)),
          h("span", { class: "nx-gm-row-copy" },
            h("strong", { text: "گشتن در گروه‌هایِ عمومی" }),
            h("small", { text: "همه‌ی گروه‌هایی که ساخته شده‌اند و عمومی‌اند" })),
          i("chevronLeft", 15)));
      }
      // ── مرتب‌سازی بر اساسِ تازگی ──
      // قبلاً کلِ گروه‌ها و کانال‌ها یک‌جا append می‌شدند و بعد دایرکت‌ها، پس هرچقدر
      // هم پیامِ تازه می‌گرفتی، گفتگویِ خصوصی زیرِ همه‌ی گروه‌ها می‌ماند. حالا در
      // نمایِ «همه» ردیف‌ها اول در یک سبد جمع می‌شوند و با زمانِ آخرین فعالیت مرتب.
      const unified = model.filter === "all" && !inFolderView;
      const bucket = [];
      const put = (ts, node) => {
        if (!node) return;
        if (unified) bucket.push({ ts: Number(ts) || 0, node });
        else list.appendChild(node);
      };
      const flushBucket = () => {
        if (!unified) return;
        bucket.sort((a, b) => b.ts - a.ts);
        bucket.forEach((x) => list.appendChild(x.node));
        bucket.length = 0;
      };

      const pinnedChannels = [];
      if (show("groups")) {
        (Chat.groups || []).filter((g) => g.joined).forEach((group) =>
          (group.channels || []).forEach((channel) => {
            if (passesOrg("channel", channel.id) && isPinned("channel", channel.id)) {
              pinnedChannels.push([group, channel]);
            }
          }));
      }
      const pinnedThreads = show("private")
        ? model.threads.filter((t) => passesOrg("dm", t.username) && isPinned("dm", t.username))
        : [];
      // چتِ همگانی و ذخیره‌شده‌ها گروه نیستند؛ در تبِ «گروه‌ها» نباید بیایند حتی
      // اگر سنجاق باشند. فقط در نمایِ «همه» (و پوشه، اگر عضوش کرده باشی) دیده می‌شوند.
      const personalRowsVisible = model.filter === "all" || inFolderView;
      const publicPinned = personalRowsVisible && passesOrg("channel", 0) && isPinned("channel", 0);
      const savedPinned = personalRowsVisible && !inFolderView && passesOrg("saved", "me") && isPinned("saved", "me");
      // عنوانِ «سنجاق‌شده» برداشته شد؛ خودِ نشانِ سنجاق رویِ هر ردیف گویا است.
      if (pinnedChannels.length || pinnedThreads.length || publicPinned || savedPinned) {
        if (savedPinned) {
          list.appendChild(inboxRow({ title: "پیام‌هایِ ذخیره‌شده", subtitle: "دفترچه‌ی شخصیِ خودت",
            glyph: "bookmark", onclick: () => openSavedChat(),
            kind: "saved", target: "me", pref: prefOf("saved", "me"), org: model.org,
            extraMenu: openSavedMenu }));
        }
        if (publicPinned) {
          list.appendChild(inboxRow({ title: "چتِ همگانی", subtitle: "گفتگوی زنده با همه‌ی بازیکن‌ها", glyph: "globe", live: true, badge: model.liveUnread, active: model.selected === "live" && !Chat.currentChannel, onclick: () => openLive(0),
            kind: "channel", target: 0, pref: prefOf("channel", "0"), org: model.org }));
        }
        pinnedChannels.forEach(([group, channel]) => list.appendChild(channelRowOf(group, channel)));
        pinnedThreads.forEach((thread) => list.appendChild(dmRowOf(thread)));
      }
      if (show("groups")) {
        // در نمایِ پوشه/آرشیو فقط همان گفتگوهایِ داخلش باید دیده شوند — نه دفترچه، نه صفِ
        // نه سرگروهی که هیچ کانالش در آن پوشه نیست. وگرنه پوشه بی‌معنی می‌شود.
        // بخشِ «خودم» حذف شد؛ این دو پیش‌فرض سنجاق‌شده‌اند و بالا می‌آیند. اگر کاربر
        // آن‌پینشان کند، بی‌عنوان داخلِ همین فهرستِ یکپارچه می‌نشینند.
        if (!inFolderView && model.filter === "all") {
          if (!isPinned("saved", "me") && passesOrg("saved", "me")) {
            list.appendChild(inboxRow({ title: "پیام‌هایِ ذخیره‌شده", subtitle: "دفترچه‌ی شخصیِ خودت",
              glyph: "bookmark", onclick: () => openSavedChat(),
              kind: "saved", target: "me", pref: prefOf("saved", "me"), org: model.org,
              extraMenu: openSavedMenu }));
          }
        }
        // چتِ همگانی هم مثلِ هر گفتگویِ دیگر سنجاق/آرشیو/پوشه می‌پذیرد (target=0).
        // بخشِ جدایِ «فضای عمومی» برداشته شد: یا بالا در سنجاق‌شده‌هاست، یا اگر
        // کاربر آن‌پینش کرده باشد، بی‌عنوان داخلِ همین فهرست می‌نشیند.
        if (personalRowsVisible && passesOrg("channel", 0) && !publicPinned) {
          put(Date.now() / 1000, inboxRow({ title: "چتِ همگانی", subtitle: "گفتگوی زنده با همه‌ی بازیکن‌ها", glyph: "globe", live: true, badge: model.liveUnread, active: model.selected === "live" && !Chat.currentChannel, onclick: () => openLive(0),
            kind: "channel", target: 0, pref: prefOf("channel", "0"), org: model.org }));
        }
        const groups = Chat.groups || [];
        const joined = groups.filter((group) => group.joined);
        // کانالِ مستقل یک گفتگوی تک‌خطی است، نه «گروهی که داخلش یک کانال است».
        // مدیریتش از عنوانِ خودِ گفتگو باز می‌شود (مثلِ تلگرام).
        const soloChannels = joined.filter((g) => g.kind === "channel");
        const realGroups = joined.filter((g) => g.kind !== "channel");
        const soloRows = [];
        soloChannels.forEach((g) => (g.channels || []).forEach((channel) => {
          if (passesOrg("channel", channel.id) && !isPinned("channel", channel.id)) {
            soloRows.push({ ts: channel.last_ts || channel.created_at || 0, node: inboxRow({
              title: g.name,
              subtitle: `کانال · ${(g.members || 1).toLocaleString("fa-IR")} عضو`,
              image: g.photo || null,
              username: g.name,
              glyph: g.photo ? null : "megaphone",
              active: model.selected === "live" && Number(Chat.currentChannel) === Number(channel.id),
              onclick: () => openLive(channel.id),
              kind: "channel", target: channel.id,
              pref: prefOf("channel", String(channel.id)), org: model.org,
              plate: g.nameplate,
            }) });
          }
        }));
        soloRows.forEach(({ ts, node }) => put(ts, node));
        realGroups.forEach((group) => {
          const visibleChannels = (group.channels || [])
            .filter((c) => passesOrg("channel", c.id) && !isPinned("channel", c.id));
          // سرگروهی که هیچ کانالی از آن در این نما نیست، اصلاً عنوان هم نمی‌گیرد.
          if (inFolderView && !visibleChannels.length) return;
          // مدیریتِ گروه قبلاً فقط یک چرخ‌دنده‌ی ۱۴ پیکسلیِ بی‌متن بود و کسی پیدایش نمی‌کرد.
          // حالا یک دکمه‌ی برچسب‌دار است، و کلِ نامِ گروه هم قابلِ کلیک است — دو راهِ آشکار.
          // سرگروه دیگر عنوانِ جدا نمی‌گیرد — کانال‌هایش مستقیم داخلِ همان فهرستِ
          // یکپارچه می‌آیند. مدیریتِ گروه از منویِ «…»ی هر کانال در دسترس است.
          visibleChannels.forEach((channel) =>
            put(channel.last_ts || channel.created_at || 0, channelRowOf(group, channel)));
        });
        // گروه‌هایِ عمومی‌ای که عضوشان نیستی هیچ‌جا در خودِ فهرست پیشنهاد نمی‌شوند —
        // فقط داخلِ «گشتن در گروه‌هایِ عمومی» (openPublicGroups) که جست‌وجو، مرتب‌سازی
        // و دکمه‌ی پیوستنِ خودش را دارد. سرور همه‌ی گروه‌هایِ عمومی را برایِ کشف
        // می‌فرستد و ریختنشان در فهرست، گفتگوهایِ واقعی را زیرِ ردیف‌هایی دفن می‌کرد
        // که کاربر هیچ‌وقت در آن‌ها پیامی نداشت.
      }
      if (show("private")) {
        _forwardThreads = model.threads || [];
        const threadUsers = new Set(model.threads.map((thread) => String(thread.username || "").toLowerCase()));
        const freshFriends = model.friends.filter((friend) => !threadUsers.has(String(friend.username || "").toLowerCase()));
        {
          model.threads
            .filter((t) => passesOrg("dm", t.username) && !isPinned("dm", t.username))
            .forEach((thread) => put(thread.last_at || 0, dmRowOf(thread)));
        }
        if (freshFriends.length) {
          freshFriends.forEach((friend) => put(0, inboxRow({ title: friend.username, subtitle: friend.online ? "آنلاین" : "شروعِ گفتگو", username: friend.username, image: friend.avatar, live: friend.online, active: model.selected === "dm:" + friend.username, onclick: () => openDm(friend) })));
        }
        if (!model.threads.length && !freshFriends.length && model.filter === "private") {
          list.appendChild(blank("هنوز پیامِ مستقیمی نداری", "نامِ یک بازیکن را بالا جست‌وجو کن و اولین پیام را بفرست.", "messageSquare"));
        }
      }
      flushBucket();
      if (!list.querySelector(".nx-inbox-row") && !list.querySelector(".nx-blank")) {
        list.appendChild(blank("هنوز گفتگویی نداری", "نامِ یک بازیکن را جست‌وجو کن و اولین پیام را بفرست."));
      }
    }

    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer); const query = search.value.trim();
      if (!query) { model.search = []; renderList(); return; }
      timer = setTimeout(async () => { const result = await call("dm_users", { q: query }).catch(() => null); model.search = (result && result.users) || []; renderList(); }, 240);
    });
    async function reload() {
      const [threadResult, friendResult] = await Promise.all([call("dm_threads").catch(() => ({ threads: [] })), call("friend_list").catch(() => ({ friends: [], incoming: [] }))]);
      model.threads = threadResult.threads || []; model.friends = friendResult.friends || []; renderList();
    }
    // پیاده‌سازیِ واقعیِ «پریدن به پیام» — این‌جا هم openLive در دسترس است هم
    // findMessageNode. پیام ممکن است اصلاً در تاریخچه‌ی بارگذاری‌شده نباشد، پس اول
    // محدوده‌ی دورِ آن از سرور گرفته و به Chat.msgs اضافه می‌شود؛ renderLive که هر
    // ۳۰۰ms اجرا می‌شود خودش گره را می‌سازد و بعد آن را پررنگ می‌کنیم.
    _jumpHook = async (channelId, messageId) => {
      const cid = Number(channelId) || 0;
      const mid = Number(messageId) || 0;
      if (!mid) return;
      if (Number(Chat.currentChannel) !== cid || !document.querySelector(".nx-native-chat-list")) {
        await openLive(cid);
      }
      const data = await wsAsk({ t: "history_around", channel: cid, message: mid },
        "history_around", (m) => Number(m.channel) === cid, 6000);
      if (data && Array.isArray(data.messages)) {
        const known = new Set((Chat.msgs || []).map((m) => String(m.id)));
        data.messages.forEach((m) => { if (!known.has(String(m.id))) Chat.msgs.push(m); });
      }
      for (let k = 0; k < 14; k++) {
        const node = findMessageNode(mid);
        if (node) {
          node.scrollIntoView({ behavior: "smooth", block: "center" });
          node.classList.remove("is-reply-ping");
          requestAnimationFrame(() => {
            node.classList.add("is-reply-ping");
            setTimeout(() => node.classList.remove("is-reply-ping"), 1600);
          });
          return;
        }
        await new Promise((done) => setTimeout(done, 130));
      }
      toast("آن پیام پیدا نشد.", "error");
    };
    onPageLeave(() => { _jumpHook = null; });

    const liveMonitor = setIntervalWhenActive(() => {
      const currentCount = Chat.msgs.length;
      if (currentCount > model.liveSeenCount) {
        const added = currentCount - model.liveSeenCount;
        model.liveSeenCount = currentCount;
        if (model.selected === "live") model.liveUnread = 0;
        else model.liveUnread += added;
        renderList();
      } else if (currentCount < model.liveSeenCount) {
        model.liveSeenCount = currentCount;
      }
    }, 800);
    const threadMonitor = setIntervalWhenActive(() => reload(), 5000);
    onPageLeave(() => { clearInterval(liveMonitor); clearInterval(threadMonitor); });
    clear(conversation, welcome()); await reload();
    // لانچر می‌تواند بخواهد مستقیم یک گفتگو باز شود — مثلاً دکمه‌ی «پیام به
    // کاربر» در پاپ‌آپِ هدیه‌ی اشتراک. بعد از مصرف پاک می‌شود تا بارِ بعد دوباره باز نشود.
    if (window.__nxPendingDm) {
      const target = String(window.__nxPendingDm);
      window.__nxPendingDm = null;
      const known = model.threads.find((t) => String(t.username).toLowerCase() === target.toLowerCase());
      openDm(known || { username: target, avatar: null });
    }
    if (focusInboxSearch) { focusInboxSearch = false; setTimeout(() => search.focus(), 60); }
    if (initial === "live") await openLive(0);
    else if (Messages.active) await openDm({ username: Messages.active, avatar: Messages.activeAvatar });
  }

  async function profilePage(root) {
    const info = await call("chat_info").catch(() => null);
    const stage = socialShell(root, "profile", info);
    if (!info || !info.logged_in) return loginRequired(stage);
    const username = getProfileTarget() || info.username;
    const page = h("div", { class: "nx-profile" }, loading("پروفایل…")); stage.appendChild(page);
    try {
      const profile = await call("user_profile", { username });
      noteProCosmetics(profile.username, profile.is_pro ? profile.color : null,
        profile.is_pro ? profile.ring : "none", profile.is_pro ? profile.nameplate : "none");
      const coverUrl = avatarUrl(profile.cover);
      const actions = h("div", { class: "nx-profile-actions" });
      if (profile.is_me) actions.appendChild(button("ویرایش پروفایل", "pencil", "primary", () => openEditProfileDialog(profile)));
      else {
        actions.append(button(profile.is_following ? "دنبال می‌کنی" : "دنبال کردن", "userPlus", "primary", async () => { try { await call("follow_user", { username: profile.username }); go("profile"); } catch (error) { toast(String(error), "error"); } }));
        actions.append(button("پیام", "messageSquare", "quiet", () => { Messages.active = profile.username; Messages.activeAvatar = profile.avatar; go("messages"); }));
        actions.append(button("تماس", "phone", "quiet", () => startDmCall(profile.username)));
      }
      const profileAvatar = avatar(profile.username, profile.avatar, profile.is_me ? 90 : 94, true);
      // دکمه‌ی شناورِ تغییرِ عکس برداشته شد — حالا داخلِ «ویرایش پروفایل» است، کنارِ بنر.
      const profileAvatarControl = profileAvatar;
      const hero = h("section", { class: "nx-profile-hero" },
        h("div", { class: "nx-cover" }, coverUrl ? h("img", { src: coverUrl, alt: "" }) : null),
        h("div", { class: "nx-profile-main" }, profileAvatarControl,
          h("div", { class: "nx-profile-copy" },
            h("h1", {}, proName(profile.username, profile.display_name || profile.username)),
            h("span", { text: "@" + profile.username }),
            profile.bio ? h("div", { class: "nx-profile-bio" }, richText(profile.bio)) : null),
          actions),
        h("div", { class: "nx-profile-stats" },
          PROFILE_POSTS_ENABLED ? h("span", {}, h("b", { text: String(profile.posts || 0) }), " پست") : null,
          // شمارنده‌ها حالا کلیک‌پذیرند — قبلاً عدد بودند و هیچ راهی برایِ دیدنِ خودِ فهرست نبود
          h("button", { class: "nx-stat-btn", type: "button", title: "دیدنِ دنبال‌کننده‌ها",
            onclick: () => openFollowSheet(profile.username, "followers") },
            h("b", { text: String(profile.followers || 0) }), " دنبال‌کننده"),
          h("button", { class: "nx-stat-btn", type: "button", title: "دیدنِ دنبال‌کرده‌ها",
            onclick: () => openFollowSheet(profile.username, "following") },
            h("b", { text: String(profile.following || 0) }), " دنبال‌کرده")));
      if (!PROFILE_POSTS_ENABLED) { clear(page, hero); return; }
      const grid = h("section", { class: "nx-profile-grid" }, loading("پست‌ها…"));
      clear(page, hero, h("div", { class: "nx-section-heading" }, h("h2", { text: "پست‌ها" }), h("span", { text: "آخرین فعالیت‌ها" })), grid);
      const result = await call("user_posts", { username: profile.username, before: null }); const posts = (result && result.posts) || [];
      // پستِ فقط-متنی حالا مثلِ کارتِ فید سر دارد (عکسِ پروفایل، نام، ساعت) و متنش
      // داخلِ کادر می‌ماند — قبلاً یک <p>ِ لخت بود و متنِ بلند از کاشی بیرون می‌زد.
      clear(grid, ...posts.map((post) => {
        const media = avatarUrl(post.image);
        const tile = h("button", {
          class: "nx-profile-tile" + (media ? " has-media" : " is-text"), type: "button",
          onclick: (e) => {
            if (swallowedBySelection(tile)) { e.preventDefault(); return; }
            openPostDetail(post, posts, { fullPage: true });
          },
        },
        media
          ? h("img", { src: media, alt: "", loading: "lazy" })
          : h("span", { class: "nx-tile-text" },
              h("span", { class: "nx-tile-head" },
                avatar(post.username || profile.username, post.avatar || profile.avatar, 26),
                h("span", { class: "nx-tile-who" },
                  h("strong", { text: post.username || profile.username }),
                  h("small", { text: relativeTime(post.created_at) }))),
              h("p", {}, richText(post.text || ""))),
        h("span", { class: "nx-tile-stats" }, i("heart", 14), ` ${post.likes || 0}`,
          i("messageCircle", 14), ` ${post.comments || 0}`));
        return tile;
      }));
      if (!posts.length) grid.appendChild(blank("هنوز پستی ندارد"));
    } catch (error) { clear(page, blank("پروفایل بارگذاری نشد", String(error), "warn")); }
  }

  async function hashtagPage(root) {
    const info = await call("chat_info").catch(() => null);
    const stage = socialShell(root, "hashtag", info);
    if (!info || !info.logged_in) return loginRequired(stage);
    const tag = getHashtagTarget();
    const feed = h("div", { class: "nx-feed nx-hashtag-feed" },
      h("header", { class: "nx-hashtag-head" },
        h("button", { class: "nx-hashtag-back", type: "button", title: "برگشت به فید", onclick: () => go("feed") }, i("arrowRight", 17)),
        h("span", { class: "nx-hashtag-mark" }, i("hash", 19)),
        h("div", {}, h("h1", { text: tag ? "#" + tag : "هشتگ" }), h("small", { text: "پست‌هایی که با این موضوع نشانه‌گذاری شده‌اند" }))),
      h("div", { class: "nx-feed-list" }, loading()));
    stage.appendChild(feed); if (!tag) return;
    const list = feed.querySelector(".nx-feed-list");
    try { const result = await call("hashtag_posts", { tag, before: null }); const posts = (result && result.posts) || []; clear(list, ...posts.map(postCard)); if (!posts.length) list.appendChild(blank("پستی پیدا نشد")); }
    catch (error) { clear(list, blank("پست‌ها بارگذاری نشدند", String(error))); }
  }

  Pages.feed = FEED_ENABLED ? feedPage : (root) => inboxPage(root, null);
  // «کشف» به‌عنوان صفحه حذف شد؛ هر لینکِ قدیمی به همان فید می‌رود.
  Pages.explore = Pages.feed;
  Pages.social = (root) => inboxPage(root, null);
  Pages.messages = (root) => inboxPage(root, null);
  Pages.chat = (root) => inboxPage(root, "live");
  Pages.profile = profilePage;
  Pages.hashtag = FEED_ENABLED ? hashtagPage : Pages.feed;
  return { notificationsControl };
}
