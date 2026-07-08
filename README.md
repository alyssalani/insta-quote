# Service Scheduler

A field-service quoting/scheduling app: a provider builds a quote, generates
a printable QR code for the property, and the customer scans it to book a
date/time. Provider and customer data is synced through Firebase Firestore,
so it works across devices (not just the same browser).

## How the QR code works

- Each quote gets a code like `SVC-AB1234`.
- The QR encodes a real URL: `https://<your-site>/?code=SVC-AB1234`.
- Scanning it opens the site and jumps straight into the booking screen for
  that code — no typing required. (Typing the code manually still works too,
  for anyone who can't scan.)
- If that code already has a booking, scanning it shows the existing
  appointment (with reschedule / change service / cancel) instead of letting
  someone book a second time.
- From the provider's **Quotes** tab, click **Show QR** → **Print QR Code**
  for a clean, printable card (QR + code + customer/address) with everything
  else hidden from the print output.

## 1. Create a Firebase project (free tier)

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Once created, click the **`</>`** (web) icon to register a web app. You
   don't need Firebase Hosting — this repo deploys to GitHub Pages instead.
3. Copy the `firebaseConfig` values shown (apiKey, authDomain, etc.) — you'll
   need them in step 3 and step 4.
4. In the left sidebar go to **Build → Firestore Database → Create database**.
   Start in **production mode** (the rules below lock it down properly).
5. Once created, go to the **Rules** tab and replace the contents with the
   rules from `firestore.rules` in this repo, then **Publish**.

## 2. Run it locally (optional but recommended first)

```bash
npm install
cp .env.example .env
# paste your Firebase config values into .env
npm run dev
```

Open the printed localhost URL. Create a quote as the Provider, click
**Show QR**, then open the customer flow in another tab/incognito window (or
scan it with your phone if your machine and phone are on the same network —
use `npm run dev -- --host` to make that possible) to confirm booking works
end-to-end.

## 3. Push this repo to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 4. Add your Firebase config as GitHub secrets

The deploy workflow needs your Firebase config at build time, but it
shouldn't be committed to the repo. In your GitHub repo:
**Settings → Secrets and variables → Actions → New repository secret**, and
add each of these (values from step 1.3):

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`

## 5. Turn on GitHub Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

That's it — the workflow in `.github/workflows/deploy.yml` already builds
and deploys on every push to `main`. Push a commit (or re-run the workflow
from the **Actions** tab) and your site will be live at:

```
https://<your-username>.github.io/<your-repo>/
```

Every QR code generated on the live site will encode that exact URL, so
codes printed from the deployed site will scan correctly on any phone.

> Using a custom domain or a `<username>.github.io` root/org site instead of
> a project site? Remove the `VITE_BASE` line from
> `.github/workflows/deploy.yml` (or set it to `/`) so paths aren't prefixed
> with a repo name that doesn't exist in the URL.

## Project structure

```
├── .github/workflows/deploy.yml   # builds + deploys to GitHub Pages on push
├── src/
│   ├── App.jsx                    # the whole app (provider + customer flows)
│   ├── firebase.js                # Firebase app init (reads VITE_* env vars)
│   ├── storage.js                 # Firestore-backed key/value storage
│   └── main.jsx                   # React entry point
├── firestore.rules                # paste into Firebase console → Rules
├── .env.example                   # local dev config template
└── vite.config.js
```

## Notes / next steps

- **Security rules** in `firestore.rules` allow anyone with your site URL to
  read/write booking data — there's no login system, which matches how the
  original app worked (the QR code/printed code is the only "access
  control"). Fine for an internal tool or small operation; if you want real
  access control, add Firebase Authentication and tighten the rules.
- **QR rendering** loads the `qrcodejs` library from a public CDN
  (cdnjs.cloudflare.com) at runtime — no extra install needed.
