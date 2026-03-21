FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS production
RUN addgroup -g 1001 -S neuroforge && \
    adduser -S neuroforge -u 1001 -G neuroforge
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER neuroforge
EXPOSE 3000
CMD ["node", "src/index.js"]
