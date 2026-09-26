FROM node:20-alpine

WORKDIR /app

# 仅拷贝依赖清单，利用构建缓存安装依赖
COPY package*.json ./
RUN npm install --omit=dev

# 拷贝应用代码
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# 以非 root 用户运行
USER node

CMD ["node", "server.js"]
