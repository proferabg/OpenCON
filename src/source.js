export class BlobSource {
  constructor(file, name = file.name) {
    this.file = file;
    this.name = name;
    this.size = file.size;
  }

  async read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new RangeError(`Read outside ${this.name}: ${offset}+${length} > ${this.size}`);
    }
    return new Uint8Array(await this.file.slice(offset, offset + length).arrayBuffer());
  }

  async *stream(offset, length, chunkSize = 1024 * 1024) {
    let position = offset;
    const end = offset + length;
    while (position < end) {
      const count = Math.min(chunkSize, end - position);
      yield await this.read(position, count);
      position += count;
    }
  }
}

export class SliceSource {
  constructor(parent, offset, size, name = parent.name) {
    this.parent = parent;
    this.offset = offset;
    this.size = size;
    this.name = name;
  }
  read(offset, length) { return this.parent.read(this.offset + offset, length); }
  stream(offset, length, chunkSize) { return this.parent.stream(this.offset + offset, length, chunkSize); }
}

export async function collectStream(stream, maximum = 256 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) throw new Error("This browser cannot save that file without a streaming file handle. Use current Chrome or Edge.");
    chunks.push(chunk);
  }
  return new Blob(chunks, { type: "application/octet-stream" });
}
