FROM node:24-alpine AS build
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html ./
COPY src ./src
COPY public ./public
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3103 DATABASE_PATH=/data/form3d.sqlite
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/dist/client ./dist/client
COPY server ./server
COPY worker/api.mjs worker/image.mjs ./worker/
COPY integration/meshy.mjs ./integration/
COPY drizzle/0000_reconstruction.sql ./drizzle/
USER node
EXPOSE 3103
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3103/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
