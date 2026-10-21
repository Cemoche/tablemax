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

> Amendement 2026-10-21 (#115) : le panneau montre aussi la ligne sélectionnée des résultats
> d'un onglet SQL (remplace « pas de panneau sur les résultats d'un onglet SQL » ci-dessus,
> et « le bouton y est désactivé », désormais seulement sans jeu de résultats).
> Même composant, même interrupteur pour la fenêtre (ouvert dans un onglet de table, il l'est
> dans un onglet SQL et inversement), même largeur, recherche, JSON indenté, NULL comme la
> grille. Placé à droite de l'éditeur et des résultats (comme à droite de la grille d'un
> onglet de table, sous la barre de l'onglet). Lecture seule : un résultat de requête n'a ni
> table ni clé, aucun champ n'est modifiable, pas d'action ni de lien de clé étrangère ; une
> valeur coupée (texte long) montre ce que le résultat contient, suivi de « Only the start of
> this value was loaded. », comme Quick Look dans cette grille (pas de clé pour la recharger ;
> même mention pour une table sans clé). Il suit le « Result N » affiché : chaque jeu de
> résultats (et chaque exécution) repart sans sélection ; vue Message, exécution en cours sans
> jeu encore : « No row selected ». Montré tant que l'exécution a un jeu de résultats ou est en
> cours (pas de clignotement à la relance) ; sans exécution, ou si elle n'a renvoyé aucun jeu
> (UPDATE…), pas de panneau et le bouton de la barre du haut est désactivé (`softDisabled`,
> info-bulle gardée), l'interrupteur restant tel quel. Clavier : `grid.rowDetails` garde la
> portée `tableTab` (aucun nouvel id, rien côté Rust) ; la grille le reconnaît dans son propre
> keydown, avec Space, pendant qu'elle a le focus — dans un onglet SQL c'est le seul endroit
> (plus le bouton), et `Ctrl+Space` dans le texte de l'éditeur reste la complétion
> (`editor.complete`) ; dans un onglet de table la grille l'arrête, la liaison de fenêtre ne le
> voit donc pas une seconde fois. Échap dans le panneau rend le focus à la grille des résultats
> (à l'éditeur quand aucune grille n'est affichée, vue Message).

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
> Relecture (#88) : des modifications non enregistrées du formulaire (brouillon différent
> de la connexion chargée ou enregistrée, ou mot de passe / secret SSH tapé) ne se perdent
> jamais en silence : ←, Ctrl+Shift+K, Ctrl+N, New connection de la palette et Edit de la
> pastille sur une autre connexion demandent « Discard changes to this connection? »
> (Discard / Cancel, même boîte que « Discard pending changes? ») ; derrière un workspace
> le formulaire reste monté, caché, avec ses modifications. Delete demande « Delete <nom> ? »
> (la connexion et ses secrets du trousseau, sans retour). Focus : à l'ouverture sur Name
> (connexion existante) ou Driver (nouvelle) ; à la fermeture sur la ligne sélectionnée,
> sinon la recherche. Ctrl+Shift+K ne supprime plus de ligne dans l'éditeur SQL
> (`Shift-Mod-k` retiré du keymap de CodeMirror, §5.5).

> Amendement 2026-10-21 (#118) : Échap ferme le formulaire comme ← (même question « Discard
> changes to this connection? » s'il a des modifications, même focus au retour : la ligne
> sélectionnée, sinon la recherche), depuis n'importe quel champ — y compris un champ texte —
> ou quand le focus est sur la page. Échap reste à l'élément ouvert : une boîte de dialogue
> (Import from URL…, Delete, invites de Test, la question elle-même), une infobulle affichée
> (#109), une composition IME, la liste de suggestions d'un champ (Group, SSH host : la
> première Échap après une saisie, ↓ / ↑ ou un clic lui revient), le menu natif d'un select
> ouvert et le sélecteur de fichier natif (ils prennent la touche avant la page). Pas
> d'Échap depuis une autre région (barre d'outils, colonne des connexions ouvertes) ni pour
> le formulaire caché derrière un workspace. Pas d'action de keymap : c'est l'Échap propre
> du formulaire, comme celle d'une boîte de dialogue, non réassignable. Les boîtes de
> dialogue des connexions prennent leur Échap (`preventDefault`), pour que le formulaire
> derrière ne réagisse pas à la même frappe ; dans la question de confirmation, une touche
> maintenue n'agit qu'une fois (ses répétitions ne l'annulent pas).

### 2.5 Éditeur SQL
- Barre de 36 px sous l'onglet : « No limit ⌄ » (LIMIT automatique), « Beautify », « Run Current
  ⌄ » ; résultats avec onglets Data / Message, mêmes règles de grille que les tables.
- La complétion `Ctrl+Space` (dans l'éditeur) marche toujours, y compris après un changement d'onglet.

> Amendement 2026-10-21 (#89) : barre (36 px, `role="toolbar"`, ← / → entre ses boutons) :
> à gauche « No limit ⌄ » (bouton de menu, nom « Row limit: … », choix radio « No limit » /
> « Limit N », N = réglage `autoLimitValue` ; c'est l'Auto LIMIT existant, choix par onglet
> gardé en mémoire seulement), « Beautify » (`editor.format`, Ctrl+I, la sélection ou tout) ;
> à droite Save, Cancel pendant l'exécution, puis « Run Current » (Ctrl+Enter) collé à son
> « ⌄ » (menu Run Current / Run All, Ctrl+Shift+Enter ; les deux désactivés pendant
> l'exécution). Le Ctrl+Shift+F de Beautify (§5.3 « reste aussi ») est laissé à la Task 10 :
> c'est aujourd'hui `sidebar.search` (global), il faut d'abord la priorité de l'éditeur.
> Résultats : onglets Data / Message (tablist, ← / →). Data = la grille de la Task 5, un
> onglet « Result N » par jeu seulement quand il y en a plusieurs, « N rows · ms » à droite
> des onglets ; Message = une ligne par instruction (lignes renvoyées, lignes modifiées ou
> « done », avec la durée), « Running… », « Cancelled », l'erreur et l'indice de reconnexion
> (pas de NOTICE : le backend n'en renvoie pas). Onglet par défaut : Data quand l'exécution a
> renvoyé des lignes sans erreur ni annulation, sinon Message (une erreur ou une annulation
> ne se voient que là) ; un onglet choisi à la main tient jusqu'à l'exécution suivante.
> Focus : un onglet SQL activé alors que rien n'a le focus (raccourci clavier, l'onglet
> d'avant a emporté le focus) met le focus dans son éditeur, pour taper ou `Ctrl+Space`
> aussitôt ; un clic sur un onglet laisse le focus sur l'onglet.

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
> (points de la liste et du formulaire) ne changent pas (remplacé par l'amendement #88 :
> points et pastilles en `--swatch-N-icon`).

Coloration SQL : celle de TablePlus (mots-clés #529BD8, fonctions #7CB342 / #2E7D32, nombres
#B57AFF / #1D00FF, chaînes #CA6E6E / #E04978, commentaires #009B31, requête courante #30363F /
#F3EEDE, sélection #003F84 / #FFEA84).

> Amendement 2026-10-21 (#89) : tokens de l'éditeur SQL (clair / sombre) : `--sql-keyword`
> #266EAA / #63A5DC, `--sql-function` #2D7931 / #7CB342, `--sql-number` #1D00FF / #BC87FF,
> `--sql-string` #CB2357 / #D58C8C, `--sql-comment` #007C27 / #00BA3B, `--sql-current`
> #F3EEDE / #30363F, `--sql-selection` #FFEA84 / #003F84. Écart au §5.1 pour le contraste :
> les couleurs de texte gardent la teinte du §5.1, assombries en clair et éclaircies en
> sombre jusqu'à ≥ 4,5:1 sur `--content` et sur la bande `--sql-current` (règle des #102 /
> #103 / #104) ; la bande et la sélection restent celles du §5.1 (la bande reste visible :
> 1,16:1 / 1,37:1 sur `--content`, l'éclaircir en clair ou l'assombrir en sombre l'effacerait).
> Contrastes (sur `--content` / sur la bande) — clair : mots-clés 5,39 / 4,65, fonctions
> 5,40 / 4,65, nombres 8,41 / 7,25, chaînes 5,36 / 4,62, commentaires 5,37 / 4,63 ; sombre :
> mots-clés 6,31 / 4,61, fonctions 6,66 / 4,86, nombres 6,39 / 4,67, chaînes 6,32 / 4,61,
> commentaires 6,42 / 4,69 (test `sql_editor_contrast`). Mots-clés : aussi les types,
> booléens et `NULL` ; fonctions : les fonctions intégrées du dialecte (lang-sql) ; les
> identifiants entre guillemets restent du texte (`--text`) ; ni gras ni italique. Requête
> courante : fond des lignes de l'instruction que Run Current exécuterait (celle du curseur),
> à partir de sa première ligne de code (un commentaire après le `;` précédent n'est pas
> coloré), seulement sans sélection (la sélection s'exécute alors), et plus de bande de ligne
> active ; rien au-delà de 200 000 caractères (le texte est redécoupé à chaque frappe).

> Amendement 2026-10-21 (#107) : règle — un fond d'accent plein sous un texte (contrôle rempli,
> ligne surlignée ou sélectionnée) est `--accent-strong` (blanc `--accent-contrast` à 5,8:1
> clair / 5,4:1 sombre), jamais `--accent` (4,0:1 / 3,9:1). Un libellé secondaire à 70 %
> (raccourci, type) ou une icône à 60 % y devient opaque (blanc à 70 % : ≈3,5:1 ; à 60 % :
> ≈3:1). `--accent` reste pour les teintes (`bg-accent/30`), anneaux de focus, bordures et
> icônes. L'accent comme couleur de texte (liens) est sous 4,5:1 (4,02:1 clair / 4,24:1
> sombre) : suivi dans #129 (fait, voir l'amendement #129). Tests : `accent_fill_guard` (`src/styles/accentText.test.ts`,
> aucun fond `--accent` opaque dans `src/`) et `accent_text_contrast` (`tokens.test.ts`, clair,
> sombre média, sombre forcé).

> Amendement 2026-10-21 (#128) : même règle pour le rouge. Nouveau `--danger-strong` #C62828
> (clair, la valeur de `--danger`) / #CC3333 (sombre, même teinte), fond d'un bouton
> destructif sous son libellé, avec `--danger-contrast` #FFFFFF (deux thèmes) : 5,62:1 /
> 5,14:1, contre 2,78:1 pour du blanc sur `--danger` sombre (#ff6b6b). Seul utilisateur : le
> bouton de confirmation de `ConfirmDialog` (Discard, Delete…), sans état survol ni pressé
> propre. `--danger` reste pour le texte d'erreur, les bordures, anneaux et icônes ; comme
> texte il fait ≥ 4,5:1 sur `--content` (= `--surface`, dialogues), `--side`, `--win`,
> `--row-a/b`, `--search`, `--bottom` (5,62 / 6,01 sur `--content`), mais pas sur `--btn`
> sombre (4,49:1), `--pill` sombre (4,23:1), `--seg-sel` (survol : 4,10:1 clair / 4,04:1
> sombre) ni `--sel` (3,79 / 3,40) : à traiter avec #129 (fait : `--danger-text`). Tests : `danger_fill_guard`
> (`src/styles/accentText.test.ts`, aucun fond `--danger` opaque dans `src/`),
> `danger_fill_contrast` et `danger_text_contrast` (`tokens.test.ts`, clair, sombre média,
> sombre forcé).

> Amendement 2026-10-21 (#129) : règle — un texte en accent ou en rouge (lien, indicateur ↗
> de clé étrangère, message d'erreur, libellé destructif, icône colorée par `text-*`) prend
> `--accent-text` / `--danger-text`, jamais `--accent` / `--danger` (qui restent pour
> teintes, anneaux, bordures et contours) ; une chaîne de classes n'a qu'une couleur de texte
> de base (Tailwind range `.text-text` / `.text-icon` après `.text-danger-text`). Valeurs,
> même teinte : `--accent-text` #0057B5 (clair) / #92B6FA (sombre), `--danger-text` #AD2323 /
> #FF9999 ; pire cas `--sel` (colonne sélectionnée de la grille) : 4,67 / 4,63 et 4,66 / 4,62.
> Liste des fonds : `tokens.test.ts` (`ACCENT_TEXT_BACKGROUNDS`, `DANGER_TEXT_BACKGROUNDS`).
> Grille : `linkColor` = `--accent-text` ; sur une cellule modifiée l'indicateur prend le texte
> lisible sur `--modified`, sur une ligne supprimée son `--text-2`. Une ligne en échec : texte
> `--danger-text` sur les lignes simples ; sur une ligne insérée ou supprimée le texte du
> remplissage l'emporte, une cellule modifiée garde `--modified` et son texte lisible ; son
> numéro de ligne est en `--danger-text` (6,33 / 7,59 sur `--grid-head`), blanc si
> sélectionnée. Tests : `src/styles/textColor.test.ts` (gardes texte et conflit de couleurs),
> `tokens.test.ts`, `gridTheme.test.ts`, `rowNumbers.test.ts`.

> Amendement 2026-10-21 (#136) : tout texte posé sur un remplissage de modification lit
> 4,5:1 (clair, sombre média, sombre forcé). Sombre : `--inserted` #558C3A → #2E5020 et
> `--modified` #8B6826 → #7E5E22 (`--cell-text` 3,24 → 7,37 et 4,10 → 4,79 ; `--text` des
> badges du panneau des modifications et du champ modifié du détail de ligne 8,21 / 5,34 ;
> ce champ garde `--text` quand il est verrouillé, `--text-2` y lisant 2,73) ;
> le clair ne change pas (11,99 / 11,83). Nouveau `--deleted-text` #474747 (clair) / #CCCCCC
> (sombre) pour une ligne supprimée, toujours barrée : 4,85 / 4,99 sur `--deleted` (au lieu
> de `--text-2`, 2,78 / 3,66), plus pâle que `--cell-text`. Grille : une ligne insérée
> dessine données, NULL / EMPTY / DEFAULT et indicateur ↗ en `--cell-text`, une ligne
> supprimée en `--deleted-text`, une cellule modifiée dans le texte le plus lisible sur
> `--modified` (`--cell-text` en clair, blanc 5,98 en sombre) ; le `--placeholder` atténué
> (moins de 3:1 sur ces remplissages) ne reste que sur les lignes simples. Colonne
> sélectionnée (`--sel`) : 6,27 / 5,88 pour `--deleted-text`. Ligne sélectionnée : blanc sur
> `--row-selected`, inchangé ; ligne en échec : règles du #129. Les remplissages restent
> distincts (ΔE*ab CIE76 ≥ 20 entre eux et avec `--row-a`, `--row-b`, `--sel`,
> `--row-selected` ; minimum clair 22,7 inséré / `--row-b`, sombre 33,1 inséré / `--sel`) ;
> inséré et modifié se distinguent aussi en luminance (sombre 1,54:1) et restent à ΔE ≥ 10
> en protanopie / deutéranopie simulées (Machado 2009, sévérité 1 ; sombre 13,8 / 20,7, clair
> 25,4 / 27,2).
> Tests : `change_fill_text_contrast` et `change_fills_distinct` (`tokens.test.ts`),
> `change_fill_text_contrast` (`gridTheme.test.ts`), placeholders (`DataGrid.test.tsx`),
> champ modifié verrouillé (`RowDetailPanel.test.tsx`).

> Amendement 2026-10-21 (#135) : un seul anneau de focus, à deux tons (décision de Cem) : un
> contour `--accent` de 2 px et une bande de 1 px en nouveau `--focus-ring-inner`, #000000
> (clair) / #FFFFFF (sombre), entre le contour et le contrôle. Utilitaires de
> `src/index.css` : `focus-ring` (contour décalé de 1 px, la bande en `box-shadow` dans ce
> décalage) et `focus-ring-inset` (contour à −2 px, bande en `box-shadow` inset de 3 px qui
> se montre à l'intérieur : 1 px, 2 px sous la bordure d'un champ) pour les lignes, onglets,
> boutons de barre et de menu et les champs dont le parent défile ou coupe (`overflow`). Les
> ombres Tailwind du contrôle restent sous la bande. L'accent seul passe sous 3:1 sur
> `--sel` (2,71 / 2,40), `--seg-sel` / `--tab` (2,93 clair), l'onglet actif sombre (1,70),
> `--pill` sombre (2,98), `--accent-strong` (1,44 / 1,37) et le champ modifié sombre (1,52) ;
> la bande lit au moins 3:1 sur chaque fond où l'anneau se pose (pire cas 3,62 clair et 5,40
> sombre sur `--accent-strong`, 5,98 sur le `--modified` sombre, 6,69 sur l'onglet actif
> sombre) et 5,23 / 3,93 contre l'accent. Le segment sélectionné de la barre du bas perd son
> anneau blanc (la bande suffit sur son remplissage) ; les pastilles de couleur du formulaire
> portent l'anneau sur toute la pastille (`has-[:focus-visible]`), hors de leur anneau coché ;
> le champ du détail de ligne (bordure `--accent` à 1,52 sur `--modified` sombre), les
> entrées surlignées des menus et les bords de redimensionnement (teinte `--accent/50` sous
> 3:1) prennent l'anneau. Grille : Glide trace la cellule active en `--cell-focus` (rouge,
> sous 3:1 sur `--sel`, les remplissages de modification et les lignes sélectionnées) ;
> `drawCell` (aussi en lecture seule) ajoute la bande `--focus-ring-inner` juste à
> l'intérieur (6,12 / 3,43 contre le rouge). Cases à cocher : nouveau `--accent-control`
> #0062CC (clair) / #4A88FA (sombre), même teinte, 3:1 sur `--pill`, `--seg-sel`, `--side`,
> `--filter-applied`, `--content` (pire cas 4,23 clair, 3,30 sombre ; coche blanche 5,80 /
> 3,39). Tests : `focus_ring_contrast` et `checkbox_contrast` (`tokens.test.ts`, clair,
> sombre média, sombre forcé), garde `src/styles/focusRing.test.ts` (pas de contour, `ring`
> ni bordure d'une couleur sous une variante de focus ; tout `outline-none` porte l'anneau
> ou figure dans `ALLOWED` avec sa raison ; pas de `accent-accent`), `gridTheme.test.ts` et
> `DataGrid.test.tsx` (bande de la cellule active).

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

> Amendement 2026-10-21 (#90) : chaque ligne du tableau a son action dans le registre, avec
> son défaut et sa portée (vérifié par `src/lib/shortcutParity.test.ts`, qui recopie ce
> tableau) ; « grille » = la portée `tableTab`. Nouvelles actions, dans un onglet de table
> seulement : `grid.discard` (Ctrl+Shift+Backspace, pas dans un champ texte ; le raccourci
> demande d'abord « Discard pending changes? » — Entrée = Discard, Échap / Cancel gardent
> et rendent le focus — car rien ne l'annule et Ctrl+Backspace est à une touche ; le bouton
> de la barre d'outils, geste délibéré, reste immédiat), `grid.preview` (Ctrl+Shift+P),
> comme son bouton ; `tab.reload` (Alt+R hors macOS, ⌥⌘R sur macOS :
> recharge la page de l'onglet de table seul) ; `workspace.reconnect` (Ctrl+Shift+R :
> reconnecte le workspace affiché s'il est déconnecté, rien sinon — l'app ne sait pas
> couper puis rouvrir une connexion ouverte) ; `editor.complete` (Ctrl+Space, remplace le
> Ctrl-Space de CodeMirror, réassignable ; les touches de CodeMirror qui lancent la
> complétion, Alt-` / Alt-i sur macOS comprises, sont retirées). Beautify répond aussi à Ctrl+Shift+F dans
> l'éditeur. Taille de police : aussi Ctrl+Shift+= (« Ctrl++ ») et + / − du pavé numérique
> (`NumpadAdd` / `NumpadSubtract` entrent dans la grammaire, des deux côtés) ; le « - »
> AZERTY (touche `Digit6`) reste Ctrl+6 = onglet 6 par position, c'est #105. Nouveau
> workspace ⌘N = `connection.new` (#88). Touches fixes de la grille, non réassignables (la
> grammaire veut un modificateur) : Space (détail), Enter (Quick Look), Delete.
> **Priorité** : quand le focus est dans une région de portée (le texte de l'éditeur SQL —
> pas ses panneaux comme la recherche de CodeMirror —, la barre de filtres : attribut
> `data-shortcut-scope`), ses actions gagnent sur celles de toute autre
> portée pour les mêmes touches, globales comprises ; hors de la région elles n'agissent
> pas. Ctrl+Shift+F met donc en forme dans l'éditeur et cherche dans la barre latérale
> ailleurs ; une touche de l'onglet de table réassignée sur une touche de la barre de
> filtres ne passe plus avant elle (écouteur en phase de capture). La grille gagne déjà en
> arrêtant ses touches dans son propre keydown. Dans les réglages, une paire déclarée
> (`shadows` : `editor.format` / `sidebar.search`) n'est pas un conflit ; tout autre
> partage de touches entre portées qui se recouvrent reste refusé. Réglages : chaque action
> montre toutes ses combinaisons (défaut et alternatives) ; une réassignation enregistrée
> qu'une autre action utilise aussi (un défaut ajouté depuis) est signalée sur sa ligne,
> jamais réécrite. Open Anything : objets (tables, onglets, connexions) par défaut, actions
> quand la saisie commence par `>`, lignes de 40 px, entrée « Show connections » (#119).

> Amendement 2026-10-21 (#105) : une touche se nomme par le caractère que la disposition
> tape dessus quand ce caractère peut nommer un raccourci, sinon par sa position (`e.code`).
> Règle (`keyPressOf`, `src/lib/shortcuts.ts`, la même pour l'enregistreur des réglages) :
> 1. touches nommées (Entrée, Tab, flèches, F1–F12, + / − du pavé) par position ; l'Entrée
>    du pavé est Entrée (#122) ; les autres touches du pavé n'ont pas de nom ;
> 2. une lettre latine tapée (`e.key`) est cette lettre (#102) ;
> 3. un caractère de raccourci tapé (`` , . / ; - = [ ] \ ` ``) est ce caractère : la touche « , »
>    d'AZERTY est Ctrl+,, la touche « / » de Dvorak Ctrl+/ ; si Shift l'a tapé (QWERTZ
>    Shift+7 = « / »), Shift appartient au caractère, pas au raccourci (Ctrl+Shift+7 = Ctrl+/).
>    Sur la rangée des chiffres, sans Shift, la touche reste son chiffre : le « - » AZERTY
>    est Ctrl+6 (onglet 6, comme les navigateurs) ; Ctrl+- y est la touche « ) » (position
>    `Minus`) et le − du pavé ;
> 4. avec Shift, un symbole décalé US (`< > ? : _ + { } | ~`) est Shift + le caractère de sa
>    touche US (« { » = Shift+[), hors rangée des chiffres ;
> 5. sinon la position : chiffre de la rangée, lettre de la position (lettre non latine,
>    touche morte, ou caractère sans raccourci : la touche « ' » de l'hébreu est W),
>    caractère US d'une position de ponctuation (la touche « ! » d'AZERTY est « / »).
> Pas de table par disposition : `keyCode` n'apporte rien de plus sous Linux (WebKitGTK le
> déduit du caractère tapé) et la webview ne connaît pas la disposition active. Vérifié
> touche par touche pour us, fr, de, us(dvorak), il, gr, ru (valeurs xkeyboard-config,
> `src/test/layouts.ts`) : chaque défaut a une touche, une touche ne vaut qu'une combinaison.
> Les dispositions non latines suivent l'amendement #131 ci-dessous (positions US). QWERTZ
> reste ainsi (Ctrl+/ = Ctrl+Shift+7) ; sa touche « + » : amendement #132 ci-dessous.
> Ctrl+AltGr sous Linux (Ctrl seul, caractère d'AltGr) : sur la rangée des chiffres la touche
> reste son chiffre (AZERTY Ctrl+AltGr+5 « [ » = Ctrl+5) ; ailleurs le caractère compte
> (AZERTY Ctrl+AltGr+« ) » tape « ] » = Ctrl+], onglet suivant, au lieu de Ctrl+- avant).
> L'enregistreur des réglages ignore les touches mortes : AZERTY Ctrl+^ et QWERTZ Ctrl+´
> valent Ctrl+[ et Ctrl+= par position mais ne s'enregistrent pas.

> Amendement 2026-10-21 (#131) : sur une disposition non latine (russe, hébreu, grec…), la
> ponctuation se nomme par sa position US, comme dans les navigateurs et les applications
> GTK (les touches y portent les légendes US). La webview ne connaît pas la disposition
> active : un écouteur `keydown` de `window` en phase de capture (`installLayoutTracker`,
> installé une fois par `useShortcut` et l'enregistreur, avant leurs propres écouteurs)
> retient l'écriture de la dernière lettre tapée — une touche `KeyA`–`KeyZ` sans Shift (le
> niveau Shift de l'hébreu tape des capitales latines), sans Alt ni AltGr (niveaux
> variables), ni Meta (⌘ sur macOS : non vérifié ; la frappe simple suffit), Ctrl compris
> (GTK garde la lettre de la disposition dans `e.key`) ; non latine = `/^\p{L}$/u` hors
> `\p{Script=Latin}` (le « ı » turc reste latin) ; toute autre touche laisse l'état tel
> quel. État non latin : les étapes 3 et 4 sont sautées, l'étape 5 nomme par position
> (lettres comprises : la touche « / » de l'hébreu est Q). Russe : Ctrl+/ = la touche « / »
> (qui tape « . »), Ctrl+, = la touche « , » ; hébreu : Ctrl+/ = la touche « / » et non Q,
> Ctrl+[ / Ctrl+] à leurs positions US (plus inversés) ; grec : comme US, sa touche Q
> (« ; ») est Q. État latin : la règle #105 inchangée (repli par position de l'étape 5
> gardé : sans lui, Ctrl+W de l'hébreu n'aurait pas de touche avant la première lettre
> hébraïque ; coût : la touche « ' » de Dvorak et QWERTZ Ctrl+AltGr+Q valent aussi Ctrl+Q).
> L'enregistreur lit le même état au même moment. Limite : juste après un changement de
> disposition, l'état reste celui de l'ancienne jusqu'à la première lettre tapée (au
> démarrage : latin) ; par exemple sur Dvorak juste après le russe, Ctrl+, et Ctrl+/ n'ont
> pas de touche avant qu'une lettre soit tapée. Vérifié touche par touche pour les sept
> dispositions : dans les deux états, une touche ne vaut qu'une combinaison et
> l'enregistreur fait l'aller-retour ; chaque défaut a une touche dans l'état latin du
> démarrage et dans l'état que la disposition produit.

> Amendement 2026-10-21 (#132) : un « + » tapé sans Shift, hors rangée des chiffres, vaut
> Shift+= (« + » est Shift+= sur US) : Ctrl + la touche « + » agrandit la police. Nouvelle
> étape entre les étapes 2 et 3 de #105 (étape 3 de `keyPressOf`, les suivantes décalées),
> dans les deux états de #131 (QWERTZ juste après le russe garde le zoom ; aucune
> disposition non latine testée ne tape « + » sans Shift, le serbe cyrillique le tape en
> position US « = », qui agrandissait déjà). QWERTZ (de, comme l'italien et l'espagnol :
> « + » en position US « ] ») : Ctrl+« + » = Ctrl+Shift+= (police +) au lieu de Ctrl+]
> (onglet suivant) ; Ctrl+Shift+« + » (« * ») reste Ctrl+Shift+] par position
> (connexion suivante) ; Ctrl+] n'a plus de touche (« ] » est AltGr+9), l'onglet suivant
> reste Ctrl+Tab et Ctrl+PageDown. Nordiques (se, no, dk, fi : « + » en position US « - ») :
> Ctrl+« + » réduisait la police (Ctrl+- par position), il l'agrandit ; Ctrl+- reste la
> touche « - ». Portugais (« + » en position US « [ ») : Ctrl+« + » agrandit au lieu de
> Ctrl+[ (onglet précédent, qui garde Ctrl+Shift+Tab et Ctrl+PageUp). Rangée des chiffres
> inchangée : le « + » du tchèque (touche 1) reste Ctrl+1 ; le suisse tape « + » avec
> Shift+1 : Ctrl+Shift+1, sans défaut, pas le zoom (limite). Le balayage « chaque défaut a une touche » vérifie par
> action (au moins une combinaison accessible), avec une liste explicite par disposition des
> combinaisons sans touche et leur raison (de : Ctrl+]) ; une combinaison listée doit rester
> sans touche. us, fr, us(dvorak), il, gr, ru inchangés.

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

> Amendement 2026-10-21 (#110) : un bouton désactivé qui porte une info-bulle (`tip()`) est
> `aria-disabled="true"` (helper `softDisabled` de `src/lib/softDisabled.ts`), pas `disabled`
> natif : WebKitGTK peut ne donner aucun survol ni focus à un bouton `disabled`, et son
> info-bulle ne s'afficherait jamais. Il reste survolable et atteignable au clavier (Tab), son
> info-bulle s'affiche au survol et au focus, il paraît désactivé (`aria-disabled:` à côté de
> `disabled:`, curseur flèche) ; un clic, Enter ou Espace ne font rien (pas de soumission, pas
> de propagation). Concerne Back / Forward, Prev / Next, Discard / Preview / Commit, Sidebar,
> Database, Reload, Row details, le × d'onglet et de tuile, Split et Export. Restent en
> `disabled` natif : les états passagers (Run Current et son menu « ⌄ » pendant l'exécution,
> + Row pendant un commit, Delete du formulaire pendant un test, un enregistrement ou une
> connexion), le menu du mode sans échec quand sa connexion enregistrée n'existe plus (cas
> limite), les contrôles natifs (`<select>` du schéma) et les boutons sans info-bulle (Show
> all des colonnes, Edit / Reconnect du popover de connexion, Clear de l'historique, Undo
> des changements en attente, Refresh de la structure, boutons des dialogues).

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
