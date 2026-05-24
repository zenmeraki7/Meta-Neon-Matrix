import crypto from "crypto";

const DEFAULT_KEY_VERSION = process.env.ACCESS_TOKEN_KEY_VERSION || "v1";
const KEY_HEX = process.env.ACCESS_TOKEN_ENCRYPTION_KEY || "";

function getKeyBuffer() {
  if (!KEY_HEX) return null;
  const key = Buffer.from(KEY_HEX, "hex");
  if (key.length !== 32) {
    throw new Error("ACCESS_TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  }
  return key;
}

export function canEncryptTokens() {
  try {
    return Boolean(getKeyBuffer());
  } catch {
    return false;
  }
}

export function encryptAccessToken(plainText) {
  if (!plainText) return null;
  const key = getKeyBuffer();
  if (!key) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${DEFAULT_KEY_VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptAccessToken(payload) {
  if (!payload) return null;
  const key = getKeyBuffer();
  if (!key) return null;

  const parts = String(payload).split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid encrypted token payload format");
  }

  const [, ivB64, tagB64, cipherB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(cipherB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

export function buildEncryptedTokenColumns(accessToken) {
  const encrypted = encryptAccessToken(accessToken);
  if (!encrypted) {
    return {
      accessToken: accessToken || null,
    };
  }

  return {
    accessToken: accessToken || null,
    accessTokenEncrypted: encrypted,
    accessTokenKeyVersion: DEFAULT_KEY_VERSION,
  };
}
