# geometria-datos: guarda las piezas en el servidor. Node puro, sin dependencias.
FROM node:22.12.0-alpine
WORKDIR /app
COPY index.mjs ./
RUN mkdir /data && chown 1000:1000 /data
USER 1000:1000
ENV DATA=/data PORT=8090
EXPOSE 8090
CMD ["node", "index.mjs"]
