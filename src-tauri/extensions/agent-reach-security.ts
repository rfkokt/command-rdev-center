import { isIP } from "node:net";

const blockedIpv4 = (bytes: number[]) => {
  const [a, b, c] = bytes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
};

export function isPublicIp(address: string) {
  const version = isIP(address);
  if (version === 4)
    return !blockedIpv4(address.split(".").map((part) => Number(part)));
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:"))
    return isPublicIp(normalized.slice("::ffff:".length));
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("2001:10:") ||
    normalized.startsWith("2001:2:") ||
    normalized.startsWith("2001:0:") ||
    normalized.startsWith("100:")
  );
}

export function isYouTubeHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "youtu.be" ||
    host === "youtube.com" ||
    host.endsWith(".youtube.com")
  );
}
