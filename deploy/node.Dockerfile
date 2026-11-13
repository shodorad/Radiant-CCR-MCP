# Shared by the MCP server and the renderer. Build context: the repo root.
#   docker build -f deploy/node.Dockerfile --build-arg APP=mcp .
FROM node:22-bookworm-slim
ARG APP
WORKDIR /app
COPY ${APP}/package.json ${APP}/package-lock.json ./
RUN npm ci
COPY ${APP}/ ./
# The MCP is TypeScript and is compiled; the renderer is plain JS and is not.
RUN if [ -f tsconfig.build.json ]; then npm run build && npm prune --omit=dev; else npm prune --omit=dev; fi
USER node
CMD ["npm", "start"]
