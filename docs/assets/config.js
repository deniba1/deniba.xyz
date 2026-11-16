// Everything personal on the page lives here. This file is public.
window.PROFILE = {
  name: "deni",
  handle: "deniba1",
  bio: "professional vibe coder. i build small tools, sites and experiments.",
  location: "earth",
  timezone: "America/Los_Angeles",   // the clock on the card shows your time in this zone (IANA name)

  // Avatar: leave empty to use your Discord avatar (when discordId is set),
  // falling back to a monogram. Or point it at an image, e.g. "images/avatar.webp".
  avatar: "",

  // Live Discord presence (status dot, activity, Spotify) comes from Lanyard.
  // 1. Join https://discord.gg/lanyard with your account (it only needs you to be a member).
  // 2. Discord -> Settings -> Advanced -> Developer Mode on, then right-click yourself -> Copy User ID.
  // 3. Paste the number below. Empty = the presence block and Discord link stay hidden.
  discordId: "1084337599444951100",
  discordUsername: "_deniba",   // shown in the copy-to-clipboard tooltip, e.g. "deniba1"

  // Music player: plays shuffled 30-second previews from this public playlist.
  // docs/assets/playlist.json is refreshed by .github/workflows/playlist.yml.
  // Empty = no player.
  spotifyPlaylist: "5vhjVUrxrh7W950hW9vi6b",

  github: "deniba1",     // repo count and the "repos" list come from the public GitHub API
  email: "deniba1@proton.me",

  // Extra links. Any entry with an empty url is skipped.
  // icon: one of github, discord, email, youtube, x, twitch, tiktok, roblox, link
  links: [
    { label: "YouTube", icon: "youtube", url: "" },
    { label: "X", icon: "x", url: "" },
    { label: "Roblox", icon: "roblox", url: "" },
  ],

  projects: [
    {
      name: "deniba.xyz",
      desc: "the site you're on. hand-written html, css and a bit of js.",
      url: "https://github.com/deniba1/deniba.xyz",
      linkText: "github.com/deniba1/deniba.xyz",
      tags: ["html", "css", "js"],
      status: "live",
    },
    {
      name: "roblox alt checker",
      desc: "scored roblox accounts on dozens of signals to flag likely alts. accounts, plans, guides, the lot.",
      url: "https://github.com/deniba1/deniba.xyz/tree/archive/alt-checker",
      linkText: "archive/alt-checker",
      tags: ["typescript", "python", "supabase"],
      status: "archived",
    },
  ],

  stack: ["typescript", "javascript", "python", "lua", "html / css", "supabase", "deno", "git"],
};
