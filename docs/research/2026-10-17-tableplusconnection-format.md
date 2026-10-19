# Format `.tableplusconnection` (TablePlus Linux) — recherche pour l'importeur TableMax (2026-10-17)

Cible : `/opt/tableplus/tableplus`, TablePlus Linux 1.8.4 (316), paquet `tableplus 0.1.316`,
SHA-256 `85ab3adbb0e2f8e37e806fca0904bda5948c06b78136ad6b384f9a748cdff979`.

But : comprendre le format des exports de connexions pour écrire un **importeur** propre dans
TableMax (lecture des fichiers que l'utilisateur exporte lui-même). Aucun code ni asset TablePlus
n'est repris ; seul le format de données est documenté.

## TL;DR

- Fichier binaire = **RNCryptor v3, mode mot de passe** (en-tête `03 01`), PBKDF2-HMAC-SHA1
  **10 000 itérations**, AES-256-CBC + PKCS#7, HMAC-SHA256. **Toujours chiffré** : la boîte de
  dialogue refuse un mot de passe vide, il n'existe pas d'export en clair.
- Clair = **tableau JSON** UTF-8 compact (pas de BOM, pas de NUL final), éléments séparés par
  `",\n"`. Chaque élément est soit une **connexion**, soit un **groupe** (récursif).
- Les clés sont celles du format historique macOS (`ConnectionName`, `Driver`, `DatabaseHost`,
  `isOverSSH`, `ServerAddress`…).
- Les **mots de passe sont en clair dans le JSON chiffré** quand la case « Includes database and
  server passwords » est cochée (cochée par défaut) ; décochée → les trois clés `*Password`
  sont **absentes**.
- La build Linux **n'exporte pas** : chemin de clé privée SSH, mode/certificats SSL, couleur,
  tag (environnement), id de connexion, id propre du groupe. L'importeur ne doit pas les attendre.
- Fixtures **réelles** (générées par TablePlus via son GUI) :
  `src-tauri/tests/fixtures/tableplus/*.tableplusconnection`, mot de passe `fixture-pass`.

## Méthode

1. **Statique** (`nm`, `objdump -d`, résolution des littéraux `lea …(%rip)` par un petit script
   Python qui mappe les adresses virtuelles sur les segments `LOAD`) :
   - `table_plus_services_setting_service_export_connection` / `export_group` (sérialisation),
   - `table_plus_services_setting_service_import_connection` / `import_group` /
     `import_from_dump` (désérialisation — les clés lues, y compris celles que Linux n'écrit pas),
   - lambdas de `ConnectionView` (`__lambda525_` export de connexion(s), `__lambda131_` export
     de groupe, `__lambda134_` export all, `____lambda138_` import),
   - `table_plus_services_setting_service_encrypt_data` / `decrypt_data` →
     `rncryptorc_encrypt_data_with_password` (lib C `rncryptor_c.c` liée statiquement, OpenSSL),
   - `table_plus_layouts_export_connection_option_dialog_*` (boîte « Encrypt file »),
   - `table_plus_services_password_service_*` (libsecret).
2. **Dynamique** : connexions factices injectées dans `~/.tableplus/settings/connections.json`
   et `connection_groups.json` (format interne, voir annexe), mots de passe factices posés dans
   le trousseau libsecret avec le schéma de TablePlus, puis TablePlus lancé **dans un Xvfb**
   (`DISPLAY=:99`, piloté par `xdotool`, captures `import -window root`). Sous XWayland direct,
   le pointeur XTest ne touche pas les dialogues et les touches spéciales (Retour, Effacement)
   ne passent pas ; Xvfb contourne les deux problèmes.
   Exports réalisés via le menu contextuel « Export connection… » → « Export this connection… »,
   « Export this group… », « Export all… ».
3. **Vérification** : déchiffrement des cinq exports par un script Python indépendant
   (`hashlib.pbkdf2_hmac` + `cryptography` AES-CBC) avec vérification HMAC ; mauvais mot de
   passe → HMAC invalide.
4. **Nettoyage** : `~/.tableplus/` restauré à l'identique depuis la sauvegarde (`diff -r` vide),
   entrées de trousseau factices supprimées.

## Conteneur chiffré : RNCryptor v3 (confirmé)

| Octets | Champ | Valeur |
|---|---|---|
| 0 | version | `0x03` |
| 1 | options | `0x01` (= dérivé d'un mot de passe) |
| 2..9 | encryption salt | 8 octets aléatoires (`RAND_bytes`) |
| 10..17 | HMAC salt | 8 octets aléatoires |
| 18..33 | IV | 16 octets aléatoires |
| 34..n-33 | ciphertext | AES-256-CBC, padding PKCS#7 |
| n-32..n-1 | HMAC | HMAC-SHA256(clé HMAC, octets 0..n-33) |

- Clé de chiffrement = `PBKDF2-HMAC-SHA1(password, encryption_salt, 10000, 32)`.
- Clé HMAC = `PBKDF2-HMAC-SHA1(password, hmac_salt, 10000, 32)`.
- Preuves dans le binaire : `allocate_rncryptor_info` écrit le mot `0x0103` (version 3,
  options 1) et `0x2710` (10 000) ; `setting_service_encrypt_data` appelle
  `rncryptorc_encrypt_data_with_password(…, kdf_iter = 0x2710, …)` ;
  `rncryptorc_encrypt_data_with_password_with_salts_and_iv` appelle deux fois
  `PKCS5_PBKDF2_HMAC_SHA1(…, saltlen = 8, …, keylen = 0x20)`, puis `EVP_aes_256_cbc`,
  `HMAC_Init_ex(…, 0x20, EVP_sha256())`. Les `RAND_bytes` sont de 8, 8 et 16 octets.
- Le mot de passe est passé en octets UTF-8 tels quels (pas de normalisation observée).
- Surcoût fixe : 34 octets d'en-tête + 32 de HMAC + 1 à 16 de padding.
- Il existe aussi une implémentation Vala (`table_plus_services_rn_cryptor_v3_*`), utilisée
  uniquement par l'import/export des **Metrics Boards**, pas par les connexions.

## Boîte de dialogue d'export (« Encrypt file »)

- Libellé : « Enter password for the encrypted file », champ `password...`, case
  **« Includes database and server passwords » cochée par défaut** (`gtk_toggle_button_set_active`
  dans `build_ui`, confirmé visuellement).
- `__lambda525_` (et 131/134) : `if (strlen(encrypt_pass) == 0) return FALSE;` → un mot de passe
  vide est simplement refusé (la boîte reste ouverte). **Aucun export non chiffré possible.**
- Nom par défaut proposé : `connections.tableplusconnection`. Filtre d'import :
  `*.tableplusconnection` (« TablePlus connection dump »).
- Import (`____lambda138_`) : `decrypt_data` → `json_parser_load_from_data` →
  `json_node_get_array` → pour chaque élément `import_from_dump`. Pas de repli en clair.

## Structure du clair

```
racine := [ élément ("," "\n" élément)* ]          // JSON compact, json_generator non "pretty"
élément := groupe | connexion
```

`import_from_dump` classe un élément comme **groupe** s'il possède `IsExpanded` **ou**
`IsExpaned` (sic) ; sinon c'est une **connexion**.

Ordre produit par « Export all » : d'abord les groupes racine, puis les connexions racine
(chacun dans l'ordre de la barre latérale).

### Connexion

Ordre exact d'écriture (`export_connection(conn, include_passwords, include_group_id)`) :

| Clé | Type JSON | Sens | Exemple | Notes |
|---|---|---|---|---|
| `ConnectionName` | string | nom affiché | `"fixture-mysql"` | lu sans test de présence à l'import → **obligatoire** |
| `Driver` | string | identifiant du driver | `"MySQL"` | **obligatoire** ; valeurs ci-dessous |
| `DatabaseHost` | string | hôte | `"127.0.0.1"` | `""` pour SQLite |
| `DatabasePort` | **string** | port | `"3306"` | chaîne, pas entier ; `""` si vide |
| `DatabaseUser` | string | utilisateur | `"demo"` | |
| `DatabaseName` | string | base | `"shop"` | |
| `DatabasePath` | string | chemin fichier (SQLite, DuckDB…) | `"/home/demo/shop.sqlite3"` | `""` sinon |
| `DriverVersion` | int | variante/version de driver interne | `0` | |
| `isOverSSH` | int (0/1) | tunnel SSH activé | `1` | entier, pas booléen |
| `ServerAddress` | string | hôte SSH | `"bastion.example.test"` | |
| `ServerPort` | **string** | port SSH | `"22"` | chaîne |
| `ServerUser` | string | utilisateur SSH | `"sshdemo"` | |
| `Favorites` | object | tables épinglées : `{ "<nom>": "pinned" }` | `{"public.orders":"pinned"}` | la **clé** est le favori, la valeur vaut toujours `"pinned"` ; `{}` si aucun |
| `GroupID` | string | id du groupe parent | `"11111111-…-0000000000a1"` | **seulement** pour les connexions exportées à l'intérieur d'un groupe (export de groupe / export all) ; absent pour les connexions racine et pour « Export this connection… » même si la connexion est dans un groupe |
| `DatabasePassword` | string | mot de passe BD | `"demo-pass"` | si case cochée ; `""` si rien dans le trousseau |
| `ServerPassword` | string | mot de passe SSH | `"ssh-demo-pass"` | si case cochée |
| `DatabaseKeyPassword` | string | **passphrase de la clé privée SSH** (malgré le nom) | `"key-demo-pass"` | si case cochée |

Correspondance trousseau (libsecret, schéma `com.tableplus.TablePlusLinux`, attributs
`id` = id de connexion, `type`, `schema`) : `type=db_password` → `DatabasePassword`,
`ssh_user_password` → `ServerPassword`, `ssh_key_password` → `DatabaseKeyPassword`
(enum `PasswordService.KeyType` 1/2/3 ; `ConnectionModel.update_secret(db_password,
ssh_user_password, ssh_key_password)` à l'import).

Clés **lues à l'import mais jamais écrites par Linux** (compatibilité avec les exports macOS) :

| Clé | Type | Effet à l'import |
|---|---|---|
| `Tag` | string | tag/environnement (`set_tag`) ; prioritaire |
| `Enviroment` (sic) | string | repli si `Tag` absent |
| `SafeModeLevel` | int | niveau safe mode (stocké via SafeModeService / trousseau) |
| `AdvancedSafeModeLevel` | int | idem, mode avancé |
| `RecentlySchema` | array<string> | schémas récents (`set_recent_schemas`) |
| `Schema` | string | schéma sélectionné (`set_selected_schema`) |

Toutes les clés autres que `ConnectionName`/`Driver` sont testées par `json_object_has_member`
avant lecture → optionnelles. Les clés inconnues sont ignorées.

**Non exportés par TablePlus Linux** (présents dans le modèle interne, perdus à l'export) :
`ssh-key-path` (chemin de la clé privée), `ssl-mode`, `ssl-negotiation`, `ssl-key-path-1/2/3`
(Key / Cert / CA Cert), `ssl-key-path-1-pass`, `color`, `tag`, `id`, `db-url`,
`limit-query-rows-returned`, `num-rows-per-page`, `enable-cleartext-plugin`,
`enable-load-local-infile`, options « command line password ». Conséquences : une connexion SSH
par clé arrive avec sa passphrase mais **sans chemin de clé** ; une connexion SSL arrive comme
une connexion non-SSL (fixture `fixture-ssl` : mode 3 + 3 chemins côté TablePlus, rien dans
l'export).

### Groupe

Ordre d'écriture (`export_group`) :

| Clé | Type | Sens | Notes |
|---|---|---|---|
| `Name` | string | nom du groupe | lu sans test → obligatoire |
| `GroupID` | string | id du **groupe parent** (`""` pour un groupe racine) | l'id propre du groupe n'est **pas** exporté ; il n'apparaît qu'indirectement comme `GroupID` de ses enfants |
| `IsExpaned` (sic) | int (0/1) | groupe déplié | l'import accepte aussi `IsExpanded` |
| `image` | string | icône personnalisée : PNG encodé en **hex majuscule** (`%02X`, sans séparateur) | écrit seulement si une icône existe ; absent des fixtures |
| `groups` | array<groupe> | sous-groupes (récursif) | |
| `connections` | array<connexion> | connexions du groupe, chacune avec `GroupID` = id de ce groupe | |

### Identifiants de driver (`Driver`)

Chaînes exactes utilisées par TablePlus (`sql_helper_name_from_driver`,
`connection_model_get_db_port_or_default`, formulaire) :

| `Driver` | Moteur | Pour TableMax v1 |
|---|---|---|
| `MySQL` | MySQL | oui |
| `MariaDB` | MariaDB | oui |
| `PostgreSQL` | PostgreSQL | oui |
| `SQLite` | SQLite (utilise `DatabasePath`) | oui |
| `Greenplum`, `Redshift`, `Cockroach` | dérivés PostgreSQL | à refuser ou mapper explicitement |
| `MicrosoftSQLServer`, `MongoDB`, `Redis`, `ElasticSearch`, `Cassandra`, `ClickHouse`, `DuckDB`, `LibSQL`, `CloudflareD1` | autres | non supportés → ignorer avec avertissement |
| `Oracle`, `Snowflake`, `Vertica`, `Mongo` | présents dans `sql_helper_short_name_from_driver` (héritage macOS) | non supportés |

Défaut du modèle : `MySQL`. Ports par défaut appliqués quand `DatabasePort` est vide
(`get_db_port_or_default`) : MySQL/MariaDB 3306, PostgreSQL/Greenplum 5432, Redshift 5439,
Cockroach 26257, MongoDB 27017, SQL Server 1433, Redis 6379, ElasticSearch 9200.

### Couleur et environnement (pour info, non exportés)

- Couleur interne : chaîne CSS `rgb(r,g,b)` (ex. `rgb(104,107,111)`, normalisée par
  `utils_normalize_default_connection_color` ; `transparent`, `rgb(248,248,248)` = défaut).
- Tag interne : chaîne (`local`, `development`, `testing`, `staging`, `production`…).
- Ni l'un ni l'autre ne figure dans un export Linux ; un export macOS peut porter
  `Tag`/`Enviroment` (et sans doute d'autres clés, non vérifié).

## Recommandations pour l'importeur TableMax

1. Vérifier `len ≥ 66`, `data[0] == 3`, `data[1] == 1` ; sinon « fichier non reconnu ».
2. Dériver les deux clés (PBKDF2-SHA1, 10 000, 32 o), **vérifier le HMAC en temps constant avant
   de déchiffrer** ; échec → « mot de passe incorrect » (on ne distingue pas fichier corrompu).
3. Déchiffrer AES-256-CBC, retirer le PKCS#7, parser en JSON UTF-8.
4. Racine = tableau ; élément avec `IsExpanded`/`IsExpaned` → groupe (récursif via `groups` /
   `connections`), sinon connexion.
5. Tolérance de types : accepter port en chaîne **ou** entier, `isOverSSH`/`IsExpaned` en entier
   **ou** booléen, clés manquantes = vide, clés inconnues ignorées.
6. Driver hors {MySQL, MariaDB, PostgreSQL, SQLite} → ignoré et listé dans le rapport d'import.
7. Mots de passe : les écrire dans le keyring de TableMax, jamais en clair sur disque ; chaîne
   vide = « pas de mot de passe ».
8. SSH : `isOverSSH = 1` + `DatabaseKeyPassword` non vide ⇒ très probablement auth par clé dont le
   chemin manque → demander le fichier à l'utilisateur. SSL : rien à importer.
9. Groupes : recréer l'arborescence à partir de l'imbrication (ne pas se fier à `GroupID`, qui
   pointe vers des ids absents du fichier). Générer de nouveaux ids.

## Inconnues / limites

- **Exports macOS / Windows** : non testés. L'import Linux lit des clés macOS (`Tag`,
  `Enviroment`, `SafeModeLevel`, `RecentlySchema`, `Schema`, `IsExpanded`), ce qui suggère le
  même schéma de base, mais un export macOS contient probablement des clés supplémentaires
  (SSL, clé SSH, couleur…) dont les noms et types ne sont pas connus ici. Le conteneur RNCryptor
  v3 est un format public partagé, a priori identique.
- `DriverVersion` : sémantique exacte non établie (0 pour toutes les fixtures).
- `image` des groupes : format déduit statiquement (`gdk_pixbuf_save_to_buffer("png")` →
  `utils_binary_to_hex` `%02X` → `g_utf8_strup`), pas observé dans un export réel.
- Comportement de TablePlus sur un JSON sans `ConnectionName`/`Driver` : non testé (lecture sans
  garde, probablement `NULL`).
- Mots de passe contenant des caractères non-ASCII : non testé (le mot de passe d'export est passé
  en octets bruts à PBKDF2, a priori UTF-8).

## Annexe : format interne `~/.tableplus/settings/connections.json` (hors export)

Utile seulement pour un éventuel « import depuis une installation TablePlus locale ». Fichier
`{"objects":[…]}` dont chaque objet est un `json_gobject_serialize` du `ConnectionModel` (noms de
propriétés GObject avec tirets : `id`, `name`, `color`, `tag`, `db-driver`, `db-host`,
`db-port` (string), `db-user`, `db-name`, `db-path`, `driver-version` (int), `use-ssh-tunnel`
(int), `ssh-host`, `ssh-port` (string), `ssh-user`, `ssh-key-path`, `ssh-key-pass`, `ssl-mode`
(int), `ssl-negotiation` (int), `ssl-key-path-1`, `ssl-key-path-1-pass`, `ssl-key-path-2`,
`ssl-key-path-3`, `favorites` (array), `recent-schemas` (array), `group-id`, …). Les entiers à 0
sont omis à la réécriture. `connection_groups.json` : `{"objects":[{"id","name","group-id",
"is-expanded","groups":[ids],"connections":[ids]}]}`. Mots de passe dans libsecret (schéma
`com.tableplus.TablePlusLinux`, attributs `id`/`type`/`schema`). Valeurs `ssl-mode` = index
dans la liste du driver (listes trouvées dans `get_ssl_modes`, attribution par driver déduite : MySQL : PREFERRED, DISABLED, REQUIRED, VERIFY-CA, VERIFY-IDENTITY ;
PostgreSQL : PREFERRED, DISABLED, REQUIRED, ALLOW, VERIFY-CA, VERIFY-FULL).

## Annexe : clair des fixtures (valeurs factices)

Texte exact produit par le déchiffrement (sauts de ligne d'origine conservés ; seul
`single-ssh-key` est aussi montré indenté pour la lisibilité). Mot de passe : `fixture-pass`.

### `all-with-passwords.tableplusconnection` — Export all, mots de passe inclus

```json
[{"Name":"Fixture Group","GroupID":"","IsExpaned":1,"groups":[{"Name":"Nested Group","GroupID":"11111111-0000-4000-8000-0000000000a1","IsExpaned":0,"groups":[],"connections":[{"ConnectionName":"fixture-nested-sqlite","Driver":"SQLite","DatabaseHost":"","DatabasePort":"","DatabaseUser":"","DatabaseName":"","DatabasePath":"/home/demo/nested.sqlite3","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"GroupID":"11111111-0000-4000-8000-0000000000a2","DatabasePassword":"","ServerPassword":"","DatabaseKeyPassword":""}]}],"connections":[{"ConnectionName":"fixture-grouped-mysql","Driver":"MySQL","DatabaseHost":"127.0.0.1","DatabasePort":"3306","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"GroupID":"11111111-0000-4000-8000-0000000000a1","DatabasePassword":"demo-pass","ServerPassword":"","DatabaseKeyPassword":""}]},
{"ConnectionName":"fixture-mysql","Driver":"MySQL","DatabaseHost":"127.0.0.1","DatabasePort":"3306","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"DatabasePassword":"demo-pass","ServerPassword":"","DatabaseKeyPassword":""},
{"ConnectionName":"fixture-mariadb","Driver":"MariaDB","DatabaseHost":"127.0.0.1","DatabasePort":"3307","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"DatabasePassword":"demo-pass","ServerPassword":"","DatabaseKeyPassword":""},
{"ConnectionName":"fixture-postgres","Driver":"PostgreSQL","DatabaseHost":"127.0.0.1","DatabasePort":"5432","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{"public.orders":"pinned"},"DatabasePassword":"demo-pass","ServerPassword":"","DatabaseKeyPassword":""},
{"ConnectionName":"fixture-sqlite","Driver":"SQLite","DatabaseHost":"","DatabasePort":"","DatabaseUser":"","DatabaseName":"","DatabasePath":"/home/demo/shop.sqlite3","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"DatabasePassword":"","ServerPassword":"","DatabaseKeyPassword":""},
{"ConnectionName":"fixture-ssh-password","Driver":"PostgreSQL","DatabaseHost":"127.0.0.1","DatabasePort":"5432","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":1,"ServerAddress":"bastion.example.test","ServerPort":"22","ServerUser":"sshdemo","Favorites":{},"DatabasePassword":"demo-pass","ServerPassword":"ssh-demo-pass","DatabaseKeyPassword":""},
{"ConnectionName":"fixture-ssh-key","Driver":"MySQL","DatabaseHost":"127.0.0.1","DatabasePort":"3306","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":1,"ServerAddress":"bastion.example.test","ServerPort":"2222","ServerUser":"sshdemo","Favorites":{},"DatabasePassword":"demo-pass","ServerPassword":"","DatabaseKeyPassword":"key-demo-pass"},
{"ConnectionName":"fixture-ssl","Driver":"PostgreSQL","DatabaseHost":"127.0.0.1","DatabasePort":"5432","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"DatabasePassword":"demo-pass","ServerPassword":"","DatabaseKeyPassword":""}]
```

### `all-without-passwords.tableplusconnection` — Export all, case décochée (clés `*Password` absentes)

```json
[{"Name":"Fixture Group","GroupID":"","IsExpaned":1,"groups":[{"Name":"Nested Group","GroupID":"11111111-0000-4000-8000-0000000000a1","IsExpaned":0,"groups":[],"connections":[{"ConnectionName":"fixture-nested-sqlite","Driver":"SQLite","DatabaseHost":"","DatabasePort":"","DatabaseUser":"","DatabaseName":"","DatabasePath":"/home/demo/nested.sqlite3","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"GroupID":"11111111-0000-4000-8000-0000000000a2"}]}],"connections":[{"ConnectionName":"fixture-grouped-mysql","Driver":"MySQL","DatabaseHost":"127.0.0.1","DatabasePort":"3306","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"GroupID":"11111111-0000-4000-8000-0000000000a1"}]},
{"ConnectionName":"fixture-mysql","Driver":"MySQL","DatabaseHost":"127.0.0.1","DatabasePort":"3306","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{}},
{"ConnectionName":"fixture-mariadb","Driver":"MariaDB","DatabaseHost":"127.0.0.1","DatabasePort":"3307","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{}},
{"ConnectionName":"fixture-postgres","Driver":"PostgreSQL","DatabaseHost":"127.0.0.1","DatabasePort":"5432","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{"public.orders":"pinned"}},
{"ConnectionName":"fixture-sqlite","Driver":"SQLite","DatabaseHost":"","DatabasePort":"","DatabaseUser":"","DatabaseName":"","DatabasePath":"/home/demo/shop.sqlite3","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{}},
{"ConnectionName":"fixture-ssh-password","Driver":"PostgreSQL","DatabaseHost":"127.0.0.1","DatabasePort":"5432","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":1,"ServerAddress":"bastion.example.test","ServerPort":"22","ServerUser":"sshdemo","Favorites":{}},
{"ConnectionName":"fixture-ssh-key","Driver":"MySQL","DatabaseHost":"127.0.0.1","DatabasePort":"3306","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":1,"ServerAddress":"bastion.example.test","ServerPort":"2222","ServerUser":"sshdemo","Favorites":{}},
{"ConnectionName":"fixture-ssl","Driver":"PostgreSQL","DatabaseHost":"127.0.0.1","DatabasePort":"5432","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{}}]
```

### `group.tableplusconnection` — Export this group (sur « Fixture Group »)

```json
[{"Name":"Fixture Group","GroupID":"","IsExpaned":1,"groups":[{"Name":"Nested Group","GroupID":"11111111-0000-4000-8000-0000000000a1","IsExpaned":0,"groups":[],"connections":[{"ConnectionName":"fixture-nested-sqlite","Driver":"SQLite","DatabaseHost":"","DatabasePort":"","DatabaseUser":"","DatabaseName":"","DatabasePath":"/home/demo/nested.sqlite3","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"GroupID":"11111111-0000-4000-8000-0000000000a2","DatabasePassword":"","ServerPassword":"","DatabaseKeyPassword":""}]}],"connections":[{"ConnectionName":"fixture-grouped-mysql","Driver":"MySQL","DatabaseHost":"127.0.0.1","DatabasePort":"3306","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"GroupID":"11111111-0000-4000-8000-0000000000a1","DatabasePassword":"demo-pass","ServerPassword":"","DatabaseKeyPassword":""}]}]
```

### `single-grouped.tableplusconnection` — Export this connection sur une connexion d'un groupe (pas de `GroupID`)

```json
[{"ConnectionName":"fixture-grouped-mysql","Driver":"MySQL","DatabaseHost":"127.0.0.1","DatabasePort":"3306","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":0,"ServerAddress":"","ServerPort":"","ServerUser":"","Favorites":{},"DatabasePassword":"demo-pass","ServerPassword":"","DatabaseKeyPassword":""}]
```

### `single-ssh-key.tableplusconnection` — Export this connection (SSH par clé)

```json
[{"ConnectionName":"fixture-ssh-key","Driver":"MySQL","DatabaseHost":"127.0.0.1","DatabasePort":"3306","DatabaseUser":"demo","DatabaseName":"shop","DatabasePath":"","DriverVersion":0,"isOverSSH":1,"ServerAddress":"bastion.example.test","ServerPort":"2222","ServerUser":"sshdemo","Favorites":{},"DatabasePassword":"demo-pass","ServerPassword":"","DatabaseKeyPassword":"key-demo-pass"}]
```

Indenté :

```json
[
  {
    "ConnectionName": "fixture-ssh-key",
    "Driver": "MySQL",
    "DatabaseHost": "127.0.0.1",
    "DatabasePort": "3306",
    "DatabaseUser": "demo",
    "DatabaseName": "shop",
    "DatabasePath": "",
    "DriverVersion": 0,
    "isOverSSH": 1,
    "ServerAddress": "bastion.example.test",
    "ServerPort": "2222",
    "ServerUser": "sshdemo",
    "Favorites": {},
    "DatabasePassword": "demo-pass",
    "ServerPassword": "",
    "DatabaseKeyPassword": "key-demo-pass"
  }
]
```
