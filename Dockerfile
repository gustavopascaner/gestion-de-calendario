FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/bookings.db
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME /app/data
EXPOSE 3000
CMD ["node", "src/server.js"]
