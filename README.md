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

If you fork this project, replace the Firebase config in `index.html` with your own project's credentials, and set the following Firestore security rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /vaults/{code} {
      allow read, write: if true;
    }
  }
}
```

## Local Development

No build step needed. Serve the project root over HTTP (required for Firebase to work — `file://` URLs are blocked):

```bash
# Python
python -m http.server 8080
# then open http://localhost:8080
```
