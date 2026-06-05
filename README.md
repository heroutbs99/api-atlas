# API Atlas

API Atlas is a static public API directory. It generates one JSON catalog from community-maintained sources, then renders a searchable page with category, access, source, and sorting controls.

No directory can literally contain every API on the internet. This project starts with broad public catalogs and keeps the update path simple so more sources can be added over time.

## Sources

- [APIs.guru](https://apis.guru/) for OpenAPI-backed public API definitions.
- [Public API Lists](https://public-api-lists.github.io/public-api-lists/) for curated free and developer-friendly APIs.

## Run Locally

```bash
npm run update:data
npm start
```

Then open the local URL printed by the server.

## Update The Catalog

Run this whenever you want to refresh the static JSON:

```bash
npm run update:data
```

The generated file lives at `data/apis.json`. Static hosts such as GitHub Pages, Netlify, Vercel, Cloudflare Pages, or S3 can serve the site without a backend.

## Add More Sources

Add a source in `scripts/update-data.mjs`, map it into the shared API record shape, and include it in the `records` array inside `main()`.
