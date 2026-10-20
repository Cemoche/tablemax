import { expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strings } from "../../lib/strings";
import { UrlImportDialog } from "./UrlImportDialog";

test("shows warnings and returns the config and password", async () => {
  const user = userEvent.setup();
  const onResult = vi.fn();
  render(<UrlImportDialog onResult={onResult} onCancel={vi.fn()} />);
  expect(screen.getByRole("button", { name: strings.url.open })).toBeDisabled();
  await user.type(screen.getByLabelText("Connection URL"), "mysql://root:pw@127.0.0.1/app?foo=1");
  expect(screen.getByText('unknown parameter "foo"')).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: strings.url.open }));
  expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ kind: "mySql", port: 3306 }), "pw", false);
});

test("an invalid URL shows an error and cannot be opened", async () => {
  const user = userEvent.setup();
  render(<UrlImportDialog onResult={vi.fn()} onCancel={vi.fn()} />);
  await user.type(screen.getByLabelText("Connection URL"), "redis://x");
  expect(screen.getByRole("alert")).toHaveTextContent("Not a valid connection URL");
  expect(screen.getByRole("button", { name: strings.url.open })).toBeDisabled();
});
