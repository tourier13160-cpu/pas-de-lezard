# Pas-de-Lézard — back-end (version MySQL)

Jeu gratuit où l'on gagne au mérite : chaque vague réunit jusqu'à 500 joueurs autour de 2 énigmes visuelles cachées dans une boutique partenaire. Aucun téléphone pour jouer ; le numéro n'est demandé qu'aux gagnants, pour la remise du lot.

**Version MySQL** — conçue pour l'hébergement mutualisé Hostinger Business (pas de compilation native à l'installation).

---

## 1. Pourquoi MySQL et pas SQLite

La version précédente utilisait `better-sqlite3`, qui se compile à l'installation via `node-gyp`. C'est la dépendance qui échoue le plus souvent sur les hébergements mutualisés, et c'est exactement ce que le déploiement Hostinger déclenche automatiquement (`npm install`).

Cette version n'utilise plus que **trois dépendances purement JavaScript** — `express`, `mysql2`, `dotenv` — donc **aucune compilation**, donc rien qui puisse échouer à l'installation.

---

## 2. Variables d'environnement à déclarer dans Hostinger

| Variable | Exemple | Rôle |
|---|---|---|
| `PORT` | `3000` (ou le port fourni par Hostinger) | Port d'écoute |
| `DB_HOST` | `localhost` | Serveur MySQL (souvent `localhost` chez Hostinger) |
| `DB_PORT` | `3306` | Port MySQL |
| `DB_USER` | `u139496838_lezard` | Utilisateur de la base |
| `DB_PASSWORD` | *(fourni par Hostinger)* | Mot de passe de la base |
| `DB_NAME` | `u139496838_lezard` | Nom de la base |
| `ADMIN_TOKEN` | une longue chaîne aléatoire | Mot de passe de l'API admin |
| `IP_SALT` | une autre chaîne aléatoire | Anonymisation des IP (anti-multicompte) |
| `TRUST_PROXY` | `1` | À mettre à `1` si le serveur est derrière un proxy |
| `MAX_PLAYERS_PER_IP` | `3` | Inscriptions max par connexion, par vague |
| `DEV_MODE` | `1` puis `0` | `1` = routes de test + code SMS renvoyé dans la réponse |
| `SMS_PROVIDER` | `console` ou `twilio` | `console` affiche le code dans les logs |

Les valeurs `DB_*` se trouvent dans `hpanel` → **Bases de données** → votre base → *Informations de connexion*.

---

## 3. Créer la base MySQL

Dans `hpanel` → **Bases de données** :

1. Créez une base de données (elle est préfixée automatiquement, ex. `u139496838_lezard`).
2. Créez un utilisateur et **associez-le à la base** avec tous les privilèges. C'est l'étape qu'on oublie le plus souvent : sans association, la connexion est refusée.
3. Notez les quatre valeurs `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.

**Aucune table à créer à la main.** Le serveur crée lui-même le schéma au démarrage (`CREATE TABLE IF NOT EXISTS`), puis insère le jeu de démonstration si la base est vide.

---

## 4. Déployer

### Option A — depuis GitHub (ce que l'outil Hostinger attend)

1. Poussez ce dossier sur un dépôt GitHub (privé de préférence).
2. Dans `hpanel` → **Sites web** → votre application Node.js, renseignez l'URL du dépôt et la branche `main`.
3. Dans les variables d'environnement de l'application, collez les valeurs du tableau ci-dessus.
4. Lancez le déploiement.

Hostinger exécute `npm install` automatiquement puis `npm start` — les deux commandes déclarées dans `package.json`.

### Option B — téléversement direct

Si l'interface accepte un dépôt de fichiers, envoyez le contenu de ce dossier (sans le dossier parent) puis déclarez le point d'entrée `src/server.js`.

---

## 5. Point d'entrée

- **Fichier lancé par `npm start`** : `src/server.js`
- **Commande de démarrage** : `node src/server.js`

Ce sont les deux informations que le support Hostinger a demandé de vérifier avant de déployer.

---

## 6. Tester

1. Ouvrez `app.pas-de-lezard.fr` (ou l'adresse fournie par Hostinger).
2. Code d'accès testeur : `LEZARD2026`.
3. Au tout premier démarrage, la console affiche `[seed] Partenaire + 6 énigmes + 1 vague de test` avec une vague qui démarre 5 minutes plus tard.
4. Pseudo + captcha → salle d'attente → bouton **« Ouvrir la porte maintenant »** → répondez aux 2 énigmes → **« Simuler le tirage »**.

Les réponses du jeu de démonstration sont dans `src/db.js` : vert, 85, 6, bienvenue, 29, paris.

---

## 7. Administration

Toutes les routes exigent l'en-tête `x-admin-token: <ADMIN_TOKEN>`.

```bash
TOKEN=votre_token
BASE=https://app.pas-de-lezard.fr

# Partenaire
curl -s -X POST $BASE/api/admin/partners -H "x-admin-token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Fromagerie du Coin","shop_url":"https://fromagerie-exemple.fr"}'

# Énigme
curl -s -X POST $BASE/api/admin/puzzles -H "x-admin-token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"partner_id":2,"question":"Quelle couleur porte l etiquete du comte ?","answers":["rouge","rouge fonce"]}'

# Vague (start_at en UTC, format ISO 8601)
curl -s -X POST $BASE/api/admin/waves -H "x-admin-token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"partner_id":2,"start_at":"2026-10-01T18:00:00Z","duration_min":15,"prizes_count":10,"qualification_seconds":300}'

# Statistiques (le tableau à montrer au partenaire)
curl -s $BASE/api/admin/waves/1/stats -H "x-admin-token: $TOKEN"

# Tirage : random (recommandé) ou chrono
curl -s -X POST $BASE/api/admin/waves/1/draw -H "x-admin-token: $TOKEN" \
  -H 'Content-Type: application/json' -d '{"mode":"random"}'
```

---

## 8. Ce que le serveur décide (et que le navigateur ne peut pas falsifier)

| Élément | Décision |
|---|---|
| Heure de référence | `GET /api/time` — le client s'y synchronise |
| Chrono du joueur | Horodatage à la **réception** de la réponse, jamais envoyé par le client |
| Énigmes | 2 tirées au hasard par joueur dans le pool du partenaire ; les réponses ne quittent jamais le serveur |
| Places restantes | Comptées en base |
| Qualification | Fenêtre de temps + plancher humain + tentatives, calculés serveur |
| Anti-multicompte | 3 inscriptions max par IP hachée, par vague |
| Tirage des lots | `POST /api/admin/waves/:id/draw` |

---

## 9. Passer en production

1. `DEV_MODE=0` — ferme `/api/dev/*` et cesse de renvoyer le code SMS dans la réponse.
2. `SMS_PROVIDER=twilio` + identifiants Twilio.
3. `ADMIN_TOKEN` et `IP_SALT` : valeurs longues et uniques.
4. Retirer l'écran de verrouillage bêta de `public/index.html`.
5. Compléter tous les champs `[entre crochets]` des mentions légales.
6. HTTPS : Hostinger l'installe automatiquement après la propagation DNS du sous-domaine.
7. Sauvegardes : celles de l'hébergement couvrent la base MySQL.

---

## 10. Structure

```
.
├── package.json          # express + mysql2 + dotenv (aucune compilation)
├── .env.example
├── README.md
├── public/
│   └── index.html        # front v4, branché sur l'API
└── src/
    ├── server.js         # point d'entrée de npm start
    ├── db.js             # pool MySQL, schéma, jeu de démonstration
    ├── lib/util.js       # phases de vague, normalisation, débit, captcha
    ├── services/sms.js   # console | Twilio
    └── routes/
        ├── public.js     # API joueur
        └── admin.js      # API administrateur
```

## 11. Reste à faire

- Interface d'administration web (aujourd'hui : `curl`).
- Envoi réel des alertes email.
- Écran de classement en direct (le flux existe : `GET /api/waves/:id/leaderboard`).
- Export CSV des gagnants.
- Purge programmée des données (pseudos, IP hachées, numéros après remise).
