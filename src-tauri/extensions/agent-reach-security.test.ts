import { describe, expect, it } from "vitest";
import { isPublicIp, isYouTubeHost } from "./agent-reach-security";

describe("Agent Reach URL security", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.0.1",
    "224.0.0.1",
    "0.0.0.0",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => expect(isPublicIp(address)).toBe(true),
  );

  it("restricts transcripts to YouTube-owned hosts", () => {
    expect(isYouTubeHost("youtube.com")).toBe(true);
    expect(isYouTubeHost("www.youtube.com")).toBe(true);
    expect(isYouTubeHost("youtu.be")).toBe(true);
    expect(isYouTubeHost("youtube.com.evil.test")).toBe(false);
  });
});
