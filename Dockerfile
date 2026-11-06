FROM node:24.21.0-bookworm-slim
WORKDIR /app
COPY src ./src
CMD ["node", "src/raft/main.ts"]
