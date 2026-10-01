import { hex, textAscii, textUtf16be, u32be, u64be } from "./binary.js?v=2026.10.01.2";

export const INSTALLED_TYPES = new Set([0x4000, 0x5000, 0x6000, 0x7000]);

const CONTENT_TYPES = new Map([
  [0x00000001, "Saved Game"], [0x00000002, "Marketplace Content"], [0x00000003, "Publisher Content"],
  [0x00000FFD, "IPTV DVR"], [0x00001000, "Xbox 360 Title"], [0x00002000, "IPTV Pause Buffer"],
  [0x00003000, "XNA Community Game"], [0x00004000, "Installed Xbox 360 Game"],
  [0x00005000, "Original Xbox Game"], [0x00006000, "Social Title / Xbox App"],
  [0x00007000, "Games on Demand / SVOD"], [0x00008000, "System Pack"], [0x00009000, "Avatar Item"],
  [0x00010000, "Profile"], [0x00020000, "Gamer Picture"], [0x00030000, "Theme"],
  [0x00040000, "System Cache"], [0x00050000, "Storage Download"], [0x00060000, "Xbox Saved Game"],
  [0x00070000, "Xbox Download"], [0x00080000, "Game Demo"], [0x00090000, "Video"],
  [0x000A0000, "Game Title"], [0x000B0000, "Installer"], [0x000C0000, "Game Trailer"],
  [0x000D0000, "Xbox Live Arcade"], [0x000E0000, "XNA"], [0x000F0000, "License Store"],
  [0x00100000, "Movie"], [0x00200000, "TV"], [0x00300000, "Music Video"],
  [0x00400000, "Game Video"], [0x00500000, "Podcast Video"], [0x00600000, "Viral Video"]
]);

export async function readPackageHeader(source) {
  if (source.size < 0x3A9) throw new Error("The file is too small to be an Xbox 360 package.");
  const length = Math.min(source.size, 0xB000);
  const b = await source.read(0, length);
  const magic = textAscii(b, 0, 4);
  if (!["CON ", "LIVE", "PIRS"].includes(magic)) throw new Error(`Unsupported package signature “${magic || "unknown"}”.`);
  const contentType = u32be(b, 0x344);
  const packageImageSize = b.length >= 0x171A ? u32be(b, 0x1712) : 0;
  const contentImageSize = b.length >= 0x171A ? u32be(b, 0x1716) : 0;
  return {
    bytes: b,
    magic,
    signatureType: magic.trim(),
    headerSize: u32be(b, 0x340),
    contentType,
    contentTypeName: CONTENT_TYPES.get(contentType) || `Unknown (0x${hex(contentType)})`,
    metadataVersion: u32be(b, 0x348),
    contentSize: u64be(b, 0x34C),
    mediaId: u32be(b, 0x354),
    version: u32be(b, 0x358),
    baseVersion: u32be(b, 0x35C),
    titleId: u32be(b, 0x360),
    platform: b[0x364],
    executableType: b[0x365],
    discNumber: b[0x366],
    discCount: b[0x367],
    dataFileCount: u32be(b, 0x39D),
    dataFileSize: u64be(b, 0x3A1),
    displayTitle: b.length >= 0x511 ? textUtf16be(b, 0x411, 0x100) : "",
    description: b.length >= 0xE11 ? textUtf16be(b, 0xD11, 0x100) : "",
    publisher: b.length >= 0x1691 ? textUtf16be(b, 0x1611, 0x80) : "",
    packageTitle: b.length >= 0x1711 ? textUtf16be(b, 0x1691, 0x80) : "",
    packageImage: validImageRange(b, 0x171A, packageImageSize),
    contentImage: validImageRange(b, 0x571A, contentImageSize),
    installed: INSTALLED_TYPES.has(contentType)
  };
}

function validImageRange(bytes, offset, size) {
  if (!size || size > 0x4000 || offset + size > bytes.length) return null;
  return bytes.slice(offset, offset + size);
}

export function versionText(value) {
  return `${(value >>> 28) & 0xF}.${(value >>> 24) & 0xF}.${(value >>> 8) & 0xFFFF}.${value & 0xFF}`;
}
