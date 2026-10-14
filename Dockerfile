FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN ./node_modules/.bin/node-pre-gyp install --fallback-to-build --directory ./node_modules/better-sqlite3 --nodedir=/usr/local
COPY . .
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node","server.js"]
