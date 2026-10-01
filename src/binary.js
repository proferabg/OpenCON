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

export function safeName(name) {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/, "");
  return clean || "unnamed";
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
