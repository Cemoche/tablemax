#!/bin/sh
# Entrypoint wrapper for the PostgreSQL test container.
# - PostgreSQL refuses a server key that is not owned by its user with mode 0600, so the
#   mounted (world-readable) test certificates are copied into place with the right
#   owner/mode before handing over to the image's entrypoint.
# - pg_hba.conf lives outside PGDATA (hba_file) and is rewritten at every start, so it
#   also applies to a data volume created before TLS was enabled. Role `certuser` (created
#   by scripts/test-dbs.sh up) authenticates with a client certificate only; that rule
#   comes first so it wins over the password rules, which mirror the image defaults.
set -eu
TLS=/var/lib/postgresql/tls
install -d -o postgres -g postgres -m 0700 "$TLS"
install -o postgres -g postgres -m 0600 /tls/server.key "$TLS/server.key"
install -o postgres -g postgres -m 0644 /tls/server.pem "$TLS/server.pem"
install -o postgres -g postgres -m 0644 /tls/ca.pem "$TLS/ca.pem"
cat > "$TLS/pg_hba.conf" <<'HBA'
hostssl all         certuser 0.0.0.0/0    cert
local   all         all                   trust
host    all         all      127.0.0.1/32 trust
host    all         all      ::1/128      trust
local   replication all                   trust
host    all         all      all          scram-sha-256
HBA
chown postgres:postgres "$TLS/pg_hba.conf"
chmod 0600 "$TLS/pg_hba.conf"
exec docker-entrypoint.sh "$@"
