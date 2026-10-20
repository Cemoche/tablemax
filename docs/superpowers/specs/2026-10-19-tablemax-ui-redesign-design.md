# TableMax — refonte de l'interface : l'apparence et le comportement de TablePlus macOS

Date : 2026-10-19 · Statut : validé par Cem (maquettes) · Epic : #77 · Spec parente :
`2026-10-16-tablemax-design.md`

Références (hors dépôt, dans le scratchpad de la session — rien de TablePlus n'entre dans le
dépôt) : analyse statique de TablePlus macOS 27.0.2 (`tp-mac/report.md` : thèmes, tailles des
nibs, menus et raccourcis), captures TablePlus Linux 1.8.4 et TableMax 0.1.0 (`ui-ref/`),
capture macOS fournie par Cem. Maquettes validées : artifact privé « TableMax — refonte style
TablePlus » (https://claude.ai/artifact/8xLdgBmt1wfjiQrynEny7Y) : fenêtre principale, liste des
connexions, formulaire de connexion, en sombre et en clair.

## 1. Intention et pourquoi

Cem (2026-10-19) : « on est PAS DU TOUT comme TablePlus » ; « tout est tout petit ». TableMax
existe pour remplacer TablePlus au quotidien : la familiarité est le produit. La référence est
**TablePlus pour macOS** (bien plus aboutie que la version Linux), à reproduire sur Linux avec
le même soin : disposition, densité, couleurs, typographie, boutons, écran des connexions,
filtres, colonnes, **raccourcis et interactions** (« ces petits détails qui font la
différence »).

**Succès** : quelqu'un qui utilise TablePlus sur Mac ouvre TableMax sur Linux et retrouve ses
repères sans chercher : mêmes zones aux mêmes endroits, mêmes raccourcis, même densité, un
thème sombre et un thème clair qui ressemblent à ceux de TablePlus ; et personne ne trouve plus
l'interface « toute petite ».

**Limite (règle du projet)** : rien n'est copié de TablePlus — ni code, ni icône, ni image, ni
logo, ni nom. On reproduit la disposition, la densité, les comportements et une palette proche ;
les icônes sont un jeu libre au même style (traits fins monochromes) et nos propres dessins ;
l'identité (nom, logo, monogrammes des moteurs) est la nôtre.

## 2. Objectifs

### 2.1 Thèmes et couleurs
- Deux thèmes, **sombre** et **clair**, calqués sur TablePlus macOS. Le réglage « System » ne
  fait que choisir lequel suit le mode clair/sombre du bureau (`prefers-color-scheme`) ; les
  couleurs du thème GTK du bureau ne sont jamais reprises. Valeurs au §5.1 (celles des
  maquettes validées).
- Tout passe par des tokens (`src/styles/tokens.css`), comme aujourd'hui : la refonte remplace
  les valeurs et ajoute les tokens qui manquent (toolbar, pastille, onglets, grille, barre du
  bas, connexions). Aucune couleur en dur dans les composants.
- Couleur de connexion : 6 couleurs prédéfinies (vert, gris, bleu, ambre, rouge, violet), une
  version par thème ; tag d'environnement (`local`, `development`, `staging`, `production`)
  indépendant de la couleur, comme dans TablePlus.
- Plus tard (hors étape) : d'autres thèmes et des thèmes communautaires ; le format (JSON de
  couleurs nommées) sera conçu à ce moment-là.

### 2.2 Typographie et taille
- **Interface** : la police système du bureau (`system-ui` : Ubuntu, Cantarell…), base
  **13 px** (aujourd'hui 12 px) ; 12 px pour les barres secondaires, 11,5 px pour les
  sous-titres et les placeholders.
- **Données** : une police **monospace livrée avec l'app** (JetBrains Mono, licence OFL, via le
  paquet npm `@fontsource/jetbrains-mono` — l'app ne charge rien depuis le réseau) pour la
  grille, l'arbre de la barre latérale, l'éditeur SQL, la pastille de statut et les sous-titres
  de connexion ; 13 px par défaut.
- **Taille de l'interface** : nouveau réglage « Interface size » (90 % à 130 %, pas de 5 %,
  défaut 100 % = les nouvelles tailles, déjà plus grandes) appliqué à toute l'interface.
  `Ctrl+=` / `Ctrl+-` changent la taille de police des données et de l'éditeur, comme
  `⌘=` / `⌘-` dans TablePlus.

### 2.3 Fenêtre principale (maquette « Après »)
- **Barre du haut unifiée** (52 px), qui sert de barre de titre (fenêtre sans décorations
  système, zone de glisser-déplacer, boutons réduire / agrandir / fermer à droite). De gauche à
  droite, en groupes de boutons « pilules » arrondies (34 px) :
  1. barre latérale (`Ctrl+0`) · connexion (popover : moteur, serveur, hôte, utilisateur, base,
     TLS ; Edit, Reconnect, Disconnect) ;
  2. [Discard `Ctrl+Shift+Backspace` | Preview `Ctrl+Shift+P` | Commit `Ctrl+S`], actifs seulement
     avec des modifications en attente ;
  3. safe mode (menu des niveaux) · base (`Ctrl+K`, changer de base / schéma) · SQL (`Ctrl+E`,
     nouvel onglet SQL) ;
  4. **pastille de statut** au centre, qui prend la place libre : « Moteur version : base :
     schéma.objet » en monospace, fond = couleur de la connexion ; états connecting /
     reconnecting / erreur ; un badge `PROD` dans la pastille pour une connexion `production`
     (remplace le bandeau d'environnement) ;
  5. reload (`Ctrl+R`) · Open Anything (`Ctrl+P`) ;
  6. [console (plus tard) | panneau de détail (`Ctrl+Space` / `Space`)].
- **Colonne des connexions ouvertes** (80 px) : une tuile par workspace ouvert (icône de base
  dans la couleur de la connexion, nom sur deux lignes) ; remplace le sélecteur de workspaces.
- **Barre latérale** (262 px, redimensionnable, min 240) : segmenté **Items / Queries / History**
  (les requêtes sauvegardées et l'historique quittent l'éditeur pour la barre latérale) ;
  recherche « Search for item… » + menu d'options (contient / commence / finit par ; tables ;
  vues) ; arbre en monospace 13 px, lignes 24 px, chevrons, icônes d'objets (table, vue,
  vue matérialisée, fonction, procédure), sélection arrondie ; en bas : réglages, [+ | ⌄]
  (nouvel onglet SQL, rafraîchir), sélecteur de schéma.
- **Onglets** (38 px) : flèches précédent / suivant, onglets en capsules qui se partagent la
  largeur, onglet d'aperçu en italique, bouton de séparation à droite ; menu New / Close / Close
  others / Rename.
- **Grille** : données en monospace, en-têtes en police d'interface (medium), lignes 26 px,
  en-tête 30 px, lignes alternées, numéros de ligne ; `NULL`, `EMPTY`, `DEFAULT` en majuscules
  pâles ; colonnes dimensionnées sur leur contenu (bornes 60–400 px).
- **Barre du bas** (42 px) : [Data | Structure] · `+ Row` · compteur « 1–300 of 1,250 rows »
  au centre · `Filters` · `Columns` · pagination [‹ | réglages | ›] (popover offset / limit).
- **Barre de filtres** (au-dessus de la grille, ouverte par `Filters` / `Ctrl+F`) : une ligne
  par filtre : case d'activation, colonne (« Any column », « Raw SQL », les colonnes),
  opérateur, valeur, Apply, +, − ; à droite « Apply All » avec AND / OR. Elle remplace le
  constructeur de filtres et la barre de filtre rapide actuels (la syntaxe rapide devient le mode
  « Raw SQL »).

> Amendement 2026-10-20 (#103) : barre du bas [Data | Structure | Index] (`Alt+3`, vue des
> index à part, retirée des sections de Structure) · `+ Row` · au centre « 1 of 415 rows
> selected », sinon « 415 rows » quand toute la table tient sur la page, sinon la plage ·
> `Filters` (loupe, rempli de `--accent-strong` quand la barre est ouverte) · `Columns` ·
> [‹ | ⚙ | ›]. Barre de filtres : chaque ligne `[✓] [colonne] [opérateur] [valeur…] [Apply]
> [−] [+]` ; une ligne de pied `[⚙] [Export] [SQL]`, les raccourcis (tirés du keymap
> effectif), `[Clear] [Apply All ⌄]`, AND / OR dans le menu ⌄ ; `SQL` montre le WHERE de la
> page (commande `filters_preview_sql`) avec les valeurs écrites en littéraux du dialecte, avec
> un bouton Copy — amendement 2026-10-20 (#109) : affichage seulement, ce texte n'est jamais
> exécuté, la page lie toujours ses valeurs en paramètres ; `Export`
> désactivé (pas d'export) ; Ctrl+↑ / Ctrl+↓ entre les lignes, Alt+C / Alt+O (⌘← / ⌘→ sur
> macOS) vers la colonne / l'opérateur ; Échap masque la barre (les lignes tapées restent).
> Le bandeau Commit / Discard au-dessus de la grille disparaît : la barre d'outils montre le
> nombre de modifications, Cancel pendant le commit. Libellés d'en-tête centrés.
- **Panneau de détail** à droite (280 px, `Ctrl+Space` comme TablePlus Linux / Windows, et `Space` comme sur Mac, dans la grille) : recherche « Search for field… », liste des
  champs avec leur type, édition sur place.

> Amendement 2026-10-20 (Task 7, #87 / #79) : le panneau est un seul interrupteur pour la
> fenêtre (comme le bouton de la barre du haut qui le lit), et non plus un état par onglet : il reste
> ouvert après un changement d'onglet ou de workspace et chaque onglet de table qui montre ses
> lignes l'affiche ; un onglet SQL ne lie pas `Ctrl+Space` (la complétion de l'éditeur le
> garde), le bouton y est désactivé. Ouvert pour la session ; la largeur (280 par défaut,
> min 240, max 720 et jamais plus de 60 % de la zone de contenu, bord gauche glissé ou flèches sur le séparateur) est gardée d'une session
> à l'autre comme celle de la barre latérale. Ouvrir ne prend pas le focus (la grille le garde
> et le panneau suit la ligne) ; Échap dans le panneau, ou sa fermeture pendant qu'il a le
> focus, rend le focus à la grille. Plusieurs lignes sélectionnées : la ligne de la cellule
> active, sinon la première sélectionnée. Pas de panneau sur les résultats d'un onglet SQL
> (suite à part). Le panneau s'affiche dès que l'interrupteur est mis, vide (« No row
> selected ») pendant le chargement de la page ou après un échec.

> Amendement 2026-10-20 (#104) : la pastille de statut prend la largeur libre (une marge de
> chaque côté reste une zone de glisser-déplacer) et se lit « [TAG] Moteur version : SSH :
> nom de la connexion : base : schéma.objet » : un badge par tag (`LOCAL`, `DEV`, `STAGING`,
> `PROD`, couleurs `--tag-*`, bordure `currentColor`), `SSH` seulement à travers un tunnel,
> le nom une seule fois s'il vaut la base ; nom accessible « TAG | texte ». À droite, un
> emplacement vide pour le débit réseau (#112, aucun chiffre tant que le backend ne compte pas
> les octets). Fond : une teinte de la couleur de la connexion (`--swatch-N-tint`), claire en
> thème clair, plus sombre que la couleur en thème sombre, texte ≥ 4,5:1. Barre du haut, à
> droite : [reload | palette de commandes (Open anything, `Ctrl+P`, glyphe ⌘)] puis [panneau
> de détail] ; ni métriques ni console (inexistants). Boutons de fenêtre selon la plateforme :
> Windows, boutons plats de 46 px sur toute la hauteur de la barre, fermer rouge
> (`--window-close`) à glyphe blanc au survol ; Linux (et macOS pour l'instant), cercles de
> 24 px façon GNOME / libadwaita, glyphes de 16 px, fermer sans rouge. Colonne des
> connexions : tuile neutre (`--pill`, bordure `--pill-border`) avec une icône de base
> contourée dans la couleur de la connexion (`--swatch-N-icon`), nom en petit dessous, panneau
> `--sel` derrière la tuile active ; le bouton des réglages (curseurs) en bas de la colonne
> (la barre du haut ne garde son engrenage que sans workspace ouvert). Barre latérale :
> pied `[+ | ⌄] [schéma]` ; en-têtes de section en lignes simples avec chevron (ni petites
> capitales grasses, ni compteur) ; « Routines » devient « Functions », masqué quand le moteur
> n'en renvoie aucune ; chaque table et vue a un chevron qui l'ouvre sur ses colonnes (nom et
> type), chargées à la première ouverture par `table_info` et gardées en cache ; un
> rafraîchissement garde les colonnes affichées et recharge celles ouvertes depuis la base,
> une table disparue se referme ; icônes : tables en grille bleue (`--icon-table`), vues en
> œil encadré violet (`--icon-view`), lucide. Onglets : plus de `+` (SQL de la barre du haut,
> `+` de la barre latérale, `Ctrl+T`), `⌄` (liste des onglets) gardé à côté du bouton de
> séparation ; un onglet seul prend toute la largeur, libellé centré, son × au survol ou au
> focus clavier seulement.

### 2.4 Connexions (maquettes « Liste des connexions » et « Formulaire »)
- Fenêtre d'accueil : à gauche logo, nom, version et trois boutons (Create connection…,
  Import connections…, Open SQLite file…) ; à droite `+`, recherche (`Ctrl+F`), connexions par
  groupes dépliables, lignes 52 px : tuile du moteur (monogramme `Pg`, `My`, `Ma`, `SL`…), point
  de couleur, nom, badge du tag, sous-titre `tag : hôte:port : base` en monospace.
- Formulaire compact, sans défilement pour les cas courants : nom ; couleur + tag ; safe mode ;
  hôte + port ; utilisateur + Other options ; mot de passe + stockage ; base ; mode SSL + CA… /
  Cert… / Key… ; encadré « Over SSH » ; en bas Import from URL… / Test / Save / Connect.
  Libellés alignés à droite (colonne 104 px).

> Amendement 2026-10-21 (#88) : écran des connexions = volet d'accueil à gauche (260 px,
> `--side` : icône de l'app `assets/icon/tablemax.svg`, nom, version, **Create connection…**
> et **Import connections…** ; pas d'**Open SQLite file…**, l'app n'a pas de sélecteur de
> fichier SQLite — une SQLite se crée dans le formulaire avec son chemin) et la liste à
> droite. Le formulaire s'ouvre à la place de la liste (bouton ← pour revenir), par `+` /
> `Ctrl+N`, Create connection…, le menu d'une ligne (Connect, Edit… ; clic droit,
> Shift+F10) ou Edit de la pastille ; un clic sur une ligne la sélectionne, Entrée ou un
> double-clic connecte. Groupes : boutons de divulgation (`aria-expanded`) au-dessus d'une
> listbox par groupe, lignes triées par nom, un seul arrêt Tab pour toutes les lignes,
> flèches / Home / End à travers les groupes ouverts. Recherche : nom, groupe, hôte, base,
> chemin. Nouvelles actions du keymap : `connection.open` (Ctrl+Shift+K, global : la liste,
> recherche focalisée), `connection.new` (Ctrl+N, global), `connections.search` (Ctrl+F,
> nouvelle portée `connectionList`, qui ne recouvre que `global`, comme `filterBar`).
> Nouveaux tokens, identiques dans les deux thèmes : tuiles des moteurs `--driver-pg`
> #2F5D8C, `--driver-my` #00758F, `--driver-ma` #8C4A2F, `--driver-sl` #4F6B2E,
> `--driver-other` #5E5E5E (moteur sans tuile propre, monogramme = deux premières lettres),
> monogrammes `--driver-*-text` #FFFFFF (≥ 5,3:1). Les points de couleur de la liste et les
> pastilles du formulaire utilisent `--swatch-N-icon` (≥ 3:1 sur `--content` dans les deux
> thèmes) et non plus `--swatch-N`, presque invisible en clair. Badge du tag = celui de la
> pastille de statut (`--tag-*`). Ligne sélectionnée `--sel` (sous-titre en `--text`,
> `--text-2` y tombe sous 4,5:1), survol `--row-b` (`--side` se confond avec `--content` en sombre). Formulaire : ordre moteur ; nom + groupe ;
> couleur (6 boutons radio) + tag ; safe mode ; hôte + port ; utilisateur ; mot de passe +
> stockage ; base ; mode SSL + CA… / Cert… / Key… (un fichier choisi a sa ligne avec son
> chemin et Clear) ; encadré « Over SSH » ; Import from URL… (remplit le formulaire ouvert,
> la connexion garde nom, couleur, tag, groupe et safe mode) / Test / Save / Connect ; Copy
> URL et Delete passent en icônes dans l'en-tête. Pas d'« Other options » (aucune option
> avancée à y mettre). Le libellé « Environment » devient « Tag ».

### 2.5 Éditeur SQL
- Barre de 36 px sous l'onglet : « No limit ⌄ » (LIMIT automatique), « Beautify », « Run Current
  ⌄ » ; résultats avec onglets Data / Message, mêmes règles de grille que les tables.
- La complétion `Ctrl+Space` (dans l'éditeur) marche toujours, y compris après un changement d'onglet.

### 2.6 Raccourcis et interactions
- Tableau du §5.3 : raccourcis de TablePlus macOS, `⌘` → `Ctrl`, `⌥` → `Alt`, `⌃⌘` →
  `Ctrl+Alt` sauf conflit avec le bureau ; tous dans le registre de raccourcis existant
  (réassignables dans les réglages).
- Interactions du §5.4 (sélection de lignes par leur numéro #78, etc.).

## 3. Non-objectifs et anti-objectifs

### Non-objectifs
- Thèmes supplémentaires, import de thèmes, thèmes communautaires.
- Fonctions de TablePlus que TableMax n'a pas encore (console de requêtes, process list,
  metrics, diagrammes, backup / restore, édition de structure, LLM) : leurs emplacements dans
  l'interface ne sont pas créés « vides » ; ils arriveront avec leurs epics.
- Onglet Index séparé (les index restent dans Structure).
- Packaging macOS / Windows (#20, #21).

### Anti-objectifs
- Un fichier, une icône, une image, un texte ou un logo de TablePlus dans le dépôt ou le
  bundle.
- Perdre la visibilité de l'environnement : une connexion `production` doit rester évidente
  (couleur de la pastille, badge `PROD`, `[PROD]` dans le titre de la fenêtre) et le safe mode
  inchangé.
- Une régression de l'accessibilité au clavier (tout reste atteignable au clavier, focus
  visible) ou du gel d'interface (grille virtualisée, I/O asynchrones).
- Une couleur ou une taille en dur dans un composant.
- Charger une police ou une ressource depuis le réseau.

## 4. Décisions prises avec Cem
- Référence : TablePlus macOS ; thèmes sombre et clair calqués ; « System » choisit entre les
  deux ; thèmes en plus plus tard.
- Interface un peu plus grande par défaut.
- Raccourcis et interactions de TablePlus reproduits avec soin.
- Maquettes de la fenêtre principale, de la liste des connexions et du formulaire validées.

## 5. Le comment, choix de Claude (à relire)

### 5.1 Tokens (sombre / clair)

| token | sombre | clair | rôle |
|---|---|---|---|
| `--win` | #1A1A1A | #ECECEC | fond de la barre du haut et de la colonne des connexions |
| `--side` | #1F1F1F | #F5F5F5 | barre latérale, barre de filtres |
| `--content` | #1E1E1E | #FFFFFF | fond du contenu |
| `--sep` | #0A0A0A | #CFCFCF | séparateurs forts |
| `--pill` / `--pill-border` | #383838 / #2C2C2C | #FFFFFF / #D6D6D6 | groupes de boutons de la barre du haut |
| `--icon` / `--icon-dim` | #EDEDED / #6B6B6B | #3A3A3A / #B0B0B0 | icônes actives / inactives |
| `--text` / `--text-2` | #F2F2F2 / #AFAFAF | #1E1E1E / #6B6B6B | texte principal / secondaire |
| `--seg-sel` | #3B3B3B | #DCDCDC | segment sélectionné (Items…) |
| `--search` | #151515 | #FFFFFF | champs de recherche |
| `--sel` | #464646 | #D4D4D4 | sélection de la barre latérale |
| `--tab` / `--tab-sel` | #2C2C2C / #5C5C5C | #DCDCDC / #FFFFFF | onglets |
| `--grid-head` / `--head-text` | #242424 / #E9E9E9 | #F5F5F5 / #262626 | en-tête de grille |
| `--row-a` / `--row-b` | #1E1E1E / #2A2A2A | #FFFFFF / #F4F5F5 | lignes alternées |
| `--grid-sep` | #303030 | #E3E3E3 | séparateurs de la grille |
| `--cell-text` | #E6E6E6 | #262626 | texte des cellules |
| `--placeholder` | #737373 | #8D8D8D | NULL / EMPTY / DEFAULT (ajusté pour un contraste ≥ 3:1 sur les deux couleurs de ligne) |
| `--rownum` | #8A8A8A | #8A8A8A | numéros de ligne |
| `--bottom` / `--btn` | #242424 / #343434 | #F3F3F3 / #FFFFFF | barre du bas / boutons |
| `--accent` | #3A7BF6 | #007AFF | segment actif, sélection, bouton principal |
| `--row-selected` / texte | `--accent` / #FFFFFF | `--accent` / #FFFFFF | lignes sélectionnées |
| `--cell-focus` | #FF4245 | #FF4245 | bordure de la cellule active |
| `--inserted` / `--modified` / `--deleted` | #558C3A / #8B6826 / #8F2F31 | #DAEBC2 / #FFE18E / #F5A6B0 | modifications en attente |
| tags local / development / staging / production | #3A3A3A·#D6D6D6 / #173E73·#9CC4FF / #5A4512·#F5D27A / #6A1C1F·#FFB3B5 | #E6E6E6·#4A4A4A / #DCE8FB·#1F4F9A / #FBF0CF·#7A5A0B / #FBDADB·#8E1C22 | badges (fond·texte) |
| couleurs de connexion | #2E8B57 #4A5160 #1F5FA8 #A3793E #8E1C22 #6B3FA0 | #BFE3A8 #E6E6E6 #BDCFF4 #F6E8A8 #F7C7C9 #DCCBF3 | pastille, point, tuile |

> Amendement 2026-10-20 (#102) : `--rownum` = #6E6E6E (clair) / #959595 (sombre) pour 4,5:1 sur
> `--row-a` et `--row-b` ; nouveau `--rownum-selected` #0062CC / #2B63D9, fond du numéro d'une
> ligne sélectionnée (blanc à 4,5:1, contre 4,0:1 sur `--accent`).

> Amendement 2026-10-20 (#103) : nouveau `--accent-strong` #0062CC (clair) / #2B63D9 (sombre),
> accent plus profond sous un texte blanc (5,8:1 / 5,4:1, contre 4,0:1 / 3,9:1 sur `--accent`) ;
> `--row-selected` = `--accent-strong` (lignes sélectionnées), et les contrôles remplis de la
> barre du bas (segment Data / Structure / Index actif, `Filters` ouvert) l'utilisent ;
> `--accent` reste #007AFF / #3A7BF6. La colonne des numéros de ligne prend les couleurs de
> l'en-tête (`--grid-head` / `--head-text`, 13,9:1 / 12,8:1) sur chaque ligne, sans zébrure
> ni teinte d'insertion / suppression ; une ligne sélectionnée y garde `--row-selected` et du
> blanc. `--rownum` et `--rownum-selected` (#102) disparaissent.

> Amendement 2026-10-20 (#104) : nouveaux tokens (clair / sombre). `--swatch-1..6-tint` :
> #BDCFF4 #BFE3A8 #F6E8A8 #E6E6E6 #F7C7C9 #DCCBF3 (la couleur claire elle-même) / #1D4068
> #25583C #654E2E #343841 #5A1B1E #472E64 (la couleur sombre à 55 % sur `--win`) ;
> `--swatch-N-tint-text` #1E1E1E / #F2F2F2 (≥ 6,9:1) ; `--swatch-N-text` disparaît.
> `--swatch-1..6-icon` : #1F5FA8 #2E8B57 #A3793E #4A5160 #8E1C22 #6B3FA0 / #799FCB #82B99A
> #C8AF8B #9297A0 #BB777A #A68CC6 (≥ 3:1 sur `--pill`). `--icon-table` #0A6CDB / #5AA2FF,
> `--icon-view` #8A3FD1 / #B58CFF (≥ 3:1 sur `--side`, `--seg-sel`, `--sel`). Dans les deux
> thèmes : `--window-close` #C42B1C, `--window-close-text` #FFFFFF (5,7:1), utilisés
> seulement par les boutons de fenêtre Windows. Les couleurs de connexion `--swatch-N`
> (points de la liste et du formulaire) ne changent pas.

Coloration SQL : celle de TablePlus (mots-clés #529BD8, fonctions #7CB342 / #2E7D32, nombres
#B57AFF / #1D00FF, chaînes #CA6E6E / #E04978, commentaires #009B31, requête courante #30363F /
#F3EEDE, sélection #003F84 / #FFEA84).

### 5.2 Dimensions (à 100 %)
Barre du haut 52, pilules 34, boutons 28–32 ; colonne des connexions 80 ; barre latérale 262
(min 240) ; en-tête de barre latérale 40 ; lignes d'arbre 24 ; onglets 38 (capsules 28) ;
en-tête de grille 30, lignes 26, numéros 46 ; barre du bas 42, contrôles 26 ; filtres : lignes
38, contrôles 24 ; panneau de détail 280 (min 240) ; liste des connexions : lignes 52, tuiles
34 ; formulaire 620 de large, champs 28 ; rayons 6–8 (contrôles), 14–17 (capsules).

### 5.3 Raccourcis (TablePlus macOS → TableMax)

| action | TablePlus | TableMax |
|---|---|---|
| Préférences | ⌘, | Ctrl+, |
| Nouvel onglet SQL / ouvrir l'éditeur | ⌘T / ⌘E | Ctrl+T / Ctrl+E |
| Fermer l'onglet | ⌘W | Ctrl+W |
| Onglet précédent / suivant | ⌘[ / ⌘] | Ctrl+[ / Ctrl+] (Ctrl+Tab garde l'ordre récent) |
| Onglet 1 à 9 | ⌘1…⌘9 | Ctrl+1…Ctrl+9 |
| Workspace précédent / suivant | ⌘⇧[ / ⌘⇧] | Ctrl+Shift+[ / Ctrl+Shift+] |
| Open Anything (objets et actions) | ⌘P | Ctrl+P : objets, et actions avec le préfixe `>` (remplace l'actuelle palette Ctrl+K) |
| Ouvrir une base / une connexion | ⌘K / ⌘⇧K | Ctrl+K (changer de base ou de schéma) / Ctrl+Shift+K (liste des connexions) |
| Barre latérale | ⌘0 | Ctrl+0 |
| Panneau de détail | Space (Mac) ; Ctrl+Space (TablePlus Linux) | Ctrl+Space et Space (grille active) ; marche après un changement d'onglet (#79) |
| Chercher dans la barre latérale | ⌘⇧F | Ctrl+Shift+F |
| Data / Structure | ⌃⌘[ / ⌃⌘] | Ctrl+Alt+[ / Ctrl+Alt+] (Alt+1 / Alt+2 gardés) |
| Précédent / suivant (navigation) | ⌃⌘← / ⌃⌘→ | Alt+← / Alt+→ |
| Filtres | ⌘F | Ctrl+F (grille) |
| Colonnes | ⌘⌥F | Ctrl+Alt+F |
| Activer / désactiver un filtre | ⌘B | Ctrl+B (barre de filtres) |
| Appliquer tous (AND / OR) | ⌘↩ / ⌘⇧↩ | Ctrl+Enter / Ctrl+Shift+Enter (barre de filtres) |
| Page précédente / suivante | ⌘← / ⌘→ | Ctrl+← / Ctrl+→ (grille active, hors édition) |
| Commit / Discard / Preview | ⌘S / ⌘⇧⌫ / ⌘⇧P | Ctrl+S / Ctrl+Shift+Backspace / Ctrl+Shift+P |
| Ajouter / dupliquer une ligne | ⌘I / ⌘D | Ctrl+I / Ctrl+D |
| Supprimer les lignes | ⌘⌫ | Ctrl+Backspace (et Delete) |
| Copier les cellules sélectionnées | ⌘⇧C | Ctrl+Shift+C |
| Quick Look / Set value | ↩ / ⌥↩ | Enter / Alt+Enter |
| Exécuter la requête courante / tout | ⌘↩ / ⌘⇧↩ | Ctrl+Enter / Ctrl+Shift+Enter |
| Commenter | ⌘/ | Ctrl+/ |
| Beautify | ⌘I (éditeur) | Ctrl+I (éditeur) ; Ctrl+Shift+F reste aussi |
| Taille de police | ⌘= / ⌘- | Ctrl+= / Ctrl+- |
| Recharger / recharger l'onglet / reconnecter | ⌘R / ⌥⌘R / ⌘⇧R | Ctrl+R / Ctrl+Alt+R / Ctrl+Shift+R |
| Nouveau workspace | ⌘N | Ctrl+N |
| Complétion | ⌃Space | Ctrl+Space (éditeur ; la portée éditeur gagne sur la grille) |

> Amendement 2026-10-20 (#102) : hors macOS Ctrl+Alt est AltGr ; Colonnes = Alt+F et Data /
> Structure = Alt+1 / Alt+2 seulement ; macOS garde ⌘⌥F et ⌘⌥[ / ⌘⌥]. Pas de Ctrl+Alt par défaut.

Règle : un raccourci n'existe que dans son contexte (grille, éditeur, barre de filtres) quand
TablePlus le réutilise (⌘I, ⌘F, ⌘←) ; tous restent réassignables (registre existant) ; un
conflit avec un raccourci courant du bureau GNOME (Ctrl+Alt+flèches) est évité.

### 5.4 Interactions

| geste | effet |
|---|---|
| clic sur un numéro de ligne | sélectionne la ligne ; Shift+clic étend ; Ctrl+clic ajoute / retire (#78) |
| clic dans une cellule | cellule active (bordure `--cell-focus`), sa ligne mise en évidence |
| double-clic dans une cellule / Enter | édition sur place / Quick Look (contenu entier, JSON indenté) |
| Ctrl+Space ou Space (grille) | ouvre / ferme le panneau de détail de la ligne active, y compris après un changement d'onglet (#79) |
| clic sur un en-tête | tri asc → desc → aucun (ne sélectionne pas la colonne) |
| glisser un en-tête | réordonne la colonne ; double-clic sur sa bordure : ajuste la largeur au contenu |
| menu d'en-tête | Filter with column, Hide column, Fit to content, Reset positions, Show all, Sort asc / desc / remove, Copy column name |
| menu de cellule | Quick Look, Set value (NULL / EMPTY / DEFAULT), Copy rows / Copy rows as (TSV, CSV, CSV + header, JSON, Markdown, INSERT), Copy selected cells, Quick filter (IS NULL / = valeur), Add row, Duplicate, Delete |
| menu d'un objet de la barre latérale | Open in new tab, Open structure, Copy name, Copy script as (CREATE, SELECT top 100), Refresh |
| clic simple / double-clic sur un objet | onglet d'aperçu / onglet permanent (existant) |
| Échap | ferme le popover, la barre de filtres vide ou annule l'édition en cours |
| changement d'onglet | conserve le focus et les raccourcis de l'onglet (panneau de détail #79, complétion) |

### 5.5 Précisions (relecture du 2026-10-19)
- **Palettes** : l'action existante `palette.all` (aujourd'hui Ctrl+K) devient Open Anything et
  passe à **Ctrl+P** (garde son identifiant, donc les réassignations des utilisateurs) : objets
  par défaut, actions quand la saisie commence par `>`. `palette.objects` disparaît (une
  réassignation enregistrée d'un identifiant inconnu est déjà ignorée par `settings.rs`).
  Nouvelles actions : `database.open` (Ctrl+K, changer de base / schéma) et `connection.open`
  (Ctrl+Shift+K, liste des connexions).
- **Contextes des raccourcis** : le registre de raccourcis a déjà des portées ; on ajoute celles
  qu'il faut (grille, éditeur, barre de filtres, liste des connexions). Dans l'éditeur, ses
  raccourcis du tableau gagnent sur ceux de CodeMirror qui les recouvrent (Ctrl+Enter exécute,
  Ctrl+I met en forme, Ctrl+[ / Ctrl+] changent d'onglet ; l'indentation reste Tab /
  Shift+Tab). Pour les dispositions où `[` / `]` demandent AltGr, Ctrl+PageUp / Ctrl+PageDown
  font aussi onglet précédent / suivant (et Ctrl+Shift+PageUp / PageDown pour les workspaces).
  Le tableau du §5.3 fait foi, sauf conflit avec un raccourci du bureau GNOME.
- **Taille de l'interface** : appliquée par le **zoom natif de la webview** (commande Rust,
  `Webview::set_zoom`), pas par du CSS : la grille sur canvas, les menus et les popovers suivent
  sans conversion des tailles. Nouveau réglage `interfaceScale` (0.9–1.3, défaut 1.0) et
  `dataFontSize` (grille et arbre, défaut 13) à côté de `editorFontSize` (valeurs enregistrées
  conservées) ; Ctrl+= / Ctrl+- changent `dataFontSize` et `editorFontSize` ensemble.
- **Barre de titre** : fenêtre sans décorations ; glisser, réduire, agrandir, fermer et
  redimensionner (poignées de bord) passent par des commandes Rust, comme `window_set_title`,
  sans élargir les capabilities ; double-clic sur la barre = agrandir. Si sur GNOME / Wayland le
  redimensionnement ou l'ancrage aux bords ne sont pas fiables, on livre avec les décorations
  natives (la barre d'outils devient la première ligne sous la barre de titre du système) et un
  réglage « Use system title bar » ; taille minimale de fenêtre 960 × 600.
- **Colonne des connexions** : elle montre les workspaces du store existant ; Items / Queries /
  History portent sur le workspace actif. Clic sur une requête sauvegardée ou une entrée
  d'historique : ouvre un onglet SQL avec ce texte (ou active celui de la requête sauvegardée
  s'il est déjà ouvert) ; « Insert into SQL editor » dans le menu contextuel ; `history.toggle`
  (Ctrl+Shift+H) ouvre l'onglet History de la barre latérale.
- **Filtres** : le modèle existant (brouillons, vues de grille, opérateurs par type) est
  conservé, seule l'interface change. Apply sur une ligne applique ce seul filtre ; Apply All
  applique toutes les lignes cochées, en AND (défaut) ou en OR — ce qui demande un champ
  `combine: And | Or` dans la requête de page côté backend.
- **Police** : `@fontsource/jetbrains-mono`, graisses 400 et 500, sous-ensembles latin et
  latin-ext ; licence OFL compatible avec la distribution dans une app GPL (la police reste
  sous sa licence, fichier de licence livré).
- **Livraison** : une issue, une branche et une PR vers `main` par tâche, chacune laissant l'app
  utilisable ; tokens, typographie et taille de l'interface d'abord. Un mélange ancien / nouveau
  style est accepté sur `main` entre deux tâches ; pas de release tant que l'epic n'est pas
  fini.
- **Thème « System »** : `prefers-color-scheme` de la webview ; si WebKitGTK ne suit pas le
  mode du bureau, la valeur vient de Tauri côté Rust (thème de la fenêtre) et est poussée au
  frontend.
- **Environnement** : `EnvBanner` est retiré ; le badge `PROD` de la pastille ne se réduit
  jamais (le texte de la pastille est tronqué avant lui) ; `[PROD]` reste dans le titre de la
  fenêtre.

## 6. Laissé au constructeur
- Le jeu d'icônes libre (style traits fins, licence compatible GPL, livré dans le bundle) et le
  dessin de nos icônes d'objets.
- La façon de faire la barre de titre personnalisée sous Tauri 2 (fenêtre sans décorations,
  zone de glisser-déplacer, commandes Rust pour réduire / agrandir / fermer comme
  `window_set_title`, sans élargir les capabilities) et son comportement au double-clic
  (agrandir).
- Le découpage des composants, la migration des composants existants (EnvBanner,
  WorkspaceSwitcher, HistoryPanel, SavedQueries, FilterBuilder, ViewToggle) et l'ordre des
  tâches, chacune livrable seule sans casser l'app.
- Les valeurs fines (paddings, rayons exacts, animations) tant que les maquettes sont
  respectées.
- La vérification visuelle : captures avant / après de chaque écran dans la PR, en sombre et en
  clair, sur un bureau Linux.
