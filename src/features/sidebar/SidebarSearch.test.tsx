import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test } from "vitest";
import { strings } from "../../lib/strings";
import { useSidebar } from "../../stores/sidebar";
import { SidebarSearch, nameMatches } from "./SidebarSearch";

const S = strings.sidebar;

beforeEach(() => {
  useSidebar.setState({ match: "contains", showTables: true, showViews: true, focusSearch: false });
});

function Box({ withOptions = false }: { withOptions?: boolean }) {
  const [v, setV] = useState("");
  return <SidebarSearch label={S.searchLabel} placeholder={S.search} value={v} onChange={setV} withOptions={withOptions} />;
}

test("nameMatches: case-insensitive contains / starts with / ends with; empty matches all", () => {
  expect(nameMatches("Active_Users", "users", "contains")).toBe(true);
  expect(nameMatches("Active_Users", "users", "startsWith")).toBe(false);
  expect(nameMatches("Active_Users", "active", "startsWith")).toBe(true);
  expect(nameMatches("Active_Users", "users", "endsWith")).toBe(true);
  expect(nameMatches("Active_Users", "active", "endsWith")).toBe(false);
  expect(nameMatches("x", "", "endsWith")).toBe(true);
});

test("Escape clears the box", async () => {
  render(<Box />);
  const box = screen.getByRole("searchbox", { name: S.searchLabel });
  await userEvent.type(box, "abc{Escape}");
  expect(box).toHaveValue("");
});

test("the options menu works from the keyboard and Escape gives the focus back", async () => {
  render(<Box withOptions />);
  const options = screen.getByRole("button", { name: S.searchOptions });
  options.focus();
  await userEvent.keyboard("{Enter}");
  // The checked mode has the focus.
  expect(screen.getByRole("menuitemradio", { name: S.match.contains })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(useSidebar.getState().match).toBe("startsWith");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(options).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(options).toHaveFocus();
});

test("no options button without withOptions", () => {
  render(<Box />);
  expect(screen.queryByRole("button", { name: S.searchOptions })).toBeNull();
});
