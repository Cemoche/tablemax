import { ChevronLeft, ChevronRight, Columns2, Plus, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useEffectiveShortcut } from "../../lib/keymap";
import { formatShortcut } from "../../lib/platform";
import { strings } from "../../lib/strings";
import { usePendingChanges } from "../../stores/pendingChanges";
import { type Tab, type Workspace, capabilitiesOf, isQueryModified, useWorkspaces } from "../../stores/workspaces";
import {
  ContextMenu,
  type MenuAnchor,
  type MenuItem,
  keyboardMenuAnchor,
  restoreFocusOnClose,
} from "../sidebar/ContextMenu";
import { TabList } from "./TabList";
import { goBack, goForward, useCanNavigate } from "./navigation";

const S = strings.workspace;
const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent";
const iconButton = `flex size-7 shrink-0 items-center justify-center rounded-md text-icon hover:bg-tab disabled:text-icon-dim disabled:hover:bg-transparent aria-disabled:text-icon-dim aria-disabled:hover:bg-transparent ${focusRing}`;

/**
 * The tab bar (spec §2.3, 38 px): back / forward through the workspace's history, the tabs as
 * capsules sharing the width (at least 120 px each, then the bar scrolls sideways), a new SQL
 * tab, the split button (epic #17, not yet) and the list of all tabs.
 *
 * Keyboard (tablist pattern): one Tab stop on the active tab; ←/→, Home/End move the focus;
 * Enter or Space activates; Delete closes; F2 renames; Shift+F10 or the menu key opens the
 * tab menu (New tab / Close / Close others / Rename…).
 */
export function TabBar({ workspace }: { workspace: Workspace }) {
  const activateTab = useWorkspaces((s) => s.activateTab);
  const closeTab = useWorkspaces((s) => s.closeTab);
  const closeOtherTabs = useWorkspaces((s) => s.closeOtherTabs);
  const pinTab = useWorkspaces((s) => s.pinTab);
  const openQueryTab = useWorkspaces((s) => s.openQueryTab);
  const committing = usePendingChanges((s) => s.committing);
  const backShortcut = formatShortcut(useEffectiveShortcut("nav.back"));
  const forwardShortcut = formatShortcut(useEffectiveShortcut("nav.forward"));
  const can = useCanNavigate(workspace);
  const { id, tabs, activeTabId } = workspace;
  const { sqlEditor } = capabilitiesOf(workspace);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ tabId: string; anchor: MenuAnchor } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  /**
   * Where the focus goes after the next render: the active tab after a close from the
   * keyboard or the menu ("active"), a tab after its rename by Enter or Escape.
   */
  const refocus = useRef<string | null>(null);
  const domId = useId();
  const tabDomId = (tabId: string) => `${domId}-tab-${tabId}`;
  const tabButton = (tabId: string | null) =>
    tabId ? (document.getElementById(tabDomId(tabId)) as HTMLElement | null) : null;

  // The active tab scrolls into view (a shortcut or the tab list may pick a hidden one).
  useLayoutEffect(() => {
    if (!activeTabId) return;
    const el = listRef.current?.querySelector(`[data-tab-id="${CSS.escape(activeTabId)}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  useEffect(() => {
    const to = refocus.current;
    if (!to) return;
    refocus.current = null;
    tabButton(to === "active" ? activeTabId : to)?.focus();
  });

  // A vertical wheel (a mouse without a horizontal wheel) scrolls the tabs sideways.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0 || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /**
   * Asks the focus to go to the new active tab, only when the tabs really closed: a close
   * waiting for "Discard pending changes?" (or refused while committing) leaves the focus to
   * the dialog, and nothing is left pending to take it later.
   */
  const focusActiveIfClosed = (closed: () => boolean) => {
    refocus.current = closed() && !useWorkspaces.getState().closeRequest ? "active" : null;
  };
  const tabIds = () => useWorkspaces.getState().workspaces.find((w) => w.id === id)?.tabs.map((t) => t.id) ?? [];
  const close = (tabId: string) => {
    closeTab(id, tabId);
    focusActiveIfClosed(() => !tabIds().includes(tabId));
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, t: Tab) => {
    const anchor = keyboardMenuAnchor(e);
    if (anchor) {
      setMenu({ tabId: t.id, anchor });
      return;
    }
    const i = tabs.findIndex((x) => x.id === t.id);
    let to: number | null = null;
    if (e.key === "ArrowRight") to = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") to = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = tabs.length - 1;
    else if (e.key === "Delete") {
      e.preventDefault();
      if (committing[t.id] !== true) close(t.id);
      return;
    } else if (e.key === "F2") {
      e.preventDefault();
      setRenaming(t.id);
      return;
    } else return;
    e.preventDefault();
    tabButton(tabs[to].id)?.focus();
  };

  const menuItems = (tabId: string): MenuItem[] => [
    ...(sqlEditor ? [{ label: S.tabMenu.newTab, run: () => openQueryTab(id) }] : []),
    ...(committing[tabId] === true ? [] : [{ label: S.tabMenu.close, run: () => close(tabId) }]),
    ...(tabs.length > 1
      ? [
          {
            label: S.tabMenu.closeOthers,
            run: () => {
              const before = tabIds().length;
              closeOtherTabs(id, tabId);
              focusActiveIfClosed(() => tabIds().length < before);
            },
          },
        ]
      : []),
    { label: S.tabMenu.rename, run: () => setRenaming(tabId) },
  ];

  return (
    <div className="flex h-[38px] shrink-0 items-center gap-1 border-b border-sep bg-win px-1.5">
      <button
        type="button"
        aria-label={S.back}
        title={S.backTitle(backShortcut)}
        disabled={!can.back}
        onClick={() => goBack(id)}
        className={iconButton}
      >
        <ChevronLeft aria-hidden="true" size={16} />
      </button>
      <button
        type="button"
        aria-label={S.forward}
        title={S.forwardTitle(forwardShortcut)}
        disabled={!can.forward}
        onClick={() => goForward(id)}
        className={iconButton}
      >
        <ChevronRight aria-hidden="true" size={16} />
      </button>
      <div
        ref={listRef}
        role="tablist"
        aria-label={S.tabsLabel}
        className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto px-0.5 [scrollbar-width:none]"
      >
        {tabs.map((t) => {
          const active = t.id === activeTabId;
          // A running commit must finish before its tab can close.
          const busy = committing[t.id] === true;
          return (
            <div
              key={t.id}
              role="presentation"
              data-tab-id={t.id}
              style={{ flexGrow: 1, flexShrink: 0, flexBasis: 0, minWidth: 120 }}
              className={`group relative flex h-7 min-w-0 items-center rounded-full ${
                active ? "bg-tab-sel text-text" : "bg-tab text-tab-text hover:text-text"
              }`}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault(); // suppress autoscroll
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  if (!busy) closeTab(id, t.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ tabId: t.id, anchor: { x: e.clientX, y: e.clientY } });
              }}
            >
              {renaming === t.id ? (
                <RenameField
                  tab={t}
                  onDone={(name, byKey) => {
                    setRenaming(null);
                    if (name !== null) useWorkspaces.getState().renameTab(id, t.id, name);
                    // Leaving the field by a press elsewhere lets the focus go there.
                    if (byKey) refocus.current = t.id;
                  }}
                />
              ) : (
                <>
                  {/* Mouse only (hidden from assistive tech: a tablist owns tabs only); the
                      keyboard closes with Delete or the tab menu. */}
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    aria-label={S.closeTab(t.title)}
                    title={busy ? strings.grid.closeWhileCommitting : S.closeTab(t.title)}
                    disabled={busy}
                    onClick={() => closeTab(id, t.id)}
                    className={`absolute left-1.5 z-10 flex size-5 items-center justify-center rounded-full text-icon disabled:opacity-40 ${
                      active
                        ? // A lone tab spans the bar, its × on hover only (as the reference, #103).
                          `${tabs.length > 1 ? "opacity-100" : "opacity-0 group-hover:opacity-100"} hover:bg-tab`
                        : "opacity-0 hover:bg-tab-sel group-hover:opacity-100"
                    }`}
                  >
                    <X aria-hidden="true" size={12} />
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id={tabDomId(t.id)}
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    aria-keyshortcuts="Delete F2 Shift+F10"
                    title={t.title}
                    onClick={() => activateTab(id, t.id)}
                    onDoubleClick={() => pinTab(id, t.id)}
                    onKeyDown={(e) => onTabKeyDown(e, t)}
                    className={`flex h-full w-full min-w-0 items-center justify-center gap-1 rounded-full px-7 ${focusRing} focus-visible:-outline-offset-2`}
                  >
                    <span
                      className={`min-w-0 truncate ${active ? "font-medium" : ""} ${
                        t.kind === "table" && t.preview ? "italic" : ""
                      }`}
                    >
                      {t.title}
                    </span>
                    {t.kind === "query" && t.database && workspace.database && t.database !== workspace.database && (
                      <span
                        title={S.tabDatabase(t.database)}
                        className="shrink-0 rounded-sm border border-border px-1 text-xs font-normal not-italic"
                      >
                        {t.database}
                      </span>
                    )}
                    {isQueryModified(t) && (
                      <span aria-hidden="true" title={strings.savedQueries.modified} className="shrink-0 text-warning">
                        {strings.savedQueries.modifiedDot}
                      </span>
                    )}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {sqlEditor && (
        <button
          type="button"
          aria-label={S.newQueryTab}
          title={S.newQueryTab}
          onClick={() => openQueryTab(id)}
          className={iconButton}
        >
          <Plus aria-hidden="true" size={16} />
        </button>
      )}
      <button type="button" aria-label={S.split} aria-disabled="true" title={S.splitSoon} className={iconButton}>
        <Columns2 aria-hidden="true" size={16} />
      </button>
      <TabList workspace={workspace} />
      {menu && (
        <ContextMenu
          label={S.tabMenu.label}
          anchor={menu.anchor}
          items={menuItems(menu.tabId)}
          onClose={(reason) => {
            const tabId = menu.tabId;
            setMenu(null);
            restoreFocusOnClose(reason, () => tabButton(tabId)?.focus());
          }}
        />
      )}
    </div>
  );
}

/**
 * The capsule's name while it is renamed: Enter keeps a non-empty name (an empty one is
 * refused and marked), Escape cancels, leaving the field keeps it (or cancels when empty).
 */
function RenameField({ tab, onDone }: { tab: Tab; onDone: (name: string | null, byKey: boolean) => void }) {
  const [value, setValue] = useState(tab.title);
  const [invalid, setInvalid] = useState(false);
  const done = useRef(false);
  const errorId = useId();
  const finish = (name: string | null, byKey: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(name, byKey);
  };
  return (
    <>
      <input
        aria-label={S.tabMenu.renameLabel}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        value={value}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (value.trim()) finish(value, true);
            else setInvalid(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(null, true);
          }
        }}
        onBlur={() => finish(value.trim() ? value : null, false)}
        className={`h-full w-full min-w-0 rounded-full bg-search px-3 text-center text-text ${focusRing} focus-visible:-outline-offset-2 aria-invalid:outline-danger`}
      />
      {invalid && (
        <span id={errorId} role="alert" className="sr-only">
          {S.tabMenu.renameEmpty}
        </span>
      )}
    </>
  );
}
