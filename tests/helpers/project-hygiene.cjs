"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Escaped patterns keep the gate subject to the same rule as project text.
const DASHES = /[\u2013\u2014]|&\u006ddash;|&\u006edash;|&#8(?:211|212);|&#x20(?:13|14);/i;
const FORBIDDEN = /\b(?:\u0061\u0069|\u006c\u006c\u006d|\u0067\u0070\u0074|\u006f\u0070\u0065\u006e\u0061\u0069|\u0063\u0068\u0061\u0074\u0067\u0070\u0074|\u0063\u006c\u0061\u0075\u0064\u0065|\u0061\u006e\u0074\u0068\u0072\u006f\u0070\u0069\u0063|\u0067\u0065\u006d\u0069\u006e\u0069|\u0064\u0065\u0065\u0070\u0073\u0065\u0065\u006b|\u0071\u0077\u0065\u006e|\u006d\u0069\u006e\u0069\u006d\u0061\u0078|\u006e\u0065\u006d\u006f\u0074\u0072\u006f\u006e|\u0063\u006f\u0064\u0065\u0078|\u0061\u0067\u0065\u006e\u0074\u0072\u006f\u0075\u0074\u0065\u0072|\u006f\u006d\u006e\u0069\u0072\u006f\u0075\u0074\u0065|\u006c\u0061\u0062\u006c\u0061\u0062\u002e\u0061\u0069|\u006d\u0069\u0073\u0074\u0072\u0061\u006c|\u0068\u0075\u0067\u0067\u0069\u006e\u0067\u0066\u0061\u0063\u0065|\u0070\u0065\u0072\u0070\u006c\u0065\u0078\u0069\u0074\u0079|\u0073\u0065\u0065\u0064\u0061\u006e\u0063\u0065|\u0068\u0069\u0067\u0067\u0073\u0066\u0069\u0065\u006c\u0064|\u006b\u0069\u006d\u0069|\u0067\u0072\u006f\u006b|\u0061\u0072\u0074\u0069\u0066\u0069\u0063\u0069\u0061\u006c\u0020\u0069\u006e\u0074\u0065\u006c\u006c\u0069\u0067\u0065\u006e\u0063\u0065|\u006d\u0061\u0063\u0068\u0069\u006e\u0065\u0020\u006c\u0065\u0061\u0072\u006e\u0069\u006e\u0067|\u006e\u0065\u0075\u0072\u0061\u006c|\u006e\u0065\u0075\u0072\u0061\u006c\u0020\u006e\u0065\u0074\u0077\u006f\u0072\u006b|\u0067\u0065\u006e\u0065\u0072\u0061\u0074\u0069\u0076\u0065|\u0067\u0065\u006e\u0065\u0072\u0061\u0074\u0069\u0076\u0065\u0020\u006d\u006f\u0064\u0065\u006c|\u0063\u0068\u0061\u0074\u0062\u006f\u0074|\u0069\u006e\u0074\u0065\u006c\u006c\u0069\u0067\u0065\u006e\u0074|\u0073\u006d\u0061\u0072\u0074|\u0073\u0065\u0061\u006d\u006c\u0065\u0073\u0073|\u0072\u0065\u0076\u006f\u006c\u0075\u0074\u0069\u006f\u006e\u0061\u0072\u0079|\u0067\u0061\u006d\u0065\u002d\u0063\u0068\u0061\u006e\u0067\u0069\u006e\u0067|\u0063\u0075\u0074\u0074\u0069\u006e\u0067\u002d\u0065\u0064\u0067\u0065|\u0062\u0072\u0065\u0061\u006b\u0074\u0068\u0072\u006f\u0075\u0067\u0068|\u006d\u0061\u0067\u0069\u0063\u0061\u006c|\u0075\u006e\u006c\u0065\u0061\u0073\u0068|\u0066\u006c\u0061\u0067\u0073\u0068\u0069\u0070|\u0070\u006f\u0077\u0065\u0072\u0065\u0064\u0020\u0062\u0079|\u0065\u0066\u0066\u006f\u0072\u0074\u006c\u0065\u0073\u0073|\u0064\u0065\u006c\u0069\u0067\u0068\u0074\u0066\u0075\u006c|\u0073\u0074\u0061\u0074\u0065\u002d\u006f\u0066\u002d\u0074\u0068\u0065\u002d\u0061\u0072\u0074|\u0077\u006f\u0072\u006c\u0064\u002d\u0063\u006c\u0061\u0073\u0073)\b/i;

const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/i;
const PHONE = /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\b\d{3}[ .-])\d{3}[ .-]\d{4}\b/;
const SECRET = /\b(?:\u0073\u006b-|\u0067\u0068\u0070_|\u0067\u0069\u0074\u0068\u0075\u0062_\u0070\u0061\u0074_|\u0041\u004b\u0049\u0041|\u0078\u006f\u0078[baprs]-|\u0067\u0073\u006b_|\u006e\u0076\u0061\u0070\u0069-|\u0074\u0076\u006c\u0079-|\u0041\u0049\u007a\u0061|\u0074\u0073\u006b\u0065\u0079-)[A-Za-z0-9_-]{16,}\b|-----\u0042\u0045\u0047\u0049\u004e (?:RSA |EC |OPENSSH )?\u0050\u0052\u0049\u0056\u0041\u0054\u0045 \u004b\u0045\u0059-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{16,}["']/i;
const PII = new RegExp([EMAIL.source, PHONE.source, SECRET.source].join("|"), "i");

function listProjectFiles(root) {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root, encoding: "utf8", timeout: 5000
  });
  return [...new Set(listed.split("\0").filter(Boolean))].filter(relative => {
    if (relative.split(/[\\/]/).includes("node_modules")) return false;
    const absolute = path.join(root, relative);
    return fs.existsSync(absolute) && fs.lstatSync(absolute).isFile();
  }).sort();
}

// Scan textual MP4 metadata, never compressed picture or audio bytes.
// Arbitrary short byte coincidences in mdat are not words or Unicode text.
function mp4Metadata(buffer) {
  const values = [];
  const containers = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "ilst"]);
  function walk(start, limit, inMetadata = false) {
    let offset = start;
    while (offset + 8 <= limit) {
      let size = buffer.readUInt32BE(offset), header = 8;
      const type = buffer.toString("latin1", offset + 4, offset + 8);
      if (size === 1) {
        if (offset + 16 > limit) throw new Error("Truncated media atom");
        size = Number(buffer.readBigUInt64BE(offset + 8)); header = 16;
      } else if (size === 0) size = limit - offset;
      if (!Number.isSafeInteger(size) || size < header || offset + size > limit) {
        throw new Error("Invalid media atom size");
      }
      const body = offset + header, end = offset + size;
      if (type === "meta") walk(body + 4, end, true);
      else if (type === "stsd") walk(body + 8, end, false);
      else if (["avc1", "avc3", "hvc1", "hev1", "vp09", "av01", "mp4v"].includes(type) && end - body >= 78) {
        const length = Math.min(buffer[body + 42], 31);
        values.push(buffer.toString("utf8", body + 43, body + 43 + length));
      }
      else if (containers.has(type)) walk(body, end, inMetadata || type === "udta" || type === "ilst");
      else if (inMetadata && type === "data") values.push(buffer.toString("utf8", body + 8, end));
      else if (type === "hdlr") values.push(buffer.toString("utf8", Math.min(body + 24, end), end));
      else if (inMetadata && type !== "free" && type !== "skip") {
        // Item-list entries wrap a data atom. Legacy copyright/name fields
        // are textual; support those without reading media payloads.
        if (body + 8 <= end && buffer.toString("latin1", body + 4, body + 8) === "data") walk(body, end, true);
        else values.push(buffer.toString("utf8", body, end));
      }
      offset = end;
    }
  }
  walk(0, buffer.length);
  return values.join("\n");
}
function projectText(root, relative) {
  const buffer = fs.readFileSync(path.join(root, relative));
  if (path.extname(relative).toLowerCase() === ".mp4") return mp4Metadata(buffer);
  if (buffer.includes(0)) throw new Error("Unsupported binary metadata format: " + relative);
  return buffer.toString("utf8");
}
function findings(root) {
  const output = [];
  for (const relative of listProjectFiles(root)) {
    const value = projectText(root, relative);
    if (DASHES.test(value)) output.push(relative + " contains a dash character or entity");
    if (FORBIDDEN.test(value)) output.push(relative + " contains a forbidden term");
    if (PII.test(value)) output.push(relative + " contains contact data or a secret-shaped value");
  }
  return output;
}
module.exports = { DASHES, FORBIDDEN, PII, EMAIL, PHONE, SECRET, listProjectFiles, mp4Metadata, projectText, findings };
