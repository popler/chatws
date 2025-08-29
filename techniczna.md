# Dokumentacja techniczna – VLS Chat

## Architektura
System składa się z:
- **Frontend (index.html, admin.html)** – klient w przeglądarce (UI czatu, reakcje, moderacja).
- **Backend HTTP (server-http.js)** – obsługa API `/chat/api/join`, `/chat/api/admin/*`.
- **Backend WS (server-ws.js)** – obsługa WebSocket (real-time chat, presence, typing, reakcje).
- **Redis** – magazyn sesji, historii, rezerwacji nicków.

## Technologie
- Node.js (ESM, Express, ws, ioredis, bcrypt, JWT)
- Bootstrap 5.3 (frontend UI)
- Redis (pub/sub, sety użytkowników, historia)

## Procesy
- **server-http.js** (port 8081): wydaje tokeny JWT i udostępnia REST API.
- **server-ws.js** (port 8080): weryfikuje token JWT, utrzymuje sesje i wymienia wiadomości.

## Redis – klucze
- `chat:rooms` – zbiór aktywnych pokoi
- `chat:room:{room}:users` – zbiór userId w pokoju
- `chat:user:{id}` – hash z metadanymi usera
- `chat:audit:{room}` – lista ostatnich wiadomości
- `chat:room:{room}:name:{nick}:hold` – blokada nicka (unikalność)

## Pliki konfiguracyjne
- `.env` – ustawienia (`JWT_SECRET`, `REDIS_URL`, porty, CORS_ORIGIN)
- `admins.json` – lista adminów z hashami haseł bcrypt

