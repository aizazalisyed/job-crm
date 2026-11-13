# JobTrack CRM

A personal CRM for tracking job applications across target countries. It's a static site built with plain HTML, CSS and JavaScript, so there's no build step and it can be hosted on GitHub Pages.

## Features
- **Dashboard:** KPIs (applications, active, interviews, offers, response rate), pipeline by stage, applications by country, weekly trend, upcoming follow-ups and top matches by fit score
- **Pipeline:** a Kanban board where you drag cards between stages (Saved, Applied, Screening, Interview, Offer, Rejected, Withdrawn)
- **All jobs:** a sortable, filterable table (stage, country, priority, visa sponsorship) with CSV export
- **Follow-ups:** grouped into overdue, this week and later, with a sidebar badge for anything due
- **Contacts:** recruiters and hiring managers, linked to jobs
- **Settings:** target countries, JSON backup and import, sample data, and a light/dark theme

## Data storage
- **Local mode** (default): data lives in this browser's localStorage.
- **Firebase mode**: you sign in with Google, and data is stored in Cloud Firestore under `users/{uid}/...`, so it syncs across all your devices. On first sign-in, the app offers to upload any jobs saved in the browser.

## Firebase setup
1. Create a project at console.firebase.google.com.
2. Go to **Authentication > Sign-in method** and enable **Google**. Then go to **Authentication > Settings > Authorized domains** and add `aizazalisyed.github.io`.
3. Go to **Firestore Database > Create database** and start in **production mode**.
4. Go to **Firestore > Rules**, paste the contents of `firestore.rules`, and click **Publish**.
5. Go to **Project settings > Your apps** and add a **Web** app. Copy the config into `js/firebase-config.js` and set `enabled: true`.

## Run locally
Open `index.html` in a browser, or run `python3 -m http.server` in this folder.
