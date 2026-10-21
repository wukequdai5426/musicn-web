# MusicN Web —— 深色在线播放前端（单容器镜像）

基于原版 [musicn-container](https://github.com/wy580477/musicn-container)（`msc -q`），
保留**下载**并新增**在线播放**、**同步歌词**、**播放队列**。

**已发布镜像（公开，免登录拉取）**

```
ghcr.io/wukequdai5426/musicn-web:latest
```

支持 `linux/amd64` 与 `linux/arm64`，由 GitHub Actions 自动构建（见 `.github/workflows/docker-publish.yml`）。

---

## 飞牛 fnOS 部署（三步）

前提：原来的 musicn 容器可以停掉，镜像会取代它。

**1. 改 compose**

```yaml
services:
  musicn:
    image: ghcr.io/wukequdai5426/musicn-web:latest
    container_name: musicn
    restart: unless-stopped
    ports:
      - "7478:7478"
    volumes:
      - ./data:/data
```

> ⚠️ **必须删掉原来这行**：`entrypoint: ["/sbin/tini", "--", "msc", "-q"]`
> 新镜像自带入口脚本，保留会覆盖它，页面出不来。

**2. 拉取启动**

```bash
docker compose pull
docker compose up -d
```

**3. 访问**

浏览器打开 `http://<NAS的IP>:7478` —— 端口和地址与原来完全一致，只是界面变了。

---

## 镜像结构

```
容器内
├─ msc -q -P 7479        后端，只监听 127.0.0.1:7479
└─ node server.js        前端 + 代理，对外监听 0.0.0.0:7478
```

对外只暴露 7478 一个端口，页面与接口同源，因此不存在跨域问题。

### 与原版的差异（摘要）

完整逐项说明见 **[CHANGELOG.md](./CHANGELOG.md)**，包含运行结构、稳定性、界面、安全收口、未改动部分、安全边界与验证记录。

| 类别 | 原版 | 本镜像 |
|---|---|---|
| 进程模型 | 单进程 `msc` | 入口脚本守护 `msc` + 前端，崩溃自动拉起 |
| 前端 | 官方极简搜索页 | 深色三栏界面，完整播放器 / 同步歌词 / 队列 / 历史 / 移动端 |
| 失败处理 | 崩溃即容器退出、请求直接报错 | 进程自愈 + 搜索/下载自动重试 + 前后端双超时 |
| 接口暴露面 | msc 全部路径对外 | 仅白名单 `/search`、`/download`，其余 404，不透传 cookie |
| 依赖 | — | 服务端零 npm 依赖；前端无框架、无 CDN 脚本 |
| 后端逻辑 | — | **未改动**（音源解析、下载、参数结构完全沿用） |

### 稳定性保护

1. **进程守护**：msc 遇到上游网络错误会整体崩溃（原项目无异常捕获），入口脚本每 3 秒检测，崩溃即自动拉起；连续崩溃退避到 30 秒，避免空转
2. **请求重试**：搜索 4 次指数退避（1.5s / 4s / 8s）、下载 3 次（仅在尚未向浏览器发出字节前），覆盖后端重启窗口
3. **超时**：搜索请求服务端 60 秒、浏览器端 45 秒，超时给出明确提示而非无限等待
4. **连接回收**：浏览器切歌或关闭页面时中止上游请求，避免继续拉取整首音频

---

## 自己构建

### 方式 A：本地构建（基础镜像已在本地时几乎瞬间完成）

```bash
git clone https://github.com/wukequdai5426/musicn-web.git
cd musicn-web
docker build -t musicn-web:latest .
```

compose 里把 `image:` 换成 `build: .`。

若拉取基础镜像很慢，可先走国内镜像源：

```bash
docker pull ghcr.nju.edu.cn/wy580477/musicn-container:latest
docker tag ghcr.nju.edu.cn/wy580477/musicn-container:latest ghcr.io/wy580477/musicn-container:latest
docker build -t musicn-web:latest .
```

### 方式 B：Fork 后由 Actions 自动构建

Fork 本仓库 → 修改 `.github/workflows/docker-publish.yml` 中的镜像名（默认按 `github.repository_owner` 自动取）→ 推送 `main` 分支 →
Actions 自动构建 `amd64 + arm64` 并推送到 `ghcr.io/<你的用户名>/musicn-web:latest`。

首次推送后，若他人需要免登录拉取，在
`https://github.com/users/<用户名>/packages/container/musicn-web/settings`
把可见性改为 Public。

---

## 验证

```bash
docker logs musicn
```

正常输出：

```
[musicn-web] musicn 后端已启动 (pid 7，内部端口 7479)
[musicn-web] musicn 后端已就绪
[musicn-web] 前端已启动 (pid 46，对外端口 7478)
MusicN Web 已启动，监听端口 7478
代理目标 (musicn): http://127.0.0.1:7479
```

---

## 功能

- 🔍 **搜索**：咪咕 / 网易云 / 酷狗 / 酷我 四源切换，分页浏览，搜索历史本地留存
- ▶️ **在线播放**：底部播放条，上一首/下一首、进度拖动、音量调节、自动连播
- 📝 **同步歌词**：右栏逐行高亮，点击歌词跳转播放位置
- 📃 **播放队列**：搜索结果即队列，实时标记当前曲目
- ⬇️ **下载**：一键下载 mp3，文件名形如 `歌名 - 歌手.mp3`
- ⌨️ **快捷键**：`⌘K` / `/` 聚焦搜索、空格播放暂停、`⌘←/→` 切歌、`Esc` 关闭播放页
- 📱 **响应式**：桌面三栏，移动端单列 + 全屏播放页

界面为深色唱片内页风格（近黑底 `#08080A` + 酸性绿 `#CDFF4D`），细线分隔、无阴影堆叠；
44px 触摸目标、可见焦点环、遵循 `prefers-reduced-motion`。

---

## 排错

| 现象 | 处理 |
|---|---|
| 页面打不开，日志只有 msc 输出 | compose 里还留着旧 `entrypoint`，删掉它 |
| 日志报 entrypoint 找不到或无执行权限 | 脚本被转成 CRLF 了。仓库有 `.gitattributes` 强制 LF；手动拷贝过的执行 `sed -i 's/\r$//' docker-entrypoint.sh` 后重新 build |
| 页面能开、搜索报"无法连接 musicn 服务" | 后端没起来或端口不符。确认 `MUSICN_INTERNAL_PORT` 与 `MUSICN_TARGET` 一致（默认 7479） |
| 日志频繁出现"后端意外退出…自动重启" | 上游网络抖动触发 musicn 崩溃，镜像会自动恢复；若持续出现，给容器配稳定 DNS（`dns: [223.5.5.5]`） |
| 咪咕源全部"暂无音源" | 上游行为：咪咕对多数曲目已不提供免费直链，换网易/酷狗源 |
| 搜索转圈十几秒 | 咪咕源要为每首歌抓歌词，首次较慢属正常 |
| 7478 端口被占用 | 改 `PORT` 与端口映射；内部端口用 `MUSICN_INTERNAL_PORT` 调整 |
| 拉取时报 `read: connection reset by peer` | 见下方「国内网络拉取失败」 |
| 拉取 ghcr.io 很慢 | 用「自己构建」的方式，或改用下方镜像源 |

---

## 国内网络拉取失败（connection reset by peer）

典型报错：

```
43.98MB/43.98MB
read tcp [240e:...]:46730->[2606:50c0:8000::154]:443: read: connection reset by peer
```

`2606:50c0:8000::/32` 是 GitHub CDN 的 IPv6 段。出现该错误说明**拉取走 IPv6 到了 GitHub 的 CDN，中途被中断**，与镜像本身无关。按下面顺序处理：

### 方案 1：直接重试（最快，先试这个）

镜像层是分层下载的，已完成的层不会重下：

```bash
docker compose pull
# 失败就再来一次，通常第二次能续上剩余层
```

### 方案 2：换国内镜像源（推荐，已验证可用）

仓库提供了现成文件 `docker-compose.cn.yml`，或只在 `.env` 里覆盖镜像地址：

```bash
# 方式 A：用现成 compose
docker compose -f docker-compose.cn.yml up -d

# 方式 B：在原 compose 同目录新建 .env，写入一行
echo 'MUSICN_IMAGE=ghcr.nju.edu.cn/wukequdai5426/musicn-web:latest' > .env
docker compose up -d
```

`ghcr.nju.edu.cn` 是南京大学提供的 GHCR 反向代理，实测拉取本镜像约 30 秒，镜像内容与官方地址完全一致。

### 方案 3：让系统优先走 IPv4（一劳永逸，修复根因）

飞牛为 Debian 系，编辑 `/etc/gai.conf` 让域名解析优先返回 IPv4，再重启 Docker：

```bash
# 取消默认文件里那行注释；若不存在则追加
sudo sed -i 's/^#\?precedence ::ffff:0:0\/96.*/precedence ::ffff:0:0\/96  100/' /etc/gai.conf

# 验证：输出的地址应 IPv4 在前
getent ahosts ghcr.io | head -3

sudo systemctl restart docker
docker pull ghcr.io/wukequdai5426/musicn-web:latest
```

若不想动系统配置，也可以在飞牛「系统设置 → 网络」里临时关闭 IPv6，拉取完成后再打开。

### 方案 4：完全不拉镜像（本地构建 / 离线导入）

```bash
# A. 在飞牛上构建（基础镜像已在本地时只需数秒，不产生大流量下载）
cd /vol1/1000/docker/musicn-web
docker build -t musicn-web:latest .
# compose 里改为：build: .   并去掉 image 行

# B. 在另一台能拉通的机器上导出，再拷到飞牛导入
docker save ghcr.io/wukequdai5426/musicn-web:latest -o musicn-web.tar
docker load -i musicn-web.tar
```

## 说明

- 音乐资源来自咪咕、酷狗、网易云等公开接口，普通音质（mp3）；会员/无版权歌曲显示"暂无音源"
- 仅供个人学习研究使用，请勿用于商业用途
- 字体使用 Space Grotesk（Google Fonts），离线时自动降级为中文字体栈
