# VLS Chat

Czat w stylu YouTube z trybem Top Chat, reakcjami i moderacją.

## Uruchomienie
1. Skopiuj repozytorium na serwer.
2. Zainstaluj zależności:
   ```bash
   npm install
   ```
3. Uruchom backend:
   ```bash
   node server-http.js &
   node server-ws.js &
   ```
4. Skonfiguruj Nginx jako reverse proxy (SSL, CORS).

## Struktura
- `index.html` – główny czat
- `admin.html` – panel administracyjny
- `server-http.js` – API HTTP
- `server-ws.js` – WebSocket
- `docs/` – dokumentacja użytkownika i techniczna

