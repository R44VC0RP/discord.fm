FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY generator.js themes.js ./
COPY fonts ./fonts

USER node
CMD ["node", "/app/generator.js"]
