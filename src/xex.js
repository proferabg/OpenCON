const moduleVersion = encodeURIComponent(globalThis.OPENCON_BUILD?.version || "development");
const { hex, textAscii, u32be } = await import(`./binary.js?v=${moduleVersion}`);

const XEX_MAGIC = "XEX2";
const XEX_HEADER_PE_BASE = 0x00010201;
const XEX_HEADER_VITAL_STATS = 0x00018002;
const XEX_HEADER_PE_MODULE_NAME = 0x000183FF;
const XEX_HEADER_EXECUTION_ID = 0x00040006;

export const MAX_XEX_HEADER_SIZE = 64 * 1024;

export function parseXex(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 0x18) throw new Error("The XEX header is truncated.");
  if (textAscii(bytes, 0, 4) !== XEX_MAGIC) throw new Error("The selected file is not an XEX2 executable.");

  const sizeOfHeaders = u32be(bytes, 0x08);
  const securityInfoOffset = u32be(bytes, 0x10);
  const entryCount = u32be(bytes, 0x14);
  if (sizeOfHeaders < 0x18 || sizeOfHeaders > MAX_XEX_HEADER_SIZE) throw new Error(`The XEX header size is invalid (0x${hex(sizeOfHeaders)}).`);
  if (sizeOfHeaders > bytes.length) throw new Error(`The XEX header needs ${sizeOfHeaders} bytes, but only ${bytes.length} were read.`);
  if (entryCount > 0x1000 || 0x18 + entryCount * 8 > sizeOfHeaders) throw new Error("The XEX optional-header directory is invalid.");

  const entries = new Map();
  for (let i = 0; i < entryCount; i++) {
    const offset = 0x18 + i * 8;
    entries.set(u32be(bytes, offset), u32be(bytes, offset + 4));
  }

  const peBase = inlineValue(entries, XEX_HEADER_PE_BASE);
  const vitalOffset = referencedOffset(entries, XEX_HEADER_VITAL_STATS, sizeOfHeaders, 8);
  const nameOffset = referencedOffset(entries, XEX_HEADER_PE_MODULE_NAME, sizeOfHeaders, 4);
  const executionOffset = referencedOffset(entries, XEX_HEADER_EXECUTION_ID, sizeOfHeaders, 0x18);

  let imageSize = null;
  if (securityInfoOffset) {
    requireRange(securityInfoOffset, 8, sizeOfHeaders, "XEX security information");
    imageSize = u32be(bytes, securityInfoOffset + 4);
  }

  let checksum = null;
  let timestamp = null;
  if (vitalOffset !== null) {
    checksum = u32be(bytes, vitalOffset);
    timestamp = u32be(bytes, vitalOffset + 4);
  }

  let originalPeName = null;
  if (nameOffset !== null) {
    const structureSize = u32be(bytes, nameOffset);
    if (structureSize < 4) throw new Error("The XEX original PE name has an invalid size.");
    requireRange(nameOffset, structureSize, sizeOfHeaders, "XEX original PE name");
    originalPeName = textAscii(bytes, nameOffset + 4, structureSize - 4).replace(/\0.*$/s, "");
  }

  let execution = null;
  if (executionOffset !== null) {
    const titleId = u32be(bytes, executionOffset + 0x0C);
    execution = {
      mediaId: u32be(bytes, executionOffset),
      version: u32be(bytes, executionOffset + 4),
      baseVersion: u32be(bytes, executionOffset + 8),
      titleId,
      ...titleIdParts(titleId)
    };
  }

  return { sizeOfHeaders, imageSize, peBase, checksum, timestamp, originalPeName, execution };
}

export function titleIdParts(titleId) {
  const value = Number(titleId) >>> 0;
  const publisherBytes = [(value >>> 24) & 0xFF, (value >>> 16) & 0xFF];
  const publisher = publisherBytes.every(byte => byte >= 0x20 && byte <= 0x7E)
    ? String.fromCharCode(...publisherBytes)
    : hex(value >>> 16, 4);
  const titleNumber = value & 0xFFFF;
  return { publisher, titleNumber, breakdown: `${publisher}-${titleNumber.toString().padStart(4, "0")}` };
}

export function formatXexVersion(value) {
  if (value === null || value === undefined) return "—";
  const number = Number(value) >>> 0;
  return `v${(number >>> 28) & 0xF}.${(number >>> 24) & 0xF}.${(number >>> 8) & 0xFFFF}.${number & 0xFF}`;
}

export function formatXexTimestamp(value) {
  if (value === null || value === undefined) return "—";
  const number = Number(value) >>> 0;
  const date = new Date(number * 1000);
  if (!number || Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23", timeZone: "UTC", timeZoneName: "short"
  }).format(date);
}

function inlineValue(entries, key) {
  return entries.has(key) ? entries.get(key) : null;
}

function referencedOffset(entries, key, headerSize, length) {
  if (!entries.has(key)) return null;
  const offset = entries.get(key);
  requireRange(offset, length, headerSize, `XEX optional header 0x${hex(key)}`);
  return offset;
}

function requireRange(offset, length, limit, description) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > limit) {
    throw new Error(`${description} points outside the XEX header.`);
  }
}
