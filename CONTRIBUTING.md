# Contributing to askBack

This is a Node.js (CommonJS) app. One process runs both the WhatsApp bot and
the admin web panel. Keep changes small and readable — several people work here.

## Module layout

```
server.js              Express app + starts the WhatsApp client
src/
  whatsapp/            Everything about the WhatsApp conversation
    client.js          Connects to WhatsApp (baileys), QR pairing, reconnect
    handler.js         Inbound message flow: decides when/what to reply
    answer.js          The brain: routes a question to the right answer path
    intent.js          Small text detectors ("is this a question?", etc.)
    history.js         Stores/loads chat messages (SQLite + in-memory)
    meetings.js        Summarize uploaded call/meeting recordings
    catchup.js         "Catch me up since Monday" time-window recaps
    digest.js          Scheduled 05:00 CAT morning briefing
    reminders.js       30-min-before deadline/meeting reminders
    groups.js          Which groups are allowed, group metadata
    share.js           Sending stored files back into a chat
    voice.js           Voice-note transcription + spoken replies
  ai/                  All model calls live here
    embeddings.js      OpenAI/OpenRouter client + embeddings + model names
    generator.js       Builds the prompt and calls the chat model
    search.js          Combines meaning-search + keyword-search
    language.js        Detects the user's language
  processor/           Turning uploaded files into searchable chunks
    ingest.js          Upload -> extract -> chunk -> embed -> store
    pdf/office/text/image/audio.js   One extractor per file type
    chunking.js        Splits long text into overlapping chunks
  db/
    index.js           Opens the SQLite database
    schema.js          Tables + default settings (safe to run every start)
    queries.js         All prepared statements + search functions
  admin/
    http.js            Base path + admin password auth
    routes.js          The web panel's JSON API
public/                The admin panel UI (plain HTML/CSS/JS)
```

## How answers work (the important flow)

`handler.js` receives a WhatsApp message, decides whether to respond, then calls
`answerQuestion()` in `answer.js`. That function checks intents in order and
returns the first match:

1. greeting / help / chitchat
2. meeting catch-up (newest recording summary)
3. time-window catch-up
4. file share request
5. document work (summarize / translate a named file)
6. a strong reused past answer (with the "already answered" note)
7. a fresh answer generated from knowledge + recent chat (with a source note)

Each returns `{ text, source, files, language }` or `null` to stay silent.

## Adding a new intent + answer path

1. Write a detector in `intent.js` (e.g. `isThingRequest(text)`) and export it.
2. In `answer.js`, `require` it and add an `if (isThingRequest(text)) { ... }`
   block at the right point in the order above. Return the standard object.
3. If it needs its own logic, put that in a new `src/whatsapp/<thing>.js`
   module with JSDoc'd exports (copy the shape of `catchup.js`).

## The settings pattern

All on/off features use one row in the `settings` table.

- Add a default in `schema.js` with `INSERT OR IGNORE ... VALUES ('my_flag', 'on')`.
- Add `getMyFlag()` / `setMyFlag()` helpers (see `getDailyDigest` in `digest.js`
  or `getRepeatNudge` in `answer.js`).
- Expose it in `admin/routes.js` `liveStats()` and add a
  `POST /api/my-flag` endpoint mirroring `/api/daily-digest`.
- Add a toggle row in `public/index.html` and wire it in `public/js/admin.js`
  with `wireSettingToggle('my-flag-toggle', '/api/my-flag')`.

## House rules

- 2-space indent, single quotes, CommonJS (`require` / `module.exports`).
- JSDoc every exported function: what it does and any non-obvious why.
- Never write `--`, em dashes, or en dashes into text the bot sends; the
  `polishAnswer` / `stripDoubleHyphens` helpers enforce this — run generated
  text through `polishAnswer`.
- Never expose raw WhatsApp JIDs or say "knowledge files" in a reply.
- Time math uses Africa/Maputo (CAT, UTC+2). Copy the helpers in `digest.js`.
- Do not commit secrets. `.env`, `auth_info/`, and the database stay local.

## Running locally

```bash
npm install
cp .env.example .env    # add OPENAI_API_KEY (or OPENROUTER_API_KEY)
npm start               # scan the QR, open http://localhost:3000
```
