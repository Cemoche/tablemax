#!/usr/bin/env bash
# Generate the throwaway TLS material used by the test databases, into .test-secrets/tls/.
# Does nothing when the directory already holds a full set. Usage: test-certs.sh
#   ca.pem / ca.key                 test CA
#   server.pem / server.key         server cert signed by the CA; SAN = localhost, pg16,
#                                   mysql8, mariadb11 (deliberately NO IP:127.0.0.1, so
#                                   connecting to 127.0.0.1 with verify-full must fail)
#   foreign-ca.pem / foreign-ca.key an unrelated CA (verify-ca must reject the server)
#   client.pem / client.key         client cert CN=certuser signed by the CA
# The keys are world-readable on purpose: the containers' mysql user must read them.
# These files are test-only and gitignored; never reuse them anywhere else.
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=.test-secrets/tls
FILES=(ca.pem ca.key server.pem server.key foreign-ca.pem foreign-ca.key client.pem client.key)

complete=1
for f in "${FILES[@]}"; do
  [[ -f "$DIR/$f" ]] || complete=0
done
if [[ $complete == 1 ]]; then
  exit 0
fi

mkdir -p "$DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

key() { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$1" 2>/dev/null; }

ca() { # name subject
  key "$TMP/$1.key"
  openssl req -x509 -new -key "$TMP/$1.key" -sha256 -days 3650 -subj "$2" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$TMP/$1.pem"
}

leaf() { # name subject extfile
  key "$TMP/$1.key"
  openssl req -new -key "$TMP/$1.key" -subj "$2" -out "$TMP/$1.csr"
  openssl x509 -req -in "$TMP/$1.csr" -CA "$TMP/ca.pem" -CAkey "$TMP/ca.key" \
    -CAcreateserial -sha256 -days 3650 -extfile "$3" -out "$TMP/$1.pem" 2>/dev/null
}

ca ca "/CN=TableMax Test CA"
ca foreign-ca "/CN=TableMax Foreign Test CA"

cat > "$TMP/server.ext" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:pg16,DNS:mysql8,DNS:mariadb11
EOF
leaf server "/CN=localhost" "$TMP/server.ext"

cat > "$TMP/client.ext" <<'EOF'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EOF
leaf client "/CN=certuser" "$TMP/client.ext"

for f in "${FILES[@]}"; do
  install -m 0644 "$TMP/$f" "$DIR/$f"
done
echo "test TLS material written to $DIR"
