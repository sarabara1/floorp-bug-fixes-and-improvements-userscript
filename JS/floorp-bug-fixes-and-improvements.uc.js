// ==UserScript==
// @name           floorp-bug-fixes-and-improvements.uc.js
// @description    Floorp Bug Fixes & Improvements: fixes for Floorp's bugs, tab stacks that work like normal tabs, and extra features, with a settings page
// @include        main
// @version        1.3.0
// ==/UserScript==

// Fixes for bugs in Floorp, improvements that make its tab stacks look and
// behave like normal tabs, and a set of optional features, all in one file.
// Each one is a "feature" you can turn on or off on the settings page:
// Tools → Floorp Bug Fixes & Improvements, right-click the tab bar → Floorp
// Bug Fixes & Improvements, or the toolbar button you can add from Customize
// Toolbar. Changes apply right away in every window. Settings are prefs under
// `uc.floorp-improvements.`.
//
// Layout of this file:
//   1. Core      settings, the feature registry and status reporting
//   2. Hooks     one shared wrapper per patched function or property, so
//                features that patch the same thing chain instead of clashing
//   3. Events    one shared listener per target and event type, so each
//                feature's handler is isolated from the others
//   4. Context   what a feature gets in init(). Every hook, listener,
//                observer, style, timer and element it creates is tracked,
//                and removed again when the feature is turned off
//   5. Helpers   shared knowledge of Floorp's stack DOM
//   6. Features  by category
//   7. Settings page
//   8. Startup
//
// Safety. A feature that throws while starting is shut down and marked
// "Failed to load". A feature whose Floorp/Firefox internals have gone missing
// is marked "Unavailable". An error inside a running feature's hook or
// listener is recorded and the original behaviour carries on (a hook that
// fails before calling through calls through for it). None of these stop the
// other features, and all of them show on the settings page.
//
// If a feature's old standalone script (e.g. stacktab-multiselect.uc.js) is
// still installed, this file's copy of that feature is skipped so the two
// don't run twice; the settings page says which files to remove.
//
// Setting `uc.floorp-improvements.paused` to true in about:config turns
// every feature off without uninstalling anything; the settings page stays
// available to turn it back on.

(function () {
  "use strict";

  if (window.UCFloorpImprovements) {
    console.warn("[FBFI] Floorp Bug Fixes & Improvements is already running in this window; ignoring a second copy.");
    return;
  }

  const LOG = "[FBFI]";
  // This file's version: the @version line in the header above, as
  // fx-autoconfig read it. The update check compares it with the @version of
  // the copy on GitHub, so that line is the only one to change for a release.
  // Found by this file's name, or by its @name if the file was renamed. Empty
  // if the loader can't say (the update check then offers nothing).
  const VERSION = (() => {
    const leaf = (url) => String(url ?? "").split(" -> ").pop().split(/[?#]/)[0].split("/").pop();
    try {
      let scripts;
      try {
        scripts = ChromeUtils.importESModule("chrome://userchromejs/content/uc_api.sys.mjs").Scripts;
      } catch (e) {
        scripts = window._ucUtils; // older loaders
      }
      const all = scripts?.getScriptData?.() ?? [];
      const own = leaf(new Error().fileName);
      const info = all.find(s => s?.filename === own) ??
        all.find(s => s?.name?.trim() === "floorp-bug-fixes-and-improvements.uc.js");
      const version = info?.version?.trim();
      if (version) return version;
    } catch (e) {
      console.warn(LOG, "couldn't read this file's version from fx-autoconfig", e);
      return "";
    }
    console.warn(LOG, "fx-autoconfig doesn't list this file's version; update checks won't offer updates");
    return "";
  })();
  const PREF_ROOT = "uc.floorp-improvements.";
  const PREF_FEATURE = PREF_ROOT + "feature.";
  const PREF_PAUSED = PREF_ROOT + "paused";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const MAX_ERRORS_KEPT = 20;   // per feature, for the settings page
  const MAX_ERRORS_LOGGED = 5;  // per feature, to the console (then every 50th)
  const HOOK_TRIP_LIMIT = 25;   // errors before a hook is bypassed for good

  // ================================================================ 1. core ==

  const STATUS = Object.freeze({
    OFF: "off",                 // turned off
    PAUSED: "paused",           // everything paused via the pref
    WAITING: "waiting",         // needs another feature that's off
    SKIPPED: "skipped",         // the old standalone script is running instead
    STARTING: "starting",
    ON: "on",
    WARN: "warn",               // running, but part of it couldn't start
    ERROR: "error",             // running, but it has thrown since
    FAILED: "failed",           // threw while starting; shut down
    UNAVAILABLE: "unavailable", // something it needs is missing; not started
  });
  const PROBLEM_STATUSES = new Set([STATUS.ERROR, STATUS.FAILED, STATUS.UNAVAILABLE]);

  // Thrown when something a feature relies on isn't there, which almost always
  // means a Floorp or Firefox update renamed or removed it.
  class Unavailable extends Error {
    constructor(message) {
      super(message);
      this.name = "Unavailable";
    }
  }

  const errorMessage = (e) => {
    if (e == null) return "Unknown error";
    if (typeof e === "string") return e;
    return e.message ? `${e.name && e.name !== "Error" ? e.name + ": " : ""}${e.message}` : String(e);
  };
  const errorStack = (e) => (typeof e?.stack === "string" ? e.stack : "");

  const CATEGORIES = [
    {
      id: "fixes",
      name: "Bug Fixes",
      description: "Fixes for bugs in Floorp's tab stacks, tab bar, workspaces and sidebar.",
    },
    {
      id: "stacks",
      name: "Stack Improvements",
      description: "Make stacks and the tabs inside them look and behave like normal tabs.",
    },
    {
      id: "stack-features",
      name: "Stack Features",
      description: "Optional changes to how stacks behave.",
    },
    {
      id: "appearance",
      name: "Appearance",
      description: "Optional style changes.",
    },
    {
      id: "browser",
      name: "Browser",
      description: "Improvements that aren't specific to stacks.",
    },
  ];

  const Prefs = {
    featureEnabled(id, fallback) {
      try {
        return Services.prefs.getBoolPref(PREF_FEATURE + id, fallback);
      } catch (e) {
        return fallback;
      }
    },
    setFeatureEnabled(id, value) {
      Services.prefs.setBoolPref(PREF_FEATURE + id, !!value);
    },
    paused() {
      try {
        return Services.prefs.getBoolPref(PREF_PAUSED, false);
      } catch (e) {
        return false;
      }
    },
    setPaused(value) {
      if (value) Services.prefs.setBoolPref(PREF_PAUSED, true);
      else Services.prefs.clearUserPref(PREF_PAUSED);
    },
    resetAll() {
      for (const name of Services.prefs.getChildList(PREF_FEATURE)) {
        Services.prefs.clearUserPref(name);
      }
    },

    // Features whose id (and so pref name) changed: a choice saved under the
    // old name moves to the new one, once.
    RENAMED: { "theme-stack-colours": "theme-stack-colors" },
    migrateRenamed() {
      for (const [from, to] of Object.entries(this.RENAMED)) {
        try {
          const old = PREF_FEATURE + from;
          if (!Services.prefs.prefHasUserValue(old)) continue;
          if (!Services.prefs.prefHasUserValue(PREF_FEATURE + to)) {
            Services.prefs.setBoolPref(PREF_FEATURE + to, Services.prefs.getBoolPref(old));
          }
          Services.prefs.clearUserPref(old);
        } catch (e) {
          console.warn(LOG, `couldn't carry over the setting for "${from}"`, e);
        }
      }
    },
  };

  // ---- change notifications (settings page, menu labels) ----
  const changeListeners = new Set();
  let changeQueued = false;
  function notifyChanged() {
    if (changeQueued) return;
    changeQueued = true;
    Promise.resolve().then(() => {
      changeQueued = false;
      for (const fn of [...changeListeners]) {
        try {
          fn();
        } catch (e) {
          console.error(LOG, "change listener failed", e);
        }
      }
    });
  }
  function onChanged(fn) {
    changeListeners.add(fn);
    return () => changeListeners.delete(fn);
  }

  // ---- features ----
  class Feature {
    constructor(def) {
      this.def = def;
      this.id = def.id;
      this.status = STATUS.OFF;
      this.reason = "";      // why it's waiting / skipped / unavailable / failed
      this.warnings = [];
      this.errors = [];      // { time, where, message, stack }
      this.errorCount = 0;
      this.ctx = null;       // the live Context while it's running
    }

    get enabled() {
      return Prefs.featureEnabled(this.id, !!this.def.default);
    }

    get running() {
      return !!this.ctx?.alive;
    }

    get hasProblem() {
      return PROBLEM_STATUSES.has(this.status);
    }

    recordError(error, where) {
      this.errorCount++;
      this.errors.push({ time: Date.now(), where, message: errorMessage(error), stack: errorStack(error) });
      if (this.errors.length > MAX_ERRORS_KEPT) this.errors.shift();
      if (this.errorCount <= MAX_ERRORS_LOGGED || this.errorCount % 50 === 0) {
        console.error(`${LOG} ${this.id}: error in ${where}`, error);
      }
    }

    // An error while the feature is running. It keeps running.
    fail(error, where = "callback") {
      this.recordError(error, where);
      if (this.status === STATUS.ON || this.status === STATUS.WARN) this.status = STATUS.ERROR;
      notifyChanged();
    }

    warn(message) {
      if (this.warnings.includes(message)) return;
      this.warnings.push(message);
      console.warn(`${LOG} ${this.id}: ${message}`);
      if (this.status === STATUS.ON) this.status = STATUS.WARN;
      notifyChanged();
    }
  }

  const features = [];
  const featureById = new Map();

  // A feature with `parent` is a sub-setting: it's shown under its parent on
  // the settings page, takes the parent's category, and only runs while the
  // parent is on. The parent must be defined first.
  function defineFeature(def) {
    try {
      if (!def?.id || featureById.has(def.id)) throw new Error(`bad or duplicate feature id "${def?.id}"`);
      if (def.parent) {
        const parent = featureById.get(def.parent);
        if (!parent || parent.def.parent) throw new Error(`${def.id}: parent "${def.parent}" isn't a top-level feature defined before it`);
        def = { ...def, category: parent.def.category };
      }
      if (!CATEGORIES.some(c => c.id === def.category)) throw new Error(`${def.id}: unknown category "${def.category}"`);
      if (typeof def.init !== "function") throw new Error(`${def.id}: no init()`);
      const feature = new Feature(def);
      features.push(feature);
      featureById.set(def.id, feature);
    } catch (e) {
      console.error(LOG, "couldn't register a feature", e);
    }
  }

  const isActive = (id) => !!featureById.get(id)?.running;

  // ---- the old standalone scripts ----
  // fx-autoconfig can list the scripts and styles it found. If a feature's
  // standalone file is among the enabled ones, it's already running, so this
  // file's copy stays off.
  const Standalone = {
    files: new Set(),
    loaderVersion: "",

    detect() {
      this.files.clear();
      let api = null;
      try {
        api = ChromeUtils.importESModule("chrome://userchromejs/content/uc_api.sys.mjs");
      } catch (e) {
        // older loaders expose _ucUtils instead
      }
      try {
        const scripts = api?.Scripts ?? window._ucUtils;
        const lists = [];
        if (typeof scripts?.getScriptData === "function") lists.push(scripts.getScriptData());
        if (typeof scripts?.getStyleData === "function") lists.push(scripts.getStyleData());
        for (const list of lists) {
          for (const info of list ?? []) {
            if (info?.filename && info.isEnabled !== false) this.files.add(info.filename);
          }
        }
        this.loaderVersion = api?.Runtime?.loaderVersion ?? "";
      } catch (e) {
        console.warn(LOG, "couldn't list the installed userscripts; old standalone copies won't be detected", e);
      }
    },

    running(file) {
      return this.files.has(file);
    },

    // Installed standalone files that this script replaces.
    installed() {
      const all = new Set();
      for (const f of features) for (const file of f.def.standalone ?? []) all.add(file);
      return [...all].filter(file => this.files.has(file)).sort();
    },
  };

  // =============================================================== 2. hooks ==
  // One "site" per patched function (or property accessor). The site replaces
  // the function once with a dispatcher that runs every feature's wrapper in
  // priority order (lower first, i.e. outermost) and then the original. A
  // wrapper is called as `fn.call(thisArg, next, ...args)` and continues the
  // chain with `next(...args)`.
  //
  // Wrappers that throw are isolated: if the wrapper hadn't called `next` yet,
  // the rest of the chain runs as if the wrapper weren't there; if it had, its
  // result stands. Errors thrown by the original (or a later wrapper) pass
  // through untouched. A wrapper that keeps throwing is bypassed for good.
  // Turning a feature off removes its wrappers; the last one to go restores
  // the original function, unless someone else has wrapped the dispatcher in
  // the meantime, in which case it's left in place as a pass-through.

  function describeTarget(obj) {
    try {
      if (obj === window.gBrowser) return "gBrowser";
      if (obj === window.gBrowser?.tabContainer) return "gBrowser.tabContainer";
      if (obj === window.gBrowser?.tabContainer?.tabDragAndDrop) return "tabDragAndDrop";
      if (obj === window.TabContextMenu) return "TabContextMenu";
      if (Object.prototype.hasOwnProperty.call(obj, "constructor") && typeof obj.constructor === "function") {
        const tag = window.customElements?.getName?.(obj.constructor);
        return tag ? `<${tag}>` : `${obj.constructor.name || "anonymous"}.prototype`;
      }
      let id = null;
      try {
        id = obj.id; // throws on some DOM prototypes
      } catch (e) {}
      if (typeof id === "string" && id) return `#${id}`;
      return obj?.constructor?.name || "object";
    } catch (e) {
      return "object";
    }
  }

  function findDescriptor(obj, name) {
    for (let o = obj; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d) return d;
    }
    return null;
  }

  const Hooks = (() => {
    const sites = [];

    // Runs `chain[i..]`, then `terminal(thisArg, args)`.
    function run(site, chain, i, thisArg, args, terminal) {
      while (i < chain.length && (chain[i].tripped || !chain[i].feature.running)) i++;
      if (i >= chain.length) return terminal(thisArg, args);

      const link = chain[i];
      const state = { called: false, done: false, result: undefined, threw: false, error: undefined };
      const next = (...nextArgs) => {
        state.called = true;
        try {
          const result = run(site, chain, i + 1, thisArg, nextArgs, terminal);
          state.done = true;
          state.result = result;
          return result;
        } catch (e) {
          state.threw = true;
          state.error = e;
          throw e;
        }
      };

      try {
        return link.fn.call(thisArg, next, ...args);
      } catch (e) {
        if (state.threw && e === state.error) throw e; // from further down the chain
        link.errors++;
        link.feature.fail(e, `hook on ${site.label}`);
        if (link.errors >= HOOK_TRIP_LIMIT && !link.tripped) {
          link.tripped = true;
          link.feature.warn(`Stopped using its hook on ${site.label} after ${HOOK_TRIP_LIMIT} errors.`);
        }
        if (!state.called) return run(site, chain, i + 1, thisArg, args, terminal);
        if (state.done) return state.result;
        throw e;
      }
    }

    function addLink(site, chainName, link) {
      const chain = [...site[chainName], link];
      chain.sort((a, b) => a.priority - b.priority || a.order - b.order);
      site[chainName] = chain;
    }

    let linkOrder = 0;

    function method(feature, obj, name, fn, { priority = 0 } = {}) {
      if (!obj) throw new Unavailable(`can't patch "${name}": its owner object doesn't exist`);
      let site = sites.find(s => s.kind === "method" && s.obj === obj && s.name === name);
      if (!site) {
        const original = obj[name];
        if (typeof original !== "function") {
          throw new Unavailable(`${describeTarget(obj)}.${name} isn't a function`);
        }
        const hadOwn = Object.prototype.hasOwnProperty.call(obj, name);
        site = {
          kind: "method",
          obj,
          name,
          label: `${describeTarget(obj)}.${name}`,
          original,
          hadOwn,
          ownDesc: hadOwn ? Object.getOwnPropertyDescriptor(obj, name) : null,
          links: [],
          dispatcher: null,
        };
        const terminal = (thisArg, args) => site.original.apply(thisArg, args);
        const s = site;
        site.dispatcher = function (...args) {
          return run(s, s.links, 0, this, args, terminal);
        };
        try {
          Object.defineProperty(site.dispatcher, "name", { value: original.name || name });
          Object.defineProperty(site.dispatcher, "length", { value: original.length });
        } catch (e) {}
        site.dispatcher.__tsiOriginal = original;
        Object.defineProperty(obj, name, {
          configurable: true,
          enumerable: site.ownDesc?.enumerable ?? false,
          writable: true,
          value: site.dispatcher,
        });
        sites.push(site);
      }
      const link = { feature, fn, priority, order: linkOrder++, errors: 0, tripped: false };
      addLink(site, "links", link);
      return () => removeLink(site, "links", link);
    }

    // `which` is "get" or "set". A get wrapper is fn.call(this, next) and
    // returns the value; a set wrapper is fn.call(this, next, value).
    function accessor(feature, obj, name, which, fn, { priority = 0 } = {}) {
      if (!obj) throw new Unavailable(`can't patch "${name}": its owner object doesn't exist`);
      let site = sites.find(s => s.kind === "accessor" && s.obj === obj && s.name === name);
      if (!site) {
        const desc = findDescriptor(obj, name);
        if (!desc || (!desc.get && !desc.set)) {
          throw new Unavailable(`${describeTarget(obj)}.${name} isn't an accessor property`);
        }
        const hadOwn = Object.prototype.hasOwnProperty.call(obj, name);
        site = {
          kind: "accessor",
          obj,
          name,
          label: `${describeTarget(obj)}.${name}`,
          desc,
          hadOwn,
          ownDesc: hadOwn ? Object.getOwnPropertyDescriptor(obj, name) : null,
          getLinks: [],
          setLinks: [],
          dispatcher: null,
        };
        const s = site;
        const getTerminal = (thisArg) => s.desc.get.call(thisArg);
        const setTerminal = (thisArg, args) => s.desc.set.call(thisArg, args[0]);
        const get = desc.get ? function () { return run(s, s.getLinks, 0, this, [], getTerminal); } : undefined;
        const set = desc.set ? function (value) { run(s, s.setLinks, 0, this, [value], setTerminal); } : undefined;
        site.dispatcher = get ?? set;
        Object.defineProperty(obj, name, {
          configurable: true,
          enumerable: desc.enumerable,
          get,
          set,
        });
        sites.push(site);
      }
      if (which === "get" && !site.desc.get) throw new Unavailable(`${site.label} has no getter`);
      if (which === "set" && !site.desc.set) throw new Unavailable(`${site.label} has no setter`);
      const chainName = which === "get" ? "getLinks" : "setLinks";
      const link = { feature, fn, priority, order: linkOrder++, errors: 0, tripped: false };
      addLink(site, chainName, link);
      return () => removeLink(site, chainName, link);
    }

    function intact(site) {
      if (site.kind === "method") return site.obj[site.name] === site.dispatcher;
      const d = Object.getOwnPropertyDescriptor(site.obj, site.name);
      return !!d && (d.get ?? d.set) === site.dispatcher;
    }

    function removeLink(site, chainName, link) {
      site[chainName] = site[chainName].filter(l => l !== link);
      const empty = site.kind === "method"
        ? !site.links.length
        : !site.getLinks.length && !site.setLinks.length;
      if (!empty) return;
      // Someone wrapped the dispatcher after us: leave it as a pass-through.
      if (!intact(site)) return;
      try {
        if (site.hadOwn) Object.defineProperty(site.obj, site.name, site.ownDesc);
        else delete site.obj[site.name];
      } catch (e) {
        console.error(LOG, `couldn't restore ${site.label}`, e);
        return;
      }
      sites.splice(sites.indexOf(site), 1);
    }

    // The unwrapped function, for code that must bypass every feature.
    function original(obj, name) {
      const site = sites.find(s => s.kind === "method" && s.obj === obj && s.name === name);
      return site ? site.original : obj?.[name];
    }

    function report() {
      return sites.map(site => ({
        target: site.label,
        intact: intact(site),
        wrappers: (site.kind === "method" ? site.links : [...site.getLinks, ...site.setLinks])
          .map(l => `${l.feature.id}${l.tripped ? " (bypassed)" : ""}`),
      }));
    }

    return { method, accessor, original, report };
  })();

  // ============================================================== 3. events ==
  // One real listener per (target, type, capture, passive), shared by every
  // feature. Handlers run in priority order (lower first), then registration
  // order, each in its own try/catch. stopImmediatePropagation() from one
  // handler still stops the ones after it, as with separate listeners.

  const Events = (() => {
    const channelsByTarget = new WeakMap();
    let handlerOrder = 0;
    let channelCount = 0;

    function dispatch(channel, event) {
      const handlers = channel.handlers; // snapshot: handlers added mid-dispatch wait
      let stopped = false;
      let patched = false;
      try {
        const stopImmediate = event.stopImmediatePropagation;
        event.stopImmediatePropagation = function () {
          stopped = true;
          return stopImmediate.call(this);
        };
        patched = true;
      } catch (e) {
        // non-extensible event; handlers just won't see each other's stops
      }
      try {
        for (const h of handlers) {
          if (stopped) break;
          if (!h.feature.running) continue;
          try {
            h.fn.call(channel.target, event);
          } catch (e) {
            h.feature.fail(e, `${channel.type} handler`);
          }
        }
      } finally {
        if (patched) {
          try {
            delete event.stopImmediatePropagation;
          } catch (e) {}
        }
      }
    }

    function listen(feature, target, type, fn, options = {}) {
      if (!target) throw new Unavailable(`nothing to listen to for "${type}" events`);
      const capture = typeof options === "boolean" ? options : !!options.capture;
      const passive = typeof options === "object" ? options.passive : undefined;
      const priority = (typeof options === "object" && options.priority) || 0;
      const key = `${type}|${capture ? 1 : 0}|${passive === undefined ? "" : passive ? 1 : 0}`;

      let channels = channelsByTarget.get(target);
      if (!channels) channelsByTarget.set(target, channels = new Map());
      let channel = channels.get(key);
      if (!channel) {
        channel = { target, type, capture, passive, handlers: [], listener: null };
        const c = channel;
        channel.listener = (event) => dispatch(c, event);
        const opts = { capture };
        if (passive !== undefined) opts.passive = passive;
        target.addEventListener(type, channel.listener, opts);
        channels.set(key, channel);
        channelCount++;
      }

      const handler = { feature, fn, priority, order: handlerOrder++ };
      channel.handlers = [...channel.handlers, handler]
        .sort((a, b) => a.priority - b.priority || a.order - b.order);

      return () => {
        channel.handlers = channel.handlers.filter(h => h !== handler);
        if (channel.handlers.length) return;
        try {
          target.removeEventListener(type, channel.listener, { capture });
        } catch (e) {}
        channels.delete(key);
        channelCount--;
      };
    }

    return { listen, get channelCount() { return channelCount; } };
  })();

  // One MutationObserver on the toolbox (both tab rows live in it), shared by
  // every feature that needs to know when Floorp rebuilds the stack bar.
  // Subscribers are called synchronously from the observer callback.
  const ToolboxWatcher = (() => {
    let observer = null;
    let subscribers = [];

    function subscribe(feature, fn) {
      const sub = { feature, fn };
      subscribers = [...subscribers, sub];
      if (!observer) {
        const target = document.getElementById("navigator-toolbox") ?? document.documentElement;
        observer = new MutationObserver((records) => {
          for (const s of subscribers) {
            if (!s.feature.running) continue;
            try {
              s.fn(records);
            } catch (e) {
              s.feature.fail(e, "toolbox change handler");
            }
          }
        });
        observer.observe(target, { childList: true, subtree: true });
      }
      return () => {
        subscribers = subscribers.filter(s => s !== sub);
        if (!subscribers.length && observer) {
          observer.disconnect();
          observer = null;
        }
      };
    }

    return { subscribe };
  })();

  // Stylesheets go in as author sheets, as fx-autoconfig loads .uc.css files.
  const Styles = {
    add(css, tag) {
      const text = `/* floorp-bug-fixes-and-improvements: ${tag} */\n${css}`;
      const uri = "data:text/css;charset=utf-8," + encodeURIComponent(text);
      const utils = window.windowUtils;
      try {
        utils.loadSheetUsingURIString(uri, utils.AUTHOR_SHEET);
        return () => {
          try {
            utils.removeSheetUsingURIString(uri, utils.AUTHOR_SHEET);
          } catch (e) {}
        };
      } catch (e) {
        const style = document.createElementNS(XHTML_NS, "style");
        style.textContent = text;
        (document.head ?? document.documentElement).append(style);
        return () => style.remove();
      }
    },
  };

  // ============================================================= 4. context ==
  // Everything a feature sets up goes through its Context, so turning the
  // feature off (or a failed start) can undo all of it.

  class Context {
    constructor(feature) {
      this.feature = feature;
      this.alive = true;
      this._disposers = [];
      this._timers = new Set();
      this._frames = new Set();
    }

    // -- lifecycle --
    _add(disposer) {
      if (!this.alive) {
        try {
          disposer();
        } catch (e) {}
        return disposer;
      }
      this._disposers.push(disposer);
      return disposer;
    }

    dispose() {
      if (!this.alive) return;
      this.alive = false;
      for (const id of this._timers) clearTimeout(id);
      for (const id of this._frames) cancelAnimationFrame(id);
      this._timers.clear();
      this._frames.clear();
      for (const d of this._disposers.splice(0).reverse()) {
        try {
          d();
        } catch (e) {
          this.feature.recordError(e, "turning off");
        }
      }
    }

    // Runs when the feature is turned off, after everything registered after
    // it has been removed (disposal runs in reverse order).
    onCleanup(fn) {
      return this._add(fn);
    }

    // -- status --
    require(value, what) {
      if (!value) throw new Unavailable(what);
      return value;
    }

    warn(message) {
      this.feature.warn(message);
    }

    fail(error, where) {
      this.feature.fail(error, where);
    }

    isActive(id) {
      return isActive(id);
    }

    // Runs `fn`; if it throws Unavailable, the feature carries on with a
    // warning instead of failing. For optional parts of a feature.
    optional(fn, message) {
      try {
        return fn();
      } catch (e) {
        if (!(e instanceof Unavailable)) throw e;
        this.warn(message ? `${message} (${e.message})` : e.message);
        return undefined;
      }
    }

    // Wraps a callback so its errors are recorded against this feature, and so
    // it does nothing once the feature is off.
    guard(fn, where = "callback") {
      const ctx = this;
      return function (...args) {
        if (!ctx.alive) return undefined;
        try {
          return fn.apply(this, args);
        } catch (e) {
          ctx.feature.fail(e, where);
          return undefined;
        }
      };
    }

    // Reports a rejected promise as an error of this feature.
    async(promise, where = "async task") {
      Promise.resolve(promise).catch(e => {
        if (!this.alive) return;
        if (e instanceof Unavailable) this.warn(e.message);
        else this.fail(e, where);
      });
    }

    // -- patching --
    hook(obj, name, fn, options) {
      return this._add(Hooks.method(this.feature, obj, name, fn, options));
    }

    hookGetter(obj, name, fn, options) {
      return this._add(Hooks.accessor(this.feature, obj, name, "get", fn, options));
    }

    hookSetter(obj, name, fn, options) {
      return this._add(Hooks.accessor(this.feature, obj, name, "set", fn, options));
    }

    // -- events and observers --
    listen(target, type, fn, options) {
      return this._add(Events.listen(this.feature, target, type, fn, options));
    }

    watchToolbox(fn) {
      return this._add(ToolboxWatcher.subscribe(this.feature, fn));
    }

    observe(target, init, fn) {
      if (!target) throw new Unavailable("nothing to observe");
      const mo = new MutationObserver(this.guard(fn, "mutation observer"));
      mo.observe(target, init);
      this._add(() => mo.disconnect());
      return mo;
    }

    resizeObserver(fn) {
      const ro = new ResizeObserver(this.guard(fn, "resize observer"));
      this._add(() => ro.disconnect());
      return ro;
    }

    observeTopic(topic, fn) {
      const observer = { observe: this.guard(fn, `"${topic}" observer`) };
      Services.obs.addObserver(observer, topic);
      this._add(() => Services.obs.removeObserver(observer, topic));
    }

    // -- DOM --
    style(css) {
      return this._add(Styles.add(css, this.feature.id));
    }

    // Removes `el` from the document when the feature is turned off.
    track(el) {
      this._add(() => el.remove());
      return el;
    }

    // -- timing --
    timeout(fn, ms = 0) {
      if (!this.alive) return 0;
      const g = this.guard(fn, "timer");
      const id = setTimeout(() => {
        this._timers.delete(id);
        g();
      }, ms);
      this._timers.add(id);
      return id;
    }

    clearTimeout(id) {
      clearTimeout(id);
      this._timers.delete(id);
    }

    frame(fn) {
      if (!this.alive) return 0;
      const g = this.guard(fn, "animation frame");
      const id = requestAnimationFrame((t) => {
        this._frames.delete(id);
        g(t);
      });
      this._frames.add(id);
      return id;
    }

    cancelFrame(id) {
      cancelAnimationFrame(id);
      this._frames.delete(id);
    }

    microtask(fn) {
      queueMicrotask(this.guard(fn, "microtask"));
    }

    // A function that runs `fn` once in the next animation frame, however many
    // times it's called before then.
    throttle(fn, where = "frame update") {
      let queued = false;
      const run = this.guard(() => {
        queued = false;
        fn();
      }, where);
      return () => {
        if (queued || !this.alive) return;
        queued = true;
        this.frame(run);
      };
    }

    // Like throttle, but runs in a microtask: after the current event's other
    // listeners, before anything repaints.
    batch(fn, where = "batched update") {
      let queued = false;
      const run = this.guard(() => {
        queued = false;
        fn();
      }, where);
      return () => {
        if (queued || !this.alive) return;
        queued = true;
        this.microtask(run);
      };
    }
  }

  // ============================================================= 5. helpers ==
  // Floorp's stack DOM (see CLAUDE.md): a stack is a tab-group with
  // data-floorp-stack. Its tabs in the second row are `.floorp-stack-tab`
  // proxies whose data-floorp-drag-id matches the real <tab>'s
  // data-floorp-tab-id.

  const U = {
    STACK_ATTR: "data-floorp-stack",
    PROXY_SEL: ".floorp-stack-tab",
    TAB_DROP_TYPE: "application/x-moz-tabbrowser-tab",
    DEFAULT_FAVICON: "chrome://global/skin/icons/defaultFavicon.svg",

    isStack(group) {
      return !!group?.hasAttribute?.("data-floorp-stack") &&
        group.getAttribute("data-floorp-stack") !== "false";
    },

    // The stack a real tab is in, or null (plain groups don't count).
    stackOf(tab) {
      const group = tab?.closest?.("tab-group[data-floorp-stack]");
      return U.isStack(group) ? group : null;
    },

    // The plain Firefox tab group a real tab is in, or null (stacks don't count).
    plainGroupOf(tab) {
      const group = tab?.group;
      return group && !U.isStack(group) ? group : null;
    },

    realTabOf(proxy) {
      const id = proxy?.getAttribute?.("data-floorp-drag-id");
      return id ? gBrowser.tabs.find(t => t.getAttribute("data-floorp-tab-id") === id) ?? null : null;
    },

    // Real tabs by their Floorp id, for syncing many proxies at once.
    tabsById() {
      return new Map(gBrowser.tabs.map(t => [t.getAttribute("data-floorp-tab-id"), t]));
    },

    // Looked up fresh each time: Floorp re-renders proxies.
    proxyOf(tab) {
      const id = tab?.getAttribute?.("data-floorp-tab-id");
      return id ? document.querySelector(`.floorp-stack-tab[data-floorp-drag-id="${CSS.escape(id)}"]`) : null;
    },

    // The stack shown by a stack-bar strip (or the active one, given document).
    stackOfStrip(root) {
      const real = U.realTabOf(root?.querySelector?.(".floorp-stack-tab[data-floorp-drag-id]"));
      return real?.closest?.("tab-group[data-floorp-stack]") || real?.group || null;
    },

    activeStack() {
      return U.stackOfStrip(document);
    },

    setAttr(el, name, value) {
      if (value == null) {
        if (el.hasAttribute(name)) el.removeAttribute(name);
      } else if (el.getAttribute(name) !== value) {
        el.setAttribute(name, value);
      }
    },

    systemPrincipal() {
      return Services.scriptSecurityManager.getSystemPrincipal();
    },

    // Focus the address bar, as a native new tab does.
    focusUrlbar() {
      try {
        const urlbar = window.gURLBar;
        if (urlbar) {
          urlbar.focus();
          urlbar.select?.();
        }
      } catch (e) {}
    },

    // Moves `tab` into `group` at its end. The API differs between versions;
    // returns the one used, or null if none exists.
    adoptToGroup(tab, group) {
      if (typeof group.addTabs === "function") {
        group.addTabs([tab]);
        return "group.addTabs";
      }
      if (typeof gBrowser.moveTabToGroup === "function") {
        gBrowser.moveTabToGroup(tab, group);
        return "gBrowser.moveTabToGroup";
      }
      if (typeof gBrowser.addTabToGroup === "function") {
        gBrowser.addTabToGroup(group, tab);
        return "gBrowser.addTabToGroup";
      }
      return null;
    },

    isLoaded(tab) {
      return !!tab.linkedPanel && !tab.hasAttribute("pending") && !tab.hasAttribute("discarded");
    },

    // The nearest visible tab outside `group` in tab order (a loaded one, with
    // `loaded`), where every other stack or group counts as its active tab.
    // The same rule as "Stay in the stack when closing tabs".
    tabOutside(group, { loaded = false } = {}) {
      const visible = gBrowser.visibleTabs.filter(t => !t.closing);
      const visibleSet = new Set(visible);
      const activeOf = (g) => U.lastViewed(g.tabs.filter(t => visibleSet.has(t)));
      const units = [];
      let lastGroup;
      for (const t of visible) {
        const g = t.group ?? null;
        if (!g || g !== lastGroup) {
          if (g === group) units.push(null);
          else units.push(g ? activeOf(g) : t);
        }
        lastGroup = g;
      }
      const i = units.indexOf(null);
      for (let d = 1; i >= 0 && d < units.length; d++) {
        for (const t of [units[i - d], units[i + d]]) {
          if (t && (!loaded || U.isLoaded(t))) return t;
        }
      }
      return null;
    },

    // The tab to switch to when `tab` goes away (closed, unloaded or moved
    // to another workspace), ignoring the tabs in `avoid`. Its "container"
    // is its stack or group, the pinned tabs, or the other global tabs:
    // nearest loaded tab to the left in it → right neighbour → left
    // neighbour → nearest loaded tab outside → nearest tab outside, where
    // each other stack or group counts as one unit (its active tab). With
    // leftFirst false, the same with left and right swapped.
    closeTarget(tab, avoid = new Set(), { leftFirst = true } = {}) {
      const containerOf = (t) => t.group ?? (t.pinned ? "pinned" : "global");
      const home = containerOf(tab);
      const remaining = gBrowser.visibleTabs
        .filter(t => t === tab || (!t.closing && !avoid.has(t)));

      const members = remaining.filter(t => containerOf(t) === home);
      const i = members.indexOf(tab);
      const left = members.slice(0, i).reverse();
      const right = members.slice(i + 1);
      const [first, second] = leftFirst ? [left, right] : [right, left];

      // Tab order, each other stack or group reduced to its active tab.
      const visible = new Set(remaining);
      const activeOf = (group) => U.lastViewed(group.tabs.filter(t => visible.has(t)));
      const units = [];
      let lastGroup = null;
      for (const t of remaining) {
        const group = t.group && t.group !== home ? t.group : null;
        if (group) {
          if (group !== lastGroup) units.push(activeOf(group) ?? t);
        } else {
          units.push(t);
        }
        lastGroup = group;
      }

      // Outward from `tab`, the preferred side first at each distance.
      const nearest = (ok) => {
        const at = units.indexOf(tab);
        for (let d = 1; at >= 0 && d < units.length; d++) {
          const pair = leftFirst ? [units[at - d], units[at + d]] : [units[at + d], units[at - d]];
          for (const t of pair) {
            if (t && ok(t)) return t;
          }
        }
        return null;
      };

      return first.find(U.isLoaded) ?? second[0] ?? first[0]
        ?? nearest(U.isLoaded)
        ?? nearest(() => true);
    },

    // The value that occurs most in `list` (the earliest on a tie), or null.
    mostCommon(list) {
      const counts = new Map();
      let best = null;
      for (const v of list) {
        counts.set(v, (counts.get(v) || 0) + 1);
        if (best === null || counts.get(v) > counts.get(best)) best = v;
      }
      return best;
    },

    // The stack or group a header menu is being opened for, or null (a tab's
    // own menu, or something else). Floorp's stack menu opens without a
    // triggerNode, so `lastPressed` (the last mousedown target) stands in.
    headerMenuGroup(popup, lastPressed) {
      if (popup.id === "floorp-stack-kind-menu") {
        const node = popup.triggerNode || lastPressed;
        return node?.closest?.("tab-group") || U.activeStack();
      }
      const node = popup.triggerNode;
      if (!node || node.closest?.(".tabbrowser-tab") || node.closest?.(U.PROXY_SEL)) return null;
      return node.closest?.("tab-group") ?? null;
    },

    // ---- tab marks ----
    // A tab's mark color, kept with SessionStore so it survives restarts.
    TAB_MARK_KEY: "uc-tab-mark",

    markOf(tab) {
      try {
        return SessionStore.getCustomTabValue(tab, U.TAB_MARK_KEY) || null;
      } catch (e) {
        return null;
      }
    },

    // ---- Floorp workspaces ----
    // Each tab says which workspace it's in with this attribute; Floorp hides
    // the tabs of the other workspaces, and a group with none of its tabs in
    // the current workspace. Workspaces themselves are in a JSON pref.
    WS_ATTR: "floorpWorkspaceId",
    WS_LAST_SHOWN_ATTR: "floorpWorkspaceLastShowId",

    workspacesOn() {
      return U.prefBool("floorp.workspaces.enabled", true) &&
        typeof window.workspacesFuncs?.getSelectedWorkspaceID === "function";
    },

    // The workspaces in their order: [{ id, name, icon, userContextId }].
    workspaces() {
      try {
        const store = JSON.parse(Services.prefs.getStringPref("floorp.workspaces.v4.store", "{}"));
        const data = new Map(Array.isArray(store.data) ? store.data : []);
        const order = Array.isArray(store.order) ? store.order : [...data.keys()];
        return order.filter(id => data.has(id)).map(id => ({ ...data.get(id), id }));
      } catch (e) {
        return [];
      }
    },

    // The workspace id a tab is in, or null. Floorp strips braces too.
    workspaceOf(tab) {
      const raw = tab?.getAttribute?.(U.WS_ATTR);
      return raw ? raw.replace(/[{}]/g, "") : null;
    },

    currentWorkspace() {
      try {
        return window.workspacesFuncs?.getSelectedWorkspaceID?.() ?? null;
      } catch (e) {
        return null;
      }
    },

    // Re-applies the current workspace, which makes Floorp re-hide the tabs
    // and groups that belong elsewhere. Keeps the selected tab if it's still
    // in the current workspace.
    refreshWorkspace() {
      const id = U.currentWorkspace();
      if (id) window.workspacesFuncs.changeWorkspace(id);
    },

    // The most recently viewed of `tabs` (lastAccessed survives restarts).
    lastViewed(tabs) {
      return tabs.reduce((a, t) => (!a || t.lastAccessed > a.lastAccessed ? t : a), null);
    },

    callStackIncludes(re) {
      try {
        return re.test(new Error().stack || "");
      } catch (e) {
        return false;
      }
    },

    // The URLs Firefox's new tab command opens.
    isBlankNewTab(uri) {
      return uri == null || uri === "" ||
        ["about:newtab", "about:home", "about:blank", "about:privatebrowsing"].includes(uri);
    },

    // A `command` event from the <command> `id`, or a key or menu item
    // pointing at it.
    isCommand(target, id) {
      return target?.id === id || target?.getAttribute?.("command") === id ||
        target?.getAttribute?.("observes") === id;
    },

    // Whether new tabs open next to the current one: Firefox's
    // browser.tabs.insertAfterCurrent, or Floorp's own "open new tabs next to
    // the current tab" (floorp.browser.tabs.openNewTabPosition = 1). Floorp's
    // opens them as related to the current tab, which Firefox only places
    // beside it with browser.tabs.insertRelatedAfterCurrent (on by default).
    // Either way Firefox keeps the tab in the current tab's stack or group.
    opensNextToCurrent() {
      if (U.prefBool("browser.tabs.insertAfterCurrent", false)) return true;
      let position = -1;
      try {
        position = Services.prefs.getIntPref("floorp.browser.tabs.openNewTabPosition", -1);
      } catch (e) {}
      return position === 1 && U.prefBool("browser.tabs.insertRelatedAfterCurrent", true);
    },

    // For the bookmark features: a function (opts, group) → addTab options
    // that open the tab in `group`, at its end, or right after the current
    // tab when new tabs open next to it (Floorp's setting doesn't reach
    // bookmarks, so the position is given here). The tabs of one folder
    // (bulkOrderedOpen, all in one go) follow each other in order.
    bookmarkPlacer(ctx) {
      let run = null; // { n } while a folder is being opened
      return (opts, group) => {
        if (!U.opensNextToCurrent() || typeof opts?.tabIndex === "number") {
          return { ...opts, tabGroup: group }; // loadTabs already chose (insertAfterCurrent)
        }
        if (!opts?.bulkOrderedOpen) {
          run = null;
        } else if (!run) {
          run = { n: 0 };
          ctx.timeout(() => { run = null; });
        }
        const at = gBrowser.tabs.indexOf(gBrowser.selectedTab) + 1 + (run ? run.n++ : 0);
        return { ...opts, tabGroup: group, tabIndex: at, index: at };
      };
    },

    // Called from inside gBrowser.addTab: is this a bookmark or history entry
    // opened in a new tab, with no place chosen by the caller? Every way of
    // doing that (middle-click, Ctrl+click, Open in New Tab, a whole folder,
    // the Library window) goes through PlacesUIUtils synchronously.
    isBookmarkOpen(opts) {
      return !opts?.tabGroup && !opts?.pinned && U.callStackIncludes(/PlacesUIUtils\.sys\.mjs/);
    },

    // dataTransfer.types is a DOMStringList in some events and a frozen array
    // in others.
    dtHasType(dt, type) {
      const types = dt?.types;
      if (!types) return false;
      if (typeof types.includes === "function") return types.includes(type);
      if (typeof types.contains === "function") return types.contains(type);
      return Array.prototype.indexOf.call(types, type) >= 0;
    },

    findDescriptor,

    prefBool(name, fallback) {
      try {
        return Services.prefs.getBoolPref(name, fallback);
      } catch (e) {
        return fallback;
      }
    },
  };

  // ============================================================ 6. features ==
  // Each feature: { id, category, name, description, default, standalone
  // (the old files it replaces), requires (feature ids), init(ctx) }.
  // init() sets everything up through ctx; ctx.onCleanup undoes whatever
  // ctx can't track by itself (attributes written, elements moved).

  // ------------------------------------------------------------- Bug Fixes --

  defineFeature({
    id: "drag-and-drop",
    category: "fixes",
    name: "Stack-aware drag and drop",
    description: "Tabs and stacks move around the tab bar smoothly without accidentally merging into stacks. Tabs can move between stacks, tabs from other windows can join a stack, and links, text and files can be dropped onto a stack or its tabs.",
    default: true,
    standalone: ["floorp-tab-and-file-drag-fix.uc.js"],
    init(ctx) {
      // Floorp builds a stack as an expanded tab group whose tabs are
      // squashed to zero width behind its chip, which confuses Firefox's drag
      // engine (drag-and-drop.js). During a drag the engine is shown each
      // stack as a collapsed group instead, the shape it already handles.
      // Full write-up in CLAUDE.md.
      const TAB_DROP_TYPE = U.TAB_DROP_TYPE;
      const STACK_ATTR = U.STACK_ATTR;
      const ACTIVE_ATTR = "stackdrag-active";
      const PROXY_ATTR = "stackproxy-drag";
      const EXTERNAL_ATTR = "stackexternal-drag"; // "join" or "group"
      const DROP_INTO_ATTR = "data-floorp-drop-into";
      const PROXY_DRAG_END_EVENT = "floorp-stack-proxy-dragend";
      const SETTLE_TIMEOUT_MS = 2000;
      const CARET_ID = "uc-stack-drop-caret";
      const isStack = U.isStack;
      const tabs = ctx.require(gBrowser.tabContainer, "gBrowser.tabContainer");

      ctx.onCleanup(() => {
        tabs.removeAttribute(ACTIVE_ATTR);
        tabs.removeAttribute(PROXY_ATTR);
        tabs.removeAttribute(EXTERNAL_ATTR);
        document.getElementById(CARET_ID)?.remove();
        for (const g of tabs.querySelectorAll(`tab-group[${DROP_INTO_ATTR}]`)) g.removeAttribute(DROP_INTO_ATTR);
        tabs._invalidateCachedVisibleTabs?.();
      });

      // ---- links, text and files dropped on the stack bar -----------------
      const dlh = () => Services.droppedLinkHandler;

      // A link, text or file — never a tab.
      function isExternalLinkDrop(e) {
        const dt = e.dataTransfer;
        if (!dt || U.dtHasType(dt, TAB_DROP_TYPE)) return false;
        try {
          if (dlh().canDropLink(e, true)) return true;
        } catch (err) {}
        // canDropLink can't read the data on dragover in some builds.
        return U.dtHasType(dt, "text/plain")
          || U.dtHasType(dt, "text/x-moz-url")
          || U.dtHasType(dt, "text/uri-list")
          || U.dtHasType(dt, "text/html");
      }

      // A dropped URL or text, resolved as the address bar does: keywords
      // expand, plain text becomes a search.
      async function resolveDropText(text) {
        if (typeof getShortcutOrURIAndPostData === "function") {
          try {
            const d = await getShortcutOrURIAndPostData(text);
            if (d && d.url) return d;
          } catch (err) {
            console.warn(LOG, "drag-and-drop: getShortcutOrURIAndPostData failed", err);
          }
        }
        try {
          const flags =
            Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP |
            Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
          const info = Services.uriFixup.getFixupURIInfo(text, flags);
          const uri = info.preferredURI || info.fixedURI;
          if (uri) return { url: uri.spec, postData: null };
        } catch (err) {
          console.warn(LOG, "drag-and-drop: URIFixup fallback failed", err);
        }
        return null;
      }

      function loadInExistingTab(tab, data, triggeringPrincipal, csp) {
        const b = tab.linkedBrowser;
        const opts = { triggeringPrincipal, csp, postData: data.postData || null };
        if (typeof b.fixupAndLoadURIString === "function") {
          b.fixupAndLoadURIString(data.url, opts);
          return true;
        }
        if (typeof b.loadURI === "function") {
          b.loadURI(Services.io.newURI(data.url), opts);
          return true;
        }
        return false;
      }

      // Stack-bar tabs grouped into drop items: a split view is one item.
      function dropItems(proxies) {
        const items = [];
        for (const p of proxies) {
          const pos = p.getAttribute("data-split-position");
          const prev = items.at(-1)?.at(-1);
          if ((pos === "middle" || pos === "last") && prev?.hasAttribute("data-split-position")) {
            items.at(-1).push(p);
          } else {
            items.push([p]);
          }
        }
        return items;
      }

      function itemRect(item) {
        const a = item[0].getBoundingClientRect();
        const b = item.at(-1).getBoundingClientRect();
        return { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) };
      }

      // Where a drop lands on the stack bar, by the global strip's rules:
      // the middle half of a tab replaces that tab, anywhere else opens in
      // the nearest gap. → { replace } | { before, x } | { after, x } | { end }
      function stackDropSpot(e, strip, { replace = true } = {}) {
        const items = dropItems(strip.querySelectorAll(".floorp-stack-tab"));
        if (!items.length) return { end: true };
        const rtl = window.RTL_UI;
        const x = e.clientX;

        const overProxy = replace && e.target.closest?.(".floorp-stack-tab");
        if (overProxy) {
          const item = items.find(it => it.includes(overProxy));
          if (item) {
            const r = itemRect(item);
            const w = r.right - r.left;
            if (x >= r.left + w * 0.25 && x <= r.left + w * 0.75) {
              const tab = U.realTabOf(overProxy);
              if (tab) return { replace: tab };
            }
          }
        }

        for (const item of items) {
          const r = itemRect(item);
          if (rtl ? x > (r.left + r.right) / 2 : x < (r.left + r.right) / 2) {
            const tab = U.realTabOf(item[0]);
            if (tab) return { before: tab, x: rtl ? r.right : r.left };
          }
        }
        const last = items.at(-1);
        const r = itemRect(last);
        const tab = U.realTabOf(last.at(-1));
        return tab ? { after: tab, x: rtl ? r.left : r.right } : { end: true };
      }

      // The drop caret: Firefox's tab-drag-indicator, over the stack bar. A
      // watchdog hides it once dragovers stop (an OS file drag that leaves
      // the window fires no dragend here).
      ctx.style(`
        #${CARET_ID} {
          position: absolute;
          inset-block: 0;
          width: 12px;
          background: url(chrome://browser/skin/tabbrowser/tab-drag-indicator.svg) no-repeat center;
          pointer-events: none;
          z-index: 3;
        }
      `);
      let caretWatchdog = 0;

      function hideCaret() {
        ctx.clearTimeout(caretWatchdog);
        const caret = document.getElementById(CARET_ID);
        if (caret) caret.hidden = true;
      }

      function showCaret(x) {
        const bar = document.getElementById("floorp-stack-bar");
        const scroller = document.getElementById("floorp-stack-scroller");
        if (!bar || x == null) return hideCaret();
        let caret = document.getElementById(CARET_ID);
        if (!caret || caret.parentNode !== bar) {
          caret?.remove();
          caret = document.createXULElement("hbox");
          caret.id = CARET_ID;
          bar.append(caret);
        }
        const view = (scroller ?? bar).getBoundingClientRect();
        const clamped = Math.min(Math.max(x, view.left), view.right);
        caret.style.left = `${Math.round(clamped - bar.getBoundingClientRect().left - 6)}px`;
        caret.hidden = false;
        ctx.clearTimeout(caretWatchdog);
        caretWatchdog = ctx.timeout(hideCaret, 250);
      }

      // Opens a drop at `spot`. The dataTransfer is only valid synchronously,
      // so everything is read off it before the first await. Switching tabs
      // follows browser.tabs.loadInBackground, with Shift reversing it.
      async function handleStackDrop(event, group, spot) {
        let inBackground = U.prefBool("browser.tabs.loadInBackground", true);
        if (event.shiftKey) inBackground = !inBackground;

        const urls = [];
        const links = dlh().dropLinks(event, true); // true → reject javascript:/data:
        for (const l of links || []) if (l && l.url) urls.push(l.url);
        if (!urls.length) return;

        let triggeringPrincipal, csp;
        try {
          triggeringPrincipal = dlh().getTriggeringPrincipal(event);
          csp = dlh().getCsp(event);
        } catch (err) {
          triggeringPrincipal = U.systemPrincipal();
          csp = null;
        }

        let firstAdded = null;
        let previous = null; // last tab placed, so later items follow in order
        for (const url of urls) {
          const data = await resolveDropText(url);
          if (!ctx.alive) return;
          if (!data || !data.url) continue;

          if (!previous && spot.replace) {
            loadInExistingTab(spot.replace, data, triggeringPrincipal, csp);
            previous = spot.replace;
            continue;
          }
          const tab = gBrowser.addTab(data.url, {
            postData: data.postData,
            triggeringPrincipal,
            csp,
          });
          placeInStack(tab, group, previous ? { after: previous } : spot);
          firstAdded ??= tab;
          previous = tab;
        }
        if (firstAdded && !inBackground) gBrowser.selectedTab = firstAdded;
      }

      // moveTabBefore/After insert at the DOM level, so the tab joins the
      // target's stack; otherwise it goes at the stack's end.
      function placeInStack(tab, group, spot) {
        if (spot.before?.group === group) gBrowser.moveTabBefore(tab, spot.before);
        else if (spot.after?.group === group) gBrowser.moveTabAfter(tab, spot.after);
        else group.addTabs([tab]);
      }

      ctx.listen(window, "dragend", hideCaret, true);

      // dragover must be cancelled for the stack bar to accept the drop.
      ctx.listen(window, "dragover", (e) => {
        const strip = e.target.closest?.("#floorp-stack-items");
        if (!strip || !isExternalLinkDrop(e)) {
          hideCaret();
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        const spot = stackDropSpot(e, strip);
        if (spot.replace) hideCaret();
        else showCaret(spot.x);
      }, true);

      ctx.listen(window, "drop", (e) => {
        const strip = e.target.closest?.("#floorp-stack-items");
        if (!strip || !isExternalLinkDrop(e)) {
          hideCaret();
          return;
        }
        const group = U.stackOfStrip(strip);
        if (!group) {
          // Couldn't work out the stack: leave the drop to Floorp/Firefox.
          hideCaret();
          return;
        }
        const spot = stackDropSpot(e, strip);
        e.preventDefault();
        e.stopImmediatePropagation();
        hideCaret();
        ctx.async(handleStackDrop(e, group, spot), "dropping links on a stack");
      }, true);

      // ---- tabs from another window dropped on the stack bar --------------
      // Floorp's stack bar only takes its own stack-tab drags, and for one
      // from another window it adopts and selects the tab before working out
      // the spot; selecting it re-renders the bar, so the tab always ended up
      // last. Normal tabs from another window weren't accepted at all. These
      // drops are handled here instead: the spot is worked out first (the
      // gap nearest the pointer, as for links), then the dragged tabs are
      // adopted and placed there, as Firefox's own cross-window drop does.
      // Listening on windowRoot runs ahead of Floorp's window listeners, which
      // are then kept out with stopPropagation.
      const isStackMemberTab = (el) => el?.localName === "tab";

      // The tab dragged in from another window, or null. A whole stack or
      // group dragged in can't go inside a stack.
      function foreignTabDrag(e) {
        const dt = e.dataTransfer;
        if (!dt || !U.dtHasType(dt, TAB_DROP_TYPE)) return null;
        let src = null;
        try {
          src = dt.mozGetDataAt(TAB_DROP_TYPE, 0);
        } catch (err) {}
        if (!isStackMemberTab(src) || src.ownerDocument === document || src.closing) return null;
        const effect = tabs.tabDragAndDrop?.getDropEffectForTabDrag?.(e) ?? "move";
        return effect === "move" ? src : null;
      }

      // The stack bar under the pointer and the stack it shows, or null.
      function stackBarTarget(e) {
        const bar = e.target?.closest?.("#floorp-stack-bar");
        const strip = bar?.querySelector("#floorp-stack-items");
        const group = strip && U.stackOfStrip(strip);
        return group ? { strip, group } : null;
      }

      ctx.listen(window.windowRoot, "dragover", (e) => {
        if (!foreignTabDrag(e)) return;
        const target = stackBarTarget(e);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        showCaret(stackDropSpot(e, target.strip, { replace: false }).x);
      }, true);

      ctx.listen(window.windowRoot, "drop", (e) => {
        const src = foreignTabDrag(e);
        if (!src) return;
        const target = stackBarTarget(e);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        hideCaret();
        tabs.removeAttribute(EXTERNAL_ATTR);
        const spot = stackDropSpot(e, target.strip, { replace: false });
        // Everything the drag carries: a multiselection, or a stack tab's
        // selection gathered by Select several stack tabs.
        const moving = (src._dragData?.movingTabs ?? [src])
          .filter(t => isStackMemberTab(t) && !t.closing && t.ownerDocument !== document);
        if (!moving.includes(src)) moving.unshift(src);
        const srcWindow = src.ownerDocument?.defaultView;
        finishSourceDrag(src);
        let previous = null;
        for (const tab of moving) {
          const adopted = gBrowser.adoptTab(tab, { tabIndex: gBrowser.tabs.length, selectTab: tab === src });
          if (!adopted) continue;
          placeInStack(adopted, target.group, previous ? { after: previous } : spot);
          previous = adopted;
        }
        endSourceDrag(srcWindow);
      }, true);

      // The window the tab came from never gets its dragend: it's fired at the
      // dragged tab, which adopting removes from that window. So, as
      // Firefox's own cross-window drop does, its drag is finished from
      // here, before adopting: the "move selected tabs together" step, the
      // drag animation, and the tab sizes and the space held open at the end
      // of the tab bar (the gap where the tab was).
      function finishSourceDrag(src) {
        const srcDnd = src.container?.tabDragAndDrop;
        for (const [what, run] of [
          ["finishing the selected tabs' move", () => srcDnd?.finishMoveTogetherSelectedTabs?.(src)],
          ["ending the drag animation", () => srcDnd?.finishAnimateTabMove?.()],
          // Firefox calls the dropping window's copy; it resets the dragged
          // tab's own document.
          ["resetting the tab bar", () => (tabs.tabDragAndDrop ?? srcDnd)?._resetTabsAfterDrop?.(src)],
        ]) {
          try {
            run();
          } catch (err) {
            ctx.fail(err, `cleaning up the other window's drag (${what})`);
          }
        }
      }

      // Then that window's own window-level dragend handlers get the dragend
      // they missed (this script's drag state and Floorp's, which refreshes
      // its stack chips). Firefox's tab bar handler isn't on the window, so
      // it isn't reached; the cleanup above stands in for it.
      function endSourceDrag(srcWindow) {
        try {
          if (srcWindow && !srcWindow.closed) srcWindow.dispatchEvent(new srcWindow.Event("dragend"));
        } catch (err) {
          ctx.fail(err, "ending the other window's drag");
        }
      }

      // ---- the drag engine ------------------------------------------------
      const dnd = tabs.tabDragAndDrop;
      const groupProto = customElements.get("tab-group")?.prototype;
      const itemsDesc = findDescriptor(tabs, "dragAndDropElements");
      const collapsedDesc = groupProto && findDescriptor(groupProto, "collapsed");
      const activeTabDesc = groupProto && findDescriptor(groupProto, "hasActiveTab");
      if (!dnd?._animateTabMove || !dnd.handle_drop || !dnd.handle_dragover || !dnd.startTabDrag ||
          !dnd._getDragTarget || !itemsDesc?.get || !collapsedDesc?.set || !activeTabDesc?.set) {
        ctx.warn("Firefox's tab drag engine has changed, so only link and file drops on the stack bar are fixed.");
        return;
      }

      ctx.style(`
        #tabbrowser-tabs:is([${ACTIVE_ATTR}], [${PROXY_ATTR}], [${EXTERNAL_ATTR}]) tab-group[${STACK_ATTR}] > .tab-group-label-container,
        #tabbrowser-tabs:is([${ACTIVE_ATTR}], [${PROXY_ATTR}], [${EXTERNAL_ATTR}]) tab-group[${STACK_ATTR}] > .tab-group-label-container * {
          pointer-events: none !important;
        }
        /* The container is position:relative (tabs.css). */
        #tabbrowser-tabs:is([${PROXY_ATTR}], [${EXTERNAL_ATTR}="join"]) tab-group[${STACK_ATTR}] > .tab-group-label-container::before {
          content: "";
          position: absolute;
          inset-block: 0;
          inset-inline: 25%;
          pointer-events: auto !important;
        }
        /* Hover-to-join cue: the same look as Floorp's drop-into-stack highlight. */
        #tabbrowser-tabs[movingtab-group] tab-group[${STACK_ATTR}] .tab-group-label[dragover-groupTarget] {
          background-color: color-mix(in srgb, var(--focus-outline-color, #0a84ff) 35%, transparent) !important;
          border-color: var(--focus-outline-color, #0a84ff) !important;
        }
      `);

      const dragService = Cc["@mozilla.org/widget/dragservice;1"].getService(Ci.nsIDragService);

      // ---- drag lifecycle ----
      let active = false;     // engine sees stacks as collapsed
      let dragged = null;     // the tab / split view / group label being dragged
      let keep = new Set();   // moving items, never filtered out
      let activatedAt = 0;
      let settleGen = 0;
      let settling = false;
      let lastBase = null;    // engine's own item list the filtered one came from
      let lastItems = null;
      let unanimated = false; // inside the engine's handling of an unanimated drag

      const isStackMember = (el) =>
        (gBrowser.isTab(el) || gBrowser.isSplitViewWrapper?.(el)) && isStack(el.group);

      function activate(item) {
        settleGen++;
        settling = false;
        activatedAt = performance.now();
        active = true;
        dragged = item;
        keep = new Set(item.multiselected ? gBrowser.selectedElements : [item]);
        lastBase = lastItems = null;
        tabs.setAttribute(ACTIVE_ATTR, "");
      }

      // Chips take the pointer back right away; the filtered item list stays
      // until the drop animation has finished, as the engine's deferred move
      // still reads it.
      function endDrag() {
        tabs.removeAttribute(ACTIVE_ATTR);
        if (!active || settling) return;
        settling = true;
        const gen = settleGen;
        const deadline = performance.now() + SETTLE_TIMEOUT_MS;
        const settle = () => {
          if (gen !== settleGen) return;
          if (tabs.querySelector("[tabdrop-samewindow]") && performance.now() < deadline) {
            ctx.frame(settle);
            return;
          }
          active = false;
          settling = false;
          dragged = null;
          keep = new Set();
          lastBase = lastItems = null;
          // Rebuild the engine's list so every item gets its real elementIndex back.
          tabs._invalidateCachedVisibleTabs?.();
        };
        ctx.frame(settle);
      }
      ctx.onCleanup(() => {
        active = false;
        unanimated = false;
      });

      // ---- 1. item list: one item per stack ----
      ctx.hookGetter(tabs, "dragAndDropElements", function (next) {
        const base = next();
        if (!active && !unanimated) return base;
        if (base === lastBase) return lastItems;
        const items = [];
        for (const el of base) {
          if (!keep.has(el)) {
            if (gBrowser.isTabGroupLabel(el)) {
              if (el.group?.style.display === "none") continue; // other workspace
            } else if (isStack(el.group)) {
              continue;
            }
          }
          el.elementIndex = items.length;
          items.push(el);
        }
        lastBase = base;
        lastItems = items;
        return items;
      });

      // ---- 2. drop-spot decision: stacks read as collapsed ----
      // Own properties on each stack for this one synchronous call only:
      // Floorp keeps stacks expanded and re-expands any real collapse.
      ctx.hook(dnd, "_animateTabMove", function (next, ...args) {
        if (!active) return next(...args);
        const stacks = gBrowser.tabGroups.filter(isStack);
        for (const g of stacks) {
          Object.defineProperty(g, "collapsed", {
            configurable: true,
            get: () => true,
            set(v) { collapsedDesc.set.call(this, v); },
          });
          Object.defineProperty(g, "hasActiveTab", {
            configurable: true,
            get: () => false,
            set(v) { activeTabDesc.set.call(this, v); },
          });
        }
        try {
          return next(...args);
        } finally {
          for (const g of stacks) {
            delete g.collapsed;
            delete g.hasActiveTab;
          }
        }
      });

      // ---- drags the engine doesn't animate ----
      // A tab (or group label) dragged in from another window, or null.
      function foreignSource(event) {
        const dt = event.dataTransfer;
        if (!U.dtHasType(dt, TAB_DROP_TYPE) || tabs.verticalMode) return null;
        const src = dt.mozGetDataAt(TAB_DROP_TYPE, 0);
        return src && src.ownerDocument !== document ? src : null;
      }

      // A tab from another window, or a link, text or file. Tabs dragged
      // within this window are animated, or are Floorp's stack-bar drags.
      const isUnanimatedDrag = (event) =>
        !tabs.verticalMode && !!event.dataTransfer &&
        (!U.dtHasType(event.dataTransfer, TAB_DROP_TYPE) || !!foreignSource(event));

      // The item list is filtered only while the engine handles one event.
      function withStackItems(fn) {
        unanimated = true;
        lastBase = lastItems = null;
        try {
          return fn();
        } finally {
          unanimated = false;
          lastBase = lastItems = null;
          tabs._invalidateCachedVisibleTabs?.();
        }
      }

      // In the tab bar but not on an item (around a group's label, or the top
      // pixel row above a stack's chip), the engine reads "the end"; the item
      // nearest the pointer is used instead.
      ctx.hook(dnd, "_getDragTarget", function (next, event, options, ...rest) {
        const found = next(event, options, ...rest);
        const opts = options ?? {};
        if (found || !unanimated || opts.ignoreSides || opts.findClosestTarget === false ||
            !event?.target?.closest?.("#tabbrowser-tabs")) {
          return found;
        }
        let nearest = null;
        let best = Infinity;
        for (const el of tabs.dragAndDropElements) {
          const box = gBrowser.isTabGroupLabel(el) ? el.closest(".tab-group-label-container") : el;
          const r = box?.getBoundingClientRect();
          if (!r?.width) continue;
          const d = event.clientX < r.left ? r.left - event.clientX
            : event.clientX > r.right ? event.clientX - r.right : 0;
          if (d < best) {
            best = d;
            nearest = el;
          }
        }
        return nearest;
      });

      ctx.hook(dnd, "handle_dragover", function (next, event, ...rest) {
        if (!isUnanimatedDrag(event)) return next(event, ...rest);
        return withStackItems(() => next(event, ...rest));
      });

      // Chips give up the pointer from the first dragover until the drop. A
      // tab from another window, or a link, text or file, can still join a
      // stack over the middle half of its chip ("join"); a whole stack or
      // group can't ("group").
      let externalAt = 0;
      function trackExternal(event) {
        const src = foreignSource(event);
        const kind = src ? (gBrowser.isTabGroupLabel(src) ? "group" : "join")
          : !tabs.verticalMode && isExternalLinkDrop(event) ? "join" : null;
        if (!kind) {
          if (tabs.hasAttribute(EXTERNAL_ATTR)) tabs.removeAttribute(EXTERNAL_ATTR);
          return;
        }
        if (tabs.getAttribute(EXTERNAL_ATTR) !== kind) tabs.setAttribute(EXTERNAL_ATTR, kind);
        externalAt = performance.now();
      }
      const endExternal = () => tabs.removeAttribute(EXTERNAL_ATTR);
      ctx.listen(window, "dragenter", trackExternal, true);
      ctx.listen(window, "dragover", trackExternal, true);
      ctx.listen(window, "drop", () => ctx.timeout(endExternal), true);

      // Links, text or files over the middle half of a chip: the stack shows
      // Floorp's drop-into highlight (set in a frame callback, after Floorp's
      // own dragover listener clears it), and the drop opens at its end.
      let chipTarget = null;
      let chipWatchdog = 0;
      const clearChipTarget = () => {
        ctx.clearTimeout(chipWatchdog);
        chipTarget = null;
        for (const g of tabs.querySelectorAll(`tab-group[${STACK_ATTR}][${DROP_INTO_ATTR}]`)) {
          g.removeAttribute(DROP_INTO_ATTR);
        }
      };
      const drawChipTarget = () => {
        if (chipTarget?.isConnected) chipTarget.setAttribute(DROP_INTO_ATTR, "true");
      };
      const linkChipTarget = (event) => {
        if (tabs.verticalMode || !isExternalLinkDrop(event)) return null;
        return event.target?.closest?.(".tab-group-label-container")
          ?.closest(`#tabbrowser-tabs tab-group[${STACK_ATTR}]`) ?? null;
      };
      ctx.listen(window, "dragover", (event) => {
        const group = linkChipTarget(event);
        if (!group) {
          if (chipTarget) clearChipTarget();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const ind = tabs.querySelector(".tab-drop-indicator");
        if (ind) ind.hidden = true;
        if (chipTarget && chipTarget !== group) chipTarget.removeAttribute(DROP_INTO_ATTR);
        chipTarget = group;
        ctx.frame(drawChipTarget);
        ctx.clearTimeout(chipWatchdog);
        chipWatchdog = ctx.timeout(clearChipTarget, 250);
      }, true);
      ctx.listen(window, "drop", (event) => {
        const group = linkChipTarget(event);
        if (!group) return;
        event.preventDefault();
        event.stopPropagation();
        clearChipTarget();
        ctx.async(handleStackDrop(event, group, { end: true }), "dropping links on a stack");
      }, true);

      // ---- 3. drop: "next to the label" means next to the stack ----
      ctx.hook(dnd, "handle_drop", function (next, event, ...rest) {
        if (isUnanimatedDrag(event)) {
          return withStackItems(() => next(event, ...rest));
        }
        if (active) {
          try {
            const src = event.dataTransfer?.mozGetDataAt(TAB_DROP_TYPE, 0);
            const data = src && src === dragged ? src._dragData : null;
            const target = data?.dropElement;
            // A hover-join keeps the label: the engine adds the tabs to its group.
            if (target && !data.shouldDropIntoCollapsedTabGroup &&
                !keep.has(target) && isStack(target.group)) {
              data.dropElement = target.group;
            }
          } catch (e) {
            ctx.fail(e, "drop");
          }
        }
        return next(event, ...rest);
      });

      // ---- drag start ----
      ctx.hook(dnd, "startTabDrag", function (next, event, tab, options, ...rest) {
        // Floorp starts stack-bar drags here with fromTabList (so does the
        // all-tabs menu, from inside its panel).
        if (options?.fromTabList && isStackMember(tab) &&
            tab.ownerDocument === document && !event?.target?.closest?.("panel")) {
          beginProxyDrag(tab);
        }
        const eligible = !options?.fromTabList && !tabs.verticalMode &&
          tab?.ownerDocument === document && !isStackMember(tab);
        if (!eligible) return next(event, tab, options, ...rest);

        // Before the original: multiselect drags index the item list at start.
        activate(tab);
        let result;
        try {
          result = next(event, tab, options, ...rest);
        } catch (e) {
          endDrag();
          throw e;
        }
        if (!tab._dragData) {
          endDrag();
        } else if (gBrowser.isTabGroupLabel(tab) && isStack(tab.group)) {
          // The stack already looks collapsed, and Floorp's re-expand would
          // flip it back on every dragover.
          tab._dragData.expandGroupOnDrop = false;
        }
        return result;
      });

      ctx.listen(window, "dragend", () => {
        if (active || tabs.hasAttribute(ACTIVE_ATTR)) endDrag();
      }, true);

      // ---- stack-bar drags into the tab strip ----
      let proxyDrag = null; // { tab, into, fixQueued }
      let proxyDragAt = 0;

      function beginProxyDrag(tab) {
        proxyDrag = { tab, into: null, fixQueued: false };
        proxyDragAt = performance.now();
        tabs.setAttribute(PROXY_ATTR, ""); // chip edges belong to the strip
      }
      const endProxyDrag = () => {
        tabs.removeAttribute(PROXY_ATTR);
        proxyDrag = null;
      };
      ctx.listen(window, "dragend", endProxyDrag, true);
      ctx.listen(window, PROXY_DRAG_END_EVENT, endProxyDrag);

      // Floorp treats an expanded group as one block; over one, this finds the
      // in-group spot a global tab would get. → { ref, before, x } or null.
      function spotInGroup(x) {
        for (const g of gBrowser.tabGroups) {
          if (isStack(g) || g.collapsed || g.style.display === "none") continue;
          const members = g.tabsAndSplitViews?.filter(el => el.visible) ?? [];
          const labelBox = g.labelElement?.closest(".tab-group-label-container");
          if (!members.length || !labelBox) continue;
          const lr = labelBox.getBoundingClientRect();
          const lastRect = members.at(-1).getBoundingClientRect();
          if (x < lr.left || x > lastRect.right) continue;
          if (x < lr.left + lr.width / 2) return null;
          for (const el of members) {
            const r = el.getBoundingClientRect();
            if (x < r.left + r.width / 2) return { ref: el, before: true, x: r.left };
          }
          return { ref: members.at(-1), before: false, x: lastRect.right };
        }
        return null;
      }

      // Floorp's strip caret, moved to the in-group spot (after Floorp's own
      // dragover listener has placed it).
      function drawGroupCaret() {
        const into = proxyDrag?.into;
        const ind = tabs.querySelector(".tab-drop-indicator");
        if (!into || !ind) return;
        const rect = tabs.arrowScrollbox.getBoundingClientRect();
        ind.hidden = false;
        ind.style.transform = `translateX(${Math.round(into.x - rect.left + ind.clientWidth / 2)}px)`;
      }

      ctx.listen(window, "dragover", (event) => {
        if (!proxyDrag) return;
        const inStrip = !!event.target?.closest?.("#TabsToolbar");
        proxyDrag.into = inStrip ? spotInGroup(event.clientX) : null;
        if (proxyDrag.into) ctx.frame(drawGroupCaret);
      }, true);

      // Floorp's drop places the tab before/after the whole group; the first
      // move it makes queues the correction, which runs once its drop
      // listener returns.
      function onProxyTabMoved(tab) {
        const d = proxyDrag;
        if (!d || tab !== d.tab || !d.into || d.fixQueued) return;
        d.fixQueued = true;
        const { ref, before } = d.into;
        ctx.microtask(() => {
          if (!ref.isConnected || !tab.isConnected || ref === tab) return;
          if (before) gBrowser.moveTabBefore(tab, ref);
          else gBrowser.moveTabAfter(tab, ref);
        });
      }
      ctx.listen(tabs, "TabMove", (e) => onProxyTabMoved(e.target));
      // Dispatched on the group it left, with the tab as detail.
      ctx.listen(window, "TabUngrouped", (e) => onProxyTabMoved(e.detail));

      // A drag that ends without a dragend (the source proxy can be
      // re-rendered away mid-drag) must not leave chips unclickable. The
      // platform session starts just after dragstart, hence the grace period.
      const endIfNoSession = () => {
        if (!active && !tabs.hasAttribute(ACTIVE_ATTR) && !tabs.hasAttribute(PROXY_ATTR) &&
            !tabs.hasAttribute(EXTERNAL_ATTR)) return;
        if (performance.now() - Math.max(activatedAt, proxyDragAt, externalAt) < 500) return;
        let session = null;
        try {
          session = dragService.getCurrentSession(window);
        } catch (e) {
          return;
        }
        if (!session) {
          endDrag();
          endProxyDrag();
          endExternal();
        }
      };
      ctx.listen(window, "mousemove", endIfNoSession, true);
      ctx.listen(window, "mousedown", endIfNoSession, true);
    },
  });

  defineFeature({
    id: "tab-overflow",
    category: "fixes",
    name: "Double new tab button",
    description: "Fixes a random startup bug where the new tab button appears twice and dragging tabs stops working.",
    default: true,
    standalone: ["floorp-tab-overflow-fix.uc.js"],
    init(ctx) {
      // The scrollbox's `overflowing` and the tab strip's `overflow` can fall
      // out of sync when the scrollbox is re-attached during startup. The
      // scrollbox's attribute comes from real measurements, so the missing
      // overflow/underflow event is fired to bring the other one in line.
      const tabs = ctx.require(gBrowser.tabContainer, "gBrowser.tabContainer");
      const scrollbox = ctx.require(tabs.arrowScrollbox, "the tab strip's scrollbox");
      const SCROLLED_MARKS = ["scrolledtostart", "scrolledtoend"];

      function reconcile() {
        const overflowing = scrollbox.hasAttribute("overflowing");
        if (tabs.hasAttribute("overflow") !== overflowing) {
          console.warn(LOG, "tab strip overflow state was stale; resyncing to",
            overflowing ? "overflowing" : "not overflowing");
          scrollbox.dispatchEvent(new CustomEvent(overflowing ? "overflow" : "underflow"));
        }
        if (!overflowing) {
          for (const mark of SCROLLED_MARKS) {
            if (scrollbox.hasAttribute(mark)) continue;
            console.warn(LOG, `tab strip fits but was missing ${mark}; setting it`);
            scrollbox.toggleAttribute(mark, true);
          }
        }
      }

      const schedule = ctx.throttle(reconcile, "overflow check");
      ctx.observe(tabs, { attributes: true, attributeFilter: ["overflow"] }, schedule);
      ctx.observe(scrollbox, { attributes: true, attributeFilter: ["overflowing", ...SCROLLED_MARKS] }, schedule);
      schedule();
    },
  });

  defineFeature({
    id: "context-menu-labels",
    category: "fixes",
    name: "Tab menu text on startup",
    description: "Fixes the tab menu showing only icons, with no text, when the browser starts on a stack tab.",
    default: true,
    standalone: ["stacktab-general-fixes.uc.js"],
    init(ctx) {
      // The menu's strings load the first time the pointer enters the tab
      // strip; the stack bar is outside it, so load them up front.
      ctx.require(typeof gBrowser.translateTabContextMenu === "function",
        "gBrowser.translateTabContextMenu is missing");
      gBrowser.translateTabContextMenu();
    },
  });

  defineFeature({
    id: "stacks-in-new-windows",
    category: "fixes",
    name: "Stacks in new windows",
    description: "Fixes new windows sometimes opening with their stacks turned into plain tab groups.",
    default: true,
    standalone: ["stacktab-general-fixes.uc.js"],
    init(ctx) {
      // In windows opened after startup, Floorp can start tab stacks before
      // the window's chrome exists, and they never retry. This starts them
      // once the chrome is ready, and makes a second start a no-op.
      const STACKS_PREF = "floorp.tabstacks.enabled";
      const STACKS_MARKER = "floorp-stack-kind-menu";
      const CORE_URL = "chrome://noraneko/content/core.js";
      const stacksRunning = () => !!document.getElementById(STACKS_MARKER);

      // Floorp's bundle numbers its chunks, and the numbers change between
      // versions; core.js's module map gives the current one.
      async function tabStacksModuleURL() {
        const core = await (await fetch(CORE_URL)).text();
        const match = core.match(
          /"\.\/tab-stacks\/index\.ts":\s*\(\)\s*=>\s*__vitePreload\(\(\)\s*=>\s*import\((['"])([^'"]+)\1\)/
        );
        return match ? new URL(match[2], CORE_URL).href : null;
      }

      async function ensureTabStacks() {
        if (!U.prefBool(STACKS_PREF, false)) return;
        await SessionStore.promiseInitialized; // Floorp waits for this too
        if (!ctx.alive) return;

        const url = await tabStacksModuleURL();
        if (!ctx.alive) return;
        if (!url) throw new Unavailable("couldn't find Floorp's tab stacks module in core.js");
        const mod = await import(url);
        if (!ctx.alive) return;
        const TabStacks = mod.default;
        if (typeof TabStacks !== "function" || mod.ENABLED_PREF !== STACKS_PREF) {
          throw new Unavailable("Floorp's tab stacks module doesn't look as expected");
        }

        ctx.hook(TabStacks.prototype, "init", function (next, ...args) {
          if (stacksRunning()) return undefined;
          return next(...args);
        });

        if (!stacksRunning()) {
          console.warn(LOG, "tab stacks didn't start in this window; starting them");
          new TabStacks();
        }
      }

      ctx.async(ensureTabStacks(), "starting tab stacks");
    },
  });

  defineFeature({
    id: "sidebar-width",
    category: "fixes",
    name: "Resizable sidebar",
    description: "Lets the sidebar be made much wider on themes that limit its width.",
    default: true,
    standalone: ["floorp-sidebar-resize-fix.uc.css"],
    init(ctx) {
      ctx.style(`
        #sidebar-box {
          max-width: 75vw !important;
        }
      `);
    },
  });

  defineFeature({
    id: "workspace-split-stacks",
    category: "fixes",
    name: "Stacks copied into another workspace",
    description: "Fixes stacks showing up in two workspaces at once after one of their tabs was moved to another workspace or reopened. A moved tab now leaves its stack, a reopened tab stays out of other workspaces' stacks, and stacks already split this way become one stack in each workspace.",
    default: true,
    init(ctx) {
      // Floorp moves a tab to a workspace by changing its workspace attribute,
      // and hides a group only when none of its tabs are in the current
      // workspace. A stack is one element, so with tabs in two workspaces it
      // shows in both, and renaming or closing it in one changes the other.
      ctx.require(typeof gBrowser.moveTabToEnd === "function", "gBrowser.moveTabToEnd");
      ctx.require(typeof gBrowser.ungroupTab === "function", "gBrowser.ungroupTab");
      const KINDS_PREF = "floorp.tabstacks.groupKinds"; // Floorp: { [groupId]: "group" }
      const knownIds = () => new Set(U.workspaces().map(w => w.id));

      // ---- a tab moved out of a group's workspace leaves the group ----
      // A move changes the attribute from one workspace to another (a first
      // assignment has no old value). The tabs left behind decide where the
      // group stays; a group whose tabs all moved together stays whole.
      // Leaving tabs go to the end of the tab bar (Firefox's "Move to End",
      // which also takes them out of the group), so they arrive after
      // everything in the other workspace rather than wherever the group sits.
      function leave(tabs) {
        const done = new Set();
        for (const tab of tabs) { // in order, each after the one before
          const sv = tab.splitview;
          if (!sv) {
            gBrowser.moveTabToEnd(tab);
          } else if (!done.has(sv) && sv.tabs.every(t => tabs.includes(t))) {
            done.add(sv);
            gBrowser.moveTabToEnd(tab); // moves the whole split view
          }
        }
      }

      // ---- a tab landing in another workspace's group ----
      // Reopening a closed tab (Ctrl+Shift+T) puts it back at its old index in
      // the whole tab bar, which counts every workspace's tabs. When tabs
      // before it have come or gone since, that index can fall inside a stack
      // of another workspace, and Firefox puts the tab in that stack, which
      // then shows here too. Any tab that lands in a group (TabGrouped, or
      // its workspace set for the first time while in one) is checked once
      // things settle:
      // - a tab that was just opened (a reopened one) in a group of another
      //   workspace (hidden here) comes back out, just after it, keeping its
      //   own workspace;
      // - any other tab joins the group's workspace: it was put there on
      //   purpose ("Add Tab to Group" lists every workspace's groups).
      // Not during session restore: groups that were saved split are
      // separated as a whole afterwards (below).
      let settled = false;
      const strays = new Set();
      const openedAt = new WeakMap(); // tab → when it opened
      ctx.listen(gBrowser.tabContainer, "TabOpen", (e) => openedAt.set(e.target, performance.now()));
      const justOpened = (tab) => performance.now() - (openedAt.get(tab) ?? -Infinity) < 1000;
      const checkStrays = ctx.guard(() => {
        const tabs = [...strays];
        strays.clear();
        if (!U.workspacesOn()) return;
        const known = knownIds();
        const here = U.currentWorkspace();
        let changed = false;
        for (const tab of tabs) {
          const group = tab.group;
          const ws = U.workspaceOf(tab);
          if (!group || !tab.isConnected || tab.closing || !known.has(ws)) continue;
          const stays = U.mostCommon(group.tabs.filter(t => t !== tab)
            .map(U.workspaceOf).filter(id => known.has(id)));
          if (!stays || stays === ws) continue;
          if (stays === here || !justOpened(tab)) {
            tab.setAttribute(U.WS_ATTR, stays);
          } else if (tab.splitview) {
            continue; // a split view only leaves whole, with its own move
          } else {
            gBrowser.ungroupTab(tab);
          }
          changed = true;
        }
        if (changed) U.refreshWorkspace();
      }, "taking a tab out of another workspace's stack");
      const queueStray = (tab) => {
        if (!settled || !tab?.group) return;
        if (!strays.size) ctx.timeout(checkStrays);
        strays.add(tab);
      };
      ctx.listen(window, "TabGrouped", (e) => queueStray(e.detail)); // fired on the group

      // "Add Tab to Group" with a group of another workspace: the tabs go to
      // that workspace with it, and you stay here, like Floorp's "Move Tab to
      // Another Workspace". The selection moves first, while the tabs are
      // still in place (the way closing them would pick, when "Stay in the
      // stack when closing tabs" is on; otherwise the workspace's first tab).
      // contextTabs was fixed when the menu opened, so selecting another tab
      // doesn't change what moves.
      ctx.optional(() => ctx.hook(window.TabContextMenu, "moveTabsToGroup", function (next, group, ...rest) {
        const known = knownIds();
        const ws = U.mostCommon((group?.tabs ?? []).map(U.workspaceOf).filter(id => known.has(id)));
        const here = U.currentWorkspace();
        if (!U.workspacesOn() || !ws || !here || ws === here) return next(group, ...rest);
        const moving = new Set();
        for (const tab of this.contextTabs ?? []) {
          for (const t of tab.splitview?.tabs ?? [tab]) moving.add(t);
        }
        const selected = gBrowser.selectedTab;
        if (moving.has(selected)) {
          const pick = ctx.isActive("close-stays-in-stack")
            ? U.closeTarget(selected, moving, { leftFirst: ctx.isActive("close-prefer-left") })
            : gBrowser.visibleTabs.find(t => !moving.has(t) && !t.closing);
          if (pick) gBrowser.selectedTab = pick;
        }
        const result = next(group, ...rest);
        for (const t of moving) {
          if (t.isConnected && t.group === group) t.setAttribute(U.WS_ATTR, ws);
        }
        U.refreshWorkspace();
        return result;
      }), "Adding a tab to another workspace's group from the tab menu");

      ctx.observe(gBrowser.tabContainer, {
        subtree: true,
        attributes: true,
        attributeFilter: [U.WS_ATTR],
        attributeOldValue: true,
      }, (records) => {
        if (!U.workspacesOn()) return;
        const known = knownIds();
        const seen = new Set();
        const moved = new Map(); // tab → the workspace it moved to
        for (const r of records) {
          const tab = r.target;
          if (seen.has(tab)) continue; // the first record has the original value
          seen.add(tab);
          const from = r.oldValue?.replace(/[{}]/g, "");
          const to = U.workspaceOf(tab);
          if (tab.group && known.has(from) && known.has(to) && from !== to) moved.set(tab, to);
          else if (tab.group && !known.has(from)) queueStray(tab);
        }
        for (const group of new Set([...moved.keys()].map(t => t.group))) {
          const stays = U.mostCommon(group.tabs.filter(t => !moved.has(t))
            .map(U.workspaceOf).filter(id => known.has(id)));
          if (!stays) continue;
          const leaving = group.tabs.filter(t => moved.has(t) && moved.get(t) !== stays);
          if (leaving.length) leave(leaving);
        }
      });

      // ---- stacks already split: one stack per workspace ----
      // The workspace with most of its tabs keeps the stack; each other one
      // gets its own copy with the same name, color and kind, just after it.
      function newGroupId() {
        let id;
        do {
          id = `${Date.now()}-${Math.round(Math.random() * 100)}`; // Firefox's format
        } while (gBrowser.tabGroups.some(g => g.id === id));
        return id;
      }

      // Floorp makes every group a stack unless this pref says otherwise.
      function markPlainGroup(id) {
        let kinds = {};
        try {
          kinds = JSON.parse(Services.prefs.getStringPref(KINDS_PREF, "{}")) || {};
        } catch (e) {}
        kinds[id] = "group";
        Services.prefs.setStringPref(KINDS_PREF, JSON.stringify(kinds));
      }

      function separate(group, known) {
        const byWorkspace = new Map();
        for (const t of group.tabs) {
          const ws = U.workspaceOf(t);
          if (!known.has(ws)) continue;
          if (!byWorkspace.has(ws)) byWorkspace.set(ws, []);
          byWorkspace.get(ws).push(t);
        }
        if (byWorkspace.size < 2) return 0;
        const keep = U.mostCommon(group.tabs.map(U.workspaceOf).filter(id => known.has(id)));
        let after = group;
        let made = 0;
        for (const [ws, tabs] of byWorkspace) {
          if (ws === keep) continue;
          const items = [];
          for (const t of tabs) {
            const sv = t.splitview;
            if (!sv) items.push(t);
            else if (!items.includes(sv) && sv.tabs.every(x => U.workspaceOf(x) === ws)) items.push(sv);
          }
          if (!items.length) continue;
          const id = newGroupId();
          if (!U.isStack(group)) markPlainGroup(id);
          const copy = gBrowser.addTabGroup(items, {
            id,
            label: group.label,
            color: group.color,
            insertBefore: after.nextElementSibling,
          });
          if (copy) {
            after = copy;
            made++;
          }
        }
        return made;
      }

      // Once the session and Floorp's workspaces have settled.
      const separateAll = ctx.guard(() => {
        settled = true;
        if (!U.workspacesOn()) return;
        const known = knownIds();
        if (known.size < 2) return;
        let made = 0;
        for (const group of [...gBrowser.tabGroups]) made += separate(group, known);
        if (made) {
          console.warn(`[FBFI] Separated ${made} stack(s) or group(s) that were split across workspaces.`);
          U.refreshWorkspace();
        }
      }, "separating stacks split across workspaces");
      ctx.async(window.SessionStore.promiseAllWindowsRestored.then(() => ctx.timeout(separateAll, 1000)),
        "waiting for the session to be restored");
    },
  });

  defineFeature({
    id: "reopen-in-workspace",
    category: "fixes",
    name: "Reopened tabs go back to their workspace",
    description: "Reopening a closed tab brings it back to the workspace it was closed in, and into its stack, and switches to that workspace.",
    default: true,
    init(ctx) {
      // Floorp saves a tab's workspace with its closed-tab data, but only puts
      // it back when a whole session is restored; a reopened tab is treated as
      // new and gets the current workspace. SessionStore removes the closed
      // entry before it creates the tab, so the entry that just disappeared
      // from a snapshot (keyed by closedId, kept up to date) is the one being
      // reopened. SessionStore itself is shared by every window, so it's
      // watched rather than wrapped; the tab is created through this window's
      // addTab.
      const REOPEN_RE = /undoCloseTab|undoCloseById|undoClosedTabFromClosedWindow/;
      const cleanId = (id) => (typeof id === "string" ? id.replace(/[{}]/g, "") : null);

      function closedTabs() {
        try {
          return SessionStore.getClosedTabData?.({ sourceWindow: window, closedTabsFromAllWindows: true })
            ?? SessionStore.getClosedTabDataForWindow(window) ?? [];
        } catch (e) {
          return [];
        }
      }
      let snapshot = new Map(); // closedId → the workspace it was closed in
      const remember = () => {
        snapshot = new Map(closedTabs().map(d => [d.closedId, cleanId(d.state?.floorpWorkspaceId)]));
      };
      ctx.observeTopic("sessionstore-closed-objects-changed", remember);
      ctx.listen(gBrowser.tabContainer, "TabClose", () => ctx.timeout(remember));
      remember();

      ctx.hook(gBrowser, "addTab", function (next, uri, opts, ...rest) {
        if (!U.workspacesOn() || !U.callStackIncludes(REOPEN_RE)) return next(uri, opts, ...rest);
        const still = new Set(closedTabs().map(d => d.closedId));
        const gone = [...snapshot].filter(([id]) => !still.has(id));
        const tab = next(uri, opts, ...rest);
        remember();
        const ws = gone.length === 1 ? gone[0][1] : null;
        if (!tab || !U.workspaces().some(w => w.id === ws)) return tab;
        // After Floorp's TabOpen handler gave it the current workspace.
        tab.setAttribute(U.WS_ATTR, ws);
        if (ws !== U.currentWorkspace()) {
          // Once SessionStore has selected it; Floorp then keeps it selected.
          ctx.timeout(() => {
            if (tab.isConnected && tab.selected && U.workspaceOf(tab) === ws) {
              window.workspacesFuncs.changeWorkspace(ws);
            }
          });
        }
        return tab;
      });
    },
  });

  defineFeature({
    id: "moved-stack-keeps-tab",
    category: "fixes",
    name: "Moved stacks keep their tab",
    description: "A stack moved to another window opens on the tab you were using in it, instead of its first or last tab.",
    default: true,
    init(ctx) {
      // Every move to another window goes through gBrowser.adoptTab in the
      // receiving window: a new tab takes over the old one's page and the old
      // one closes. A loaded tab's new copy is stamped as used at the time of
      // the move (tab.js), in order, so a moved stack's last tab looks like
      // the one you were on, and Floorp, Firefox and this script pick it.
      // (Unloaded tabs keep their time: SessionStore restores it.) The move
      // can also select a tab itself: Move to New Window and tearing a stack
      // off end by closing the new window's blank tab, which selects the
      // stack's last tab, and Move Group to This Window selects the first
      // (tab-group select()).
      // A new window isn't running this script yet when that happens, so the
      // old window does the work: its TabClose names the new tab
      // (detail.adoptedBy). The time is copied over at once. When the move is
      // done, a stack whose selected tab the move picked gets the tab you were
      // on instead.
      // The times are read when the first tab of a stack leaves: as each moved
      // tab closes here, this window selects the next one (close-stays-in-
      // stack picks the stack neighbour), which would then look just used.
      let moved = [];
      const timeBefore = new Map(); // old tab → lastAccessed before the move
      function finish() {
        const batch = moved;
        moved = [];
        timeBefore.clear();
        const byStack = new Map();
        for (const m of batch) {
          const stack = U.stackOf(m.tab);
          if (!stack?.isConnected) continue;
          if (!byStack.has(stack)) byStack.set(stack, []);
          byStack.get(stack).push(m);
        }
        for (const [stack, list] of byStack) {
          const browser = stack.ownerDocument.defaultView.gBrowser;
          const picked = list.find(m => m.tab === browser.selectedTab);
          if (!picked) continue; // the move didn't select a tab of this stack
          const best = list.reduce((a, b) => (b.last > a.last ? b : a));
          if (best === picked || !best.tab.isConnected || best.tab.closing) continue;
          browser.selectedTab = best.tab;
          picked.tab.updateLastAccessed(picked.last); // only the move selected it
        }
      }

      ctx.listen(gBrowser.tabContainer, "TabClose", (e) => {
        const tab = e.detail?.adoptedBy;
        if (!tab || tab.closing) return;
        const old = e.target;
        if (!timeBefore.has(old)) {
          // The selected tab reads as now, which is right: it's the one you were on.
          for (const t of old.group?.tabs ?? [old]) timeBefore.set(t, t.lastAccessed);
        }
        const last = timeBefore.get(old);
        if (!tab.selected) tab.updateLastAccessed(last);
        if (!moved.length) ctx.timeout(finish);
        moved.push({ tab, last });
      });
    },
  });

  // ---------------------------------------------------- Stack Improvements --

  // Stack tabs are proxies that don't carry the real tab's state, so several
  // features copy it across whenever Floorp rebuilds the stack bar
  // (toolbox mutations) or the state changes.
  function syncProxiesOn(ctx, sync, { attrs = null, onSelect = true } = {}) {
    const schedule = ctx.throttle(sync, "stack tab update");
    ctx.watchToolbox(schedule);
    if (onSelect) ctx.listen(gBrowser.tabContainer, "TabSelect", schedule);
    if (attrs) {
      ctx.listen(gBrowser.tabContainer, "TabAttrModified", (e) => {
        if (e.detail?.changed?.some(a => attrs.includes(a))) schedule();
      });
    }
    sync();
    return schedule;
  }

  defineFeature({
    id: "stack-container-line",
    category: "stacks",
    name: "Container colors",
    description: "Stack tabs in a container show the container's colored line, like normal tabs.",
    default: true,
    standalone: ["stacktab-general-improvements.uc.js"],
    init(ctx) {
      // Copying the tab's identity-color-* class makes usercontext.css set
      // the --identity-* colors on the proxy. ::after is Floorp's separator.
      const COLOR_CLASS_RE = /^identity-color-/;
      ctx.style(`
        .floorp-stack-tab[usercontextid]::before {
          content: "";
          position: absolute;
          inset-inline: 6px;
          inset-block-end: 2px;
          height: 2px;
          border-radius: 1px;
          background: var(--identity-stroke-color, var(--identity-icon-color));
          pointer-events: none;
        }
      `);

      function syncContainer(proxy, tab) {
        const ctxId = tab?.getAttribute("usercontextid");
        const color = ctxId && [...tab.classList].find(c => COLOR_CLASS_RE.test(c));
        for (const c of [...proxy.classList]) {
          if (COLOR_CLASS_RE.test(c) && c !== color) proxy.classList.remove(c);
        }
        if (ctxId && color) {
          U.setAttr(proxy, "usercontextid", ctxId);
          proxy.classList.add(color);
        } else {
          U.setAttr(proxy, "usercontextid", null);
        }
      }

      const sync = () => {
        const byId = U.tabsById();
        for (const proxy of document.querySelectorAll(U.PROXY_SEL)) {
          syncContainer(proxy, byId.get(proxy.getAttribute("data-floorp-drag-id")) ?? null);
        }
      };
      ctx.onCleanup(() => {
        for (const proxy of document.querySelectorAll(U.PROXY_SEL)) syncContainer(proxy, null);
      });
      const schedule = syncProxiesOn(ctx, sync);
      // A container's color can be edited in settings.
      ctx.observeTopic("contextual-identity-updated", schedule);
    },
  });

  defineFeature({
    id: "stack-audio-button",
    category: "stacks",
    name: "Audio button",
    description: "Stack tabs and stacks show the speaker button while playing sound. Click it to mute or unmute.",
    default: true,
    standalone: ["stacktab-general-improvements.uc.js"],
    init(ctx) {
      // The button is the same moz-button a global tab uses, carrying the real
      // tab's audio attributes, so the theme styles it too. tabs.css only
      // shows it inside #tabbrowser-tabs, so those rules are repeated for the
      // stack bar, and the theme's positioning variables are copied from the
      // real tab. Clicks are caught on windowRoot, ahead of Floorp.
      const STACK_ATTR = U.STACK_ATTR;
      const AUDIO_BTN = "uc-stack-audio-button";
      const AUDIO_ATTRS = ["soundplaying", "soundplaying-scheduledremoval", "muted", "activemedia-blocked"];
      const THEME_VARS = [
        [tab => tab, [
          "--tab-icon-end-margin",
          "--tab-min-width-extra-icons",
          "--uc-sound-tab-icon-position-x",
          "--uc-sound-tab-icon-position-y",
        ]],
        [tab => tab.querySelector(".tab-label-container"), [
          "--uc-sound-tab-label-position-x",
        ]],
      ];
      const ALL_THEME_VARS = THEME_VARS.flatMap(([, names]) => names);
      const PROXY_TOOLTIPS = { playing: "Mute tab", muted: "Unmute tab", blocked: "Play tab" };
      const CHIP_TOOLTIPS = { playing: "Mute stack", muted: "Unmute stack" };
      const ICON = "chrome://browser/skin/tabbrowser/";

      ctx.style(`
        /* tabs.css's own rules, which only match inside #tabbrowser-tabs. */
        #floorp-stack-bar .tab-audio-button:not([crashed]) {
          &:is([soundplaying], [muted], [activemedia-blocked]) {
            display: flex;
          }
          &[soundplaying]::part(button) {
            background-image: url("${ICON}tab-audio-playing-small.svg");
          }
          &[muted]::part(button) {
            background-image: url("${ICON}tab-audio-muted-small.svg");
          }
          &[activemedia-blocked]::part(button) {
            background-image: url("${ICON}tab-audio-blocked-circle-12.svg");
          }
        }

        /* A global tab with the button grows its min-width and changes the
           favicon's end margin; the theme may also shift the title. */
        .floorp-stack-tab[uc-audio] {
          min-width: calc(var(--tab-min-width, 76px) + var(--tab-min-width-extra-icons, 0px)) !important;
        }
        .floorp-stack-tab[uc-audio] > .floorp-stack-tab-iconbox {
          margin-inline-end: var(--tab-icon-end-margin, 6px);
        }
        .floorp-stack-tab[uc-audio] > .floorp-stack-tab-label {
          transform: translateX(var(--uc-sound-tab-label-position-x, 0px));
        }

        /* Chip: the title is the label's ::before; sit in front of it, just
           past the (absolutely placed) stack icon. */
        tab-group[${STACK_ATTR}] .tab-group-label > .${AUDIO_BTN} {
          order: -1;
        }
        tab-group[${STACK_ATTR}] .tab-group-label[uc-audio]::before {
          transform: translateX(var(--uc-sound-tab-label-position-x, 0px));
        }
      `);

      // Same precedence as tabs.css: blocked > muted > playing.
      function tabAudioState(tab) {
        if (!tab || tab.hasAttribute("crashed")) return null;
        if (tab.hasAttribute("activemedia-blocked")) return "blocked";
        if (tab.hasAttribute("muted")) return "muted";
        if (tab.hasAttribute("soundplaying")) return "playing";
        return null;
      }

      function stackAudioState(group) {
        const states = group.tabs.map(tabAudioState);
        if (states.includes("playing")) return "playing";
        if (states.includes("muted")) return "muted";
        return null;
      }

      function copyThemeVars(tab, target) {
        for (const [elementOf, names] of THEME_VARS) {
          const el = tab && elementOf(tab);
          const style = el && getComputedStyle(el);
          for (const name of names) {
            const value = style?.getPropertyValue(name).trim();
            if (value) {
              if (target.style.getPropertyValue(name) !== value) target.style.setProperty(name, value);
            } else {
              target.style.removeProperty(name);
            }
          }
        }
      }

      // Keeps `parent`'s button showing `attrs`, creating it with `place` or
      // removing it when `attrs` is null.
      function syncAudioButton(parent, attrs, tooltip, place) {
        let btn = parent.querySelector(`:scope > .${AUDIO_BTN}`);
        if (!attrs) {
          btn?.remove();
          return;
        }
        if (!btn) {
          btn = document.createElementNS(XHTML_NS, "moz-button");
          btn.className = `tab-audio-button ${AUDIO_BTN}`;
          btn.setAttribute("type", "icon ghost");
          btn.setAttribute("size", "small");
          btn.setAttribute("tabindex", "-1");
          place(btn);
        }
        for (const name of AUDIO_ATTRS) U.setAttr(btn, name, attrs[name] ?? null);
        U.setAttr(btn, "title", tooltip);
      }

      function syncProxyAudio(proxy, tab) {
        const state = tabAudioState(tab);
        const attrs = state && Object.fromEntries(
          AUDIO_ATTRS.filter(a => tab.hasAttribute(a)).map(a => [a, tab.getAttribute(a)])
        );
        const iconbox = proxy.querySelector(":scope > .floorp-stack-tab-iconbox");
        U.setAttr(proxy, "uc-audio", state);
        copyThemeVars(state && tab, proxy);
        syncAudioButton(proxy, attrs, PROXY_TOOLTIPS[state],
          btn => iconbox ? iconbox.after(btn) : proxy.prepend(btn));
      }

      function syncChipAudio(group) {
        const label = group.querySelector(".tab-group-label");
        if (!label) return;
        // Groups Floorp doesn't show as stacks keep their native look.
        const state = U.isStack(group) ? stackAudioState(group) : null;
        const attrs = state && { [state === "playing" ? "soundplaying" : "muted"]: "" };
        U.setAttr(label, "uc-audio", state);
        copyThemeVars(state && group.tabs.find(t => tabAudioState(t) === state), label);
        syncAudioButton(label, attrs, CHIP_TOOLTIPS[state], btn => label.append(btn));
      }

      function sync() {
        const byId = U.tabsById();
        for (const proxy of document.querySelectorAll(U.PROXY_SEL)) {
          syncProxyAudio(proxy, byId.get(proxy.getAttribute("data-floorp-drag-id")) ?? null);
        }
        for (const group of gBrowser.tabGroups) syncChipAudio(group);
      }

      // Does what tab.js does for `.tab-audio-button`: resume blocked media,
      // otherwise toggle mute (on every selected tab when multiselected). On
      // a chip: mute every playing member, or unmute every muted one.
      function onAudioButtonClick(btn) {
        const proxy = btn.closest(U.PROXY_SEL);
        if (proxy) {
          const tab = U.realTabOf(proxy);
          if (!tab) return;
          if (tabAudioState(tab) === "blocked") {
            if (tab.multiselected) gBrowser.resumeDelayedMediaOnMultiSelectedTabs(tab);
            else tab.resumeDelayedMedia();
          } else if (tab.multiselected) {
            gBrowser.toggleMuteAudioOnMultiSelectedTabs(tab);
          } else {
            tab.toggleMuteAudio();
          }
          return;
        }
        const group = btn.closest(`tab-group[${STACK_ATTR}]`);
        if (!group) return;
        const state = stackAudioState(group);
        for (const tab of group.tabs) {
          if (tabAudioState(tab) === state) tab.toggleMuteAudio();
        }
      }

      // Plain left presses on a button stop here, before Floorp or the proxy
      // see them; mousedown's default is cancelled so it can't start a drag.
      // Ctrl/Shift fall through, so they multiselect like on a global tab.
      function onPress(e) {
        if (e.button !== 0 || e.shiftKey || e.getModifierState("Accel")) return;
        const btn = e.target?.closest?.(`.${AUDIO_BTN}`);
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "click") onAudioButtonClick(btn);
      }
      for (const type of ["mousedown", "click", "dblclick"]) {
        ctx.listen(window.windowRoot, type, onPress, true);
      }

      ctx.onCleanup(() => {
        for (const btn of document.querySelectorAll(`.${AUDIO_BTN}`)) btn.remove();
        for (const el of document.querySelectorAll(`${U.PROXY_SEL}, tab-group .tab-group-label`)) {
          el.removeAttribute("uc-audio");
          for (const name of ALL_THEME_VARS) el.style.removeProperty(name);
        }
      });
      syncProxiesOn(ctx, sync, { attrs: [...AUDIO_ATTRS, "crashed"] });
    },
  });

  defineFeature({
    id: "stack-loading-animation",
    category: "stacks",
    name: "Loading animation",
    description: "Stack tabs show the loading animation while their page loads.",
    default: true,
    standalone: ["stacktab-general-improvements.uc.js"],
    init(ctx) {
      // Firefox's tab throbber (same sprite, timing, `progress` color and
      // reduced-motion fallback as tabs.css) in a box next to the favicon.
      const THROBBER_CLASS = "uc-stack-throbber";
      ctx.style(`
        .floorp-stack-tab-iconbox > .${THROBBER_CLASS} {
          position: relative;
          width: 16px;
          height: 16px;
          overflow: hidden;
          pointer-events: none;
        }

        /* The doubled class outranks the "keep the icon on hover" rule. */
        .floorp-stack-tab.floorp-stack-tab[uc-busy] > .floorp-stack-tab-iconbox > .floorp-stack-tab-icon,
        .floorp-stack-tab-iconbox > .${THROBBER_CLASS}:not([busy]) {
          display: none !important;
        }

        @media (prefers-reduced-motion: reduce) {
          .floorp-stack-tab-iconbox > .${THROBBER_CLASS} {
            background-image: url("chrome://global/skin/icons/loading.svg");
            background-position: center;
            background-repeat: no-repeat;
            -moz-context-properties: fill;
            fill: currentColor;
            opacity: 0.4;
          }
          .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[progress] {
            opacity: 0.8;
          }
        }

        @media (prefers-reduced-motion: no-preference) {
          :root[sessionrestored] .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[busy]::before {
            content: "";
            position: absolute;
            background-image: url("chrome://browser/skin/tabbrowser/loading.svg");
            background-position: left center;
            background-repeat: no-repeat;
            width: 480px;
            height: 100%;
            animation: uc-stack-tab-throbber 1.05s steps(30) infinite;
            -moz-context-properties: fill;
            fill: currentColor;
            opacity: 0.7;
          }
          :root[sessionrestored] .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[busy]:-moz-locale-dir(rtl)::before {
            animation-name: uc-stack-tab-throbber-rtl;
          }
          :root[sessionrestored] .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[progress]::before {
            fill: var(--tab-loading-fill);
            opacity: 1;
          }
          :root[sessionrestored]:has(#TabsToolbar[brighttext])
            .floorp-stack-tab:not([data-selected="true"]) > .floorp-stack-tab-iconbox > .${THROBBER_CLASS}[progress]::before {
            fill: #84c1ff;
          }
        }

        @keyframes uc-stack-tab-throbber {
          0% { transform: translateX(0); }
          100% { transform: translateX(-100%); }
        }
        @keyframes uc-stack-tab-throbber-rtl {
          0% { transform: translateX(0); }
          100% { transform: translateX(100%); }
        }
      `);

      // Created the first time the tab loads and hidden when idle after that.
      function syncThrobber(proxy, tab) {
        const iconbox = proxy.querySelector(":scope > .floorp-stack-tab-iconbox");
        if (!iconbox) return;
        const busy = !!tab?.hasAttribute("busy");
        let throbber = iconbox.querySelector(`:scope > .${THROBBER_CLASS}`);
        if (!throbber) {
          if (!busy) return;
          throbber = document.createXULElement("hbox");
          throbber.classList.add(THROBBER_CLASS);
          const icon = iconbox.querySelector(":scope > .floorp-stack-tab-icon");
          if (icon) icon.after(throbber);
          else iconbox.prepend(throbber);
        }
        U.setAttr(throbber, "busy", busy ? "true" : null);
        U.setAttr(throbber, "progress", tab?.hasAttribute("progress") ? "true" : null);
        U.setAttr(proxy, "uc-busy", busy ? "true" : null);
      }

      const sync = () => {
        const byId = U.tabsById();
        for (const proxy of document.querySelectorAll(U.PROXY_SEL)) {
          syncThrobber(proxy, byId.get(proxy.getAttribute("data-floorp-drag-id")) ?? null);
        }
      };
      ctx.onCleanup(() => {
        for (const el of document.querySelectorAll(`.floorp-stack-tab-iconbox > .${THROBBER_CLASS}`)) el.remove();
        for (const el of document.querySelectorAll(`${U.PROXY_SEL}[uc-busy]`)) el.removeAttribute("uc-busy");
      });
      syncProxiesOn(ctx, sync, { attrs: ["busy", "progress"] });
    },
  });

  defineFeature({
    id: "stack-button-layout",
    category: "stacks",
    name: "Normal tab buttons",
    description: "Stack tabs and stacks have their close button at the right end, keep their icon visible on hover, and use the normal pointer, like normal tabs.",
    default: true,
    standalone: ["stacktab-general-improvements.uc.js"],
    init(ctx) {
      const STACK_ATTR = U.STACK_ATTR;
      ctx.style(`
        .floorp-stack-tab > .floorp-stack-tab-iconbox > .floorp-stack-tab-close {
          position: absolute !important;
          inset-inline-end: 6px !important;
          inset-block-start: 50% !important;
          transform: translateY(-50%) !important;
        }

        /* Floorp paints a solid backdrop so the X can cover the favicon; at
           the end of the tab it only needs the hover highlight. */
        .floorp-stack-tab > .floorp-stack-tab-iconbox > .floorp-stack-tab-close:not(:hover) {
          background-color: transparent !important;
        }

        .floorp-stack-tab:hover > .floorp-stack-tab-iconbox > .floorp-stack-tab-icon {
          display: revert-layer !important;
        }

        /* Hover-reload goes in front of the close button: title, reload, close. */
        .floorp-stack-tab > .floorp-stack-tab-refresh {
          inset-inline-end: 24px !important;
        }

        .floorp-stack-tab:hover > .floorp-stack-tab-label {
          margin-inline-end: 14px !important;
        }

        :root[floorp-hover-reload] .floorp-stack-tab:hover > .floorp-stack-tab-label {
          margin-inline-end: 32px !important;
        }

        /* The stack bar sizes to its tabs' content widths, so the hover
           margin above would nudge every tab. A preferred width equal to
           Floorp's flex-basis makes each tab count the same; flexing still
           shrinks them when space is short. */
        .floorp-stack-tab {
          width: 180px;
        }

        tab-group[${STACK_ATTR}] .tab-group-label > .floorp-stack-close {
          inset-inline-start: auto !important;
          inset-inline-end: 6px !important;
        }

        tab-group[${STACK_ATTR}] .tab-group-label > .floorp-stack-close:not(:hover) {
          background-color: transparent !important;
        }

        tab-group[${STACK_ATTR}] .tab-group-label-container:hover .floorp-stack-icon {
          display: revert-layer !important;
        }

        /* The tab count moves over to clear the close button and the title's
           fade moves in with it. Painting only, so the chip keeps its width. */
        tab-group[${STACK_ATTR}] .tab-group-label-container:hover .tab-group-label::after {
          position: relative;
          inset-inline-start: -15px;
        }
        tab-group[${STACK_ATTR}] .tab-group-label-container:hover .tab-group-label::before {
          mask-image: linear-gradient(to left, transparent 15px, black calc(15px + 1em));
        }

        /* Global tabs keep the arrow cursor; Floorp gives the chip a pointer. */
        tab-group[${STACK_ATTR}] .tab-group-label,
        tab-group[${STACK_ATTR}] .tab-group-label > .floorp-stack-close {
          cursor: default !important;
        }
      `);
    },
  });

  defineFeature({
    id: "stack-remember-tab",
    category: "stacks",
    name: "Remember each stack's tab",
    description: "Clicking a stack opens the tab you last used in it, even after a restart.",
    default: true,
    standalone: ["stacktab-general-improvements.uc.js"],
    init(ctx) {
      // Floorp remembers this only in memory. Firefox's lastAccessed (what
      // Ctrl+Tab orders by) survives restarts. A second click of a
      // double-click finds the stack active and passes through to rename.
      ctx.listen(window.windowRoot, "click", (e) => {
        if (e.button !== 0) return;
        const target = e.target;
        if (target?.closest?.(".floorp-stack-close, .uc-stack-audio-button")) return;
        const group = target?.closest?.(".tab-group-label-container")
          ?.closest(`tab-group[${U.STACK_ATTR}]`);
        if (!group || gBrowser.selectedTab.group === group) return;
        const recent = U.lastViewed(group.tabs.filter(t => !t.hidden && !t.closing));
        if (!recent) return;
        e.preventDefault();
        e.stopPropagation();
        gBrowser.selectedTab = recent;
      }, true);
    },
  });

  defineFeature({
    id: "close-stays-in-stack",
    category: "stacks",
    name: "Stay in the stack when closing tabs",
    description: "Closing or unloading a tab, or moving it to another workspace, switches to the nearest loaded tab in the same stack or group, or among the normal tabs. If none is left there, it goes to the nearest one outside, and a stack opens on the tab you last used in it.",
    default: true,
    standalone: ["stacktab-general-improvements.uc.js"],
    init(ctx) {
      // Sets the selected tab's successor (see CLAUDE.md for the full rules).
      // The "container" is its stack or group, the pinned tabs, or the other
      // global tabs. Outside stacks, Firefox's owner/MRU rules win.
      const STACK_ATTR = U.STACK_ATTR;
      const ourSuccessors = new WeakMap(); // tab → successor we set
      const tabsWithOurs = new Set();

      // Left first unless the "Go to the tab on the left" sub-setting is off.
      const closeTarget = (tab, avoid) =>
        U.closeTarget(tab, avoid, { leftFirst: ctx.isActive("close-prefer-left") });

      const firefoxPicksOwnerOrMRU = (tab) =>
        (tab.owner?.visible && U.prefBool("browser.tabs.selectOwnerOnClose", true))
        || U.prefBool("browser.tabs.selectMRUOnClose", false);

      // Firefox skips the successor when it's among the tabs to avoid
      // (closing several at once, or unloading); apply the same rules then.
      ctx.optional(() => ctx.hook(gBrowser, "_findTabToBlurTo", function (next, tab, excludeTabs = [], ...rest) {
        if (tab?.selected && excludeTabs?.length
            && tab.successor && tab.successor === ourSuccessors.get(tab)) {
          const avoid = new Set(excludeTabs);
          const fxView = window.FirefoxViewHandler?.tab; // Firefox avoids it too
          if (fxView) avoid.add(fxView);
          const pick = closeTarget(tab, avoid);
          if (pick) return pick;
        }
        return next(tab, excludeTabs, ...rest);
      }), "Closing several tabs at once, or unloading, may still leave the stack or group");

      // Floorp's "Move Tab to Another Workspace" switches to the workspace's
      // first tab when the selected tab moves; this lands where closing it
      // would. Floorp only switches if the moved tab is still selected, so a
      // single tab is handled by switching first. With several selected tabs
      // that can't work (gBrowser.selectedTabs always includes the selected
      // tab, so the new one would be moved too): Floorp's choice is corrected
      // once its command has run, then Floorp re-hides what moved.
      let afterMove = null; // { event, pick }
      ctx.listen(window, "command", (e) => {
        if (!e.target?.closest?.("#WorkspacesTabContextMenu")) return;
        const context = window.TabContextMenu?.contextTab;
        const selected = gBrowser.selectedTab;
        const moving = context?.multiselected ? gBrowser.selectedTabs : [context];
        if (!moving.includes(selected)) return;
        const pick = closeTarget(selected, new Set(moving));
        if (!pick) return; // nothing left here: Floorp opens a tab
        if (!context.multiselected) {
          gBrowser.selectedTab = pick;
        } else {
          afterMove = { event: e, pick };
          ctx.timeout(() => { afterMove = null; });
        }
      }, true);
      ctx.listen(window, "command", (e) => {
        if (afterMove?.event !== e) return;
        const { pick } = afterMove;
        afterMove = null;
        if (pick.isConnected && !pick.closing && U.workspaceOf(pick) === U.currentWorkspace()) {
          gBrowser.selectedTab = pick;
          U.refreshWorkspace();
        }
      });

      function refreshSuccessor() {
        const tab = gBrowser.selectedTab;
        if (!tab || tab.closing) return;
        const ours = ourSuccessors.get(tab);
        const inStack = !!tab.group?.hasAttribute(STACK_ATTR);
        const successor = tab.successor;
        // Leave other people's successors alone, apart from Floorp's in-stack one.
        if (successor && successor !== ours && !(inStack && successor.group === tab.group)) return;
        const pick = !inStack && firefoxPicksOwnerOrMRU(tab) ? null : closeTarget(tab);
        if (pick) {
          if (tab.successor !== pick) gBrowser.setSuccessor(tab, pick);
          ourSuccessors.set(tab, pick);
          tabsWithOurs.add(tab);
        } else if (ours) {
          gBrowser.setSuccessor(tab, null);
          ourSuccessors.delete(tab);
          tabsWithOurs.delete(tab);
        }
      }

      // After the event's other listeners (Floorp sets its successors
      // synchronously), once per burst.
      const schedule = ctx.batch(refreshSuccessor, "choosing the tab to switch to");
      const tabs = gBrowser.tabContainer;
      for (const type of ["TabSelect", "TabOpen", "TabClose", "TabMove", "TabShow", "TabHide",
                          "TabPinned", "TabUnpinned", "TabGrouped", "TabUngrouped",
                          "TabGroupCollapse", "TabGroupExpand",
                          "TabBrowserInserted", "TabBrowserDiscarded"]) {
        ctx.listen(tabs, type, schedule);
      }
      ctx.listen(tabs, "TabAttrModified", (e) => {
        if (e.detail?.changed?.some(a => a === "pending" || a === "discarded")) schedule();
      });
      ctx.listen(tabs, "TabClose", (e) => tabsWithOurs.delete(e.target));
      // A feature turning on or off (the sub-setting among them) re-picks the
      // successor at once instead of at the next tab event.
      ctx.onCleanup(onChanged(schedule));

      ctx.onCleanup(() => {
        for (const tab of tabsWithOurs) {
          if (tab.isConnected && tab.successor && tab.successor === ourSuccessors.get(tab)) {
            gBrowser.setSuccessor(tab, null);
          }
        }
        tabsWithOurs.clear();
      });
      schedule();
    },
  });

  defineFeature({
    id: "close-prefer-left",
    parent: "close-stays-in-stack",
    name: "Go to the tab on the left",
    description: "Looks for the next tab on the left first. Turn off to look on the right first.",
    default: true,
    standalone: ["stacktab-general-improvements.uc.js"],
    init() {
      // Nothing to set up: "Stay in the stack when closing tabs" and "Move
      // Stack to Another Workspace" check whether this is running.
    },
  });

  defineFeature({
    id: "middle-click-new-tab",
    category: "stacks",
    name: "Middle-click for a new tab",
    description: "Middle-click empty space on the tab bar to open a new tab, or empty space in a stack to open one in that stack.",
    default: true,
    standalone: ["stacktab-mouse-improvements.uc.js"],
    init(ctx) {
      // Blank global tab bar → a new tab at the global end.
      ctx.listen(window, "click", (e) => {
        if (e.button !== 1) return;
        if (e.target.closest?.("#floorp-stack-items") || e.target.closest?.(".floorp-stack-tab") ||
            e.target.closest?.(".tabbrowser-tab")) return;
        const isScrollbox =
          e.target.classList?.contains("tabbrowser-arrowscrollbox") ||
          e.target.localName === "arrowscrollbox" ||
          e.target.id === "tabbrowser-arrowscrollbox" ||
          e.target.getAttribute?.("anonid") === "arrowscrollbox";
        if (!isScrollbox) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const newTab = gBrowser.addTab("about:newtab", {
          tabIndex: gBrowser.tabs.length,
          index: gBrowser.tabs.length, // older Firefox reads index
          triggeringPrincipal: U.systemPrincipal(),
        });
        gBrowser.selectedTab = newTab;
        ctx.timeout(U.focusUrlbar);
      }, true);

      // Blank stack bar → a new tab in that stack. When new tabs open next
      // to the current one (Firefox's or Floorp's setting) the native command
      // already lands beside it inside the stack; otherwise Firefox appends
      // it at the global end, so it's opened and moved to the end of the
      // stack instead. Floorp handles middle-clicking a stack tab itself (it
      // closes it).
      ctx.listen(window, "auxclick", (e) => {
        if (e.button !== 1) return;
        if (e.target.closest?.(".floorp-stack-tab")) return;
        const strip = e.target.closest?.("#floorp-stack-items");
        if (!strip) return;

        e.preventDefault();
        e.stopImmediatePropagation();

        const nativeNewTab = () => {
          document.getElementById("cmd_newNavigatorTab").doCommand();
          ctx.timeout(U.focusUrlbar);
        };

        const group = U.stackOfStrip(strip);
        if (!group || (U.opensNextToCurrent() && U.stackOf(gBrowser.selectedTab) === group)) {
          nativeNewTab();
          return;
        }

        const newTab = gBrowser.addTab("about:newtab", { triggeringPrincipal: U.systemPrincipal() });
        if (!U.adoptToGroup(newTab, group)) ctx.warn("Couldn't move new tabs into a stack (no API for it).");
        gBrowser.selectedTab = newTab;
        ctx.timeout(U.focusUrlbar);
      }, true);
    },
  });

  defineFeature({
    id: "new-tab-shortcut-in-stack",
    category: "stacks",
    name: "Ctrl+T opens in the stack",
    description: "Ctrl+T and the new tab mouse gesture open the tab where you are: in the stack you're using, or with your normal tabs when you're not in one.",
    default: true,
    standalone: ["stacktab-hotkey-opens-in-stack.uc.js"],
    init(ctx) {
      // Opens in the stack by clicking Floorp's own stack + button: a tab
      // created inside the group doesn't replay the stack's roll-down
      // animation the way a moved one does. The keyboard is caught at its
      // command (the + button uses a different one); the gesture fires no
      // command, so it's caught in addTab by its call stack.
      // In a stack, unless new tabs open next to the current one (Firefox's
      // or Floorp's setting): then Firefox already puts it beside the current
      // tab, inside its stack, and the stack's + would put it at the end.
      function targetStack() {
        const group = U.stackOf(gBrowser.selectedTab);
        return group && !U.opensNextToCurrent() ? group : null;
      }

      let clicking = false; // our own + click re-enters addTab
      function openWithStackButton() {
        const btn = document.getElementById("floorp-stack-newtab");
        if (!btn?.isConnected) return null;
        const before = new Set(gBrowser.tabs);
        clicking = true;
        try {
          btn.click();
        } finally {
          clicking = false;
        }
        return gBrowser.tabs.find(t => !before.has(t)) || null;
      }

      // Fallback when the button is missing: open, then move into the stack.
      function adopt(tab, group) {
        if (!U.adoptToGroup(tab, group)) ctx.warn("Couldn't move new tabs into a stack (no API for it).");
      }

      let handledThisTick = false;
      ctx.listen(window, "command", (e) => {
        if (!U.isCommand(e.target, "cmd_newNavigatorTabNoEvent")) return;
        const group = targetStack();
        if (!group) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (handledThisTick) return; // the same key press arriving twice
        handledThisTick = true;
        ctx.timeout(() => { handledThisTick = false; });

        if (!openWithStackButton()) {
          const newTab = gBrowser.addTab("about:newtab", { triggeringPrincipal: U.systemPrincipal() });
          adopt(newTab, group);
          gBrowser.selectedTab = newTab;
        }
        ctx.timeout(U.focusUrlbar);
      }, true);

      ctx.hook(gBrowser, "addTab", function (next, uri, ...rest) {
        if (clicking) return next(uri, ...rest);
        // Decide before anything is created, while selectedTab is still the
        // tab you were on.
        const group = U.isBlankNewTab(uri) && U.callStackIncludes(/executeGestureAction/) ? targetStack() : null;
        if (!group) return next(uri, ...rest);

        const opened = openWithStackButton();
        ctx.timeout(U.focusUrlbar);
        if (opened) return opened; // hand the gesture the in-stack tab
        const tab = next(uri, ...rest);
        adopt(tab, group);
        return tab;
      });
    },
  });

  defineFeature({
    id: "new-tab-shortcut-in-group",
    parent: "new-tab-shortcut-in-stack",
    name: "Also in tab groups",
    description: "The same for tab groups: in a tab group, Ctrl+T and the mouse gesture open the tab in that group.",
    default: true,
    init(ctx) {
      // Firefox still opens the tab itself (its new tab page, address bar
      // focus); only its place changes, through addTab's tabGroup option,
      // which creates it inside the group. The shortcut's command marks the
      // addTab call it's about to make (synchronously); the gesture fires no
      // command and is recognised by its call stack, as in the parent.
      let pending = null;
      ctx.listen(window, "command", (e) => {
        if (!U.isCommand(e.target, "cmd_newNavigatorTabNoEvent")) return;
        pending = U.plainGroupOf(gBrowser.selectedTab);
        if (pending) ctx.timeout(() => { pending = null; });
      }, true);

      ctx.hook(gBrowser, "addTab", function (next, uri, opts, ...rest) {
        let group = pending;
        pending = null;
        if (!group && U.isBlankNewTab(uri) && U.callStackIncludes(/executeGestureAction/)) {
          group = U.plainGroupOf(gBrowser.selectedTab);
        }
        if (!group?.isConnected || opts?.tabGroup) return next(uri, opts, ...rest);
        return next(uri, { ...opts, tabGroup: group }, ...rest);
      });
    },
  });

  defineFeature({
    id: "bookmarks-in-stack",
    category: "stacks",
    name: "Bookmarks open in the stack",
    description: "Bookmarks and history entries opened in new tabs, including whole folders, go into the stack you're using.",
    default: true,
    init(ctx) {
      // Firefox opens these at the end of the tab bar, outside every stack.
      // addTab's tabGroup option creates them inside the stack instead (at
      // its end, or right after the current tab when new tabs open next to
      // it), so nothing is moved in afterwards. Outside a stack nothing
      // changes. Outermost, so "One Floorp Hub and Settings tab" still takes
      // those pages back out to the normal tabs.
      const place = U.bookmarkPlacer(ctx);
      ctx.hook(gBrowser, "addTab", function (next, uri, opts, ...rest) {
        const group = U.isBookmarkOpen(opts) ? U.stackOf(gBrowser.selectedTab) : null;
        if (!group) return next(uri, opts, ...rest);
        return next(uri, place(opts, group), ...rest);
      }, { priority: -1 });
    },
  });

  defineFeature({
    id: "bookmarks-in-group",
    parent: "bookmarks-in-stack",
    name: "Also in tab groups",
    description: "Bookmarks opened in new tabs also go into the tab group you're using.",
    default: true,
    init(ctx) {
      // The same as the parent, for plain Firefox groups.
      const place = U.bookmarkPlacer(ctx);
      ctx.hook(gBrowser, "addTab", function (next, uri, opts, ...rest) {
        const group = U.isBookmarkOpen(opts) ? U.plainGroupOf(gBrowser.selectedTab) : null;
        if (!group) return next(uri, opts, ...rest);
        return next(uri, place(opts, group), ...rest);
      }, { priority: -1 });
    },
  });

  defineFeature({
    id: "inline-stack-newtab-button",
    category: "stacks",
    name: "Stack + button beside the tabs",
    description: "A stack's + button sits right after its tabs, like on the main tab bar, and moves to the edge when the tabs don't fit.",
    default: true,
    standalone: ["stacktab-inline-newtab-button.uc.js"],
    init(ctx) {
      // Floorp puts the button after the scroll arrows. Inline when the tabs
      // fit, back at the bar's end when they overflow, with a small dead
      // band so a borderline width can't flicker.
      const PARK_AT = 4;   // inline → park once overflow exceeds this
      const INLINE_AT = 2; // parked → inline once overflow drops below this
      let roTarget = null;
      const ro = ctx.resizeObserver(() => schedule());

      function update() {
        const bar = document.getElementById("floorp-stack-bar");
        const items = document.getElementById("floorp-stack-items");
        const scroller = document.getElementById("floorp-stack-scroller");
        const btn = document.getElementById("floorp-stack-newtab");
        if (!bar || !items || !scroller || !btn) return;

        if (roTarget !== scroller) {
          if (roTarget) ro.unobserve(roTarget);
          ro.observe(scroller);
          roTarget = scroller;
        }

        const over = scroller.scrollWidth - scroller.clientWidth; // >0 = overflow
        const inline = btn.parentElement === items ? !(over > PARK_AT) : over < INLINE_AT;
        if (inline) {
          if (btn.parentElement !== items || items.lastElementChild !== btn) items.appendChild(btn);
        } else if (btn.parentElement !== bar || bar.lastElementChild !== btn) {
          bar.appendChild(btn);
        }
      }
      const schedule = ctx.throttle(update, "placing the stack + button");
      ctx.watchToolbox(schedule);

      ctx.onCleanup(() => {
        const bar = document.getElementById("floorp-stack-bar");
        const btn = document.getElementById("floorp-stack-newtab");
        if (bar && btn && btn.parentElement !== bar) bar.appendChild(btn);
      });

      const btnOf = (e) => e.target?.closest?.("#floorp-stack-newtab");
      const isInline = (btn) => !!document.getElementById("floorp-stack-items")?.contains(btn);

      // Floorp's button opens a tab on `click` for every mouse button.
      // Right-click doesn't: its click is kept from the button with
      // stopPropagation only, because on Windows a cancelled right-button
      // click means no contextmenu event at all (no container menu).
      // Middle-click on the inline button is left to the "Middle-click for a
      // new tab" feature's auxclick (the button now sits in the stack's empty
      // space), so exactly one tab opens; no preventDefault, or auxclick
      // wouldn't fire.
      ctx.listen(window, "click", (e) => {
        const btn = btnOf(e);
        if (!btn) return;
        if (e.button === 2) {
          e.stopPropagation();
          return;
        }
        if (e.button === 1 && isInline(btn) && ctx.isActive("middle-click-new-tab")) {
          e.stopPropagation();
          return;
        }
        // Floorp's in-stack open doesn't focus the address bar.
        if (e.button === 0 || e.button === 1) ctx.timeout(U.focusUrlbar);
      }, true);

      // The toolbar's own context menu stays away from the button. The
      // right-button auxclick is only stopped, like the click above.
      ctx.listen(window, "auxclick", (e) => {
        if (e.button === 2 && btnOf(e)) e.stopPropagation();
      }, true);
      ctx.listen(window, "contextmenu", (e) => {
        if (!btnOf(e)) return;
        e.preventDefault();
        e.stopPropagation();
      }, true);

      schedule();
    },
  });

  defineFeature({
    id: "stack-newtab-containers",
    category: "stacks",
    name: "Container menu on the stack + button",
    description: "Right-click or hold a stack's + button to open a new tab in a container in that stack, like the main tab bar's + button. If containers are set to open on a left-click, a left-click works too.",
    default: true,
    init(ctx) {
      // Firefox's + buttons open a menu filled by createUserContextMenu, whose
      // items run Browser:NewUserContextTab. That opens the tab through
      // openTrustedLinkIn, which takes no group, so the tab would land at the
      // end of the tab bar. The stack's + gets the same menu, and the addTab
      // its command makes gets the stack as its group, with the tab at the
      // stack's end like Floorp's own +. Firefox still opens the page, so the
      // new tab URL, selection and address bar focus are its own.
      const COMMAND = "Browser:NewUserContextTab";
      ctx.require(typeof window.createUserContextMenu === "function",
        "Firefox's container menu (createUserContextMenu) is missing");
      const popupset = ctx.require(document.getElementById("mainPopupSet"), "the main popup set is missing");

      // The same conditions Firefox uses for its + buttons.
      const containersOn = () => U.prefBool("privacy.userContext.enabled", false) &&
        !window.PrivateBrowsingUtils?.isWindowPrivate(window);
      const btnOf = (e) => e.target?.closest?.("#floorp-stack-newtab");

      const popup = ctx.track(document.createXULElement("menupopup"));
      popup.id = "uc-stack-newtab-container-popup";
      popup.className = "new-tab-popup";
      popupset.appendChild(popup);
      popup.addEventListener("popupshowing", ctx.guard((e) => {
        if (e.target !== popup) return;
        window.createUserContextMenu(e, {
          useAccessKeys: false,
          showDefaultTab: true,
          containerSource: "new_tab_button",
        });
      }, "filling the container menu"));

      // Firefox's ways into the menu: right-click, holding the button down,
      // or a plain left-click when this pref makes the + a menu button.
      const LEFT_CLICK_PREF = "privacy.userContext.newTabContainerOnLeftClick.enabled";
      const HOLD_MS = 500; // Firefox's click-and-hold delay

      let menuStack = null; // the stack whose + opened the menu
      // At the pointer for a right-click; below the button otherwise, like
      // Firefox's menu button.
      function openMenu(btn, e) {
        const group = U.activeStack();
        if (!group) return false;
        menuStack = group;
        if (e?.type === "contextmenu") popup.openPopupAtScreen(e.screenX, e.screenY, true, e);
        else popup.openPopup(btn, "after_end", 0, 0, false, false);
        return true;
      }

      ctx.listen(window, "contextmenu", (e) => {
        const btn = btnOf(e);
        if (!btn || !containersOn() || !openMenu(btn, e)) return;
        e.preventDefault();
        e.stopPropagation();
      }, true);

      // Only real presses: new-tab-shortcut-in-stack opens stack tabs by
      // clicking this button from code, and that must still open a tab.
      const realPress = (e) => e.mozInputSource !== MouseEvent.MOZ_SOURCE_UNKNOWN;
      let holdBtn = null;
      let holdTimer = 0;
      let pressOpened = false; // the menu opened during this press
      function cancelHold() {
        if (holdTimer) ctx.clearTimeout(holdTimer);
        holdTimer = 0;
        holdBtn = null;
      }
      function openFromPress(btn) {
        cancelHold();
        if (openMenu(btn)) pressOpened = true;
      }

      ctx.listen(window, "mousedown", (e) => {
        cancelHold();
        pressOpened = false;
        const btn = btnOf(e);
        if (!btn || e.button !== 0 || !realPress(e) || !containersOn() || popup.state !== "closed") return;
        if (U.prefBool(LEFT_CLICK_PREF, false)) {
          e.preventDefault();
          openFromPress(btn);
        } else {
          holdBtn = btn;
          holdTimer = ctx.timeout(() => openFromPress(btn), HOLD_MS);
        }
      }, true);

      // Letting go before the delay is an ordinary click. Dragging down off
      // the button opens the menu at once; off any other side cancels.
      ctx.listen(window, "mouseup", () => {
        cancelHold();
        if (pressOpened) ctx.timeout(() => { pressOpened = false; }); // after this press's click
      }, true);
      ctx.listen(window, "mouseout", (e) => {
        if (!holdBtn || !holdBtn.contains(e.target) || holdBtn.contains(e.relatedTarget)) return;
        const r = holdBtn.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.bottom) openFromPress(holdBtn);
        else cancelHold();
      }, true);

      // The click ending a press that opened the menu isn't a + click: it
      // would open a tab (Floorp) and focus the address bar
      // (inline-stack-newtab-button), so it goes before those and stops them.
      ctx.listen(window, "click", (e) => {
        if (e.button !== 0 || !pressOpened || !realPress(e) || !btnOf(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      }, { capture: true, priority: -1 });

      // Floorp's + opens a tab on a click with any button; a right-click
      // shows the menu instead. Only stopPropagation: on Windows, cancelling
      // the right-button click (or the release) means Gecko never sends the
      // contextmenu event this menu opens from.
      const swallowRight = (e) => {
        if (e.button === 2 && btnOf(e) && containersOn()) e.stopPropagation();
      };
      ctx.listen(window, "click", swallowRight, true);
      ctx.listen(window, "auxclick", swallowRight, true);

      // The command arrives at the <command> element, with the menu item as
      // its source event's target.
      let pending = null;
      ctx.listen(window, "command", (e) => {
        const item = e.target?.id === COMMAND ? e.sourceEvent?.target : e.target;
        if (!item?.hasAttribute?.("data-usercontextid") || !popup.contains(item)) return;
        pending = menuStack;
        ctx.timeout(() => { pending = null; });
      }, true);

      ctx.hook(gBrowser, "addTab", function (next, uri, opts, ...rest) {
        const group = pending;
        pending = null;
        if (!group?.isConnected || opts?.tabGroup || opts?.pinned) return next(uri, opts, ...rest);
        return next(uri, { ...opts, tabGroup: group, tabIndex: gBrowser.tabs.length }, ...rest);
      });
    },
  });

  defineFeature({
    id: "global-plus-middle-click",
    category: "stacks",
    name: "Middle-click the main + for a normal tab",
    description: "Middle-clicking the main tab bar's + button opens a normal tab at the end of the tab bar.",
    default: true,
    standalone: ["stacktab-inline-newtab-button.uc.js"],
    init(ctx) {
      let thisTick = false;
      function openGlobalTab() {
        if (thisTick) return; // click and auxclick from one press
        thisTick = true;
        ctx.timeout(() => { thisTick = false; });
        const tab = gBrowser.addTab("about:newtab", {
          tabIndex: gBrowser.tabs.length, // past all stacks
          index: gBrowser.tabs.length, // older Firefox reads index
          triggeringPrincipal: U.systemPrincipal(),
        });
        gBrowser.selectedTab = tab;
        ctx.timeout(U.focusUrlbar);
      }
      for (const type of ["click", "auxclick"]) {
        ctx.listen(window, type, (e) => {
          if (e.button !== 1 || !e.target?.closest?.("#tabs-newtab-button, #new-tab-button")) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          openGlobalTab();
        }, true);
      }
    },
  });

  defineFeature({
    id: "stack-wheel-scroll",
    category: "stacks",
    name: "Faster wheel scrolling",
    description: "Scrolling a stack's tabs with the mouse wheel is as fast and smooth as on the main tab bar.",
    default: true,
    standalone: ["stacktab-overflow-scroll-speed.uc.js"],
    init(ctx) {
      // Uses Firefox's own smooth scrolling (scrollTo behavior: "smooth"), as
      // the main tab strip does, so it follows the smoothScroll prefs.
      const SPEED = 4;       // distance per notch, times the raw delta
      const RESYNC_MS = 250; // idle time after which the target is re-read
      let scroller = null;
      let dest = 0;
      let lastWheel = 0;

      ctx.listen(window, "wheel", (e) => {
        if (e.ctrlKey) return; // zoom
        const path = e.composedPath();
        let hit = path.find(n => n?.nodeType === 1 && n.id === "floorp-stack-scroller");
        // The arrows and + button sit beside the scroller, in the bar.
        if (!hit) {
          const bar = path.find(n => n?.nodeType === 1 && n.id === "floorp-stack-bar");
          if (bar) hit = (scroller?.isConnected && scroller) || bar.querySelector?.("#floorp-stack-scroller");
        }
        if (!hit) return;

        const raw = e.deltaY || e.deltaX;
        if (!raw) return;
        let px = raw;
        if (e.deltaMode === 1) px *= 16;
        else if (e.deltaMode === 2) px *= hit.clientWidth;
        px *= SPEED;

        e.preventDefault();
        e.stopImmediatePropagation();

        // Accumulate onto our own target so fast spins build distance; re-read
        // the real position after a pause or on another scroller.
        const now = performance.now();
        if (hit !== scroller || now - lastWheel > RESYNC_MS) {
          dest = hit.scrollLeft;
          scroller = hit;
        }
        lastWheel = now;
        dest = Math.max(0, Math.min(hit.scrollWidth - hit.clientWidth, dest + px));
        hit.scrollTo({ left: dest, behavior: "smooth" });
      }, { capture: true, passive: false });
    },
  });

  defineFeature({
    id: "stack-edge-scroll",
    category: "stacks",
    name: "Auto-scroll while dragging",
    description: "A stack's tabs scroll when you drag something to their edge, like the main tab bar.",
    default: true,
    standalone: ["stacktab-drag-edge-scroll.uc.js"],
    init(ctx) {
      // Speeds measured from the main tab strip; the edge ramp is deliberate.
      const HOT = 32;          // edge zone, px
      const V_MIN = 160;       // px/s at the inner edge of the zone
      const V_MAX = 1800;      // px/s at the edge and beyond

      const findIn = (path, id) => path.find(n => n?.nodeType === 1 && n.id === id);

      let scroller = null;
      let lastScroller = null; // survives stop(), for dragging over the arrows beside it
      let dir = 0;
      let vel = 0;
      let raf = 0;
      let lastT = 0;

      function loop(now) {
        raf = 0;
        if (!scroller || dir === 0) return;
        const dt = lastT ? (now - lastT) / 1000 : 0;
        lastT = now;
        const max = scroller.scrollWidth - scroller.clientWidth;
        scroller.scrollLeft = Math.max(0, Math.min(max, scroller.scrollLeft + dir * vel * dt));
        raf = ctx.frame(loop);
      }

      function stop() {
        scroller = null;
        dir = 0;
        vel = 0;
        lastT = 0;
        if (raf) ctx.cancelFrame(raf);
        raf = 0;
      }

      // No preventDefault: Floorp's own drop logic stays untouched. On
      // windowRoot, so it still sees drags that Stack-aware drag and drop
      // takes over (tabs from another window) and keeps from the window.
      ctx.listen(window.windowRoot, "dragover", (e) => {
        const path = e.composedPath();
        const inScroller = findIn(path, "floorp-stack-scroller");
        const inBar = findIn(path, "floorp-stack-bar");
        const hit = inScroller || (inBar &&
          ((lastScroller?.isConnected && lastScroller) || inBar.querySelector?.("#floorp-stack-scroller")));
        if (!hit) {
          stop();
          return;
        }
        lastScroller = hit;

        const max = hit.scrollWidth - hit.clientWidth;
        if (max <= 0) {
          stop();
          return;
        }
        const rect = hit.getBoundingClientRect();
        const dL = e.clientX - rect.left;
        const dR = rect.right - e.clientX;
        let d = 0;
        let into = 0;
        if (dL < HOT) {
          d = -1;
          into = (HOT - dL) / HOT;
        } else if (dR < HOT) {
          d = 1;
          into = (HOT - dR) / HOT;
        }
        if (d === 0 || (d < 0 && hit.scrollLeft <= 0) || (d > 0 && hit.scrollLeft >= max)) {
          stop();
          return;
        }
        into = Math.max(0, Math.min(1, into));
        scroller = hit;
        dir = d;
        vel = V_MIN + (V_MAX - V_MIN) * into;
        if (!raf) {
          lastT = 0;
          raf = ctx.frame(loop);
        }
      }, true);
      ctx.listen(window.windowRoot, "drop", stop, true);
      ctx.listen(window.windowRoot, "dragend", stop, true);
    },
  });

  defineFeature({
    id: "stack-arrow-hold-scroll",
    parent: "stack-edge-scroll",
    name: "Hold the arrows to scroll",
    description: "Holding down a stack's scroll arrow keeps scrolling, like the main tab bar.",
    default: true,
    standalone: ["stacktab-drag-edge-scroll.uc.js"],
    init(ctx) {
      // Speeds measured from the main tab strip. The arrow's own single step
      // is suppressed; a quick tap reduces to the release glide, which reads
      // as one step.
      const ARROW_SPEED = 600;  // px/s while an arrow is held
      const ARROW_GLIDE = 0.32; // s of ease-out after release (~64px)
      const findIn = (path, id) => path.find(n => n?.nodeType === 1 && n.id === id);

      let aScroller = null;
      let aDir = 0;
      let aRaf = 0;
      let aLastT = 0;
      let aCoast = false;
      let aCoastT0 = 0;

      function aStop() {
        aScroller = null;
        aDir = 0;
        aCoast = false;
        aLastT = 0;
        if (aRaf) ctx.cancelFrame(aRaf);
        aRaf = 0;
      }

      function aLoop(now) {
        aRaf = 0;
        if (!aScroller || aDir === 0) return;
        const dt = aLastT ? (now - aLastT) / 1000 : 0;
        aLastT = now;
        let v = ARROW_SPEED;
        if (aCoast) {
          const p = (now - aCoastT0) / (ARROW_GLIDE * 1000);
          if (p >= 1) {
            aStop();
            return;
          }
          v = ARROW_SPEED * (1 - p) * (1 - p); // quadratic ease-out
        }
        const max = aScroller.scrollWidth - aScroller.clientWidth;
        const next = Math.max(0, Math.min(max, aScroller.scrollLeft + aDir * v * dt));
        aScroller.scrollLeft = next;
        if ((aDir < 0 && next <= 0) || (aDir > 0 && next >= max)) {
          aStop();
          return;
        }
        aRaf = ctx.frame(aLoop);
      }

      ctx.listen(window, "mousedown", (e) => {
        if (e.button !== 0) return;
        const path = e.composedPath();
        const up = findIn(path, "floorp-stack-scroll-up");
        const down = findIn(path, "floorp-stack-scroll-down");
        if (!up && !down) return;
        const bar = findIn(path, "floorp-stack-bar");
        const sc = bar?.querySelector?.("#floorp-stack-scroller") ?? document.getElementById("floorp-stack-scroller");
        if (!sc) return;
        e.preventDefault();
        e.stopPropagation();
        aScroller = sc;
        aDir = up ? -1 : 1;
        aCoast = false;
        aLastT = 0;
        if (!aRaf) aRaf = ctx.frame(aLoop);
      }, true);

      ctx.listen(window, "click", (e) => {
        if (e.button !== 0) return;
        const path = e.composedPath();
        if (findIn(path, "floorp-stack-scroll-up") || findIn(path, "floorp-stack-scroll-down")) {
          e.stopPropagation();
        }
      }, true);

      ctx.listen(window, "mouseup", () => {
        if (!aScroller || aCoast) return;
        aCoast = true;
        aCoastT0 = performance.now();
      }, true);
      ctx.listen(window, "blur", aStop, true);
    },
  });

  defineFeature({
    id: "stack-multiselect",
    category: "stacks",
    name: "Select several stack tabs",
    description: "Ctrl-click and Shift-click select several stack tabs at once. Dragging, the tab menu and anything else that works on selected tabs then applies to all of them.",
    default: true,
    standalone: ["stacktab-multiselect.uc.js"],
    init(ctx) {
      // Uses Firefox's real multiselection, running tab.js's Shift/Accel
      // logic against the real tab. Floorp clears the selection when a drag
      // starts, so it's restored in startTabDrag; Floorp's drop only places
      // the grabbed tab, so the rest are gathered beside it afterwards.
      const BUTTON_SEL = ".floorp-stack-tab-close, .floorp-stack-tab-refresh";
      const MS_ATTR = "uc-multiselected";
      const PROXY_DRAG_END_EVENT = "floorp-stack-proxy-dragend";
      const dnd = ctx.require(gBrowser.tabContainer?.tabDragAndDrop, "the tab drag engine");

      ctx.style(`
        .floorp-stack-tab[${MS_ATTR}] {
          background: var(
            --tab-selected-bgcolor,
            var(--toolbarbutton-active-background, rgba(128, 128, 128, 0.3))
          );
          outline: 1px solid var(--focus-outline-color, AccentColor);
          outline-offset: -1px;
        }
      `);

      const proxyFor = (e) =>
        e.button === 0 && !e.target.closest?.(BUTTON_SEL) ? e.target.closest?.(U.PROXY_SEL) : null;
      const isModified = (e) => e.shiftKey || e.getModifierState("Accel");

      // tab.js on_mousedown's Shift / Accel branches.
      function multiSelect(tab, e) {
        if (e.shiftKey) {
          const last = gBrowser.lastMultiSelectedTab;
          if (!e.getModifierState("Accel")) {
            gBrowser.selectedTab = last;
            gBrowser.clearMultiSelectedTabs();
          }
          gBrowser.addRangeToMultiSelectedTabs(last, tab);
        } else if (tab.multiselected) {
          gBrowser.removeFromMultiSelectedTabs(tab);
        } else if (tab !== gBrowser.selectedTab) {
          gBrowser.addToMultiSelectedTabs(tab);
          gBrowser.lastMultiSelectedTab = tab;
        }
      }

      function syncProxies() {
        for (const proxy of document.querySelectorAll(U.PROXY_SEL)) {
          proxy.toggleAttribute(MS_ATTR, !!U.realTabOf(proxy)?.multiselected);
        }
      }

      // ---- dragging a selection ----
      let drag = null; // { tab, tabs, group, prev, next }
      let finishTimer = 0;
      let lastSelection = [];
      const liveHere = (el) => el.isConnected && !el.closing && el.ownerDocument === document;

      function restoreSelection(tabs) {
        const live = tabs.filter(liveHere);
        if (live.length < 2) return;
        for (const t of live) {
          if (!t.multiselected) gBrowser.addToMultiSelectedTabs(t);
        }
      }

      // Selected tabs (split views whole) line up beside the grabbed one, in
      // their original order.
      function gather(d, anchor) {
        const els = [...new Set(d.tabs.map(t => t.splitview ?? t))]
          .filter(el => liveHere(el) && !el.pinned);
        const i = els.indexOf(anchor);
        if (i < 0) return;
        for (const el of els.slice(0, i)) gBrowser.moveTabBefore(el, anchor);
        let prev = anchor;
        for (const el of els.slice(i + 1)) {
          gBrowser.moveTabAfter(el, prev);
          prev = el;
        }
      }

      function finishDrag() {
        const d = drag;
        drag = null;
        if (!d) return;
        const tab = d.tab;
        if (!liveHere(tab)) { // torn off, or adopted by another window
          restoreSelection(d.tabs);
          return;
        }
        const anchor = tab.splitview ?? tab;
        const moved = tab.group !== d.group ||
          anchor.previousElementSibling !== d.prev ||
          anchor.nextElementSibling !== d.next;
        try {
          if (moved && !tab.pinned) gather(d, anchor);
        } finally {
          restoreSelection(d.tabs);
          gBrowser.lastMultiSelectedTab = tab;
        }
      }

      function beginDrag(tab) {
        drag = null;
        const tabs = lastSelection.filter(liveHere);
        if (tabs.length < 2 || !tabs.includes(tab)) return;
        for (const t of tabs) {
          if (!t.multiselected) gBrowser.addToMultiSelectedTabs(t);
        }
        gBrowser.lastMultiSelectedTab = tab;
        const anchor = tab.splitview ?? tab;
        drag = { tab, tabs, group: tab.group, prev: anchor.previousElementSibling, next: anchor.nextElementSibling };
      }

      // Floorp's drop into another stack runs in a setTimeout(0) queued at
      // drop, which runs before this one.
      function scheduleFinish() {
        if (!drag || finishTimer) return;
        finishTimer = ctx.timeout(() => {
          finishTimer = 0;
          finishDrag();
        }, 30);
      }

      ctx.listen(window, "mousedown", (e) => {
        const proxy = proxyFor(e);
        if (!proxy || !isModified(e)) return;
        const tab = U.realTabOf(proxy);
        if (!tab) return;
        e.preventDefault(); // no focus/drag side effects from the modified press
        multiSelect(tab, e);
      }, true);

      ctx.listen(window, "click", (e) => {
        const proxy = proxyFor(e);
        if (!proxy) return;
        if (isModified(e)) {
          // Floorp's handler would select the tab and drop the selection.
          e.preventDefault();
          e.stopImmediatePropagation();
        } else if (gBrowser.multiSelectedTabsCount > 0) {
          gBrowser.clearMultiSelectedTabs();
        }
      }, true);

      const takeSelection = () => { lastSelection = gBrowser.selectedTabs; };
      ctx.listen(window, "TabMultiSelect", takeSelection);
      ctx.listen(gBrowser.tabContainer, "TabSelect", takeSelection);
      takeSelection();

      // Hooked here rather than on dragstart: a drag from a proxy Floorp just
      // re-rendered away never reaches window listeners. The all-tabs menu
      // also passes fromTabList; it's ruled out by its panel.
      ctx.hook(dnd, "startTabDrag", function (next, event, tab, options, ...rest) {
        if (options?.fromTabList && U.isStack(tab?.group) && !event?.target?.closest?.("panel")) {
          try {
            beginDrag(tab);
          } catch (e) {
            ctx.fail(e, "starting a multi-tab drag");
          }
        }
        return next(event, tab, options, ...rest);
      }, { priority: -10 });
      ctx.listen(window, "dragend", scheduleFinish, true);
      ctx.listen(window, PROXY_DRAG_END_EVENT, scheduleFinish);

      ctx.onCleanup(() => {
        for (const el of document.querySelectorAll(`[${MS_ATTR}]`)) el.removeAttribute(MS_ATTR);
      });
      const schedule = syncProxiesOn(ctx, syncProxies);
      ctx.listen(window, "TabMultiSelect", schedule);
    },
  });

  defineFeature({
    id: "stack-add-to-group-menu",
    category: "stacks",
    name: "Add Tab to Group for stack tabs",
    description: "Stack tabs get the \"Add Tab to Group\" menu item, to move a tab straight into another stack or group. A new group made from a stack tab appears right after its stack.",
    default: true,
    standalone: ["stacktab-move-to-group-menu.uc.js"],
    init(ctx) {
      // Floorp hides #context_moveTabToGroup for stack tabs from a document
      // listener. Firefox's decision is recorded on the popup (after
      // Firefox's own listener) and put back on the window (after Floorp's),
      // so Firefox's own rules for the item still apply.
      const ITEM_ID = "context_moveTabToGroup";
      const popup = ctx.require(document.getElementById("tabContextMenu"), "#tabContextMenu");

      let firefoxShowed = false;
      ctx.listen(popup, "popupshowing", (e) => {
        if (e.target !== popup) return; // submenus bubbling up
        firefoxShowed = !document.getElementById(ITEM_ID)?.hidden;
      });
      ctx.listen(window, "popupshowing", (e) => {
        if (e.target !== popup || !firefoxShowed) return;
        if (!popup.triggerNode?.closest?.(U.PROXY_SEL)) return;
        const item = document.getElementById(ITEM_ID);
        if (item?.hidden) item.hidden = false;
      });

      // "New Group" goes just after the source stack/group instead of before
      // it: while the command runs, addTabGroup's insertBefore is pointed at
      // whatever follows the group.
      let placeAfter = null;
      function elementAfter(group) {
        for (let n = group.nextElementSibling; n; n = n.nextElementSibling) {
          if (gBrowser.isTab?.(n) || gBrowser.isTabGroup?.(n) || gBrowser.isSplitViewWrapper?.(n)) return n;
        }
        return null;
      }
      const placing = ctx.optional(() => {
        ctx.hook(gBrowser, "addTabGroup", function (next, tabs, opts = {}, ...rest) {
          if (!placeAfter) return next(tabs, opts, ...rest);
          return next(tabs, { ...opts, insertBefore: elementAfter(placeAfter) }, ...rest);
        });
        return true;
      }, "New groups will appear before the stack instead of after it");
      if (!placing) return;
      for (const name of ["moveTabsToNewGroup", "moveSplitViewToNewGroup"]) {
        ctx.optional(() => ctx.hook(window.TabContextMenu, name, function (next, ...args) {
          const group = this.contextTab?.group;
          if (!group) return next(...args);
          placeAfter = group;
          try {
            return next(...args);
          } finally {
            placeAfter = null;
          }
        }));
      }
    },
  });

  defineFeature({
    id: "stack-hover-preview",
    category: "stacks",
    name: "Hover previews",
    description: "Hovering a stack tab shows the tab preview card, like normal tabs, and hovering a stack shows just its name.",
    default: true,
    standalone: ["stacktab-hover-preview.uc.js"],
    init(ctx) {
      // Hovering a proxy activates the real tab's preview (the same call
      // tabs.js makes on TabHoverStart). A stack's real tabs have no width,
      // so the card is anchored to the proxy instead.
      const PROXY_BUTTONS = ".floorp-stack-tab-close, .floorp-stack-tab-refresh";
      const tabs = gBrowser.tabContainer;
      ctx.require(typeof tabs?.ensureTabPreviewPanelLoaded === "function",
        "Firefox's tab preview panel (ensureTabPreviewPanelLoaded) is missing");

      let previewTab = null; // real tab whose card is anchored to its proxy
      const hookedPanels = new WeakSet();

      function loadTabPanel() {
        tabs.ensureTabPreviewPanelLoaded();
        const panelSet = tabs.previewPanel;
        const panel = panelSet?.tabPanel?.panelElement;
        if (!panel) throw new Unavailable("the tab preview panel has changed");
        if (!hookedPanels.has(panel)) {
          hookedPanels.add(panel);
          const anchorFor = (anchor) => (anchor && anchor === previewTab && U.proxyOf(anchor)) || anchor;
          ctx.hook(panel, "openPopup", function (next, anchor, ...rest) {
            return next(anchorFor(anchor), ...rest);
          });
          ctx.hook(panel, "moveToAnchor", function (next, anchor, ...rest) {
            return next(anchorFor(anchor), ...rest);
          });
          ctx.listen(panel, "popuphidden", (e) => {
            if (e.target === panel) previewTab = null;
          });
        }
        return panelSet;
      }

      // Only on entering or leaving the proxy itself, as tab.js does.
      ctx.listen(window, "mouseover", (e) => {
        const proxy = e.target.closest?.(U.PROXY_SEL);
        if (!proxy || proxy.contains(e.relatedTarget)) return;
        if (!tabs._showTabHoverPreview) return;
        const tab = U.realTabOf(proxy);
        if (!tab || tab.closing) return;
        const panelSet = loadTabPanel();
        previewTab = tab;
        panelSet.activate(tab);
      });
      ctx.listen(window, "mouseout", (e) => {
        const proxy = e.target.closest?.(U.PROXY_SEL);
        if (!proxy || proxy.contains(e.relatedTarget)) return;
        const tab = U.realTabOf(proxy);
        if (tab) tabs.previewPanel?.deactivate(tab);
      });
      // Pressing a stack tab closes its card, as clicking a tab does.
      ctx.listen(window.windowRoot, "mousedown", (e) => {
        if (e.target?.closest?.(".tab-audio-button")) return;
        const proxy = e.target?.closest?.(U.PROXY_SEL);
        if (proxy) tabs.previewPanel?.deactivate(U.realTabOf(proxy), { force: true });
      }, true);

      // The plain title tooltip is suppressed while previews are on. A
      // tooltiptext tooltip's popupshowing arrives retargeted to the root,
      // so the tooltip itself is originalTarget.
      ctx.listen(document, "popupshowing", (e) => {
        const tooltip = e.originalTarget;
        if (tooltip?.localName !== "tooltip") return;
        const node = tooltip.triggerNode ?? document.tooltipNode;
        if (!node?.closest?.(U.PROXY_SEL) || node.closest(PROXY_BUTTONS)) return;
        if (tabs._showTabHoverPreview) e.preventDefault();
      }, true);

      // ---- stack tooltips without " — Expanded" ----
      // tabgroup.js writes "<name> — Expanded" to the group's data-tooltip;
      // on stacks it's rewritten to the name alone.
      const renamed = new WeakSet();
      const groupName = (group) => group.label || group.defaultGroupName || "";

      function firefoxTooltip(group) {
        gBrowser.tabLocalization?.formatValue(
          group.collapsed ? "tab-group-label-tooltip-collapsed" : "tab-group-label-tooltip-expanded",
          { tabGroupName: groupName(group) }
        ).then(text => {
          if (text && (!U.isStack(group) || !ctx.alive)) group.dataset.tooltip = text;
        }, () => {});
      }

      function syncGroupTooltip(group) {
        if (U.isStack(group)) {
          const name = groupName(group);
          if (group.dataset.tooltip !== name) group.dataset.tooltip = name;
          renamed.add(group);
        } else if (renamed.has(group)) {
          renamed.delete(group);
          firefoxTooltip(group);
        }
      }

      ctx.observe(tabs, { subtree: true, attributes: true, attributeFilter: ["data-tooltip", U.STACK_ATTR] }, (records) => {
        const groups = new Set(records.map(r => r.target).filter(t => t.localName === "tab-group"));
        for (const group of groups) syncGroupTooltip(group);
      });
      for (const group of gBrowser.tabGroups) syncGroupTooltip(group);

      ctx.onCleanup(() => {
        for (const group of gBrowser.tabGroups) {
          if (renamed.has(group)) firefoxTooltip(group);
        }
      });
    },
  });

  defineFeature({
    id: "stack-open-animation",
    category: "stacks",
    name: "New tab animation",
    description: "New stack tabs grow open like normal tabs.",
    default: true,
    standalone: ["stacktab-newtab-expand-animation.uc.js"],
    init(ctx) {
      // Only for a real new tab: every previously shown tab id is still there
      // and exactly one is new. A stack switch replaces the ids, even when
      // switching to a stack with one tab.
      const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
      const DURATION = 120; // ms, close to the native width transition
      const STYLE_PROPS = ["transition", "overflow", "minWidth", "maxWidth", "opacity"];
      const animating = new Set();

      const idsOf = (items) => new Set(
        [...items.querySelectorAll(".floorp-stack-tab[data-floorp-drag-id]")]
          .map(el => el.getAttribute("data-floorp-drag-id"))
      );

      function resetStyle(tab) {
        for (const p of STYLE_PROPS) tab.style[p] = "";
        animating.delete(tab);
      }

      function animateIn(tab) {
        if (REDUCED.matches) return;
        const full = tab.getBoundingClientRect().width;
        if (!full) return; // not laid out yet
        animating.add(tab);
        tab.style.transition = "none";
        tab.style.overflow = "hidden";
        tab.style.minWidth = "0";
        tab.style.maxWidth = "0";
        tab.style.opacity = "0";
        void tab.offsetWidth; // commit the collapsed state
        tab.style.transition = `max-width ${DURATION}ms ease-out, opacity ${DURATION}ms ease-out`;
        tab.style.maxWidth = full + "px";
        tab.style.opacity = "1";

        let done = false;
        const cleanup = () => {
          if (done) return;
          done = true;
          tab.removeEventListener("transitionend", onEnd);
          resetStyle(tab);
        };
        const onEnd = (e) => {
          if (e.target === tab && e.propertyName === "max-width") cleanup();
        };
        tab.addEventListener("transitionend", onEnd);
        ctx.timeout(cleanup, DURATION + 200); // in case transitionend doesn't fire
      }

      let knownIds = new Set();
      function sync() {
        const items = document.getElementById("floorp-stack-items");
        if (!items) {
          knownIds = new Set();
          return;
        }
        const current = idsOf(items);
        if (knownIds.size > 0) {
          const newIds = [...current].filter(id => !knownIds.has(id));
          const allPrevKept = [...knownIds].every(id => current.has(id));
          if (newIds.length === 1 && allPrevKept) {
            const tab = items.querySelector(`.floorp-stack-tab[data-floorp-drag-id="${CSS.escape(newIds[0])}"]`);
            if (tab) animateIn(tab);
          }
        }
        knownIds = current;
      }

      ctx.onCleanup(() => {
        for (const tab of [...animating]) resetStyle(tab);
      });
      ctx.watchToolbox(sync);
      sync();
    },
  });

  defineFeature({
    id: "stack-scroll-to-tab",
    category: "stacks",
    name: "Keep the current tab in view",
    description: "When a stack has more tabs than fit, they scroll to keep the tab you're on in view, including new tabs and the tab you land on after closing one, like the main tab bar.",
    default: true,
    init(ctx) {
      // Firefox's rules for the main tab bar (tabs.js), which Floorp's stack
      // bar doesn't follow (it only scrolls after a drop):
      // - _handleTabSelect / #ensureTabIsVisible: the selected tab is scrolled
      //   into view on every TabSelect (smooth), and instantly when the strip
      //   is resized or starts overflowing.
      // - _handleNewTab, once a new tab has finished opening: a selected one is
      //   scrolled into view; a background one (_notifyBackgroundTab) only with
      //   smooth scrolling on and not for session restore's
      //   (skipbackgroundnotify), and only as far as the selected tab stays
      //   visible: both when they fit, otherwise the selected tab at the start.
      // Not copied: hovering a partly hidden selected tab scrolls it into view
      // in Firefox, but Floorp turns that off on the main strip once you've
      // scrolled it yourself, and it would fight scrolling the stack bar.
      const MAX_WAIT_MS = 1500; // for the stack bar to show the tab
      const SETTLE_FRAMES = 2;  // after it has grown open (the + may move)
      const smooth = () => U.prefBool("toolkit.scrollbox.smoothScroll", true);
      let opened = null;   // the latest new tab: { tab, at, settle }
      let selected = null; // the latest selection: { tab, at, settle, instant }

      // The stack bar's view and the proxy's box, when the bar overflows and
      // shows this proxy.
      function geometry(proxy) {
        const items = document.getElementById("floorp-stack-items");
        const scroller = document.getElementById("floorp-stack-scroller");
        if (!items?.contains(proxy) || !scroller || scroller.scrollWidth - scroller.clientWidth <= 1) return null;
        return { items, scroller, view: scroller.getBoundingClientRect(), r: proxy.getBoundingClientRect() };
      }
      const inView = ({ view, r }) => view.left <= r.left && r.right <= view.right;
      const intoView = ({ view, r }) => (r.left < view.left ? r.left - view.left : r.right - view.right);
      function scrollBy(scroller, dx, instant) {
        if (dx) scroller.scrollBy({ left: dx, behavior: instant || !smooth() ? "instant" : "smooth" });
      }

      function ensureVisible(proxy, instant) {
        const g = geometry(proxy);
        if (g && !inView(g)) scrollBy(g.scroller, intoView(g), instant);
      }

      function notifyBackground(proxy) {
        const g = geometry(proxy);
        if (!g || inView(g)) return;
        const { items, scroller, view, r } = g;
        const sel = U.proxyOf(gBrowser.selectedTab);
        const s = items.contains(sel) ? sel.getBoundingClientRect() : null;
        let dx = intoView(g);
        if (s && Math.max(r.right - s.left, s.right - r.left) > view.width) {
          dx = getComputedStyle(scroller).direction === "rtl" ? s.right - view.right : s.left - view.left;
        }
        scrollBy(scroller, dx, false);
      }

      // The proxy once it's shown and has finished growing open; null while
      // waiting; false to give up.
      function readyProxy(p) {
        if (!p.tab.isConnected || p.tab.closing || performance.now() - p.at > MAX_WAIT_MS) return false;
        const proxy = U.proxyOf(p.tab);
        if (!proxy || proxy.getAnimations().some(a => a.playState !== "finished") || p.settle-- > 0) return null;
        return proxy;
      }

      const check = ctx.throttle(() => {
        let waiting = false;
        if (selected) {
          const proxy = readyProxy(selected);
          if (proxy === null) {
            waiting = true;
          } else {
            const { tab, instant } = selected;
            selected = null;
            if (proxy && tab.selected) ensureVisible(proxy, instant);
          }
        }
        if (opened) {
          const proxy = readyProxy(opened);
          if (proxy === null) {
            waiting = true;
          } else {
            const { tab } = opened;
            opened = null;
            if (proxy && tab.selected) ensureVisible(proxy, false);
            else if (proxy && !tab.hasAttribute("skipbackgroundnotify") && smooth()) notifyBackground(proxy);
          }
        }
        if (waiting) check(); // look again next frame
      }, "scrolling the stack bar to a tab");

      function wantSelected(instant, settle = SETTLE_FRAMES) {
        const tab = gBrowser.selectedTab;
        if (!U.stackOf(tab)) return; // not shown in the stack bar
        selected = { tab, at: performance.now(), settle, instant };
        check();
      }

      // The latest new tab wins, as in Firefox. Floorp's + adds the tab to the
      // stack just after opening it, so the stack is checked later.
      ctx.listen(gBrowser.tabContainer, "TabOpen", (e) => {
        if (e.target.pinned) return;
        opened = { tab: e.target, at: performance.now(), settle: SETTLE_FRAMES };
        check();
      });
      // A closed tab's proxy goes away and a switch to another stack rebuilds
      // the bar (with that stack's saved scroll position), hence the settle.
      ctx.listen(gBrowser.tabContainer, "TabSelect", () => wantSelected(false));

      // Resizes of the visible area: the window, or the + moving to the bar's
      // end when the tabs start to overflow. Re-attached when Floorp rebuilds
      // the bar (which also fires it once for the new bar).
      let observed = null;
      const ro = ctx.resizeObserver(() => wantSelected(true, 0));
      ctx.watchToolbox(() => {
        const scroller = document.getElementById("floorp-stack-scroller");
        if (scroller === observed) return;
        if (observed) ro.unobserve(observed);
        if (scroller) ro.observe(scroller);
        observed = scroller;
      });
    },
  });

  // -------------------------------------------------------- Stack Features --

  // A stack chip showing its active tab's favicon (and Firefox's loading
  // throbber while it loads) in place of Floorp's stack glyph. Used by
  // Auto-title stacks (unnamed stacks) and Tab icons on stacks (the rest).
  // Both use the same attributes, so whichever took the icon first keeps the
  // saved glyph and the other can take over without losing it.
  //
  // Floorp's glyph is an <image class="floorp-stack-icon"> whose `src` is set
  // only when it's created; the original is saved in uc-stack-src and put
  // back on release. uc-auto-icon swaps the glyph styling (14px, tinted)
  // for a plain 16px favicon box, lined up with global tabs' favicons.
  // Floorp's hover swap to the close button keeps working, and the throbber
  // gives way to it on hover too.
  const StackIcon = {
    ICON_ATTR: "uc-auto-icon",
    ORIG_SRC_ATTR: "uc-stack-src",
    BUSY_ATTR: "uc-busy",
    THROBBER_CLASS: "uc-stack-throbber",

    CSS: `
      tab-group[data-floorp-stack] .floorp-stack-icon[uc-auto-icon] {
        width: 16px;
        height: 16px;
        padding: 0;
        opacity: 1;
        -moz-context-properties: fill;
      }

      tab-group[data-floorp-stack] .uc-stack-throbber {
        position: absolute;
        inset-inline-start: 6px;
        inset-block-start: 50%;
        transform: translateY(-50%);
        width: 16px;
        height: 16px;
        overflow: hidden;
        pointer-events: none;
      }

      tab-group[data-floorp-stack] .uc-stack-throbber:not([busy]),
      tab-group[data-floorp-stack] .tab-group-label-container:hover .uc-stack-throbber,
      tab-group[data-floorp-stack] .floorp-stack-icon[uc-busy] {
        display: none;
      }

      @media (prefers-reduced-motion: reduce) {
        tab-group[data-floorp-stack] .uc-stack-throbber {
          background-image: url("chrome://global/skin/icons/loading.svg");
          background-position: center;
          background-repeat: no-repeat;
          -moz-context-properties: fill;
          fill: currentColor;
          opacity: 0.4;
        }
        tab-group[data-floorp-stack] .uc-stack-throbber[progress] {
          opacity: 0.8;
        }
      }

      @media (prefers-reduced-motion: no-preference) {
        :root[sessionrestored] tab-group[data-floorp-stack] .uc-stack-throbber[busy]::before {
          content: "";
          position: absolute;
          background-image: url("chrome://browser/skin/tabbrowser/loading.svg");
          background-position: left center;
          background-repeat: no-repeat;
          width: 480px;
          height: 100%;
          animation: uc-stack-throbber 1.05s steps(30) infinite;
          -moz-context-properties: fill;
          fill: currentColor;
          opacity: 0.7;
        }
        :root[sessionrestored] tab-group[data-floorp-stack] .uc-stack-throbber[busy]:-moz-locale-dir(rtl)::before {
          animation-name: uc-stack-throbber-rtl;
        }
        :root[sessionrestored] tab-group[data-floorp-stack] .uc-stack-throbber[progress]::before {
          fill: var(--tab-loading-fill);
          opacity: 1;
        }
        :root[sessionrestored] #TabsToolbar[brighttext] tab-group[data-floorp-stack] .uc-stack-throbber[progress]:not([selected])::before {
          fill: #84c1ff;
        }
      }

      @keyframes uc-stack-throbber {
        0% { transform: translateX(0); }
        100% { transform: translateX(-100%); }
      }
      @keyframes uc-stack-throbber-rtl {
        0% { transform: translateX(0); }
        100% { transform: translateX(100%); }
      }
    `,

    // The stack's header label, which holds the icon.
    labelOf(group) {
      return group.labelElement || group.querySelector(".tab-group-label") || null;
    },

    // "Active tab": the selected tab if it's in the stack, otherwise the one
    // viewed last.
    activeTabOf(group) {
      const tabs = [...(group.tabs || [])].filter(t => !t.closing);
      if (!tabs.length) return null;
      if (tabs.includes(gBrowser.selectedTab)) return gBrowser.selectedTab;
      return U.lastViewed(tabs);
    },

    setIcon(icon, src) {
      if (!icon.hasAttribute(this.ICON_ATTR)) {
        icon.setAttribute(this.ORIG_SRC_ATTR, icon.getAttribute("src") || "");
        icon.setAttribute(this.ICON_ATTR, "true");
      }
      if (icon.getAttribute("src") !== src) icon.setAttribute("src", src);
    },

    restoreIcon(icon) {
      if (!icon?.hasAttribute(this.ICON_ATTR)) return;
      icon.setAttribute("src", icon.getAttribute(this.ORIG_SRC_ATTR));
      icon.removeAttribute(this.ORIG_SRC_ATTR);
      icon.removeAttribute(this.ICON_ATTR);
      icon.removeAttribute(this.BUSY_ATTR);
    },

    // Created on first load, hidden when idle. No tab → removed.
    syncThrobber(label, icon, tab) {
      let throbber = label.querySelector(`:scope > .${this.THROBBER_CLASS}`);
      if (!tab) {
        throbber?.remove();
        return;
      }
      const busy = tab.hasAttribute("busy");
      if (!throbber) {
        if (!busy) return;
        throbber = document.createXULElement("hbox");
        throbber.classList.add(this.THROBBER_CLASS);
        label.appendChild(throbber);
      }
      throbber.toggleAttribute("busy", busy);
      throbber.toggleAttribute("progress", tab.hasAttribute("progress"));
      throbber.toggleAttribute("selected", tab.selected);
      icon?.toggleAttribute(this.BUSY_ATTR, busy);
    },

    // Shows `tab`'s favicon and loading state on the chip, or Floorp's glyph
    // when there's no tab.
    show(label, tab) {
      const icon = label.querySelector(":scope > .floorp-stack-icon");
      if (icon) {
        if (tab) this.setIcon(icon, tab.getAttribute("image") || U.DEFAULT_FAVICON);
        else this.restoreIcon(icon);
      }
      this.syncThrobber(label, icon, icon && tab);
    },

    // Puts Floorp's glyph back.
    clear(label) {
      const icon = label.querySelector(":scope > .floorp-stack-icon");
      this.restoreIcon(icon);
      this.syncThrobber(label, icon, null);
    },

    // Tab and group events after which a chip may need updating.
    EVENTS: [
      "TabSelect", "TabAttrModified", "TabOpen", "TabClose", "TabMove",
      "TabGrouped", "TabUngrouped", "TabGroupCreate", "TabGroupRemoved",
      "TabGroupExpand", "TabGroupCollapse",
    ],

    // The body of a feature that shows favicons on the stack chips `owns`
    // picks (auto-titled ones, or the rest). A chip that leaves its hands is
    // cleared, unless `otherId`, the feature that owns the rest, is running:
    // then the favicon stays and that feature takes the chip over, so the
    // glyph doesn't flash up in between. Both watch uc-auto-title, which is
    // what moves a chip from one to the other.
    run(ctx, owns, otherId) {
      ctx.style(this.CSS);

      const refreshAll = () => {
        for (const group of gBrowser.tabGroups) {
          const label = this.labelOf(group);
          if (!label) continue;
          try {
            if (!U.isStack(group)) {
              // Changed to a plain group: Floorp removed the icon.
              label.querySelector(`:scope > .${this.THROBBER_CLASS}`)?.remove();
            } else if (owns(label)) {
              this.show(label, this.activeTabOf(group));
            } else if (!ctx.isActive(otherId)) {
              this.clear(label);
            }
          } catch (e) {
            ctx.fail(e, "updating a stack icon");
          }
        }
      };

      const schedule = ctx.throttle(refreshAll, "updating stack icons");
      const container = gBrowser.tabContainer;
      for (const type of this.EVENTS) ctx.listen(container, type, schedule);
      // Stacks being built or restored, Floorp re-creating the icon, and
      // Auto-title taking or releasing a chip.
      ctx.observe(container, {
        subtree: true, childList: true,
        attributes: true, attributeFilter: ["label", "data-floorp-title", U.STACK_ATTR, "uc-auto-title"],
      }, schedule);

      ctx.onCleanup(() => {
        for (const group of gBrowser.tabGroups) {
          const label = this.labelOf(group);
          if (label && (owns(label) || !ctx.isActive(otherId))) this.clear(label);
        }
      });
      refreshAll();
    },
  };

  defineFeature({
    id: "stack-auto-title",
    category: "stack-features",
    name: "Auto-title stacks",
    description: "Unnamed stacks show the title of the tab you're using in them, and new stacks skip the naming popup. Naming a stack shows its name again; clearing the name brings the title back.",
    default: false,
    standalone: ["stacktab-auto-title.uc.js"],
    init(ctx) {
      // Display only: the header's visible text and icon change, never the
      // group's `label`, so session restore, the rename panel and Floorp's
      // own data see the real, empty name.
      const FALLBACK_TITLE = "New Stack"; // only if a stack has no tabs
      const OVERRIDE_ATTR = "uc-auto-title";
      const FLOORP_TITLE_ATTR = "data-floorp-title";
      const AUTO_NAME_RE = /^New Stack(?: \d+)?$/; // Floorp's generated names

      const isStack = U.isStack;
      // The `label` attribute holds a zero-width space when the name is empty.
      const nameOf = (group) =>
        (group.label ?? group.getAttribute("label") ?? "").replace(/\u200B/g, "").trim();
      const isUnnamed = (group) => !nameOf(group);
      const labelElementOf = (group) => StackIcon.labelOf(group);
      const seen = new WeakSet(); // stacks checked for a generated name

      // ---- names: keep new stacks nameless ----
      // Floorp gives every stack with an empty label a generated name each
      // time it decorates the strip. That exact write is dropped. Real
      // renames arrive a keystroke at a time, so they never go straight from
      // empty to "New Stack".
      ctx.optional(() => {
        const proto = customElements.get("tab-group")?.prototype;
        const labelGetter = proto && findDescriptor(proto, "label")?.get;
        if (!labelGetter) throw new Unavailable("the tab-group label property is missing");
        ctx.hookSetter(proto, "label", function (next, val) {
          if (isStack(this) && !labelGetter.call(this) && AUTO_NAME_RE.test(val ?? "")) return;
          next(val);
        });
      }, "Floorp may still name new stacks \"New Stack\"");

      // A stack that already has a generated name (from an older session) is
      // cleared once.
      function clearGeneratedName(group) {
        if (seen.has(group)) return;
        seen.add(group);
        if (AUTO_NAME_RE.test(nameOf(group))) group.label = "";
      }

      // ---- no naming popup for new stacks ----
      ctx.optional(() => {
        const proto = customElements.get("tabgroup-menu")?.prototype ??
          Object.getPrototypeOf(gBrowser.tabGroupMenu ?? document.getElementById("tab-group-editor") ?? {});
        ctx.hook(proto, "openCreateModal", function (next, group, ...rest) {
          if (isStack(group)) return undefined;
          // The marker may be set just after creation; decide a tick later.
          ctx.timeout(() => {
            if (!isStack(group)) next(group, ...rest);
          });
          return undefined;
        });
      }, "New stacks will still show the naming popup");

      // ---- the title and icon ----
      // Stack headers render data-floorp-title; plain group labels render
      // their text content.
      function setText(el, text) {
        if (el.hasAttribute(FLOORP_TITLE_ATTR)) {
          if (el.getAttribute(FLOORP_TITLE_ATTR) !== text) el.setAttribute(FLOORP_TITLE_ATTR, text);
        } else if (el.childElementCount === 0 && el.textContent !== text) {
          el.textContent = text;
        }
      }

      // Hands a header this feature overrode back to the real name, and to
      // Floorp's glyph unless Tab icons on named stacks will take it over
      // (it reacts to the attribute going), so the glyph doesn't flash up
      // in between. Headers it didn't override are left alone.
      function release(group, el) {
        if (!el.hasAttribute(OVERRIDE_ATTR)) return;
        el.removeAttribute(OVERRIDE_ATTR);
        setText(el, nameOf(group) || (ctx.alive ? "" : FALLBACK_TITLE));
        if (!ctx.alive) el.setAttribute("tooltiptext", group.dataset.tooltip ?? nameOf(group));
        if (!ctx.isActive("stack-tab-icons")) StackIcon.clear(el);
      }

      function refreshGroup(group) {
        const el = labelElementOf(group);
        clearGeneratedName(group);
        if (!el) return;
        if (!isUnnamed(group)) {
          release(group, el);
          return;
        }
        const tab = StackIcon.activeTabOf(group);
        const title = tab?.label || FALLBACK_TITLE;
        setText(el, title);
        if (el.getAttribute("tooltiptext") !== title) el.setAttribute("tooltiptext", title);
        el.setAttribute(OVERRIDE_ATTR, "true");
      }

      const allStacks = () => document.querySelectorAll("tab-group[data-floorp-stack]");
      function refreshAll() {
        for (const group of allStacks()) {
          try {
            refreshGroup(group);
          } catch (e) {
            ctx.fail(e, "updating a stack title");
          }
        }
      }

      // Bursts (a tab switch fires select + attr-modified + mutations) become
      // one pass per frame. Our own writes re-trigger the observer, but the
      // second pass finds nothing to change.
      const schedule = ctx.throttle(refreshAll, "updating stack titles");
      const container = gBrowser.tabContainer;
      for (const type of StackIcon.EVENTS) ctx.listen(container, type, schedule);
      // Renames, stacks being built or restored, and Floorp re-rendering the
      // header behind our back.
      ctx.observe(container, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["label", FLOORP_TITLE_ATTR],
      }, schedule);

      ctx.onCleanup(() => {
        for (const group of allStacks()) {
          const el = labelElementOf(group);
          if (el) release(group, el);
        }
      });
      refreshAll();
    },
  });

  defineFeature({
    id: "auto-title-icon",
    parent: "stack-auto-title",
    name: "Show the tab's icon",
    description: "Also shows that tab's icon, and its loading animation, in place of the stack symbol.",
    default: true,
    standalone: ["stacktab-auto-title.uc.js"],
    init(ctx) {
      StackIcon.run(ctx, (label) => label.hasAttribute("uc-auto-title"), "stack-tab-icons");
    },
  });

  defineFeature({
    id: "link-opens-stack",
    parent: "stack-auto-title",
    name: "Links from normal tabs make a stack",
    description: "Opening a link in a new tab from a normal tab turns that tab and the new one into a stack, titled after the tab you're using.",
    default: false,
    init(ctx) {
      // Firefox records where a tab came from (tab.openerTab: the tab of
      // openerBrowser for link clicks and pages opening tabs, or the selected
      // tab for "related" opens such as the context menu's Open Link in New
      // Tab) and already puts it in the opener's group. So only an opener
      // outside any group needs a new stack; later links from either tab join
      // it by themselves. Links carry the page's principal; Ctrl+T, bookmarks,
      // duplicates and reopened tabs use the system principal, so they're
      // left out. The stack is unnamed, so Auto-title titles it.
      ctx.hook(gBrowser, "addTab", function (next, uri, opts, ...rest) {
        const tab = next(uri, opts, ...rest);
        const opener = tab?.openerTab;
        const principal = opts?.triggeringPrincipal;
        if (!opener || opener === tab || tab.pinned || tab.group || opts?.fromExternal) return tab;
        if (!principal || principal.isSystemPrincipal) return tab;
        if (opener.pinned || opener.group || opener.splitview || opener.closing) return tab;
        if (opener.ownerDocument !== document || !U.prefBool("floorp.tabstacks.enabled", false)) return tab;
        // After the opening call has finished with the tab.
        ctx.microtask(() => {
          if (!tab.isConnected || tab.closing || tab.group || !opener.isConnected || opener.closing) return;
          if (opener.group) {
            // Another link from the same tab got there first.
            if (U.isStack(opener.group)) U.adoptToGroup(tab, opener.group);
            return;
          }
          gBrowser.addTabGroup([opener, tab], { insertBefore: opener });
        });
        return tab;
      });
    },
  });

  defineFeature({
    id: "single-tab-unstack",
    parent: "stack-auto-title",
    name: "One-tab stacks become normal tabs",
    description: "When an auto-titled stack is down to one tab, the stack goes away and that tab stays in its place as a normal tab.",
    default: false,
    init(ctx) {
      // When a tab closes in or leaves an unnamed stack (TabClose; TabUngrouped
      // for drags out, workspace and window moves) and one tab is left, the
      // stack is ungrouped a tick later, once the other tab is gone.
      // group.ungroupTabs() leaves that tab where the stack was. A stack that
      // starts with one tab stays until it has had more. So does one whose
      // remaining tab was opened in the same go: Keep stacks when their last
      // tab closes adds a new tab just before closing a stack's last one.
      const justOpened = new WeakSet();
      ctx.listen(gBrowser.tabContainer, "TabOpen", (e) => {
        justOpened.add(e.target);
        ctx.timeout(() => justOpened.delete(e.target));
      });
      const autoTitled = (group) => !!group?.querySelector?.(".tab-group-label[uc-auto-title]");

      function leaving(tab, group) {
        if (!U.isStack(group) || !autoTitled(group)) return;
        const rest = group.tabs.filter(t => t !== tab && !t.closing);
        if (rest.length !== 1 || justOpened.has(rest[0])) return;
        const [last] = rest;
        ctx.timeout(() => {
          // Gone (the whole stack moved or closed), refilled, or named since.
          if (!group.isConnected || group.tabs.length !== 1 || group.tabs[0] !== last || !autoTitled(group)) return;
          group.ungroupTabs();
        });
      }
      ctx.listen(gBrowser.tabContainer, "TabClose", (e) => leaving(e.target, e.target.group));
      // Dispatched on the group, with the tab as detail.
      ctx.listen(gBrowser.tabContainer, "TabUngrouped", (e) => leaving(e.detail, e.target));
    },
  });

  defineFeature({
    id: "stack-tab-icons",
    category: "stack-features",
    name: "Tab icons on named stacks",
    description: "Named stacks show the icon of the tab you're using in them, and its loading animation, in place of the stack symbol.",
    default: false,
    init(ctx) {
      // Every chip Auto-title stacks isn't titling (it marks those with
      // uc-auto-title); with Auto-title off, that's every stack.
      StackIcon.run(ctx, (label) => !label.hasAttribute("uc-auto-title"), "auto-title-icon");
    },
  });

  defineFeature({
    id: "close-stack-confirm",
    category: "stack-features",
    name: "Confirm closing stacks",
    description: "Asks before closing a stack or group with more than one tab.",
    default: false,
    standalone: ["stacktab-close-confirm.uc.js"],
    init(ctx) {
      // Every way of closing a group goes through removeTabGroup. Firefox's
      // own warning is used (localized, and its checkbox writes the same
      // pref), with a plain prompt as a fallback.
      const PREF = "browser.tabs.warnOnClose";

      function confirmClose(group) {
        const count = group?.tabs?.length ?? gBrowser.tabs.filter(t => t.group === group).length;
        if (count <= 1) return true;

        if (typeof gBrowser.warnAboutClosingTabs === "function") {
          try {
            return gBrowser.warnAboutClosingTabs(count, gBrowser.closingTabsEnum?.ALL ?? 0);
          } catch (e) {
            ctx.fail(e, "Firefox's close warning");
          }
        }

        if (!U.prefBool(PREF, true)) return true;
        const ps = Services.prompt;
        const check = { value: true };
        const proceed = ps.confirmEx(
          window,
          "Confirm close",
          `You are about to close ${count} tabs. Are you sure you want to continue?`,
          ps.BUTTON_TITLE_IS_STRING * ps.BUTTON_POS_0 + ps.BUTTON_TITLE_CANCEL * ps.BUTTON_POS_1,
          "Close tabs", null, null,
          "Confirm before closing multiple tabs",
          check
        ) === 0;
        if (proceed && !check.value) Services.prefs.setBoolPref(PREF, false);
        return proceed;
      }

      ctx.hook(gBrowser, "removeTabGroup", function (next, group, ...rest) {
        // An error here throws before `next`, so the hook system lets the
        // close go ahead rather than trapping it.
        if (group && !confirmClose(group)) {
          const isAsync = next.constructor?.name === "AsyncFunction" ||
            Hooks.original(gBrowser, "removeTabGroup")?.constructor?.name === "AsyncFunction";
          return isAsync ? Promise.resolve() : undefined;
        }
        return next(group, ...rest);
      });
    },
  });

  defineFeature({
    id: "unload-stack-menu",
    category: "stack-features",
    name: "Unload Stack menu item",
    description: "Adds \"Unload Stack\" and \"Unload Group\" to a stack's or group's menu, to unload all its tabs.",
    default: false,
    standalone: ["stacktab-unload-context-menu-item.uc.js"],
    init(ctx) {
      // Floorp's stack menu (#floorp-stack-kind-menu) opens without a
      // triggerNode, so the stack is found from the last pressed element.
      const ITEM_CLASS = "uc-unload-group-item";
      const isUnloadable = (tab) => tab && !tab.closing && !tab.hasAttribute("pending");

      // discardBrowser took a <browser> on old builds, a <tab> on current ones.
      function discard(tab) {
        try {
          return gBrowser.discardBrowser(tab);
        } catch (e) {
          return gBrowser.discardBrowser(tab.linkedBrowser);
        }
      }

      // Firefox won't unload the selected tab, so it switches away first: to
      // a loaded tab outside, or a new normal tab if there's none.
      function unloadGroup(group) {
        const tabs = [...(group.tabs || [])];
        const active = tabs.find(t => t.selected);
        let n = 0;
        for (const t of tabs) {
          if (!t.selected && isUnloadable(t) && discard(t)) n++;
        }
        if (active && isUnloadable(active)) {
          const other = U.tabOutside(group, { loaded: true }) ?? gBrowser.addTab("about:newtab", {
            tabIndex: gBrowser.tabs.length,
            index: gBrowser.tabs.length, // older Firefox reads index
            triggeringPrincipal: U.systemPrincipal(),
          });
          gBrowser.selectedTab = other;
          if (discard(active)) n++;
        }
        return n;
      }

      let pendingGroup = null;
      let lastPressed = null;
      ctx.listen(window, "mousedown", (e) => { lastPressed = e.target; }, true);

      function ensureItem(popup) {
        let item = popup.getElementsByClassName(ITEM_CLASS)[0];
        if (item) return item;
        item = ctx.track(document.createXULElement("menuitem"));
        item.className = ITEM_CLASS;
        item.addEventListener("command", ctx.guard(() => {
          if (pendingGroup) unloadGroup(pendingGroup);
        }, "unloading a stack"));
        popup.insertBefore(item, popup.firstChild);
        return item;
      }

      ctx.listen(document, "popupshowing", (e) => {
        const popup = e.target;
        // Not submenus (such as "Move Stack to Another Workspace"'s list).
        if (popup?.localName !== "menupopup" || popup.parentNode?.localName === "menu") return;
        const group = U.headerMenuGroup(popup, lastPressed);
        if (!group) return;
        const item = ensureItem(popup);
        item.setAttribute("label", U.isStack(group) ? "Unload Stack" : "Unload Group");
        item.disabled = ![...(group.tabs || [])].some(isUnloadable);
        item.hidden = false;
        pendingGroup = group;
      }, true);
    },
  });

  defineFeature({
    id: "stack-workspace-menu",
    category: "stack-features",
    name: "Move Stack to Another Workspace",
    description: "Adds \"Move Stack to Another Workspace\" and \"Move Group to Another Workspace\" to a stack's or group's menu, to send it with all its tabs to another workspace while you stay where you are.",
    default: false,
    init(ctx) {
      // Floorp's own "Move Tab to Another Workspace" only moves tabs. This
      // moves every tab of the group at once (so "Stacks copied into another
      // workspace" sees the whole group move and leaves it together), then
      // has Floorp re-hide what belongs elsewhere.
      const MENU_CLASS = "uc-workspace-group-menu";
      const LIST_CLASS = "uc-workspace-group-list";
      let pendingGroup = null;
      let lastPressed = null;
      ctx.listen(window, "mousedown", (e) => { lastPressed = e.target; }, true);

      // The workspace a group is in (the one most of its tabs are in).
      function workspaceOfGroup(group, known) {
        return U.mostCommon(group.tabs.map(U.workspaceOf).filter(id => known.has(id)));
      }

      function otherWorkspaces(group) {
        const all = U.workspaces();
        const here = workspaceOfGroup(group, new Set(all.map(w => w.id)));
        return all.filter(w => w.id !== here);
      }

      // Floorp draws workspace icons as data URLs on its workspace buttons;
      // borrowed when they're in the document, otherwise no icon.
      function iconOf(id) {
        const css = document.getElementById(`workspace-${id}`)?.style?.listStyleImage || "";
        return /^url\("?(.*?)"?\)$/.exec(css)?.[1] ?? null;
      }

      function openTabHere() {
        const here = U.workspaces().find(w => w.id === U.currentWorkspace());
        return gBrowser.addTab(window.BROWSER_NEW_TAB_URL ?? "about:newtab", {
          tabIndex: gBrowser.tabs.length,
          index: gBrowser.tabs.length, // older Firefox reads index
          userContextId: here?.userContextId > 0 ? here.userContextId : undefined,
          triggeringPrincipal: U.systemPrincipal(),
        });
      }

      function moveGroup(group, workspaceId) {
        const tabs = [...group.tabs];
        // Firefox can't hide the selected tab: switch to a tab staying here.
        // With "Stay in the stack when closing tabs", the one closing it
        // would pick; otherwise Floorp's choice, the workspace's first tab.
        const selected = gBrowser.selectedTab;
        if (tabs.includes(selected)) {
          const moving = new Set(tabs);
          const pick = ctx.isActive("close-stays-in-stack")
            ? U.closeTarget(selected, moving, { leftFirst: ctx.isActive("close-prefer-left") })
            : gBrowser.visibleTabs.find(t => !moving.has(t) && !t.closing);
          gBrowser.selectedTab = pick ?? openTabHere();
        }
        for (const t of tabs) {
          const was = U.workspaceOf(t);
          t.setAttribute(U.WS_ATTR, workspaceId);
          // "Last tab shown in that workspace" belongs to the old one.
          if (t.getAttribute(U.WS_LAST_SHOWN_ATTR)?.replace(/[{}]/g, "") === was) {
            t.removeAttribute(U.WS_LAST_SHOWN_ATTR);
          }
        }
        U.refreshWorkspace();
      }

      function fillList(list) {
        list.replaceChildren();
        for (const w of pendingGroup ? otherWorkspaces(pendingGroup) : []) {
          const item = document.createXULElement("menuitem");
          item.setAttribute("label", w.name || "Workspace");
          const icon = iconOf(w.id);
          if (icon) {
            item.className = "menuitem-iconic";
            item.setAttribute("image", icon);
          }
          item.addEventListener("command", ctx.guard(() => {
            if (pendingGroup?.isConnected) moveGroup(pendingGroup, w.id);
          }, "moving a stack to another workspace"));
          list.appendChild(item);
        }
      }

      // After Floorp's own items (Reload, New Tab, Manage…), before the first
      // separator.
      function ensureMenu(popup) {
        let menu = popup.getElementsByClassName(MENU_CLASS)[0];
        if (menu) return menu;
        menu = ctx.track(document.createXULElement("menu"));
        menu.className = MENU_CLASS;
        const list = document.createXULElement("menupopup");
        list.className = LIST_CLASS;
        menu.appendChild(list);
        popup.insertBefore(menu, popup.querySelector(":scope > menuseparator"));
        return menu;
      }

      ctx.listen(document, "popupshowing", (e) => {
        const popup = e.target;
        if (popup?.localName !== "menupopup") return;
        if (popup.classList.contains(LIST_CLASS)) {
          fillList(popup);
          return;
        }
        if (popup.parentNode?.localName === "menu") return;
        const group = U.headerMenuGroup(popup, lastPressed);
        if (!group) return;
        const menu = ensureMenu(popup);
        menu.setAttribute("label", U.isStack(group) ? "Move Stack to Another Workspace" : "Move Group to Another Workspace");
        menu.hidden = !U.workspacesOn() || !otherWorkspaces(group).length;
        pendingGroup = group;
      }, true);
    },
  });

  defineFeature({
    id: "keep-stack-on-last-close",
    category: "stack-features",
    name: "Keep stacks when their last tab closes",
    description: "Closing the last tab in a stack leaves a new tab page in it, so the stack stays.",
    default: false,
    standalone: ["stacktab-close-last-becomes-newtab.uc.js"],
    init(ctx) {
      // Just before the last stack tab closes, a new tab joins the stack; the
      // original then closes normally, so Ctrl+Shift+T brings it back into the
      // stack. Closing a whole stack (removeTabGroup / removeTabs) is left
      // alone. Plain groups are left alone.
      let bulk = 0;
      const guardBulk = (name) => ctx.optional(() => ctx.hook(gBrowser, name, function (next, ...args) {
        bulk++;
        try {
          return next(...args);
        } finally {
          bulk--;
        }
      }));
      guardBulk("removeTabGroup");
      guardBulk("removeTabs");
      const inBulkClose = () => bulk > 0 || U.callStackIncludes(/removeTabGroup|removeTabs|removeAllTabs/);

      function isLastInStack(tab, group) {
        const members = group.tabs
          ? [...group.tabs]
          : gBrowser.tabs.filter(t => t.closest?.("tab-group[data-floorp-stack]") === group);
        return members.filter(t => t !== tab && !t.closing).length === 0;
      }

      function placeReplacement(tab, group) {
        const wasSelected = gBrowser.selectedTab === tab;
        const newTab = gBrowser.addTab("about:newtab", { triggeringPrincipal: U.systemPrincipal() });
        if (!newTab) return;
        let joined = null;
        try {
          joined = U.adoptToGroup(newTab, group);
        } finally {
          if (!joined) {
            // Don't leave a stray tab behind; the close goes ahead normally.
            Hooks.original(gBrowser, "removeTab").call(gBrowser, newTab, { animate: false });
            ctx.warn("Couldn't move the new tab into the stack (no API for it).");
          }
        }
        if (joined && wasSelected) {
          gBrowser.selectedTab = newTab; // so closing the tab doesn't flash its page
          ctx.timeout(U.focusUrlbar);
        }
      }

      ctx.hook(gBrowser, "removeTab", function (next, tab, ...rest) {
        if (tab && !tab.pinned && !tab.closing && !inBulkClose()) {
          const group = U.stackOf(tab);
          if (group && isLastInStack(tab, group)) {
            try {
              placeReplacement(tab, group);
            } catch (e) {
              ctx.fail(e, "keeping the stack open");
            }
          }
        }
        return next(tab, ...rest);
      });
    },
  });

  // ------------------------------------------------------------ Appearance --

  defineFeature({
    id: "theme-stack-colors",
    category: "appearance",
    name: "Theme-matched stack colors",
    description: "New stacks start white on dark themes and gray on light ones, and White is added to the colors for stacks and groups.",
    default: false,
    standalone: ["stacktab-auto-title.uc.js"],
    init(ctx) {
      // A group color is just a name that points at --tab-group-<name>-*
      // variables, so White is a set of variables plus a swatch in the editor
      // panel. Floorp draws a stack's border and glyph with the invert color,
      // so white stacks get white there too (stacks never collapse).
      const SWATCH_ID = "tab-group-editor-swatch-white";
      // A soft white with the same cool tint as Firefox's gray. Move toward
      // #ffffff for brighter, or #99a6b4 (Firefox's light gray) for dimmer.
      const WHITE_SHADE = "#d5dbe2";
      const WHITE_SHADE_HOVER = "#c3cad2";
      const WHITE = [0xd5, 0xdb, 0xe2];
      const DARK_GRAY = [0x5e, 0x6a, 0x77]; // Firefox's gray on dark themes
      const AUTO_NAME_RE = /^New Stack(?: \d+)?$/; // Floorp's generated names

      ctx.style(`
        :root {
          --tab-group-white: ${WHITE_SHADE};
          --tab-group-white-hover: ${WHITE_SHADE_HOVER};
          --tab-group-white-invert: #52525e;
          --tab-group-white-pale: light-dark(#15141a, ${WHITE_SHADE});
          --tab-group-white-text: #15141a;
          --tab-group-white-text-invert: #ffffff;
        }
        tab-group[data-floorp-stack][style*="var(--tab-group-white)"] {
          --tab-group-color-invert: var(--tab-group-white) !important;
        }
      `);

      // The editor builds its swatches once from a fixed list, so White is
      // added after Gray whenever it opens. Its own change handler applies
      // whichever tab-group-color radio is picked.
      function addWhiteSwatch(menu) {
        const container = menu.querySelector(".tab-group-editor-swatches");
        if (!container) return null;
        let input = container.querySelector(`#${SWATCH_ID}`);
        if (input) return input;

        input = ctx.track(document.createElementNS(XHTML_NS, "input"));
        input.id = SWATCH_ID;
        input.type = "radio";
        input.name = "tab-group-color";
        input.value = "white";

        const label = ctx.track(document.createElementNS(XHTML_NS, "label"));
        label.classList.add("tab-group-editor-swatch");
        label.htmlFor = SWATCH_ID;
        label.textContent = "White"; // hidden visually; read by screen readers
        label.style.setProperty("--tabgroup-swatch-color", "var(--tab-group-white)");
        label.style.setProperty("--tabgroup-swatch-color-invert", "var(--tab-group-white-invert)");

        const gray = container.querySelector('label[for="tab-group-editor-swatch-gray"]');
        if (gray) gray.after(input, label);
        else container.append(input, label);
        return input;
      }

      ctx.listen(document, "popupshowing", (e) => {
        const menu = e.target.parentNode;
        if (e.target.localName !== "panel" || menu?.localName !== "tabgroup-menu") return;
        const input = addWhiteSwatch(menu);
        if (input) input.checked = menu.activeGroup?.color === "white";
      }, true);

      // ---- color of new stacks ----
      // White or dark gray, whichever is closer to the tab text color, so a
      // new stack matches the theme instead of taking Firefox's next unused
      // color. Only at creation, so a color picked later sticks.
      const rgbOf = (css) => css.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? null;
      const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      // The `label` attribute holds a zero-width space when the name is empty.
      const nameOf = (group) =>
        (group.label ?? group.getAttribute("label") ?? "").replace(/\u200B/g, "").trim();

      function themeColorFor(group) {
        const label = group.labelElement || group.querySelector(".tab-group-label");
        const text = rgbOf(getComputedStyle(label || gBrowser.tabContainer).color);
        if (!text) return "gray";
        return distance(text, WHITE) < distance(text, DARK_GRAY) ? "white" : "gray";
      }

      // New groups don't pass an id (restores and moves between windows do),
      // and one created with a name was named on purpose. The stack marker and
      // Floorp's generated name can land just after creation, hence the tick.
      ctx.optional(() => ctx.hook(gBrowser, "addTabGroup", function (next, tabs, opts = {}, ...rest) {
        const group = next(tabs, opts, ...rest);
        if (group && !opts?.id && !opts?.label) {
          ctx.timeout(() => {
            const name = nameOf(group);
            if (group.isConnected && U.isStack(group) && (!name || AUTO_NAME_RE.test(name))) {
              group.color = themeColorFor(group);
            }
          });
        }
        return group;
      }), "New stacks will get a random color");
    },
  });

  defineFeature({
    id: "stacks-look-like-tabs",
    category: "appearance",
    name: "Stacks look like normal tabs (Experimental)",
    description: "Stacks look exactly like normal tabs in whatever theme and design you use: the same shape, spacing, text, icon and close button, and the same hover and selected colors. Only their colored outline and tab count set them apart.",
    default: false,
    init(ctx) {
      // Themes style tabs through selectors on .tabbrowser-tab and its parts,
      // which a stack chip (a tab-group label) never matches, and Floorp
      // gives the chip its own look. So the chip copies a real tab: the
      // computed styles of an unselected tab (hover forced off, then on, with
      // InspectorUtils' pseudo-class locks, as the devtools do) and of the
      // selected tab, read again whenever the theme, design, color scheme or
      // density may have changed. A stack's tabs are squashed by Floorp only
      // on the <tab> itself, so the selected tab's inner parts read true even
      // inside a stack; sizes and positions come from a visible normal tab.
      // The stack's colored outline is drawn as an inset outline, so it adds
      // nothing to the box.
      const IU = ctx.require(window.InspectorUtils?.addPseudoClassLock && window.InspectorUtils, "InspectorUtils");
      const STACK = `#tabbrowser-tabs tab-group[${U.STACK_ATTR}]`;
      const ROOT_ATTR = "uc-tablike";
      const WHOLE_OUTLINE = "stack-whole-outline"; // sub-setting: end the chip where the tab bar clips
      const TAB_EDGE = "stack-tab-highlight"; // sub-setting: the open stack takes the selected tab's colored edge
      const sheet = ctx.track(document.createElementNS(XHTML_NS, "style"));
      sheet.id = "uc-tablike-style";
      document.head.appendChild(sheet);
      ctx.onCleanup(() => document.documentElement.removeAttribute(ROOT_ATTR));

      const px = (v) => parseFloat(v) || 0;
      const partsOf = (tab) => ({
        tab,
        bg: tab.querySelector(".tab-background"),
        content: tab.querySelector(".tab-content"),
        icon: tab.querySelector(".tab-icon-image"),
        label: tab.querySelector(".tab-label"),
        close: tab.querySelector(".tab-close-button"),
      });
      const complete = (p) => p.bg && p.content && p.icon && p.label && p.close;

      // Reads `fn` with :hover forced on or off on `lockOn`, and transitions
      // off on the tab's parts: tab backgrounds fade, and a computed style
      // read mid-fade (right after a tab switch, or right after the lock) is
      // still the old color. Styles are flushed with the lock gone before the
      // transitions come back, so the real tab doesn't fade out of the state.
      // A selected tab standing in for the normal look (see read), read with
      // its selected state taken off.
      let standIn = null;

      // Floorp squashes a stack's tabs to nothing with one rule in its
      // stylesheet. With no normal tab in view at all, a stack's tab is read
      // instead: the rule is told to leave tabs with PROBE_ATTR alone, and
      // readTab sets that attribute only while it reads, so for that moment
      // the tab is laid out like a normal tab (it never paints that way).
      // The rule is put back when the feature stops.
      const PROBE_ATTR = "uc-tablike-probe";
      let probing = new Set();
      const squashed = new Map(); // Floorp's rule -> its own selector
      ctx.onCleanup(() => {
        for (const [rule, selector] of squashed) {
          try { rule.selectorText = selector; } catch {}
        }
      });
      function canProbe() {
        for (const [rule] of squashed) {
          if (rule.parentStyleSheet?.ownerNode?.isConnected && rule.selectorText.includes(PROBE_ATTR)) return true;
          squashed.delete(rule); // Floorp rebuilt its stylesheet
        }
        for (const style of document.querySelectorAll("style")) {
          let rules;
          try { rules = style.sheet?.cssRules; } catch { continue; }
          for (const rule of rules ?? []) {
            if (!rule.selectorText?.includes(`tab-group[${U.STACK_ATTR}] > :is(.tabbrowser-tab`) || rule.style?.visibility !== "collapse") continue;
            const selector = rule.selectorText;
            rule.selectorText = `${selector}:not([${PROBE_ATTR}])`;
            if (!rule.selectorText.includes(PROBE_ATTR)) return false;
            squashed.set(rule, selector);
            return true;
          }
        }
        return false;
      }

      // While probed, a tab is as wide as its stack's chip (what the look is
      // for) and takes no room: a negative end margin of the same width keeps
      // the tab bar's contents as wide as before (laid out in the flow, it made
      // a full tab bar overflow and underflow, which can blink its arrows).
      const PROBE_SIZE = ["flex", "width", "min-width", "max-width", "margin-inline-start", "margin-inline-end"];
      function sizeProbe(tab) {
        const chip = U.stackOf(tab)?.querySelector(".tab-group-label-container");
        const w = Math.round(chip?.getBoundingClientRect().width || 0) || 200;
        const saved = PROBE_SIZE.map(n => [n, tab.style.getPropertyValue(n), tab.style.getPropertyPriority(n)]);
        const set = { flex: "none", width: `${w}px`, "min-width": `${w}px`, "max-width": `${w}px`, "margin-inline-start": "0px", "margin-inline-end": `-${w}px` };
        for (const n of PROBE_SIZE) tab.style.setProperty(n, set[n], "important");
        return () => {
          for (const [n, v, prio] of saved) {
            if (v) tab.style.setProperty(n, v, prio);
            else tab.style.removeProperty(n);
          }
        };
      }

      function readTab(p, lockOn, hover, fn) {
        const probe = probing.has(p.tab) && canProbe();
        // A probed tab's own size transitions too (Firefox's tab width).
        const els = probe ? [p.tab, p.bg, p.content, p.icon, p.label, p.close] : [p.bg, p.content, p.icon, p.label, p.close];
        const saved = els.map(el => el.style.getPropertyValue("transition"));
        for (const el of els) el.style.setProperty("transition", "none", "important");
        // Taken off and put back within this call, so it never paints.
        const unsize = probe ? sizeProbe(p.tab) : null;
        if (probe) p.tab.setAttribute(PROBE_ATTR, "");
        const stripped = p.tab === standIn
          ? ["selected", "visuallyselected"].filter(a => p.tab.hasAttribute(a)).map(a => [a, p.tab.getAttribute(a)])
          : [];
        for (const [a] of stripped) p.tab.removeAttribute(a);
        IU.addPseudoClassLock(lockOn, ":hover", hover);
        try {
          return fn();
        } finally {
          IU.removePseudoClassLock(lockOn, ":hover");
          for (const [a, v] of stripped) p.tab.setAttribute(a, v);
          if (probe) p.tab.removeAttribute(PROBE_ATTR);
          unsize?.();
          for (const el of els) getComputedStyle(el).backgroundColor; // flush without transitions
          els.forEach((el, i) => {
            if (saved[i]) el.style.setProperty("transition", saved[i]);
            else el.style.removeProperty("transition");
          });
        }
      }

      // The state-dependent look of a tab.
      function lookOf(p) {
        // The background's box inside the tab. Themes may size it with auto
        // margins and percentages (Fluerial's hover pill), which computed
        // margins don't show, so it's measured; a stack's squashed tabs have
        // no layout and fall back to the margins (stateBox).
        const t = p.tab.getBoundingClientRect();
        const r = p.bg.getBoundingClientRect();
        const rtl = getComputedStyle(p.tab).direction === "rtl";
        const laidOut = t.width > 0 && r.width > 0;
        const box = laidOut
          ? { top: r.top - t.top, bottom: t.bottom - r.bottom, start: rtl ? t.right - r.right : r.left - t.left, end: rtl ? r.left - t.left : t.right - r.right }
          : null;
        // Where the content row's middle sits in the tab (a theme may move it
        // for a state: Fluerial's selected tab sits lower).
        const c = p.content.getBoundingClientRect();
        const contentMid = laidOut ? (c.top + c.bottom) / 2 - t.top : null;
        const bg = getComputedStyle(p.bg);
        const label = getComputedStyle(p.label);
        const close = getComputedStyle(p.close);
        const icon = getComputedStyle(p.icon);
        // Themes hide a close button by removing it, hiding it or fading it
        // out (Lepton and Photon hide unhovered ones in a crowded tab bar with
        // visibility and opacity). A stack's tabs are visibility: collapse,
        // which their parts inherit, so visibility only counts on a tab that
        // is itself visible.
        const tabVisible = getComputedStyle(p.tab).visibility === "visible";
        const closeShown = close.display !== "none" && parseFloat(close.opacity) > 0 &&
          (close.visibility === "visible" || !tabVisible);
        const side = (s) => `${bg[`border${s}Width`]} ${bg[`border${s}Style`]} ${bg[`border${s}Color`]}`;
        return {
          bgColor: bg.backgroundColor,
          bgImage: bg.backgroundImage,
          // Where each image layer goes: image themes (dark stars, Tokyo Night)
          // give a selected tab several layers, with a line along the top
          // (repeated across) and the theme's picture pinned to the window.
          bgLayout: [
            ["background-position-x", bg.backgroundPositionX], ["background-position-y", bg.backgroundPositionY],
            ["background-size", bg.backgroundSize], ["background-repeat", bg.backgroundRepeat],
            ["background-attachment", bg.backgroundAttachment], ["background-origin", bg.backgroundOrigin],
            ["background-clip", bg.backgroundClip], ["background-blend-mode", bg.backgroundBlendMode],
          ],
          // The theme's colored edge, if any (stack-tab-highlight). An outline
          // the content layer covers isn't seen: Fluerial gives a selected
          // tab's content the same background, on top of the outline.
          filter: bg.filter,
          edgeOutline: coveredByContent(p, laidOut ? r : null) ? null
            : { style: bg.outlineStyle, width: bg.outlineWidth, color: bg.outlineColor, offset: bg.outlineOffset },
          shadow: bg.boxShadow,
          border: { top: side("Top"), right: side("Right"), bottom: side("Bottom"), left: side("Left") },
          borderWidth: { top: px(bg.borderTopWidth), right: px(bg.borderRightWidth), bottom: px(bg.borderBottomWidth), left: px(bg.borderLeftWidth) },
          radius: [bg.borderTopLeftRadius, bg.borderTopRightRadius, bg.borderBottomRightRadius, bg.borderBottomLeftRadius].join(" "),
          box,
          contentMid,
          mt: px(bg.marginTop), mb: px(bg.marginBottom), ms: px(bg.marginInlineStart), me: px(bg.marginInlineEnd),
          bgOpacity: bg.opacity,
          color: label.color,
          textOpacity: label.opacity,
          textShadow: label.textShadow,
          fontWeight: label.fontWeight,
          closeShown,
          closeOpacity: close.opacity,
          closeFillOpacity: close.fillOpacity,
          iconOpacity: icon.opacity,
        };
      }

      // Sizes and positions, measured on a normal tab with hover forced off:
      // themes may reshape the background on hover (Fluerial shrinks it to a
      // pill), and that's a state of the background, not the tab's layout.
      // Positions are taken from the background's outer box, which is the
      // chip label's box (the label draws no border of its own).
      function layoutOf(p) {
        const rtl = getComputedStyle(p.tab).direction === "rtl";
        const b = p.bg.getBoundingClientRect();
        const edges = { rtl, left: b.left, right: b.right };
        const ts = getComputedStyle(p.tab);
        const cs = getComputedStyle(p.content);
        const ls = getComputedStyle(p.label);
        // Where the content row sits in the background (Lepton puts it a
        // little above the middle); the chip's content moves the same way.
        const cr = p.content.getBoundingClientRect();
        // How far the background runs past the edge that clips the tab bar
        // (Lepton's do, by 4px, so a box there loses its bottom edge).
        let clipBottom = Infinity;
        for (let el = p.tab.parentElement; el && el !== document.documentElement; el = el.parentElement) {
          const es = getComputedStyle(el);
          if (es.overflowY !== "visible") clipBottom = Math.min(clipBottom, el.getBoundingClientRect().bottom - px(es.borderBottomWidth));
        }
        return {
          edges,
          clipOverlap: Number.isFinite(clipBottom) ? Math.max(0, b.bottom - clipBottom) : 0,
          bgHeight: b.height,
          contentShift: (cr.top + cr.bottom) / 2 - (b.top + b.bottom) / 2,
          tabPadStart: ts.paddingInlineStart, tabPadEnd: ts.paddingInlineEnd,
          // From the background's end to where the content stops.
          padEnd: (rtl ? cr.left - b.left : b.right - cr.right) + px(cs.paddingInlineEnd),
          font: { family: ls.fontFamily, size: ls.fontSize, style: ls.fontStyle, spacing: ls.letterSpacing },
        };
      }

      // The icon, on a tab that shows one; without one, its computed size and
      // margins stand in.
      function iconOf(ip, rtl) {
        const b = ip.bg.getBoundingClientRect();
        const icon = ip.icon.getBoundingClientRect();
        const label = ip.label.getBoundingClientRect();
        return {
          padStart: rtl ? b.right - icon.right : icon.left - b.left,
          iconW: icon.width, iconH: icon.height,
          iconGap: rtl ? icon.left - label.right : label.left - icon.right,
        };
      }
      function iconFallback(p) {
        const cs = getComputedStyle(p.content);
        const is = getComputedStyle(p.icon);
        const stack = p.icon.closest(".tab-icon-stack");
        const ss = stack ? getComputedStyle(stack) : is;
        return {
          padStart: px(cs.paddingInlineStart) + px(ss.marginInlineStart),
          iconW: px(is.width) || 16, iconH: px(is.height) || 16,
          iconGap: px(ss.marginInlineEnd) || px(is.marginInlineEnd),
        };
      }

      // The close button, with hover forced on so it shows where it would,
      // placed against the normal background box (the tab doesn't move; its
      // background may).
      function closeOf(p, edges, padEnd) {
        const cs = getComputedStyle(p.close);
        if (cs.display === "none") return {};
        const c = p.close.getBoundingClientRect();
        // The label box reaches up to the close button; the text inside it may be shorter.
        const lc = (p.label.closest(".tab-label-container") ?? p.label).getBoundingClientRect();
        const toEnd = (r) => (edges.rtl ? r.left - edges.left : edges.right - r.right);
        return {
          closeW: c.width, closeH: c.height, closeEnd: toEnd(c),
          closePad: cs.padding, closeRadius: cs.borderRadius,
          // How far the count has to stay in to clear it, as the tab's label does.
          closeRoom: Math.max(0, toEnd(lc) - padEnd),
        };
      }

      // Whether a normal tab shows its close button, unhovered and hovered.
      // Some themes (Lepton, Photon, Protonfix) bring an unselected tab's close
      // button back on hover, in a crowded tab bar, with a selector that needs
      // the tab directly in the tab strip, which a stack's tab never is; so a
      // probed tab can't tell (nor measure the button). What normal tabs
      // showed, and the button's size, is remembered per theme and
      // close-button mode (kept in a pref, for a start with only stacks) and
      // used when a stack's tab had to be read. Returns the close button to use.
      const CLOSE_MEMO_PREF = "uc.floorp-improvements-cache.tablike-close";
      function rememberClose(probed, normal, hover, close) {
        const key = `${themeKey}|${gBrowser.tabContainer.getAttribute("closebuttons") ?? ""}`;
        let memo = {};
        try { memo = JSON.parse(Services.prefs.getStringPref(CLOSE_MEMO_PREF, "{}")) || {}; } catch {}
        const pick = (l) => ({ closeShown: l.closeShown, closeOpacity: l.closeOpacity, closeFillOpacity: l.closeFillOpacity });
        if (probed) {
          if (!memo[key]) return close;
          Object.assign(normal, memo[key].normal);
          Object.assign(hover, memo[key].hover);
          return memo[key].close ?? close; // a normal tab's beats the selected stack tab's
        }
        const value = { normal: pick(normal), hover: pick(hover), close: close.closeW ? close : memo[key]?.close };
        if (JSON.stringify(memo[key]) === JSON.stringify(value)) return close;
        delete memo[key];
        memo[key] = value;
        const keys = Object.keys(memo);
        for (const old of keys.slice(0, Math.max(0, keys.length - 12))) delete memo[old];
        try { Services.prefs.setStringPref(CLOSE_MEMO_PREF, JSON.stringify(memo)); } catch {}
        return close;
      }

      let geometry = null;
      let looks = null;
      let selectedLayout = null; // { box, contentMid } of a laid-out selected tab
      let closeCache = null; // the last close button measured
      let themeKey = ""; // the current theme's normal-tab layout (see read)

      // Without a measured close button: its computed size and margins, at the
      // end of the content.
      function closeFallback(p, layout) {
        const cs = getComputedStyle(p.close);
        const pad = cs.boxSizing === "border-box" ? [0, 0] : [px(cs.paddingLeft) + px(cs.paddingRight), px(cs.paddingTop) + px(cs.paddingBottom)];
        const w = px(cs.width) + pad[0];
        const h = px(cs.height) + pad[1];
        if (!w) return {};
        return {
          closeW: w, closeH: h, closeEnd: layout.padEnd + px(cs.marginInlineEnd),
          closePad: cs.padding, closeRadius: cs.borderRadius,
          closeRoom: w + px(cs.marginInlineStart) + px(cs.marginInlineEnd),
        };
      }

      function read() {
        const visible = (t) => !t.hidden && !t.closing && !t.pinned && !U.stackOf(t) && t.getBoundingClientRect().width > 0;
        const hasIcon = (t) => (t.querySelector(".tab-icon-image")?.getBoundingClientRect().width ?? 0) > 0;
        // Firefox moves `visuallyselected` (which themes style) only once the
        // new tab has painted, a moment after the switch; until then the old
        // tab still looks selected and the new one doesn't.
        const looksSelected = (t) => t.hasAttribute("visuallyselected");
        // A tab that's opening (or making room for one) is still changing
        // size: a new tab starts as a sliver until Firefox gives it "fadein",
        // then grows, and a sliver measures as nonsense.
        const settling = (t) => !t.hasAttribute("fadein") ||
          t.getAnimations().some(a => a instanceof CSSTransition && a.playState === "running");
        const all = gBrowser.tabs.filter(t => !t.selected && !t.multiselected && !looksSelected(t) && visible(t));
        const steady = all.filter(t => !settling(t));
        const normals = steady.length ? steady : all;
        const selectedTab = gBrowser.selectedTab;
        // With no other normal tab in view (e.g. the selected tab is the only
        // one in this workspace besides stacks), the selected tab stands in,
        // read as if it weren't selected.
        standIn = normals.length ? null
          : selectedTab && !selectedTab.multiselected && visible(selectedTab) ? selectedTab : null;
        // With every tab in a stack, one of the stacks' tabs is probed (see
        // canProbe): an unselected one, preferably with an icon, or else the
        // selected one, read as if it weren't selected.
        let probe = null;
        if (!normals.length && !standIn) {
          const members = gBrowser.tabs.filter(t => !t.hidden && !t.closing && !t.pinned && U.stackOf(t) &&
            U.stackOf(t).style.display !== "none" && complete(partsOf(t)));
          const unselected = members.filter(t => !t.selected && !t.multiselected && !looksSelected(t));
          probe = unselected.find(t => t.hasAttribute("image")) ?? unselected[0] ??
            (members.includes(selectedTab) && !selectedTab.multiselected ? selectedTab : null);
          if (probe === selectedTab) standIn = selectedTab;
        }
        // The selected tab is probed for its own look when it's a stack's.
        probing = new Set([probe, U.stackOf(selectedTab) ? selectedTab : null].filter(Boolean));
        let normalTab = normals.find(hasIcon) ?? normals[0] ?? standIn ?? probe;
        // A tab that's still opening isn't read (its sizes are a sliver's):
        // the look stays as it was and is read again once it has settled.
        // Reading it anyway made the stacks' text jump for a moment whenever
        // the first normal tab opened.
        if (normalTab && settling(normalTab)) {
          ctx.timeout(refresh, 250);
          normalTab = null;
        }
        if (normalTab) {
          const p = partsOf(normalTab);
          if (complete(p)) {
            const transition = getComputedStyle(p.bg).transition;
            const [normal, layout, tabTop] = readTab(p, p.tab, false, () => [lookOf(p), layoutOf(p), p.tab.getBoundingClientRect().top]);
            // What remembered measurements belong to: the normal tab's layout,
            // which a design or theme switch changes. A selected layout or
            // close button from Fluerial must not be used under Photon.
            themeKey = JSON.stringify([layout.bgHeight, layout.contentShift, normal.box, layout.font.size, layout.font.family],
              (k, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v));
            const iconTab = (probe === normalTab && probe.hasAttribute("image") ? probe : null) ??
              [normalTab, ...normals, selectedTab].find(t => t && visible(t) && hasIcon(t)) ?? null;
            const ip = iconTab && partsOf(iconTab);
            const icon = ip && complete(ip)
              ? readTab(ip, ip.tab, false, () => iconOf(ip, layout.edges.rtl))
              : iconFallback(p);
            let [hover, close] = readTab(p, p.tab, true, () => [lookOf(p), closeOf(p, layout.edges, layout.padEnd)]);
            // Narrow tabs show a close button only on the selected tab, even on
            // hover (Firefox's closebuttons="activetab"): measure it there if
            // that's a normal tab (the stand-in too, as itself), placed against
            // the normal box.
            if (!close.closeW && (selectedTab !== normalTab || standIn) && (visible(selectedTab) || probing.has(selectedTab)) &&
                looksSelected(selectedTab) && !settling(selectedTab)) {
              const sp2 = partsOf(selectedTab);
              if (complete(sp2)) {
                const nb = normal.box;
                const rtl = layout.edges.rtl;
                const was = standIn;
                standIn = null;
                try {
                  close = readTab(sp2, sp2.tab, false, () => {
                    const t = selectedTab.getBoundingClientRect();
                    const edges = { rtl, left: t.left + (rtl ? nb.end : nb.start), right: t.right - (rtl ? nb.start : nb.end) };
                    return closeOf(sp2, edges, layout.padEnd);
                  });
                } finally {
                  standIn = was;
                }
              }
            }
            close = rememberClose(normalTab === probe, normal, hover, close);
            if (close.closeW) closeCache = { ...close, themeKey };
            else close = (closeCache?.themeKey === themeKey ? closeCache : null) ?? closeFallback(p, layout);
            const closeHoverBg = readTab(p, p.close, true, () => getComputedStyle(p.close).backgroundColor);
            // The chip container's top against the tab's (both are tab strip
            // items, but a theme may pad tabs).
            const chip = document.querySelector(`${STACK} > .tab-group-label-container`);
            const containerShift = chip ? chip.getBoundingClientRect().top - tabTop : 0;
            geometry = { ...layout, ...icon, ...close, closeHoverBg, transition, containerShift };
            looks = { ...(looks || {}), normal, hover };
          }
        }
        standIn = null; // the selected look is read as it is
        const sp = selectedTab && partsOf(selectedTab);
        if (sp && complete(sp) && looks) {
          if (settling(selectedTab)) {
            ctx.timeout(refresh, 250); // the selected look stays until it has settled
          } else if (looksSelected(selectedTab)) {
            const sel = readTab(sp, sp.tab, false, () => lookOf(sp));
            if (sel.box) selectedLayout = { box: sel.box, contentMid: sel.contentMid, themeKey };
            else if (selectedLayout?.themeKey === themeKey) Object.assign(sel, { box: selectedLayout.box, contentMid: selectedLayout.contentMid });
            looks.selected = sel;
          } else {
            ctx.timeout(refresh, 150); // not painted as selected yet
          }
        }
      }

      // Like a tab, the chip has a background layer and a content layer. The
      // label wrapper (.tab-group-label-hover-highlight) is the background:
      // each state's box (margins, height, corners), border, color and
      // shadow, and the stack's outline, so the outline hugs the shape the
      // theme gives a tab (normal or selected). On hover the outline stays on
      // the normal box, drawn by the label: a hover shape (Fluerial's pill) is
      // an effect, not the stack's edge. The label is the content, and stays
      // on the normal box in every state: negative margins inside the wrapper undo
      // whatever the state's box changes. A state's box keeps its own margins
      // but ends no lower than the normal box does (cut short where the tab
      // bar clips, with "Show the whole outline").
      // A state's background box within the tab: measured, or the normal box
      // moved by the difference in margins.
      function stateBox(l) {
        const n = looks.normal;
        if (l.box) return l.box;
        return {
          top: n.box.top + l.mt - n.mt, bottom: n.box.bottom + l.mb - n.mb,
          start: n.box.start + l.ms - n.ms, end: n.box.end + l.me - n.me,
        };
      }
      function bgRules(l, cut) {
        const g = geometry;
        const nb = looks.normal.box;
        const b = stateBox(l);
        // Ends no lower than the normal box, which may be cut short.
        const bottom = Math.min(nb.top + g.bgHeight - (b.bottom - nb.bottom), nb.top + g.bgHeight - cut);
        const h = Math.max(0, bottom - b.top);
        return `
          margin-block: ${b.top - g.containerShift}px 0px !important;
          margin-inline: ${b.start}px ${b.end}px !important;
          height: ${h}px !important; min-height: ${h}px !important; max-height: ${h}px !important;
          border-top: ${l.border.top} !important; border-right: ${l.border.right} !important;
          border-bottom: ${l.border.bottom} !important; border-left: ${l.border.left} !important;
          border-radius: ${l.radius} !important;
          background-color: ${l.bgColor} !important;
          background-image: ${l.bgImage} !important;
          ${l.bgLayout.map(([prop, value]) => `${prop}: ${value} !important;`).join(" ")}
          box-shadow: ${l.shadow} !important;`;
      }

      // "Highlight like a selected tab": the selected tab's colored edge, as
      // the theme draws it: an outline (Firefox themes' accent in Proton and
      // Fluerial), or drop shadows (Lepton). Drop shadows become box shadows,
      // which take the same color and offsets, so they don't shadow the
      // stack's text too. Null when the theme draws no edge.
      function dropShadows(filter) {
        const out = [];
        for (let i = filter.indexOf("drop-shadow("); i !== -1; i = filter.indexOf("drop-shadow(", i)) {
          let depth = 0, j = i + "drop-shadow".length;
          for (; j < filter.length; j++) {
            if (filter[j] === "(") depth++;
            else if (filter[j] === ")" && --depth === 0) break;
          }
          out.push(filter.slice(i + "drop-shadow(".length, j).trim());
          i = j + 1;
        }
        return out;
      }
      const isClear = (color) => /^transparent$|,\s*0\)$|\/\s*0\)$/.test(String(color).trim());
      function coveredByContent(p, bgRect) {
        const cs = getComputedStyle(p.content);
        if (isClear(cs.backgroundColor) && cs.backgroundImage === "none") return false;
        if (!bgRect) return true;
        const c = p.content.getBoundingClientRect();
        return c.left <= bgRect.left + 0.5 && c.right >= bgRect.right - 0.5 && c.top <= bgRect.top + 0.5 && c.bottom >= bgRect.bottom - 0.5;
      }
      // Returns { bg, after } (CSS for the background layer and for its
      // ::after), or null. Drop shadows (Lepton) are the theme's own filter,
      // on a copy of the background in the layer's ::after, behind the
      // stack's text: a filter on the layer itself would shadow the text too,
      // and box shadows don't show through a see-through background the way
      // the filter does (dark stars tints the whole tab with its accent).
      function edgeRules(l) {
        const shadowed = dropShadows(l.filter || "").length > 0;
        const o = l.edgeOutline;
        const outlined = !!o && o.style !== "none" && px(o.width) > 0 && !isClear(o.color);
        if (!shadowed && !outlined) return null;
        const outline = outlined
          ? `outline: ${o.width} ${o.style} ${o.color} !important; outline-offset: ${o.offset} !important;`
          : "outline: none !important;";
        if (!shadowed) return { bg: outline, after: null };
        return {
          bg: `${outline} position: relative !important; isolation: isolate !important;
            background: none !important; box-shadow: none !important;`,
          after: `content: "" !important; display: block !important; position: absolute !important; inset: 0 !important;
            z-index: -1 !important; pointer-events: none !important; border-radius: inherit !important;
            background-color: ${l.bgColor} !important; background-image: ${l.bgImage} !important;
            ${l.bgLayout.map(([prop, value]) => `${prop}: ${value} !important;`).join(" ")}
            box-shadow: ${l.shadow} !important; filter: ${l.filter} !important;`,
        };
      }
      // How far a state moves the content row from the normal tab's.
      const contentMove = (l) => (l.contentMid != null && looks.normal.contentMid != null ? l.contentMid - looks.normal.contentMid : 0);
      function labelRules(l, cut) {
        const nb = looks.normal.box;
        const b = stateBox(l);
        const lift = 2 * (geometry.contentShift + contentMove(l)) + cut; // top padding minus bottom padding
        return `
          padding-block: ${Math.max(0, lift)}px ${Math.max(0, -lift)}px !important;
          margin-block: ${nb.top - b.top}px 0px !important;
          margin-inline: ${nb.start - b.start}px ${nb.end - b.end}px !important;
          color: ${l.color} !important;
          text-shadow: ${l.textShadow} !important;`;
      }
      const textRules = (l) => `opacity: ${l.textOpacity} !important; font-weight: ${l.fontWeight} !important;`;
      const closeRules = (l) => `display: ${l.closeShown ? "flex" : "none"} !important; opacity: ${l.closeOpacity} !important; fill-opacity: ${l.closeFillOpacity} !important;`;

      // Where a state shows the close button, the count moves in by the room it
      // takes, as a tab's title does, and the title fades out before the count.
      // Painting only (a relative offset and a mask), so the stack keeps its
      // width under Compact stacks; where it doesn't show, the count stays at
      // the end.
      function countRules(l, sel) {
        // The button's room, plus the theme's icon-to-title gap between the count
        // and the button (whose padding and hover background reach its edge).
        const room = l.closeShown ? (geometry.closeRoom ?? 0) + geometry.iconGap : 0;
        const LABEL = "> .tab-group-label-hover-highlight > .tab-group-label";
        return `
          ${sel} ${LABEL}::after { inset-inline-start: ${-room}px !important; }
          ${sel} ${LABEL}::before { mask-image: linear-gradient(to left, transparent ${room}px, black calc(${room}px + 1em)) !important; }
          ${sel} ${LABEL}:-moz-locale-dir(rtl)::before { mask-image: linear-gradient(to right, transparent ${room}px, black calc(${room}px + 1em)) !important; }`;
      }

      function css() {
        const g = geometry;
        // "Show the whole outline": the box ends where the tab bar clips, and
        // the content keeps its place (it would re-center a little higher).
        const cut = ctx.isActive(WHOLE_OUTLINE) ? g.clipOverlap : 0;
        // For the absolutely placed parts (close button, throbber).
        const midShift = (l) => g.contentShift + contentMove(l) + cut / 2;
        const { normal, hover } = looks;
        const selected = looks.selected || normal;
        // The open stack's edge: the selected tab's, with "Highlight like a
        // selected tab" where the theme draws one, otherwise the stack's color.
        const edge = ctx.isActive(TAB_EDGE) ? edgeRules(selected) : null;
        const R = `:root[${ROOT_ATTR}] ${STACK}`;
        const N = `${R} > .tab-group-label-container`;
        const H = `${R} > .tab-group-label-container:hover`;
        const S = `${R}[hasactivetab] > .tab-group-label-container`;
        // Floorp's "drop to join" cue, and the hover-to-join one (drag-and-drop).
        const DROP = `:is(${R}[data-floorp-drop-into], :root[${ROOT_ATTR}] #tabbrowser-tabs[movingtab-group] tab-group[${U.STACK_ATTR}]:has(.tab-group-label[dragover-groupTarget])) > .tab-group-label-container`;
        const BG = "> .tab-group-label-hover-highlight";
        const LABEL = `${BG} > .tab-group-label`;
        const outline = "color-mix(in srgb, var(--tab-group-color-invert, currentColor) 70%, transparent)";
        const outlineActive = "color-mix(in srgb, var(--tab-group-color-invert, currentColor) 85%, white 15%)";
        return `
          ${N} {
            padding-inline: 0 !important;
            /* The boxes may start below the container's top (where a theme's
               tabs start lower), and that strip would be part of the toolbar's
               window-drag area: in a maximized window, clicks on the screen's
               top edge would move the window instead. Tabs aren't draggable. */
            -moz-window-dragging: no-drag !important;
          }
          ${N} ${BG} {
            box-sizing: border-box !important;
            padding: 0 !important;
            overflow: visible !important;
            outline: 1px solid ${outline} !important;
            outline-offset: -1px !important;
            transition: ${g.transition} !important;
            ${bgRules(normal, cut)}
          }
          ${H} ${BG} { ${bgRules(hover, cut)} outline: none !important; }
          ${S} ${BG} { ${bgRules(selected, cut)} ${edge?.bg ?? `outline: 1px solid ${outlineActive} !important; outline-offset: -1px !important;`} }
          ${edge?.after ? `${S} ${BG}::after { ${edge.after} }` : ""}

          ${N} ${LABEL} {
            box-sizing: border-box !important;
            flex: none !important;
            height: ${g.bgHeight - cut}px !important; min-height: ${g.bgHeight - cut}px !important; max-height: ${g.bgHeight - cut}px !important;
            padding-inline: ${g.padStart}px ${g.padEnd}px !important;
            border: none !important;
            border-radius: ${normal.radius} !important;
            background: none !important;
            box-shadow: none !important;
            outline: none !important;
            ${labelRules(normal, cut)}
          }
          ${H} ${LABEL} { ${labelRules(hover, cut)} outline: 1px solid ${outline} !important; outline-offset: -1px !important; }
          ${S} ${LABEL} { ${labelRules(selected, cut)} outline: none !important; }

          ${N} ${LABEL}::before {
            font-family: ${g.font.family} !important;
            font-size: ${g.font.size} !important;
            font-style: ${g.font.style} !important;
            letter-spacing: ${g.font.spacing} !important;
            ${textRules(normal)}
          }
          ${H} ${LABEL}::before { ${textRules(hover)} }
          ${S} ${LABEL}::before { ${textRules(selected)} }
          /* The count sits at the end, where a tab's title would end. */
          ${N} ${LABEL}::after {
            position: relative !important;
            flex: none !important;
            margin-inline-start: auto !important;
            margin-inline-end: 0 !important;
            padding-inline-start: ${g.iconGap}px !important;
            font-family: ${g.font.family} !important;
            font-size: calc(${g.font.size} * 0.9) !important;
            font-style: ${g.font.style} !important;
            opacity: 0.7 !important;
          }

          ${countRules(normal, N)}
          ${countRules(hover, H)}
          ${countRules(selected, S)}

          ${N} ${LABEL} > .floorp-stack-icon {
            position: static !important;
            transform: none !important;
            order: -1 !important;
            flex: none !important;
            display: revert-layer !important;
            box-sizing: border-box !important;
            width: ${g.iconW}px !important;
            height: ${g.iconH}px !important;
            margin: 0 !important;
            margin-inline-end: ${g.iconGap}px !important;
            opacity: ${normal.iconOpacity} !important;
          }
          ${H} ${LABEL} > .floorp-stack-icon { opacity: ${hover.iconOpacity} !important; }
          ${S} ${LABEL} > .floorp-stack-icon { opacity: ${selected.iconOpacity} !important; }
          ${N} ${LABEL} > .uc-stack-throbber {
            inset-inline-start: ${g.padStart}px !important;
            inset-block-start: calc(50% + ${midShift(normal)}px) !important;
            width: ${g.iconW}px !important;
            height: ${g.iconH}px !important;
          }

          ${N} ${LABEL} > .floorp-stack-close {
            inset-inline-start: auto !important;
            inset-block-start: calc(50% + ${midShift(normal)}px) !important;
            inset-inline-end: ${g.closeEnd ?? g.padEnd}px !important;
            ${g.closeW ? `box-sizing: border-box !important; width: ${g.closeW}px !important; height: ${g.closeH}px !important;` : ""}
            ${g.closePad ? `padding: ${g.closePad} !important; border-radius: ${g.closeRadius} !important;` : ""}
            background-color: transparent !important;
            ${closeRules(normal)}
          }
          ${N} ${LABEL} > .floorp-stack-close:hover { background-color: ${g.closeHoverBg} !important; }
          ${H} ${LABEL} > .floorp-stack-close { ${closeRules(hover)} inset-block-start: calc(50% + ${midShift(hover)}px) !important; }
          ${S} ${LABEL} > .floorp-stack-close { ${closeRules(selected)} inset-block-start: calc(50% + ${midShift(selected)}px) !important; }
          ${H} ${LABEL} > .uc-stack-throbber { inset-block-start: calc(50% + ${midShift(hover)}px) !important; }
          ${S} ${LABEL} > .uc-stack-throbber { inset-block-start: calc(50% + ${midShift(selected)}px) !important; }

          /* A tab dragged over a stack to join it: Floorp's highlight (and
             the hover-to-join one) colors the label, which has no background
             here, so it goes on the background layer. After the states so it
             wins over all of them. */
          ${DROP} ${BG} {
            background-color: color-mix(in srgb, var(--focus-outline-color, #0a84ff) 35%, transparent) !important;
            background-image: none !important;
            outline: 1px solid var(--focus-outline-color, #0a84ff) !important;
            outline-offset: -1px !important;
          }
          ${DROP} ${LABEL} { outline: none !important; }
        `;
      }

      const refresh = ctx.throttle(() => {
        read();
        if (!geometry || !looks?.normal?.box) return; // no normal tab to copy yet
        const text = css();
        if (sheet.textContent !== text) sheet.textContent = text;
        if (!document.documentElement.hasAttribute(ROOT_ATTR)) document.documentElement.setAttribute(ROOT_ATTR, "");
      }, "copying the tab look");
      // Stylesheets load a moment after a design or theme switch.
      const refreshSoon = () => {
        refresh();
        ctx.timeout(refresh, 400);
        ctx.timeout(refresh, 1500);
      };

      // Themes (inline variables and attributes on the root), Floorp designs
      // (style sheets added and loaded), density, light/dark.
      ctx.observe(document.documentElement, { attributes: true }, (records) => {
        if (records.some(r => r.attributeName !== ROOT_ATTR)) refreshSoon();
      });
      ctx.observe(document.documentElement, { childList: true }, refreshSoon);
      ctx.observe(document.head, { childList: true }, (records) => {
        if (records.some(r => [...r.addedNodes, ...r.removedNodes].some(n => n !== sheet))) refreshSoon();
      });
      ctx.listen(document, "load", (e) => {
        if (e.target?.localName === "link") refreshSoon();
      }, true);
      ctx.observeTopic("lightweight-theme-styling-update", refreshSoon);
      const scheme = window.matchMedia("(prefers-color-scheme: dark)");
      const onScheme = ctx.guard(refreshSoon, "color scheme change");
      scheme.addEventListener("change", onScheme);
      ctx.onCleanup(() => scheme.removeEventListener("change", onScheme));
      const prefObserver = { observe: ctx.guard(refreshSoon, "theme pref change") };
      for (const branch of ["floorp.design.", "browser.uidensity", "browser.theme.", "browser.tabs."]) {
        Services.prefs.addObserver(branch, prefObserver);
      }
      ctx.onCleanup(() => {
        for (const branch of ["floorp.design.", "browser.uidensity", "browser.theme.", "browser.tabs."]) {
          Services.prefs.removeObserver(branch, prefObserver);
        }
      });
      // The "Show the whole outline" sub-setting turning on or off.
      ctx.onCleanup(onChanged(() => refresh()));
      // Until there's a normal tab to copy, and for the selected look.
      for (const type of ["TabOpen", "TabClose", "TabSelect", "TabPinned", "TabUnpinned"]) {
        ctx.listen(gBrowser.tabContainer, type, refresh);
      }
      // A crowded tab bar shows close buttons only on the selected tab; Firefox
      // switches a moment after the tabs have shrunk, with no tab event.
      ctx.observe(gBrowser.tabContainer, { attributes: true, attributeFilter: ["closebuttons"] }, refresh);
      // Tabs are styled differently while the window is in the background
      // (dimmer text), e.g. when the browser starts behind another window.
      ctx.listen(window, "activate", refresh);
      ctx.listen(window, "deactivate", refresh);

      // Where a theme's tabs start below the tab bar's top, so do the stack's
      // boxes, and the strip above them is the label's container. Firefox closes
      // a stack on middle-click only when the label itself is the target, so a
      // middle-click on that strip does what a click on the label does (ahead
      // of Firefox's handler, which would treat it as empty tab-bar space).
      ctx.listen(gBrowser.tabContainer, "click", (e) => {
        if (e.button !== 1 || !document.documentElement.hasAttribute(ROOT_ATTR)) return;
        const t = e.target;
        if (!t?.closest || t.closest(".tab-group-label")) return;
        const group = t.closest(".tab-group-label-container")?.parentElement;
        if (group?.localName !== "tab-group" || !U.isStack(group)) return;
        e.preventDefault();
        e.stopPropagation();
        group.saveAndClose();
      }, true);
      refreshSoon();
    },
  });

  defineFeature({
    id: "stack-whole-outline",
    parent: "stacks-look-like-tabs",
    name: "Show the whole outline",
    description: "On themes where tabs run past the bottom of the tab bar, stacks end at its edge so their outline shows all the way around.",
    default: true,
    init() {
      // Nothing to set up: "Stacks look like normal tabs" checks whether this
      // is running and shortens the stack by however much the theme's tabs
      // run past the tab bar's clipping edge (none on most themes).
    },
  });

  defineFeature({
    id: "stack-tab-highlight",
    parent: "stacks-look-like-tabs",
    name: "Highlight like a selected tab",
    description: "Where your theme highlights the selected tab in its own color, the open stack is highlighted the same way instead of in its stack color.",
    default: false,
    init() {
      // Nothing to set up: "Stacks look like normal tabs" checks whether this
      // is running and draws the selected tab's edge on the open stack.
    },
  });

  defineFeature({
    id: "compact-stacks",
    category: "appearance",
    name: "Compact stacks",
    description: "Stacks take up less room than normal tabs, so more of them fit in the tab bar. A stack whose name doesn't fit grows to show it, up to a normal tab's width.",
    default: false,
    standalone: ["stackktab-compact-stacks.uc.css"],
    init(ctx) {
      // Floorp's tab-like flex stays, so stacks still shrink with the tabs.
      // The label wrapper is as wide as its widest child: the label, or an
      // invisible 150px line whose percentage max-width lets it shrink. No
      // !important on max-width: Floorp's inline widths during a drag win.
      //
      // An auto-titled stack's "name" is a page title, which would almost
      // always reach a full tab's width, so those are held to the compact
      // 150px. The "Full width for auto-titled stacks" sub-setting widens them.
      ctx.style(`
        :root #tabbrowser-tabs tab-group[data-floorp-stack] > .tab-group-label-container {
          max-width: max-content;
        }
        #tabbrowser-tabs tab-group[data-floorp-stack] .tab-group-label-hover-highlight {
          max-width: var(--tab-max-width, 225px);
        }
        #tabbrowser-tabs tab-group[data-floorp-stack] .tab-group-label-hover-highlight:has(> .tab-group-label[uc-auto-title]) {
          max-width: 150px;
        }
        #tabbrowser-tabs tab-group[data-floorp-stack] .tab-group-label-hover-highlight::before {
          content: "";
          width: 150px;
          max-width: 100%;
        }
      `);
    },
  });

  defineFeature({
    id: "auto-title-full-width",
    parent: "compact-stacks",
    name: "Full width for auto-titled stacks",
    description: "With Auto-title stacks on, auto-titled stacks are as wide as a normal tab, while named stacks stay compact.",
    default: false,
    requires: ["stack-auto-title"],
    standalone: ["stacktab-auto-title-full-width.uc.css"],
    init(ctx) {
      // uc-auto-title is set by Auto-title stacks (hence `requires`). The
      // :root prefix outranks Compact stacks' selectors, which hold
      // auto-titled stacks to 150px.
      ctx.style(`
        :root #tabbrowser-tabs tab-group[data-floorp-stack] > .tab-group-label-container:has(> .tab-group-label-hover-highlight > .tab-group-label[uc-auto-title]) {
          max-width: var(--tab-max-width, 225px);
        }
        :root #tabbrowser-tabs tab-group[data-floorp-stack] .tab-group-label-hover-highlight:has(> .tab-group-label[uc-auto-title]) {
          max-width: var(--tab-max-width, 225px);
        }
      `);
    },
  });

  // --------------------------------------------------------------- Browser --

  defineFeature({
    id: "tab-marks",
    category: "browser",
    name: "Tab marks",
    description: "Adds \"Mark Tab\" to the tab menu to give tabs, including stack tabs, a colored border so they're easy to find. Works on several selected tabs, and marks are kept after a restart.",
    default: false,
    standalone: ["floorp-tab-marks.uc.js"],
    init(ctx) {
      // Saved with SessionStore.setCustomTabValue, so a mark comes back after
      // a restart, with Reopen Closed Tab, on duplicates and in other
      // windows. Colors are Firefox's tab group palette.
      const KEY = U.TAB_MARK_KEY;
      const ATTR = "uc-mark";
      const PROXY_SEL = U.PROXY_SEL;
      const ANCHOR_ID = "context_openAndOrganizeSeparator";
      const COLORS = [
        ["blue", "Blue"], ["purple", "Purple"], ["cyan", "Cyan"], ["orange", "Orange"],
        ["yellow", "Yellow"], ["pink", "Pink"], ["green", "Green"], ["gray", "Gray"], ["red", "Red"],
      ];
      const popup = ctx.require(document.getElementById("tabContextMenu"), "#tabContextMenu");
      ctx.require(window.SessionStore?.getCustomTabValue, "SessionStore custom tab values");

      // An inset box-shadow leaves the outline, border and pseudo-elements
      // the theme and Floorp use alone.
      ctx.style(`
        :root {
          --uc-tab-mark-width: 1px;
          --uc-tab-mark-opacity: 50%;
        }

        ${COLORS.map(([c]) =>
          `:is(.tabbrowser-tab, ${PROXY_SEL})[${ATTR}="${c}"] { --uc-mark-color: color-mix(in srgb, var(--tab-group-${c}) var(--uc-tab-mark-opacity), transparent); }`
        ).join("\n")}

        #tabbrowser-tabs .tabbrowser-tab[${ATTR}] > .tab-stack > .tab-background {
          box-shadow: inset 0 0 0 var(--uc-tab-mark-width) var(--uc-mark-color) !important;
        }

        ${PROXY_SEL}[${ATTR}] {
          box-shadow: inset 0 0 0 var(--uc-tab-mark-width) var(--uc-mark-color);
        }
        ${PROXY_SEL}[${ATTR}][data-drop-side="before"] {
          box-shadow: inset 2px 0 0 var(--focus-outline-color, #0a84ff),
                      inset 0 0 0 var(--uc-tab-mark-width) var(--uc-mark-color);
        }
        ${PROXY_SEL}[${ATTR}][data-drop-side="after"] {
          box-shadow: inset -2px 0 0 var(--focus-outline-color, #0a84ff),
                      inset 0 0 0 var(--uc-tab-mark-width) var(--uc-mark-color);
        }

        /* Floorp's separators sit on a stack tab's end edge; hide them beside
           a mark, as Floorp does around the selected tab. */
        ${PROXY_SEL}[${ATTR}]::after,
        ${PROXY_SEL}:has(+ ${PROXY_SEL}[${ATTR}])::after {
          background: transparent !important;
        }
      `);

      const isColor = (c) => COLORS.some(([name]) => name === c);

      function applyMark(tab) {
        if (!tab || tab.closing) return;
        const color = SessionStore.getCustomTabValue(tab, KEY);
        U.setAttr(tab, ATTR, isColor(color) ? color : null);
      }

      function syncProxies() {
        const proxies = document.querySelectorAll(PROXY_SEL);
        if (!proxies.length) return;
        const byId = U.tabsById();
        for (const proxy of proxies) {
          const tab = byId.get(proxy.getAttribute("data-floorp-drag-id"));
          U.setAttr(proxy, ATTR, tab?.getAttribute(ATTR) ?? null);
        }
      }
      const scheduleSync = ctx.throttle(syncProxies, "syncing tab marks");

      function setMark(tabs, color) {
        for (const tab of tabs) {
          if (color) SessionStore.setCustomTabValue(tab, KEY, color);
          else SessionStore.deleteCustomTabValue(tab, KEY);
          applyMark(tab);
        }
        syncProxies();
      }

      const applyAll = () => {
        for (const tab of gBrowser.tabs) applyMark(tab);
        scheduleSync();
      };

      // Read back whenever a tab may have gained a mark: restored tabs get
      // their values in the same go as TabOpen, and adopted ones during it.
      const tabs = gBrowser.tabContainer;
      ctx.listen(tabs, "TabOpen", (e) => ctx.microtask(() => {
        applyMark(e.target);
        scheduleSync();
      }));
      ctx.listen(tabs, "SSTabRestoring", (e) => {
        applyMark(e.target);
        scheduleSync();
      });
      ctx.listen(window, "SSWindowRestored", applyAll);
      ctx.watchToolbox(scheduleSync);

      // A tab moved to another window is a new tab there (gBrowser.adoptTab).
      // SessionStore hands it the mark at its TabOpen, but for an unloaded
      // tab Firefox then restores it from the old tab's state, which no longer
      // has the mark, and it's lost. The old tab still shows it when it closes
      // here (the new window may not be running this script yet), so the mark
      // is put back on the tab that replaced it. Not at once: the old tab
      // closes before that restore, so after the move (a microtask later,
      // still ahead of the new window's stack bar sync).
      ctx.listen(tabs, "TabClose", (e) => {
        const to = e.detail?.adoptedBy;
        const color = e.target.getAttribute(ATTR);
        if (!to || !isColor(color)) return;
        ctx.microtask(() => {
          if (!to.isConnected || to.closing) return;
          if (SessionStore.getCustomTabValue(to, KEY) !== color) SessionStore.setCustomTabValue(to, KEY, color);
          U.setAttr(to, ATTR, color);
        });
      });

      // ---- the menu ----
      // Firefox's MenuSectionLayout won't lay out a menu holding items it
      // doesn't know, so the submenu is added after Firefox has set the menu
      // up for this opening, and removed when it closes.
      const menu = ctx.track(document.createXULElement("menu"));
      menu.id = "uc-context_markTab";
      const menuPopup = document.createXULElement("menupopup");
      menu.append(menuPopup);
      const contextTabs = () => window.TabContextMenu?.contextTabs ?? [];
      for (const [color, label] of COLORS) {
        const item = document.createXULElement("menuitem");
        item.classList.add("menuitem-iconic", "tab-group-icon");
        item.setAttribute("label", label);
        item.style.setProperty("--tab-group-color", `var(--tab-group-${color})`);
        item.style.setProperty("--tab-group-color-invert", `var(--tab-group-${color}-invert)`);
        item.style.setProperty("--tab-group-color-pale", `var(--tab-group-${color}-pale)`);
        item.style.setProperty("--tab-group-background-color", `var(--tab-group-${color})`);
        item.addEventListener("command", ctx.guard(() => setMark(contextTabs(), color), "marking tabs"));
        menuPopup.append(item);
      }
      menuPopup.append(document.createXULElement("menuseparator"));
      const remove = document.createXULElement("menuitem");
      remove.addEventListener("command", ctx.guard(() => setMark(contextTabs(), null), "removing marks"));
      menuPopup.append(remove);

      ctx.listen(popup, "popupshowing", (e) => {
        if (e.target !== popup) return;
        const selected = contextTabs();
        const many = selected.length > 1;
        menu.setAttribute("label", many ? "Mark Tabs" : "Mark Tab");
        remove.setAttribute("label", many ? "Remove Marks" : "Remove Mark");
        remove.disabled = !selected.some(t => t.hasAttribute(ATTR));
        const anchor = document.getElementById(ANCHOR_ID);
        if (anchor?.parentNode === popup) anchor.before(menu);
        else popup.append(menu);
      });
      ctx.listen(popup, "popuphidden", (e) => {
        if (e.target === popup) menu.remove();
      });

      ctx.onCleanup(() => {
        for (const el of document.querySelectorAll(`[${ATTR}]`)) el.removeAttribute(ATTR);
      });
      applyAll();
    },
  });

  defineFeature({
    id: "tab-marks-confirm-close",
    parent: "tab-marks",
    name: "Ask before closing marked tabs",
    description: "Asks before closing a marked tab. When closing several tabs at once, you can keep the marked ones and close the rest.",
    default: false,
    init(ctx) {
      // One tab closes through removeTab; several, a whole stack or group
      // (removeTabGroup), "Close Other Tabs" and the like through removeTabs,
      // which only calls removeTab itself for tabs with a beforeunload prompt.
      // Outermost (priority -5), so a cancelled close happens before any other
      // feature reacts to it (e.g. "Keep stacks when their last tab closes"
      // adding its replacement tab).
      const PREF = "uc.floorp-improvements.feature.tab-marks-confirm-close";
      const marked = (tab) => !!tab && !tab.closing && !!U.markOf(tab);
      let bulk = 0; // inside removeTabs: it has asked already

      const ps = Services.prompt;
      const CHECKBOX = "Ask before closing marked tabs";
      // The checkbox turns this sub-setting off, like Firefox's own warnings.
      function stopAskingIf(check) {
        if (!check.value) Services.prefs.setBoolPref(PREF, false);
      }

      function confirmOne(tab) {
        const check = { value: true };
        const name = tab.label || "This tab";
        const button = ps.confirmEx(
          window,
          "Close marked tab?",
          `"${name}" is marked. Close it anyway?`,
          ps.BUTTON_TITLE_IS_STRING * ps.BUTTON_POS_0 + ps.BUTTON_TITLE_CANCEL * ps.BUTTON_POS_1,
          "Close Tab", null, null, CHECKBOX, check
        );
        if (button === 0) stopAskingIf(check);
        return button === 0;
      }

      // → "all", "unmarked" (keep the marked ones) or "none".
      function confirmMany(count, markedCount) {
        const check = { value: true };
        const some = markedCount < count;
        const text = markedCount === 1
          ? `1 of the ${count} tabs you're closing is marked.`
          : some ? `${markedCount} of the ${count} tabs you're closing are marked.`
          : `All ${count} tabs you're closing are marked.`;
        const flags = ps.BUTTON_TITLE_IS_STRING * ps.BUTTON_POS_0 +
          ps.BUTTON_TITLE_CANCEL * ps.BUTTON_POS_1 +
          (some ? ps.BUTTON_TITLE_IS_STRING * ps.BUTTON_POS_2 : 0);
        const button = ps.confirmEx(
          window,
          "Close marked tabs?",
          some ? `${text} Close ${markedCount === 1 ? "it" : "them"} too?` : `${text} Close them anyway?`,
          flags,
          "Close All", null, some ? (markedCount === 1 ? "Keep Marked Tab" : "Keep Marked Tabs") : null,
          CHECKBOX, check
        );
        if (button !== 1) stopAskingIf(check);
        return button === 0 ? "all" : button === 2 ? "unmarked" : "none";
      }

      // A refused close returns what the original would have (undefined, or a
      // promise when it's async).
      const nothing = (name) =>
        Hooks.original(gBrowser, name)?.constructor?.name === "AsyncFunction" ? Promise.resolve() : undefined;

      ctx.hook(gBrowser, "removeTab", function (next, tab, ...rest) {
        if (bulk || !marked(tab) || confirmOne(tab)) return next(tab, ...rest);
        return nothing("removeTab");
      }, { priority: -5 });

      ctx.hook(gBrowser, "removeTabs", function (next, tabs, ...rest) {
        // Nested: removeTabs closes whole groups through removeTabGroup,
        // which comes back here.
        if (bulk) return next(tabs, ...rest);
        const list = Array.from(tabs ?? []);
        const markedCount = list.filter(marked).length;
        if (!markedCount) return next(tabs, ...rest);
        const choice = list.length === 1
          ? (confirmOne(list[0]) ? "all" : "none")
          : confirmMany(list.length, markedCount);
        if (choice === "none") return nothing("removeTabs");
        const closing = choice === "all" ? list : list.filter(t => !marked(t));
        bulk++;
        try {
          return next(closing, ...rest);
        } finally {
          bulk--;
        }
      }, { priority: -5 });
    },
  });

  defineFeature({
    id: "workspace-scroll",
    category: "browser",
    name: "Scroll to switch workspaces",
    description: "Scroll the mouse wheel over the Workspaces button to switch workspaces, stopping at the first and last.",
    default: false,
    standalone: ["floorp-workspaces-scroll-switch.uc.js"],
    init(ctx) {
      // The order comes from the workspaces store pref, read fresh each time;
      // getSelectedWorkspaceID (not the global getWorkspaceID, a different id
      // space) gives the current one.
      const BUTTON_ID = "workspaces-toolbar-button";
      const STORE_PREF = "floorp.workspaces.v4.store";
      const SENSITIVITY = 100;  // wheel distance per step; one notch ≈ 100
      const DOWN_IS_NEXT = true;
      const wf = () => window.workspacesFuncs;

      function workspaceOrder() {
        try {
          const store = JSON.parse(Services.prefs.getStringPref(STORE_PREF, "{}"));
          return Array.isArray(store.order) ? store.order : [];
        } catch (e) {
          return [];
        }
      }

      function step(count) {
        const order = workspaceOrder();
        if (order.length < 2) return;
        if (typeof wf()?.getSelectedWorkspaceID !== "function" || typeof wf()?.changeWorkspace !== "function") {
          throw new Unavailable("Floorp's workspace functions have changed");
        }
        const i = order.indexOf(wf().getSelectedWorkspaceID());
        if (i === -1) return;
        const target = Math.max(0, Math.min(order.length - 1, i + count));
        if (target !== i) wf().changeWorkspace(order[target]);
      }

      let accum = 0; // so trackpads step smoothly too
      ctx.listen(window, "wheel", (e) => {
        if (!e.target?.closest?.("#" + BUTTON_ID)) return;
        e.preventDefault();
        e.stopPropagation();

        let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
        if (e.deltaMode === 1) d *= 20;
        else if (e.deltaMode === 2) d *= 100;
        if ((d < 0) !== (accum < 0)) accum = 0; // reversing responds at once
        accum += d;

        let steps = 0;
        while (accum >= SENSITIVITY) {
          steps++;
          accum -= SENSITIVITY;
        }
        while (accum <= -SENSITIVITY) {
          steps--;
          accum += SENSITIVITY;
        }
        if (steps) step(DOWN_IS_NEXT ? steps : -steps);
      }, { capture: true, passive: false });
    },
  });

  defineFeature({
    id: "about-singletons",
    category: "browser",
    name: "One Floorp Hub and Settings tab",
    description: "Floorp Hub and Settings each open in only one tab, with the normal tabs; opening them again switches to that tab.",
    default: false,
    standalone: ["floorp-about-page-singletons.uc.js"],
    init(ctx) {
      // Every tab open goes through gBrowser.addTab, including the Hub's
      // buttons that skip switchToTabHavingURI. about:hub doesn't keep its URL
      // once loaded, so the tab is remembered by reference; a URL scan adopts
      // tabs opened before this started.
      const SINGLETONS = ["about:hub", "about:preferences"];
      const baseFor = (uri) =>
        typeof uri === "string" ? SINGLETONS.find(b => uri === b || uri.startsWith(b + "#")) ?? null : null;
      const tracked = new Map();

      function living(base) {
        const t = tracked.get(base);
        if (t && !t.closing && gBrowser.tabs.includes(t)) return t;
        tracked.delete(base);
        for (const tab of gBrowser.tabs) {
          let spec = "";
          try {
            spec = tab.linkedBrowser?.currentURI?.spec || "";
          } catch (e) {}
          if (!tab.closing && (spec === base || spec.startsWith(base + "#"))) {
            tracked.set(base, tab);
            return tab;
          }
        }
        return null;
      }

      ctx.hook(gBrowser, "addTab", function (next, uri, ...rest) {
        const base = baseFor(uri);
        if (!base) return next(uri, ...rest);
        const existing = living(base);
        if (existing) {
          gBrowser.selectedTab = existing;
          return existing; // the caller gets the open tab; nothing is created
        }
        // First open: with the normal tabs, not next to the current one or in
        // a group ("Bookmarks open in the stack" may have asked for one),
        // either of which would put it in the current stack. Current Firefox
        // reads tabIndex, older builds index.
        const opts = { ...(rest[0] || {}) };
        delete opts.relatedToCurrent;
        delete opts.ownerTab;
        delete opts.tabGroup;
        opts.index = opts.tabIndex = gBrowser.tabs.length;
        opts.triggeringPrincipal ??= U.systemPrincipal();
        const tab = next(uri, opts, ...rest.slice(1));
        tracked.set(base, tab);
        return tab;
      });
    },
  });

  // ======================================================= 7. settings page ==
  // A modal page over the browser window, built with plain HTML so a change
  // in Firefox's own widgets can't break it. It reflects this window's state
  // and updates live.

  const STATUS_TEXT = {
    off: "Off",
    paused: "Paused",
    waiting: "Waiting",
    skipped: "Skipped",
    starting: "Starting",
    on: "On",
    warn: "Partly working",
    error: "Errors",
    failed: "Failed to load",
    unavailable: "Unavailable",
  };
  const STATUS_TONE = {
    off: "neutral",
    paused: "neutral",
    waiting: "neutral",
    skipped: "warn",
    starting: "neutral",
    on: "good",
    warn: "warn",
    error: "bad",
    failed: "bad",
    unavailable: "bad",
  };

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const featureName = (id) => featureById.get(id)?.def.name ?? id;

  function issueText(f) {
    switch (f.status) {
      case STATUS.FAILED:
        return `Couldn't start: ${f.reason}`;
      case STATUS.UNAVAILABLE:
        return `Something this needs is missing, usually because Floorp or Firefox changed in an update: ${f.reason}.`;
      case STATUS.ERROR: {
        const last = f.errors.at(-1);
        return `${plural(f.errorCount, "error")} while running. Latest: ${last?.message ?? "unknown"}` +
          (last?.where ? ` (in ${last.where}).` : ".");
      }
      case STATUS.WARN:
        return f.warnings.join(" ");
      case STATUS.SKIPPED:
        return `The old standalone ${f.reason} is installed and running instead. Remove it from your chrome folder to use this version.`;
      case STATUS.WAITING: {
        const parent = f.def.parent && featureById.get(f.def.parent);
        if (parent?.enabled && f.reason.includes(parent.id)) {
          return `Waiting for ${parent.def.name}, which isn't running.`;
        }
        return `Turn on ${f.reason.map(featureName).join(" and ")} to use this.`;
      }
      default:
        return "";
    }
  }

  function counts() {
    let on = 0, off = 0, problems = 0, notices = 0;
    for (const f of features) {
      if (f.running) on++;
      else off++;
      if (f.hasProblem) problems++;
      else if (f.status === STATUS.WARN || f.status === STATUS.SKIPPED) notices++;
    }
    return { on, off, problems, notices };
  }

  function versionInfo() {
    const app = Services.appinfo;
    // Floorp's MOZ_APP_VERSION is "<floorp>@<firefox>".
    const appVersion = String(window.AppConstants?.MOZ_APP_VERSION ?? app.version ?? "");
    const floorp = appVersion.includes("@") ? appVersion.split("@")[0] : "";
    return {
      script: VERSION || "unknown",
      floorp,
      firefox: app.platformVersion,
      os: app.OS,
      loader: Standalone.loaderVersion,
    };
  }

  function diagnostics() {
    const time = (t) => new Date(t).toISOString();
    return JSON.stringify({
      ...versionInfo(),
      paused: Prefs.paused(),
      update: (({ latest, lastCheck, error, auto }) => ({
        latest: latest || undefined,
        lastCheck: lastCheck ? time(lastCheck * 1000) : undefined,
        error: error || undefined,
        auto,
      }))(Updates.state()),
      oldScriptsInstalled: Standalone.installed(),
      features: features.map(f => ({
        id: f.id,
        enabled: f.enabled,
        status: f.status,
        reason: Array.isArray(f.reason) ? f.reason.join(", ") : f.reason || undefined,
        warnings: f.warnings.length ? f.warnings : undefined,
        errorCount: f.errorCount || undefined,
        errors: f.errors.length ? f.errors.map(e => ({
          time: time(e.time),
          where: e.where,
          message: e.message,
          stack: e.stack.split("\n").slice(0, 8).join("\n"),
        })) : undefined,
      })),
      hooks: Hooks.report(),
    }, null, 2);
  }

  function copyText(text) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
  }

  function setEnabled(f, value) {
    Prefs.setFeatureEnabled(f.id, value);
  }

  function retry(f) {
    if (f.ctx) stop(f);
    f.status = STATUS.OFF;
    reconcile();
  }

  // ---- update check ----
  // Reads the @version line at the top of this file as published on GitHub
  // (only the first few KB) and compares it with VERSION (this file's own
  // @version, as fx-autoconfig read it). Results are kept in prefs, so every
  // window shares them; their pref observer redraws the menu labels and the
  // settings page. An automatic check runs when the last one is
  // more than CHECK_EVERY old (looked at every half hour); the first window to
  // start one claims it by writing the time, so the others skip.
  const Updates = (() => {
    const REPO = "sarabara1/floorp-bug-fixes-and-improvements-userscript";
    const FILE = "JS/floorp-bug-fixes-and-improvements.uc.js";
    const RAW_URL = `https://raw.githubusercontent.com/${REPO}/main/${FILE}`;
    const PAGE_URL = `https://github.com/${REPO}/blob/main/${FILE}`;
    const CHECK_EVERY = 12 * 60 * 60; // seconds
    const PREF = {
      auto: PREF_ROOT + "update.auto",
      last: PREF_ROOT + "update.lastCheck",   // seconds since 1970
      latest: PREF_ROOT + "update.latest",    // version found on GitHub
      error: PREF_ROOT + "update.error",      // why the last check failed
    };
    let checking = false;

    const now = () => Math.floor(Date.now() / 1000);
    const getInt = (name) => {
      try {
        return Services.prefs.getIntPref(name, 0);
      } catch (e) {
        return 0;
      }
    };
    const getString = (name) => {
      try {
        return Services.prefs.getStringPref(name, "");
      } catch (e) {
        return "";
      }
    };

    // 1.10.0 > 1.9.2; missing parts count as 0.
    function compare(a, b) {
      const pa = String(a).split(/[.-]/).map(n => parseInt(n, 10) || 0);
      const pb = String(b).split(/[.-]/).map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
      }
      return 0;
    }

    function state() {
      const latest = getString(PREF.latest);
      return {
        auto: U.prefBool(PREF.auto, true),
        lastCheck: getInt(PREF.last),
        latest,
        error: getString(PREF.error),
        checking,
        available: !!latest && !!VERSION && compare(latest, VERSION) > 0,
      };
    }

    async function check() {
      if (checking) return;
      checking = true;
      Services.prefs.setIntPref(PREF.last, now());
      notifyChanged();
      try {
        const res = await fetch(RAW_URL, {
          cache: "no-store",
          credentials: "omit",
          headers: { Range: "bytes=0-4095" }, // the header is near the top
        });
        if (!res.ok) {
          throw new Error(res.status === 404 ? "the file isn't on GitHub yet" : `GitHub answered ${res.status}`);
        }
        const version = /^\/\/\s*@version\s+(\S+)/m.exec(await res.text())?.[1];
        if (!version) throw new Error("no version found in the file on GitHub");
        Services.prefs.setStringPref(PREF.latest, version);
        Services.prefs.clearUserPref(PREF.error);
      } catch (e) {
        const offline = e instanceof TypeError; // fetch's network error
        Services.prefs.setStringPref(PREF.error, offline ? "couldn't reach GitHub" : errorMessage(e));
        console.warn(LOG, "update check failed:", e);
      } finally {
        checking = false;
        notifyChanged();
      }
    }

    function checkIfDue() {
      if (U.prefBool(PREF.auto, true) && now() - getInt(PREF.last) >= CHECK_EVERY) check();
    }

    function start() {
      setTimeout(checkIfDue, 30 * 1000); // not during startup
      setInterval(checkIfDue, 30 * 60 * 1000);
    }

    function setAuto(value) {
      if (value) Services.prefs.clearUserPref(PREF.auto);
      else Services.prefs.setBoolPref(PREF.auto, false);
    }

    function openPage() {
      window.openTrustedLinkIn(PAGE_URL, "tab");
    }

    return { state, check, start, setAuto, openPage };
  })();

  const SETTINGS_CSS = `
    #uc-fbfi-settings {
      --fbfi-bg: var(--arrowpanel-background, Canvas);
      --fbfi-fg: var(--arrowpanel-color, CanvasText);
      --fbfi-muted: color-mix(in srgb, var(--fbfi-fg) 68%, transparent);
      --fbfi-line: color-mix(in srgb, var(--fbfi-fg) 14%, transparent);
      --fbfi-surface: color-mix(in srgb, var(--fbfi-fg) 4%, transparent);
      --fbfi-hover: color-mix(in srgb, var(--fbfi-fg) 9%, transparent);
      --fbfi-accent: var(--color-accent-primary, AccentColor);
      --fbfi-good: light-dark(#1a7f37, #5bd68e);
      --fbfi-warn: light-dark(#9a6700, #f2c14e);
      --fbfi-bad: light-dark(#cf222e, #ff8189);
      --fbfi-neutral: var(--fbfi-muted);

      box-sizing: border-box;
      width: min(980px, calc(100vw - 40px));
      height: min(800px, calc(100vh - 40px));
      max-width: none;
      max-height: none;
      padding: 0;
      border: 1px solid var(--fbfi-line);
      border-radius: 12px;
      background: var(--fbfi-bg);
      color: var(--fbfi-fg);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.35);
      font: menu;
      font-size: 13px;
      line-height: 1.45;
      overflow: hidden;
    }
    #uc-fbfi-settings[open] {
      display: flex;
      flex-direction: column;
    }
    #uc-fbfi-settings.fbfi-fallback {
      position: fixed;
      inset: 0;
      margin: auto;
      z-index: 2147483647;
    }
    #uc-fbfi-settings::backdrop {
      background: rgba(0, 0, 0, 0.45);
    }
    #uc-fbfi-settings *,
    #uc-fbfi-settings *::before,
    #uc-fbfi-settings *::after {
      box-sizing: border-box;
    }
    #uc-fbfi-settings [hidden] {
      display: none !important;
    }
    #uc-fbfi-settings :focus-visible {
      outline: 2px solid var(--fbfi-accent);
      outline-offset: 2px;
    }

    /* ---- header ---- */
    #uc-fbfi-settings .fbfi-header {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 18px 20px 16px 24px;
      border-bottom: 1px solid var(--fbfi-line);
    }
    #uc-fbfi-settings .fbfi-heading {
      flex: 1;
      min-width: 0;
    }
    #uc-fbfi-settings h1 {
      margin: 0;
      font-size: 19px;
      font-weight: 600;
      line-height: 1.25;
    }
    #uc-fbfi-settings .fbfi-sub {
      margin: 2px 0 0;
      color: var(--fbfi-muted);
      font-size: 12px;
    }
    #uc-fbfi-settings .fbfi-update {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 12px;
      margin-top: 4px;
      color: var(--fbfi-muted);
      font-size: 12px;
    }
    #uc-fbfi-settings .fbfi-update-status[data-tone="info"] {
      color: var(--fbfi-accent);
      font-weight: 600;
    }
    #uc-fbfi-settings .fbfi-update-status[data-tone="bad"] {
      color: var(--fbfi-bad);
    }
    #uc-fbfi-settings .fbfi-update-auto {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    #uc-fbfi-settings .fbfi-update-auto input {
      margin: 0;
    }
    #uc-fbfi-settings .fbfi-link {
      appearance: none;
      padding: 0;
      border: none;
      background: none;
      color: var(--fbfi-accent);
      font: inherit;
      text-decoration: underline;
      cursor: pointer;
    }
    #uc-fbfi-settings .fbfi-link:disabled {
      color: var(--fbfi-muted);
      text-decoration: none;
      cursor: default;
    }
    #uc-fbfi-settings .fbfi-summary {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    #uc-fbfi-settings .fbfi-chip {
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--fbfi-surface);
      border: 1px solid var(--fbfi-line);
      font-size: 12px;
      white-space: nowrap;
    }
    #uc-fbfi-settings .fbfi-chip[data-tone="bad"] {
      color: var(--fbfi-bad);
      border-color: color-mix(in srgb, var(--fbfi-bad) 45%, transparent);
      background: color-mix(in srgb, var(--fbfi-bad) 10%, transparent);
      font-weight: 600;
    }
    #uc-fbfi-settings .fbfi-chip[data-tone="good"] {
      color: var(--fbfi-good);
    }
    #uc-fbfi-settings .fbfi-icon-btn {
      appearance: none;
      flex: none;
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 6px;
      background: transparent url("chrome://global/skin/icons/close.svg") no-repeat center / 16px;
      -moz-context-properties: fill;
      fill: currentColor;
      color: inherit;
      cursor: default;
    }
    #uc-fbfi-settings .fbfi-icon-btn:hover {
      background-color: var(--fbfi-hover);
    }

    /* ---- body ---- */
    #uc-fbfi-settings .fbfi-body {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: 220px 1fr;
    }
    #uc-fbfi-settings .fbfi-nav {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 14px 12px;
      border-inline-end: 1px solid var(--fbfi-line);
      overflow-y: auto;
    }
    #uc-fbfi-settings .fbfi-search {
      appearance: none;
      width: 100%;
      margin: 0 0 10px;
      padding: 6px 10px;
      border: 1px solid var(--fbfi-line);
      border-radius: 6px;
      background: var(--fbfi-surface);
      color: inherit;
      font: inherit;
    }
    #uc-fbfi-settings .fbfi-nav-item {
      appearance: none;
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 7px 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: default;
    }
    #uc-fbfi-settings .fbfi-nav-item:hover {
      background: var(--fbfi-hover);
    }
    #uc-fbfi-settings .fbfi-nav-item[aria-current="true"] {
      background: color-mix(in srgb, var(--fbfi-accent) 14%, transparent);
      color: var(--fbfi-accent);
      font-weight: 600;
    }
    #uc-fbfi-settings .fbfi-nav-label {
      flex: 1;
    }
    #uc-fbfi-settings .fbfi-nav-count {
      color: var(--fbfi-muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    #uc-fbfi-settings .fbfi-nav-item.fbfi-nav-problems {
      margin-top: 8px;
      color: var(--fbfi-bad);
    }
    #uc-fbfi-settings .fbfi-nav-item.fbfi-nav-problems .fbfi-nav-count {
      color: inherit;
      font-weight: 600;
    }

    #uc-fbfi-settings .fbfi-content {
      overflow-y: auto;
      padding: 8px 28px 28px;
      scroll-padding-top: 12px;
    }

    /* ---- banners ---- */
    #uc-fbfi-settings .fbfi-banner {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--fbfi-tone) 40%, transparent);
      background: color-mix(in srgb, var(--fbfi-tone) 9%, transparent);
    }
    #uc-fbfi-settings .fbfi-banner[data-tone="bad"] { --fbfi-tone: var(--fbfi-bad); }
    #uc-fbfi-settings .fbfi-banner[data-tone="warn"] { --fbfi-tone: var(--fbfi-warn); }
    #uc-fbfi-settings .fbfi-banner[data-tone="neutral"] { --fbfi-tone: var(--fbfi-fg); }
    #uc-fbfi-settings .fbfi-banner[data-tone="info"] { --fbfi-tone: var(--fbfi-accent); }
    #uc-fbfi-settings .fbfi-banner-text {
      flex: 1;
      min-width: 0;
    }
    #uc-fbfi-settings .fbfi-banner strong {
      display: block;
      margin-bottom: 2px;
    }
    #uc-fbfi-settings .fbfi-banner p {
      margin: 0;
    }
    #uc-fbfi-settings .fbfi-banner code {
      font-size: 12px;
    }

    /* ---- sections and rows ---- */
    #uc-fbfi-settings .fbfi-section {
      padding-top: 20px;
    }
    #uc-fbfi-settings h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 600;
    }
    #uc-fbfi-settings .fbfi-section-desc {
      margin: 2px 0 10px;
      color: var(--fbfi-muted);
    }
    #uc-fbfi-settings .fbfi-card {
      border: 1px solid var(--fbfi-line);
      border-radius: 10px;
      background: var(--fbfi-surface);
      overflow: hidden;
    }
    #uc-fbfi-settings .fbfi-row {
      display: grid;
      grid-template-columns: 1fr auto auto;
      align-items: start;
      gap: 6px 16px;
      padding: 13px 16px;
    }
    #uc-fbfi-settings .fbfi-row + .fbfi-row {
      border-top: 1px solid var(--fbfi-line);
    }
    #uc-fbfi-settings .fbfi-row[data-tone="good"] { --fbfi-tone: var(--fbfi-good); }
    #uc-fbfi-settings .fbfi-row[data-tone="warn"] { --fbfi-tone: var(--fbfi-warn); }
    #uc-fbfi-settings .fbfi-row[data-tone="bad"] { --fbfi-tone: var(--fbfi-bad); }
    #uc-fbfi-settings .fbfi-row[data-tone="neutral"] { --fbfi-tone: var(--fbfi-neutral); }
    #uc-fbfi-settings .fbfi-row-text {
      min-width: 0;
    }
    #uc-fbfi-settings .fbfi-name {
      font-weight: 600;
    }
    #uc-fbfi-settings .fbfi-desc {
      margin: 2px 0 0;
      color: var(--fbfi-muted);
      max-width: 62ch;
    }
    #uc-fbfi-settings .fbfi-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 1px;
      padding: 1px 9px 1px 7px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--fbfi-tone) 45%, transparent);
      color: var(--fbfi-tone);
      font-size: 11.5px;
      font-weight: 600;
      white-space: nowrap;
    }
    #uc-fbfi-settings .fbfi-pill::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: currentColor;
    }
    #uc-fbfi-settings .fbfi-row[data-tone="neutral"] .fbfi-pill {
      font-weight: normal;
    }
    #uc-fbfi-settings .fbfi-row[data-tone="neutral"] .fbfi-pill::before {
      background: transparent;
      box-shadow: inset 0 0 0 1.5px currentColor;
    }
    #uc-fbfi-settings .fbfi-issue {
      margin-top: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      border-inline-start: 3px solid var(--fbfi-tone);
      background: color-mix(in srgb, var(--fbfi-tone) 10%, transparent);
    }
    #uc-fbfi-settings .fbfi-row[data-tone="neutral"] .fbfi-issue {
      padding-block: 4px;
      background: transparent;
      color: var(--fbfi-muted);
    }
    #uc-fbfi-settings .fbfi-details {
      margin-top: 6px;
      color: var(--fbfi-muted);
      font-size: 12px;
    }
    #uc-fbfi-settings .fbfi-details > summary {
      width: max-content;
      cursor: default;
    }
    #uc-fbfi-settings .fbfi-details > summary:hover {
      color: var(--fbfi-fg);
    }
    #uc-fbfi-settings .fbfi-details-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
      color: var(--fbfi-fg);
    }
    #uc-fbfi-settings .fbfi-details-body p {
      margin: 0;
    }
    #uc-fbfi-settings .fbfi-meta {
      color: var(--fbfi-muted);
    }
    #uc-fbfi-settings .fbfi-errors {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #uc-fbfi-settings .fbfi-errors li {
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--fbfi-surface);
      border: 1px solid var(--fbfi-line);
    }
    #uc-fbfi-settings .fbfi-errors pre {
      margin: 6px 0 0;
      white-space: pre-wrap;
      word-break: break-all;
      font-size: 11px;
      color: var(--fbfi-muted);
    }
    #uc-fbfi-settings .fbfi-children {
      grid-column: 1 / -1;
      margin: 4px 0 -4px;
      padding-inline-start: 14px;
      border-inline-start: 2px solid var(--fbfi-line);
    }
    #uc-fbfi-settings .fbfi-subrow {
      padding: 8px 0;
    }
    #uc-fbfi-settings .fbfi-subrow .fbfi-name {
      font-weight: 500;
    }
    #uc-fbfi-settings .fbfi-row[data-parent-off] > :not(.fbfi-children) {
      opacity: 0.5;
    }
    #uc-fbfi-settings .fbfi-row-actions {
      display: flex;
      gap: 8px;
    }

    /* ---- switch ---- */
    #uc-fbfi-settings .fbfi-switch {
      position: relative;
      display: inline-block;
      flex: none;
      width: 36px;
      height: 20px;
      margin-top: 1px;
    }
    #uc-fbfi-settings .fbfi-switch-input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      opacity: 0;
      z-index: 1;
    }
    #uc-fbfi-settings .fbfi-switch-track {
      position: absolute;
      inset: 0;
      border-radius: 10px;
      background: color-mix(in srgb, var(--fbfi-fg) 28%, transparent);
      transition: background-color 120ms;
      pointer-events: none;
    }
    #uc-fbfi-settings .fbfi-switch-track::after {
      content: "";
      position: absolute;
      top: 3px;
      inset-inline-start: 3px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
      transition: transform 120ms;
    }
    #uc-fbfi-settings .fbfi-switch-input:checked + .fbfi-switch-track {
      background: var(--fbfi-accent);
    }
    #uc-fbfi-settings .fbfi-switch-input:checked + .fbfi-switch-track::after {
      transform: translateX(16px);
    }
    #uc-fbfi-settings .fbfi-switch-input:checked + .fbfi-switch-track:-moz-locale-dir(rtl)::after {
      transform: translateX(-16px);
    }
    #uc-fbfi-settings .fbfi-switch-input:focus-visible + .fbfi-switch-track {
      outline: 2px solid var(--fbfi-accent);
      outline-offset: 2px;
    }
    #uc-fbfi-settings .fbfi-switch-input:disabled + .fbfi-switch-track {
      opacity: 0.45;
    }

    /* ---- buttons and footer ---- */
    #uc-fbfi-settings .fbfi-btn {
      appearance: none;
      padding: 5px 12px;
      border: 1px solid var(--fbfi-line);
      border-radius: 6px;
      background: var(--button-background-color, var(--fbfi-surface));
      color: inherit;
      font: inherit;
      white-space: nowrap;
      cursor: default;
    }
    #uc-fbfi-settings .fbfi-btn:hover {
      background: var(--button-background-color-hover, var(--fbfi-hover));
    }
    #uc-fbfi-settings .fbfi-btn[data-armed] {
      border-color: var(--fbfi-bad);
      color: var(--fbfi-bad);
    }
    #uc-fbfi-settings .fbfi-footer {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 20px 12px 24px;
      border-top: 1px solid var(--fbfi-line);
    }
    #uc-fbfi-settings .fbfi-hint {
      flex: 1;
      margin: 0;
      color: var(--fbfi-muted);
      font-size: 12px;
    }
    #uc-fbfi-settings .fbfi-toast {
      color: var(--fbfi-good);
      font-size: 12px;
    }
    #uc-fbfi-settings .fbfi-empty {
      margin: 32px 0;
      text-align: center;
      color: var(--fbfi-muted);
    }

    @media (max-width: 760px) {
      #uc-fbfi-settings .fbfi-body {
        grid-template-columns: 1fr;
      }
      #uc-fbfi-settings .fbfi-nav {
        display: none;
      }
      #uc-fbfi-settings .fbfi-hint {
        display: none;
      }
      #uc-fbfi-settings .fbfi-content {
        padding-inline: 16px;
      }
    }

    /* The optional toolbar button. */
    #uc-fbfi-button {
      list-style-image: url("chrome://global/skin/icons/settings.svg");
    }
  `;

  const Settings = (() => {
    const DIALOG_ID = "uc-fbfi-settings";
    let dialog = null;
    let parts = null;      // references into the open dialog
    let unsubscribe = null;
    let filterText = "";
    let problemsOnly = false;

    function h(tag, props, ...kids) {
      const el = document.createElementNS(XHTML_NS, tag);
      for (const [key, value] of Object.entries(props ?? {})) {
        if (value == null || value === false) continue;
        if (key === "class") el.className = value;
        else if (key === "text") el.textContent = value;
        else if (key === "dataset") Object.assign(el.dataset, value);
        else if (key.startsWith("on")) el.addEventListener(key.slice(2), safe(value));
        else el.setAttribute(key, value === true ? "" : value);
      }
      for (const kid of kids.flat()) {
        if (kid != null && kid !== false) el.append(kid);
      }
      return el;
    }

    // UI handlers never throw into the browser.
    function safe(fn) {
      return function (...args) {
        try {
          return fn.apply(this, args);
        } catch (e) {
          console.error(LOG, "settings page:", e);
          toast("Something went wrong; see the Browser Console.", true);
          return undefined;
        }
      };
    }

    let toastTimer = 0;
    function toast(text, bad = false) {
      const el = parts?.toast;
      if (!el) return;
      el.textContent = text;
      el.style.color = bad ? "var(--fbfi-bad)" : "";
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.textContent = ""; }, 3000);
    }

    // ---- building ----

    function buildRow(f) {
      const isChild = !!f.def.parent;
      const inputId = `fbfi-toggle-${f.id}`;
      const toggle = h("input", {
        type: "checkbox",
        role: "switch",
        id: inputId,
        class: "fbfi-switch-input",
        onchange: (e) => setEnabled(f, e.target.checked),
      });
      const pill = h("span", { class: "fbfi-pill" });
      const issue = h("div", { class: "fbfi-issue", role: "status", hidden: true });
      const detailsBody = h("div", { class: "fbfi-details-body" });
      const details = h("details", { class: "fbfi-details" }, h("summary", { text: "Details" }), detailsBody);
      // Sub-settings go in their own list under the parent's text.
      const children = isChild ? null : h("div", { class: "fbfi-children", role: "group", "aria-label": `${f.def.name} options`, hidden: true });
      const row = h("div", { class: isChild ? "fbfi-row fbfi-subrow" : "fbfi-row", dataset: { id: f.id } },
        h("div", { class: "fbfi-row-text" },
          h("label", { class: "fbfi-name", for: inputId, text: f.def.name }),
          h("p", { class: "fbfi-desc", text: f.def.description }),
          issue,
          details),
        pill,
        h("span", { class: "fbfi-switch" }, toggle, h("span", { class: "fbfi-switch-track", "aria-hidden": "true" })),
        children);
      return { f, row, toggle, pill, issue, details, detailsBody, children, subRows: [], signature: "" };
    }

    function renderDetails(r) {
      const f = r.f;
      const body = r.detailsBody;
      body.replaceChildren();
      if (f.warnings.length) {
        body.append(h("ul", { class: "fbfi-errors" }, f.warnings.map(w => h("li", { text: w }))));
      }
      if (f.errors.length) {
        body.append(h("ul", { class: "fbfi-errors" }, [...f.errors].reverse().map(e =>
          h("li", {},
            h("div", {}, h("strong", { text: new Date(e.time).toLocaleTimeString() }), ` · ${e.where}`),
            h("div", { text: e.message }),
            e.stack ? h("pre", { text: e.stack.split("\n").slice(0, 6).join("\n") }) : null)
        )));
      }
      const canRetry = f.enabled && !Prefs.paused() &&
        [STATUS.FAILED, STATUS.ERROR, STATUS.UNAVAILABLE, STATUS.WARN].includes(f.status);
      body.append(h("div", { class: "fbfi-row-actions" },
        canRetry ? h("button", {
          class: "fbfi-btn",
          text: "Try again",
          onclick: () => {
            retry(f);
            toast(`Restarted ${f.def.name}`);
          },
        }) : null,
        h("button", {
          class: "fbfi-btn",
          text: "Copy details",
          onclick: () => {
            copyText(JSON.stringify({
              id: f.id, status: f.status, reason: f.reason, warnings: f.warnings, errors: f.errors, ...versionInfo(),
            }, null, 2));
            toast("Copied");
          },
        })));
      // Only when there's something to see or do.
      r.details.hidden = !f.warnings.length && !f.errors.length && !canRetry;
    }

    function build() {
      const summary = h("div", { class: "fbfi-summary", "aria-live": "polite" });
      const v = versionInfo();
      const updateStatus = h("span", { class: "fbfi-update-status", role: "status" });
      const checkBtn = h("button", {
        class: "fbfi-link",
        type: "button",
        text: "Check for updates",
        onclick: () => Updates.check(),
      });
      const autoInput = h("input", {
        type: "checkbox",
        id: "fbfi-update-auto",
        onchange: (e) => Updates.setAuto(e.target.checked),
      });
      const header = h("header", { class: "fbfi-header" },
        h("div", { class: "fbfi-heading" },
          h("h1", { id: "fbfi-title", text: "Floorp Bug Fixes & Improvements" }),
          h("p", {
            class: "fbfi-sub",
            text: [`Version ${v.script}`, v.floorp && `Floorp ${v.floorp}`, v.firefox && `Firefox ${v.firefox}`,
              v.loader && `fx-autoconfig ${v.loader}`].filter(Boolean).join(" · "),
          }),
          h("div", { class: "fbfi-update" },
            updateStatus,
            checkBtn,
            h("span", { class: "fbfi-update-auto" },
              autoInput,
              h("label", { for: "fbfi-update-auto", text: "Check every 12 hours" })))),
        summary,
        h("button", { class: "fbfi-icon-btn", title: "Close", "aria-label": "Close", onclick: close }));

      const search = h("input", {
        class: "fbfi-search",
        type: "search",
        placeholder: "Find a setting",
        "aria-label": "Find a setting",
        autofocus: true, // the dialog focuses this when it opens
        oninput: (e) => {
          filterText = e.target.value.trim().toLowerCase();
          applyFilter();
        },
      });

      const navItems = new Map();
      const sections = new Map();
      const rows = new Map();
      const content = h("main", { class: "fbfi-content" });
      const banners = h("div", { class: "fbfi-banners" });
      content.append(banners);

      for (const cat of CATEGORIES) {
        const list = features.filter(f => f.def.category === cat.id);
        if (!list.length) continue;
        const card = h("div", { class: "fbfi-card" });
        for (const f of list.filter(f => !f.def.parent)) {
          const r = buildRow(f);
          rows.set(f.id, r);
          card.append(r.row);
          for (const child of list.filter(c => c.def.parent === f.id)) {
            const cr = buildRow(child);
            rows.set(child.id, cr);
            r.subRows.push(cr);
            r.children.append(cr.row);
          }
          r.children.hidden = !r.subRows.length;
        }
        const section = h("section", { class: "fbfi-section", id: `fbfi-cat-${cat.id}`, "aria-labelledby": `fbfi-h-${cat.id}` },
          h("h2", { id: `fbfi-h-${cat.id}`, text: cat.name }),
          h("p", { class: "fbfi-section-desc", text: cat.description }),
          card);
        sections.set(cat.id, section);
        content.append(section);

        const count = h("span", { class: "fbfi-nav-count" });
        const item = h("button", {
          class: "fbfi-nav-item",
          type: "button",
          onclick: () => {
            if (problemsOnly) setProblemsOnly(false);
            section.scrollIntoView({ block: "start", behavior: "smooth" });
            for (const [id, n] of navItems) n.item.setAttribute("aria-current", id === cat.id ? "true" : "false");
          },
        }, h("span", { class: "fbfi-nav-label", text: cat.name }), count);
        navItems.set(cat.id, { item, count, list });
      }
      const empty = h("p", { class: "fbfi-empty", text: "Nothing matches.", hidden: true });
      content.append(empty);

      const problemsCount = h("span", { class: "fbfi-nav-count" });
      const problemsItem = h("button", {
        class: "fbfi-nav-item fbfi-nav-problems",
        type: "button",
        hidden: true,
        onclick: () => setProblemsOnly(!problemsOnly),
      }, h("span", { class: "fbfi-nav-label", text: "Problems" }), problemsCount);

      const nav = h("nav", { class: "fbfi-nav", "aria-label": "Categories" },
        search, [...navItems.values()].map(n => n.item), problemsItem);

      const toastEl = h("span", { class: "fbfi-toast", role: "status" });
      const resetBtn = h("button", {
        class: "fbfi-btn",
        type: "button",
        text: "Reset to defaults",
        onclick: (e) => {
          const btn = e.currentTarget;
          if (!btn.hasAttribute("data-armed")) {
            btn.setAttribute("data-armed", "");
            btn.textContent = "Click again to reset";
            setTimeout(() => {
              btn.removeAttribute("data-armed");
              btn.textContent = "Reset to defaults";
            }, 4000);
            return;
          }
          btn.removeAttribute("data-armed");
          btn.textContent = "Reset to defaults";
          Prefs.resetAll();
          toast("Reset to defaults");
        },
      });
      const footer = h("footer", { class: "fbfi-footer" },
        h("p", { class: "fbfi-hint", text: "Changes apply right away in every window." }),
        toastEl,
        h("button", { class: "fbfi-btn", type: "button", text: "Browser Console", onclick: openBrowserConsole }),
        h("button", {
          class: "fbfi-btn",
          type: "button",
          text: "Copy diagnostics",
          onclick: () => {
            copyText(diagnostics());
            toast("Diagnostics copied");
          },
        }),
        resetBtn);

      const d = h("dialog", { id: DIALOG_ID, "aria-labelledby": "fbfi-title" },
        header,
        h("div", { class: "fbfi-body" }, nav, content),
        footer);

      // A click that lands on the dialog itself is on the backdrop.
      d.addEventListener("click", safe((e) => {
        if (e.target === d) close();
      }));
      d.addEventListener("close", safe(() => teardown()));

      parts = {
        summary, banners, rows, sections, navItems, problemsItem, problemsCount, empty, toast: toastEl, search, content,
        updateStatus, checkBtn, autoInput,
      };
      return d;
    }

    // ---- updating ----

    function updateRow(r) {
      const f = r.f;
      const paused = Prefs.paused();
      const parent = f.def.parent && featureById.get(f.def.parent);
      const parentOff = !!parent && !parent.enabled;
      r.toggle.checked = f.enabled;
      r.toggle.disabled = paused || parentOff;
      r.row.toggleAttribute("data-parent-off", parentOff);
      r.row.dataset.status = f.status;
      r.row.dataset.tone = STATUS_TONE[f.status] ?? "neutral";
      r.pill.textContent = STATUS_TEXT[f.status] ?? f.status;
      r.pill.hidden = parentOff;
      const issue = parentOff ? "" : issueText(f);
      r.issue.hidden = !issue;
      r.issue.textContent = issue;
      const signature = JSON.stringify([f.status, f.errorCount, f.warnings.length, f.reason, f.enabled, paused]);
      if (signature !== r.signature) {
        r.signature = signature;
        renderDetails(r);
      }
    }

    function banner(tone, title, text, ...actions) {
      return h("div", { class: "fbfi-banner", dataset: { tone }, role: tone === "bad" ? "alert" : "status" },
        h("div", { class: "fbfi-banner-text" }, h("strong", { text: title }), h("p", {}, text)),
        ...actions);
    }

    function updateBanners() {
      const list = [];
      const u = Updates.state();
      if (u.available) {
        list.push(banner("info", `Version ${u.latest} is available`,
          `You have ${VERSION}. Download the new file from GitHub and put it in your profile's chrome/JS folder in place of this one, then clear the startup cache in about:support and restart.`,
          h("button", {
            class: "fbfi-btn",
            type: "button",
            text: "Get it on GitHub",
            onclick: () => {
              Updates.openPage();
              close();
            },
          }),
          h("button", { class: "fbfi-btn", type: "button", text: "Open chrome folder", onclick: openChromeFolder })));
      }
      if (Prefs.paused()) {
        list.push(banner("neutral", "Everything is paused",
          "All features are off until you resume them. Your choices below are kept.",
          h("button", { class: "fbfi-btn", type: "button", text: "Resume", onclick: () => Prefs.setPaused(false) })));
      }
      const old = Standalone.installed();
      if (old.length) {
        list.push(banner("warn", "Old standalone scripts are still installed",
          [
            `This file replaces them, so their features are skipped here to avoid running twice: `,
            h("code", { text: old.join(", ") }),
            ". Delete them from your profile's chrome folder, then clear the startup cache in about:support and restart.",
          ],
          h("button", { class: "fbfi-btn", type: "button", text: "Open chrome folder", onclick: openChromeFolder })));
      }
      const c = counts();
      if (c.problems) {
        list.push(banner("bad", `${plural(c.problems, "feature")} ${c.problems === 1 ? "has" : "have"} a problem`,
          "Turning a feature off and on again, or Try again under its Details, restarts it. If it keeps failing after a Floorp update, Copy diagnostics and report it.",
          h("button", {
            class: "fbfi-btn",
            type: "button",
            text: problemsOnly ? "Show all" : "Show problems",
            onclick: () => setProblemsOnly(!problemsOnly),
          })));
      }
      parts.banners.replaceChildren(...list);
    }

    function updateSummary() {
      const c = counts();
      const chips = [
        h("span", { class: "fbfi-chip", text: `${c.on} on` }),
        h("span", { class: "fbfi-chip", text: `${c.off} off` }),
        c.problems
          ? h("span", { class: "fbfi-chip", dataset: { tone: "bad" }, text: plural(c.problems, "problem") })
          : h("span", { class: "fbfi-chip", dataset: { tone: "good" }, text: "No problems" }),
      ];
      parts.summary.replaceChildren(...chips);
      for (const { count, list } of parts.navItems.values()) {
        count.textContent = `${list.filter(f => f.running).length}/${list.length}`;
      }
      parts.problemsItem.hidden = !c.problems && !problemsOnly;
      parts.problemsCount.textContent = String(c.problems);
      parts.problemsItem.setAttribute("aria-current", problemsOnly ? "true" : "false");
    }

    function setProblemsOnly(value) {
      problemsOnly = value;
      applyFilter();
      update();
      if (parts) parts.content.scrollTop = 0;
    }

    function applyFilter() {
      if (!parts) return;
      let any = false;
      for (const section of parts.sections.values()) {
        let visible = 0;
        const matches = (r) => {
          const text = `${r.f.def.name} ${r.f.def.description} ${r.f.id}`.toLowerCase();
          return (!filterText || text.includes(filterText)) &&
            (!problemsOnly || r.f.hasProblem || r.f.status === STATUS.WARN);
        };
        for (const row of section.querySelectorAll(".fbfi-row:not(.fbfi-subrow)")) {
          const r = parts.rows.get(row.dataset.id);
          const show = matches(r) || r.subRows.some(matches);
          row.hidden = !show;
          if (show) visible++;
        }
        section.hidden = !visible;
        if (visible) any = true;
      }
      parts.empty.hidden = any;
    }

    function ago(seconds) {
      const s = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
      if (s < 60) return "just now";
      if (s < 3600) return plural(Math.floor(s / 60), "minute") + " ago";
      if (s < 86400) return plural(Math.floor(s / 3600), "hour") + " ago";
      return plural(Math.floor(s / 86400), "day") + " ago";
    }

    function updateUpdateLine() {
      const u = Updates.state();
      let text;
      let tone = "";
      if (u.checking) {
        text = "Checking for updates…";
      } else if (!VERSION) {
        text = "Can't check for updates: fx-autoconfig didn't report this file's version";
        tone = "bad";
      } else if (u.available) {
        text = `Version ${u.latest} is available`;
        tone = "info";
      } else if (u.error) {
        text = `Couldn't check for updates: ${u.error}`;
        tone = "bad";
      } else if (u.lastCheck) {
        text = `Up to date · checked ${ago(u.lastCheck)}`;
      } else {
        text = "Not checked for updates yet";
      }
      parts.updateStatus.textContent = text;
      if (tone) parts.updateStatus.dataset.tone = tone;
      else delete parts.updateStatus.dataset.tone;
      parts.checkBtn.disabled = u.checking;
      parts.autoInput.checked = u.auto;
    }

    function update() {
      if (!parts) return;
      for (const r of parts.rows.values()) updateRow(r);
      updateSummary();
      updateBanners();
      updateUpdateLine();
      if (problemsOnly) applyFilter();
    }

    // ---- actions ----

    function openBrowserConsole() {
      try {
        const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
        require("devtools/client/webconsole/browser-console-manager").BrowserConsoleManager.openBrowserConsoleOrFocus();
      } catch (e) {
        toast("Press Ctrl+Shift+J to open the Browser Console", true);
      }
    }

    function openChromeFolder() {
      try {
        const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
        dir.launch();
      } catch (e) {
        toast("Couldn't open the folder; find it via about:support → Profile Folder", true);
      }
    }

    // ---- open and close ----

    function open() {
      if (dialog?.isConnected) {
        parts?.search?.focus();
        return;
      }
      try {
        filterText = "";
        problemsOnly = false;
        dialog = build();
        (document.body ?? document.documentElement).append(dialog);
        unsubscribe = onChanged(update);
        update();
        try {
          dialog.showModal();
        } catch (e) {
          dialog.classList.add("fbfi-fallback");
          dialog.setAttribute("open", "");
        }
      } catch (e) {
        console.error(LOG, "couldn't open the settings page", e);
        teardown();
      }
    }

    function teardown() {
      unsubscribe?.();
      unsubscribe = null;
      clearTimeout(toastTimer);
      const d = dialog;
      dialog = null;
      parts = null;
      if (d?.isConnected) {
        try {
          if (d.open) d.close();
        } catch (e) {}
        d.remove();
      }
    }

    function close() {
      teardown();
    }

    return { open, close, get isOpen() { return !!dialog; } };
  })();

  // ---- ways to open it ----

  const WIDGET_ID = "uc-fbfi-button";
  const MENU_LABEL = "Floorp Bug Fixes & Improvements";

  function installEntryPoints() {
    const openSettings = () => Settings.open();
    const items = [];

    // Tools menu, after "Add-ons and Themes".
    const tools = document.getElementById("menu_ToolsPopup");
    if (tools) {
      const item = document.createXULElement("menuitem");
      item.id = "uc-fbfi-tools-menuitem";
      item.setAttribute("label", MENU_LABEL);
      item.addEventListener("command", openSettings);
      const addons = document.getElementById("menu_openAddons");
      if (addons?.parentNode === tools) addons.after(item);
      else tools.append(item);
      items.push(item);
    }

    // Right-clicking the tab bar or any toolbar.
    const toolbarMenu = document.getElementById("toolbar-context-menu");
    if (toolbarMenu) {
      const sep = document.createXULElement("menuseparator");
      sep.id = "uc-fbfi-toolbar-separator";
      const item = document.createXULElement("menuitem");
      item.id = "uc-fbfi-toolbar-menuitem";
      item.setAttribute("label", MENU_LABEL);
      item.addEventListener("command", openSettings);
      toolbarMenu.append(sep, item);
      items.push(item);
    }

    // A toolbar button, available from Customize Toolbar. Widgets are global,
    // so it's created once for the session.
    try {
      if (CustomizableUI.getWidget(WIDGET_ID)?.provider !== CustomizableUI.PROVIDER_API) {
        CustomizableUI.createWidget({
          id: WIDGET_ID,
          type: "button",
          label: MENU_LABEL,
          tooltiptext: `${MENU_LABEL} settings`,
          onCommand(event) {
            event.target.ownerDocument?.defaultView?.UCFloorpImprovements?.openSettings();
          },
        });
      }
    } catch (e) {
      console.warn(LOG, "couldn't create the toolbar button", e);
    }

    // Labels mention problems and an available update, so they're noticed
    // without opening the page: "(2 problems, update available)".
    const updateLabels = () => {
      const { problems } = counts();
      const notes = [];
      if (problems) notes.push(plural(problems, "problem"));
      if (Updates.state().available) notes.push("update available");
      const note = notes.join(", ");
      const label = note ? `${MENU_LABEL} (${note[0].toUpperCase()}${note.slice(1)})` : MENU_LABEL;
      for (const item of items) item.setAttribute("label", label);
      const button = document.getElementById(WIDGET_ID);
      if (button) {
        button.setAttribute("tooltiptext", note ? `${label}: open settings` : `${MENU_LABEL} settings`);
      }
    };
    onChanged(updateLabels);
    updateLabels();
  }

  // ============================================================ 8. startup ==

  function desiredState(f) {
    if (Prefs.paused()) return { status: STATUS.PAUSED };
    if (!f.enabled) return { status: STATUS.OFF };
    const standalone = (f.def.standalone ?? []).find(file => Standalone.running(file));
    if (standalone) return { status: STATUS.SKIPPED, reason: standalone };
    // A sub-setting runs only while its parent does (parents are reconciled
    // first, being defined first).
    const parent = f.def.parent && featureById.get(f.def.parent);
    if (parent && !parent.running && parent.status !== STATUS.SKIPPED) {
      return { status: STATUS.WAITING, reason: [parent.id] };
    }
    const missing = (f.def.requires ?? []).filter(id => !featureById.get(id)?.enabled);
    if (missing.length) return { status: STATUS.WAITING, reason: missing };
    return { run: true };
  }

  function start(f) {
    f.status = STATUS.STARTING;
    f.reason = "";
    f.warnings = [];
    f.errors = [];
    f.errorCount = 0;
    const ctx = new Context(f);
    f.ctx = ctx;
    try {
      const result = f.def.init(ctx);
      if (result && typeof result.then === "function") ctx.async(result, "starting up");
    } catch (e) {
      f.ctx = null;
      ctx.dispose();
      if (e instanceof Unavailable) {
        f.status = STATUS.UNAVAILABLE;
        f.reason = e.message;
        console.warn(`${LOG} ${f.id} is unavailable: ${e.message}`);
      } else {
        f.status = STATUS.FAILED;
        f.reason = errorMessage(e);
        f.recordError(e, "starting up");
      }
      return;
    }
    if (f.status === STATUS.STARTING) {
      f.status = f.errorCount ? STATUS.ERROR : f.warnings.length ? STATUS.WARN : STATUS.ON;
    }
  }

  function stop(f) {
    const ctx = f.ctx;
    f.ctx = null;
    ctx?.dispose();
  }

  // Brings every feature in line with the settings. A feature that failed
  // or was unavailable stays that way until it's turned off and on, paused
  // and resumed, or retried from the settings page, rather than retrying on
  // every unrelated change.
  function reconcile() {
    for (const f of features) {
      const want = desiredState(f);
      if (want.run) {
        const stuck = f.status === STATUS.FAILED || f.status === STATUS.UNAVAILABLE;
        if (!f.ctx && !stuck) start(f);
      } else {
        if (f.ctx) stop(f);
        f.status = want.status;
        f.reason = want.reason ?? "";
        f.warnings = [];
      }
    }
    notifyChanged();
  }

  let reconcileQueued = false;
  function scheduleReconcile() {
    if (reconcileQueued) return;
    reconcileQueued = true;
    Promise.resolve().then(() => {
      reconcileQueued = false;
      try {
        reconcile();
      } catch (e) {
        console.error(LOG, "applying settings failed", e);
      }
    });
  }

  const prefObserver = { observe: scheduleReconcile };

  function shutdown() {
    try {
      Services.prefs.removeObserver(PREF_ROOT, prefObserver);
    } catch (e) {}
    Settings.close();
    for (const f of features) {
      if (f.ctx) stop(f);
    }
  }

  function logSummary() {
    const c = counts();
    const problems = features.filter(f => f.hasProblem)
      .map(f => `${f.id} (${STATUS_TEXT[f.status]}: ${f.reason || f.errors.at(-1)?.message || ""})`);
    const skipped = features.filter(f => f.status === STATUS.SKIPPED).map(f => f.id);
    console.log(`${LOG} ${VERSION || "(version unknown)"} running: ${c.on} on, ${c.off} off` +
      (skipped.length ? `; skipped (old scripts installed): ${skipped.join(", ")}` : "") +
      (problems.length ? `; problems: ${problems.join("; ")}` : ""));
  }

  function startup() {
    try {
      Styles.add(SETTINGS_CSS, "settings page");
    } catch (e) {
      console.error(LOG, "couldn't add the settings page styles", e);
    }
    Prefs.migrateRenamed();
    Standalone.detect();
    try {
      reconcile();
    } catch (e) {
      console.error(LOG, "starting features failed", e);
    }
    try {
      installEntryPoints();
    } catch (e) {
      console.error(LOG, "couldn't add the settings menu items", e);
    }
    Services.prefs.addObserver(PREF_ROOT, prefObserver);
    window.addEventListener("unload", shutdown, { once: true });
    try {
      Updates.start();
    } catch (e) {
      console.error(LOG, "couldn't start the update check", e);
    }
    logSummary();
  }

  window.UCFloorpImprovements = Object.freeze({
    version: VERSION,
    openSettings: () => Settings.open(),
    closeSettings: () => Settings.close(),
    features: () => features.map(f => ({
      id: f.id,
      category: f.def.category,
      name: f.def.name,
      enabled: f.enabled,
      status: f.status,
      reason: f.reason,
      warnings: [...f.warnings],
      errors: f.errors.map(e => ({ ...e })),
    })),
    diagnostics,
    hooks: () => Hooks.report(),
  });

  if (gBrowserInit?.delayedStartupFinished) {
    startup();
  } else {
    const observer = (subject) => {
      if (subject !== window) return;
      Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
      startup();
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  }
})();
