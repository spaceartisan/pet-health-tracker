# Pet Health Tracker

A responsive web app for tracking the health and daily care of your pets. Works on mobile and desktop. No installation required.

**Live app:** https://spaceartisan.github.io/pet-health-tracker/

## Features

- Track weight, meals, medications, activity, mood, symptoms, vomit/diarrhea episodes, and vet visits
- Trend charts for weight, mood, activity, cost, and GI episodes (weekly)
- Search, edit, and delete individual logs
- Pet summary with care snapshot and stats
- Export data as CSV or JSON; import from JSON backup
- Fully responsive — bottom tab navigation on mobile

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

## Releasing updates

Every save carries the app's version (`_v`) and a new write stamp (`_w`). The rules refuse saves below `minVersion()`. A refused copy of the app keeps its changes on the device and shows a banner with a **Reload** button; after reloading, its unsent changes are merged in. The app also checks `version.json` when it's opened and when it comes back to the screen, and offers the update if a newer version is live.

**Most updates** (fixes, new features that don't change saved data): just push. Nothing else to change.

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
