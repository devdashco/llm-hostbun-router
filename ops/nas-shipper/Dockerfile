FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY ship.mjs ./
ENV LOOP=1 INTERVAL=60 BATCH=500
# Long-running loop; no port. Coolify: deploy as a "background" service.
CMD ["node", "ship.mjs"]
