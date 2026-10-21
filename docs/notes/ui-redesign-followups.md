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

## Without an issue yet

To file (one issue each, or grouped by area), or to close with a ruling.

### Window and chrome

1. **Zoom jump at startup.** The interface size is applied after the settings load
   (async IPC), so a non-100 % size shows one frame at 100 %. Apply the saved zoom from
   Rust `setup` before the first paint. (Task 1)
2. **Window controls before the settings load.** Our buttons and grips render before
   `settings_get` returns; if it fails with `useSystemTitleBar` on, both title bars show.
   (Task 2)
3. **`set_decorations(true)` on an undecorated window** may flash on Wayland; consider
   creating the window with `create: false` and building it in `setup`. (Task 2)
4. **A triple press on the toolbar starts a drag** (Tauri accepts detail 1 | 2 only).
   (Task 2)
5. **Minimize on tiling compositors** (niri) may do nothing: hide it there if confirmed.
   (Task 2, owner check)
6. **Safe mode save error has no dismiss** in the toolbar menu. (Task 2)
7. **Disconnect closes the whole workspace**: confirm that is the intended meaning, or
   keep the tabs disconnected. (Task 2)
8. **`useChrome` maps are never pruned** (per-tab requests of closed tabs). (Task 2)
9. **macOS window buttons**: our buttons on the right in the Linux style; native traffic
   lights on the left would match the platform. (#104)

### Sidebar and tabs

10. **A column list closed while loading, then failed** keeps its error until Refresh
    (drop the error on reopen). (#104)
11. **Section order**: Tables, Views, Functions; moving Functions first is a one-line change
    if the owner prefers it. (#104, owner choice)
12. **Forward does not redo a foreign key step**, and a FK jump resets a renamed table tab's
    title. (Task 4)
13. **No focus ring after a mouse click on a tab then an arrow key**: WebKitGTK's
    `:focus-visible` heuristic; the focus does move. (Task 4, platform limit)
14. **Palette entries** for Go back / Go forward, Discard / Preview, Reload tab.
    (Tasks 4 and 10)
15. **macOS**: WebKit does not focus a button on press, so a press outside a sidebar menu
    onto a button gives the focus back to the tree row first. (Task 3, macOS build)

### Grid, bottom bar and filters

16. **Sorting from the keyboard**: Glide headers cannot take the focus; the header menu has
    no keyboard path. (Task 5)
17. **Column layouts** (widths, order, hidden) last for the session only. (Task 5)
18. **DEFAULT on existing rows** needs backend support (`dml.rs` refuses it in an UPDATE).
    (Task 5)
19. **Query results have no cell menu.** (Task 5)
20. **AltGr characters do not start type-to-edit** (a Glide limit; double-click first).
    (#102)
21. **Corner select-all** is Glide's hover checkbox; a permanent control needs a Glide
    upgrade or a fork. (#103)
22. **Typed but unapplied filter rows are lost on a tab switch** (only the active tab is
    mounted; applied filters survive). (Task 6, pre-existing)
23. **The page popover's limit** stays for the tab until it closes; no "back to the
    setting". (Task 6)
24. **Applied filter row tint** is ≈ 1.2:1 against the bar; its accessible name says
    "applied", but the visual cue is faint. (Task 6)
25. **Export of the filtered rows** does not exist (the button is disabled). (#103)
26. **MySQL index type and condition** are empty: `meta.rs` would need `INDEX_TYPE` (MySQL
    has no partial indexes). (#103)
27. **Toolbar pending-count badge** may want restyling. (#103)

### Row details, editor, connections

28. **Row details open state** lasts for the session; keep it across restarts if wanted.
    (Task 7)
29. **Message tab**: show each statement's SQL text (`QueryRun` does not keep it), and mark
    the Message tab when an error happens while Data is shown. (Task 9)
30. **Limit presets per tab** (100 / 500 / …) in the No limit menu. (Task 9)
31. **Editor selection text** is 3.9–4.5:1 on `--sql-selection`; MySQL `/*! … */` band
    edge. (Task 9 review, optional)
32. **`--env-*` tokens** survive only in `envClasses.ts` (used by `ConfirmRunDialog`): move
    it to the `--tag-*` tokens and remove `--env-*`. (Tasks 1 and 8)
33. **Settings cannot rebind a single alternate**: a custom binding replaces all of an
    action's default keys. (Task 10)
34. **No focus ring on the connections screen.** `ConnectionList.tsx` (4 class strings),
    `WelcomePane.tsx` (1) and `formStyles.ts` (4: fields and buttons of the form) use
    `outline-none focus-visible:outline-2` without `focus-visible:outline-solid`. Compiled
    with Tailwind 4.3: `outline-none` sets `--tw-outline-style: none` and
    `focus-visible:outline-2` uses `outline-style: var(--tw-outline-style)`, so no ring is
    drawn (the same bug Task 2 fixed in the toolbar). Add `focus-visible:outline-solid`.
    (found in Task 11)
35. **Settings**: an invalid number typed in a section is dropped when another section is
    shown (valid drafts are saved on blur); the dialog always opens on General. (Task 11)

### Release and tooling

36. **OFL license and unused font files**: the release scripts do not check that
    `licenses/JetBrainsMono-OFL.txt` ships; check whether unused `woff` files end up in the
    bundle. (Task 1)
37. **`scripts/test-dbs.sh env` in a worktree** points the TLS / SSH test directories at the
    worktree's missing `.test-secrets/`. (Task 1)
38. **The manual check** (`docs/notes/ui-redesign-manual-check.md`) has not been run on
    GNOME Wayland yet: several items above (1, 5, 13) depend on it.
