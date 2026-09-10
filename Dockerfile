ARG NODE_IMAGE=docker.m.daocloud.io/library/node:20-bookworm
ARG NGINX_IMAGE=docker.m.daocloud.io/library/nginx:1.27-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_registry=https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html admin.html vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NGINX_IMAGE} AS admin
COPY --from=build /app/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_registry=https://registry.npmmirror.com \
    HOST=0.0.0.0 \
    PORT=8787 \
    AXIOM_BROWSER_NO_SANDBOX=1 \
    AXIOM_DATA_DIR=/var/lib/axiom-agent
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY db ./db
EXPOSE 8787
CMD ["node", "server/index.mjs"]
