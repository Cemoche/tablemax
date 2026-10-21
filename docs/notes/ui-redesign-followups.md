# UI redesign — open follow-ups

What the redesign (epic #77, plan `docs/superpowers/plans/2026-10-19-tablemax-ui-redesign.md`,
Tasks 1–11 and issues #102, #103, #104, #109) leaves open, at the end of Task 11 (#91),
2026-10-21. Items fixed by a later task or review round are left out. The expected
behaviour is the spec `docs/superpowers/specs/2026-10-19-tablemax-ui-redesign-design.md`
and its dated amendments.

## With a GitHub issue

| Issue | What | From |
|---|---|---|
| #105 | Punctuation shortcuts and letter keys that type ASCII on other layouts (AZERTY `,` and `-`: `Ctrl+-` is `Ctrl+6` = tab 6 there; Dvorak; Hebrew) | #102, Task 10 |
| #107 | White text on `--accent` (≈ 4:1) left in context menus, the palette, primary buttons, `TabList`: use `--accent-strong` | #103 |
| #110 | Tooltips of plain `disabled` buttons (Back / Forward, Prev / Next, empty Commit group) may never show under WebKitGTK | #109 |
| #112 | Live network throughput in the status pill (the slot is there, empty) | #104 |
| #114 | Flaky `catalog::databases_listed` on MySQL (scratch databases race) | #104 CI |
| #115 | Row detail panel for SQL tab results | Task 7 |
| #117 | **Open SQLite file…** on the welcome pane (needs a file picker purpose) | Task 8 |
| #118 | Escape closes the connection form | Task 8 |
| #122 | `Ctrl` + keypad Enter does not trigger the Enter shortcuts | Task 10 |
| #123 | Reconnect a live workspace (`Ctrl+Shift+R` only connects a disconnected one) | Task 2, Task 10 |

Related, opened before the redesign and touched by it: #39 (Ctrl+T focus is fixed from the
editor and the grid by Task 9; the palette and the toolbar's SQL button, and completion kind
labels, remain), #42 (dialog focus traps), #53 (settings robustness).

## Already covered by an existing issue

- **Zoom jump at startup**: the interface size is applied after the settings load (async
  IPC), so a non-100 % size shows one frame at 100 % (Task 1). Same cause as the theme
  frame of **#53**: apply both from Rust `setup` before the first paint.
- **The Settings dialog always opens on General** (Task 11): remembering the last section
  belongs with the dialog polish of **#53**.
- **Typed but unapplied filter rows are lost on a tab switch** (only the active tab is
  mounted; applied filters survive; Task 6): **#43** ("a filter surviving a tab switch").
- **Export of the filtered rows** does not exist, the bar's Export is disabled (#103):
  epic **#12** (import and export files).
- **MySQL index type and condition** are empty in the Index view, `IndexInfo.definition` is
  `None` on MySQL (#103): **#52**.

## Without an issue yet

To file (one issue each, or grouped by area), or to close with a ruling.

### Window and chrome

1. **Window controls before the settings load.** Our buttons and grips render before
   `settings_get` returns; if it fails with `useSystemTitleBar` on, both title bars show.
   (Task 2)
2. **`set_decorations(true)` on an undecorated window** may flash on Wayland; consider
   creating the window with `create: false` and building it in `setup`. (Task 2)
3. **A triple press on the toolbar starts a drag** (Tauri accepts detail 1 | 2 only).
   (Task 2)
4. **Minimize on tiling compositors** (niri) may do nothing: hide it there if confirmed.
   (Task 2, owner check)
5. **Safe mode save error has no dismiss** in the toolbar menu. (Task 2)
6. **Disconnect closes the whole workspace**: confirm that is the intended meaning, or
   keep the tabs disconnected. (Task 2)
7. **`useChrome` maps are never pruned** (per-tab requests of closed tabs). (Task 2)
8. **macOS window buttons**: our buttons on the right in the Linux style; native traffic
   lights on the left would match the platform. (#104)

### Sidebar and tabs

9. **A column list closed while loading, then failed** keeps its error until Refresh
    (drop the error on reopen). (#104)
10. **Section order**: Tables, Views, Functions; moving Functions first is a one-line change
    if the owner prefers it. (#104, owner choice)
11. **Forward does not redo a foreign key step**, and a FK jump resets a renamed table tab's
    title. (Task 4)
12. **No focus ring after a mouse click on a tab then an arrow key**: WebKitGTK's
    `:focus-visible` heuristic; the focus does move. (Task 4, platform limit)
13. **Palette entries** for Go back / Go forward, Discard / Preview, Reload tab.
    (Tasks 4 and 10)
14. **macOS**: WebKit does not focus a button on press, so a press outside a sidebar menu
    onto a button gives the focus back to the tree row first. (Task 3, macOS build)

### Grid, bottom bar and filters

15. **Sorting from the keyboard**: Glide headers cannot take the focus; the header menu has
    no keyboard path. (Task 5)
16. **Column layouts** (widths, order, hidden) last for the session only. (Task 5)
17. **DEFAULT on existing rows** needs backend support (`dml.rs` refuses it in an UPDATE).
    (Task 5)
18. **Query results have no cell menu.** (Task 5)
19. **AltGr characters do not start type-to-edit** (a Glide limit; double-click first).
    (#102)
20. **Corner select-all** is Glide's hover checkbox; a permanent control needs a Glide
    upgrade or a fork. (#103)
21. **The page popover's limit** stays for the tab until it closes; no "back to the
    setting". (Task 6)
22. **Applied filter row tint** is ≈ 1.2:1 against the bar; its accessible name says
    "applied", but the visual cue is faint. (Task 6)
23. **Toolbar pending-count badge** may want restyling. (#103)

### Row details, editor, connections

24. **Row details open state** lasts for the session; keep it across restarts if wanted.
    (Task 7)
25. **Message tab**: show each statement's SQL text (`QueryRun` does not keep it), and mark
    the Message tab when an error happens while Data is shown. (Task 9)
26. **Limit presets per tab** (100 / 500 / …) in the No limit menu. (Task 9)
27. **Editor selection text** is 3.9–4.5:1 on `--sql-selection`; MySQL `/*! … */` band
    edge. (Task 9 review, optional)
28. **`--env-*` tokens** survive only in `envClasses.ts` (used by `ConfirmRunDialog`): move
    it to the `--tag-*` tokens and remove `--env-*`. (Tasks 1 and 8)
29. **Settings cannot rebind a single alternate**: a custom binding replaces all of an
    action's default keys. (Task 10)

### Release and tooling

30. **OFL license and unused font files**: the release scripts do not check that
    `licenses/JetBrainsMono-OFL.txt` ships; check whether unused `woff` files end up in the
    bundle. (Task 1)
31. **`scripts/test-dbs.sh env` in a worktree** points the TLS / SSH test directories at the
    worktree's missing `.test-secrets/`. (Task 1)
32. **The manual check** (`docs/notes/ui-redesign-manual-check.md`) has not been run on
    GNOME Wayland yet: several items above depend on it.
