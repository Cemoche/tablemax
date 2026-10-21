# UI redesign — open follow-ups

What the redesign (epic #77, plan `docs/superpowers/plans/2026-10-19-tablemax-ui-redesign.md`,
Tasks 1–11 and issues #102, #103, #104, #109) leaves open, at the end of Task 11 (#91),
2026-10-21. Items fixed by a later task or review round are left out. The expected
behaviour is the spec `docs/superpowers/specs/2026-10-19-tablemax-ui-redesign-design.md`
and its dated amendments.

## With a GitHub issue

Status on 2026-10-21, after the follow-up run.

**Done (merged):** #105 (+ #122), #107, #110, #115, #117, #118, #128, #129, #131, #132, #135,
#136, #141, #112 (throughput: PR #152).

**Open:**

| Issue | What | From |
|---|---|---|
| #114 | Flaky `catalog::databases_listed` on MySQL (scratch databases race) | #104 CI |
| #123 | Reconnect a live workspace (`Ctrl+Shift+R` only connects a disconnected one) | Task 2, Task 10 |
| #144 | NULL / DEFAULT placeholders need a non-colour cue (italic) | #136 review |
| #145 | Row detail panel: NULL / DEFAULT textarea placeholder under 3:1 on an edited field | #136 review |
| #149 | Glide's fixed grid keys swallow actions rebound to them | #141 |
| #151 | Security: the SSH tunnel's loopback listener forwards any local connection (paused, WIP on its branch) | #112 review |
| #153 | Window chrome polish (items 1, 2, 3, 5, 7 of the former list) | Task 2 |
| #154 | Navigation polish: sidebar order like TablePlus (Functions, Tables, Views), column list retry, FK forward step, palette entries (items 9, 10, 11, 13) | Tasks 4, 10, #104 |
| #155 | Grid polish: keyboard sort, saved column layouts, DEFAULT on UPDATE, results cell menu, page limit reset, filter cue, pending badge (items 15–18, 21–23) | Tasks 5, 6, #103 |
| #156 | Editor, row details and keymap leftovers (items 24–29) | Tasks 7, 9, 10 |
| #157 | Release and tooling: font licence check, `test-dbs.sh env` in a worktree (items 30, 31) | Task 1 |
| #158 | macOS polish: native traffic lights, focus after an outside press (items 8, 14) | Task 3, #104 |

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

## Triage of the former "without an issue" list (#126, 2026-10-21)

Every item of the former list (numbered as in #126) is now filed, grouped or ruled on. Owner rule (Cem,
2026-10-21): **when in doubt, do as TablePlus does.**

- **Filed and grouped:** items 1, 2, 3, 5, 7 → #153; 9, 10, 11, 13 → #154; 15–18, 21–23 →
  #155; 24–29 → #156; 30, 31 → #157; 8, 14 → #158.
- **Ruled by the owner:**
  - Item 4, *Minimize on tiling compositors (niri)*: keep the button as it is, even where the
    compositor ignores it.
  - Item 6, *Disconnect closes the whole workspace*: intended, keep it.
  - Item 10, *sidebar section order*: as TablePlus, Functions first (→ #154).
- **Closed as known platform or library limits** (no issue):
  - Item 12: no focus ring after a mouse click on a tab then an arrow key — WebKitGTK's
    `:focus-visible` heuristic; the focus does move.
  - Item 19: AltGr characters don't start type-to-edit — a Glide limit (double-click first).
  - Item 20: the corner select-all is Glide's hover checkbox — a permanent control needs a
    Glide upgrade or a fork.
- **Done:** item 32, the full manual check (`ui-redesign-manual-check.md`), validated by the
  owner on 2026-10-21.
