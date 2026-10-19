#!/usr/bin/env bash
# Manage the test databases and the test sshd. Usage: test-dbs.sh up|down|env
# To add a DB version: one service in docker-compose.test.yml + one URL below.
#
# Overridable (e.g. to run two worktrees side by side; use the same values for every
# command, `env` included):
#   TABLEMAX_TEST_PROJECT       compose project name     (default tablemax-test)
#   TABLEMAX_TEST_PG_PORT       PostgreSQL 16 host port  (default 54321)
#   TABLEMAX_TEST_MYSQL_PORT    MySQL 8.4 host port      (default 33061)
#   TABLEMAX_TEST_MARIADB_PORT  MariaDB 11.4 host port   (default 33062)
#   TABLEMAX_TEST_SSH_PORT      test sshd host port      (default 2222)
set -euo pipefail

cd "$(dirname "$0")/.."
export TABLEMAX_TEST_PG_PORT="${TABLEMAX_TEST_PG_PORT:-54321}"
export TABLEMAX_TEST_MYSQL_PORT="${TABLEMAX_TEST_MYSQL_PORT:-33061}"
export TABLEMAX_TEST_MARIADB_PORT="${TABLEMAX_TEST_MARIADB_PORT:-33062}"
export TABLEMAX_TEST_SSH_PORT="${TABLEMAX_TEST_SSH_PORT:-2222}"
COMPOSE=(docker compose -p "${TABLEMAX_TEST_PROJECT:-tablemax-test}" -f docker-compose.test.yml)

PG_URLS="postgres://postgres:tablemax@127.0.0.1:${TABLEMAX_TEST_PG_PORT}/tablemax_test"
MYSQL_URLS="mysql://root:tablemax@127.0.0.1:${TABLEMAX_TEST_MYSQL_PORT}/tablemax_test,mysql://root:tablemax@127.0.0.1:${TABLEMAX_TEST_MARIADB_PORT}/tablemax_test"

case "${1:-}" in
  up)
    bash scripts/test-secrets.sh
    "${COMPOSE[@]}" up -d --wait --build
    # Client-certificate login role (see tests/docker/pg-ssl.sh); idempotent.
    "${COMPOSE[@]}" exec -T pg16 psql -q -U postgres -d postgres -c \
      "DO \$\$ BEGIN CREATE ROLE certuser LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$"
    # Client keys added since the sshd started (it only copies them at start).
    "${COMPOSE[@]}" exec -T sshd \
      install -o tunnel -g tunnel -m 0600 /keys/authorized_keys /home/tunnel/.ssh/authorized_keys
    ;;
  down)
    "${COMPOSE[@]}" down -v
    ;;
  env)
    echo "export TABLEMAX_TEST_PG_URLS=${PG_URLS}"
    echo "export TABLEMAX_TEST_MYSQL_URLS=${MYSQL_URLS}"
    echo "export TABLEMAX_TEST_TLS_DIR=$(pwd)/.test-secrets/tls"
    echo "export TABLEMAX_TEST_SSH=127.0.0.1:${TABLEMAX_TEST_SSH_PORT}"
    echo "export TABLEMAX_TEST_SSH_DIR=$(pwd)/.test-secrets/ssh"
    # MongoDB is experimental until it ships (flags.rs); removed with the flag.
    echo "export TABLEMAX_EXPERIMENTAL=mongodb"
    ;;
  *)
    echo "usage: $0 up|down|env" >&2
    exit 2
    ;;
esac
