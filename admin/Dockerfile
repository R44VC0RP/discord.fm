FROM node:22-bookworm-slim
# ffmpeg renders archive sessions into branded mp4 clips (download feature).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js ui.html ./
USER node
EXPOSE 8091
CMD ["node", "server.js"]
