# MongoDB Compass 1.53.0 — inventaire fonctionnel (2026-10-19)

Objectif : servir de **référence fonctionnelle** pour le support MongoDB de TableMax
(« au moins les mêmes fonctionnalités que Compass »). Ce document décrit *ce que fait* Compass,
avec assez de détail UX pour concevoir des équivalents. Il ne contient aucun code de Compass.

## 1. Sources et méthode

### Artefacts analysés
| Artefact | Identité |
|---|---|
| `mongodb-compass_1.53.0_amd64.deb` (édition standard) | SHA-256 `c3660c1f295b2c94b6f8186bfdfcb78681d489b4badb3b78e18c1f237e5de9cd` |
| `resources/app.asar` (standard) | SHA-256 `256eb3dcbdf5a2cf23b5fc4191da06f73f41211bd04fe39ff21fecc5acf11a1c` |
| Binaire `MongoDB Compass` (Electron 44.7.0, ELF) | SHA-256 `10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564` |
| `mongodb-compass-readonly_1.53.0_amd64.deb` (édition readonly, release GitHub v1.53.0) | SHA-256 `6b1c356f68d0f0bfe5f8516cb4b38684872ad221a2bdd865ce40677fe76cd93b` |

`package.json` : version `1.53.0`, `electronVersion` 44.7.0, `channel` stable, licence SSPL.
L'application est un bundle webpack : `build/main.js` (process principal, ~4,7 Mo),
`build/index-*.renderer.js` (UI ; l'essentiel des plugins est dans
`index-0b9a48a6…renderer.js`, la gestion bases/collections dans `index-5d3f7ed2…`),
`build/42.js` (menus Electron, auto-update), plus des chunks vendor (mongosh, driver Node,
ssh2, faker, TypeScript, CodeMirror, client OIDC…).

### Plugins embarqués (noms de paquets trouvés dans le bundle)
`compass-connections`, `compass-connection-import-export`, `compass-sidebar`,
`compass-databases-collections`, `compass-collection`, `compass-crud`, `compass-query-bar`,
`compass-aggregations`, `compass-saved-aggregations-queries` (« My Queries »),
`compass-schema`, `compass-schema-validation`, `compass-indexes`, `compass-explain-plan`,
`compass-import-export`, `compass-export-to-language`, `compass-serverstats` (Performance),
`compass-shell`, `compass-field-store`, `compass-find-in-page`, `compass-settings`,
`compass-workspaces`, `compass-welcome`, `compass-data-modeling`, `compass-generative-ai`,
`compass-assistant`, `compass-global-writes`, `compass-intercom`, `compass-telemetry`,
`compass-electron-menu`, `compass-app-stores`, `compass-components`, `compass-logging`.

### Méthode
- Extraction des deux `.deb` (`ar` + `tar`) et des `app.asar` (`@electron/asar extract`) dans
  le scratchpad. **L'application n'a jamais été lancée.**
- REA : `analyze_javascript_application` (summary) sur `app.asar` (evidence
  `ev_aa24227d19cb52f81e56cf9e930cd4e815c4f5ac70924441e30e8d39155ebc00` ; analyse
  sémantique limitée à `package.json`, `build/main.js`, `build/index.html`, inventaire complet de
  l'artefact) ; `inspect_electron_fuses` sur le binaire (evidence
  `ev_31ddb6b74a935fc184daccaf6aff2c8bca321b0cca501bed6eb3bf6cc1f76b4a` : RunAsNode activé,
  NodeCliInspectArguments activé, intégrité ASAR et OnlyLoadAppFromAsar désactivés).
- Analyse statique au shell : extraction des définitions de préférences (`main.js`), des feature
  flags, des menus (`42.js`), et de toutes les chaînes `label`/`title`/`description`/
  `placeholder`/textes enfants des composants React, dans l'ordre du code (ce qui regroupe les
  libellés par écran). Contrôles ciblés du code (gating `readOnly`, listes d'options, raccourcis).
- Diff octet-à-octet standard vs readonly (voir § 1.1).
- Tout ce qui est décrit ci-dessous est **observé dans le code livré** (libellés, options,
  conditions) ; le comportement à l'exécution est **inféré** de ce code, pas observé.

### Licence
Compass est sous SSPL ; TableMax est GPL. Ce document ne reprend que des noms de
fonctionnalités, d'options MongoDB et de courts libellés d'UI nécessaires à la description.
Aucun code, asset, icône ou texte long n'est à réutiliser : TableMax doit être réécrit de zéro.

### 1.1 Édition readonly : ce qu'elle est réellement
- `package.json` déclare trois distributions : `compass`, `compass-readonly` (`readonly: true`)
  et `compass-isolated` (`isolated: true`).
- Le diff des deux builds montre que **le code est identique** ; seules changent des constantes
  injectées au build (`HADRON_DISTRIBUTION`, `HADRON_PRODUCT[_NAME]`, `HADRON_READONLY:"true"`),
  le nom du raccourci Windows et le nom du canal d'auto-update (`compass-readonly`).
- Au démarrage, `main.js` transforme `HADRON_READONLY=true` en préférence **figée** (hardcoded)
  `readOnly = true` (et `HADRON_ISOLATED=true` en `networkTraffic = false` pour l'édition
  Isolated). Dans Settings, l'option apparaît verrouillée (message « cannot be modified … »).
- Préférences dérivées de `readOnly` (fonctions `deriveValue`) :
  `readWrite` → vrai, `enableShell` → faux, `enableDevTools` → faux.
- L'édition readonly est donc exactement « Compass + Settings › Set Read-Only Mode forcé ».
  Les marqueurs « RO » ci-dessous viennent des conditions `readOnly` / `readWrite` /
  `hasWriteActionsDisabled` / `isWritable` trouvées dans le code.

Légende colonne **RO** : **Oui** = conservé dans l'édition readonly ; **Non** = retiré ou désactivé ;
**Partiel** = conservé mais amputé ; **?** = pas de condition trouvée, non vérifié à l'exécution.

À noter : Compass a aussi un **mode Read-Write** (préférence `readWrite`, « Set Read-Write
Mode ») intermédiaire : lecture/écriture de données autorisée, mais sans renommer/supprimer de
namespaces ni gérer les index. Bon modèle pour un « safe mode » TableMax à trois niveaux.

---

## 2. Inventaire par domaine

### 2.1 Connexions

#### Formulaire de connexion (modal « New Connection » / « Edit Connection »)
Structure : champ **URI** en haut (chaîne de connexion éditable, masquable), puis
« Advanced Connection Options » en 6 onglets : **General, Authentication, TLS/SSL, Proxy/SSH,
In-Use Encryption, Advanced**. Le formulaire et l'URI sont synchronisés en permanence (chaque
champ modifie un paramètre de l'URI). Si l'URI est invalide, le formulaire est désactivé
(« The connection form is disabled when the connection string cannot be parsed »).
Pied : **Cancel / Save / Connect** (Save & Connect). Panneau d'aide à droite (« How do I find my
connection string in Atlas? », « How do I format my connection string? »).
Bloc de personnalisation : **Name**, **Color** (10 couleurs + « No Color »), case
« Favorite this connection » (épingle en haut de la liste).
Connexion active : seuls nom/couleur/favori sont éditables (« While connected, you may only
personalize… »).

| ID | Élément | Détail | RO |
|---|---|---|---|
| C1 | URI éditable | Champ texte `mongodb://` / `mongodb+srv://`. Si « Protect Connection String Secrets » est actif, l'édition demande une confirmation (« Editing this connection string will reveal your credentials ») et les options avancées sont cachées. | Oui |
| C2 | General › Connection String Scheme | `mongodb` (standard) ou `mongodb+srv` (DNS seed list), avec explications. | Oui |
| C3 | General › Hosts | Liste d'hôtes `host:port` (ajout/suppression ; un seul hôte en +srv). | Oui |
| C4 | General › Direct Connection | Case « force dispatch all operations to the specified host ». | Oui |
| C5 | Auth › Username/Password | Username, Password (optionnels), Authentication Database, Authentication Mechanism : Default / SCRAM-SHA-1 / SCRAM-SHA-256. | Oui |
| C6 | Auth › OIDC (`MONGODB-OIDC`) | Username ; options : Auth Code Flow Redirect URI ; « Consider Target Endpoint Trusted » ; « Use ID token instead of Access Token » ; « Send a nonce in the Auth Code Request » ; « Use Application-Level Proxy Settings » ; « Enable Device Authentication Flow » (visible si préférence `showOIDCDeviceAuthFlow`). Flux : ouverture du navigateur (commande configurable `browserCommandForOIDCAuth`), modale « Complete authentication in the browser » avec URL + code pour le device flow ; jetons persistables (`persistOIDCTokens`) et purgeables. | Oui |
| C7 | Auth › X.509 (`MONGODB-X509`) | Username optionnel ; exige un certificat client configuré dans l'onglet TLS/SSL. | Oui |
| C8 | Auth › Kerberos (`GSSAPI`) | Principal, Service Name, Canonicalize Host Name (None / Forward / Forward and reverse), Service Realm, « Provide password directly » + Password (visible si `showKerberosPasswordField`). | Oui |
| C9 | Auth › LDAP (`PLAIN`) | Username, Password. | Oui |
| C10 | Auth › AWS IAM (`MONGODB-AWS`) | AWS Access Key Id, AWS Secret Access Key, AWS Session Token (tous optionnels → chaîne d'identifiants AWS de l'environnement). | Oui |
| C11 | TLS/SSL | « SSL/TLS Connection » : Default / On / Off ; Certificate Authority (.pem) (sélecteur de fichier) ; Client Certificate and Key (.pem) ; Client Key Password ; cases `tlsInsecure`, `tlsAllowInvalidHostnames`, `tlsAllowInvalidCertificates` avec descriptions. Avertissement « TLS/SSL is disabled… ». CA système chargées nativement (module `system-ca`). | Oui |
| C12 | Proxy/SSH › SSH with Password | SSH Hostname, SSH Port, SSH Username, SSH Password. Tunnel via ssh2 + proxy Socks5 local. | Oui |
| C13 | Proxy/SSH › SSH with Identity File | SSH Hostname, Port, Username, SSH Identity File (fichier), SSH Passphrase. | Oui |
| C14 | Proxy/SSH › Socks5 | Proxy Hostname, Proxy Tunnel Port, Proxy Username, Proxy Password (avertissement : mot de passe Socks5 en clair). | Oui |
| C15 | Proxy/SSH › Application-level Proxy | Réutilise le proxy global défini dans Settings (voir P8). | Oui |
| C16 | In-Use Encryption (CSFLE / Queryable Encryption) | Key Vault Namespace (`db.coll`) ; KMS Providers multiples et nommés (ajout/renommage/suppression) : **Local KMS** (clé 96 octets base64, bouton « Generate Random Key »), **AWS** (Access Key ID, Secret Access Key, Session Token, Endpoint), **GCP** (Service Account E-Mail, Private Key, Endpoint), **Azure** (Tenant ID, Client ID, Client Secret, Identity Platform Endpoint), **KMIP** (Endpoint + TLS par KMS) ; état « Incomplete / Fully configured » par KMS ; « Store KMS provider secrets » (stockage disque protégé par le trousseau OS, sinon oubli à la déconnexion) ; éditeurs EncryptedFieldsMap et SchemaMap (debug). Nécessite `mongodb-client-encryption` (+ `mongo_crypt` shared lib). | Oui |
| C17 | Advanced › Read Preference | Primary, Primary Preferred, Secondary, Secondary Preferred, Nearest ; **Read Preference Tags** (ensembles ordonnés clé/valeur) ; Max Staleness Seconds (min 90). | Oui |
| C18 | Advanced › Replica Set Name, Default Authentication Database | Champs texte. | Oui |
| C19 | Advanced › URI Options | Table clé/valeur libre groupée : Connection Timeout (`connectTimeoutMS`, `socketTimeoutMS`), Compression (`compressors`, `zlibCompressionLevel`), Pool (`maxPoolSize`, `minPoolSize`, `maxIdleTimeMS`, `waitQueueMultiple`, `waitQueueTimeoutMS`), Write Concern (`w`, `wtimeoutMS`, `journal`), Read Concern (`readConcernLevel`), Server (`localThresholdMS`, `serverSelectionTimeoutMS`, `serverSelectionTryOnce`, `heartbeatFrequencyMS`), Misc (`appName`, `retryReads`, `retryWrites`, `srvMaxHosts`, `uuidRepresentation`, `enableUtf8Validation`). | Oui |
| C20 | Avertissements de forme | Validation inline (ex. tags de read preference interdits avec `primary`, proxy distant avec hôte local). | Oui |

#### Gestion des connexions
| ID | Élément | Détail | RO |
|---|---|---|---|
| C21 | Liste latérale des connexions | Toutes les connexions sauvegardées ; favorites épinglées en tête ; recherche « Search connections » ; filtre « Show only active connections » ; « Collapse all connections ». Pas de liste « Recents » séparée observée dans cette version (une connexion utilisée est enregistrée). | Oui |
| C22 | Actions sur une connexion | Connect, Connect « In New Window », Edit connection, Copy connection string, Favorite/Unfavorite, Duplicate connection, Remove connection, Show connection info, Refresh databases, Disconnect, Open MongoDB shell, View performance metrics, Create database. | Partiel (Create database et shell retirés) |
| C23 | Couleurs | 10 couleurs prédéfinies + aucune, affichées sur l'arbre et les onglets. | Oui |
| C24 | Connexions simultanées | Plusieurs connexions actives dans la même fenêtre (arbre multi-connexions) ; limite configurable `maximumNumberOfActiveConnections` (modale « Maximum concurrent connections limit reached »). | Oui |
| C25 | Multi-fenêtres | Menu Window › New Window (Ctrl/Cmd+N) ; « Connect in New Window » (`enableConnectInNewWindow`). | Oui |
| C26 | Import / Export de connexions | Menu Connections › Import/Export Saved Connections et boutons de la sidebar. Export : sélection des connexions, fichier cible, « Remove Secrets », mot de passe de chiffrement optionnel des secrets. Import : fichier source, mot de passe de déchiffrement, sélection, avertissement d'écrasement des existantes. Aussi en ligne de commande (`--exportConnections`, `--importConnections`, `--passphrase`). | Oui |
| C27 | Stockage des secrets | Secrets chiffrés via `safeStorage` Electron (trousseau OS) ; message de repli « Compass cannot access credential storage… passwords will not be saved ». | Oui |
| C28 | Connexion automatique CLI | Arguments positionnels (URI ou ID de connexion), `--file` (liste de connexions), `--username`, `--password`, `--trustedConnectionString`. Gestionnaire d'URL `mongodb://` et `mongodb+srv://` (`installURLHandlers`). | Oui |
| C29 | Détections à la connexion | « Non-Genuine MongoDB Detected » (CosmosDB/DocumentDB…), « End-of-life MongoDB Detected » (version serveur), info topologie (Standalone, Replica Set with/without Primary, Sharded Cluster, Load Balancer), Atlas Stream Processing refusé. Réauthentification demandée si la session expire (« Authentication expired »). | Oui |
| C30 | Politique de connexion | `forceConnectionOptions` (forcer des paramètres d'URI), `protectConnectionStrings`, `protectConnectionStringsForNewConnections`, paquet `connection-string-policy`. | Oui |

### 2.2 Navigation (arbre, bases, collections, vues)

| ID | Élément | Détail | RO |
|---|---|---|---|
| N1 | Arbre latéral « Databases and Collections » | Connexion › bases › collections/vues, chargement paresseux, filtre de recherche, badges (vue, time-series…). Option `inferNamespacesFromPrivileges` : ajoute les namespaces déduits des rôles/privilèges (marqués « Your privileges grant you access to this namespace, but it might not currently exist »). | Oui |
| N2 | Onglet « Databases » (par connexion) | Liste/grille : Database name, Storage size, Data size, Collections, Indexes ; boutons Create database, Refresh ; état vide « Looks like your cluster is empty ». | Partiel (pas de Create/Delete) |
| N3 | Onglet « Collections » (par base) | Collection name, Properties (badges), Storage size (Used/Free au survol), Data size, Documents, Avg. document size, Indexes, Total index size ; time-series : Bucket count / Avg. bucket size ; vues : « Derived from ». Stats dbStats/collStats désactivables (`enableDbAndCollStats`). | Partiel |
| N4 | Créer une base | Modal Database Name + Collection Name (obligatoire) + options de collection (N6). | Non |
| N5 | Créer une collection | Modal Collection Name + « Additional preferences ». | Non |
| N6 | Options de création | **Time-Series** (timeField, metaField, granularity seconds/minutes/hours, bucketMaxSpanSeconds, bucketRoundingSeconds, expireAfterSeconds) ; **Clustered Collection** (nom de l'index clusterisé, expireAfterSeconds) ; **Queryable Encryption** (Encrypted fields JSON, KMS Provider, Key Encryption Key) ; **Use Custom Collation** (locale — ~150 locales ICU avec variantes —, strength, caseLevel, caseFirst, numericOrdering, alternate, maxVariable, backwards, normalization). Les options capped (`capped`, `size`, `max`) ne sont pas apparues dans les libellés extraits de cette build (voir § Inconnues). | Non |
| N7 | Drop database / collection / view | Confirmation par saisie du nom (« Drop {type}? »). | Non |
| N8 | Rename collection | Modal avec avertissements (perte de requêtes non sauvegardées, requêtes enregistrées à remapper). | Non |
| N9 | Vues | Ouvrir, « Duplicate view », « Modify view » (rouvre le pipeline source dans l'éditeur d'agrégation : « Edit Pipeline » / « Update view » / « Return to View »), « Drop view ». Avertissements si des index de recherche existent sur la vue. | Partiel (lecture seule) |
| N10 | Ouvrir dans un nouvel onglet | Menu contextuel « Open in new tab ». | Oui |
| N11 | En-tête de collection | Nom, badges READ-ONLY / Time-Series / View / Queryable Encryption / CLUSTERED, boutons « Open Shell », « Visualize Your Data » (Atlas Charts), lien vers la vue source. | Partiel (pas de shell) |
| N12 | Onglets de collection | Documents, Aggregations, Schema, Indexes, Validation, (Global Writes : Atlas uniquement). | Oui |

### 2.3 Onglet Documents (CRUD)

#### Barre de requête (query bar)
| ID | Élément | Détail | RO |
|---|---|---|---|
| D1 | Filter | Éditeur document (CodeMirror) avec autocomplétion des champs (field store alimenté par les documents/schéma) et opérateurs ; placeholder « Type a query: { field: 'value' } ». Boutons Find, Reset, Explain, Options (déplie le reste), Export Code. | Oui |
| D2 | Options | **Project**, **Sort** (document ou tableau de paires), **Collation**, **Index Hint** (document ou nom d'index), **Skip**, **Limit**, **Max Time MS** (plafonné par les préférences `maxTimeMS` et `maxTimeMSEnvLimit`). | Oui |
| D3 | Tri par défaut | Préférence `defaultSortOrder` : MongoDB server default, `_id: 1`, `_id: -1`, `$natural: -1` (avertissement production). | Oui |
| D4 | Historique des requêtes | Panneau « Query History » : **Recents** et **Favorites** par namespace ; Favorite (nommer), Copy Query to Clipboard, Delete, Open in Modal, appliquer. Stocké localement (`RecentQueries`, `FavoriteQueries`). Les requêtes de type « update » (bulk update favorisé) ne peuvent pas être appliquées en readonly. | Partiel |
| D5 | Requête en langage naturel (IA) | « Generate query » : prompt texte → filtre/projection/tri/skip/limit ou bascule vers un pipeline si nécessaire ; feedback +/- ; envoie optionnellement des valeurs d'exemple (`enableGenAISampleDocumentPassing`). Service distant MongoDB, opt-in requis. | Oui (si réseau/opt-in) |
| D6 | Explain depuis la query bar | Ouvre le plan d'exécution (voir 2.6). | Oui |

#### Affichage
| ID | Élément | Détail | RO |
|---|---|---|---|
| D7 | Vues de documents | 3 vues : **List** (arbre de champs dépliable avec types), **E-JSON View** (JSON étendu), **Table View** (grille, navigation dans les sous-documents/tableaux par fil d'Ariane). | Oui |
| D8 | Pagination | Taille de page 25 / 50 / 75 / 100 ; Previous/Next ; compteur « x – y of N » avec comptage asynchrone (« Fetching document count… », bouton refresh, N/A si timeout). | Oui |
| D9 | Expand/collapse | « Expand all documents » / « Collapse all documents » ; dépliage par champ ; « Show N more fields ». | Oui |
| D10 | Affichage des types BSON | Rendu typé : ObjectId, Date (fuseau configurable `timezone`), Int32/Int64/Double/Decimal128, String, Binary, UUID (+ encodages legacy Java/C#/Python via `legacyUUIDDisplayEncoding`), RegExp, Code, MinKey/MaxKey, Timestamp, DBRef, champs chiffrés (« Encrypted Field »). Avertissement entiers hors plage sûre (« Convert to Long »). | Oui |
| D11 | Menu contextuel de champ | Add to query / Remove from query (ajoute le champ+valeur au filtre), Copy value, Copy field & value, Open URL in browser, Expand/Collapse field items. | Oui |
| D12 | Copier un document | « Copy document as Shell Syntax » ou « as EJSON ». | Oui |
| D13 | Insights | Signaux contextuels : « Query executed without index », « $lookup usage », « Possibly bloated document », « Large array detected », « High number of indexes », « Databases with too many collections », alternatives Atlas Search. | Oui |

#### Écriture
| ID | Élément | Détail | RO |
|---|---|---|---|
| D14 | Insérer | « Add data › Insert document » : modal avec éditeur **EJSON** (document ou tableau pour multi-insert, `_id` auto) ou **Visual editor** (champ par champ, type par champ ; indisponible pour plusieurs documents) ; conversion EJSON → syntaxe shell proposée ; info chiffrement CSFLE. | Non |
| D15 | Éditer | Édition en place (List/Table) : renommer clé, changer valeur, **changer le type** (Array, Binary, Boolean, Code, Date, Decimal128, Double, Int32, Int64, MaxKey, MinKey, Null, Object, ObjectId, BSONRegExp, String, Symbol, Timestamp, Undefined, UUID…), ajouter champ après, supprimer champ, annuler modif (Revert), éditeurs dédiés (Date, String, Decimal128, Double, Int32, Int64, Null, Undefined, ObjectId, UUID) ; ou édition JSON complète. Update via `findOneAndReplace`/update avec détection de conflit. | Non |
| D16 | Cloner | « Clone document… » ouvre l'insert pré-rempli sans `_id`. | Non |
| D17 | Supprimer | Marquage puis confirmation par document. | Non |
| D18 | Bulk update | « Update documents » : éditeur d'update (opérateurs ou pipeline) appliqué au filtre courant, **prévisualisation** avant/après sur 3 documents, sauvegarde comme requête favorite dans My Queries. Nécessite pas de skip/limit. | Non |
| D19 | Bulk delete | Confirmation avec aperçu d'un échantillon et nombre de documents supprimés. | Non |
| D20 | Générateur de données factices (IA) | « Generate mock data script » : analyse du schéma, mappage faker par IA, aperçu, nombre de documents et taille estimée, génère un script mongosh+faker à exécuter soi-même. | Non |
| D21 | Ajout de données | « Import JSON or CSV file » depuis l'état vide ou le menu Add data. | Non |

### 2.4 Agrégations

| ID | Élément | Détail | RO |
|---|---|---|---|
| A1 | Builder par étapes (Stages) | Cartes d'étapes : opérateur (combobox avec description, filtré par version serveur, type de namespace — collection, vue, time-series — et environnement), éditeur de corps avec snippet commenté (« Comment Mode »), activer/désactiver une étape, supprimer, ajouter avant/après, déplacer (drag & drop), replier. | Partiel ($out/$merge retirés) |
| A2 | Mode texte | Bascule Stages ↔ Text (pipeline complet en un seul éditeur), conversion bidirectionnelle avec gestion des erreurs de syntaxe. | Oui |
| A3 | Prévisualisations | Aperçu des documents en sortie de chaque étape (Auto Preview activable), nombre d'exemples configurable (« Number of Preview Documents », défaut 10), « Limit » d'entrée avant `$group/$bucket/$bucketAuto` (préférence `enableAggregationBuilderExtraOptions`). Vue des résultats en liste ou JSON. | Oui |
| A4 | Focus Mode | Une étape en plein écran : Stage Input / éditeur / Stage Output ; raccourcis Mod+Shift+9 / Mod+Shift+0 (étape précédente/suivante), Mod+Shift+A / Mod+Shift+B (ajouter étape après/avant). | Oui |
| A5 | Stage Wizard | Assistant de cas d'usage par formulaire : match (conditions AND/OR imbriquées, max 3 niveaux), group simple, group avec statistiques (accumulateurs), group avec sous-ensemble (First/Last/Top/Bottom N), project (Include/Exclude), sort, lookup (collection/champ local/champ distant/nom du tableau), text search (`$search`, fuzzy maxEdits, index) ; génère l'étape. | Oui |
| A6 | Options du pipeline | Collation, Max Time MS ; Settings (Comment Mode, nombre de documents d'aperçu, limite). | Oui |
| A7 | Exécuter | « Run » avec résultats paginés ; confirmation « A write operation will occur » si `$out`/`$merge` ; persistance des résultats (« Go to collection »). Désactivable (`enableAggregationBuilderRunPipeline`). | Partiel |
| A8 | Explain du pipeline | Plan d'exécution de l'agrégation (voir 2.6) + « Interpret » IA. | Oui |
| A9 | Pipelines sauvegardés | Save / Save as (nom), liste « Saved Pipelines in {namespace} » (ouvrir, supprimer), indicateur « modified », nouveau pipeline avec confirmation. Stocké localement (`SavedPipelines`). | Oui |
| A10 | Créer une vue | « Create view » depuis le pipeline courant (nom) ; mettre à jour une vue existante. | Non |
| A11 | Export des résultats | « Export pipeline results » vers JSON/CSV (via 2.10). | Oui |
| A12 | Export Code | Pipeline vers un langage (voir 2.12). | Oui |
| A13 | Génération IA de pipeline | Prompt (« Tell us what aggregation to build… » ou pipeline dans un autre langage, ex. SQL). | Oui (si réseau/opt-in) |
| A14 | Étapes Atlas | `$search`, `$searchMeta`, `$vectorSearch`, `$rerank` (flag), messages « Atlas only », limites de débit Voyage. | Oui |

### 2.5 Analyse de schéma

| ID | Élément | Détail | RO |
|---|---|---|---|
| S1 | Échantillonnage | « Analyze schema » sur le filtre/projection courant de la query bar, échantillon de **1 000 documents** max (ou la limite de la requête si plus petite), `maxTimeMS` respecté, annulable ; message « This report is based on a sample of N documents ». | Oui |
| S2 | Champs et types | Arbre des champs (y compris imbriqués, « Expand/Collapse Document Schema »), fréquence de présence, répartition des types (barre de types), valeurs d'exemple (« Refresh sample values »), « mixed data types ». | Oui |
| S3 | Graphiques | Par type : histogrammes numériques/dates, valeurs uniques fréquentes pour les chaînes, booléens, longueurs de tableaux (min/moyenne/max), sous-documents ; carte géographique pour coordonnées/GeoJSON (tuiles `compass-maps.mongodb.com`, désactivable via `enableMaps`). Sélection d'une valeur/plage → construit le filtre de la query bar. | Oui |
| S4 | Export du schéma | « Export Schema » : 3 formats — **Standard** (JSON Schema), **MongoDB** (`$jsonSchema` avec types BSON), **Expanded** (analyse détaillée) — copie ou fichier. Ancien « Share Schema as JSON (Legacy) » (menu Collection, Alt+Ctrl/Cmd+S). | Oui |
| S5 | Avertissement de désynchronisation | « The schema content is outdated… Press Analyze again ». | Oui |

### 2.6 Explain plan

| ID | Élément | Détail | RO |
|---|---|---|---|
| E1 | Modal Explain Plan | Pour find et aggregate ; « Query Performance Summary » : documents returned, documents examined, execution time, sorted in memory (oui/non), index keys examined, index(es) used (ou « No index available for this query »). | Oui |
| E2 | Visual Tree | Arbre des étapes (IXSCAN, FETCH, SORT…) avec métriques par étape, zoom in/out ; repli sur la sortie brute si non supporté. | Oui |
| E3 | Raw Output | JSON complet de `explain` (executionStats). | Oui |
| E4 | Interpret (IA) | Envoie le plan à l'assistant pour une explication en langage naturel. | Oui (si réseau/opt-in) |

### 2.7 Index

| ID | Élément | Détail | RO |
|---|---|---|---|
| I1 | Liste des index | Colonnes Name & Definition, Type (regular, compound, text, 2dsphere, hashed, wildcard, columnstore, clustered, TTL…), Size, **Usage** (`$indexStats` : nombre d'utilisations et date), Properties (unique, sparse, partial, TTL, collation, hidden…), Status (Ready, Building avec progression, In Progress, Creating, Failed). Recherche « Find by index name », Refresh. | Oui |
| I2 | Créer un index | Champs (nom + type : `1 (asc)`, `-1 (desc)`, `2dsphere`, `text`, `columnstore`), ajout/suppression de champs ; options : Create unique index, Index name, Create TTL (secondes), Partial Filter Expression, Wildcard Projection, Use Custom Collation, Columnstore Projection (Preview), Create sparse index, Build in rolling process (Atlas). | Non |
| I3 | Drop / Cancel | Supprimer un index (confirmation par saisie) ; annuler un index en cours de construction ; supprimer un index échoué. | Non |
| I4 | Hide / Unhide | Masquer/démasquer un index (serveur ≥ 4.4). | Non |
| I5 | Index Atlas Search / Vector Search | Liste (nom, type, statut, queryable), création/édition en JSON avec templates (Search ou Vector Search, embeddings automatiques ou fournis), Drop, Aggregate (ouvre un pipeline `$search`). Disponible sur Atlas et déploiements Atlas locaux ≥ 6.0.7/7.0 ; préférence `enableAtlasSearchIndexes`. | Partiel (lecture seule) |
| I6 | Index roulants | Création « rolling » et listing via l'API Atlas (cluster Atlas uniquement). | Non |

### 2.8 Validation de schéma

| ID | Élément | Détail | RO |
|---|---|---|---|
| V1 | Lecture des règles | Affichage du validateur JSON (`$jsonSchema` ou opérateurs de requête). | Oui |
| V2 | Édition | « Edit rules » : éditeur JSON avec autocomplétion, **Validation Action** (Warning / Error / Error and Log selon version), **Validation Level** (Off / Moderate / Strict), Apply avec confirmation. | Non |
| V3 | Génération | « Generate rules » à partir d'un échantillon de 1 000 documents (option effacer les règles existantes). | Non |
| V4 | Aperçu | « Preview sample documents » : un document qui passe et un qui échoue la validation. | Oui |
| V5 | Restrictions | Indisponible pour vues, time-series, serveurs < 3.2, collections en lecture seule. | — |

### 2.9 Données : opérations serveur

| ID | Élément | Détail | RO |
|---|---|---|---|
| O1 | Onglet Performance (serverstats) | Graphes temps réel (fenêtre 60 points) : **operations** (insert, query, update, delete, command, getmore), **read & write** (active/queued reads/writes via globalLock), **network** (bytes in/out + connexions), **memory** (vsize, resident, mapped). Bouton Pause. Avertissements mongos (`top` indisponible). | Oui |
| O2 | Hottest Collections | Collections les plus actives (commande `top`, % lecture/écriture). | Oui |
| O3 | Slowest Operations | Liste issue de `currentOp`, détail d'une opération (opid, client, active, wait lock, JSON brut). | Oui |
| O4 | Kill Op | Bouton « Kill Op » dans le détail d'une opération (`killOp`). Aucune condition `readOnly` trouvée sur ce bouton. | ? (probablement Oui) |

### 2.10 Import / Export de données

| ID | Élément | Détail | RO |
|---|---|---|---|
| X1 | Import JSON | Fichier JSON (document, tableau ou JSON lines), « Stop on errors », journal d'erreurs, compteur de progression, annulation, alertes post-import (documents volumineux, tableaux non bornés). Un seul import à la fois. | Non |
| X2 | Import CSV | Délimiteur (Comma, Tab, Semicolon, Space, auto-détecté), « Ignore empty strings », « Stop on errors », détection des types ligne par ligne (« Detecting field types », Skip), tableau « Specify Fields and Types » : inclure/exclure chaque colonne, type par colonne (Int32, Long, Double, Decimal128, Boolean, Date, String, Null, ObjectId, Binary, UUID, MD5, Timestamp, RegExp, MinKey, MaxKey, EJSON, Number, Mixed…), aperçu des premières lignes, notation pointée → sous-documents, colonnes `a[0]` → tableaux. | Non |
| X3 | Export | Source : résultats de la requête courante (avec filtre/projection/tri) ou collection entière, ou résultats d'agrégation. Sélection des champs (« Select Fields » depuis un échantillon, ajout manuel, all/none) ou projection de la requête. Format **JSON** (Default / Relaxed / Canonical Extended JSON) ou **CSV** (« Escape formulae in data », tableaux aplatis ; avertissement perte de types). Progression, annulation. | Oui |
| X4 | Préférence | `enableImportExport`. | — |

### 2.11 Shell intégré (mongosh)

| ID | Élément | Détail | RO |
|---|---|---|---|
| H1 | Panneau `>_MONGOSH` | mongosh complet (worker thread `@mongosh/node-runtime-worker-thread`) connecté à la connexion de l'onglet, en bas de l'espace de travail, redimensionnable, onglet shell dédié par connexion (« Open MongoDB shell »). | Non (désactivé par dérivation) |
| H2 | Raccourcis du shell | Ctrl+A/E (début/fin de ligne), Ctrl+B/F (caractère), Ctrl+C (stopper la commande), Ctrl+D (supprimer), Ctrl+H (backspace), Mod+L (effacer l'écran), Ctrl+T (permuter), Ctrl+U (majuscules), flèches haut/bas (historique) ; panneau « Shell Info » avec la table des raccourcis. | Non |
| H3 | Thème | `shellFollowsCompassTheme` (sinon toujours sombre). | — |

### 2.12 Export vers un langage

| ID | Élément | Détail | RO |
|---|---|---|---|
| L1 | « Export Code » (requête ou pipeline) | Source en syntaxe Shell ; cible : **Java, Node, C#, Python, Ruby, Go, Rust, PHP** ; options « Include Import Statements », « Include Driver Syntax », « Use Builders » (Java) ; copie. Fonctionne aussi pour bulk update/delete (« Update Query », « Delete Query »). Transpileur local (bson-transpilers). | Oui |

### 2.13 Préférences, raccourcis, espace de travail

#### Settings (fenêtre « Settings », Ctrl/Cmd+,)
Sections : General, Theme, Privacy, Proxy Configuration, OIDC, Artificial Intelligence, Feature
Preview. Chaque réglage peut être figé par la ligne de commande, le fichier de configuration
global ou l'édition (messages dédiés). Options CLI : `--help`, `--version`, `--versions`,
`--showExampleConfig`, `--ignoreAdditionalCommandLineFlags`, et la plupart des préférences.

| ID | Préférence (clé) | Effet | RO |
|---|---|---|---|
| P1 | `readOnly` « Set Read-Only Mode » | Supprime toute écriture (voir § 1.1). | figé à vrai |
| P2 | `readWrite` « Set Read-Write Mode » | Écriture de données seulement ; pas de rename/drop de namespaces ni d'édition d'index. | dérivé vrai |
| P3 | `enableShell`, `shellFollowsCompassTheme` | Shell intégré. | dérivé faux |
| P4 | `enableDbAndCollStats` | Active/désactive dbStats/collStats. | Oui |
| P5 | `defaultSortOrder`, `maxTimeMS`, `maxTimeMSEnvLimit` | Tri par défaut, plafond de temps des opérations. | Oui |
| P6 | `timezone`, `legacyUUIDDisplayEncoding` | Fuseau d'affichage des dates (stockage toujours UTC) ; affichage UUID legacy (raw / Java / C# / Python). | Oui |
| P7 | `theme` | Light / Dark / Sync with OS. | Oui |
| P8 | `proxy` | No Proxy / System Proxy / Manual Configuration (URL `http://`, `https://`, `socks5://`, `pac+https://`, utilisateur, mot de passe, « Excluded hosts »). | Oui |
| P9 | OIDC | `showOIDCDeviceAuthFlow`, `browserCommandForOIDCAuth`, `persistOIDCTokens`. | Oui |
| P10 | `showKerberosPasswordField` | Affiche le champ mot de passe Kerberos. | Oui |
| P11 | `protectConnectionStrings`, `protectConnectionStringsForNewConnections` | Masquage des secrets d'URI. | Oui |
| P12 | `networkTraffic`, `trackUsageStatistics`, `enableFeedbackPanel`, `autoUpdates`, `enableMaps` | Réseau hors base : télémétrie Segment, Intercom, mises à jour, cartes. | Oui |
| P13 | `enableGenAIFeatures`, `optInGenAIFeatures`, `enableGenAISampleDocumentPassing`, `enableGenAIToolCalling` | Fonctions IA. | Oui |
| P14 | `enableImportExport`, `enableExplainPlan`, `enableAggregationBuilderRunPipeline`, `enableAggregationBuilderExtraOptions`, `enableAtlasSearchIndexes`, `enableMyQueries`, `inferNamespacesFromPrivileges` | Interrupteurs de fonctionnalités. | Oui |
| P15 | `maximumNumberOfActiveConnections`, `enableShowDialogOnQuit`, `installURLHandlers`, `enableDevTools`, `forceConnectionOptions` | Divers. | `enableDevTools` dérivé faux |
| P16 | Feature flags (Feature Preview) | `enableRollingIndexes`, `enableGlobalWrites`, `enableAIAssistant`, `enableToolCalling`, `enableMockDataGenerator`, `enableRerank` (released) ; `enableAutoEmbedding*`, `enableSortedSearchIndexes` (preview) ; `enableSkillsInAssistant`, `enableRestoreWorkspaces`, `enableCompassWebSettings` (development, cachés sauf `showDevFeatureFlags`). | Oui |

#### Raccourcis clavier observés
| Contexte | Raccourci | Action |
|---|---|---|
| Application | Ctrl/Cmd+, | Settings |
| | Ctrl/Cmd+N | Nouvelle fenêtre |
| | Ctrl/Cmd+Q | Quitter (confirmation optionnelle) |
| | Ctrl/Cmd+F | Find in page (Entrée / Maj+Entrée pour naviguer) |
| | Ctrl/Cmd+R | Reload Data (rafraîchit les données) |
| | Ctrl/Cmd+Shift+R | Reload (fenêtre) |
| | Ctrl/Cmd+0 / = / - | Zoom reset / in / out |
| | Alt+Ctrl/Cmd+I | Toggle DevTools (si activé) |
| | F1 | Aide en ligne |
| | Alt+Ctrl/Cmd+S | Share Schema as JSON (Legacy) |
| Éditeurs (CodeMirror) | Ctrl+Shift+B | Format (prettify) |
| | Ctrl+Shift+C | Copier tout le contenu |
| Agrégation (Focus Mode) | Mod+Shift+9 / Mod+Shift+0 | Étape précédente / suivante |
| | Mod+Shift+A / Mod+Shift+B | Ajouter une étape après / avant |
| Data Modeling | Mod+Z / Mod+Shift+Z ; Suppr/Retour arrière ; Échap | Annuler / rétablir ; supprimer la sélection ; quitter le mode |
| Shell | voir H2 | |

Aucun raccourci dédié aux onglets d'espace de travail (Ctrl+T/W…) n'a été trouvé dans le code.

#### Espace de travail et fenêtres
| ID | Élément | Détail | RO |
|---|---|---|---|
| W1 | Onglets d'espace de travail | Types : Welcome, Databases (connexion), Collections (base), Collection (sous-onglets), Shell, Performance, My Queries, Data Modeling. Actions : nouvel onglet, Duplicate, Close Tab, « Close all other tabs », confirmation si contenu modifié, réordonnancement. Couleur de la connexion sur l'onglet. | Oui |
| W2 | Restauration de session | « Reopen closed tabs? » après déconnexion ; restauration au démarrage derrière le flag `enableRestoreWorkspaces` (development). État stocké localement (`WorkspacesState`). | Oui |
| W3 | Menus | Compass/Settings, Connections (Import/Export), Edit (Undo/Redo/Cut/Copy/Paste/Select All/Find), View (Reload, Reload Data, zoom, DevTools), Collection (Share Schema, Import Data, Export Collection), Window, Help (aide, licence, sources, suggérer une fonctionnalité, signaler un bug, ouvrir le fichier de log, About). | Partiel (Import Data retiré) |
| W4 | My Queries | Écran listant requêtes et pipelines sauvegardés de toutes les connexions : recherche, filtre base/collection, tri (nom, dernière modification), Open (choix de la connexion/namespace si ambigu, remappage si namespace introuvable), Rename, Copy, Delete. | Oui |
| W5 | Welcome | Écran d'accueil, modal de bienvenue (télémétrie), lien Atlas. | Oui |
| W6 | Mises à jour | Vérification/téléchargement/installation (« Restart to Update »), notifications de version. | Oui |

### 2.14 Autres fonctionnalités

| ID | Élément | Détail | RO |
|---|---|---|---|
| Z1 | Data Modeling (diagrammes) | Écran « Data Modeling » : générer un diagramme depuis une connexion + base + sélection de collections ; échantillonnage configurable (taille ou tous les documents) ; **inférence automatique des relations** (requêtes sur champs indexés) ; diagramme interactif : collections (renommer, notes, supprimer, ajouter une collection vide ou depuis la base), champs (ajouter, renommer, changer le type, supprimer), relations (champ local/distant, cardinalités, notes, dessin par glisser), annuler/rétablir ; export **MDM** (fichier réimportable dans Compass/Atlas Data Explorer), **PNG**, **JSON** ; import MDM ; liste des diagrammes (recherche, renommer, supprimer). Le diagramme n'affecte pas les données. | ? (aucune condition readOnly trouvée) |
| Z2 | MongoDB Assistant (IA) | Panneau de chat (« Ask a question »), prompts suggérés par contexte, entrées « Tell me more » depuis les insights et l'explain, outils en lecture seule sur la base (find, aggregate, count, list-databases, list-collections, collection-schema, collection-indexes, collection-storage-size, db-stats, explain, mongodb-logs, get-current-query, get-current-pipeline) avec **approbation explicite** de chaque appel, débogage d'erreurs de connexion Atlas, connexion Atlas optionnelle. Service distant `knowledge.mongodb.com`. | Oui (outils en lecture seule) |
| Z3 | Global Writes | Configuration de clés de sharding géographiques sur les Atlas Global Clusters (API Atlas). | n/a (Atlas) |
| Z4 | Find in page | Recherche texte dans la vue (Ctrl/Cmd+F). | Oui |
| Z5 | Copie / presse-papiers | Copier documents, valeurs, requêtes, pipelines, chaîne de connexion. | Oui |
| Z6 | Journalisation | Fichier de log JSON (« Open Log File »), logs driver/connexion détaillés. | Oui |
| Z7 | Édition Isolated | Distribution sans aucun trafic réseau hors base (`networkTraffic=false` figé). | — |

---

## 3. Ce qui dépend d'Atlas ou du cloud

TableMax interdit la télémétrie et le contenu distant : les éléments suivants sont **à exclure**
ou à **remplacer par un équivalent local**.

| Fonction Compass | Dépendance | Piste TableMax |
|---|---|---|
| Télémétrie (Segment, clé API dans le bundle), Intercom (widget feedback), « Give Product Feedback » | `api.segment.io`, `*.intercom.io` | Exclure. |
| Auto-updates, vérification de version EOL | `compass.mongodb.com` | Exclure (mises à jour par le gestionnaire de paquets). La vérification EOL peut être faite localement via une table de versions. |
| Cartes du schéma (tuiles) | `compass-maps.mongodb.com` | Afficher les coordonnées sans fond de carte, ou carte vectorielle embarquée hors ligne. |
| Génération de requête/pipeline par IA, Interpret explain, Mock data generator, MongoDB Assistant | Services IA MongoDB (`knowledge.mongodb.com`, Atlas AI), opt-in | Exclure, ou plus tard via un fournisseur configuré explicitement par l'utilisateur (hors périmètre « no remote content »). |
| Connexion à Atlas (login, debugger d'erreurs de connexion, liens cluster overview/monitoring/query insights, Performance Advisor, « Visualize Your Data » / Atlas Charts, « Create free cluster », sample data) | `cloud.mongodb.com`, `authorize.mongodb.com` | Exclure. |
| Index roulants, Global Writes | API d'administration Atlas | Exclure. |
| Index Atlas Search / Vector Search, `$search`, `$vectorSearch`, `$rerank`, embeddings automatiques | Fonctionnalité **serveur** (Atlas ou `mongot` local) ; `$rerank`/auto-embedding passent par Voyage AI côté Atlas | Les commandes `listSearchIndexes`/`createSearchIndex` fonctionnent sur tout serveur qui les supporte (Atlas local, MongoDB 8.2+ avec mongot) : implémentable sans cloud. |
| Liens de documentation (`docs.mongodb.com`, `dochub.mongodb.org`) | Ouverture navigateur sur action utilisateur | Acceptable si ouverture explicite dans le navigateur, sinon doc embarquée. |
| OIDC | Fournisseur d'identité de l'utilisateur | Légitime (fait partie de l'authentification à la base). |
| AWS IAM / KMS (AWS, GCP, Azure, KMIP) | Services du client, requis par l'auth/le chiffrement | Légitime. |

---

## 4. Tableau récapitulatif

Complexité de reconstruction dans TableMax (Rust + React) : **S** < 1 j, **M** quelques jours,
**L** 1–3 semaines, **XL** > 3 semaines. RO = conservé dans l'édition readonly.

| Domaine | Fonctionnalité | RO | Complexité | Notes |
|---|---|---|---|---|
| Connexions | URI éditable synchronisé avec le formulaire | oui | L | Parser/sérialiser l'URI MongoDB ; crate `mongodb` côté Rust gère le parsing. |
| Connexions | Schéma mongodb / mongodb+srv, hôtes, directConnection | oui | S | |
| Connexions | Auth Username/Password + mécanismes SCRAM | oui | S | |
| Connexions | Auth OIDC (auth code + device flow, jetons persistés) | oui | L | Navigateur externe + serveur de redirection local. |
| Connexions | Auth X.509 | oui | S | Dépend du TLS client. |
| Connexions | Auth Kerberos (GSSAPI) | oui | M | Support GSSAPI du driver Rust à valider. |
| Connexions | Auth LDAP (PLAIN) | oui | S | |
| Connexions | Auth AWS IAM | oui | M | |
| Connexions | TLS/SSL (CA, cert client, mot de passe clé, insecure) | oui | M | CA système. |
| Connexions | Tunnel SSH (mot de passe / clé + passphrase) | oui | M | Réutiliser le tunnel SSH existant de TableMax. |
| Connexions | Proxy Socks5 / proxy applicatif | oui | M | |
| Connexions | In-Use Encryption (CSFLE/QE, 5 types de KMS) | oui | XL | Nécessite libmongocrypt + crypt_shared ; à reporter. |
| Connexions | Read preference + tags + max staleness | oui | S | |
| Connexions | Options d'URI avancées (≈25 clés groupées) | oui | S | |
| Connexions | Nom, couleur, favori | oui | S | Déjà présent dans TableMax pour SQL. |
| Connexions | Liste/recherche/filtre « actives » des connexions | oui | S | |
| Connexions | Duplicate / Remove / Copy connection string | oui | S | |
| Connexions | Connexions simultanées + limite | oui | M | |
| Connexions | Multi-fenêtres | oui | M | |
| Connexions | Import/export de connexions chiffré | oui | M | Format propre à TableMax. |
| Connexions | Secrets dans le trousseau OS | oui | S | Déjà prévu (keyring). |
| Connexions | Lancement par URI / gestionnaire d'URL mongodb:// | oui | M | |
| Connexions | Détection non-genuine / EOL / topologie | oui | S | EOL via table locale. |
| Connexions | Masquage des secrets d'URI (protect) | oui | S | |
| Navigation | Arbre connexions › bases › collections/vues | oui | M | |
| Navigation | Namespaces déduits des privilèges | oui | M | `connectionStatus` + rôles. |
| Navigation | Liste des bases avec statistiques | oui | S | dbStats. |
| Navigation | Liste des collections avec statistiques | oui | S | collStats/`$collStats`. |
| Navigation | Créer base / collection | non | S | |
| Navigation | Options time-series / clustered / collation | non | M | |
| Navigation | Création collection Queryable Encryption | non | L | Dépend de l'In-Use Encryption. |
| Navigation | Drop base / collection / vue | non | S | |
| Navigation | Rename collection | non | S | |
| Navigation | Vues : ouvrir, dupliquer, modifier le pipeline, supprimer | partiel | M | |
| Documents | Query bar filter avec autocomplétion | oui | L | Éditeur + autocomplétion champs/opérateurs. |
| Documents | Project / Sort / Collation / Hint / Skip / Limit / maxTimeMS | oui | S | |
| Documents | Tri par défaut configurable | oui | S | |
| Documents | Historique recents + favoris | partiel | M | |
| Documents | Requête en langage naturel (IA) | oui | — | Exclu (cloud). |
| Documents | Vue liste (arbre typé) | oui | L | |
| Documents | Vue JSON (EJSON) | oui | M | |
| Documents | Vue table + navigation imbriquée | oui | L | Réutiliser la grille TableMax. |
| Documents | Pagination 25/50/75/100 + comptage asynchrone | oui | S | |
| Documents | Rendu de tous les types BSON + fuseau + UUID legacy | oui | M | |
| Documents | Menu contextuel de champ (add to query, copy…) | oui | S | |
| Documents | Copier en Shell / EJSON | oui | S | |
| Documents | Insights (requête sans index, gros documents…) | oui | M | |
| Documents | Insertion EJSON / éditeur visuel / multi-documents | non | M | |
| Documents | Édition en place avec changement de type | non | L | |
| Documents | Cloner / supprimer un document | non | S | |
| Documents | Bulk update avec prévisualisation | non | M | |
| Documents | Bulk delete avec aperçu | non | S | |
| Documents | Générateur de données factices | non | — | Exclu (IA) ; une version locale faker+schéma serait L. |
| Agrégations | Builder par étapes (activer, réordonner, snippets) | partiel | L | |
| Agrégations | Mode texte | oui | M | |
| Agrégations | Aperçus par étape + réglages | oui | M | |
| Agrégations | Focus Mode + raccourcis | oui | M | |
| Agrégations | Stage Wizard (8 cas d'usage) | oui | L | |
| Agrégations | Run + confirmation des étapes d'écriture | partiel | S | |
| Agrégations | Pipelines sauvegardés | oui | M | |
| Agrégations | Créer / mettre à jour une vue | non | S | |
| Agrégations | Export des résultats | oui | S | Via l'export commun. |
| Agrégations | Génération IA de pipeline | oui | — | Exclu (cloud). |
| Schéma | Échantillonnage + types/fréquences | oui | L | Algorithme type `mongodb-schema` à réécrire en Rust. |
| Schéma | Graphiques par type, filtre par sélection | oui | L | |
| Schéma | Carte géographique | oui | M | Sans tuiles distantes. |
| Schéma | Export JSON Schema (3 formats) | oui | M | |
| Explain | Résumé des performances | oui | M | |
| Explain | Arbre visuel | oui | L | |
| Explain | Sortie brute | oui | S | |
| Explain | Interprétation IA | oui | — | Exclu. |
| Index | Liste avec usage, taille, propriétés, statut | oui | M | `$indexStats`, `currentOp` pour la progression. |
| Index | Création (types + 8 options) | non | M | |
| Index | Drop / cancel / supprimer index échoué | non | S | |
| Index | Hide / unhide | non | S | |
| Index | Index Search / Vector Search (serveur) | partiel | L | Sans dépendance cloud si le serveur les supporte. |
| Index | Index roulants Atlas | non | — | Exclu (API Atlas). |
| Validation | Lecture des règles | oui | S | |
| Validation | Édition règles + action + niveau | non | M | |
| Validation | Génération des règles depuis un échantillon | non | M | Réutilise l'analyse de schéma. |
| Validation | Aperçu documents valides/invalides | oui | M | |
| Serveur | Graphes temps réel (opcounters, R/W, réseau, mémoire) | oui | L | serverStatus périodique. |
| Serveur | Hottest collections (`top`) | oui | M | |
| Serveur | Slowest operations (`currentOp`) + détail | oui | M | |
| Serveur | Kill Op | ? | S | Pas de garde readOnly observée ; TableMax devrait la gater. |
| Import/Export | Import JSON | non | M | |
| Import/Export | Import CSV avec typage par colonne | non | L | |
| Import/Export | Export JSON (3 variantes EJSON) / CSV, sélection de champs | oui | M | |
| Shell | mongosh intégré | non | XL | Pas d'équivalent Rust ; options : lancer `mongosh` installé dans un terminal intégré, ou console de commandes maison. |
| Export langage | Requête/pipeline → 8 langages | oui | L | Transpileur à écrire. |
| Préférences | Read-only / Read-write modes | — | M | Modèle pour le safe mode. |
| Préférences | Thème, fuseau, UUID, tri par défaut, maxTimeMS | oui | S | |
| Préférences | Proxy applicatif (manuel/système/PAC) | oui | M | |
| Préférences | Réglages figés par config globale / CLI | oui | M | |
| Préférences | Télémétrie, auto-update, cartes, IA | oui | — | Exclus. |
| Espace de travail | Onglets typés, duplicate, close others, confirmation | oui | M | |
| Espace de travail | Réouverture des onglets fermés | oui | M | |
| Espace de travail | My Queries (toutes connexions) | oui | M | |
| Espace de travail | Find in page | oui | S | |
| Espace de travail | Menus + raccourcis (zoom, reload data…) | oui | S | |
| Autres | Data Modeling (diagrammes, inférence des relations, export) | ? | XL | Fonction locale (hors IA) ; valeur élevée. |
| Autres | MongoDB Assistant | oui | — | Exclu (cloud). |
| Autres | Global Writes | n/a | — | Exclu (Atlas). |
| Autres | Fichier de log consultable | oui | S | |

---

## Inconnues et limites

- **Exécution non observée** : l'application n'a pas été lancée ; l'inventaire repose sur les
  libellés et conditions présents dans le code livré. L'ordre exact des écrans et certains
  comportements (ex. raccourcis de navigation dans les onglets) peuvent différer.
- **Collections capped** : aucune option `capped`/`size`/`max` n'a été trouvée parmi les
  libellés extraits du formulaire de création de collection ; il est possible qu'elle ait été
  retirée de cette version ou qu'elle soit rendue via un libellé non capturé. À vérifier par
  exécution.
- **Kill Op et Data Modeling en readonly** : aucune condition `readOnly` n'a été trouvée sur ces
  fonctions ; leur disponibilité dans l'édition readonly est inférée, non vérifiée.
- **Liste « Recents » de connexions** : pas de liste séparée observée dans cette version (seules
  les favorites sont distinguées) ; à confirmer à l'exécution.
- **Stockage des diagrammes Data Modeling** : persistance locale probable (`save` dans le store),
  emplacement exact non déterminé.
- **Liste exacte des types du sélecteur de type** du document : déduite des éditeurs dédiés et du
  rendu ; l'ordre et l'exhaustivité (ex. Symbol, DBRef) ne sont pas confirmés.
- L'analyse REA sémantique n'a couvert que `package.json`, `build/main.js` et `build/index.html` ;
  le reste a été examiné par extraction de chaînes et lecture ciblée du code minifié.
