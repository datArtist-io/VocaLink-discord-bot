FROM node:22-bookworm-slim
# Build tools in case native modules (opus/sodium) need to compile
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
RUN mkdir -p data
CMD ["sh", "-c", "node src/deploy-commands.js && node src/index.js"]
