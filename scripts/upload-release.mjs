/**
 * Upload desktop release artifacts to R2 (S3-compatible).
 *
 * Usage (CI):
 *   node scripts/upload-release.mjs --artifacts-dir <dir> --version <ver>
 *
 * Required env:
 *   R2_ENDPOINT          e.g. <accountid>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET            bucket name
 *   R2_PUBLIC_BASE_URL   e.g. https://files.bothub.run
 */

import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

// ── helpers ────────────────────────────────────────────────────────────────

function requireEnv(name) {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`Missing env: ${name}`)
  return v
}

function normalizeEndpoint(raw) {
  return (raw || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

function encodeKey(key) {
  return key.split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

function contentTypeFor(name) {
  const l = name.toLowerCase()
  if (l.endsWith('.dmg'))     return 'application/x-apple-diskimage'
  if (l.endsWith('.zip'))     return 'application/zip'
  if (l.endsWith('.exe'))     return 'application/vnd.microsoft.portable-executable'
  if (l.endsWith('.deb'))     return 'application/vnd.debian.binary-package'
  if (l.endsWith('.rpm'))     return 'application/x-rpm'
  if (l.endsWith('.AppImage')) return 'application/octet-stream'
  return 'application/octet-stream'
}

// ── core upload ────────────────────────────────────────────────────────────

function createClient(cfg) {
  return new S3Client({
    region: cfg.region,
    endpoint: `https://${cfg.endpoint}`,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: cfg.forcePathStyle,
  })
}

async function uploadFile(client, cfg, filePath, objectKey) {
  const stat = await fs.stat(filePath)
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: objectKey,
    Body: createReadStream(filePath),
    ContentLength: stat.size,
    ContentType: contentTypeFor(path.basename(filePath)),
    CacheControl: 'public,max-age=31536000,immutable',
  }))
  const publicUrl = `${cfg.publicBaseUrl.replace(/\/+$/, '')}/${encodeKey(objectKey)}`
  return { objectKey, publicUrl, sizeBytes: stat.size }
}

// ── main ───────────────────────────────────────────────────────────────────

const SKIP_EXT = new Set(['.yml', '.yaml', '.json', '.blockmap'])

async function main() {
  const { values } = parseArgs({
    options: {
      'artifacts-dir': { type: 'string' },
      'version':       { type: 'string' },
      'prefix':        { type: 'string', default: 'releases/exec' },
    },
  })

  const artifactsDir = values['artifacts-dir']
  const version      = values['version']
  const prefix       = values['prefix']

  if (!artifactsDir || !version) {
    console.error('Usage: node upload-release.mjs --artifacts-dir <dir> --version <ver>')
    process.exit(1)
  }

  const cfg = {
    endpoint:       normalizeEndpoint(requireEnv('R2_ENDPOINT')),
    accessKeyId:    requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    bucket:         requireEnv('R2_BUCKET'),
    region:         (process.env.R2_REGION || 'auto').trim(),
    publicBaseUrl:  requireEnv('R2_PUBLIC_BASE_URL'),
    forcePathStyle: process.env.R2_FORCE_PATH_STYLE === 'true',
  }

  const client = createClient(cfg)
  const entries = await fs.readdir(artifactsDir, { withFileTypes: true })

  // Only upload installer files, skip metadata files
  const files = entries
    .filter(e => e.isFile())
    .map(e => e.name)
    .filter(name => !SKIP_EXT.has(path.extname(name).toLowerCase()))
    .sort()

  if (!files.length) {
    console.error(`No release artifacts found in ${artifactsDir}`)
    process.exit(1)
  }

  const results = []
  for (const name of files) {
    const filePath  = path.join(artifactsDir, name)
    // Replace existing version with new one: releases/exec/ddm-mac-arm64.dmg (no timestamp)
    const objectKey = `${prefix}/${name}`
    console.log(`Uploading ${name} → ${objectKey} ...`)
    const result = await uploadFile(client, cfg, filePath, objectKey)
    console.log(`  ✓ ${result.publicUrl}  (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB)`)
    results.push(result)
  }

  console.log(`\nUploaded ${results.length} file(s) to R2.`)
  await fs.writeFile('upload-results.json', JSON.stringify(results, null, 2) + '\n')
}

main().catch(err => {
  console.error('[upload-release]', err.message || err)
  process.exit(1)
})
