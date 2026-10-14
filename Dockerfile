FROM node:20-bullseye-slim
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN npm rebuild better-sqlite3 --build-from-source
COPY . .
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node","server.js"]
