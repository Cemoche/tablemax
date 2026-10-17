import { render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { strings } from "../../lib/strings";
import { DEFAULT_SETTINGS, useSettings } from "../../stores/settings";
import { ResultsPanel } from "./ResultsPanel";

afterEach(() => useSettings.setState({ settings: DEFAULT_SETTINGS }));

test("before any run, the hint names the effective Run shortcut", () => {
  const { unmount } = render(<ResultsPanel run={undefined} />);
  expect(screen.getByText(strings.query.empty("Ctrl+Enter"))).toBeInTheDocument();
  unmount();
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keymap: { "editor.run": "Mod+Shift+R" } } });
  render(<ResultsPanel run={undefined} />);
  expect(screen.getByText(strings.query.empty("Ctrl+Shift+R"))).toBeInTheDocument();
});
