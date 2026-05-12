/**
 * Upload desktop release artifacts to R2 (S3-compatible),
 * then generate and upload release-info.json.
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
import { createReadStream, createHash } from 'node:fs'
import crypto from 'node:crypto'
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
  if (l.endsWith('.dmg'))      return 'application/x-apple-diskimage'
  if (l.endsWith('.zip'))      return 'application/zip'
  if (l.endsWith('.exe'))      return 'application/vnd.microsoft.portable-executable'
  if (l.endsWith('.deb'))      return 'application/vnd.debian.binary-package'
  if (l.endsWith('.rpm'))      return 'application/x-rpm'
  if (l.endsWith('.appimage')) return 'application/octet-stream'
  return 'application/octet-stream'
}

async function sha512Base64(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('base64')))
    stream.on('error', reject)
  })
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

async function uploadFile(client, cfg, filePath, objectKey, cacheControl) {
  const stat = await fs.stat(filePath)
  const body = await fs.readFile(filePath)
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: objectKey,
    Body: body,
    ContentLength: stat.size,
    ContentType: contentTypeFor(path.basename(filePath)),
    CacheControl: cacheControl ?? 'public,max-age=31536000,immutable',
  }))
  const publicUrl = `${cfg.publicBaseUrl.replace(/\/+$/, '')}/${encodeKey(objectKey)}`
  return { objectKey, publicUrl, sizeBytes: stat.size }
}

// ── release-info builder ───────────────────────────────────────────────────

/**
 * Detect platform/arch from versioned filename.
 * e.g. ddm-1.14.53-mac-arm64.dmg  → { platform: 'mac', arch: 'arm64', ext: 'dmg' }
 *      ddm-1.14.53-win-x64.exe    → { platform: 'win', arch: 'x64',   ext: 'exe' }
 */
function parseArtifactName(name, version) {
  const ext = path.extname(name).slice(1).toLowerCase()
  // strip prefix "ddm-<version>-"
  const stem = path.basename(name, path.extname(name))
    .replace(new RegExp(`^ddm-${version.replace(/\./g, '\\.')}-`), '')
  const parts = stem.split('-') // e.g. ['mac', 'arm64'] or ['win', 'x64']
  return { platform: parts[0], arch: parts[1] || 'x64', ext }
}

function buildReleaseInfo(version, results) {
  const releaseDate = new Date().toISOString()

  const info = {
    version,
    channel: 'latest',
    releaseDate,
    changelogUrl: `https://github.com/zhouchangui/ddm/releases/tag/v${version}`,
    releaseNotes: '',
    downloads: {
      macos: { arm64: null, x64: null },
      windows: { x64: null },
      linux: {
        appImage: { x64: null, arm64: null },
        deb: { x64: null, arm64: null },
        rpm: { x64: null },
      },
    },
  }

  for (const r of results) {
    const { platform, arch, ext } = parseArtifactName(path.basename(r.objectKey), version)
    const entry = {
      fileName: path.basename(r.objectKey),
      url: r.publicUrl,
      size: r.sizeBytes,
      sha512: r.sha512,
    }

    if (platform === 'mac' && ext === 'dmg') {
      info.downloads.macos[arch] = entry
    } else if (platform === 'win' && ext === 'exe') {
      info.downloads.windows[arch] = entry
    }
  }

  return info
}

// ── main ───────────────────────────────────────────────────────────────────

const SKIP_EXT = new Set(['.yml', '.yaml', '.json', '.blockmap'])

async function main() {
  const { values } = parseArgs({
    options: {
      'artifacts-dir': { type: 'string' },
      'version':       { type: 'string' },
      'prefix':        { type: 'string', default: 'releases/exec' },
      'meta-prefix':   { type: 'string', default: 'releases/latest' },
    },
  })

  const artifactsDir = values['artifacts-dir']
  const version      = values['version']
  const prefix       = values['prefix']
  const metaPrefix   = values['meta-prefix']

  if (!artifactsDir || !version) {
    console.error('Usage: node upload-release.mjs --artifacts-dir <dir> --version <ver>')
    process.exit(1)
  }

  const cfg = {
    endpoint:        normalizeEndpoint(requireEnv('R2_ENDPOINT')),
    accessKeyId:     requireEnv('R2_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
    bucket:          requireEnv('R2_BUCKET'),
    region:          (process.env.R2_REGION || 'auto').trim(),
    publicBaseUrl:   requireEnv('R2_PUBLIC_BASE_URL'),
    forcePathStyle:  process.env.R2_FORCE_PATH_STYLE === 'true',
  }

  const client = createClient(cfg)
  const entries = await fs.readdir(artifactsDir, { withFileTypes: true })

  const files = entries
    .filter(e => e.isFile())
    .map(e => e.name)
    .filter(name => !SKIP_EXT.has(path.extname(name).toLowerCase()))
    .sort()

  if (!files.length) {
    console.error(`No release artifacts found in ${artifactsDir}`)
    process.exit(1)
  }

  // 1. Upload installers with versioned filenames
  const results = []
  for (const name of files) {
    const filePath = path.join(artifactsDir, name)
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    const versionedName = base.replace(/^(ddm-)/, `$1${version}-`) + ext
    const objectKey = `${prefix}/${versionedName}`

    console.log(`Uploading ${name} → ${objectKey} ...`)
    const sha512 = await sha512Base64(filePath)
    const result = await uploadFile(client, cfg, filePath, objectKey)
    result.sha512 = sha512
    console.log(`  ✓ ${result.publicUrl}  (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB)`)
    results.push(result)
  }

  // 2. Generate release-info.json and upload to releases/latest/
  const releaseInfo = buildReleaseInfo(version, results)
  const releaseInfoJson = JSON.stringify(releaseInfo, null, 2) + '\n'
  const releaseInfoPath = path.join(artifactsDir, 'release-info.json')
  await fs.writeFile(releaseInfoPath, releaseInfoJson)

  const metaKey = `${metaPrefix}/release-info.json`
  console.log(`\nUploading release-info.json → ${metaKey} ...`)
  const metaResult = await uploadFile(client, cfg, releaseInfoPath, metaKey,
    'public,max-age=60,must-revalidate')
  console.log(`  ✓ ${metaResult.publicUrl}`)

  console.log(`\nUploaded ${results.length} installer(s) + release-info.json`)
  console.log(`release-info.json URL: ${metaResult.publicUrl}`)
  await fs.writeFile('upload-results.json', JSON.stringify({ installers: results, meta: metaResult }, null, 2) + '\n')
}

main().catch(err => {
  console.error('[upload-release]', err.message || err)
  process.exit(1)
})
