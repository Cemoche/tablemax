// Keyboard layouts for the shortcut tests (#105): what `e.key` is for each physical key
// (`e.code`), without and with Shift, on Linux.
//
// Source: xkeyboard-config's symbols as Ubuntu ships them (/usr/share/X11/xkb/symbols),
// compiled with `xkbcomp` for `pc+<layout>` (fr, de, us(dvorak), il, gr, ru, and us for
// reference); level 1 and level 2 of group 1, keysyms turned into characters with
// keysymdef.h, dead keys as "Dead". WebKitGTK reports the keysym's character as `e.key` and
// the evdev key's position as `e.code` (UI Events code values), Ctrl and Alt changing
// neither. `keyCode` is left out on purpose: WebKitGTK derives it from the keysym alone
// (WebEventFactory.cpp, `windowsKeyCodeForGdkKeyval`), so it says nothing `e.key` does not.

/** Characters typed at each key position: [without Shift, with Shift]. */
export type Layout = Readonly<Record<string, readonly [string, string]>>;

const layout = (keys: Record<string, [string, string]>): Layout => keys;

export const LAYOUTS = {
  us: layout({
    Backquote: ["`", "~"], Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"],
    Digit5: ["5", "%"], Digit6: ["6", "^"], Digit7: ["7", "&"], Digit8: ["8", "*"], Digit9: ["9", "("],
    Digit0: ["0", ")"], Minus: ["-", "_"], Equal: ["=", "+"], KeyQ: ["q", "Q"], KeyW: ["w", "W"],
    KeyE: ["e", "E"], KeyR: ["r", "R"], KeyT: ["t", "T"], KeyY: ["y", "Y"], KeyU: ["u", "U"],
    KeyI: ["i", "I"], KeyO: ["o", "O"], KeyP: ["p", "P"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"],
    KeyA: ["a", "A"], KeyS: ["s", "S"], KeyD: ["d", "D"], KeyF: ["f", "F"], KeyG: ["g", "G"],
    KeyH: ["h", "H"], KeyJ: ["j", "J"], KeyK: ["k", "K"], KeyL: ["l", "L"], Semicolon: [";", ":"],
    Quote: ["'", "\""], Backslash: ["\\", "|"], IntlBackslash: ["<", ">"], KeyZ: ["z", "Z"], KeyX: ["x", "X"],
    KeyC: ["c", "C"], KeyV: ["v", "V"], KeyB: ["b", "B"], KeyN: ["n", "N"], KeyM: ["m", "M"],
    Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"],
  }),
  fr: layout({
    Backquote: ["²", "~"], Digit1: ["&", "1"], Digit2: ["é", "2"], Digit3: ["\"", "3"], Digit4: ["'", "4"],
    Digit5: ["(", "5"], Digit6: ["-", "6"], Digit7: ["è", "7"], Digit8: ["_", "8"], Digit9: ["ç", "9"],
    Digit0: ["à", "0"], Minus: [")", "°"], Equal: ["=", "+"], KeyQ: ["a", "A"], KeyW: ["z", "Z"],
    KeyE: ["e", "E"], KeyR: ["r", "R"], KeyT: ["t", "T"], KeyY: ["y", "Y"], KeyU: ["u", "U"],
    KeyI: ["i", "I"], KeyO: ["o", "O"], KeyP: ["p", "P"], BracketLeft: ["Dead", "Dead"],
    BracketRight: ["$", "£"], KeyA: ["q", "Q"], KeyS: ["s", "S"], KeyD: ["d", "D"], KeyF: ["f", "F"],
    KeyG: ["g", "G"], KeyH: ["h", "H"], KeyJ: ["j", "J"], KeyK: ["k", "K"], KeyL: ["l", "L"],
    Semicolon: ["m", "M"], Quote: ["ù", "%"], Backslash: ["*", "µ"], IntlBackslash: ["<", ">"],
    KeyZ: ["w", "W"], KeyX: ["x", "X"], KeyC: ["c", "C"], KeyV: ["v", "V"], KeyB: ["b", "B"],
    KeyN: ["n", "N"], KeyM: [",", "?"], Comma: [";", "."], Period: [":", "/"], Slash: ["!", "§"],
  }),
  de: layout({
    Backquote: ["Dead", "°"], Digit1: ["1", "!"], Digit2: ["2", "\""], Digit3: ["3", "§"], Digit4: ["4", "$"],
    Digit5: ["5", "%"], Digit6: ["6", "&"], Digit7: ["7", "/"], Digit8: ["8", "("], Digit9: ["9", ")"],
    Digit0: ["0", "="], Minus: ["ß", "?"], Equal: ["Dead", "Dead"], KeyQ: ["q", "Q"], KeyW: ["w", "W"],
    KeyE: ["e", "E"], KeyR: ["r", "R"], KeyT: ["t", "T"], KeyY: ["z", "Z"], KeyU: ["u", "U"],
    KeyI: ["i", "I"], KeyO: ["o", "O"], KeyP: ["p", "P"], BracketLeft: ["ü", "Ü"], BracketRight: ["+", "*"],
    KeyA: ["a", "A"], KeyS: ["s", "S"], KeyD: ["d", "D"], KeyF: ["f", "F"], KeyG: ["g", "G"],
    KeyH: ["h", "H"], KeyJ: ["j", "J"], KeyK: ["k", "K"], KeyL: ["l", "L"], Semicolon: ["ö", "Ö"],
    Quote: ["ä", "Ä"], Backslash: ["#", "'"], IntlBackslash: ["<", ">"], KeyZ: ["y", "Y"], KeyX: ["x", "X"],
    KeyC: ["c", "C"], KeyV: ["v", "V"], KeyB: ["b", "B"], KeyN: ["n", "N"], KeyM: ["m", "M"],
    Comma: [",", ";"], Period: [".", ":"], Slash: ["-", "_"],
  }),
  dvorak: layout({
    Backquote: ["`", "~"], Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"],
    Digit5: ["5", "%"], Digit6: ["6", "^"], Digit7: ["7", "&"], Digit8: ["8", "*"], Digit9: ["9", "("],
    Digit0: ["0", ")"], Minus: ["[", "{"], Equal: ["]", "}"], KeyQ: ["'", "\""], KeyW: [",", "<"],
    KeyE: [".", ">"], KeyR: ["p", "P"], KeyT: ["y", "Y"], KeyY: ["f", "F"], KeyU: ["g", "G"],
    KeyI: ["c", "C"], KeyO: ["r", "R"], KeyP: ["l", "L"], BracketLeft: ["/", "?"], BracketRight: ["=", "+"],
    KeyA: ["a", "A"], KeyS: ["o", "O"], KeyD: ["e", "E"], KeyF: ["u", "U"], KeyG: ["i", "I"],
    KeyH: ["d", "D"], KeyJ: ["h", "H"], KeyK: ["t", "T"], KeyL: ["n", "N"], Semicolon: ["s", "S"],
    Quote: ["-", "_"], Backslash: ["\\", "|"], IntlBackslash: ["<", ">"], KeyZ: [";", ":"], KeyX: ["q", "Q"],
    KeyC: ["j", "J"], KeyV: ["k", "K"], KeyB: ["x", "X"], KeyN: ["b", "B"], KeyM: ["m", "M"],
    Comma: ["w", "W"], Period: ["v", "V"], Slash: ["z", "Z"],
  }),
  il: layout({
    Backquote: [";", "~"], Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"],
    Digit5: ["5", "%"], Digit6: ["6", "^"], Digit7: ["7", "&"], Digit8: ["8", "*"], Digit9: ["9", ")"],
    Digit0: ["0", "("], Minus: ["-", "_"], Equal: ["=", "+"], KeyQ: ["/", "Q"], KeyW: ["'", "W"],
    KeyE: ["ק", "E"], KeyR: ["ר", "R"], KeyT: ["א", "T"], KeyY: ["ט", "Y"], KeyU: ["ו", "U"],
    KeyI: ["ן", "I"], KeyO: ["ם", "O"], KeyP: ["פ", "P"], BracketLeft: ["]", "}"], BracketRight: ["[", "{"],
    KeyA: ["ש", "A"], KeyS: ["ד", "S"], KeyD: ["ג", "D"], KeyF: ["כ", "F"], KeyG: ["ע", "G"],
    KeyH: ["י", "H"], KeyJ: ["ח", "J"], KeyK: ["ל", "K"], KeyL: ["ך", "L"], Semicolon: ["ף", ":"],
    Quote: [",", "\""], Backslash: ["\\", "|"], IntlBackslash: ["<", ">"], KeyZ: ["ז", "Z"], KeyX: ["ס", "X"],
    KeyC: ["ב", "C"], KeyV: ["ה", "V"], KeyB: ["נ", "B"], KeyN: ["מ", "N"], KeyM: ["צ", "M"],
    Comma: ["ת", ">"], Period: ["ץ", "<"], Slash: [".", "?"],
  }),
  gr: layout({
    Backquote: ["`", "~"], Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"],
    Digit5: ["5", "%"], Digit6: ["6", "^"], Digit7: ["7", "&"], Digit8: ["8", "*"], Digit9: ["9", "("],
    Digit0: ["0", ")"], Minus: ["-", "_"], Equal: ["=", "+"], KeyQ: [";", ":"], KeyW: ["ς", "Σ"],
    KeyE: ["ε", "Ε"], KeyR: ["ρ", "Ρ"], KeyT: ["τ", "Τ"], KeyY: ["υ", "Υ"], KeyU: ["θ", "Θ"],
    KeyI: ["ι", "Ι"], KeyO: ["ο", "Ο"], KeyP: ["π", "Π"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"],
    KeyA: ["α", "Α"], KeyS: ["σ", "Σ"], KeyD: ["δ", "Δ"], KeyF: ["φ", "Φ"], KeyG: ["γ", "Γ"],
    KeyH: ["η", "Η"], KeyJ: ["ξ", "Ξ"], KeyK: ["κ", "Κ"], KeyL: ["λ", "Λ"], Semicolon: ["Dead", "Dead"],
    Quote: ["'", "\""], Backslash: ["\\", "|"], IntlBackslash: ["«", "»"], KeyZ: ["ζ", "Ζ"], KeyX: ["χ", "Χ"],
    KeyC: ["ψ", "Ψ"], KeyV: ["ω", "Ω"], KeyB: ["β", "Β"], KeyN: ["ν", "Ν"], KeyM: ["μ", "Μ"],
    Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"],
  }),
  ru: layout({
    Backquote: ["ё", "Ё"], Digit1: ["1", "!"], Digit2: ["2", "\""], Digit3: ["3", "№"], Digit4: ["4", ";"],
    Digit5: ["5", "%"], Digit6: ["6", ":"], Digit7: ["7", "?"], Digit8: ["8", "*"], Digit9: ["9", "("],
    Digit0: ["0", ")"], Minus: ["-", "_"], Equal: ["=", "+"], KeyQ: ["й", "Й"], KeyW: ["ц", "Ц"],
    KeyE: ["у", "У"], KeyR: ["к", "К"], KeyT: ["е", "Е"], KeyY: ["н", "Н"], KeyU: ["г", "Г"],
    KeyI: ["ш", "Ш"], KeyO: ["щ", "Щ"], KeyP: ["з", "З"], BracketLeft: ["х", "Х"], BracketRight: ["ъ", "Ъ"],
    KeyA: ["ф", "Ф"], KeyS: ["ы", "Ы"], KeyD: ["в", "В"], KeyF: ["а", "А"], KeyG: ["п", "П"],
    KeyH: ["р", "Р"], KeyJ: ["о", "О"], KeyK: ["л", "Л"], KeyL: ["д", "Д"], Semicolon: ["ж", "Ж"],
    Quote: ["э", "Э"], Backslash: ["\\", "/"], IntlBackslash: ["/", "|"], KeyZ: ["я", "Я"], KeyX: ["ч", "Ч"],
    KeyC: ["с", "С"], KeyV: ["м", "М"], KeyB: ["и", "И"], KeyN: ["т", "Т"], KeyM: ["ь", "Ь"],
    Comma: ["б", "Б"], Period: ["ю", "Ю"], Slash: [".", ","],
  }),
} as const satisfies Record<string, Layout>;

export type LayoutName = keyof typeof LAYOUTS;

/** Keys named by their position whatever the layout: `[code, key]` (the keypad's as with Num Lock on). */
export const NAMED_KEYS: readonly (readonly [string, string])[] = [
  ["Enter", "Enter"], ["NumpadEnter", "Enter"], ["Tab", "Tab"], ["Escape", "Escape"], ["Space", " "],
  ["Backspace", "Backspace"], ["Delete", "Delete"], ["ArrowUp", "ArrowUp"], ["ArrowDown", "ArrowDown"],
  ["ArrowLeft", "ArrowLeft"], ["ArrowRight", "ArrowRight"], ["PageUp", "PageUp"], ["PageDown", "PageDown"],
  ["NumpadAdd", "+"], ["NumpadSubtract", "-"], ["NumpadDivide", "/"], ["NumpadMultiply", "*"],
  ["NumpadDecimal", "."], ["Numpad1", "1"], ["F5", "F5"],
];

/** The modifier chords the defaults use off macOS, plus Ctrl+Alt (Windows reports AltGr so). */
export const CHORDS = [
  { ctrlKey: true },
  { ctrlKey: true, shiftKey: true },
  { altKey: true },
  { altKey: true, shiftKey: true },
  { ctrlKey: true, altKey: true },
] as const;

export type Chord = (typeof CHORDS)[number];

/** Every keydown of `name` with one of `CHORDS`: one per key position and chord. */
export function presses(name: LayoutName): KeyboardEventInit[] {
  const out: KeyboardEventInit[] = [];
  const keys: Layout = LAYOUTS[name];
  for (const chord of CHORDS) {
    const shift = "shiftKey" in chord;
    for (const [code, [base, shifted]] of Object.entries(keys)) out.push({ code, key: shift ? shifted : base, ...chord });
    for (const [code, key] of NAMED_KEYS) out.push({ code, key, ...chord });
  }
  return out;
}

/** A press as text for the assertions: "Ctrl+Shift+KeyM (?)". */
export function describePress(p: KeyboardEventInit): string {
  const mods = [p.ctrlKey && "Ctrl", p.altKey && "Alt", p.shiftKey && "Shift"].filter(Boolean);
  return [...mods, `${p.code} (${p.key})`].join("+");
}
