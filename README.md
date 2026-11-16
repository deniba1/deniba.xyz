# deniba.xyz

Personal portfolio. Static files in `docs/`, served by GitHub Pages.

Edit `docs/assets/config.js` to change the bio, links, projects and stack, or to turn on live Discord presence (instructions are in the file). Bump the `?v=N` on the CSS/JS links in `index.html` after changing them.

The old Roblox Alt Checker lives on the [`archive/alt-checker`](https://github.com/deniba1/deniba.xyz/tree/archive/alt-checker) branch.

## Music player

The dock at the bottom plays the Spotify playlist set in `spotifyPlaylist` (config.js), shuffled. `.github/workflows/playlist.yml` runs `scripts/update_playlist.py` every 15 minutes: it reads the public playlist, matches each song to a full-length YouTube upload, and commits `docs/assets/playlist.json` when the playlist changed. Run the workflow by hand from the Actions tab for an immediate refresh. Songs with no embeddable YouTube match fall back to Spotify's 30-second preview.

If a song plays the wrong version, replace its `youtube` ids in `docs/assets/playlist.json` (the first id is tried first); the script keeps existing ids.
