// Site settings. This file is public: never put a secret key in it.
window.SITE = {
  // Supabase project (dashboard -> Project Settings -> API). Leave both empty
  // when running server.py yourself: accounts, plans and ads are then off and
  // every feature is unlocked.
  supabaseUrl: "https://qytyagyhgvhlygmanqyo.supabase.co",
  supabaseAnonKey: "sb_publishable_zkNpkjvBKQeCQ7SI_Z1HLw_TIFvRNz9",   // the anon / publishable key, not the service-role key
  googleLogin: true,    // show "Continue with Google" (enable the provider in Supabase first)

  // Google AdSense, shown to guests and free accounts only. Empty = no ads.
  adsenseClient: "",     // "ca-pub-0000000000000000"
  adSlots: { top: "", bottom: "" },   // ad unit IDs for the two placements on the checker page

  // Printed in the Terms, Privacy Policy and Refund Policy.
  operator: "Ruslan Suvorov, doing business as DENIXYZ",   // your name or your company's legal name
  contactEmail: "deniba1@proton.me",   // where support, privacy and refund requests go
  governingLaw: "the State of California, USA",
};
