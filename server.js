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
 *          本脚本把页面与接口放到同一源下，页面即可正常工作。
 *
 * 关于 /api/download —— 为什么不再转发给上游：
 *   上游 musicn 的实现是 `got.stream(url).pipe(res)`，管道上没有挂 error 监听。
 *   只要 CDN 返回 4xx/5xx 或中途断流，整个 msc 进程就会因未捕获异常退出
 *   （实测网易云返回 403 时，容器内 node 直接崩，紧接着就是 ECONNREFUSED）。
 *   所以这里改为自己拉音频流，并且：
 *     - 补浏览器 UA 与按音源的 Referer，绕过 CDN 的 UA / 防盗链白名单
 *     - 手动跟随 3xx（最多 5 跳），got 原本默认跟随、原生 http 不会
 *     - 透传 Range，保证 <audio> 可以拖动进度
 *     - 任何失败只返回 JSON 502，绝不拖垮进程
 *   上游那条路由本身不做任何签名或解密，只是 pipe，因此这样替换是等价的。
 *
 * 安全约定:
 *   - 搜索只代理白名单路径 /search，其余一律 404，不做任意路径转发
 *   - 下载只接受 http/https 音频地址，不允许 file: 之类的协议
 *   - 只转发必要请求头，不透传 cookie / authorization
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

// 允许代理到上游的路径白名单（下载已由本进程实现，不再转发）
const ALLOWED_PATHS = ['/search']
const FORWARD_HEADERS = ['accept', 'accept-language', 'user-agent']

// 部分 CDN 会用 UA 白名单拦非浏览器请求，这里统一用桌面 Chrome UA
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const REFERER = {
  wangyi: 'https://music.163.com/',
  kugou: 'https://www.kugou.com/',
  kuwo: 'https://www.kuwo.cn/',
  migu: 'https://music.migu.cn/',
}

// 重试：musicn 后端遇到上游网络错误会整体崩溃，入口脚本会在数秒内拉起它，
// 这里用指数退避覆盖那段重启窗口。
const SEARCH_MAX_ATTEMPTS = 4
const SEARCH_TIMEOUT_MS = 60000
const BACKOFF_MS = [1500, 4000, 8000]

// 音频流：首包/空闲超时、重定向上限、网络错误重试次数
const AUDIO_IDLE_MS = 20000
const AUDIO_MAX_ATTEMPTS = 2
const MAX_REDIRECTS = 5
const REDIRECT_CODES = [301, 302, 303, 307, 308]

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

function contentDisposition(name) {
  const ascii = String(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_')
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name)
}

/* ---------------- 搜索：转发到上游 msc ---------------- */

function proxySearch(req, res) {
  forward(req, res, 1)
}

function forward(req, res, attempt) {
  const upstreamPath = req.url.replace(/^\/api\//, '/')
  const pathOnly = upstreamPath.split('?')[0]

  if (ALLOWED_PATHS.indexOf(pathOnly) === -1) {
    jsonError(res, 404, 'Not Found')
    return
  }

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
      if (status >= 500 && attempt < SEARCH_MAX_ATTEMPTS && !res.headersSent) {
        upRes.resume()
        scheduleRetry(attempt, '上游返回 ' + status)
        return
      }
      const out = { ...upRes.headers }
      out['access-control-allow-origin'] = '*'
      out['cache-control'] = 'no-store'
      res.writeHead(status, out)
      upRes.pipe(res)
    }
  )

  upReq.setTimeout(SEARCH_TIMEOUT_MS, () => {
    upReq.destroy(new Error('上游响应超时'))
  })

  const onClientClose = () => {
    if (!res.writableEnded) {
      clientGone = true
      upReq.destroy()
    }
  }
  res.on('close', onClientClose)

  upReq.on('error', (err) => {
    if (clientGone) return
    if (attempt < SEARCH_MAX_ATTEMPTS && !res.headersSent) {
      scheduleRetry(attempt, err.message)
      return
    }
    jsonError(res, 502, '无法连接 musicn 服务: ' + err.message)
  })

  function scheduleRetry(attemptNo, reason) {
    res.removeListener('close', onClientClose)
    if (clientGone || res.writableEnded) return
    const delay = BACKOFF_MS[attemptNo - 1] || 4000
    console.log('[musicn-web] 上游无响应(' + reason + ')，' + delay + 'ms 后第 ' + (attemptNo + 1) + '/' + SEARCH_MAX_ATTEMPTS + ' 次重试')
    setTimeout(() => {
      if (res.writableEnded) return
      forward(req, res, attemptNo + 1)
    }, delay)
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    upReq.end()
  } else {
    req.pipe(upReq)
  }
}

/* ---------------- 下载 / 播放：本进程直连音频源 ---------------- */

function handleDownload(req, res) {
  let q
  try {
    q = new URL(req.url, 'http://placeholder')
  } catch (e) {
    return jsonError(res, 400, '请求地址不合法')
  }

  const raw = q.searchParams.get('url') || ''
  if (!raw) return jsonError(res, 400, '缺少 url 参数')

  let start
  try {
    start = new URL(raw)
  } catch (e) {
    return jsonError(res, 400, 'url 不合法')
  }
  if (start.protocol !== 'http:' && start.protocol !== 'https:') {
    return jsonError(res, 400, '只支持 http/https 音频地址')
  }

  const service = (q.searchParams.get('service') || '').toLowerCase()
  const songName = q.searchParams.get('songName') || 'audio.mp3'
  const range = req.headers.range
  const ifRange = req.headers['if-range']

  let gone = false
  let current = null
  let hops = 0
  let attempt = 1

  res.on('close', () => {
    if (!res.writableEnded) {
      gone = true
      if (current) current.destroy()
    }
  })

  function go(u) {
    if (gone || res.writableEnded) return

    const headers = { 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity' }
    if (REFERER[service]) headers.referer = REFERER[service]
    if (range) {
      headers.range = range
      if (ifRange) headers['if-range'] = ifRange
    }

    const mod = u.protocol === 'https:' ? https : http
    current = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      },
      (up) => {
        const status = up.statusCode || 502

        if (REDIRECT_CODES.indexOf(status) !== -1 && up.headers.location && hops < MAX_REDIRECTS) {
          hops++
          up.resume()
          let next
          try {
            next = new URL(up.headers.location, u)
          } catch (e) {
            return jsonError(res, 502, '音源重定向地址不合法')
          }
          return go(next)
        }

        if (status >= 400) {
          up.resume()
          // 5xx 可能是瞬时故障，再试一次；4xx 说明链接失效或防盗链，重试无意义
          if (status >= 500 && attempt < AUDIO_MAX_ATTEMPTS) {
            attempt++
            setTimeout(() => go(u), 1200)
            return
          }
          const tip = status === 401 || status === 403
            ? '音源拒绝访问（HTTP ' + status + '），链接可能已过期或该曲目需付费'
            : '音源返回 HTTP ' + status
          console.log('[musicn-web] 下载失败 ' + status + ' ' + u.hostname)
          return jsonError(res, 502, tip)
        }

        const out = {
          'content-type': up.headers['content-type'] || 'audio/mpeg',
          'accept-ranges': up.headers['accept-ranges'] || 'bytes',
          'cache-control': 'no-store',
          'content-disposition': contentDisposition(songName),
        }
        if (up.headers['content-length']) out['content-length'] = up.headers['content-length']
        if (up.headers['content-range']) out['content-range'] = up.headers['content-range']

        res.writeHead(status, out)
        up.pipe(res)
        up.on('aborted', () => res.destroy())
      }
    )

    // 空闲超时：CDN 长时间不吐字节时主动断开，避免请求永久挂住
    current.setTimeout(AUDIO_IDLE_MS, () => {
      current.destroy(new Error('音源响应超时'))
    })

    current.on('error', (err) => {
      if (gone || res.writableEnded) return
      if (attempt < AUDIO_MAX_ATTEMPTS) {
        attempt++
        setTimeout(() => go(u), 1200)
        return
      }
      console.log('[musicn-web] 下载出错 ' + u.hostname + ' ' + err.message)
      jsonError(res, 502, '拉取音频失败: ' + err.message)
    })

    current.end()
  }

  go(start)
}

/* ---------------- 路由 ---------------- */

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0]
  if (urlPath === '/api/download') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    handleDownload(req, res)
  } else if (urlPath.indexOf('/api/') === 0) {
    proxySearch(req, res)
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

// 进程级兜底：任何漏网的异常都不应该让页面服务一起消失
process.on('uncaughtException', (err) => {
  console.error('[musicn-web] 未捕获异常（已忽略，进程继续）: ' + err.message)
})
process.on('unhandledRejection', (err) => {
  console.error('[musicn-web] 未处理的 Promise 拒绝（已忽略）: ' + (err && err.message))
})

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('MusicN Web 已启动，监听端口 ' + PORT)
  console.log('代理目标 (musicn): ' + TARGET)
  console.log('浏览器访问: http://<本机或NAS的IP>:' + PORT)
})
