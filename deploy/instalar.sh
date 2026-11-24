#!/bin/sh
# Prepara Geometría en el servidor 24/7. Sin sudo: lo corre axcen.
# No toca el cortafuegos (eso va aparte, en el README).
set -eu
cd "$(dirname "$0")/.."

mkdir -p certs
chmod 700 certs

# El certificado de 10.8.0.20 firmado por la CA de casa: el mismo que el del taller.
if [ ! -f certs/geometria.crt ]; then
    cp /home/axcen/certs-10.8.0.20/taller.crt certs/geometria.crt
    cp /home/axcen/certs-10.8.0.20/taller.key certs/geometria.key
    chmod 644 certs/geometria.crt
    chmod 600 certs/geometria.key
    echo "Certificado copiado."
else
    echo "Ya había certificado: no lo toco."
fi

echo "Listo. Ahora: docker compose up -d --build"
