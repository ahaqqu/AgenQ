// Zstandard frame plumbing for the DSH adapter — stateless, harness-agnostic:
// a DSH session log is a concatenation of small independent frames (one per
// append batch), so both "read the whole log" and "read only what was appended"
// reduce to decoding complete frames and holding on to a partial trailing one.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export const READ_WINDOW = 8 * 1024 * 1024; // bytes decoded per read pass
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

// Bun's own zstd API is the intended path; node:zlib is the tier for a Bun
// build that ships the Node-compatible API without the Bun-namespaced one, and
// zstdAvailable() is what turns "neither exists" into one clear board warning
// instead of a TypeError per session.
const zlib = await import("node:zlib").catch(() => ({}));
const zstdDecompress =
  (typeof Bun !== "undefined" && typeof Bun.zstdDecompressSync === "function"
    ? (bytes) => Bun.zstdDecompressSync(bytes)
    : zlib.zstdDecompressSync) ?? null;

export const zstdAvailable = () => zstdDecompress != null;

export function readRange(path, start, length) {
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

const isMagicAt = (buf, i) =>
  buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
  buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3];

function nextMagic(buf, from) {
  for (let i = from; i + 4 <= buf.length; i++) if (isMagicAt(buf, i)) return i;
  return -1;
}

// Decode one frame sequence starting at `start`, extending the end past any
// false frame magic inside its data until a prefix decodes or the buffer runs
// out. Returns the decoded text and the byte offset just past what it
// consumed, or null when no prefix from `start` decodes.
function decodeFrom(buf, start) {
  let end = nextMagic(buf, start + 4);
  for (;;) {
    const sliceEnd = end === -1 ? buf.length : end;
    try {
      return {
        text: Buffer.from(zstdDecompress(buf.subarray(start, sliceEnd))).toString("utf8"),
        end: sliceEnd,
      };
    } catch {
      if (end === -1) return null; // ran out of data: incomplete tail frame
      end = nextMagic(buf, end + 4); // false magic — extend to the next one
    }
  }
}

// The first later frame boundary from which the rest of the buffer decodes on
// its own. That is the resume point when the frame at `pos` is corrupt: the
// bytes before it are lost, everything after it is not. Bounded, so a
// pathological buffer cannot turn recovery into an O(n²) scan.
const RECOVER_MAX_PROBES = 64;
function recoverStart(buf, pos) {
  let candidate = nextMagic(buf, pos + 4);
  for (let tries = 0; candidate !== -1 && tries < RECOVER_MAX_PROBES; tries++) {
    if (decodeFrom(buf, candidate)) return candidate;
    candidate = nextMagic(buf, candidate + 4);
  }
  return -1;
}

// Decode every *complete* frame in buf. Three outcomes:
//  - the frame at `pos` decodes (after extending past false magics inside its
//    data): the normal path;
//  - it does not, but a later frame does: the bytes in between are a corrupt
//    committed frame (DSH calls a checksum/decompression failure in a complete
//    frame corruption), so they are dropped and reported in `corrupt` rather
//    than blocking every event behind them forever;
//  - nothing from `pos` on decodes: an incomplete tail frame still being
//    appended — kept in `rest` and retried on the next read.
export function decodeFrames(buf) {
  let pos = 0;
  let text = "";
  let corrupt = 0;
  while (pos < buf.length) {
    const hit = decodeFrom(buf, pos);
    if (hit) {
      text += hit.text;
      pos = hit.end;
      continue;
    }
    const resume = recoverStart(buf, pos);
    if (resume < 0) break;
    corrupt += resume - pos;
    pos = resume;
  }
  return { text, rest: buf.subarray(pos), corrupt };
}

// The header is the log's first line and its first frame is tiny. Decoding
// just that frame is how a session outside the window still contributes its
// real identity (cwd, parent, creation time) without paying for the log.
// The probe is capped: a first frame that will not decode within 1 MB is
// treated as "no header" rather than reading a whole multi-hundred-MB file.
const HEADER_PROBE_MAX = 1024 * 1024;
export function readHeader(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  for (let take = 64 * 1024; take <= HEADER_PROBE_MAX; take *= 8) {
    const chunk = readRange(path, 0, Math.min(take, size));
    let line;
    if (path.endsWith(".zstd")) {
      if (!chunk.length || !isMagicAt(chunk, 0)) return null;
      const end = nextMagic(chunk, 4);
      try {
        line = Buffer.from(zstdDecompress(chunk.subarray(0, end === -1 ? chunk.length : end))).toString("utf8").split("\n")[0];
      } catch {
        line = undefined; // first frame larger than the probe — read more
      }
    } else {
      line = chunk.toString("utf8").split("\n")[0];
    }
    if (line !== undefined) {
      try {
        const ev = JSON.parse(line);
        return ev?.type === "session" ? ev : null;
      } catch {
        return null;
      }
    }
    if (take >= size) return null;
  }
  return null;
}
