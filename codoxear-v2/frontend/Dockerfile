FROM node:22-bookworm-slim AS build
WORKDIR /frontend
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /frontend
COPY --from=build /frontend/dist ./dist
COPY --from=build /frontend/serve.mjs ./serve.mjs
ENV CODOXEAR_CLIENT_HOST=0.0.0.0 CODOXEAR_CLIENT_PORT=19520
EXPOSE 19520
USER node
CMD ["node", "serve.mjs"]
