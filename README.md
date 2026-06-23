# Class One Booking API

This is the new backend API for moving the Class One booking app from Google Sheets to Neon PostgreSQL.

The current safe migration plan is:

1. Keep the existing Google Sheets HTML app as backup.
2. Deploy this API to Vercel.
3. Store live data in Neon.
4. Import old Google Sheet data one time.
5. Stop normal Google Sheet pull/push.

## Files

- `api/health.js` - API and database health check.
- `api/state.js` - load/save the whole app state to Neon.
- `api/state-chunk.js` - chunked load/save for large app state.
- `api/audit.js` - read/write audit log entries.
- `db/schema.sql` - full Neon PostgreSQL table setup.
- `.env.example` - environment variable template.

## Vercel Environment Variables

Add these in Vercel Project Settings > Environment Variables:

```text
DATABASE_URL=your Neon connection string
API_SECRET=your private API key
ALLOWED_ORIGINS=https://class-one-yls.github.io,http://localhost:8766,http://localhost:8776,http://localhost:8780,null
```

Do not put `DATABASE_URL` into `index.html` or any public GitHub Pages file.

## Suggested API Secret

Use the API secret given by Codex in the chat, or generate a new long random password.

## Neon Setup

1. Open Neon.
2. Open the SQL Editor for the Class One project.
3. Paste everything from `db/schema.sql`.
4. Run it once.

The API can auto-create the two minimum tables it needs, but running `db/schema.sql` prepares the full business database.

## Endpoints

### `GET /api/health`

No API key required.

Optional database test:

```text
GET /api/health?db=1
```

### `GET /api/state`

Headers:

```text
X-API-Key: your private API key
```

Returns the latest app state:

```json
{
  "ok": true,
  "key": "production",
  "data": {},
  "version": 1,
  "updatedAt": "2026-06-23T00:00:00.000Z"
}
```

### `PUT /api/state`

Headers:

```text
Content-Type: application/json
X-API-Key: your private API key
```

Body:

```json
{
  "key": "production",
  "data": {
    "teachers": [],
    "students": [],
    "bookings": []
  },
  "updatedBy": "admin",
  "expectedVersion": 1
}
```

`expectedVersion` is optional. When used, it prevents another device from overwriting newer data silently.

### `GET /api/audit`

Headers:

```text
X-API-Key: your private API key
```

Returns latest audit rows.

## Local Check

After installing dependencies:

```bash
npm install
npm run check
```

## Next Migration Step

After Vercel is deployed, update the HTML app so:

- old Google Sheets buttons become one-time import only
- auto-load reads `/api/state`
- auto-save writes `/api/state`
- audit log can read `/api/audit`

## Large State Support

The app uses `/api/state-chunk` when saving/loading large data. This avoids browser/Vercel request limits by splitting the app state into smaller chunks.

Chunk flow:

```text
POST /api/state-chunk mode=init
POST /api/state-chunk mode=chunk
POST /api/state-chunk mode=complete
GET  /api/state-chunk?key=production
GET  /api/state-chunk?key=production&version=1&chunk=0
```
