# TablePlus `.tableplusconnection` fixtures

**Real exports**, produced by TablePlus Linux 1.8.4 (build 316, package `tableplus 0.1.316`)
on 2026-10-17 through its own GUI ("Export connection..." context menu), from fake
connections seeded for the occasion. They are not synthetic: the bytes are exactly what
TablePlus wrote.

- **Export password (all files): `fixture-pass`**
- Format: RNCryptor v3, password-based (header `03 01`). See
  `docs/research/2026-10-17-tableplusconnection-format.md` for the full format and the
  decrypted plaintext of each file.
- Every credential is fake: DB password `demo-pass`, SSH password `ssh-demo-pass`,
  SSH key passphrase `key-demo-pass`, host `127.0.0.1`, SSH host `bastion.example.test`
  (reserved `.test` TLD), user `demo` / `sshdemo`, paths under `/home/demo/`.

| File | GUI action | "Includes database and server passwords" | Contents (plaintext = JSON array) |
|---|---|---|---|
| `all-with-passwords.tableplusconnection` | Export connection… → Export all… | checked | 1 root group "Fixture Group" (containing "Nested Group") + 7 root connections: `fixture-mysql` (MySQL), `fixture-mariadb` (MariaDB, port 3307), `fixture-postgres` (PostgreSQL, 1 pinned favorite), `fixture-sqlite` (SQLite), `fixture-ssh-password` (PG over SSH, password auth), `fixture-ssh-key` (MySQL over SSH, key auth with passphrase), `fixture-ssl` (PG, SSL mode + cert paths in TablePlus; **not exported**) |
| `all-without-passwords.tableplusconnection` | Export all… | unchecked | Same tree; the three `*Password` keys are **absent** |
| `group.tableplusconnection` | (on the group) Export this group… | checked | "Fixture Group" → `fixture-grouped-mysql` + subgroup "Nested Group" → `fixture-nested-sqlite` |
| `single-ssh-key.tableplusconnection` | Export this connection… | checked | `fixture-ssh-key` only (`DatabaseKeyPassword` = `key-demo-pass`) |
| `single-grouped.tableplusconnection` | Export this connection… (connection inside a group) | checked | `fixture-grouped-mysql` only; no `GroupID` key (single exports never carry it) |

What TablePlus Linux does **not** export (although set on the source connections):
SSH private key path, SSL mode / key / cert / CA paths, color, tag (environment),
connection id, group id of the group itself. An importer must not expect them.

Decrypt for inspection (Python + `cryptography`):

```
PBKDF2-HMAC-SHA1(password, salt, 10000 iterations, 32 bytes) for both keys
file = 03 | 01 | encSalt[8] | hmacSalt[8] | iv[16] | AES-256-CBC/PKCS7 ciphertext | HMAC-SHA256[32]
HMAC covers everything before the last 32 bytes.
```
