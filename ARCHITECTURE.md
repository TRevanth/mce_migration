# Architecture

## Purpose
A guided tool for Marketing Cloud Engagement (MCE) users moving to Marketing Cloud Next (Data Cloud). It covers the foundation step: turning Data Extensions (DEs) into Data Cloud data lake objects (DLOs) through an Ingestion API connector and data stream. DMO mapping, data loading, journeys and automations are out of scope for V1.

Flow: `MCE DE schema -> mapped schema (+ PK, category) -> OpenAPI YAML -> Ingestion API connector + data stream -> DLO auto-created`.

## Components

```
Browser (React wizard)
   |  /api/*  (Vite proxy in dev)
   v
Node/Express server  ---- client credentials ---->  MCE REST API
   |  session: MCE creds + Salesforce tokens          (auth host + REST host)
   |
   +---- OAuth (Web Server + PKCE) ---->  Salesforce org / Data Cloud (Connect REST /ssot/*)
```

| Part | Location | Responsibility |
|---|---|---|
| Wizard UI | `web/src` | Four steps (Connect, Discover, Configure schema, Create data stream). Holds selection and options in React state only. |
| API server | `server/src/index.js` | Routes, session, error wrapping. Secrets never reach the browser. |
| MCE client | `server/src/mce/client.js` | Token fetch and cache, list DEs, fields, row counts. |
| Salesforce client | `server/src/sf/client.js` | PKCE OAuth, generic authenticated fetch, data stream create and lookup. |
| Mapper | `server/src/mapper/` | Pure, deterministic logic: type map, name sanitizing, schema build and validation, YAML output. |
| Mock MCE | `test/mock-mce.js` | Local stand-in for MCE so the UI can be exercised without credentials. |

The server is required because MCE client secrets must not live in the browser and MCE's API is not meant for browser calls.

## Request flow

1. `POST /api/mce/connect` stores credentials in the server session after a test call to MCE.
2. `GET /api/sf/login` -> Salesforce authorize -> `GET /api/sf/callback` stores the access token in the session.
3. `GET /api/des` lists DEs; `GET /api/des/:id` returns fields and row count.
4. `POST /api/schema` takes the selected DEs plus user options and returns built schemas, issues and YAML. The UI calls it on every change, so the server is the single source of truth for validation.
5. `POST /api/stream` tries to create each valid stream via Salesforce. On rejection it returns the guided manual steps for that object.
6. `GET /api/stream/verify` lists data streams and matches by name.

## Mapper rules (`server/src/mapper`)

- **Types**: Text, EmailAddress, Phone, Locale -> string; Number, Decimal -> number; Boolean -> boolean; Date -> string with `date-time` format. Anything else is an error.
- **Names**: non-alphanumerics become single underscores, leading digits get an `f_` prefix, collisions get `_2`, `_3`. Each rename is reported as a note.
- **Primary key**: explicit choice, else the single MCE key, else error. Composite keys must be resolved by the user. A synthetic `record_id` can be added; the source must populate it at load time.
- **Category**: Profile, Engagement or Other. Engagement requires a date field as the event time.
- A schema is `valid` only when it has no error-level issues. Only valid schemas go into the YAML and the stream step.
- Primary key, category and event time are not part of the YAML. They are set when the data stream is created.

## Data stream creation and fallback
The request body for creating an Ingestion API data stream (`createDataStream` in `server/src/sf/client.js`) is the least certain part of the design and has not been verified against a real org. If Salesforce rejects the call, the UI shows manual steps (upload the YAML to the connector, create the stream, set category, key and event time, then Verify). The connector itself is created once in the Salesforce UI.

## Security notes
- MCE secret and Salesforce tokens live only in the server session (in-memory store, dev only). A production deployment needs a persistent store and encrypted secrets per tenant.
- The session cookie is `httpOnly`, `sameSite=lax`. Set a real `SESSION_SECRET`.
- The tool only reads from MCE and only creates data streams in Data Cloud. It does not delete or alter existing objects.

## Known limits and open questions
- Stream creation by API is unconfirmed (see above).
- The native Marketing Cloud connector in Data Cloud may ingest DEs directly and could replace this path for some DEs. Not evaluated.
- No data loading, DMO mapping, relationships or sendable-DE links.
- Dates: MCE stores server time without DST; normalization to UTC is not applied yet.
- Large DE lists are paged at 100 per call; large field counts are not batched.
