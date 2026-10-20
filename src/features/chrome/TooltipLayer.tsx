import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TIP_ATTR, TIP_KEY_ATTR, TIP_OVERFLOW_ATTR } from "../../lib/tooltip";

/** Hover time before a tooltip shows. */
export const TOOLTIP_DELAY_MS = 300;
/** After a tooltip hides, the next one shows at once for this long (warm state). */
export const TOOLTIP_WARM_MS = 500;
/** Space between the control and its tooltip, and kept from the window's edges. */
const GAP = 6;
const MARGIN = 4;

/** Keys that move the focus: the focus they give shows the tooltip of the new control. */
const NAV_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);

interface Shown {
  anchor: HTMLElement;
  label: string;
  shortcut: string | null;
  /** Shown at once (warm state): no entry animation. */
  instant: boolean;
}

function anchorOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(`[${TIP_ATTR}]`) : null;
}

/** Is `el`, or an element inside it, cut (its content wider or taller than its box)? */
function isCut(el: HTMLElement): boolean {
  const cut = (e: Element) =>
    e instanceof HTMLElement && (e.scrollWidth > e.clientWidth || e.scrollHeight > e.clientHeight);
  return cut(el) || [...el.querySelectorAll("*")].some(cut);
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function addDescribedBy(el: HTMLElement, id: string) {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  if (!ids.includes(id)) el.setAttribute("aria-describedby", [...ids, id].join(" "));
}

function removeDescribedBy(el: HTMLElement, id: string) {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((x) => x && x !== id);
  if (ids.length > 0) el.setAttribute("aria-describedby", ids.join(" "));
  else el.removeAttribute("aria-describedby");
}

/**
 * The app's one tooltip (#109), for every element with `{...tip(label, shortcut)}`.
 *
 * - Hover: shows after {@link TOOLTIP_DELAY_MS}; once one has shown, the next control
 *   within {@link TOOLTIP_WARM_MS} shows its own at once.
 * - Keyboard: a focus given by Tab or an arrow key shows it at once (a focus given back
 *   after Escape or Enter, or by a press, does not).
 * - Hides at once on leave, blur, a press (and stays hidden until the pointer leaves that
 *   control), any key but a modifier, scroll, resize and window blur.
 * - Escape with a tooltip shown closes the tooltip only: the key goes no further (the WAI
 *   tooltip pattern), so it never also closes the filter bar or a dialog. Without a shown
 *   tooltip Escape passes on as before.
 * - Below the control, flipped above when the window ends there, kept inside the window
 *   horizontally; it never covers its control. A short fade and slide, none when shown at
 *   once or under `prefers-reduced-motion`.
 * - The control gets `aria-describedby` while it shows; its own name is untouched.
 */
export function TooltipLayer() {
  const id = useId();
  const [shown, setShown] = useState<Shown | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let fromFocus = false;
    let pending: { anchor: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
    let warmUntil = 0;
    /** Pressed or Escaped: no tooltip until the pointer (or the focus) leaves it. */
    let suppressed: HTMLElement | null = null;
    /** The last key moved the focus. */
    let navKey = false;

    const cancel = () => {
      if (pending) clearTimeout(pending.timer);
      pending = null;
    };
    const hide = (warm: boolean) => {
      cancel();
      if (!current) return;
      current = null;
      fromFocus = false;
      if (warm) warmUntil = Date.now() + TOOLTIP_WARM_MS;
      setShown(null);
    };
    const show = (anchor: HTMLElement, instant: boolean, focus: boolean) => {
      cancel();
      const label = anchor.getAttribute(TIP_ATTR);
      if (!label) return;
      // A name's tooltip: only while it is cut.
      if (anchor.hasAttribute(TIP_OVERFLOW_ATTR) && !isCut(anchor)) return;
      current = anchor;
      fromFocus = focus;
      setShown({ anchor, label, shortcut: anchor.getAttribute(TIP_KEY_ATTR) || null, instant });
    };

    const onOver = (e: Event) => {
      if ((e as PointerEvent).pointerType === "touch") return;
      const anchor = anchorOf(e.target);
      if (!anchor || anchor === suppressed || anchor === current || anchor === pending?.anchor) return;
      if (current || Date.now() < warmUntil) return show(anchor, true, false);
      cancel();
      pending = { anchor, timer: setTimeout(() => show(anchor, false, false), TOOLTIP_DELAY_MS) };
    };
    const onOut = (e: Event) => {
      const anchor = anchorOf(e.target);
      if (!anchor) return;
      const to = (e as MouseEvent).relatedTarget;
      if (to instanceof Node && anchor.contains(to)) return;
      if (anchor === suppressed) suppressed = null;
      if (anchor === pending?.anchor) cancel();
      if (anchor === current && !fromFocus) hide(true);
    };
    const onDown = (e: Event) => {
      navKey = false;
      suppressed = anchorOf(e.target);
      hide(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && current) {
        suppressed = current;
        hide(false);
        navKey = false;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      navKey = NAV_KEYS.has(e.key);
      // Only for the focus move this key makes now: an arrow that moves nothing (a caret, a
      // list end) must not make a later programmatic focus look like a keyboard one.
      if (navKey) setTimeout(() => (navKey = false), 0);
      if (!MODIFIERS.has(e.key)) hide(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      const anchor = anchorOf(e.target);
      const byKey = navKey;
      navKey = false;
      if (anchor && byKey && anchor !== suppressed) show(anchor, true, true);
    };
    const onFocusOut = (e: FocusEvent) => {
      const anchor = anchorOf(e.target);
      if (!anchor) return;
      const to = e.relatedTarget;
      if (to instanceof Node && anchor.contains(to)) return;
      if (anchor === suppressed) suppressed = null;
      if (anchor === current && fromFocus) hide(false);
    };
    const onAway = () => hide(false);

    const doc = document;
    doc.addEventListener("pointerover", onOver, true);
    doc.addEventListener("mouseover", onOver, true);
    doc.addEventListener("pointerout", onOut, true);
    doc.addEventListener("mouseout", onOut, true);
    doc.addEventListener("pointerdown", onDown, true);
    doc.addEventListener("mousedown", onDown, true);
    doc.addEventListener("focusin", onFocusIn, true);
    doc.addEventListener("focusout", onFocusOut, true);
    doc.addEventListener("scroll", onAway, true);
    doc.addEventListener("wheel", onAway, { capture: true, passive: true });
    // Window, capture: before any other Escape handler (dialogs, menus, the filter bar).
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onAway);
    window.addEventListener("blur", onAway);
    return () => {
      cancel();
      doc.removeEventListener("pointerover", onOver, true);
      doc.removeEventListener("mouseover", onOver, true);
      doc.removeEventListener("pointerout", onOut, true);
      doc.removeEventListener("mouseout", onOut, true);
      doc.removeEventListener("pointerdown", onDown, true);
      doc.removeEventListener("mousedown", onDown, true);
      doc.removeEventListener("focusin", onFocusIn, true);
      doc.removeEventListener("focusout", onFocusOut, true);
      doc.removeEventListener("scroll", onAway, true);
      doc.removeEventListener("wheel", onAway, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onAway);
      window.removeEventListener("blur", onAway);
    };
  }, []);

  // Follows its control: a new label (a busy state), or gone with it.
  useEffect(() => {
    if (!shown) return;
    const { anchor } = shown;
    const drop = () => setShown((s) => (s?.anchor === anchor ? null : s));
    const attrs = new MutationObserver(() => {
      const label = anchor.getAttribute(TIP_ATTR);
      if (!label) return drop();
      const shortcut = anchor.getAttribute(TIP_KEY_ATTR) || null;
      setShown((s) => (s?.anchor === anchor && (s.label !== label || s.shortcut !== shortcut) ? { ...s, label, shortcut } : s));
    });
    attrs.observe(anchor, { attributes: true, attributeFilter: [TIP_ATTR, TIP_KEY_ATTR] });
    const tree = new MutationObserver(() => {
      if (!anchor.isConnected) drop();
    });
    tree.observe(document.body, { childList: true, subtree: true });
    return () => {
      attrs.disconnect();
      tree.disconnect();
    };
  }, [shown]);

  // Described by the tooltip once its node exists, until it goes.
  const anchor = shown?.anchor ?? null;
  useLayoutEffect(() => {
    if (!anchor) return;
    addDescribedBy(anchor, id);
    return () => removeDescribedBy(anchor, id);
  }, [anchor, id]);

  // Placement, before paint: below, else above; inside the window horizontally.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!shown || !el) return;
    const a = shown.anchor.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = a.bottom + GAP;
    let placement = "bottom";
    if (top + t.height > vh - MARGIN && a.top - GAP - t.height >= MARGIN) {
      top = a.top - GAP - t.height;
      placement = "top";
    }
    const left = Math.max(MARGIN, Math.min(a.left + a.width / 2 - t.width / 2, vw - t.width - MARGIN));
    el.style.top = `${Math.round(top)}px`;
    el.style.left = `${Math.round(left)}px`;
    el.dataset.placement = placement;
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={tipRef}
      id={id}
      role="tooltip"
      data-animate={!shown.instant && !reducedMotion() ? "true" : "false"}
      className="tm-tooltip pointer-events-none fixed top-0 left-0 z-[100] flex max-w-[22rem] items-center gap-2 rounded-md border border-pill-border bg-pill px-2 py-1 text-xs whitespace-pre-line text-text shadow-md"
    >
      <span className="min-w-0 break-words">{shown.label}</span>
      {/* Not rendered between flex items; read between the label and the key. */}
      {shown.shortcut && " "}
      {shown.shortcut && (
        <kbd className="shrink-0 rounded-sm border border-pill-border bg-search px-1 font-sans text-[0.95em] whitespace-nowrap text-text-2">
          {shown.shortcut}
        </kbd>
      )}
    </div>,
    document.body,
  );
}
