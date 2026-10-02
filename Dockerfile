FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Render injects $PORT; the app reads it via config.ts. EXPOSE is
# documentation only, not functional, but kept for clean-checkout clarity.
EXPOSE 2000

CMD ["node", "dist/src/app.js"]
