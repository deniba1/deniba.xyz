// Site settings. This file is public: never put a secret key in it.
window.SITE = {
  // Supabase project (dashboard -> Project Settings -> API). Leave both empty
  // when running server.py yourself: accounts, plans and ads are then off and
  // every feature is unlocked.
  supabaseUrl: "https://qytyagyhgvhlygmanqyo.supabase.co",
  supabaseAnonKey: "sb_publishable_zkNpkjvBKQeCQ7SI_Z1HLw_TIFvRNz9",   // the anon / publishable key, not the service-role key
  googleLogin: true,    // show "Continue with Google" (enable the provider in Supabase first)

  // Cloudflare Turnstile site key: adds a "verify you are human" check to sign-up,
  // sign-in and password reset. Set it here AND switch on CAPTCHA protection in
  // Supabase (Authentication -> Attack Protection) with the matching secret key.
  // Do both or neither: Supabase rejects sign-ins when only its side is on.
  turnstileSiteKey: "",

  // Google AdSense, shown to guests and free accounts only. Empty = no ads.
  adsenseClient: "ca-pub-1335354496523169",
  adSlots: { top: "", bottom: "" },   // ad unit IDs for the two placements on the checker page

  // Printed in the Terms, Privacy Policy and Refund Policy.
  operator: "Ruslan Suvorov, doing business as DENIXYZ",   // your name or your company's legal name
  tradeName: "DENIXYZ",   // short business name, used on the Privacy Policy's contact line
  contactEmail: "deniba1@proton.me",   // where support, privacy and refund requests go
  governingLaw: "the State of California, USA",
};
