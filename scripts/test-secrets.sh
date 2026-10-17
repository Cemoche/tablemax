#!/usr/bin/env bash
# Generate the throwaway TLS and SSH material used by the test containers, into
# .test-secrets/. Idempotent: the TLS set is generated when incomplete, each SSH key only
# when missing (so adding a key never changes the existing ones, nor the sshd host key
# fingerprint), and authorized_keys is rebuilt from the client keys on every run.
# Usage: test-secrets.sh
# Needs openssl and ssh-keygen.
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
#   id_rsa_pem_enc    RSA 2048 in the legacy encrypted PEM format (Proc-Type: 4,ENCRYPTED,
#                     DEK-Info: AES-128-CBC), passphrase `key-pass`
#   id_ecdsa          ECDSA P-256, no passphrase
#   authorized_keys   the client public keys (mounted into the sshd container)
#   host/ssh_host_ed25519_key[.pub], host/ssh_host_ecdsa_key[.pub]
#                     host keys of the test sshd, generated once so their fingerprints
#                     survive image rebuilds (the app's known_hosts entry stays valid)
#
# These files are test-only and gitignored; never reuse them anywhere else.
set -euo pipefail

cd "$(dirname "$0")/.."
TLS_DIR=.test-secrets/tls
TLS_FILES=(ca.pem ca.key server.pem server.key foreign-ca.pem foreign-ca.key client.pem client.key)
SSH_DIR=.test-secrets/ssh
HOST_DIR=$SSH_DIR/host
CLIENT_KEYS=(id_ed25519 id_ed25519_enc id_rsa_pem id_rsa_pem_enc id_ecdsa)

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

ssh_key() { # dir name passphrase ssh-keygen-options...: generates the pair when missing
  local dir=$1 name=$2 pass=$3
  shift 3
  [[ -f "$dir/$name" && -f "$dir/$name.pub" ]] && return 0
  rm -f "$TMP/$name" "$TMP/$name.pub"
  ssh-keygen -q "$@" -N "$pass" -C "tablemax-test-$name" -f "$TMP/$name"
  install -d -m 0700 "$dir"
  install -m 0600 "$TMP/$name" "$dir/$name"
  install -m 0644 "$TMP/$name.pub" "$dir/$name.pub"
  echo "test SSH key written to $dir/$name"
}

ssh_material() {
  local k
  ssh_key "$SSH_DIR" id_ed25519 '' -t ed25519
  ssh_key "$SSH_DIR" id_ed25519_enc key-pass -t ed25519
  ssh_key "$SSH_DIR" id_rsa_pem '' -t rsa -b 2048 -m PEM
  ssh_key "$SSH_DIR" id_rsa_pem_enc key-pass -t rsa -b 2048 -m PEM
  ssh_key "$SSH_DIR" id_ecdsa '' -t ecdsa -b 256
  ssh_key "$HOST_DIR" ssh_host_ed25519_key '' -t ed25519
  ssh_key "$HOST_DIR" ssh_host_ecdsa_key '' -t ecdsa -b 256
  for k in "${CLIENT_KEYS[@]}"; do cat "$SSH_DIR/$k.pub"; done > "$TMP/authorized_keys"
  install -m 0644 "$TMP/authorized_keys" "$SSH_DIR/authorized_keys"
}

complete "$TLS_DIR" "${TLS_FILES[@]}" || tls_material
ssh_material
