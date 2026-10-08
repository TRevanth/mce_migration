# Development guide

## Prerequisites
- Node.js 20+ (this machine uses a portable Node 24 in `%USERPROFILE%\tools\node`; it is not on PATH, so run `$env:PATH = "$env:USERPROFILE\tools\node;$env:PATH"` in each new PowerShell terminal).
- For real use: an MCE installed package (API Integration, server-to-server) with Data Extensions read access, and a Salesforce Connected App / External Client App with OAuth enabled.

## Setup
```powershell
npm install
Copy-Item .env.example server\.env   # then fill in values
```

`server/.env` values:

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Signs the session cookie. |
| `WEB_URL` | Where to send the browser after Salesforce login (default `http://localhost:5173`). |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | Salesforce app credentials. The secret is optional if the app allows PKCE without it. |
| `SF_LOGIN_URL` | `https://login.salesforce.com`, or `https://test.salesforce.com` for sandboxes. |
| `SF_REDIRECT_URI` | Must match the app's callback: `http://localhost:3001/api/sf/callback`. |
| `MCE_AUTH_BASE` | Test only. Points MCE auth at a mock instead of `https://{subdomain}.auth.marketingcloudapis.com`. |

Required OAuth scopes: `api`, `refresh_token`, `cdp_ingest_api`, `cdp_profile_api`, `cdp_query_api`.

## Run
```powershell
npm run dev       # API on :3001, web on :5173 (proxies /api to the API)
npm test          # mapper unit tests (vitest)
npm run build -w web
```

## Running without real credentials (mock MCE)
```powershell
node test/mock-mce.js                         # mock on :4010, three sample DEs
$env:MCE_AUTH_BASE = "http://localhost:4010"  # set before starting the server
npm run dev
```
Connect with any subdomain, client ID and secret. The mock provides: `Customers` (has a PK, a field needing a rename), `Orders 2024` (no PK, a date field), and `Has Blob` (unsupported `Blob` type). Salesforce steps need a real org, so the stream step shows the manual fallback.

## Project layout
```
server/src/index.js          routes and session
server/src/mce/client.js     MCE REST client
server/src/sf/client.js      Salesforce OAuth + Data Cloud calls
server/src/mapper/           typeMap.js, schema.js, yaml.js, mapper.test.js
web/src/App.jsx              wizard shell and shared state
web/src/steps/               Connect, Discover, Configure, Deploy
web/src/api.js               fetch wrapper for /api
test/mock-mce.js             local MCE stand-in
```

## Conventions
- Business rules (type mapping, naming, PK and category validation) live in `server/src/mapper` only. The UI displays what `/api/schema` returns and does not re-implement rules.
- Keep the mapper pure (no network, no session) so it stays unit-testable.
- Add a test in `mapper.test.js` for every new rule.
- Never log or return the MCE secret or Salesforce tokens.

## Testing status
- Mapper: 10 unit tests passing.
- Web build and the `/api/schema` endpoint: checked.
- Browser walkthrough against the mock (connect, discover, configure, deploy fallback, mobile width): started but not completed. Run it again before relying on the UI.
- MCE and Salesforce calls: not yet run against real accounts.

## Before the first real run (spike checklist)
1. Create an MCE installed package and note the subdomain, client ID, secret and MID.
2. In a sandbox org with Data Cloud, create an Ingestion API connector once in the UI.
3. Migrate one DE by hand: upload YAML, create the stream, confirm the DLO appears.
4. Compare the working stream with the body in `createDataStream` and correct it, or keep the manual fallback.
5. Test a DE with no PK and one with awkward field names.

## Troubleshooting
- `node` not found: add the portable Node to PATH (see Prerequisites).
- `MCE auth failed`: check subdomain, that the package type is server-to-server, and the MID if you use business units.
- Salesforce login returns "OAuth state mismatch": the session cookie was lost; restart the server and log in again (sessions are in memory).
- Stream creation returns a 4xx: expected until the request body is verified; use the manual steps shown.
