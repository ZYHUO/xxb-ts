// ────────────────────────────────────────
// StickerAsset — download sticker files from Telegram, cache locally
// Port of PHP StickerAssetService
// ────────────────────────────────────────

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_ASSET_ROOT = './data/sticker_assets';

function getAssetRoot(): string {
  return process.env['STICKER_ASSET_ROOT'] ?? DEFAULT_ASSET_ROOT;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertSafeId(fileUniqueId: string): void {
  if (!SAFE_ID_PATTERN.test(fileUniqueId)) {
    throw new Error(`Invalid fileUniqueId: ${fileUniqueId}`);
  }
}

export function buildAssetPaths(
  fileUniqueId: string,
  format: string,
): {
  rawDir: string;
  previewDir: string;
  rawPath: string;
  previewPath: string;
} {
  assertSafeId(fileUniqueId);
  const root = getAssetRoot();
  const ext = formatToExt(format);
  return {
    rawDir: resolve(root, 'raw', fileUniqueId),
    previewDir: resolve(root, 'preview', fileUniqueId),
    rawPath: resolve(root, 'raw', fileUniqueId, `original.${ext}`),
    previewPath: resolve(root, 'preview', fileUniqueId, 'preview.png'),
  };
}

export function writeRawAsset(
  fileUniqueId: string,
  format: string,
  rawBytes: Buffer,
): string {
  const paths = buildAssetPaths(fileUniqueId, format);
  ensureDir(paths.rawDir);
  ensureDir(paths.previewDir);
  writeFileSync(paths.rawPath, rawBytes);
  return paths.rawPath;
}

export function previewPath(
  fileUniqueId: string,
  extension = 'png',
): string {
  const root = getAssetRoot();
  return resolve(root, 'preview', fileUniqueId, `preview.${extension}`);
}

function formatToExt(format: string): string {
  switch (format) {
    case 'static_webp': return 'webp';
    case 'animated_tgs': return 'tgs';
    case 'video_webm': return 'webm';
    default: return 'bin';
  }
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}
