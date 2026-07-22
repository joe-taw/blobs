# Blobs — deployment guide

Your project has two parts:

- **`server/`** — the game engine (Node.js + Socket.io). Needs a host that runs server code.
- **`public/index.html`** — the page players open in their browser. Just a static file.

You'll deploy these to two different (both free) places, then point the page at the server.

---

## Part 1 — Put the code on GitHub

1. Create a free GitHub account at github.com if you don't have one.
2. Create a new repository (e.g. `blobs-game`), and upload both the `server` folder and `public` folder into it (GitHub's web UI lets you drag-and-drop files — "Add file" → "Upload files").

---

## Part 2 — Deploy the server (Render, free tier)

1. Go to https://render.com and sign up (you can sign in with GitHub).
2. Click **New +** → **Web Service**.
3. Connect your `blobs-game` GitHub repo.
4. When asked to configure it:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Create Web Service**. Render will build and deploy it — this takes a couple of minutes.
6. Once it's live, copy the URL Render gives you at the top of the page. It'll look like:
   `https://blobs-game-xxxx.onrender.com`

**Note:** Render's free tier "sleeps" a service after 15 minutes of no traffic, and takes ~30-60 seconds to wake back up on the next request. That's fine for casual play — just means the first person to open the game might see a short delay.

---

## Part 3 — Point the page at your server

1. In `public/index.html`, find this line near the bottom (inside the `<script>` tag):
   ```js
   const SERVER_URL = window.BLOBS_SERVER_URL || 'http://localhost:3001';
   ```
2. Replace `http://localhost:3001` with the Render URL from Part 2:
   ```js
   const SERVER_URL = window.BLOBS_SERVER_URL || 'https://blobs-game-xxxx.onrender.com';
   ```
3. Save the file and upload the updated version back to your GitHub repo.

---

## Part 4 — Deploy the page (GitHub Pages, free)

1. In your GitHub repo, go to **Settings** → **Pages**.
2. Under "Build and deployment", set **Source** to "Deploy from a branch".
3. Set **Branch** to `main` and folder to `/public` (or `/root` if you move `index.html` to the repo root — either works, just be consistent).
4. Save. GitHub will give you a URL like:
   `https://yourusername.github.io/blobs-game/`
5. Give that link to anyone you want to play with — that's the whole game, live, for free.

*(Netlify is an equally good alternative to GitHub Pages if you'd rather use that — just drag the `public` folder into Netlify's dashboard.)*

---

## Playing a game

1. One player opens the site, enters their name, and leaves the room code field blank → this creates a room and shows a 4-letter code.
2. Everyone else opens the same site, enters their name, and types in that code to join.
3. Once 2–6 players have joined, the host clicks **Start Game**.
4. The game runs all 16 rounds automatically — bidding, trump reveal, trick play, and scoring are all handled for you. The host clicks **Continue** to move to the next round after seeing each round's results.

## Local testing (optional, before deploying)

If you want to try it on your own computer first:
```bash
cd server
npm install
npm start
```
Then just open `public/index.html` directly in your browser (it defaults to `http://localhost:3001`). Open it in a few browser tabs to simulate multiple players.
