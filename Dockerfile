# Context-Saver remote gateway image.
#   docker build -t context-saver .
#   docker run --rm -p 3270:3270 \
#     -v ~/.context-saver:/root/.context-saver:ro \
#     context-saver
FROM node:22-alpine

# The entire product is one file — no dependencies to install.
WORKDIR /app
COPY context-saver.mjs .
COPY README.md LICENSE CHANGELOG.md server.json llms.txt ./

ENV NODE_ENV=production
EXPOSE 3270

# Healthcheck via the gateway's own /health endpoint.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3270/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# HTTP + OAuth on by default; mount your config at /root/.context-saver/config.json
# or pass -e CONTEXT_SAVER_CONFIG=/app/config.json -v ./config.json:/app/config.json:ro
ENTRYPOINT ["node", "/app/context-saver.mjs"]
CMD ["--transport", "http", "--host", "0.0.0.0", "--port", "3270", "--auth"]
