# Hosting the demo page

The page is static: no server, no network calls, no keys. Nothing here deploys anything for you.

1. Run `npm install && npm run site`. See `Site ready: out/site/index.html`.
2. Open `out/site/index.html` by double-click (`file://`). See the four agents, their art and character sheets, the channel and the dry-run anchor table.
3. Upload the `out/site/` folder as is to any static host. Every link inside is relative, so a sub-path works too.
   - GitHub Pages: copy the folder contents to a branch or `docs/` folder and choose it under Settings, Pages. See the page at the URL GitHub shows.
   - Vercel static: `vercel out/site` (or import the repo with output directory `out/site` and build command `npm run site`). See the page at the deployment URL.
4. Open the hosted URL. See the same page as in step 2. The content is the mock demo (mocked inference, nothing signed).

`npm run site` rewrites `out/site/` on every run; it is gitignored and the output is deterministic. `npm run demo` still writes to `out/`.
