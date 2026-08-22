FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=4173
ENV HOST=0.0.0.0
ENV ENABLE_SCHEDULED_SCRAPING=true
ENV TRACKER_DATA_FILE=/app/data/store.json

VOLUME ["/app/data"]
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD curl -fsS http://localhost:4173/api/state || exit 1

CMD ["node", "server.mjs"]
