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
 * 存在原因: musicn 容器的 Web 服务未开启 CORS，浏览器跨源调用会被拦截。
 *          本脚本把页面与两个接口放到同一源下，页面即可正常工作。
 *
 * 安全约定:
 *   - 只代理白名单路径 /search、/download，其余一律 404，不做任意路径转发
 *   - 只转发必要请求头，不透传 cookie / authorization
 *   - 仅监听本进程可访问的端口，不写入磁盘、不记录请求内容
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

// 允许代理到上游的路径白名单
const ALLOWED_PATHS = ['/search', '/download']
// 需要透传给上游的请求头白名单（Range 用于音频拖动，条件请求用于缓存协商）
const FORWARD_HEADERS = ['accept', 'accept-language', 'user-agent', 'range', 'if-range', 'if-none-match', 'if-modified-since']

// 重试：musicn 后端遇到上游网络错误会整体崩溃，入口脚本会在数秒内拉起它，
// 这里用指数退避覆盖那段重启窗口。媒体流不可重复发送，故仅在未向客户端发出字节时重试。
const SEARCH_MAX_ATTEMPTS = 4
const DOWNLOAD_MAX_ATTEMPTS = 3
const BACKOFF_MS = [1500, 4000, 8000]
const SEARCH_TIMEOUT_MS = 60000

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

function jsonError(res, status, message) {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: message }))
}

function proxy(req, res) {
  forward(req, res, 1)
}

function forward(req, res, attempt) {
  // /api/search?... -> {target}/search?...
  // /api/download?... -> {target}/download?...
  const upstreamPath = req.url.replace(/^\/api\//, '/')
  const pathOnly = upstreamPath.split('?')[0]

  if (ALLOWED_PATHS.indexOf(pathOnly) === -1) {
    jsonError(res, 404, 'Not Found')
    return
  }

  const isSearch = pathOnly === '/search'
  const maxAttempts = isSearch ? SEARCH_MAX_ATTEMPTS : DOWNLOAD_MAX_ATTEMPTS

  const headers = { host: targetUrl.host, 'accept-encoding': 'identity' }
  FORWARD_HEADERS.forEach((name) => {
    if (req.headers[name]) headers[name] = req.headers[name]
  })

  let clientGone = false

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

  // 搜索请求加整体超时；下载是长连接，不设空闲超时
  if (isSearch) {
    upReq.setTimeout(SEARCH_TIMEOUT_MS, () => {
      upReq.destroy(new Error('上游响应超时'))
    })
  }

  // 浏览器关闭页面或切歌时中止上游请求，避免继续拉取整首音频
  const onClientClose = () => {
    if (!res.writableEnded) {
      clientGone = true
      upReq.destroy()
    }
  }
  res.on('close', onClientClose)

  upReq.on('error', (err) => {
    if (clientGone) return
    if (attempt < maxAttempts && !res.headersSent) {
      scheduleRetry(attempt, maxAttempts, err.message)
      return
    }
    jsonError(res, 502, '无法连接 musicn 服务: ' + err.message)
  })

  function scheduleRetry(attemptNo, max, reason) {
    res.removeListener('close', onClientClose)
    if (clientGone || res.writableEnded) return
    const delay = BACKOFF_MS[attemptNo - 1] || 4000
    console.log('[musicn-web] 上游无响应(' + reason + ')，' + delay + 'ms 后第 ' + (attemptNo + 1) + '/' + max + ' 次重试')
    setTimeout(() => {
      if (res.writableEnded) return
      forward(req, res, attemptNo + 1)
    }, delay)
  }

  // GET/HEAD 无请求体；其余方法透传
  if (req.method === 'GET' || req.method === 'HEAD') {
    upReq.end()
  } else {
    req.pipe(upReq)
  }
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0]
  if (urlPath.indexOf('/api/') === 0) {
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
