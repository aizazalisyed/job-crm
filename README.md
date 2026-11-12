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
For now, data lives in your browser's localStorage. Use **Settings > Export JSON backup** regularly.

## Moving to Firebase later
1. Create a Firebase project with Firestore and Authentication.
2. Paste the web config into `js/firebase-config.js` and set `enabled: true`.
3. Implement the `FirebaseAdapter` methods in `js/store.js` (`list`, `save`, `remove`, `replaceAll`, `getSettings`, `saveSettings`). The UI only calls these methods, so no other file needs to change.

## Run locally
Open `index.html` in a browser, or run `python3 -m http.server` in this folder.
