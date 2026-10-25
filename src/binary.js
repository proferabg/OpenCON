export const ascii = new TextDecoder("windows-1252");

export function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
export function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
export function u24le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) >>> 0; }
export function u24be(b, o) { return ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0; }
export function u32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
export function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
export function u64be(b, o) { return Number((BigInt(u32be(b, o)) << 32n) | BigInt(u32be(b, o + 4))); }

export function textAscii(b, o = 0, n = b.length - o) {
  return ascii.decode(b.subarray(o, o + n)).replace(/\0+$/, "");
}

export function textUtf16be(b, o, byteLength) {
  let result = "";
  const end = Math.min(b.length, o + byteLength);
  for (let p = o; p + 1 < end; p += 2) {
    const code = u16be(b, p);
    if (!code) break;
    result += String.fromCharCode(code);
  }
  return result;
}

export function hex(value, width = 8) {
  return (Number(value) >>> 0).toString(16).toUpperCase().padStart(width, "0");
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const MAX_OUTPUT_NAME_LENGTH = 240;

function truncateName(name, limit = MAX_OUTPUT_NAME_LENGTH) {
  const characters = Array.from(name);
  if (characters.length <= limit) return name;

  // Keep a short extension where possible so extracted files remain recognizable.
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 32 ? name.slice(dot) : "";
  const extensionLength = Array.from(extension).length;
  return `${characters.slice(0, Math.max(1, limit - extensionLength)).join("")}${extension}`;
}

export function safeName(name, fallback = "unnamed") {
  let clean = String(name ?? "").normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, "_")
    .replace(/[. ]+$/, "");
  if (!clean || clean === "." || clean === "..") clean = fallback;
  if (WINDOWS_DEVICE_NAME.test(clean)) clean = `_${clean}`;
  clean = truncateName(clean);
  return clean || fallback;
}

export function uniqueSafeName(name, usedNames, fallback = "unnamed") {
  const base = safeName(name, fallback);
  let candidate = base;
  let number = 2;
  while (usedNames.has(candidate.toLocaleLowerCase("en-US"))) {
    const dot = base.lastIndexOf(".");
    const hasExtension = dot > 0 && base.length - dot <= 32;
    const stem = hasExtension ? base.slice(0, dot) : base;
    const extension = hasExtension ? base.slice(dot) : "";
    const suffix = ` (${number++})`;
    const stemLimit = MAX_OUTPUT_NAME_LENGTH - Array.from(suffix + extension).length;
    candidate = `${Array.from(stem).slice(0, Math.max(1, stemLimit)).join("")}${suffix}${extension}`;
  }
  usedNames.add(candidate.toLocaleLowerCase("en-US"));
  return candidate;
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unit = -1;
  do { size /= 1024; unit++; } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}
