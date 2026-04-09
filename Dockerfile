# --- Stage 1: Build ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
RUN npm run build

# --- Stage 2: Production ---
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache sqlite
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY prompts/ prompts/
COPY migrations/ migrations/
EXPOSE 3000
CMD ["node", "dist/index.js"]
