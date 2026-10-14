FROM node:20-alpine
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN npm rebuild better-sqlite3 --build-from-source
COPY . .
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["node","server.js"]
