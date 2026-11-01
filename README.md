# Todolist (Go, bibliothèque standard uniquement)

Application web de todolist, 100 % locale, sans aucune dépendance externe.

## Emplacement des fichiers

Le programme lit toujours ses fichiers dans `C:\Logiciels\Todo`, quel que soit
l'endroit où se trouve l'exécutable :

    C:\Logiciels\Todo\static\          (index.html, style.css, app.js)
    C:\Logiciels\Todo\todolist.json     (créé automatiquement)

Copiez donc le dossier `static` de ce projet dans `C:\Logiciels\Todo\`.
Le dossier `C:\Logiciels\Todo` est créé s'il n'existe pas.
Les modifications de `static` sont prises en compte en rechargeant la page
(pas besoin de recompiler).

## Compiler et lancer

    go build -o todo.exe .
    todo.exe

Puis ouvrir http://127.0.0.1:8080

Options : `-addr 127.0.0.1:9000` et `-dir D:\autre\dossier`.
