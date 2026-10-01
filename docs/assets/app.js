// Shared by every page: Supabase session, plan, backend calls, header state, ads.
// Settings come from config.js. With no Supabase project configured the site
// runs in self-hosted mode (server.py): no accounts, no limits, no ads.
const App = (() => {
  const cfg = window.SITE || {};
  const hosted = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);

  // Supabase puts the result of an email link in the URL hash and then clears
  // it, so note what we landed with before the client starts.
  const landing = new URLSearchParams(location.hash.slice(1));
  const recovery = landing.get('type') === 'recovery';
  const authError = landing.get('error_description');

  const sb = hosted ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const fnBase = hosted ? `${cfg.supabaseUrl.replace(/\/+$/, '')}/functions/v1` : '';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function session() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session ?? null;
  }

  // Call an Edge Function route, as the signed-in user when there is one.
  // Throws an Error carrying .status, .code and .data on a non-2xx reply.
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { apikey: cfg.supabaseAnonKey };
    const s = await session();
    if (s) headers.Authorization = `Bearer ${s.access_token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${fnBase}/${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A token the server rejects is no use to keep; drop back to guest.
      if (res.status === 401 && data.code === 'auth') await sb.auth.signOut({ scope: 'local' });
      throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, code: data.code, data });
    }
    return data;
  }

  // Who is looking at the page: {hosted, user, plan, profile}. plan is
  // 'guest' | 'free' | 'pro', or 'self' when self-hosted. It only drives what
  // the page shows; the server decides what each plan may actually do.
  async function loadState() {
    if (!hosted) return { hosted, user: null, plan: 'self', profile: null };
    const s = await session();
    if (!s) return { hosted, user: null, plan: 'guest', profile: null };
    const { data: profile } = await sb.from('profiles')
      .select('plan,subscription_status,current_period_end,cancel_at_period_end,stripe_customer_id')
      .maybeSingle();
    return { hosted, user: s.user, plan: profile?.plan === 'pro' ? 'pro' : 'free', profile: profile ?? null };
  }

  function paintHeader(state) {
    const link = $('#navAccount');
    if (!link) return;
    if (!state.hosted) { link.hidden = true; return; }
    if (state.user) {
      link.classList.remove('btn', 'small');
      link.innerHTML = `Account <span class="badge ${state.plan === 'pro' ? 'pro' : ''}">${state.plan === 'pro' ? 'Pro' : 'Free'}</span>`;
    }
  }

  // Legal pages print the operator's details from config.js.
  function fillConfig() {
    for (const el of document.querySelectorAll('[data-cfg]')) {
      const value = cfg[el.dataset.cfg];
      if (!value) continue;
      el.textContent = value;
      el.classList.remove('unset');
      if (el.tagName === 'A' && el.dataset.cfg === 'contactEmail') el.href = `mailto:${value}`;
    }
  }

  // Ads are for guests and free accounts. Until the plan is known, and for Pro, nothing loads.
  let adsAllowed = false;

  // Fill the <div class="ad" data-slot="name"> container once. Slots marked
  // data-lazy wait for the page to ask (an ad needs content next to it).
  function showAd(name) {
    const el = document.querySelector(`.ad[data-slot="${name}"]`);
    if (!adsAllowed || !el || el.childElementCount) return;
    const client = cfg.adsenseClient, slot = (cfg.adSlots || {})[name];
    if (client && slot) {
      el.innerHTML = `<span class="ad-label">Advertisement</span>
        <ins class="adsbygoogle" style="display:block" data-ad-client="${esc(client)}" data-ad-slot="${esc(slot)}"
          data-ad-format="auto" data-full-width-responsive="true"></ins>`;
      el.hidden = false;
      if (!document.getElementById('adsense-js')) {
        const s = document.createElement('script');
        s.id = 'adsense-js';
        s.async = true;
        s.crossOrigin = 'anonymous';
        s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(client)}`;
        document.head.append(s);
      }
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } else if (['localhost', '127.0.0.1'].includes(location.hostname)) {
      // Preview only: shows where an ad will sit before AdSense is set up.
      el.innerHTML = `<span class="ad-label">Advertisement</span><div class="ad-placeholder">Ad slot “${esc(name)}” · hidden for Pro</div>`;
      el.hidden = false;
    }
  }

  fillConfig();
  if (!hosted) for (const el of document.querySelectorAll('[data-hosted-only]')) el.hidden = true;
  // Never rejects: if Supabase can't be reached the page still works as a guest.
  const ready = loadState()
    .catch(() => ({ hosted, user: null, plan: 'guest', profile: null }))
    .then((state) => {
      paintHeader(state);
      adsAllowed = state.plan === 'guest' || state.plan === 'free';
      for (const el of document.querySelectorAll('.ad[data-slot]:not([data-lazy])')) showAd(el.dataset.slot);
      return state;
    });

  return { cfg, hosted, sb, fnBase, esc, call, loadState, ready, showAd, recovery, authError };
})();
