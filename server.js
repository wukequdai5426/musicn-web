/**
 * MusicN Web - 零依赖静态服务器 + API 代理
 *
 * 用法:
 *   node server.js                          # 代理目标默认 http://127.0.0.1:7478
 *   node server.js http://192.168.1.5:7478  # 指定 musicn 服务地址（不写 http:// 也会自动补全）
 *   PORT=8080 node server.js                # 指定本服务监听端口（默认 7479）
 *
 * Docker / 飞牛 fnOS 部署时用环境变量：MUSICN_TARGET、PORT
 *
 * 原理: musicn 容器的 Web 服务未开启 CORS，浏览器直接跨域访问会被拦截。
 *       本脚本把页面与 /search、/download 接口代理到同一源下，页面即可正常工作。
 */
const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')

function normalizeTarget(v) {
  v = String(v || '').trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(v) ? v : 'http://' + v
}

const TARGET = normalizeTarget(process.argv[2] || process.env.MUSICN_TARGET || 'http://127.0.0.1:7478')
const PORT = Number(process.env.PORT) || 7479

const targetUrl = new URL(TARGET)
const targetMod = targetUrl.protocol === 'https:' ? https : http

const INDEX_HTML = path.join(__dirname, 'index.html')

function sendIndex(res) {
  fs.readFile(INDEX_HTML, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('index.html 读取失败')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(buf)
  })
}

// 搜索请求自动重试：musicn 后端遇到上游网络错误会整体崩溃，
// 入口脚本会在数秒内把它拉起；对 /search 做指数退避重试即可覆盖重启窗口。
// /download 也做重试，但仅在尚未向客户端发出任何字节时（媒体流不可重复发）。
const SEARCH_MAX_ATTEMPTS = 4
const DOWNLOAD_MAX_ATTEMPTS = 3
const BACKOFF_MS = [1500, 4000, 8000]

function proxy(req, res) {
  forward(req, res, 1)
}

function forward(req, res, attempt) {
  // /api/search?... -> {target}/search?...
  // /api/download?... -> {target}/download?...
  const upstreamPath = req.url.replace(/^\/api\//, '/')
  const isSearch = upstreamPath.startsWith('/search')
  const headers = { ...req.headers, host: targetUrl.host }
  // 统一要求未压缩响应，避免二次解压处理
  headers['accept-encoding'] = 'identity'
  // 来自页面的跨源请求没有 cookie 必要，移除 origin/referer 以免上游校验失败
  delete headers.origin
  delete headers.referer

  const upReq = targetMod.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: upstreamPath,
      method: req.method,
      headers,
    },
    (upRes) => {
      const status = upRes.statusCode || 502
      const maxAttempts = isSearch ? SEARCH_MAX_ATTEMPTS : DOWNLOAD_MAX_ATTEMPTS
      // 后端崩溃时 express 会返回 5xx，此时重试（仅在尚未向客户端发送响应时）
      if (status >= 500 && attempt < maxAttempts && !res.headersSent) {
        upRes.resume()
        scheduleRetry(attempt, maxAttempts, '上游返回 ' + status)
        return
      }
      const out = { ...upRes.headers }
      out['access-control-allow-origin'] = '*'
      res.writeHead(status, out)
      upRes.pipe(res)
    }
  )
  upReq.on('error', (err) => {
    const maxAttempts = isSearch ? SEARCH_MAX_ATTEMPTS : DOWNLOAD_MAX_ATTEMPTS
    if (attempt < maxAttempts && !res.headersSent) {
      scheduleRetry(attempt, maxAttempts, err.message)
      return
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    }
    res.end(JSON.stringify({ error: '无法连接 musicn 服务: ' + err.message }))
  })

  function scheduleRetry(attemptNo, maxAttempts, reason) {
    const delay = BACKOFF_MS[attemptNo - 1] || 4000
    console.log('[musicn-web] 上游无响应(' + reason + ')，' + delay + 'ms 后第 ' + (attemptNo + 1) + '/' + maxAttempts + ' 次重试')
    setTimeout(() => forward(req, res, attemptNo + 1), delay)
  }

  // GET/HEAD 无请求体，直接结束；其余方法透传 body
  if (req.method === 'GET' || req.method === 'HEAD') {
    upReq.end()
  } else {
    req.pipe(upReq)
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0]
  if (urlPath.startsWith('/api/')) {
    proxy(req, res)
  } else if (urlPath === '/' || urlPath === '/index.html') {
    sendIndex(res)
  } else if (urlPath === '/favicon.ico') {
    res.writeHead(204)
    res.end()
  } else {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('MusicN Web 已启动，监听端口 ' + PORT)
  console.log('代理目标 (musicn): ' + TARGET)
  console.log('浏览器访问: http://<本机或NAS的IP>:' + PORT)
})
