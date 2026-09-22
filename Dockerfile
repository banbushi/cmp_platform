# 与本地开发环境一致（本地 v25.7.0）。
# 注意：Node 20 不支持 require() 加载 ESM 包，uuid 12+ 是纯 ESM，会报 ERR_REQUIRE_ESM。
FROM swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/node:25-alpine

WORKDIR /app

COPY package*.json ./
# 用 npm ci 而非 npm install：严格按 package-lock.json 安装，
# 避免镜像层缓存导致装到与 lock 不符的旧版本（曾因此仍装到 uuid@13）
RUN npm ci --omit=dev

COPY . .

EXPOSE 9001

CMD ["node", "server.js"]
