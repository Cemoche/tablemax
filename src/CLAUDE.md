# Frontend rules (`src/`)

Stack: React 19, TypeScript, Zustand 5 (stores in `src/stores/`), Tailwind 4, Glide Data
Grid (canvas), CodeMirror 6. Feature code lives in `src/features/<area>/`
(`connections`, `editor`, `grid`, `workspace`).

## Strings

- Every user-visible string (labels, buttons, placeholders, aria labels, messages) comes
  from `src/lib/strings.ts`. No literal UI text in components. The UI language is English;
  strings are centralized for a future translation.
- Tests may import `strings` instead of repeating the wording.

## Colors and theme

- Colors only through the design tokens in `src/styles/tokens.css`, exposed to Tailwind
  by the `@theme inline` block of `src/index.css` (`bg-surface`, `text-muted`,
  `border-border`, `text-danger`, `bg-env-prod`, `bg-swatch-1`…). No hex, `rgb()` or
  Tailwind palette colors (`blue-500`…) in components.
- A new color = a token in `tokens.css` (dark and light values) + a `--color-*` line in
  `src/index.css`.
- Canvas code (the grid) reads tokens at runtime: see `src/features/grid/gridTheme.ts`.

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
