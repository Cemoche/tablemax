# Frontend rules (`src/`)

Stack: React 19, TypeScript, Zustand 5 (stores in `src/stores/`), Tailwind 4, Glide Data
Grid (canvas), CodeMirror 6, icons from `lucide-react` (plus our own SVGs). Feature code
lives in `src/features/<area>/`: `chrome` (toolbar, status pill, window controls, open
connections column, tooltips), `connections`, `editor`, `grid`, `palette` (Open anything),
`safety`, `settings`, `sidebar`, `structure`, `workspace` (tab bar, tab content).
The UI follows the redesign spec `docs/superpowers/specs/2026-10-19-tablemax-ui-redesign-design.md`
(its dated amendments record what was built).

## Strings

- Every user-visible string (labels, buttons, placeholders, aria labels, messages) comes
  from `src/lib/strings.ts`. No literal UI text in components. The UI language is English;
  strings are centralized for a future translation.
- Tests may import `strings` instead of repeating the wording.

## Colors and theme

- Colors only through the design tokens in `src/styles/tokens.css` (spec §5.1), exposed to
  Tailwind by the `@theme inline` block of `src/index.css` (`bg-content`, `bg-side`,
  `bg-pill`, `text-text-2`, `border-sep`, `bg-accent-strong`, `bg-swatch-3-tint`,
  `text-swatch-3-icon`, `bg-tag-prod-bg`…; `bg-surface`, `text-muted`, `border-border` are
  older aliases). No hex, `rgb()` or Tailwind palette colors (`blue-500`…) in components.
- A new color = a token in `tokens.css` (dark and light values) + a `--color-*` line in
  `src/index.css`. Text tokens keep ≥ 4.5:1 on their backgrounds in both themes
  (`src/styles/tokens.test.ts` checks the pairs it draws).
- Accent fills: `bg-accent-strong` + `text-accent-contrast`, never an opaque `bg-accent`
  (white is 4.0:1 there). Same for danger (#128): a destructive button is
  `bg-danger-strong` + `text-danger-contrast`, never `bg-danger`
  (`src/styles/accentText.test.ts` checks both, #107).
- Accent or danger as a text colour (links, error messages, destructive labels, an icon
  coloured through `text-*`): `text-accent-text` / `text-danger-text`, never `text-accent` /
  `text-danger` (under 4.5:1 on some backgrounds); the canvas reads `--accent-text` /
  `--danger-text` too. `--accent` and `--danger` stay for tints (`bg-accent/30`), focus rings,
  borders and outlines (`src/styles/textColor.test.ts` checks it, #129). A new background
  under these texts goes into the lists of `tokens.test.ts`.
- One base text colour per class string: Tailwind 4 orders same-property utilities by
  name, so `.text-text` / `.text-icon` beat `.text-danger-text` whatever the class order.
  A coloured variant of a shared style uses its colourless base (`btnBase`,
  `buttonBaseClass`, `iconButtonBase`) plus one colour (`textColor.test.ts` checks it).
- Canvas code (the grid) reads tokens at runtime: see `src/features/grid/gridTheme.ts`.
- Focus rings: `outline-none focus-visible:outline-2 focus-visible:outline-solid
  focus-visible:outline-accent` (Tailwind 4 needs `outline-solid` after `outline-none`).
- Sizes follow spec §5.2 at 100 %; the interface size is the webview's native zoom
  (`interfaceScale`), never CSS scaling.

## Tooltips

- No native `title`. A control declares its hint with `{...tip(label, shortcut)}` from
  `src/lib/tooltip.ts` (one `TooltipLayer` shows it), or `tipIfCut(name)` for text that
  may be truncated. The shortcut text comes from the live keymap
  (`formatShortcut(useEffectiveShortcut(id))`), never written by hand.

## Keyboard shortcuts

- Every shortcut is an action of the registry `src/lib/keymapRegistry.ts`: id, scope
  (`global`, `tableTab`, `queryTab`, `editor`, `filterBar`, `connectionList`), default,
  alternates, macOS default. Bind it with `useAction(id, handler)` from `src/lib/keymap.ts`;
  never match keys by hand for a reassignable shortcut.
- A new action: its entry in the registry, its label in `strings.keymap`, its id at the end
  of `src/lib/keymap-actions.json` **and** of `KEYMAP_ACTION_IDS` in
  `src-tauri/src/settings.rs` (both sides test their list against that file). A §5.3 row is
  pinned by `src/lib/shortcutParity.test.ts`.
- No Ctrl+Alt default off macOS (it is AltGr there). A shortcut never steals a key from a
  text field or the editor when that is not its scope; a focus region marked
  `data-shortcut-scope` makes its scope's actions win inside it.

## IPC (frontend ↔ Rust)

- Call the backend only through `src/lib/ipc.ts`: one function per Tauri command, names
  mirroring `src-tauri/src/commands.rs`. No `invoke()` anywhere else.
- Wire types live in `src/lib/types.ts`, a hand-written mirror of the Rust serde types
  (camelCase on the wire). Change both sides together and update
  `src/lib/types.shape.test.ts`, which pins the shapes.
- A rejected call carries an `AppError { kind, message }`: normalize it with `toAppError`
  from `src/lib/errors.ts`, and branch on `kind`, not on free text (except the helpers
  already in `errors.ts`).
- Secrets typed by the user go to the backend once and are never stored in a store,
  `localStorage` or logs.

## Tests

- Vitest + Testing Library (`jsdom`, setup in `src/test/setup.ts`); test files sit next to
  the code: `Foo.tsx` → `Foo.test.tsx`, `bar.ts` → `bar.test.ts`.
- Mock the backend with `vi.mock("../../lib/ipc")` (path relative to the test) and
  `vi.mocked(ipc.someCommand).mockResolvedValue(...)`; reset with `vi.resetAllMocks()` in
  `beforeEach`. Reset Zustand stores with `useX.setState(...)`.
- Prefer user-level queries (`getByRole`, `getByLabelText`) and `userEvent`.
- Run: `pnpm test` (all) or `pnpm test src/features/grid` (one folder); `pnpm lint` for tsc.

## UI behaviour

- Never block the UI: long work is an async IPC call with a visible pending state and,
  for queries, a cancel action.
- The app loads no remote content (fonts, images, scripts): everything ships in the bundle.
