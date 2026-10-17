#!/usr/bin/env bash
# Generate the throwaway TLS and SSH material used by the test containers, into
# .test-secrets/. Each part does nothing when its directory already holds a full set.
# Usage: test-secrets.sh
#
# .test-secrets/tls/
#   ca.pem / ca.key                 test CA
#   server.pem / server.key         server cert signed by the CA; SAN = localhost, pg16,
#                                   mysql8, mariadb11 (deliberately NO IP:127.0.0.1, so
#                                   connecting to 127.0.0.1 with verify-full must fail)
#   foreign-ca.pem / foreign-ca.key an unrelated CA (verify-ca must reject the server)
#   client.pem / client.key         client cert CN=certuser signed by the CA
# The TLS keys are world-readable on purpose: the containers' mysql user must read them.
#
# .test-secrets/ssh/ (client keys of user `tunnel` on the test sshd)
#   id_ed25519        ed25519, no passphrase
#   id_ed25519_enc    ed25519, passphrase `key-pass`
#   id_rsa_pem        RSA 2048 in the legacy PEM (PKCS#1) format, no passphrase
#   authorized_keys   the three public keys (mounted into the sshd container)
#   host/ssh_host_ed25519_key[.pub]
#                     host key of the test sshd, generated once so its fingerprint survives
#                     image rebuilds (the app's known_hosts entry stays valid)
#
# These files are test-only and gitignored; never reuse them anywhere else.
set -euo pipefail

cd "$(dirname "$0")/.."
TLS_DIR=.test-secrets/tls
TLS_FILES=(ca.pem ca.key server.pem server.key foreign-ca.pem foreign-ca.key client.pem client.key)
SSH_DIR=.test-secrets/ssh
SSH_FILES=(id_ed25519 id_ed25519_enc id_rsa_pem authorized_keys)
HOST_DIR=$SSH_DIR/host
HOST_FILES=(ssh_host_ed25519_key ssh_host_ed25519_key.pub)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

complete() { # dir files...
  local dir=$1 f
  shift
  for f in "$@"; do
    [[ -f "$dir/$f" ]] || return 1
  done
}

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

tls_material() {
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

  mkdir -p "$TLS_DIR"
  for f in "${TLS_FILES[@]}"; do
    install -m 0644 "$TMP/$f" "$TLS_DIR/$f"
  done
  echo "test TLS material written to $TLS_DIR"
}

ssh_material() {
  local d="$TMP/ssh" f
  mkdir -p "$d"
  ssh-keygen -q -t ed25519 -N '' -C tablemax-test -f "$d/id_ed25519"
  ssh-keygen -q -t ed25519 -N 'key-pass' -C tablemax-test-enc -f "$d/id_ed25519_enc"
  ssh-keygen -q -t rsa -b 2048 -m PEM -N '' -C tablemax-test-pem -f "$d/id_rsa_pem"
  cat "$d/id_ed25519.pub" "$d/id_ed25519_enc.pub" "$d/id_rsa_pem.pub" > "$d/authorized_keys"

  install -d -m 0700 "$SSH_DIR"
  for f in id_ed25519 id_ed25519_enc id_rsa_pem; do
    install -m 0600 "$d/$f" "$SSH_DIR/$f"
    install -m 0644 "$d/$f.pub" "$SSH_DIR/$f.pub"
  done
  install -m 0644 "$d/authorized_keys" "$SSH_DIR/authorized_keys"
  echo "test SSH keys written to $SSH_DIR"
}

host_key() {
  ssh-keygen -q -t ed25519 -N '' -C tablemax-test-sshd -f "$TMP/ssh_host_ed25519_key"
  install -d -m 0700 "$SSH_DIR" "$HOST_DIR"
  install -m 0600 "$TMP/ssh_host_ed25519_key" "$HOST_DIR/ssh_host_ed25519_key"
  install -m 0644 "$TMP/ssh_host_ed25519_key.pub" "$HOST_DIR/ssh_host_ed25519_key.pub"
  echo "test sshd host key written to $HOST_DIR"
}

complete "$TLS_DIR" "${TLS_FILES[@]}" || tls_material
complete "$SSH_DIR" "${SSH_FILES[@]}" || ssh_material
complete "$HOST_DIR" "${HOST_FILES[@]}" || host_key
