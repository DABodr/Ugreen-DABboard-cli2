# uGreen DAB Web Interface

Ce dépôt contient une interface web moderne pour piloter le module **uGreen DAB Board** sur Raspberry Pi.  Elle permet de scanner les blocs DAB (5A→13F), de sélectionner un multiplex, d’afficher les services disponibles et les métadonnées associées (DLS, DL+ et SLS).  Un journal des commandes et un vumètre audio optionnel facilitent l’analyse et le diagnostic.

## Prérequis

- Un Raspberry Pi (modèle 3, 4 ou 5) équipé d’une carte **uGreen DAB Board v5/v6**.
- Une installation de Raspberry Pi OS en version 32 bits ou 64 bits.
- Un accès à Internet pour télécharger les fichiers uGreen et Node.js.
- Des droits administrateur (sudo) pour installer des dépendances et accéder aux interfaces SPI/I²C.

## Installation du logiciel uGreen et de l’interface web

Pour simplifier l’installation, un script automatisé est fourni : **`ugreen_install.sh`**.  Ce script :

- Télécharge l’archive `Files_v12.zip` depuis le site uGreen et la décompresse dans `/usr/local/lib`.
- Choisit automatiquement la version correcte de `radio_cli` et `DABBoardRadio` en fonction de l’architecture du Raspberry Pi (ARM 32 bits ou 64 bits).
- Installe les bibliothèques nécessaires (`libncurses5`, `alsa-utils`, `wiringPi`) ainsi que Node.js.
- Déploie l’interface web dans `/opt/dab-web-interface` et crée un service systemd pour la lancer sur le port 9595.

Pour exécuter le script :

```bash
sudo ./ugreen_install.sh
```

Suivez les instructions affichées.  Après l’installation, redémarrez le Raspberry Pi pour que les groupes `spi` et `gpio` soient pris en compte.  L’interface sera accessible via :

```
http://<adresse_ip_du_pi>:9595/
```

⚠️ Les binaires uGreen (`radio_cli`, `DABBoardRadio`) sont distribués sous **licence propriétaire** : ils ne doivent pas être modifiés ni redistribués【109490326545304†L224-L233】.  Le script se charge de les télécharger depuis la source officielle sans les altérer.

## Activation de l’I²S (optionnel)

La carte uGreen peut transmettre un flux audio numérique via I²S, ce qui permet d’écouter le son par la sortie jack ou HDMI du Raspberry Pi ou de mesurer le niveau audio.  Pour activer cette fonctionnalité :

1. Vérifiez que votre noyau contient l’overlay `ugreen-dabboard.dtbo` et que les paramètres `i2c`, `i2s`, `spi` et `audio` sont activés dans `/boot/config.txt` ou `/boot/firmware/config.txt`【487981551829083†L64-L82】.  Rebootez le Raspberry Pi si nécessaire.
2. Démarrez `radio_cli` avec l’option `-o 1` pour activer l’I²S, puis utilisez `arecord -D sysdefault:CARD=dabboard -c 2 -r 48000 -f S16_LE -vv` pour capturer l’audio【487981551829083†L115-L126】.  Le vumètre de l’interface se base sur cette commande et nécessite que l’audio circule via I²S.

## Utilisation de l’interface

Une fois l’installation terminée et l’interface accessible dans le navigateur :

- Cliquez sur **« Lancer le scan »** pour rechercher les multiplex disponibles sur les blocs 5A → 13F.  Le rapport signal/bruit (SNR) s’affiche pour les blocs où un multiplex est détecté.
- Sélectionnez un bloc pour afficher la liste des services disponibles.
- Choisissez une station : les métadonnées DLS, DL+ et l’image SLS (le cas échéant) s’affichent.
- Cliquez sur **« Voir les logs »** pour consulter toutes les commandes envoyées et leurs réponses.
- Utilisez le sélecteur de thème pour passer du mode clair au mode sombre.
- Si l’I²S est activé, cliquez sur **« Afficher le vumètre »** pour visualiser le niveau audio en temps réel.

## Déploiement manuel des fichiers de l’interface

Si vous souhaitez copier manuellement les fichiers de l’interface dans un autre répertoire (par exemple `/opt/dab-web-interface`), un script **`deploy_interface.sh`** est fourni.  Ce script :

- Crée le dossier cible s’il n’existe pas (pour éviter l’échec du script).
- Copie `app.js`, `package.json` et le dossier `public` dans ce répertoire.

Utilisation :

```bash
chmod +x deploy_interface.sh
sudo ./deploy_interface.sh /opt/dab-web-interface
```

Cela remplacera les fichiers existants si le répertoire cible existe déjà.

## Support et contributions

Ce projet n’est pas affilié à uGreen.  Il vise à fournir une interface web conviviale pour leur matériel.  Les contributions (rapports de bugs, améliorations de l’interface) sont les bienvenues via des pull requests ou des issues GitHub.  Merci de consulter la [licence uGreen](https://ugreen.eu/) pour toute question juridique.
