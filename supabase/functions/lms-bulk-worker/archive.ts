import { Inflate } from "npm:fflate@0.8.3";

type Entry = { path: string; start: number; compressed: number; size: number; method: number; crc: number };
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_EXPANDED = 100 * 1024 * 1024; // Edge worker infrastructure ceiling.
const MAX_RATIO = 200;
const invalid = () => new Error("Invalid, unsupported or unsafe ZIP archive.");

function checkedPath(path: string, directory: boolean) {
  const segments = (directory ? path.slice(0, -1) : path).split("/");
  if (path.length > 750 || /[\\:\x00-\x1f\x7f]/.test(path)
    || segments.some((part) => !part || part === "." || part === ".." || part.length > 240)) throw invalid();
}

export function readArchive(bytes: Uint8Array, maxFile: number, maxFiles: number): Entry[] {
  if (bytes.length < 22) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (i: number) => view.getUint16(i, true);
  const u32 = (i: number) => view.getUint32(i, true);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557)) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break;
    end--;
  }
  if (end < Math.max(0, bytes.length - 65557) || u16(end + 4) || u16(end + 6)) throw invalid();
  const count = u16(end + 10);
  const offset = u32(end + 16);
  if (count !== u16(end + 8) || offset + u32(end + 12) !== end || count > maxFiles * 3) throw invalid();
  let cursor = offset;
  let total = 0;
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const ranges: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) throw invalid();
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    const compressed = u32(cursor + 20);
    const size = u32(cursor + 24);
    const nameSize = u16(cursor + 28);
    const next = cursor + 46 + nameSize + u16(cursor + 30) + u16(cursor + 32);
    const local = u32(cursor + 42);
    const type = (u32(cursor + 38) >>> 16) & 0xf000;
    if (next > end || local + 30 > offset || u32(local) !== 0x04034b50
      || flags & ~(0x800 | 0x8 | 0x6) || u16(cursor + 34) || ![0, 8].includes(method)
      || u16(local + 6) !== flags || u16(local + 8) !== method
      || (type && type !== 0x8000 && type !== 0x4000)) throw invalid();
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    if (u16(local + 26) !== nameSize || start + compressed > offset) throw invalid();
    const pathBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    if (!pathBytes.every((byte, index) => byte === bytes[local + 30 + index])) throw invalid();
    const path = decoder.decode(pathBytes);
    const directory = path.endsWith("/");
    checkedPath(path, directory);
    const key = path.replace(/\/$/, "").normalize("NFC").toLowerCase();
    if (seen.has(key) || (type === 0x4000 && !directory)
      || (directory && size !== 0) || (method === 0 && compressed !== size)) throw invalid();
    seen.add(key);
    ranges.push([local, start + compressed]);
    const crc = u32(cursor + 16);
    cursor = next;
    if (directory) continue;
    total += size;
    if (size < 1 || size > maxFile || !compressed || size > compressed * MAX_RATIO
      || total > MAX_EXPANDED || entries.length >= maxFiles) throw new Error("ZIP expansion exceeds safe limits.");
    entries.push({ path, start, compressed, size, method, crc });
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (cursor !== end || !entries.length || ranges.some(([start], index) => index > 0 && ranges[index - 1][1] > start)) throw invalid();
  return entries;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});

export function extractEntry(bytes: Uint8Array, entry: Entry): Uint8Array {
  const source = bytes.subarray(entry.start, entry.start + entry.compressed);
  const output = new Uint8Array(entry.size);
  let position = 0;
  let checksum = 0xffffffff;
  const write = (chunk: Uint8Array) => {
    if (position + chunk.length > entry.size) throw invalid();
    for (const byte of chunk) checksum = (checksum >>> 8) ^ crcTable[(checksum ^ byte) & 255];
    output.set(chunk, position);
    position += chunk.length;
  };
  if (entry.method === 0) {
    write(source);
  } else {
    const inflate = new Inflate(write);
    // Bound each decoder callback even when a corrupt entry understates its size.
    for (let offset = 0; offset < source.length; offset += 4096) {
      inflate.push(source.subarray(offset, offset + 4096), offset + 4096 >= source.length);
    }
  }
  if (position !== entry.size || ((checksum ^ 0xffffffff) >>> 0) !== entry.crc) throw invalid();
  return output;
}
