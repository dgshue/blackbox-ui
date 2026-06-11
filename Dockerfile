FROM node:26-alpine

ARG VERSION=dev

LABEL org.opencontainers.image.title="blackbox-ui" \
      org.opencontainers.image.description="Web UI sidecar for configuring Prometheus Blackbox Exporter" \
      org.opencontainers.image.source="https://github.com/dgshue/blackbox-ui" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    CONFIG_PATH=/config/blackbox.yml \
    BLACKBOX_URL=http://blackbox:9115

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY shared ./shared
COPY server ./server
COPY public ./public

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "server/healthcheck.js"]

# Runs as root by default: the config volume is typically owned by root and
# must stay readable by the blackbox exporter (which runs as nobody).
# See the "Permissions" section of the README to run as a custom user.
CMD ["node", "server/index.js"]
