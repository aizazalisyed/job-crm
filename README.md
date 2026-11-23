<p align="center"><img src="assets/icon.svg" width="96" alt="My Job Tracker logo"></p>

<h1 align="center">Jarvis</h1>
<p align="center">Your personal AI assistant, with a built-in job application tracker.</p>


A personal tracker for job applications across target countries. It's a static site built with plain HTML, CSS and JavaScript, so there's no build step and it can be hosted on GitHub Pages.

## Features
- **Dashboard:** KPIs (applications, active, interviews, offers, response rate), pipeline by stage, applications by country, weekly trend, upcoming follow-ups and top matches by fit score
- **Pipeline:** a Kanban board where you drag cards between stages (Saved, Applied, Screening, Interview, Offer, Rejected, Withdrawn)
- **All jobs:** a sortable, filterable table (stage, country, priority, visa sponsorship) with CSV export
- **Follow-ups:** grouped into overdue, this week and later, with a sidebar badge for anything due
- **Contacts:** recruiters and hiring managers, linked to jobs
- **Settings:** target countries, JSON backup and import, sample data, and a light/dark theme

## AI Job Match and Apply
- Upload your CV once. Claude extracts your profile and your full CV.
- Search LinkedIn, Indeed, Glassdoor and Bayt (via Apify) in your target countries. Claude scores each job and reads the application deadline from the description. Applicants count comes from LinkedIn; anything unavailable shows N/A.
- **Apply** opens a panel where Claude tailors your CV to the job (reordering and rewording your real experience only, never inventing), writes a cover letter and form answers, and asks you for any missing details. Download the CV and letter as PDF or Word, open the application page, submit, then mark it as Applied.

## Data storage
Everything is stored in Cloud Firestore under your Google account, and nothing is saved in the browser:
- `users/{uid}/jobs`, `users/{uid}/contacts`
- `users/{uid}/meta/settings` (countries, CV profile, theme, search preferences)
- `users/{uid}/meta/matchResults` (last AI Job Match results)
- `users/{uid}/private/keys` (Claude API key and Apify token)

Firestore runs with an in-memory cache only. Access is restricted to the signed-in owner by `firestore.rules`.

## Firebase setup
1. Create a project at console.firebase.google.com.
2. Go to **Authentication > Sign-in method** and enable **Google**. Then go to **Authentication > Settings > Authorized domains** and add `aizazalisyed.github.io`.
3. Go to **Firestore Database > Create database** and start in **production mode**.
4. Go to **Firestore > Rules**, paste the contents of `firestore.rules`, and click **Publish**.
5. Go to **Project settings > Your apps** and add a **Web** app. Copy the config into `js/firebase-config.js` and set `enabled: true`.

## Run locally
Open `index.html` in a browser, or run `python3 -m http.server` in this folder.
