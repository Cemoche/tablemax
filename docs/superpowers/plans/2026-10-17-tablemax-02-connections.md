# TableMax — Plan 2 : Connexions avancées — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Se connecter à des bases distantes en sécurité (SSL/TLS, tunnel SSH avec alias `~/.ssh/config` et vérification `known_hosts`), organiser les connexions en groupes, les échanger par URL, et importer les exports `.tableplusconnection`.

**Architecture:** Le backend gagne un module `driver/tls.rs` (configs rustls à partir d'un `SslConfig`), un module `ssh/` (parser `~/.ssh/config`, verdicts `known_hosts`, tunnel `russh` avec forward local `127.0.0.1:<port>`), et un module `import/` (déchiffrement RNCryptor v3 et lecture des exports TablePlus). Le `SessionManager` ouvre **un tunnel par workspace**, partagé par la connexion de navigation, les onglets SQL et les annulations ; les drivers se connectent à l'extrémité locale du tunnel tout en vérifiant le certificat TLS au nom du vrai hôte. Le frontend étend le formulaire (sections SSL et SSH, choix de fichiers par un sélecteur natif ouvert côté Rust) et ajoute groupes, URL et import.

**Tech Stack:** existant (Tauri 2.12, Rust 1.96 edition 2024, React 19, Zustand 5, Tailwind 4) + `rustls 0.23` (provider **ring**), `tokio-postgres-rustls 0.14` (feature `ring`), `rustls-native-certs 0.8`, `webpki-roots 1`, `mysql_async 0.37.1` (features `minimal-rust`, `rustls-tls`, `ring`, `tls12`), `russh 0.64` (`default-features = false`, features `ring`, `rsa`, `flate2`), `aes 0.9`, `cbc 0.2` (`alloc`), `hmac 0.13`, `sha1 0.11`, `sha2 0.11`, `pbkdf2 0.13` (`hmac`), `tauri-plugin-dialog 2.8` (Rust uniquement).

**Spec:** `docs/superpowers/specs/2026-10-16-tablemax-design.md` (§2 Connexions, §6, §6 bis) · Recherches : `docs/research/2026-10-17-tableplusconnection-format.md`, notes de crates résumées dans « Décisions techniques » ci-dessous · Suivi du plan 1 : `docs/notes/plan-01-followups.md`.

## Global Constraints

- Tout le plan 1 reste valable (stack, chaînes dans `src/lib/strings.ts`, tokens CSS uniquement, I/O asynchrone et annulable, commits `<emoji> <type>(<scope>): <description>`).
- Secrets (mot de passe DB, mot de passe SSH, passphrase de clé) **uniquement dans le trousseau** (service `dev.tablemax.app`, username `{id}:db_password|ssh_password|ssh_passphrase`) ; jamais sur disque, dans les logs, dans un `Debug`, ni renvoyés au frontend — y compris dans l'aperçu d'import.
- **Aucune dépendance native ajoutée** au-delà d'un compilateur C : jamais `aws-lc-rs`/`aws-lc-sys`, cmake ou OpenSSL (`cargo tree -i aws-lc-sys` doit être vide). Provider rustls = `ring`, installé une fois au démarrage (`rustls::crypto::ring::default_provider().install_default()`), et toute `ClientConfig` construite avec `builder_with_provider(ring)`.
- Clé d'hôte SSH : vérifiée contre `~/.ssh/known_hosts` puis `<app_data_dir>/known_hosts`. Hôte inconnu → l'utilisateur confirme l'empreinte (`SHA256:…`, format `ssh-keygen -lf`) puis elle est ajoutée au `known_hosts` de l'app. **Clé différente = connexion bloquée**, rien n'est écrit.
- Pas de ProxyJump ni bastion. Alias `~/.ssh/config` : `HostName`, `User`, `Port`, `IdentityFile` lus depuis la config ; ce qui est saisi dans le formulaire prime.
- Les chemins de fichiers (CA, cert, clé, clé SSH, fichier d'import) sont choisis par un sélecteur natif ouvert **côté Rust** ; aucune permission `dialog:*` ni `fs:*` n'est ajoutée aux capabilities (qui restent `core:default`).
- Aucun code, nom de produit visible, icône ni asset de TablePlus ; le format `.tableplusconnection` n'est que **lu**. Dans l'UI, le libellé est « Import TablePlus export… » (nom de format, nécessaire pour que l'utilisateur s'y retrouve).
- Versions testées : MySQL 8, MariaDB 11, PostgreSQL 16, plus un `sshd` de test ; tout tourne sur `127.0.0.1` uniquement.

## Décisions techniques (issues des recherches, à ne pas rediscuter)

| Sujet | Décision |
|---|---|
| Modes SSL | `SslMode { Disable, Prefer, Require, VerifyCa, VerifyFull }`, défaut `Prefer` (comme libpq). `Prefer`/`Require` chiffrent sans vérifier ; `VerifyCa` vérifie la chaîne, pas le nom ; `VerifyFull` vérifie chaîne + nom. |
| PG + TLS | `tokio-postgres-rustls::MakeRustlsConnect`. `Prefer`→`SslMode::Prefer`, autres modes chiffrés → `SslMode::Require` avec le vérificateur adéquat : `NoVerify` (accepte tout certificat mais vérifie les signatures de handshake via `rustls::crypto::verify_tls12_signature`/`verify_tls13_signature`), `VerifyCaOnly` (enveloppe `WebPkiServerVerifier` et ne transforme en succès que `CertificateError::NotValidForName`/`NotValidForNameContext`), ou `with_root_certificates` (VerifyFull). |
| Racines | CA fourni → uniquement ce CA. Sinon `rustls_native_certs::load_native_certs()`, et `webpki_roots::TLS_SERVER_ROOTS` si vide. Parsing PEM via `rustls::pki_types::pem::PemObject` (pas `rustls-pemfile`). |
| MySQL + TLS | `SslOpts` : CA → `with_root_certs` + `with_disable_built_in_roots(true)` ; cert client → `with_client_identity(ClientIdentity::new(cert, key))` ; `Require` → `with_danger_accept_invalid_certs(true)` ; nom TLS via `with_danger_tls_hostname_override`. `Prefer` = essai TLS puis nouvel essai sans TLS **uniquement** sur `DriverError::NoClientSslFlagFromServer`. |
| MySQL `VerifyCa` | **Non proposé** pour MySQL/MariaDB en v1 (bug mysql_async 0.37.1, upstream #404 corrigé par PR #408 non publiée). Backend : `Invalid "verify-ca is not supported for MySQL yet; use verify-full or require"`. UI : option absente pour ces drivers. |
| Tunnel + TLS | PG : `Config::host(<vrai hôte>)` + `hostaddr(127.0.0.1)` + `port(<port local>)`. MySQL : `ip_or_hostname("127.0.0.1")`, `tcp_port(<port local>)` et `with_danger_tls_hostname_override(<vrai hôte>)`. |
| SSH | `russh 0.64` : `client::connect`, `Handler::check_server_key` (async fn native), `keys::load_secret_key(path, passphrase)` (`keys::Error::KeyIsEncrypted` → passphrase requise), `keys::agent::client::AgentClient::connect_env()`, `keys::check_known_hosts_path`, `keys::known_hosts::learn_known_hosts_path`, `key.fingerprint(HashAlg::Sha256)`. Forward : `TcpListener` sur `127.0.0.1:0`, par connexion `channel_open_direct_tcpip` + `into_stream()` + `tokio::io::copy_bidirectional`. |
| `~/.ssh/config` | Parser maison (~150 lignes) ; `russh-config` et `ssh2-config` sont buggés sur les cas courants. |
| RNCryptor v3 | Implémentation maison avec les crates RustCrypto ci-dessus ; PBKDF2-HMAC-SHA1 10 000 itérations, clés de 32 octets, AES-256-CBC PKCS7, HMAC-SHA256 vérifié avant déchiffrement (`Mac::verify_slice`, temps constant). |
| Sélecteur de fichiers | `tauri_plugin_dialog::DialogExt` côté Rust (`app.dialog().file().add_filter(..).blocking_pick_file()` dans `spawn_blocking`), plugin enregistré mais **aucune** permission JS. |

## Review Focus

1. **Tunnel SSH coupé en cours de session** (réseau, `sshd` redémarré) : les requêtes échouent en `ConnectionLost`, puis rouvrir un onglet SQL ou recharger rétablit un nouveau tunnel sans rouvrir le workspace → test `reopens_tunnel_after_it_dies` (Task 4).
2. **Clé d'hôte modifiée** (serveur réinstallé ou attaque) : connexion bloquée avec `HostKeyChanged`, le `known_hosts` de l'app n'est pas modifié, aucun secret n'est envoyé → tests `changed_host_key_blocks` (Task 2) et `tunnel_refuses_changed_host_key` (Task 3).
3. **Clé privée chiffrée sans passphrase enregistrée** : demande de passphrase (`Auth "ssh passphrase required"`), pas une erreur générique ; une mauvaise passphrase redemande → test `encrypted_key_without_passphrase_requires_it` (Task 3) + test UI (Task 5).
4. **Vérification TLS à travers le tunnel** : `VerifyFull` valide le certificat au nom du vrai hôte (`pg16`), pas `127.0.0.1` → test `verify_full_through_tunnel_uses_real_host_name` (Task 3).
5. **Export TablePlus avec mauvais mot de passe, fichier corrompu ou driver inconnu** : erreur claire (`Invalid "wrong password or corrupted file"`), rien n'est importé ; un driver hors v1 est ignoré avec un avertissement sans faire échouer les autres → tests `wrong_password_is_rejected`, `unsupported_driver_is_skipped_with_warning` (Task 7).

---

### Task 1: TLS pour PostgreSQL et MySQL/MariaDB

**Files:**
- Create: `src-tauri/src/driver/tls.rs`, `scripts/test-certs.sh`, `tests/docker/pg-ssl.sh` (ou équivalent : script d'entrée qui copie les certificats avec les bons droits)
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/driver/mod.rs`, `src-tauri/src/driver/postgres.rs`, `src-tauri/src/driver/mysql.rs`, `src-tauri/src/lib.rs` (install du provider), `src-tauri/src/manager.rs` (`connect_params` passe `ssl` et `dial: None`), `docker-compose.test.yml`, `scripts/test-dbs.sh`, `.gitignore` (`.test-secrets/`)
- Test: `src-tauri/tests/postgres_driver.rs`, `src-tauri/tests/mysql_driver.rs`, tests unitaires dans `tls.rs`

**Interfaces:**
- Produces (`driver/tls.rs`) :
  - `#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)] #[serde(rename_all = "camelCase")] pub enum SslMode { Disable, #[default] Prefer, Require, VerifyCa, VerifyFull }`
  - `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)] #[serde(rename_all = "camelCase")] pub struct SslConfig { pub mode: SslMode, pub ca_file: Option<String>, pub cert_file: Option<String>, pub key_file: Option<String> }`
  - `pub fn rustls_client_config(ssl: &SslConfig) -> AppResult<Option<Arc<rustls::ClientConfig>>>` (`None` pour `Disable`) ; fichiers illisibles ou PEM invalides → `ErrorKind::Invalid` avec le chemin et la nature du fichier (« CA file », « client certificate », « client key »), jamais leur contenu ; `cert_file` sans `key_file` (ou l'inverse) → `Invalid`.
  - `pub fn install_crypto_provider()` (idempotent).
- Produces (`driver/mod.rs`) : `ConnectParams` gagne `pub ssl: SslConfig` et `pub dial: Option<std::net::SocketAddr>` (quand `Some`, la connexion TCP part vers cette adresse ; `host` reste le nom utilisé pour la vérification TLS et l'affichage). `ensure_local_host` reste, mais n'est appelé que si `dial` est `None` **et** que le mode ne vérifie pas le serveur (`Disable`, `Prefer`, `Require`) ; message : `unverified TLS is only allowed for local hosts: use verify-full or verify-ca, or an SSH tunnel` (règle intérimaire jusqu'à la Task 4).
- Test infra : `scripts/test-certs.sh` génère dans `.test-secrets/tls/` (si absent) un CA, un certificat serveur signé (SAN `DNS:localhost, DNS:pg16, DNS:mysql8, DNS:mariadb11` — **sans** `IP:127.0.0.1`, pour tester l'erreur de nom), un second CA « étranger », et un certificat client `CN=certuser` signé par le CA. `test-dbs.sh up` l'appelle avant `docker compose up`. Les trois serveurs activent TLS avec ce certificat ; PG ajoute `hostssl all certuser 0.0.0.0/0 cert` (en tête de `pg_hba.conf`) et crée le rôle `certuser`. `test-dbs.sh env` exporte en plus `TABLEMAX_TEST_TLS_DIR=<chemin absolu de .test-secrets/tls>`.

- [ ] **Step 1: Tests unitaires qui échouent (`tls.rs`)**

```rust
#[test] fn disable_has_no_config() { assert!(rustls_client_config(&SslConfig { mode: SslMode::Disable, ..Default::default() }).unwrap().is_none()); }
#[test] fn missing_ca_file_is_invalid() {
    let e = rustls_client_config(&SslConfig { mode: SslMode::VerifyFull, ca_file: Some("/nope/ca.pem".into()), ..Default::default() }).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Invalid); assert!(e.message.contains("CA file"));
}
#[test] fn cert_without_key_is_invalid() { /* cert_file Some, key_file None → Invalid */ }
#[test] fn ssl_config_serde_default_is_prefer() {
    let c: SslConfig = serde_json::from_str("{}").unwrap(); assert_eq!(c.mode, SslMode::Prefer);
}
```
(`SslConfig` porte `#[serde(default)]` au niveau du struct pour accepter `{}`.)

- [ ] **Step 2: Tests d'intégration qui échouent** (dans les fichiers existants, mêmes helpers d'URL ; le dossier TLS vient de `TABLEMAX_TEST_TLS_DIR`)

PostgreSQL :
- `pg_require_encrypts` : `Require` sans CA → connecté et `select ssl from pg_stat_ssl where pid = pg_backend_pid()` renvoie `true`.
- `pg_verify_full_ok_on_localhost` : host `localhost`, CA du test → OK.
- `pg_verify_full_rejects_wrong_name` : host `127.0.0.1`, CA du test → `ErrorKind::Connection`, message contenant `not valid for name`.
- `pg_verify_ca_ignores_name` : host `127.0.0.1`, `VerifyCa` + CA → OK.
- `pg_verify_ca_rejects_foreign_ca` : `VerifyCa` + CA étranger → `ErrorKind::Connection`.
- `pg_client_cert_auth` : user `certuser`, sans mot de passe, `VerifyFull` + cert/clé client → OK.
- `pg_cancel_over_tls` : `Require`, `select pg_sleep(30)` annulé → `ErrorKind::Cancelled` en < 4 s (le `CancelToken` doit utiliser le même connecteur TLS).

MySQL 8 et MariaDB 11 (chaque URL de `TABLEMAX_TEST_MYSQL_URLS`) :
- `mysql_require_encrypts` : `Require` → `SHOW SESSION STATUS LIKE 'Ssl_cipher'` non vide.
- `mysql_verify_full_ok_on_localhost` / `mysql_verify_full_rejects_wrong_name` (mêmes règles que PG).
- `mysql_verify_ca_is_not_supported` : `VerifyCa` → `ErrorKind::Invalid`.
- `mysql_cancel_over_tls` : `Require`, `select sleep(30)` annulé → `Cancelled` (le canceller ouvre sa connexion `KILL QUERY` avec les mêmes `SslOpts`).

- [ ] **Step 3: Vérifier l'échec**

Run: `pnpm test:rust`
Expected: échecs de compilation (`SslConfig`, champs `ssl`/`dial` absents).

- [ ] **Step 4: Implémenter**

`tls.rs` selon « Décisions techniques ». `postgres.rs` : `Config` avec `host(p.host)`, `hostaddr(dial.ip())`/`port(dial.port())` quand `dial` est `Some`, `ssl_mode` mappé, `connect(MakeRustlsConnect::new(cfg))` ou `NoTls` pour `Disable` ; le canceller garde le connecteur. `mysql.rs` : `OptsBuilder` avec `ssl_opts`, `Prefer` réessaie sans TLS uniquement sur `NoClientSslFlagFromServer` ; `VerifyCa` → `Invalid` avant toute I/O. `lib.rs` appelle `install_crypto_provider()` au démarrage ; les tests d'intégration l'appellent aussi (helper commun).

- [ ] **Step 5: Vérifier**

Run: `pnpm test:rust && pnpm lint && cargo tree --manifest-path src-tauri/Cargo.toml -i aws-lc-sys`
Expected: tout passe ; `cargo tree -i aws-lc-sys` répond qu'aucun paquet ne correspond.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "🔒 security(driver): add TLS modes for PostgreSQL and MySQL/MariaDB"
```

---

### Task 2: `~/.ssh/config` et verdicts `known_hosts`

**Files:**
- Create: `src-tauri/src/ssh/mod.rs`, `src-tauri/src/ssh/config.rs`, `src-tauri/src/ssh/known_hosts.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/error.rs`, `src-tauri/Cargo.toml` (russh)
- Test: tests unitaires dans les deux fichiers

**Interfaces:**
- Produces (`error.rs`) : `ErrorKind` gagne `HostKeyUnknown` et `HostKeyChanged` (serde camelCase : `"hostKeyUnknown"`, `"hostKeyChanged"`). Pour ces deux kinds, `message` = l'empreinte `SHA256:…` présentée par le serveur.
- Produces (`ssh/config.rs`) :
  - `#[derive(Debug, Clone, PartialEq, Default)] pub struct ResolvedHost { pub host_name: String, pub port: u16, pub user: Option<String>, pub identity_files: Vec<PathBuf> }`
  - `pub struct SshConfigFile` ; `impl SshConfigFile { pub fn parse(text: &str, home: &Path) -> Self; pub fn load(path: &Path, home: &Path) -> Self; pub fn resolve(&self, alias: &str) -> ResolvedHost; pub fn aliases(&self) -> Vec<String> }`
  - `pub fn user_config() -> SshConfigFile` (`~/.ssh/config` ; fichier absent ou illisible → config vide, jamais d'erreur).
  - Règles : mots-clés insensibles à la casse, `Key Value` et `Key=Value`, guillemets ; blocs `Host` avec motifs `*`, `?`, négation `!` ; options avant le premier `Host` = globales ; **première valeur gagne**, sauf `IdentityFile` qui s'accumule dans l'ordre ; `~` et `%h` (nom résolu), `%p`, `%r`, `%u`, `%%` développés dans `IdentityFile` ; `HostName` développe `%h` (alias) ; `Include` (chemin relatif à `~/.ssh`, `*` dans le dernier composant, profondeur max 8) ; blocs `Match` **ignorés** jusqu'au prochain `Host`/`Match` ; port par défaut 22 ; `host_name` par défaut = l'alias. `aliases()` = motifs `Host` sans joker ni négation, sans doublon, dans l'ordre du fichier.
- Produces (`ssh/known_hosts.rs`) :
  - `#[derive(Debug, Clone, PartialEq)] pub enum HostKeyVerdict { Known, Unknown { fingerprint: String }, Changed { fingerprint: String } }`
  - `pub struct KnownHosts { pub system: Option<PathBuf>, pub app: PathBuf }` ; `impl KnownHosts { pub fn verify(&self, host: &str, port: u16, key: &russh::keys::PublicKey) -> HostKeyVerdict; pub fn trust(&self, host: &str, port: u16, key: &russh::keys::PublicKey) -> AppResult<()> }`
  - `verify` : `Changed` si l'un des deux fichiers renvoie `KeyChanged` ; sinon `Known` si l'un des deux le connaît ; sinon `Unknown`. Fichier absent = rien de connu. `pub fn fingerprint(key) -> String` (`SHA256:…`).

- [ ] **Step 1: Tests qui échouent**

`config.rs` :
```rust
#[test] fn resolves_alias_with_globals_and_first_wins() {
    let c = SshConfigFile::parse("User global\nHost prod\n  HostName 10.0.0.5\n  Port 2200\n  User deploy\nHost *\n  User fallback\n  IdentityFile ~/.ssh/id_ed25519\n", Path::new("/home/u"));
    assert_eq!(c.resolve("prod"), ResolvedHost { host_name: "10.0.0.5".into(), port: 2200, user: Some("global".into()), identity_files: vec!["/home/u/.ssh/id_ed25519".into()] });
}
#[test] fn identity_files_accumulate_and_expand() { /* deux IdentityFile, %h et %r développés */ }
#[test] fn wildcard_and_negation() { /* Host *.prod !db.prod */ }
#[test] fn match_blocks_are_ignored() { /* "Match user x\n User matched\nHost db-1\n User fallback" → user fallback */ }
#[test] fn equals_syntax_and_quotes() { /* "Port=2222" → 2222 ; IdentityFile "~/k ey" → "/home/u/k ey" */ }
#[test] fn unknown_alias_defaults() { assert_eq!(SshConfigFile::parse("", Path::new("/h")).resolve("x.example").port, 22); }
#[test] fn aliases_skip_patterns() { /* "Host a b *.x !c" → ["a", "b"] */ }
#[test] fn include_relative_to_ssh_dir() { /* tempdir avec .ssh/config.d/work */ }
```
`known_hosts.rs` (clés générées dans le test avec `russh::keys::PrivateKey::random(&mut OsRng, Algorithm::Ed25519)`) :
```rust
#[test] fn unknown_then_trusted_then_known() { /* verify → Unknown{fingerprint commence par "SHA256:"} ; trust ; verify → Known */ }
#[test] fn changed_host_key_blocks() { /* trust k1 ; verify(k2 même algo) → Changed ; le fichier app est inchangé */ }
#[test] fn system_file_is_read_and_never_written() { /* clé connue dans system → Known ; trust n'écrit que dans app */ }
#[test] fn non_default_port_entries() { /* trust(host, 2222) puis verify(host, 22) → Unknown */ }
```

- [ ] **Step 2: Vérifier l'échec** — Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib ssh::` → Expected: échec de compilation.

- [ ] **Step 3: Implémenter** selon les Interfaces.

- [ ] **Step 4: Vérifier** — Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib ssh:: && pnpm lint` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "✨ feat(ssh): resolve ~/.ssh/config aliases and verify host keys"
```

---

### Task 3: Tunnel SSH

**Files:**
- Create: `src-tauri/src/ssh/tunnel.rs`, `tests/docker/sshd/Dockerfile`, `tests/docker/sshd/sshd_config`, `src-tauri/tests/ssh_tunnel.rs`
- Modify: `src-tauri/src/ssh/mod.rs`, `docker-compose.test.yml` (service `sshd`, build local, port `127.0.0.1:2222:22`, même réseau que les bases), `scripts/test-certs.sh` → renommer `scripts/test-secrets.sh` (génère aussi les clés SSH), `scripts/test-dbs.sh`
- Test: `src-tauri/tests/ssh_tunnel.rs`

**Interfaces:**
- Consumes: `KnownHosts`, `HostKeyVerdict`, `fingerprint` (Task 2) ; `ConnectParams.dial`, `SslConfig` (Task 1).
- Produces (`ssh/tunnel.rs`) :
  - `pub enum SshAuthMaterial { Password(String), Key { path: PathBuf, passphrase: Option<String> }, Agent }` (Debug manuel qui masque mot de passe et passphrase)
  - `pub struct SshTarget { pub host: String, pub port: u16, pub user: String, pub auth: SshAuthMaterial }` (`host` = nom résolu, utilisé pour `known_hosts`)
  - `pub struct HostKeyPolicy { pub known_hosts: KnownHosts, pub accept_fingerprint: Option<String> }` — si le verdict est `Unknown` et que `accept_fingerprint` est égal à l'empreinte présentée, la clé est `trust`ée puis acceptée ; `Unknown` sinon → `HostKeyUnknown` ; `Changed` → `HostKeyChanged` (toujours, même avec `accept_fingerprint`).
  - `pub struct SshTunnel` ; `pub async fn open_tunnel(target: &SshTarget, remote_host: &str, remote_port: u16, policy: &HostKeyPolicy) -> AppResult<Arc<SshTunnel>>` ; `impl SshTunnel { pub fn local_addr(&self) -> SocketAddr; pub fn is_alive(&self) -> bool; pub async fn close(&self) }` ; `Drop` arrête l'écoute et la session.
  - Erreurs : échec TCP/handshake → `Connection` ; authentification refusée → `Auth "ssh authentication failed"` ; clé chiffrée sans passphrase ou passphrase fausse → `Auth "ssh passphrase required"` ; mode mot de passe sans mot de passe → `Auth "ssh password required"` (ces deux messages exacts sont le contrat avec le frontend) ; agent absent (`SSH_AUTH_SOCK` vide) → `Auth "ssh agent not available"`. Le forward vers une cible injoignable fait échouer la connexion DB (le socket local est fermé), pas le tunnel.
- Test infra : image `sshd` (alpine + openssh) : utilisateur `tunnel`, mot de passe `tunnel-pass` (`PasswordAuthentication yes`, sans PAM : `chpasswd`), `authorized_keys` = clés publiques générées par `scripts/test-secrets.sh` dans `.test-secrets/ssh/` (`id_ed25519` sans passphrase, `id_ed25519_enc` passphrase `key-pass`, `id_rsa_pem` au format PEM), `AllowTcpForwarding yes`, clés d'hôte générées au build. `test-dbs.sh env` exporte `TABLEMAX_TEST_SSH=127.0.0.1:2222` et `TABLEMAX_TEST_SSH_DIR=<.test-secrets/ssh absolu>`. Depuis `sshd`, les bases sont `pg16:5432`, `mysql8:3306`, `mariadb11:3306`.

- [ ] **Step 1: Tests d'intégration qui échouent** (`ssh_tunnel.rs` ; chaque test utilise un `known_hosts` d'app dans un tempdir et `system: None`)

```rust
#[tokio::test] async fn unknown_host_key_requires_confirmation() {
    // open_tunnel sans accept_fingerprint → Err kind HostKeyUnknown, message commence par "SHA256:"
    // puis avec accept_fingerprint = ce message → Ok ; le fichier known_hosts de l'app contient "[127.0.0.1]:2222"
}
#[tokio::test] async fn tunnel_refuses_changed_host_key() { /* known_hosts d'app pré-rempli avec une autre clé ed25519 pour [127.0.0.1]:2222 → HostKeyChanged, fichier inchangé */ }
#[tokio::test] async fn password_auth_reaches_postgres() { /* tunnel vers pg16:5432 ; connect PG avec dial = local_addr, host "pg16", Disable → select 1 */ }
#[tokio::test] async fn key_auth_reaches_mysql_and_mariadb() { /* id_ed25519 ; mysql8:3306 et mariadb11:3306 */ }
#[tokio::test] async fn pem_rsa_key_auth() { /* id_rsa_pem */ }
#[tokio::test] async fn encrypted_key_without_passphrase_requires_it() { /* id_ed25519_enc sans passphrase → Auth "ssh passphrase required" ; avec "wrong" → même erreur ; avec "key-pass" → Ok */ }
#[tokio::test] async fn wrong_password_fails_auth() { /* → Auth "ssh authentication failed" */ }
#[tokio::test] async fn verify_full_through_tunnel_uses_real_host_name() { /* PG VerifyFull + CA de test, host "pg16", dial local → Ok ; host "127.0.0.1" → erreur de nom */ }
#[tokio::test] async fn cancel_through_tunnel() { /* PG puis MySQL : sleep(30) annulé via le tunnel → Cancelled < 4 s */ }
#[tokio::test] async fn several_connections_share_one_tunnel() { /* 3 sessions PG simultanées sur le même tunnel */ }
#[tokio::test] async fn closed_tunnel_reports_dead() { /* close() → is_alive() == false ; nouvelle connexion DB → Err Connection */ }
```

- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test:rust` → Expected: échec de compilation (`open_tunnel` absent).

- [ ] **Step 3: Implémenter** `open_tunnel` selon les Interfaces et « Décisions techniques ». Le `Handler` mémorise le verdict pour produire l'erreur `HostKeyUnknown`/`HostKeyChanged` (au lieu de l'erreur générique de russh). Authentification par agent : essayer chaque identité de l'agent dans l'ordre.

- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm lint` → Expected: PASS (les tests des plans précédents aussi).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "✨ feat(ssh): open SSH tunnels with password, key and agent auth"
```

---

### Task 4: SSL/SSH dans les connexions enregistrées et le SessionManager

**Files:**
- Modify: `src-tauri/src/store.rs`, `src-tauri/src/manager.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs` (plugin dialog, chemin du `known_hosts` d'app, nouvelles commandes), `src-tauri/Cargo.toml` (`tauri-plugin-dialog`)
- Test: tests unitaires de `store.rs`/`manager.rs`, `src-tauri/tests/manager_ssh.rs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (`store.rs`) :
  - `#[serde(rename_all = "camelCase")] pub enum SshAuth { Password, Key, Agent }`
  - `#[serde(rename_all = "camelCase")] pub struct SshSettings { pub host: String /* alias ~/.ssh/config ou nom d'hôte */, pub port: Option<u16>, pub user: Option<String>, pub auth: SshAuth, pub key_file: Option<String>, pub secret_mode: PasswordMode }` — `secret_mode` porte sur le mot de passe SSH (`Password`) ou la passphrase (`Key`) ; forcé à `None` pour `Agent`.
  - `ConnectionConfig` gagne `#[serde(default)] pub ssl: SslConfig` et `#[serde(default)] pub ssh: Option<SshSettings>` (les configs du plan 1 se relisent sans migration).
  - `same_identity` compare aussi `ssh` (host, port, user, auth, key_file) : tout changement de cible SSH exige de ressaisir les secrets.
  - `save_connection(store, secrets, cfg, password, ssh_secret: Option<String>)` : même règle que le mot de passe DB pour la clé `SshPassword` (auth `Password`) ou `SshPassphrase` (auth `Key`) ; la clé de l'autre type est supprimée ; sans SSH, les deux sont supprimées.
- Produces (`manager.rs`) :
  - `SessionManager::new(store, secrets, known_hosts: KnownHosts)`.
  - `test_connection(cfg, password, ssh_secret, accept_fingerprint: Option<String>)`, `open_workspace(connection_id, password, ssh_secret, accept_fingerprint: Option<String>)` ; `save_connection(cfg, password, ssh_secret)`.
  - Résolution SSH : `user_config().resolve(ssh.host)` puis champs du formulaire prioritaires ; `user` absent partout → `Invalid "ssh user required"` ; clé : `key_file` sinon le premier `IdentityFile` existant, sinon le premier fichier existant parmi `~/.ssh/id_ed25519`, `~/.ssh/id_ecdsa`, `~/.ssh/id_rsa` (comme OpenSSH), sinon `Invalid "ssh key file required"`.
  - Le workspace garde `Option<Arc<SshTunnel>>` et les secrets SSH saisis (mode `Ask`, comme `held_password`) ; la connexion de navigation, chaque onglet SQL et les annulations passent par ce tunnel (`ConnectParams.dial = Some(tunnel.local_addr())`, `host` = hôte DB de la config). `open_sql_session` rouvre le tunnel s'il est mort (`!is_alive()`), avec les secrets tenus ou le trousseau ; `close_workspace` ferme le tunnel après les sessions.
  - Pas de tunnel pour SQLite (`ssh` ignoré et forcé à `None` à l'enregistrement).
  - `ensure_local_host` est supprimé (fonction, appels et test) : le mode SSL devient un choix explicite de l'utilisateur, protégé par les défauts ci-dessous et l'avertissement du formulaire.
- Produces (`driver/tls.rs`) : `pub fn default_ssl_mode(host: &str, over_ssh: bool) -> SslMode` = `VerifyFull` si l'hôte n'est pas local (loopback, `localhost`, chemin de socket) et qu'il n'y a pas de tunnel, sinon `Prefer`. Utilisé par l'import TablePlus (Task 7) ; le frontend applique la même règle (Task 5/6).
- Produces (`commands.rs`) — contrat frontend :
  - `connection_save(config, password, sshSecret)`, `connection_test(config, password, sshSecret, acceptFingerprint)`, `workspace_open(connectionId, password, sshSecret, acceptFingerprint)` (paramètres ajoutés, tous optionnels/null).
  - `ssh_hosts_list() -> Vec<String>` (alias de `~/.ssh/config`).
  - `file_pick(purpose: FilePurpose) -> Option<String>` avec `#[serde(rename_all = "camelCase")] enum FilePurpose { CaCert, ClientCert, ClientKey, SshKey, TableplusExport }` : sélecteur natif ouvert côté Rust (filtres : `pem/crt/cer` ; `pem/crt/cer` ; `pem/key` ; aucun filtre, dossier initial `~/.ssh` ; `tableplusconnection`) ; annulation → `None`.

- [ ] **Step 1: Tests qui échouent**

`store.rs` :
- `plan1_config_json_still_parses` : le JSON d'une config du plan 1 (sans `ssl`/`ssh`) se lit avec `ssl.mode == Prefer` et `ssh == None`.
- `ssh_secret_follows_auth_kind` : auth `Password` + secret → `ssh_password` en trousseau ; passage en `Key` avec un nouveau secret → `ssh_passphrase` enregistré et `ssh_password` supprimé.
- `changing_ssh_host_requires_secrets` : config enregistrée en `Keyring`, `ssh.host` modifié, sans secret → `Auth "password required"`, rien n'est modifié.
- `config_json_has_no_secret` : après `save_connection` avec mot de passe et secret SSH, le `config_json` stocké ne contient aucune des deux valeurs.

`manager_ssh.rs` (sshd + bases de test ; `known_hosts` d'app en tempdir ; `MemorySecretStore`) :
- `open_workspace_over_ssh_asks_for_unknown_host_key` : premier `open_workspace` → `HostKeyUnknown` ; second avec `acceptFingerprint` → OK, `list_schemas` répond.
- `sql_sessions_and_cancel_use_the_tunnel` : `open_sql_session` puis `select pg_sleep(30)` annulé → `Cancelled`.
- `ask_mode_ssh_secret_is_held_for_sql_sessions` : `secret_mode: Ask`, secret fourni à `open_workspace` → `open_sql_session` réussit sans redemander.
- `reopens_tunnel_after_it_dies` : fermer le tunnel du workspace (accesseur `#[cfg(test)]`), la navigation échoue en `ConnectionLost` ou `Connection`, puis `open_sql_session` réussit (nouveau tunnel).
- `ssh_user_from_config_alias` : `SshSettings.user = None` et un faux `~/.ssh/config` (la résolution passe par une fonction injectable en test, ex. `with_ssh_config(SshConfigFile)`) → l'utilisateur de l'alias est utilisé.

- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test:rust` → Expected: échec de compilation.

- [ ] **Step 3: Implémenter** selon les Interfaces. Le chemin du `known_hosts` d'app = `<app_data_dir>/known_hosts` ; `system` = `~/.ssh/known_hosts` s'il existe.

- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm lint` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "✨ feat(manager): connect saved connections through SSL and SSH tunnels"
```

---

### Task 5: Formulaire SSL/SSH et confirmations (frontend)

**Files:**
- Create: `src/features/connections/SslSection.tsx`, `src/features/connections/SshSection.tsx`, `src/features/connections/HostKeyPrompt.tsx`, `src/features/connections/SecretPrompt.tsx` (remplace `PasswordPrompt.tsx`, supprimé), `src/features/connections/useConnectFlow.ts`, tests associés
- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/errors.ts`, `src/lib/strings.ts`, `src/lib/types.shape.test.ts`, `src/features/connections/ConnectionForm.tsx`, `src/stores/workspaces.ts`, `src/App.tsx`

**Interfaces:**
- Consumes: commandes de la Task 4.
- Produces (`types.ts`) : `SslMode = "disable" | "prefer" | "require" | "verifyCa" | "verifyFull"`, `SslConfig { mode; caFile: string | null; certFile: string | null; keyFile: string | null }`, `SshAuth = "password" | "key" | "agent"`, `SshSettings { host; port: number | null; user: string | null; auth; keyFile: string | null; secretMode: PasswordMode }`, `ConnectionConfig` + `ssl: SslConfig` + `ssh: SshSettings | null`, `ErrorKind` + `"hostKeyUnknown" | "hostKeyChanged"`, `FilePurpose`.
- Produces (`errors.ts`) : `isPasswordRequired` (inchangé), `isSshPasswordRequired(e)` (`auth` + `"ssh password required"`), `isSshPassphraseRequired(e)` (`auth` + `"ssh passphrase required"`), `isHostKeyUnknown(e)`, `isHostKeyChanged(e)`.
- Produces (`ipc.ts`) : signatures étendues `connectionSave(config, password, sshSecret)`, `connectionTest(config, password, sshSecret, acceptFingerprint)`, `workspaceOpen(connectionId, password, sshSecret, acceptFingerprint)`, `sshHostsList()`, `filePick(purpose)`.
- Produces (`useConnectFlow.ts`) : `useConnectFlow(run: (secrets: FlowSecrets) => Promise<T>)` → `{ start(initial: FlowSecrets): Promise<T | undefined>; prompt: FlowPrompt | null }` avec `FlowSecrets { password: string | null; sshSecret: string | null; acceptFingerprint: string | null }` et `FlowPrompt = { kind: "password" | "sshPassword" | "sshPassphrase"; error: string | null } | { kind: "hostKey"; fingerprint: string; host: string }`. Sur chaque erreur reconnue, le flux affiche l'invite correspondante, garde les secrets déjà saisis et relance `run` ; `hostKeyChanged` termine en erreur avec le texte `strings.ssh.hostKeyChanged` (qui explique que la clé a changé, affiche l'empreinte reçue et dit de vérifier avec l'administrateur avant de modifier `known_hosts`). Utilisé par `App.tsx` (ouverture) et par le bouton Test du formulaire.
- UI :
  - Défaut du mode SSL pour une **nouvelle** connexion (et pour une URL sans `sslmode`) : `verifyFull` si l'hôte n'est pas local et sans SSH, sinon `prefer` — `defaultSslMode(host, overSsh)` dans `src/lib/ssl.ts`, mêmes règles que `default_ssl_mode` côté Rust ; le mode suit l'hôte et la case SSH tant que l'utilisateur n'a pas touché au select.
  - Section **SSL** (masquée pour SQLite) : select des modes (sans `verifyCa` pour MySQL/MariaDB), champs CA / certificat / clé en lecture seule + bouton « Browse… » (`filePick`) + bouton d'effacement. Si l'hôte n'est pas local, qu'il n'y a pas de SSH et que le mode est `disable`/`prefer`, une ligne d'avertissement `strings.ssl.cleartextWarning`.
  - Section **SSH tunnel** (case à cocher, masquée pour SQLite) : hôte avec `<datalist>` des alias (`sshHostsList`), port et utilisateur optionnels (placeholder « from ~/.ssh/config » quand l'hôte est un alias connu), auth (Password / Private key / SSH agent), fichier de clé + « Browse… » (`filePick("sshKey")`), secret (mot de passe ou passphrase) + stockage (Keyring / Ask / None).
  - `HostKeyPrompt` : hôte, empreinte en police monospace, texte `strings.ssh.unknownHostExplain`, boutons « Trust and connect » / « Cancel ». Échap = Cancel.
  - `SecretPrompt` : variantes mot de passe DB / mot de passe SSH / passphrase (libellé et titre différents), Échap = Cancel, focus sur le champ.

- [ ] **Step 1: Tests qui échouent** (Vitest + Testing Library, `ipc` mocké comme dans les tests existants)

- `types.shape.test.ts` : une config avec `ssl` et `ssh` complète passe le test de forme existant.
- `useConnectFlow.test.ts` : `run` rejette `ssh passphrase required` → `prompt.kind === "sshPassphrase"` ; après saisie, `run` est rappelé avec `sshSecret` saisi et le `password` précédent conservé ; `hostKeyUnknown` → prompt `hostKey` avec l'empreinte ; « Trust » relance avec `acceptFingerprint` ; `hostKeyChanged` → rejet final avec `strings.ssh.hostKeyChanged`, sans invite.
- `ConnectionForm.test.tsx` : pour `mySql`, l'option `verifyCa` est absente ; pour `postgres`, présente ; cocher « SSH tunnel » affiche les champs ; « Browse… » appelle `filePick("caCert")` et affiche le chemin renvoyé ; SQLite masque SSL et SSH ; l'avertissement texte clair apparaît pour `db.example.com` + `prefer` sans SSH et disparaît avec SSH.
- `HostKeyPrompt.test.tsx` : affiche l'empreinte ; Échap appelle `onCancel`.

- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.

- [ ] **Step 3: Implémenter** ; `ConnectionForm.tsx` délègue aux sections pour rester sous ~300 lignes.

- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.

- [ ] **Step 5: Vérification manuelle** — `pnpm demo:db` puis `pnpm tauri dev` : créer une connexion « Demo · PG via SSH » (SSH `127.0.0.1:2222`, user `tunnel`, mot de passe `tunnel-pass`, base `pg16:5432`) → invite d'empreinte, confirmation, ouverture ; recommencer → plus d'invite. Consigner dans `docs/notes/plan-02-manual-check.md`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "✨ feat(connections): SSL and SSH tunnel settings with host key confirmation"
```

---

### Task 6: Groupes et import/export par URL

**Files:**
- Create: `src/lib/connectionUrl.ts`, `src/lib/connectionUrl.test.ts`, `src/features/connections/UrlImportDialog.tsx`, `src/features/connections/ConnectionList.test.tsx`
- Modify: `src/features/connections/ConnectionList.tsx`, `src/features/connections/ConnectionForm.tsx` (champ groupe avec `<datalist>` des groupes existants, bouton « Copy URL »), `src/App.tsx`, `src/lib/strings.ts`

**Interfaces:**
- Produces (`connectionUrl.ts`) :
  - `toConnectionUrl(cfg: ConnectionConfig): string` — jamais de mot de passe. Schémas : `postgresql://`, `mysql://`, `mariadb://`, `sqlite://` + chemin absolu (`sqlite:///home/u/db.sqlite`). Forme `scheme://user@host:port/database?params` ; user et database encodés (`encodeURIComponent`), IPv6 entre crochets ; params seulement s'ils diffèrent du défaut : `sslmode=disable|prefer|require|verify-ca|verify-full` (noms libpq) puis, avec SSH, `ssh=<user@>host<:port>`.
  - `parseConnectionUrl(url: string): { config: Partial<ConnectionConfig>; password: string | null; warnings: string[] }` — schémas acceptés : `postgres`, `postgresql`, `mysql`, `mariadb`, `sqlite` ; port par défaut du driver si absent ; `sslmode` libpq et les valeurs MySQL `ssl-mode=DISABLED|PREFERRED|REQUIRED|VERIFY_IDENTITY` ; un mot de passe présent dans l'URL est renvoyé séparément (jamais mis dans la config) ; paramètre inconnu → avertissement `unknown parameter "<nom>"` ; schéma inconnu ou URL illisible → `throw new Error(strings.url.invalid)`.
- UI :
  - `ConnectionList` : connexions groupées par `group` (sections repliables, groupe vide = « Ungrouped » en dernier, état replié mémorisé en `localStorage` avec try/catch), recherche qui filtre aussi sur le nom du groupe et l'hôte, groupes contenant un résultat dépliés pendant la recherche.
  - « New from URL… » (dans le menu du bouton `+`, qui devient un petit menu : New connection / New from URL… / Import TablePlus export…) : collage d'une URL, aperçu des avertissements, puis ouverture du formulaire pré-rempli (mot de passe pré-rempli dans le champ si présent, rien n'est enregistré avant Save).
  - « Copy URL » dans le formulaire d'une connexion enregistrée : copie via `navigator.clipboard.writeText`.

- [ ] **Step 1: Tests qui échouent**

```ts
test("round-trips a postgres config without the password", () => {
  const url = toConnectionUrl({ ...pgCfg, user: "a b", database: "shop", ssl: { ...noSsl, mode: "verifyFull" } });
  expect(url).toBe("postgresql://a%20b@db.example.com:5432/shop?sslmode=verify-full");
  expect(parseConnectionUrl(url).config).toMatchObject({ kind: "postgres", user: "a b", database: "shop", ssl: { mode: "verifyFull" } });
});
test("password in URL is returned separately", () => {
  const r = parseConnectionUrl("mysql://root:s3cret@127.0.0.1/app");
  expect(r.password).toBe("s3cret"); expect(r.config.port).toBe(3306); expect(JSON.stringify(r.config)).not.toContain("s3cret");
});
test("sqlite absolute path", () => { expect(parseConnectionUrl("sqlite:///home/u/x.db").config).toMatchObject({ kind: "sqlite", sqlitePath: "/home/u/x.db" }); });
test("mysql ssl-mode and unknown params warn", () => { /* ?ssl-mode=REQUIRED&foo=1 → ssl.mode "require", warnings ['unknown parameter "foo"'] */ });
test("ipv6 host", () => { /* postgresql://u@[::1]:5433/db ↔ host "::1" */ });
test("ssh param round-trips", () => { /* ssh=deploy@bastion.example:2200 */ });
test("rejects unknown scheme", () => { expect(() => parseConnectionUrl("redis://x")).toThrow(); });
```
`ConnectionList.test.tsx` : deux groupes + des connexions sans groupe → en-têtes de groupe dans l'ordre alphabétique puis « Ungrouped » ; cliquer un en-tête replie ; une recherche sur le nom d'un groupe montre ses connexions.
`connectionUrl.test.ts` ajoute : `postgresql://u@db.example.com/x` sans `sslmode` → `ssl.mode === "verifyFull"` ; `postgresql://u@localhost/x` → `"prefer"` (via `defaultSslMode`, Task 5).

- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.

- [ ] **Step 3: Implémenter.**

- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "✨ feat(connections): connection groups and URL import/export"
```

---

### Task 7: Lecture des exports `.tableplusconnection` (backend)

**Files:**
- Create: `src-tauri/src/import/mod.rs`, `src-tauri/src/import/rncryptor.rs`, `src-tauri/src/import/tableplus.rs`, `src-tauri/tests/tableplus_import.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/manager.rs`, `src-tauri/Cargo.toml`
- Fixtures: `src-tauri/tests/fixtures/tableplus/` (produites par la recherche ; voir son `README.md` pour le mot de passe et le contenu)

**Interfaces:**
- Produces (`rncryptor.rs`) : `pub fn decrypt(data: &[u8], password: &str) -> AppResult<Vec<u8>>` — format v3 à mot de passe (octet 0 = 3, bit 0 des options = 1) ; trop court, mauvaise version, HMAC faux ou padding faux → `Invalid "wrong password or corrupted file"` (même message pour tous : ne pas aider à distinguer). `#[cfg(test)] pub fn encrypt(plain, password, salts, iv) -> Vec<u8>` pour les tests.
- Produces (`tableplus.rs`) :
  - `pub struct ImportedConnection { pub config: ConnectionConfig /* id vide */, pub password: Option<String>, pub ssh_secret: Option<String> }` (Debug manuel qui masque les secrets)
  - `pub struct ImportWarning { pub entry: String, pub message: String }` (Serialize camelCase)
  - `pub fn parse_export(plain: &[u8]) -> AppResult<(Vec<ImportedConnection>, Vec<ImportWarning>)>` — format décrit dans `docs/research/2026-10-17-tableplusconnection-format.md` (racine = tableau JSON ; élément avec `IsExpanded` ou `IsExpaned` = groupe, récursif via `groups`/`connections` ; sinon connexion). Clés inconnues ignorées ; ports et booléens acceptés en chaîne **ou** nombre ; clé absente = vide ; JSON illisible → `Invalid "not a TablePlus export"`. Correspondance :

| Export | TableMax |
|---|---|
| `ConnectionName` | `name` (vide → `"Imported connection"`) |
| `Driver` `MySQL` / `MariaDB` / `PostgreSQL` / `SQLite` | `kind` `mySql` / `mariaDb` / `postgres` / `sqlite` ; tout autre driver → entrée ignorée + `ImportWarning { entry: <nom>, message: "unsupported driver <Driver>" }` |
| `DatabaseHost`, `DatabasePort`, `DatabaseUser`, `DatabaseName`, `DatabasePath` | `host`, `port` (vide → port par défaut du driver), `user`, `database` (vide → `None`), `sqlite_path` |
| `isOverSSH` = 1 + `ServerAddress`, `ServerPort`, `ServerUser` | `ssh = Some(SshSettings { host, port, user, … })` ; auth `Password` si `ServerPassword` non vide, sinon `Key` avec `key_file: None` (le chemin de clé n'est pas exporté) ; `secret_mode` = `Keyring` si un secret est présent, sinon `Ask` pour `Password` et `None` pour `Key` |
| `DatabasePassword` | `password` ; `password_mode` = `Keyring` si non vide, sinon `Ask` (`None` pour SQLite) |
| `ServerPassword` / `DatabaseKeyPassword` | `ssh_secret` (mot de passe SSH / **passphrase de la clé SSH**, malgré le nom) |
| `Tag`, sinon `Enviroment` | `env_tag` : `local`→Local, `development`/`dev`→Dev, `testing`/`staging`→Staging, `production`/`prod`→Prod, absent ou autre → Local |
| groupes imbriqués (`Name`) | `group` = noms du chemin joints par `" / "` (ex. `"Fixture Group / Sub"`) ; connexion hors groupe → `None` |
| (non exporté) couleur, SSL | `color` = `"swatch-1"`, `ssl.mode` = `default_ssl_mode(host, over_ssh)` (Task 4), fichiers SSL vides |
| `Favorites`, `DriverVersion`, `SafeModeLevel`, `RecentlySchema`, `Schema`, `image`, `GroupID` | ignorés |

    Une connexion SSH par clé importée reçoit en plus l'avertissement `"SSH key file not included in the export: choose it in the connection settings"` (la résolution de la Task 4 retombe sinon sur `~/.ssh/config` et les clés par défaut).
- Produces (`manager.rs` / `commands.rs`) :
  - `import_tableplus_preview(password: String) -> ImportPreview` : ouvre le sélecteur (`FilePurpose::TableplusExport`), lit le fichier (max 10 Mo, sinon `Invalid "file too large"`), déchiffre, analyse, et **garde côté backend** les secrets dans une table d'imports en attente (clé `import_id` UUID, expiration 10 minutes ou au premier commit). Annulation du sélecteur → `Ok(None)` (type de retour `Option<ImportPreview>`).
  - `#[serde(rename_all = "camelCase")] pub struct ImportPreview { pub import_id: String, pub items: Vec<ImportItem>, pub warnings: Vec<ImportWarning> }` ; `pub struct ImportItem { pub index: usize, pub config: ConnectionConfig, pub has_password: bool, pub has_ssh_secret: bool, pub duplicate_of: Option<String> }` — `duplicate_of` = id d'une connexion existante de même identité (`same_identity`) ou de même nom.
  - `import_tableplus_commit(import_id: String, indexes: Vec<usize>) -> Vec<ConnectionConfig>` : enregistre chaque entrée choisie via `save_connection` ; secrets → trousseau (mode `Keyring`) ; si le trousseau est indisponible, la connexion est enregistrée en mode `Ask` et un avertissement est renvoyé ; l'import en attente est supprimé ; id inconnu ou expiré → `NotFound "import expired"`.

- [ ] **Step 1: Tests qui échouent**

`rncryptor.rs` :
```rust
#[test] fn decrypts_official_v3_password_vectors() { /* au moins 3 vecteurs de RNCryptor-Spec vectors/v3/password, copiés en hex dans le test avec leur source en commentaire */ }
#[test] fn wrong_password_is_rejected() { /* message exact "wrong password or corrupted file" */ }
#[test] fn flipped_byte_is_rejected() {}
#[test] fn truncated_is_rejected() {}
```
`tableplus_import.rs` (fixtures) :
- `parses_every_fixture` : chaque fichier de fixtures se déchiffre avec le mot de passe du README et donne les connexions attendues (driver, hôte, port, user, base, groupe) ; secrets présents là où le README le dit.
- `ssh_and_ssl_fields_are_mapped` : sur la fixture SSH/SSL, `ssh.host`, `ssh.user`, `ssh.auth`, `ssl.mode` attendus.
- `unsupported_driver_is_skipped_with_warning` : JSON d'export construit dans le test avec une entrée d'un driver hors v1 (ex. Redis) et une entrée PG → 1 connexion + 1 avertissement.
- `preview_never_contains_secrets` : `serde_json::to_string(&preview)` ne contient pas les mots de passe des fixtures.
- `commit_stores_secrets_in_keyring_and_flags_duplicates` (unitaire manager, `MemorySecretStore`) : second aperçu du même fichier → `duplicate_of` renseigné ; commit → secrets dans le store mémoire, aucun dans `config_json`.

- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test:rust` → Expected: FAIL.

- [ ] **Step 3: Implémenter.**

- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm lint` → Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "✨ feat(import): read TablePlus connection exports"
```

---

### Task 8: Dialogue d'import et vérification finale

**Files:**
- Create: `src/features/connections/ImportDialog.tsx`, `src/features/connections/ImportDialog.test.tsx`
- Modify: `src/lib/ipc.ts`, `src/lib/types.ts`, `src/lib/strings.ts`, `src/App.tsx` (entrée « Import TablePlus export… » du menu `+`), `README.md` (SSL, SSH, URL, import ; `test-dbs.sh down`), `docs/notes/plan-02-manual-check.md`

**Interfaces:**
- Consumes: `importTablePlusPreview(password)` → `ImportPreview | null`, `importTablePlusCommit(importId, indexes)` → `ConnectionConfig[]` (Task 7).
- UI : étape 1 = champ « Export password » + « Choose file… » (appelle `importTablePlusPreview`) ; erreur affichée sur place (mauvais mot de passe) ; étape 2 = liste à cocher (nom, driver, hôte, groupe, pastilles « password », « SSH », « duplicate of <nom> ») avec tout coché sauf les doublons, avertissements listés, bouton « Import N connections » ; à la fin, recharge la liste des connexions et affiche « Imported N connections ».

- [ ] **Step 1: Tests qui échouent** — `ImportDialog.test.tsx` : mot de passe faux → message d'erreur sans quitter l'étape 1 ; aperçu avec un doublon → doublon décoché ; « Import » appelle `importTablePlusCommit(importId, [indexes cochés])` puis recharge la liste.

- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.

- [ ] **Step 3: Implémenter.**

- [ ] **Step 4: Vérification complète**

Run: `pnpm test && pnpm lint && pnpm test:rust`
Expected: tout passe.

- [ ] **Step 5: Vérification manuelle dans l'app** (`pnpm demo:db`, `pnpm tauri dev`) et notes dans `docs/notes/plan-02-manual-check.md` : connexion TLS `verifyFull` sur `localhost` avec le CA de test ; connexion via SSH (mot de passe puis clé chiffrée → invite de passphrase) ; empreinte inconnue puis connue ; groupe replié/déplié ; « Copy URL » puis « New from URL… » ; import d'une fixture TablePlus (un doublon signalé) ; vérifier qu'aucun secret n'apparaît dans `app.db` (`sqlite3 ~/.local/share/dev.tablemax.app/app.db .dump | grep -c <secret>` = 0).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "✨ feat(import): import dialog for TablePlus exports"
```
