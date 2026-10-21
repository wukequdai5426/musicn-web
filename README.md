# MusicN Web —— 深色在线播放前端（可打包成单容器镜像）

基于原版 [musicn-container](https://github.com/wy580477/musicn-container)（`msc -q`），
保留**下载**并新增**在线播放**、**同步歌词**、**播放队列**。

有两种用法：

| 方案 | 说明 | 适合 |
|---|---|---|
| **一、自建单容器镜像** | 一个容器 = musicn 后端 + 新前端，对外仍只占 `7478` | 推荐，长期使用、多设备 |
| 二、代理容器 | 保留原 musicn 容器，另起一个 Node 容器做代理 | 不想重新构建镜像 |

---

# 方案一：自建单容器镜像（推荐）

## 镜像里发生了什么

```
容器内
├─ msc -q -P 7479        后端，只监听 127.0.0.1:7479
└─ node server.js        前端 + 代理，对外监听 0.0.0.0:7478
```

所以你对外的端口映射、访问地址（`http://NAS:7478`）都不用变，只是镜像换了。

镜像额外做了两层稳定性保护（原版没有）：

1. **进程守护**：msc 因上游网络错误崩溃时，入口脚本 3 秒后自动拉起，容器不退出
2. **请求重试**：搜索 4 次指数退避重试、下载 3 次（仅在未向浏览器发出数据前），覆盖后端重启窗口

## 构建方式 A：GitHub 自动构建（推一次代码即可）

仓库里已包含 `.github/workflows/docker-publish.yml`，推送后自动构建
`linux/amd64` + `linux/arm64` 双架构镜像并推到 GHCR。

**1. 在 GitHub 网页新建空仓库**

打开 https://github.com/new ，仓库名填 `musicn-web`，**不要**勾选 "Add a README file"，创建。

**2. 把本目录推上去**

在本目录（含 `Dockerfile` 的这一层）执行：

```bash
bash push-to-github.sh <你的GitHub用户名>
```

首次推送会弹出浏览器让你登录 GitHub 授权（Git Credential Manager），授权一次后续免登录。

**3. 等构建完成**

打开 `https://github.com/<用户名>/musicn-web/actions`，等待 Build and push image 变绿（约 3–8 分钟）。

**4. 把镜像包设为公开（重要）**

GHCR 的包默认是私有的，NAS 免登录拉不到。打开：

```
https://github.com/users/<用户名>/packages/container/musicn-web/settings
```

在 Danger Zone → Change visibility → 改为 **Public**。

**5. 飞牛上换镜像**

编辑原来的 `docker-compose.yml`：

```yaml
services:
  musicn:
    image: ghcr.io/<你的GitHub用户名>/musicn-web:latest
    container_name: musicn
    restart: unless-stopped
    ports:
      - "7478:7478"
    volumes:
      - ./data:/data
```

> ⚠️ **必须删掉原来的这一行**：`entrypoint: ["/sbin/tini", "--", "msc", "-q"]`
> 新镜像自带入口脚本，保留这行会覆盖它，页面出不来。

然后：

```bash
docker compose pull
docker compose up -d
```

## 构建方式 B：飞牛本地构建（不走 GitHub，最省事）

把 `musicn-web` 目录（含 Dockerfile）传到飞牛，SSH 进去：

```bash
cd /vol1/1000/docker/musicn-web
docker build -t musicn-web:latest .
```

compose 改成：

```yaml
services:
  musicn:
    build: .
    container_name: musicn
    restart: unless-stopped
    ports:
      - "7478:7478"
    volumes:
      - ./data:/data
```

或直接用 `image: musicn-web:latest`。

> 前提：飞牛能拉取 `ghcr.io/wy580477/musicn-container` 基础镜像（你已成功部署过，说明没问题）。

## 验证

```bash
docker logs musicn
```

正常输出：

```
[musicn-web] 启动 musicn 后端，内部端口 7479
[musicn-web] musicn 后端已就绪
[musicn-web] 启动前端，对外端口 7478
MusicN Web 已启动，监听端口 7478
```

浏览器打开 `http://<NAS的IP>:7478`。

---

# 方案二：不建镜像，用代理容器

保留原 musicn 容器不动，另起一个极小的 Node 容器托管页面并代理接口。
适用于只想要界面、不想动原来 compose 的情况。

```yaml
  musicn-web:
    image: node:20-alpine
    container_name: musicn-web
    restart: unless-stopped
    working_dir: /app
    command: node server.js
    environment:
      - PORT=7479
      - MUSICN_TARGET=http://musicn:7478   # 同一 compose 用容器名互访
    volumes:
      - ./musicn-web:/app
    ports:
      - "7479:7479"
```

访问 `http://<NAS的IP>:7479`。

---

# 功能

- 🔍 **搜索**：咪咕 / 网易云 / 酷狗 / 酷我 四源切换，分页浏览，搜索历史本地留存
- ▶️ **在线播放**：底部播放条，上一首/下一首、进度拖动、音量调节、自动连播
- 📝 **同步歌词**：右栏逐行高亮，点击歌词跳转播放位置
- 📃 **播放队列**：搜索结果即队列，实时标记当前曲目
- ⬇️ **下载**：一键下载 mp3，文件名形如 `歌名 - 歌手.mp3`
- ⌨️ **快捷键**：`⌘K` / `/` 聚焦搜索、空格播放暂停、`⌘←/→` 切歌、`Esc` 关闭播放页
- 📱 **响应式**：桌面三栏，移动端单列 + 全屏播放页

# 排错

| 现象 | 处理 |
|---|---|
| 日志报 entrypoint 找不到或无执行权限 | Windows 上传时脚本被转成 CRLF。本仓库有 `.gitattributes` 强制 LF；若手动拷贝过，执行 `sed -i 's/\r$//' docker-entrypoint.sh` |
| 页面打不开，日志只有 msc 输出 | compose 里还留着旧 `entrypoint`，删掉它 |
| 页面能开、搜索报"无法连接 musicn 服务" | 后端没起来或端口不符。确认 `MUSICN_INTERNAL_PORT` 与 `MUSICN_TARGET` 一致（默认 7479） |
| NAS 拉取 ghcr.io 很慢或失败 | 用构建方式 B 在本地构建；或给 Docker 配镜像加速（如 `ghcr.nju.edu.cn`） |
| GitHub Actions 拉不到基础镜像 | 重跑一次 workflow 即可 |
| 搜索转圈十几秒 | 咪咕源要为每首歌抓歌词，首次较慢属正常 |
| 7478 端口被占用 | 改 `PORT` 与端口映射；内部端口用 `MUSICN_INTERNAL_PORT` 调整 |
| 日志频繁出现"后端意外退出…自动重启" | musicn 原项目遇到上游网络错误会崩溃，本镜像已自动拉起并配合请求重试，无需处理；若持续出现，检查 NAS 的 DNS（可给容器加 `dns: [223.5.5.5]`） |
| 咪咕源全部显示"暂无音源" | 上游行为：咪咕近期对多数曲目不再提供免费直链，换网易/酷狗源即可 |
| Windows 上 Docker Desktop 内测试时域名解析报 EAI_AGAIN | 宿主机走了代理/VPN 的常见现象，NAS 原生 Linux 无此问题 |

# 说明

- 音乐资源来自咪咕、酷狗、网易云等公开接口，普通音质（mp3）；会员/无版权歌曲显示"暂无音源"
- 仅供个人学习研究使用，请勿用于商业用途
- 字体使用 Space Grotesk（Google Fonts），离线时自动降级为中文字体栈
