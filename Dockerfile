# MusicN 单容器版：msc 后端 + 深色在线播放前端
#
# 基于原版镜像 ghcr.io/wy580477/musicn-container，只增加前端页面与代理服务：
#   - musicn (msc -q) 在容器内部监听 7479，只供本机访问
#   - server.js 对外监听 7478，托管页面并把 /search、/download 代理到 7479
# 因此 compose 里端口映射仍是 "7478:7478"，用户访问 http://NAS:7478 即可看到新界面。
FROM ghcr.io/wy580477/musicn-container:latest

LABEL org.opencontainers.image.title="musicn-web" \
      org.opencontainers.image.description="MusicN 单容器版：msc 后端 + 深色在线播放前端（搜索/播放/歌词/下载）" \
      org.opencontainers.image.licenses="MIT"

USER root

COPY index.html server.js /opt/musicn-web/
COPY docker-entrypoint.sh /usr/local/bin/musicn-web-entrypoint
RUN chmod +x /usr/local/bin/musicn-web-entrypoint

# 内部 msc 端口 / 对外 Web 端口
ENV MUSICN_INTERNAL_PORT=7479 \
    PORT=7478

EXPOSE 7478

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/musicn-web-entrypoint"]
