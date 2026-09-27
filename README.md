# Schulcloud Exporter

A local, read-only archive for your own schul.cloud chats. / Ein lokales, schreibgeschütztes Archiv für deine eigenen schul.cloud-Chats.

<details open>
<summary><strong>Deutsch</strong></summary>

## Was das Projekt macht

Schulcloud Exporter liest Channels sowie aktive und archivierte Konversationen über einen [inoffiziellen stashcat-Client](https://github.com/dclausen01/stashcat-api/commit/8c179a6fba802019f7ed09b2419a68b7c0c458d2) seitenweise aus. Nachrichten und Beziehungen landen in SQLite. Anhänge und Profilbilder werden anhand ihres SHA-256-Hashes nur einmal unter `archive-data/blobs/` gespeichert. Eine Webansicht zeigt das Archiv auf `127.0.0.1`; JSON- und JSONL-Exporte erlauben die Weiterverarbeitung.

## Start

Voraussetzung: Node.js ab 24.15 und pnpm 11.11.0.

```sh
pnpm install --frozen-lockfile
pnpm sync
pnpm serve
```

Die Ansicht ist unter <http://127.0.0.1:4317> erreichbar. `pnpm sync` fragt E-Mail-Adresse, Account-Kennwort und Verschlüsselungskennwort verdeckt im Terminal ab. Die Zugangsdaten werden nicht in der Datenbank oder in Dateien gespeichert. Alternativ können `SCHULCLOUD_EMAIL`, `SCHULCLOUD_PASSWORD` und `SCHULCLOUD_SECURITY_PASSWORD` für den laufenden Prozess gesetzt werden.

Die Webansicht verwendet React, React Router, Tailwind CSS und Vite; die lokale API läuft mit Hono auf Node.js. Sie ist schreibgeschützt: Nachrichten, Chats und Dateien lassen sich nur lesen. Einzige Ausnahme ist der Import, den die Webansicht starten kann. Nachrichtentexte werden als Markdown dargestellt, inklusive Autolinks für die von den Beteiligten oft ohne Syntax eingefügten URLs. Da die Inhalte von anderen Personen stammen, rendert `react-markdown` direkt in React-Elemente statt über `dangerouslySetInnerHTML`; eingebettetes HTML bleibt inaktiv. Der Import läuft im Hintergrund; der Fortschritt kommt per Server-Sent-Events an die Oberfläche, sodass ein Neuladen einen laufenden Import wieder aufnimmt. Sind `SCHULCLOUD_EMAIL`, `SCHULCLOUD_PASSWORD` und `SCHULCLOUD_SECURITY_PASSWORD` gesetzt, nutzt der Import diese und der Browser sieht kein Kennwort. Andernfalls fragt der Dialog sie ab; sie gelten nur für diesen Lauf und werden nicht in die Datenbank oder auf die Platte geschrieben. Da der Import eine Anmeldung auslöst, akzeptiert die API ihn nur von `127.0.0.1`/`localhost` und nur als `application/json` — damit kann keine fremde Seite einen Import auf diesem Rechner auslösen. Die Auswahl orientiert sich an [Better T Stack](https://www.better-t-stack.dev/). Das bestehende SQLite-Archiv und der Importer bleiben kompatibel. Ein ORM oder eine Anmeldung würden für diesen lokalen Betrachter zusätzliche Migrationen und Angriffsfläche schaffen und sind deshalb nicht eingebaut.

Für die Entwicklung startet `pnpm dev` API und Webansicht zusammen; die Ausgaben beider Prozesse sind mit `api` und `web` gekennzeichnet. `pnpm dev:api` startet nur die API, `pnpm dev:web` nur Vite auf <http://127.0.0.1:5173>. `pnpm serve` erstellt zuerst den Produktions-Build. `pnpm typecheck` und `pnpm test` prüfen Typen und Archiv/API-Verhalten.

`pnpm export` erzeugt JSONL-Dateien für die normalisierten Tabellen in `archive-data/json-export/`, einschließlich `metadata` und `import_runs`. `pnpm repair` berechnet Zeitstempel, Konversationstitel sowie Lösch-, Anhangs- und Reaktionsstatus neu aus den gespeicherten API-Antworten, ohne Netzwerkzugriff. Der JSON-Download in der Webansicht exportiert jeweils einen Chat. Sichere für eine vollständige lokale Kopie das gesamte Verzeichnis `archive-data/`. Ein unterbrochener Import kann erneut gestartet werden; gespeicherte Nachrichten und Dateien werden wiederverwendet.

## Grenzen

Die Oberfläche orientiert sich am Messenger, bildet ihn aber nicht vollständig nach. Der Import hängt von einer inoffiziellen API ab. Prüfe nach jedem Lauf den Importstatus: Verschlüsselte Nachrichten können als `needs-review` markiert sein, und nicht mehr verfügbare Dateien oder verlassene Channels lassen sich nicht wiederherstellen. S3-Speicherung ist derzeit nicht eingebaut.

<details>
<summary><strong>Hinweise zu Daten, Verbindung und Gewährleistung</strong></summary>

Das Archiv und die Webansicht laufen lokal auf deinem Gerät. Für den Import verbindet sich das Programm mit `https://api.stashcat.com/`, dem vom schul.cloud-Webclient verwendeten API-Host, und lädt gegebenenfalls Dateien und Profilbilder. Es schreibt keine Nachrichten zurück und speichert die eingegebenen Kennwörter nicht. Deine exportierten Chats können sensible Daten anderer Personen enthalten: Bewahre `archive-data/` entsprechend geschützt auf und veröffentliche es nicht. Dieses unabhängige Projekt ist nicht mit schul.cloud oder stashcat verbunden. Es gibt keine Gewähr für Vollständigkeit, dauerhafte Kompatibilität oder Fehlerfreiheit.

</details>
</details>

<details>
<summary><strong>English</strong></summary>

## What it does

Schulcloud Exporter reads channels and active or archived conversations page by page through an [unofficial stashcat client](https://github.com/dclausen01/stashcat-api/commit/8c179a6fba802019f7ed09b2419a68b7c0c458d2). It stores messages and relationships in SQLite. Attachments and avatars are stored once by SHA-256 hash in `archive-data/blobs/`. A local web viewer runs on `127.0.0.1`, and JSON or JSONL exports support further processing.

## Get started

Requires Node.js 24.15 or newer and pnpm 11.11.0.

```sh
pnpm install --frozen-lockfile
pnpm sync
pnpm serve
```

Open <http://127.0.0.1:4317>. `pnpm sync` prompts for your email address, account password, and encryption password without echoing them. Credentials are not stored in the database or files. You may instead provide `SCHULCLOUD_EMAIL`, `SCHULCLOUD_PASSWORD`, and `SCHULCLOUD_SECURITY_PASSWORD` in the process environment.

The viewer uses React, React Router, Tailwind CSS, and Vite. Hono serves the local API on Node.js. It is read-only: messages, chats, and files can only be read. The one exception is the import, which the viewer can start. Message bodies render as Markdown, including autolinks for the bare URLs people often paste. Because the content comes from other people, `react-markdown` renders straight to React elements instead of going through `dangerouslySetInnerHTML`, and embedded HTML stays inert. An import runs in the background and reports progress over server-sent events, so reloading the page rejoins a run already in progress. With `SCHULCLOUD_EMAIL`, `SCHULCLOUD_PASSWORD`, and `SCHULCLOUD_SECURITY_PASSWORD` set, the import uses those and the browser never handles a password. Otherwise the dialog asks for them; they apply to that run only and are never written to the database or to disk. Because an import triggers a login, the API accepts one only from `127.0.0.1`/`localhost` and only as `application/json`, so no foreign page can start an import on this machine. The selection follows [Better T Stack](https://www.better-t-stack.dev/), while keeping the existing SQLite archive and importer compatible. An ORM and authentication would add migrations and unnecessary surface area to this local viewer, so they are not included.

For development, `pnpm dev` starts the API and the viewer together, with each process's output labelled `api` or `web`. Use `pnpm dev:api` for the API alone or `pnpm dev:web` for Vite alone on <http://127.0.0.1:5173>. `pnpm serve` builds the production viewer first. Use `pnpm typecheck` and `pnpm test` to check types and archive/API behavior.

`pnpm export` writes JSONL files for the normalized tables to `archive-data/json-export/`, including `metadata` and `import_runs`. `pnpm repair` recomputes message timestamps, conversation titles, and deletion/attachment/reaction state from the stored API responses without network access. The viewer can download JSON for an individual chat. Back up the entire `archive-data/` directory to preserve the full local archive. You can rerun an interrupted import; saved messages and files are reused.

## Limitations

The viewer resembles a messenger but does not reproduce every part of the original interface. Import relies on an unofficial API. Check the import status after each run: encrypted messages may be marked `needs-review`, and unavailable files or channels you have left cannot be recovered. S3 storage is not implemented yet.

<details>
<summary><strong>Data, network, and warranty notice</strong></summary>

The archive and viewer run locally on your device. Import connects to `https://api.stashcat.com/`, the API host used by the schul.cloud web client, and may download files and avatars. It does not send messages back or store the entered passwords. Exported chats may contain other people's sensitive data: protect `archive-data/` and do not publish it. This independent project is not affiliated with schul.cloud or stashcat. There is no warranty of completeness, ongoing compatibility, or error-free operation.

</details>
</details>

## Storage format / Speicherformat

| Table / Tabelle | Contents / Inhalt |
| --- | --- |
| `chats` | Channels, conversations, import status / Channels, Konversationen, Importstatus |
| `people` | Senders and local avatar references / Absender und lokale Profilbild-Verweise |
| `messages` | Text, time, sender, reply link, full API response / Text, Zeit, Absender, Antwortbezug, vollständige API-Antwort |
| `files`, `message_files` | Attachments and message links / Anhänge und Nachrichten-Zuordnung |
| `blobs` | Content-addressed file and image data / Inhaltsadressierte Dateien und Bilder |
| `import_runs` | Import attempt status / Status der Importversuche |

`raw_json` preserves API responses for future format improvements. / `raw_json` bewahrt API-Antworten für spätere Formatverbesserungen auf.
