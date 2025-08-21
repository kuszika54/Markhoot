# Kahoot Lite

Egyszerű, helyi hálózaton futó, böngészős kvíz app (Kahoot-szerű).

- Host / Admin nézet: játék létrehozása, kérdések betöltése, kérdés indítása és lezárása.
- Játékos nézet: csatlakozás PIN kóddal és névvel, válaszadás.
- 4 válaszlehetőség, 1 helyes. 30 mp időzítő. Max 50 játékos.
- Pontozás: helyes = 1 pont. Külön “leggyorsabb” logolása, plusz 0.5 bónusz pont a leggyorsabb helyes válasznak.
- Eredmények exportálhatók CSV-be.

## Futtatás

1) Telepítés:
```
npm install
```
2) Indítás:
```
npm start
```
3) A host gépen nyisd meg a böngészőt: `http://localhost:3000/host`.
4) A játékosok ugyanazon a LAN-on a host képernyőjén látható IP:port és PIN segítségével csatlakoznak.

## Kérdések

- Minta fájl: `questions.sample.json` (magyar példa).
- Saját kérdések: töltsd be admin/host nézetből JSON feltöltéssel, vagy cseréld a `questions.json`-t.

## Export

- A játék végén a host letöltheti a ponttáblát CSV formátumban.
