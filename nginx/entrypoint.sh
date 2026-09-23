#!/bin/sh
set -e

CERT_DIR=/etc/nginx/certs
CRT="$CERT_DIR/vast-internal.com.pem"
KEY="$CERT_DIR/vast-internal.com.key"
CN="${SSL_CN:-cmp.vast-internal.com}"

mkdir -p "$CERT_DIR"

if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
  echo "[nginx] generating self-signed cert for CN=$CN"
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$KEY" \
    -out "$CRT" \
    -subj "/CN=$CN" \
    -addext "subjectAltName=DNS:$CN,DNS:localhost,IP:127.0.0.1"
fi

exec nginx -g "daemon off;"
