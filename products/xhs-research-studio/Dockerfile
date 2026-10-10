FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0
ENV PORT=5418
ENV XHS_STUDIO_DATA=/data
VOLUME ["/data"]
EXPOSE 5418
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:5418/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
