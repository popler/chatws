# Instrukcja użytkownika – VLS Chat

## Dołączanie do czatu
1. Otwórz stronę `index.html` z parametrami URL, np.:
   ```
   https://videolivesystem.pl/chat/index.html?room=demo&nick=TwojNick
   ```
2. Jeśli nie podasz nicka w URL, system zapyta Cię o niego w okienku modalnym.

## Wysyłanie wiadomości
- Wpisz tekst w polu na dole i naciśnij **Enter**, aby wysłać.
- Shift+Enter wstawia nową linię.
- Możesz dodać emoji przyciskiem 😊 lub za pomocą shortcode (np. `:heart:`).

## Reakcje
- Najedź na wiadomość i kliknij **+**, aby dodać reakcję.
- Kliknij istniejącą reakcję, aby zwiększyć jej licznik.

## Tryby wyświetlania
- **Top chat** – filtruje powtarzające się i mało istotne wiadomości.
- **Live chat** – pokazuje wszystkie wiadomości.

## Dla administratora
Po zalogowaniu jako admin (nick i hasło zapisane w `admins.json`):

- **PIN (nagłówek czatu):**
  1. Wpisz treść ogłoszenia w polu PIN na górze panelu admina.
  2. Kliknij **Wyślij**, aby ustawić ogłoszenie – pojawi się ono jako pasek nad wiadomościami.

- **Tryb wolny (Slow mode):**
  - Wybierz opóźnienie (np. 5s), aby ograniczyć częstotliwość wysyłania wiadomości przez użytkowników.

- **Czyszczenie czatu:**
  - Kliknij **Wyczyść**, aby usunąć wszystkie wiadomości z bieżącego pokoju.

- **Moderacja użytkowników:**
  - Kliknij nick użytkownika i wybierz akcję: Timeout (czasowe wyciszenie), Ban, Shadowban (ukrycie tylko lokalnie), Usuń wszystkie wiadomości.

