// gitobj.ts — the git object model, packfiles and the pkt-line codec, on node:crypto and node:zlib
// alone. Objects are addressed by the SHA-1 of "<type> <length>\0" + bytes, exactly as git computes
// them, so anything this forge writes can be read back by a real git client byte for byte.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

/** The object id of a typed payload. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** SHA-1 of raw bytes (pack trailers). */
export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ------------------------------------------------------------------ commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  /** Committer timestamp, seconds (0 when unparseable). */
  time: number;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let time = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5, 45);
    else if (line.startsWith('parent ')) parents.push(line.slice(7, 47));
    else if (line.startsWith('committer ')) {
      const match = / (\d+) [+-]\d{4}$/.exec(line);
      if (match !== null) time = Number(match[1]);
    }
  }
  return { tree, parents, message, time };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** git's tree order: byte order by name, directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries (sorting them the way git does). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** A commit object with a fixed identity line, as the forge writes its own commits. */
export function buildCommit(input: { tree: string; parents: string[]; message: string; time: number; name: string; email: string }): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  const stamp = `${input.name} <${input.email}> ${input.time} +0000`;
  lines.push(`author ${stamp}`, `committer ${stamp}`, '', input.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ------------------------------------------------------------------ deltas

/** Apply a git binary delta to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos]!;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          offset |= delta[pos]! << (8 * bit);
          pos += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= delta[pos]! << (8 * bit);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta size mismatch');
  return result;
}

// ------------------------------------------------------------------ packfiles

/** Serialize objects into a version-2 packfile (undeltified), with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const typeId = TYPE_IDS[object.type]!;
    let size = object.data.length;
    const headBytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

export interface PackReader {
  /** Store one fully-resolved object from the pack. */
  store(type: ObjectType, data: Buffer): string;
  /** Read an object already stored (a ref-delta base may live outside the pack). */
  read(oid: string): GitObject | null;
}

/**
 * Read a packfile at `offset` in `buf`, storing every object through `sink`. Answers the offset just
 * past the pack's trailer. Delta bases inside the pack resolve against the pack's own objects.
 */
export function readPack(buf: Buffer, offset: number, sink: PackReader): number {
  if (buf.length < offset + 12 || buf.toString('ascii', offset, offset + 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(offset + 8);
  let pos = offset + 12;
  const local = new Map<number, GitObject & { oid: string }>();
  const byOid = new Map<string, GitObject>();
  for (let index = 0; index < count; index += 1) {
    const objectStart = pos;
    let byte = buf[pos]!;
    pos += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const typeName = ID_TYPES[typeId];
    if (typeName === undefined) throw new Error(`pack object type ${typeId}`);
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeName === 'ofs-delta') {
      let back = buf[pos]!;
      pos += 1;
      let backValue = back & 0x7f;
      while (back & 0x80) {
        back = buf[pos]!;
        pos += 1;
        backValue = ((backValue + 1) << 7) | (back & 0x7f);
      }
      baseOffset = objectStart - backValue;
    } else if (typeName === 'ref-delta') {
      baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    // Inflate exactly this object's deflate stream: try the rest of the buffer, then trim by the
    // stream's own end. inflateSync stops at the stream end and reports nothing about the remainder,
    // so probe with a growing window only when the whole remainder fails (corrupt data).
    const inflated = inflateStream(buf, pos);
    pos = inflated.next;
    if (inflated.data.length !== size && typeName !== 'ofs-delta' && typeName !== 'ref-delta') {
      // Delta objects declare the delta's size, which is what was inflated; plain objects their own.
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    }
    if (typeName === 'ofs-delta' || typeName === 'ref-delta') {
      let base: GitObject | null = null;
      if (baseOffset >= 0) base = local.get(baseOffset) ?? null;
      if (base === null && baseOid !== null) base = byOid.get(baseOid) ?? sink.read(baseOid);
      if (base === null) throw new Error('delta base not found');
      const data = applyDelta(base.data, inflated.data);
      const oid = sink.store(base.type, data);
      local.set(objectStart, { type: base.type, data, oid });
      byOid.set(oid, { type: base.type, data });
    } else {
      const oid = sink.store(typeName, inflated.data);
      local.set(objectStart, { type: typeName, data: inflated.data, oid });
      byOid.set(oid, { type: typeName, data: inflated.data });
    }
  }
  const trailer = buf.toString('hex', pos, pos + 20);
  const expect = sha1Hex(buf.subarray(offset, pos));
  if (trailer !== expect) throw new Error('pack trailer checksum mismatch');
  return pos + 20;
}

/** Inflate one deflate stream starting at `pos`; answers the data and the offset just past the stream. */
function inflateStream(buf: Buffer, pos: number): { data: Buffer; next: number } {
  // Node's inflateSync stops at the stream's final block and tolerates trailing bytes, while a slice
  // that ends early throws. So the stream's end is the smallest slice length that inflates to the
  // same bytes as the whole remainder: bracket it exponentially, then bisect.
  const rest = buf.subarray(pos);
  const data = inflateSync(rest);
  const inflatesToData = (length: number): boolean => {
    try {
      return inflateSync(buf.subarray(pos, pos + length)).equals(data);
    } catch {
      return false;
    }
  };
  let hi = 64;
  while (hi < rest.length && !inflatesToData(hi)) hi *= 2;
  if (hi > rest.length) hi = rest.length;
  let lo = Math.max(1, hi >> 1);
  if (inflatesToData(lo)) {
    // The very first probe already covered the stream (a tiny object): bisect from the bottom.
    hi = lo;
    lo = 1;
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inflatesToData(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data, next: pos + lo };
}

// ------------------------------------------------------------------ pkt-line

/** One pkt-line: a 4-hex length prefix (counting itself) plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktItem =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Split a buffer into pkt-line items; `rest` is whatever follows the last complete packet. */
export function parsePkts(buf: Buffer, start = 0): { items: PktItem[]; next: number } {
  const items: PktItem[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const head = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      items.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2 || length === 3) break;
    if (pos + length > buf.length) break;
    items.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { items, next: pos };
}
