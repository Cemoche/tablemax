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
    outcome = result.current.start({ ...none, password: "db-pw" }, "ctx");
  });
  await waitFor(() => expect(result.current.prompt).toEqual({ kind: "sshPassphrase", error: null }));
  act(() => result.current.submit("secret phrase"));
  await act(async () => {
    await expect(outcome).resolves.toBe("ok");
  });
  expect(run).toHaveBeenNthCalledWith(1, { ...none, password: "db-pw" }, "ctx");
  expect(run).toHaveBeenNthCalledWith(2, { ...none, password: "db-pw", sshSecret: "secret phrase" }, "ctx");
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
    outcome = result.current.start(none, "ctx");
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
  expect(run).toHaveBeenLastCalledWith({ ...none, sshSecret: "right" }, "ctx");
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
    outcome = result.current.start(none, "ctx");
  });
  await waitFor(() => expect(result.current.prompt).toEqual({ kind: "password", error: null }));
  act(() => result.current.submit("db"));
  await waitFor(() => expect(result.current.prompt).toEqual({ kind: "sshPassword", error: null }));
  act(() => result.current.submit("ssh"));
  await act(async () => {
    await expect(outcome).resolves.toBe("ok");
  });
  expect(run).toHaveBeenLastCalledWith({ password: "db", sshSecret: "ssh", acceptFingerprint: null }, "ctx");
});

test("an unknown host key prompts with its fingerprint; Trust retries accepting it", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce({ kind: "hostKeyUnknown", message: FP })
    .mockResolvedValueOnce("ok");
  const { result } = renderHook(() => useConnectFlow(run));
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.start({ ...none, sshSecret: "s" }, "ctx", "bastion:2222");
  });
  await waitFor(() =>
    expect(result.current.prompt).toEqual({ kind: "hostKey", fingerprint: FP, host: "bastion:2222" }),
  );
  act(() => result.current.trust());
  await act(async () => {
    await expect(outcome).resolves.toBe("ok");
  });
  expect(run).toHaveBeenLastCalledWith({ password: null, sshSecret: "s", acceptFingerprint: FP }, "ctx");
});

test("cancelling a prompt ends the flow with undefined", async () => {
  const run = vi.fn().mockRejectedValue({ kind: "hostKeyUnknown", message: FP });
  const { result } = renderHook(() => useConnectFlow(run));
  let outcome: Promise<unknown> = Promise.resolve();
  act(() => {
    outcome = result.current.start(none, "ctx");
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
    outcome = result.current.start(none, "ctx");
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
    await expect(result.current.start(none, "ctx")).rejects.toEqual(err);
  });
  expect(result.current.prompt).toBeNull();
});

/** A run whose result each test settles by hand, per context. */
function deferredRun() {
  const pending = new Map<string, { resolve: (v: string) => void; reject: (e: unknown) => void }>();
  const run = vi.fn(
    (_s: FlowSecrets, ctx: string) =>
      new Promise<string>((resolve, reject) => pending.set(ctx, { resolve, reject })),
  );
  return { run, settle: (ctx: string) => pending.get(ctx)! };
}

test("a new start supersedes a flow waiting on a prompt; answers go to the new flow only", async () => {
  const run = vi.fn(async (s: FlowSecrets, ctx: string) => {
    if (ctx === "A") throw { kind: "hostKeyUnknown", message: FP };
    if (s.sshSecret === null) throw { kind: "auth", message: "ssh passphrase required" };
    return `B:${s.sshSecret}:${s.acceptFingerprint}`;
  });
  const { result } = renderHook(() => useConnectFlow(run));
  let a: Promise<unknown> = Promise.resolve();
  let b: Promise<unknown> = Promise.resolve();
  act(() => {
    a = result.current.start(none, "A", "host-a");
  });
  await waitFor(() => expect(result.current.prompt?.kind).toBe("hostKey"));
  expect(result.current.context).toBe("A");
  act(() => {
    b = result.current.start(none, "B", "host-b");
  });
  await act(async () => {
    await expect(a).resolves.toBeUndefined();
  });
  await waitFor(() => expect(result.current.prompt).toEqual({ kind: "sshPassphrase", error: null }));
  expect(result.current.context).toBe("B");
  act(() => result.current.submit("pp"));
  await act(async () => {
    await expect(b).resolves.toBe("B:pp:null");
  });
  expect(run.mock.calls.filter(([, ctx]) => ctx === "A")).toHaveLength(1);
  expect(result.current.prompt).toBeNull();
  expect(result.current.context).toBeNull();
});

test("a superseded flow whose run fails later neither prompts nor clears the new prompt", async () => {
  const { run, settle } = deferredRun();
  const { result } = renderHook(() => useConnectFlow(run));
  let a: Promise<unknown> = Promise.resolve();
  let b: Promise<unknown> = Promise.resolve();
  act(() => {
    a = result.current.start(none, "A");
  });
  act(() => {
    b = result.current.start(none, "B");
  });
  await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  await act(async () => {
    settle("B").reject({ kind: "auth", message: "password required" });
  });
  await waitFor(() => expect(result.current.prompt?.kind).toBe("password"));
  await act(async () => {
    settle("A").reject({ kind: "auth", message: "ssh password required" });
    await expect(a).resolves.toBeUndefined();
  });
  expect(result.current.prompt).toEqual({ kind: "password", error: null });
  expect(result.current.context).toBe("B");
  act(() => result.current.submit("pw"));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(3));
  expect(run).toHaveBeenLastCalledWith({ ...none, password: "pw" }, "B");
  await act(async () => {
    settle("B").resolve("ok");
    await expect(b).resolves.toBe("ok");
  });
});

test("a superseded flow whose run succeeds resolves undefined", async () => {
  const { run, settle } = deferredRun();
  const { result } = renderHook(() => useConnectFlow(run));
  let a: Promise<unknown> = Promise.resolve();
  act(() => {
    a = result.current.start(none, "A");
    void result.current.start(none, "B");
  });
  await act(async () => {
    settle("A").resolve("late");
    await expect(a).resolves.toBeUndefined();
  });
});
