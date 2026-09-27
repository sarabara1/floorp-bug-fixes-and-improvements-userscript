// ==UserScript==
// @name           stacktab-newtab-expand-animation.uc.js
// @description    Stack tabs: expand animation on new-tab creation
// @include        main
// ==/UserScript==

// The native tab bar animates a newly-created tab open by growing its width
// (a min-width/max-width transition on `#tabbrowser-tabs .tabbrowser-tab`, see
// the `--tab-width-transition` rule in the inspector). A stack strip's visual
// tabs are `.floorp-stack-tab` elements inside `#floorp-stack-items` — a
// SEPARATE container from `#tabbrowser-tabs` — so that native rule never
// applies and stack tabs just pop in at full width.
//
// This replays the same grow-from-zero reveal, but ONLY for a genuinely new
// tab. The catch: the strip is fully rebuilt on stack expand / stack switch
// (the visual tabs are torn down and re-created, and the `#floorp-stack-items`
// element is REUSED), so a naive "animate any added node" — or even "animate
// when one id is new" — would replay the animation on every stack switch. To
// avoid that we key on tab IDENTITY and require CONTINUITY, not DOM churn:
//
//   - Each visual tab carries a stable `data-floorp-drag-id`.
//   - We remember the set of ids currently rendered in the strip.
//   - A real new-tab ADD keeps every previous id and introduces exactly one
//     more (current === knownIds + 1). A stack switch REPLACES the ids, so the
//     old ones are gone.
//   - We animate ONLY when exactly one id is new AND every previously-rendered
//     id is still present. That "all previous ids kept" test is what tells an
//     add apart from a switch — crucially even when switching TO a single-tab
//     stack, which also shows "one new id" but drops all the old ones. First
//     build, rebuild, and stack switch all just resync silently.
//
// Result: opening/switching stacks is still instant; creating a tab in a stack
// grows it in like the main tab bar.

(function () {
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
  const DURATION = 120; // ms — close to native's ~100ms width transition

  const idsOf = (items) => {
    const set = new Set();
    for (const el of items.querySelectorAll(".floorp-stack-tab[data-floorp-drag-id]")) {
      set.add(el.getAttribute("data-floorp-drag-id"));
    }
    return set;
  };

  function animateIn(tab) {
    if (REDUCED.matches) return;
    const full = tab.getBoundingClientRect().width;
    if (!full) return; // not laid out yet — skip rather than animate from/to 0

    // Collapse to zero width with no transition, force a reflow, then transition
    // out to the measured natural width. min-width is pinned to 0 for the
    // duration so flex/min-width can't fight the max-width reveal.
    tab.style.transition = "none";
    tab.style.overflow = "hidden";
    tab.style.minWidth = "0";
    tab.style.maxWidth = "0";
    tab.style.opacity = "0";
    void tab.offsetWidth; // reflow so the collapsed state is committed

    tab.style.transition =
      `max-width ${DURATION}ms ease-out, opacity ${DURATION}ms ease-out`;
    tab.style.maxWidth = full + "px";
    tab.style.opacity = "1";

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      // Hand width control back to the stylesheet.
      for (const p of ["transition", "overflow", "minWidth", "maxWidth", "opacity"]) {
        tab.style[p] = "";
      }
      tab.removeEventListener("transitionend", onEnd);
    };
    const onEnd = (e) => { if (e.target === tab && e.propertyName === "max-width") cleanup(); };
    tab.addEventListener("transitionend", onEnd);
    setTimeout(cleanup, DURATION + 200); // fallback if transitionend doesn't fire
  }

  function init() {
    let knownIds = new Set();

    function sync() {
      const items = document.getElementById("floorp-stack-items");
      if (!items) { knownIds = new Set(); return; }

      const current = idsOf(items);

      // A genuine new tab is an ADD: every previously-rendered id is still here
      // and exactly one id is new (current === knownIds + 1). A stack switch
      // REPLACES the ids instead, so the old ids are gone — that fails the
      // "all previous ids still present" test even when the new stack holds a
      // single tab (which otherwise also looks like "one new id"). Requiring
      // continuity, not the strip element being reused, is what tells them
      // apart, so we don't gate on knownItems here.
      if (knownIds.size > 0) {
        const newIds = [...current].filter((id) => !knownIds.has(id));
        const allPrevKept = [...knownIds].every((id) => current.has(id));
        if (newIds.length === 1 && allPrevKept) {
          const tab = items.querySelector(
            `.floorp-stack-tab[data-floorp-drag-id="${CSS.escape(newIds[0])}"]`
          );
          if (tab) animateIn(tab);
        }
      }

      knownIds = current;
    }

    // Both new tabs and strip rebuilds surface as childList changes under the
    // toolbox; sync() decides which (if any) warrant an animation.
    const toolbox = document.getElementById("navigator-toolbox") || document.documentElement;
    new MutationObserver(sync).observe(toolbox, { childList: true, subtree: true });
    sync();

    console.log("[stack-newtab-anim] loaded");
  }

  if (gBrowserInit && gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const obs = (subject) => {
      if (subject === window) {
        Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
        init();
      }
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
