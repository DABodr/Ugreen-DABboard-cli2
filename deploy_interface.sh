#!/bin/bash

# deploy_interface.sh – déploiement simplifié des fichiers de l’interface web uGreen
#
# Ce script copie les fichiers de l’interface (app.js, package.json et le
# répertoire public/) dans un dossier cible.  S’il n’existe pas, il sera
# créé afin d’éviter les erreurs d’installation.  Ce script est utile
# lorsque l’on souhaite mettre à jour ou déplacer l’interface sans
# relancer tout le processus d’installation uGreen.

set -e

# Dossier cible passé en argument, sinon /opt/dab-web-interface
TARGET_DIR="${1:-/opt/dab-web-interface}"

echo "Déploiement des fichiers de l’interface dans $TARGET_DIR"

# Chemin vers les fichiers sources (répertoire du script)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Vérifier l’existence du dossier cible et le créer si nécessaire
if [ ! -d "$TARGET_DIR" ]; then
  echo "Le répertoire cible n’existe pas, création…"
  mkdir -p "$TARGET_DIR"
  echo "Créé : $TARGET_DIR"
else
  echo "Le répertoire cible existe déjà, les fichiers seront mis à jour."
fi

# Copier les fichiers principaux
cp "$SCRIPT_DIR/app.js" "$TARGET_DIR/"
cp "$SCRIPT_DIR/package.json" "$TARGET_DIR/"

# Copier le dossier public en mode récursif.  On supprime d’abord l’ancien
if [ -d "$TARGET_DIR/public" ]; then
  rm -rf "$TARGET_DIR/public"
fi
cp -r "$SCRIPT_DIR/public" "$TARGET_DIR/"

echo "Déploiement terminé.  Les fichiers ont été copiés dans $TARGET_DIR."
echo "Vous pouvez maintenant lancer l’interface avec :"
echo "  node $TARGET_DIR/app.js"
