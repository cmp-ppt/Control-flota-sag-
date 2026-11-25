FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TZ=America/Santiago
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.js"]
