# Discord voice edge (TypeScript). Node >= 22.12 is required by @discordjs/voice 0.19.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true
# toolchain only for building @discordjs/opus if no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --legacy-peer-deps; else npm install --legacy-peer-deps; fi
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --legacy-peer-deps

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/healthz?live=1').then(r=>process.exit(0)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
