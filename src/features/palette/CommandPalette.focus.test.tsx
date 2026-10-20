import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { strings } from "../../lib/strings";
import { useCatalog } from "../../stores/catalog";
import { useConnections } from "../../stores/connections";
import { type Workspace, useWorkspaces } from "../../stores/workspaces";
import { SqlEditor } from "../editor/SqlEditor";
import { WorkspaceView } from "../workspace/WorkspaceView";
import { CommandPalette } from "./CommandPalette";

vi.mock("../../lib/ipc");
vi.mock("../workspace/ObjectSidebar", () => ({ ObjectSidebar: () => null }));
vi.mock("../grid/TableDataTab", () => ({ TableDataTab: () => <button type="button">grid cell</button> }));
vi.mock("../editor/QueryTab", () => ({
  QueryTab: ({ tab }: { tab: { id: string } }) => (
    <SqlEditor tabId={tab.id} value="" onChange={() => {}} dialect="postgres" onRun={() => {}} />
  ),
}));

const ws: Workspace = {
  id: "w1",
  connectionId: "c1",
  name: "PG",
  color: "swatch-1",
  envTag: "local",
  dialect: "postgres",
  status: "connected",
  database: "app",
  schemas: ["public"],
  currentSchema: "public",
  tabs: [{ id: "t1", kind: "table", object: { schema: "public", name: "old" }, title: "old", preview: true }],
  activeTabId: "t1",
  mru: ["t1"],
};

function Harness() {
  const w = useWorkspaces((s) => s.workspaces[0]);
  return (
    <>
      <WorkspaceView workspace={w} />
      <CommandPalette onOpenConnection={vi.fn()} onNewConnection={vi.fn()} onShowConnections={vi.fn()} onShowWorkspace={vi.fn()} />
    </>
  );
}

beforeEach(async () => {
  vi.resetAllMocks();
  const ipc = await import("../../lib/ipc");
  vi.mocked(ipc.catalogGet).mockResolvedValue({
    schema: "public",
    tables: [{ name: "users", kind: "table", columns: [] }],
  });
  useCatalog.setState({ catalogs: {}, errors: {}, loading: {} });
  useConnections.setState({ items: [] });
  useWorkspaces.setState({ workspaces: [ws], activeWorkspaceId: "w1", sidebarVisible: true });
});

async function openFromGrid(chord: string) {
  const user = userEvent.setup();
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "grid cell" });
  opener.focus();
  await user.keyboard(chord);
  return { user, opener };
}

test("New SQL tab: the detached opener is replaced by focus in the new editor", async () => {
  const { user, opener } = await openFromGrid("{Control>}p{/Control}");
  const dialog = await screen.findByRole("dialog", { name: strings.palette.label });
  await user.type(within(dialog).getByRole("combobox"), ">");
  await user.click(await screen.findByText(strings.palette.action.newQuery));
  await waitFor(() => expect(opener).not.toBeInTheDocument());
  await waitFor(() => {
    const content = document.querySelector(".cm-content");
    expect(content).not.toBeNull();
    expect(content).toHaveFocus();
  });
});

test("opening an object whose tab replaces the opener's tab focuses the tab content", async () => {
  const { user, opener } = await openFromGrid("{Control>}p{/Control}");
  await user.click(await screen.findByText("users"));
  await waitFor(() => {
    const region = screen.getByLabelText(strings.workspace.tabContentLabel);
    expect(document.activeElement).not.toBe(document.body);
    expect(region.contains(document.activeElement)).toBe(true);
  });
  expect(opener).not.toBeInTheDocument();
});
