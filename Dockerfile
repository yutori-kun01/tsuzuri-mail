# tsuzuri-mail（VPS 版）のコンテナ。1 つのプロセスで、公開ページ・管理画面・送信・SES イベント・夜間処理を動かす。
# 設定と秘密値はイメージに入れない（deploy/docker/compose.yml が ~/tsuzuri/tsuzuri.env を渡す）。
FROM node:22-bookworm-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g pnpm@10.28.0 && npm cache clean --force

WORKDIR /app
# 依存パッケージ（サーバーと、それが使うパッケージだけ。AWS CDK などは入れない）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter "@tsuzuri/server..." && pnpm store prune

COPY packages ./packages
COPY content ./content

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app/packages/server
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "src/vps/main.ts"]
