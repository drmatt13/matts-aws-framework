# Studio browser regression suite

Run from the repository root:

```sh
npm exec --workspace framework-studio -- playwright install chromium firefox webkit
npm --workspace framework-studio run test:browser
```

The suite builds the real production entry and an independent Board/shared-component
gallery, then starts strict-port Vite previews on `127.0.0.1:4592` and `:4593`.
It never starts the Studio application server. Each test has a fresh browser context.
Every API operation, EventSource event and WebSocket connection uses explicit,
sanitized fixtures. Unknown API/external requests fail the test. The metadata in
the test HTML is synthetic and uses the actual shared protocol version.

Chromium checks light and dark themes, screenshots, keyboard interaction, errors,
draft/review boundaries and accessibility. Firefox and WebKit run the six-route
navigation smoke check. Screenshots are platform-specific; the checked-in originals
were captured with Playwright 1.64.1 Chromium on macOS arm64. Other platforms need
an explicitly reviewed baseline instead of comparing different font rasterizers.
Reference changes require visual review; do not automatically accept them to make
a migration green. A missing baseline fails a normal verification run.
Map captures read the existing camera/viewport diagnostics until they remain stable
for 250ms, covering the application's 180ms aspect-layout debounce. Inspector
references were reviewed and captured again from the same frozen original assets
after this timing correction; no references use migrated output.

Rendered layout assertions cover the 560px/760px navigation transitions, 800px panel
transition, 1100px toolbar transition, named inspector containers around 300px,
360px and 420px, a 380px panel, forced colors, and coarse input with DPR 2. These
are finite acceptance cases, not a claim that every browser/device was exercised.

The second-pass specs also traverse all eleven creation forms, populated Cognito
subsections and six user/group actions, federation branches, retention/reference
reviews, IAM simulation, managed DNS review, frontend/deployment source reviews,
Database subsection/SQL/init dialogs, short-phone resources, and WebSocket
loading/error/manual recovery and message history. They attach screenshots and
geometry receipts for expanded states. Assertions check readable labels and table
columns, keyboard scrolling, pointer input, bounded controls, mobile approval
footers, and dialog transitions. Approval flows stop before applying or publishing.

One accessibility issue predates this migration: the gallery's **Modified** sample
has the existing `#0e7c86` text on `#edefea` paper at 12px/500. The axe helper allows
only that exact node, text, foreground, background and typography in the gallery
and attaches its receipt. It does not disable the contrast rule or permit new
violations elsewhere. Improving that existing token use is separate follow-up.

`assets/fonts/` pins the seven Latin faces the application requests. `sources.json`
records original URLs and SHA-256 values; upstream OFL licenses accompany the files.
The font stylesheet and binaries are fulfilled locally, so Google availability,
font cache state and fallback-font timing cannot change screenshot geometry.

Original migration references were captured from commit `69dbe222` before the
Tailwind source changes. The one-off `STUDIO_BROWSER_BASELINE=1` option previews
the frozen original app/gallery under the ignored
`.framework/artifacts/studio-tailwind-baseline/` directory without rebuilding.
Those local artifacts are not required by the normal suite and are not committed.

Layout measurements, fixture request logs, failure screenshots and traces go under
`output/playwright/studio/`. Sources and screenshot references stay under this
directory; generated gallery output is ignored. The root `npm run verify` remains
the offline unit/type/generation gate; run this browser suite separately.
