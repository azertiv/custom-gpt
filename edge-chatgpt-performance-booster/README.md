# ChatGPT Performance Booster

Extension Microsoft Edge / Chrome unpacked pour accelerer l'interface web de ChatGPT quand les conversations deviennent longues.

## Positionnement

Cette version remplace completement l'ancienne extension centree sur le relooking de l'interface.

Le nouveau socle est oriente performance:

- garde seulement les messages les plus recents dans le DOM
- masque les anciens messages pour reduire la charge memoire et le cout de rendu
- permet de recharger l'historique par batch avec `Afficher plus`
- reapplique automatiquement une fenetre glissante quand une conversation continue de grandir
- propose une popup pour regler l'optimisation
- peut reduire animations, transitions et flous couteux

## Reglages exposes

- activation / desactivation globale
- nombre de messages visibles
- taille du batch `Afficher plus`
- seuil avant declenchement de l'optimisation
- activation du badge in-page
- reduction des effets visuels couteux

## Installation dans Microsoft Edge

1. Ouvrir `edge://extensions`
2. Activer `Mode developpeur`
3. Cliquer sur `Charger l'extension non empaquetee`
4. Selectionner le dossier `edge-chatgpt-performance-booster`

## Fichiers principaux

- `manifest.json`
- `background.js`
- `content.js`
- `styles.css`
- `popup.html`
- `popup.css`
- `popup.js`
