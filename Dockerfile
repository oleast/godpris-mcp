# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app
ARG GODPRIS_VERSION
ENV NODE_ENV=production \
    GODPRIS_HOST=0.0.0.0 \
    GODPRIS_PORT=3333 \
    GODPRIS_DATA_DIR=/data \
    GODPRIS_VERSION=${GODPRIS_VERSION}
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.GODPRIS_PORT||3333)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Default: Streamable HTTP on :3333.
# stdio mode (for MCP clients that spawn the container): overriding CMD drops --http,
# so the server falls back to stdio:
#   docker run -i --rm IMAGE node dist/index.js
CMD ["node", "dist/index.js", "--http"]
