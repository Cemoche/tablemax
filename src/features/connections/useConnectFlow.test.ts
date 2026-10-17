import { expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { strings } from "../../lib/strings";
import { useConnectFlow, type FlowSecrets } from "./useConnectFlow";

const none: FlowSecrets = { password: null, sshSecret: null, acceptFingerprint: null };
const FP = "SHA256:abcDEF0123456789abcDEF0123456789abcDEF01234";

test("a required passphrase prompts, then retries with it and keeps the password", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce({ kind: "auth", message: "ssh passphrase required" })
    .mockResolvedValueOnce("ok");
  const { result } = renderHook(() => useConnectFlow(run));
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.start({ ...none, password: "db-pw" });
  });
  await waitFor(() => expect(result.current.prompt).toEqual({ kind: "sshPassphrase", error: null }));
  act(() => result.current.submit("secret phrase"));
  await act(async () => {
    await expect(outcome).resolves.toBe("ok");
  });
  expect(run).toHaveBeenNthCalledWith(1, { ...none, password: "db-pw" });
  expect(run).toHaveBeenNthCalledWith(2, { ...none, password: "db-pw", sshSecret: "secret phrase" });
  expect(result.current.prompt).toBeNull();
});

test("a wrong passphrase prompts again with an error", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce({ kind: "auth", message: "ssh passphrase required" })
    .mockRejectedValueOnce({ kind: "auth", message: "ssh passphrase required" })
    .mockResolvedValueOnce("ok");
  const { result } = renderHook(() => useConnectFlow(run));
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.start(none);
  });
  await waitFor(() => expect(result.current.prompt?.kind).toBe("sshPassphrase"));
  act(() => result.current.submit("wrong"));
  await waitFor(() =>
    expect(result.current.prompt).toEqual({
      kind: "sshPassphrase",
      error: strings.secretPrompt.sshPassphrase.retry,
    }),
  );
  act(() => result.current.submit("right"));
  await act(async () => {
    await expect(outcome).resolves.toBe("ok");
  });
  expect(run).toHaveBeenLastCalledWith({ ...none, sshSecret: "right" });
});

test("DB password and SSH password prompts chain and keep each other's answer", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce({ kind: "auth", message: "password required" })
    .mockRejectedValueOnce({ kind: "auth", message: "ssh password required" })
    .mockResolvedValueOnce("ok");
  const { result } = renderHook(() => useConnectFlow(run));
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.start(none);
  });
  await waitFor(() => expect(result.current.prompt).toEqual({ kind: "password", error: null }));
  act(() => result.current.submit("db"));
  await waitFor(() => expect(result.current.prompt).toEqual({ kind: "sshPassword", error: null }));
  act(() => result.current.submit("ssh"));
  await act(async () => {
    await expect(outcome).resolves.toBe("ok");
  });
  expect(run).toHaveBeenLastCalledWith({ password: "db", sshSecret: "ssh", acceptFingerprint: null });
});

test("an unknown host key prompts with its fingerprint; Trust retries accepting it", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce({ kind: "hostKeyUnknown", message: FP })
    .mockResolvedValueOnce("ok");
  const { result } = renderHook(() => useConnectFlow(run));
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.start({ ...none, sshSecret: "s" }, "bastion:2222");
  });
  await waitFor(() =>
    expect(result.current.prompt).toEqual({ kind: "hostKey", fingerprint: FP, host: "bastion:2222" }),
  );
  act(() => result.current.trust());
  await act(async () => {
    await expect(outcome).resolves.toBe("ok");
  });
  expect(run).toHaveBeenLastCalledWith({ password: null, sshSecret: "s", acceptFingerprint: FP });
});

test("cancelling a prompt ends the flow with undefined", async () => {
  const run = vi.fn().mockRejectedValue({ kind: "hostKeyUnknown", message: FP });
  const { result } = renderHook(() => useConnectFlow(run));
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.start(none);
  });
  await waitFor(() => expect(result.current.prompt?.kind).toBe("hostKey"));
  act(() => result.current.cancel());
  await act(async () => {
    await expect(outcome).resolves.toBeUndefined();
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(result.current.prompt).toBeNull();
});

test("a changed host key rejects with the explanation and never prompts", async () => {
  const run = vi.fn().mockRejectedValue({ kind: "hostKeyChanged", message: FP });
  const { result } = renderHook(() => useConnectFlow(run));
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.start(none);
  });
  await act(async () => {
    await expect(outcome).rejects.toEqual({
      kind: "hostKeyChanged",
      message: strings.ssh.hostKeyChanged(FP),
    });
  });
  expect(strings.ssh.hostKeyChanged(FP)).toContain(FP);
  expect(result.current.prompt).toBeNull();
  expect(run).toHaveBeenCalledTimes(1);
});

test("other errors reject unchanged", async () => {
  const err = { kind: "auth", message: "ssh authentication failed" };
  const run = vi.fn().mockRejectedValue(err);
  const { result } = renderHook(() => useConnectFlow(run));
  await act(async () => {
    await expect(result.current.start(none)).rejects.toEqual(err);
  });
  expect(result.current.prompt).toBeNull();
});
