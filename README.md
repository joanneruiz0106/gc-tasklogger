# GC Field Task Logger

A mobile-friendly voice-to-Google Sheets task logger for Garratt-Callahan field reps.

## Features
- 🎙️ Voice dictation (Chrome Android / Safari iOS)
- ✨ AI cleanup via Claude API
- 📊 Direct sync to Google Sheets "Friday Report" tab
- 👤 Each rep signs in with their own Google account

---

## Setup Instructions

### Step 1 — Google Cloud Console
1. Go to https://console.cloud.google.com
2. Create a new project (e.g., "GC Task Logger")
3. Go to **APIs & Services → Library**
4. Enable **Google Sheets API**
5. Enable **Google Drive API**

### Step 2 — Create OAuth Client ID
1. Go to **APIs & Services → Credentials**
2. Click **+ Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Name: GC Task Logger
5. Under **Authorized JavaScript Origins**, add:
   - `https://your-app-name.vercel.app` (your Vercel URL after deploy)
   - `http://localhost:5173` (for local testing)
6. Click **Save** — copy the Client ID

### Step 3 — Deploy to Vercel (Free)
1. Go to https://github.com and create a new repository called `gc-tasklogger`
2. Upload all files from this folder to the repo
3. Go to https://vercel.com → Sign up free → **Add New Project**
4. Import your GitHub repo
5. Under **Environment Variables**, add:
   - Key: `VITE_GOOGLE_CLIENT_ID`
   - Value: your Client ID from Step 2
6. Click **Deploy** — Vercel gives you a URL like `https://gc-tasklogger.vercel.app`
7. Go back to Google Cloud → your OAuth Client → add that Vercel URL to Authorized JavaScript Origins

### Step 4 — Add to Phone Home Screen
**iPhone (Safari):**
1. Open your Vercel URL in Safari
2. Tap the Share button → **Add to Home Screen**

**Android (Chrome):**
1. Open your Vercel URL in Chrome
2. Tap the 3-dot menu → **Add to Home Screen**

---

## Local Development
```bash
npm install
cp .env.example .env.local
# Edit .env.local with your Client ID
npm run dev
```

## For Each Team Member
1. Open the app URL on their phone
2. Tap **Sign in with Google** — use their own Google account
3. Paste their own Weekly Report Google Sheet URL
4. The app remembers their sheet URL for next time

---

## Tech Stack
- React 18 + Vite
- Google Identity Services (OAuth 2.0)
- Google Sheets API v4
- Web Speech API
- Claude API (Anthropic) for AI cleanup
