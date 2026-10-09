FROM node:22-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0
ENV PORT=5418
ENV XHS_STUDIO_DATA=/data
VOLUME ["/data"]
EXPOSE 5418
CMD ["node", "server.mjs"]
