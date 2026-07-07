FROM node:22-bookworm-slim
WORKDIR /opt/opencode
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && test "$(./node_modules/.bin/opencode --version)" = "1.17.13"
COPY entrypoint.sh ./entrypoint.sh
RUN chmod 0555 ./entrypoint.sh
ENV OPENCODE_CONFIG=/config/opencode.json \
    OPENCODE_CONFIG_DIR=/config \
    HOME=/scratch/home
WORKDIR /scratch
EXPOSE 4096
USER node
CMD ["/opt/opencode/entrypoint.sh"]
