import fs from "fs";
import path from "path";
import crypto from "crypto";
import { canonicalSerializePayload } from "../../utils/immutablePayloadUtils.js";

const STORAGE_ROOT = process.env.OBJECT_STORAGE_ROOT || path.join(process.cwd(), "uploads", "storage");

export function canonicalizeMappings(mappings) {
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return {};
  const sortedKeys = Object.keys(mappings).sort();
  const canonical = {};
  for (const k of sortedKeys) {
    canonical[k] = mappings[k];
  }
  return canonical;
}

export async function saveFile({ shop, file }) {
  if (!shop) throw new Error("SHOP_REQUIRED");
  if (!file?.path && !file?.buffer) throw new Error("FILE_REQUIRED");

  let buffer;
  if (file.buffer) {
    buffer = file.buffer;
  } else {
    buffer = await fs.promises.readFile(file.path);
  }

  const contentSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const sizeBytes = BigInt(buffer.length);
  const storageKey = `imports/${shop}/${contentSha256}.csv`;
  const absolutePath = path.join(STORAGE_ROOT, storageKey);

  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.promises.writeFile(absolutePath, buffer);

  return {
    storageKey,
    contentSha256,
    sizeBytes,
  };
}

export function openReadStream(storageKey) {
  if (!storageKey) throw new Error("STORAGE_KEY_REQUIRED");
  const absolutePath = path.isAbsolute(storageKey) ? storageKey : path.join(STORAGE_ROOT, storageKey);
  if (!fs.existsSync(absolutePath)) {
    const error = new Error("FILE_NOT_FOUND_IN_STORAGE");
    error.code = "FILE_NOT_FOUND_IN_STORAGE";
    throw error;
  }
  return fs.createReadStream(absolutePath);
}

export async function verifyStreamSha256(streamOrPath, expectedSha256) {
  if (!expectedSha256) throw new Error("EXPECTED_SHA256_REQUIRED");
  const hash = crypto.createHash("sha256");

  if (typeof streamOrPath === "string") {
    const absolutePath = path.isAbsolute(streamOrPath) ? streamOrPath : path.join(STORAGE_ROOT, streamOrPath);
    const stream = fs.createReadStream(absolutePath);
    for await (const chunk of stream) {
      hash.update(chunk);
    }
  } else if (streamOrPath && typeof streamOrPath.on === "function") {
    for await (const chunk of streamOrPath) {
      hash.update(chunk);
    }
  } else if (Buffer.isBuffer(streamOrPath)) {
    hash.update(streamOrPath);
  } else {
    throw new Error("INVALID_STREAM_SOURCE");
  }

  const actualHash = hash.digest("hex");
  if (actualHash !== expectedSha256) {
    const error = new Error("CSV_CHECKSUM_MISMATCH");
    error.code = "CSV_CHECKSUM_MISMATCH";
    throw error;
  }

  return true;
}

export async function saveImmutablePayload({ shop, payload }) {
  if (!shop) throw new Error("SHOP_REQUIRED");
  const canonicalPayload = canonicalSerializePayload(payload);
  const payloadHash = crypto.createHash("sha256").update(canonicalPayload).digest("hex");
  const storageKey = `payloads/${shop}/${payloadHash}.json`;
  const absolutePath = path.join(STORAGE_ROOT, storageKey);
  await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await fs.promises.writeFile(absolutePath, canonicalPayload, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return { storageKey, payloadHash, payloadByteSize: Buffer.byteLength(canonicalPayload, "utf8") };
}

export async function loadImmutablePayload({ storageKey, expectedHash }) {
  if (!storageKey || !expectedHash) throw new Error("PAYLOAD_STORAGE_IDENTITY_REQUIRED");
  const absolutePath = path.join(STORAGE_ROOT, storageKey);
  const serialized = await fs.promises.readFile(absolutePath, "utf8");
  const actualHash = crypto.createHash("sha256").update(serialized).digest("hex");
  if (actualHash !== expectedHash) {
    const error = new Error("IMMUTABLE_PAYLOAD_STORAGE_HASH_MISMATCH");
    error.code = "IMMUTABLE_PAYLOAD_STORAGE_HASH_MISMATCH";
    throw error;
  }
  return JSON.parse(serialized);
}

export const immutableObjectStorage = {
  saveFile,
  openReadStream,
  verifyStreamSha256,
  saveImmutablePayload,
  loadImmutablePayload,
  canonicalizeMappings,
};

export default immutableObjectStorage;
