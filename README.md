# Pet Health Tracker

A responsive web app for tracking the health and daily care of your pets. Works on mobile and desktop, and can optionally be installed to a phone home screen as a standalone web app (PWA).

**Live app:** https://spaceartisan.github.io/pet-health-tracker/

## Features

- Track weight, meals, medications, activity, mood, symptoms, vomit/diarrhea episodes, and vet visits
- Trend charts for weight, mood, activity, cost, and GI episodes (weekly)
- Search, edit, and delete individual logs
- Pet summary with care snapshot and stats
- Daily Routine quick logging, including how long it has been since each routine item was last logged
- Export data as CSV or JSON; import from JSON backup
- Fully responsive — bottom tab navigation on mobile

## Install on a phone

The GitHub Pages site is a Progressive Web App (PWA). Installing it is optional and does not create a separate data store.

- **iPhone/iPad:** open the site in Safari → **Share** → **Add to Home Screen** → **Add**.
- **Android/Chrome:** open the site → browser menu → **Install app** or **Add to Home screen**.

When launched from the home-screen icon, the tracker opens in a standalone app window. The service worker caches the local app shell and, after an online launch, caches static CDN/font assets as they are used. Local logging can still open without a connection; cloud sync requires network access. If the chart library has never been loaded before an offline launch, the tracker stays usable and simply hides trend charts until it is online.

## Cloud Sync

Data is stored in the browser's `localStorage` by default. To sync across devices:

1. Click **☁ Cloud sync** in the header (or the "More" menu on mobile)
2. Click **Generate a new code** — you'll get an 8-character code (e.g. `K7MX4PQN`)
3. Save that code somewhere safe (Notes, password manager, etc.)
4. On any other device, click **☁ Cloud sync** → enter your code → your data loads

The sync code is the only credential — there is no account or password. Anyone who has your code can read and overwrite your data, so keep it private.

## Tech Stack

- Vanilla HTML/CSS/JS — no framework, no build step
- [Chart.js](https://www.chartjs.org/) for trend charts (CDN)
- [Firebase Firestore](https://firebase.google.com/docs/firestore) for cloud sync (CDN)
- Fonts: Fraunces + Geist via Google Fonts
- Hosted on GitHub Pages

## Firebase Setup (self-hosting)

If you fork this project, replace the Firebase config in `index.html` with your own project's credentials, and set the Firestore security rules from `firestore.rules` in this repo (Firebase Console → Firestore Database → Rules → paste → Publish):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Oldest app version allowed to save. Keep it equal to DATA_VERSION in the
    // index.html that's live. Only raise it AFTER the new version is live.
    function minVersion() {
      return 2;
    }

    // A vault document is well-formed
    function isValidVault(data) {
      return data.keys().hasOnly(['pets', 'records', '_email', '_createdAt', '_v', '_w'])
          && data.pets is list
          && data.pets.size() <= 50
          && data.records is list
          && data.records.size() <= 5000
          && (!('_email' in data) || (data._email is string && data._email.size() <= 254))
          && (!('_createdAt' in data) || data._createdAt is string);
    }

    // Every save from a current copy of the app carries its version (_v) and
    // a new write stamp (_w). Older copies don't, so their saves are refused.
    function isCurrentApp(data) {
      return data.get('_v', 0) is number
          && data.get('_v', 0) >= minVersion()
          && data.get('_w', '') is string
          && data.get('_w', '') != '';
    }

    match /vaults/{code} {
      // Code must be exactly 8 chars from the unambiguous alphabet
      function isValidCode() {
        return code.matches('^[A-HJ-NP-Z2-9]{8}$');
      }

      allow get: if isValidCode();

      allow create: if isValidCode()
                    && isValidVault(request.resource.data)
                    && isCurrentApp(request.resource.data);

      // Updates must also bring a new write stamp, and can't change _createdAt
      allow update: if isValidCode()
                    && isValidVault(request.resource.data)
                    && isCurrentApp(request.resource.data)
                    && request.resource.data._w != resource.data.get('_w', '')
                    && (!('_createdAt' in resource.data)
                        || request.resource.data._createdAt == resource.data._createdAt);

      // No listing the whole collection, no deleting via the app
      allow list, delete: if false;
    }
  }
}
```

**Do not use `allow read, write: if true`.** That lets anyone list and download every vault in the database.

These rules:
- block reading the collection as a whole, so a vault can only be opened by someone who knows its exact code
- reject saves that don't match the app's data shape
- reject saves from out-of-date copies of the app (see below)

If you add a new top-level field to the saved data, add it to the `hasOnly([...])` list or cloud saves will be rejected.

## Files

| File | What it is |
|---|---|
| `index.html` | The page's markup, plus a tiny inline script that applies the saved color theme before the page draws |
| `styles.css` | All styles, including the Garden, Night and Ocean themes |
| `app.js` | All app code |
| `version.json` | The live data version, checked by the app to offer updates |
| `manifest.webmanifest` | PWA name, colors, launch behavior and install icons |
| `sw.js` | Service worker that caches the same-origin app shell for install/offline launch |
| `icons/` | Home-screen and maskable PWA icons |
| `firestore.rules` | A copy of the Firebase security rules (keep it matching the console) |
| `tests/` | Automated tests; see `tests/README.md` |

**Start-up code goes in `init()`**, at the end of `app.js`. It's called on the last line, after every setting and function above it has been defined. Don't add loose statements that run code elsewhere in the file: running code before a setting further down had its value caused several bugs.

## Releasing updates

Every save carries the app's version (`_v`) and a new write stamp (`_w`). The rules refuse saves below `minVersion()`. A refused copy of the app keeps its changes on the device and shows a banner with a **Reload** button; after reloading, its unsent changes are merged in. The app also checks `version.json` when it's opened and when it comes back to the screen, and offers the update if a newer version is live.

**Every update:** in `index.html`, bump the `?v=` number on both `styles.css?v=…` and `app.js?v=…` (e.g. `5.0` → `5.1`). Also bump `SHELL_CACHE` and the matching `styles.css?v=…` / `app.js?v=…` entries in `sw.js`. Browsers then fetch the new files together instead of mixing a new page with an old cached script. The tests check the two numbers match.

**Most updates** (fixes, new features that don't change saved data): bump `?v=`, run the tests, push. Nothing else to change.

**Updates that older copies must not save alongside** (e.g. a change to how logs are stored):

1. In `index.html`, bump `DATA_VERSION`. Set `"version"` in `version.json` to the same number.
2. Push, and wait for the new version to be live on GitHub Pages.
3. In the Firestore rules, set `minVersion()` to the same number and Publish.

Always do step 3 last. Publishing the rules first would refuse saves from every user until they reload.

## Local Development

No build step needed. Serve the project root over HTTP (required for Firebase to work — `file://` URLs are blocked):

```bash
# Python
python -m http.server 8080
# then open http://localhost:8080
```


### Structured food intake and quick foods (data v6)

Food logs can optionally record an amount and unit (can, pouch, cup, serving, piece, g, oz, kg, or lb). Each pet can keep up to 30 reusable food presets with a default amount/unit, optional package net weight, and an optional calorie declaration such as 90 kcal per can, 110 kcal per 100 g, or 3,700 kcal per kg. The app stores the calculated kcal on the log so historical intake does not change if a preset is edited later. Package weight enables conversions between a can/pouch and mass units. Legacy food-name-only logs remain valid.
