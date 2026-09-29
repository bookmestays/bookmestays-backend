// Media storage: S3 presigned PUT uploads, with a local-disk fallback for non-production (contract §9).
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";

export const UPLOADS_DIR = resolve(process.cwd(), "uploads");
const PRESIGN_TTL_SECONDS = 15 * 60;

export const s3Configured = () => !!(env.aws.bucket && env.aws.accessKeyId && env.aws.secretAccessKey);
export const localStorageEnabled = () => !s3Configured() && !env.isProd;

let client: S3Client | null = null;
const s3 = () =>
  (client ??= new S3Client({
    region: env.aws.region,
    credentials: { accessKeyId: env.aws.accessKeyId, secretAccessKey: env.aws.secretAccessKey },
  }));

const trimSlash = (s: string) => s.replace(/\/+$/, "");

export function publicUrlFor(key: string) {
  if (s3Configured()) {
    return env.aws.mediaCdnUrl
      ? `${trimSlash(env.aws.mediaCdnUrl)}/${key}`
      : `https://${env.aws.bucket}.s3.${env.aws.region}.amazonaws.com/${key}`;
  }
  return `${trimSlash(env.apiUrl)}/uploads/${key}`;
}

/** Only keys we generate are accepted by the local upload endpoint (no path traversal). */
export const KEY_RE = /^[a-z_]+\/[A-Za-z0-9-]+\/\d{4}\/\d{2}\/[A-Za-z0-9-]+\.[a-z0-9]{2,5}$/;

const localSig = (key: string, exp: number, contentType: string, size: number) =>
  createHmac("sha256", env.jwtAccessSecret).update(`${key}|${exp}|${contentType}|${size}`).digest("base64url");

export function verifyLocalSig(key: string, q: Record<string, string | undefined>) {
  const exp = Number(q.exp);
  const size = Number(q.size);
  if (!q.sig || !exp || exp < Date.now() / 1000 || !q.ct) return null;
  const expected = Buffer.from(localSig(key, exp, q.ct, size));
  const given = Buffer.from(q.sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { contentType: q.ct, maxSize: size };
}

export async function presignUpload(key: string, contentType: string, sizeBytes: number) {
  if (s3Configured()) {
    const uploadUrl = await getSignedUrl(
      s3(),
      new PutObjectCommand({ Bucket: env.aws.bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes }),
      { expiresIn: PRESIGN_TTL_SECONDS },
    );
    return { uploadUrl, s3Key: key, publicUrl: publicUrlFor(key), headers: { "Content-Type": contentType } };
  }
  if (env.isProd) throw new AppError(503, "STORAGE_NOT_CONFIGURED", "Media storage is not configured yet");
  const exp = Math.floor(Date.now() / 1000) + PRESIGN_TTL_SECONDS;
  const qs = new URLSearchParams({
    exp: String(exp),
    ct: contentType,
    size: String(sizeBytes),
    sig: localSig(key, exp, contentType, sizeBytes),
  });
  return {
    uploadUrl: `${trimSlash(env.apiUrl)}/media/local-upload/${key}?${qs}`,
    s3Key: key,
    publicUrl: publicUrlFor(key),
    headers: { "Content-Type": contentType },
  };
}

export async function writeLocal(key: string, data: ArrayBuffer) {
  const path = join(UPLOADS_DIR, key);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, data);
}

/** Deletes the stored object. Never throws (media rows can reference external URLs, e.g. demo data). */
export async function deleteObject(key: string) {
  try {
    if (!KEY_RE.test(key)) return;
    if (s3Configured()) await s3().send(new DeleteObjectCommand({ Bucket: env.aws.bucket, Key: key }));
    else await rm(join(UPLOADS_DIR, key), { force: true });
  } catch (err) {
    console.error("media delete failed", key, err);
  }
}
