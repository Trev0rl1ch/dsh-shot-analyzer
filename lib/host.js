/**
 * dsh-shot-analyzer — host half.
 *
 * One button in the DSH web composer asks this half for a screenshot; this half
 * captures the whole virtual desktop, stores the PNG, and hands it to the
 * current Session as a normal user prompt so the Agent analyzes the picture and
 * answers in the conversation.
 *
 * Routes (all same-origin, loopback-only):
 *   POST /dsh-shot/capture   capture + (by default) deliver into one Session
 *   GET  /dsh-shot/last.png  the most recent capture, for the button's preview
 *   GET  /dsh-shot/state.json metadata for the most recent capture
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CAPTURE_SCRIPT = path.join(PACKAGE_ROOT, 'lib', 'capture.ps1')

/** Where captures land. Purely a convenience copy; the Session gets its own durable one. */
const SHOT_DIR = path.join(DSH_HOME, 'screenshots')

/** Longest-side ladder tried in order; the first that the attachment policy accepts wins. */
const DEFAULT_SIZE_LADDER = [1600, 1280, 1024, 800]

const DEFAULT_PROMPT = [
  '【自动截图分析】下面这张图是我刚在 DSH 界面上按下「截图分析」按钮后抓取的全屏截图（已经作为图片附件放在本条消息里，你不必再自己截图）。',
  '',
  '请直接分析这张截图：',
  '1. 画面里是什么 / 正在发生什么；',
  '2. 如果这是 DSH 界面，指出当前所处的界面区域与状态；',
  '3. 有没有值得注意的异常、报错，或可以顺手改进的地方。',
  '',
  '用中文回答，简洁一点，先给结论。',
].join('\n')

/** Candidate PowerShell hosts, most-likely-first. */
function powershellCandidates() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return [
    'powershell.exe',
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'pwsh.exe',
  ]
}

function runPowerShell(scriptPath, args, timeoutMs) {
  const candidates = powershellCandidates()
  return new Promise((resolve) => {
    let index = 0
    const attempt = () => {
      if (index >= candidates.length) {
        resolve({ ok: false, error: 'no PowerShell host could be started' })
        return
      }
      const exe = candidates[index++]
      execFile(
        exe,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message || error).trim()
            // A missing executable is the only reason to try the next candidate.
            if (error.code === 'ENOENT') { attempt(); return }
            resolve({ ok: false, error: detail.slice(0, 600) || 'capture failed' })
            return
          }
          resolve({ ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() })
        },
      )
    }
    attempt()
  })
}

function readPngSize(buf) {
  // PNG: 8-byte signature, then IHDR length(4) type(4) width(4) height(4).
  if (buf.length < 24) return null
  if (buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function timestampSlug(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const parts = host.split('.')
  if (parts.length !== 4) return false
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false
  return Number(parts[0]) === 127
}

async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(body.length))
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function sendPng(res, buf) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'image/png')
  res.setHeader('Content-Length', String(buf.length))
  res.setHeader('Cache-Control', 'no-store')
  res.end(buf)
}

export default {
  name: 'dsh-shot-analyzer',

  apply(root, config) {
    const settings = {
      autoSend: config?.autoSend !== false,
      maxLongSide: Number.isFinite(config?.maxLongSide) ? Number(config.maxLongSide) : 0,
      prompt: typeof config?.prompt === 'string' && config.prompt.trim() ? config.prompt : DEFAULT_PROMPT,
      captureTimeoutMs: Number.isFinite(config?.captureTimeoutMs) ? Number(config.captureTimeoutMs) : 30000,
      // How many convenience copies to keep in SHOT_DIR (newest first).
      // 0 or negative keeps every capture. Enforced by capture.ps1 so the
      // policy can change without reloading this module.
      keepLocalCopies: Number.isFinite(config?.keepLocalCopies) ? Number(config.keepLocalCopies) : 10,
    }
    const sizeLadder = settings.maxLongSide > 0
      ? [settings.maxLongSide]
      : DEFAULT_SIZE_LADDER

    /** Most recent capture, kept for the button's preview and for /state.json. */
    let lastShot = null

    // Trust fence: this surface writes to the local disk and can drive the
    // Agent, so only loopback authorities may reach it. Delegates to the host
    // fence when that exists; fails closed otherwise.
    function denied(req, res) {
      const deny = () => { try { res.statusCode = 403; res.end() } catch { /* ignore */ } return true }
      try {
        const headers = req.headers || {}
        let url
        try { url = new URL(`http://${String(headers.host || '')}`) } catch { return deny() }
        if (!isLoopbackHostname(url.hostname)) return deny()
        const site = String(headers['sec-fetch-site'] || '').toLowerCase()
        if (site === 'cross-site') return deny()
        const origin = headers.origin
        if (typeof origin === 'string' && origin && origin !== 'null') {
          let originUrl
          try { originUrl = new URL(origin) } catch { return deny() }
          if (originUrl.host.toLowerCase() !== url.host.toLowerCase()) return deny()
        }
      } catch { return deny() }
      return false
    }

    /**
     * Capture the desktop to a PNG.
     * @returns {Promise<{ok: true, file: string, bytes: Buffer, width: number, height: number} | {ok: false, error: string}>}
     */
    async function capture() {
      if (process.platform !== 'win32') {
        return { ok: false, error: `screen capture is only implemented for Windows (current platform: ${process.platform})` }
      }
      let lastError = ''
      for (const maxLongSide of sizeLadder) {
        const file = path.join(SHOT_DIR, `shot-${timestampSlug()}.png`)
        const result = await runPowerShell(
          CAPTURE_SCRIPT,
          ['-Out', file, '-MaxLongSide', String(maxLongSide), '-KeepLocalCopies', String(settings.keepLocalCopies)],
          settings.captureTimeoutMs,
        )
        if (!result.ok) { lastError = result.error; continue }
        let bytes
        try { bytes = fs.readFileSync(file) } catch (err) { lastError = String(err?.message || err); continue }
        const size = readPngSize(bytes) || { width: 0, height: 0 }
        return { ok: true, file, bytes, width: size.width, height: size.height }
      }
      return { ok: false, error: lastError || 'screen capture failed' }
    }

    /**
     * Hand one captured PNG to a Session as a user prompt carrying the image.
     * @returns {Promise<{ok: true, delivered: true} | {ok: false, error: string}>}
     */
    async function deliver(ctx, sessionId, bytes, file) {
      const controller = ctx.get('sessionController')
      if (!controller || typeof controller.prompt !== 'function') {
        return { ok: false, error: 'sessionController service is unavailable; screenshot was captured but not sent' }
      }
      try {
        // `ctx.sessionController.prompt` is the Session-controller facade, not
        // the inner command controller: its host-side signature is
        // `prompt(request, signal)` and it calls `signal.throwIfAborted()` before
        // admitting anything. Omitting the signal throws a TypeError, so every
        // caller must supply one.
        await controller.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [
            { type: 'image', mediaType: 'image/png', data: bytes.toString('base64'), name: path.basename(file) },
            { type: 'text', text: settings.prompt },
          ],
        }, new AbortController().signal)
        return { ok: true, delivered: true }
      } catch (err) {
        const message = String(err?.message || err)
        const reason = err?.details?.reason || err?.reason
        return {
          ok: false,
          error: reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES'
            ? `当前会话的模型不支持图片输入，截图已保存到 ${file}`
            : message,
        }
      }
    }

    root.inject(['webServer'], (ctx) => {
      const dispose = []

      const route = (method, routePath, handler) => {
        dispose.push(ctx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: async (req, res) => {
            if (denied(req, res)) return
            if (String(req.method || 'GET').toUpperCase() !== method) {
              res.statusCode = 405
              res.setHeader('Allow', method)
              res.end()
              return
            }
            try {
              await handler(req, res)
            } catch (err) {
              if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err?.message || err) })
              else { try { res.end() } catch { /* ignore */ } }
            }
          },
        }))
      }

      route('POST', '/dsh-shot/capture', async (req, res) => {
        let body = {}
        try { body = await readBody(req) } catch (err) {
          sendJson(res, 400, { ok: false, error: String(err?.message || err) })
          return
        }
        const shot = await capture()
        if (!shot.ok) { sendJson(res, 500, { ok: false, error: shot.error }); return }

        let delivered = false
        let warning
        const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : ''
        if (settings.autoSend && sessionId) {
          const sent = await deliver(ctx, sessionId, shot.bytes, shot.file)
          if (sent.ok) delivered = true
          else warning = sent.error
        } else if (settings.autoSend && !sessionId) {
          warning = '没有拿到会话 id，截图只保存到了本地'
        }

        lastShot = {
          file: shot.file,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes.length,
          capturedAt: new Date().toISOString(),
          sessionId: sessionId || null,
          delivered,
        }
        sendJson(res, 200, {
          ok: true,
          file: shot.file,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes.length,
          capturedAt: lastShot.capturedAt,
          delivered,
          ...(warning ? { warning } : {}),
        })
      })

      route('GET', '/dsh-shot/last.png', async (_req, res) => {
        if (!lastShot) { res.statusCode = 404; res.end(); return }
        let bytes
        try { bytes = fs.readFileSync(lastShot.file) } catch { res.statusCode = 404; res.end(); return }
        sendPng(res, bytes)
      })

      route('GET', '/dsh-shot/state.json', async (_req, res) => {
        sendJson(res, 200, { ok: true, last: lastShot })
      })

      ctx.effect(() => () => {
        for (const d of dispose) { try { d() } catch { /* ignore */ } }
      })
    })
  },
}
