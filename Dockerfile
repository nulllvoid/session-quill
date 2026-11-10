# Session Quill team hub (docs/SELF-HOSTING.md). The hub uses Node built-ins only, so the image
# copies the source and installs nothing.
FROM node:22-alpine

ENV NODE_ENV=production \
    QUILL_HUB_DIR=/data \
    QUILL_HUB_HOST=0.0.0.0 \
    QUILL_HUB_PORT=47400

WORKDIR /app
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src
COPY ui ./ui

RUN addgroup -S quill && adduser -S -G quill quill \
 && mkdir /data && chown quill:quill /data
USER quill
VOLUME /data
EXPOSE 47400

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.QUILL_HUB_PORT || 47400) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["node", "bin/quill.js", "hub"]
CMD ["serve"]
