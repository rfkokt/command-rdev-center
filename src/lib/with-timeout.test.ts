import { afterEach, expect, it, vi } from "vitest";
import { withTimeout } from "./with-timeout";

afterEach(() => vi.useRealTimers());

it("preserves successful results and clears the deadline", async () => {
  vi.useFakeTimers();
  await expect(withTimeout(Promise.resolve(42), 1500, "stalled")).resolves.toBe(
    42,
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves errors and clears the deadline", async () => {
  vi.useFakeTimers();
  await expect(
    withTimeout(Promise.reject(new Error("offline")), 1500, "stalled"),
  ).rejects.toThrow("offline");
  expect(vi.getTimerCount()).toBe(0);
});

it("times out stalled work and consumes late rejection", async () => {
  vi.useFakeTimers();
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => {
    fail = reject;
  });
  const result = expect(withTimeout(pending, 1500, "stalled")).rejects.toThrow(
    "stalled",
  );
  await vi.advanceTimersByTimeAsync(1500);
  await result;
  fail(new Error("late failure"));
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
