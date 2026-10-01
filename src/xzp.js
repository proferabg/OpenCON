const moduleVersion = encodeURIComponent(globalThis.OPENCON_BUILD?.version || "development");
const { textAscii, u16be, u32be } = await import(`./binary.js?v=${moduleVersion}`);
const { SliceSource } = await import(`./source.js?v=${moduleVersion}`);

const XZP_HEADER_SIZE = 0x16;
const MAX_XZP_ENTRIES = 0xFFFF;
const MAX_XZP_TABLE_SIZE = 32 * 1024 * 1024;

export class XzpArchive {
  static async open(source, archiveName = source.name || "archive.xzp") {
    if (!source || typeof source.read !== "function" || typeof source.stream !== "function") {
      throw new TypeError("XZP input must support bounded read and stream operations.");
    }
    if (source.size < XZP_HEADER_SIZE) throw new Error("The XZP header is truncated.");

    const header = await source.read(0, XZP_HEADER_SIZE);
    if (textAscii(header, 0, 4) !== "XUIZ") throw new Error("The selected file is not an XZP archive.");
    const version = u32be(header, 4);
    if (version !== 1 && version !== 3) throw new Error(`Unsupported XZP version ${version}. Only versions 1 and 3 are supported.`);

    const declaredSize = u32be(header, 8);
    const tableSize = u32be(header, 0x10);
    const entryCount = u16be(header, 0x14);
    const dataOffset = XZP_HEADER_SIZE + tableSize;
    if (entryCount > MAX_XZP_ENTRIES) throw new Error("The XZP entry count is invalid.");
    if (tableSize > MAX_XZP_TABLE_SIZE || dataOffset > source.size) throw new Error("The XZP resource table points outside the archive.");
    if (declaredSize && declaredSize > source.size) throw new Error(`The XZP declares ${declaredSize} bytes, but the file only contains ${source.size}.`);

    const table = await source.read(XZP_HEADER_SIZE, tableSize);
    const records = parseTable(table, version, entryCount, dataOffset, source.size);
    const root = makeDirectory(archiveName, "");
    const entries = [];
    for (const record of records) {
      const entry = insertEntry(root, source, record);
      entries.push(entry);
    }
    sortTree(root);
    return new XzpArchive(source, archiveName, version, declaredSize, dataOffset, entries, root);
  }

  constructor(source, name, version, declaredSize, dataOffset, entries, root) {
    Object.assign(this, { source, name, version, declaredSize, dataOffset, entries, root });
  }
}

function parseTable(bytes, version, entryCount, dataOffset, archiveSize) {
  const decoder = new TextDecoder(version === 1 ? "utf-16be" : "utf-8", { fatal: true });
  const records = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 9 > bytes.length) throw new Error(`XZP entry ${index} is truncated.`);
    const size = u32be(bytes, cursor);
    const relativeOffset = u32be(bytes, cursor + 4);
    const characterCount = bytes[cursor + 8];
    cursor += 9;
    const nameByteLength = characterCount * (version === 1 ? 2 : 1);
    if (!characterCount || cursor + nameByteLength > bytes.length) throw new Error(`XZP entry ${index} has an invalid name.`);
    let name;
    try { name = decoder.decode(bytes.subarray(cursor, cursor + nameByteLength)); }
    catch { throw new Error(`XZP entry ${index} has an invalid ${version === 1 ? "UTF-16BE" : "UTF-8"} name.`); }
    cursor += nameByteLength;
    name = normalizePath(name);
    const offset = dataOffset + relativeOffset;
    if (!name || offset < dataOffset || offset + size > archiveSize) throw new Error(`XZP entry ${index} points outside the archive.`);
    records.push({ name, size, offset });
  }
  return records;
}

function normalizePath(value) {
  const parts = String(value).replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
  if (parts.some(part => part === "..")) throw new Error("The XZP contains an unsafe parent-directory path.");
  return parts.join("/");
}

function insertEntry(root, source, record) {
  const parts = record.name.split("/");
  const fileName = parts.pop();
  let directory = root;
  for (const part of parts) {
    let child = directory.children.find(node => node.directory && node.name === part);
    if (!child) {
      const path = directory.path ? `${directory.path}/${part}` : part;
      child = makeDirectory(part, path);
      directory.children.push(child);
    }
    directory = child;
  }
  const slice = new SliceSource(source, record.offset, record.size, fileName);
  const node = {
    name: fileName,
    path: record.name,
    size: record.size,
    directory: false,
    sourceOffset: record.offset,
    read: (offset, length) => slice.read(offset, length),
    stream: (chunkSize = 1024 * 1024) => slice.stream(0, slice.size, chunkSize)
  };
  directory.children.push(node);
  return node;
}

function makeDirectory(name, path) {
  return { name, path, size: 0, directory: true, children: [] };
}

function sortTree(directory) {
  directory.children.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const child of directory.children) if (child.directory) sortTree(child);
}
