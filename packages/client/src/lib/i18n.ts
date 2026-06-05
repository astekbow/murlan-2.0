// ============================================================================
// MURLAN — internationalization (sq default, en optional)
// ----------------------------------------------------------------------------
// A small bilingual catalog + a persisted language store + a `useT()` hook. Albanian
// (sq) is the source language; English (en) is opt-in. Migration is INCREMENTAL:
// a view uses t('key') instead of a literal as it's translated; unmigrated views
// keep their Albanian literals (so there are never "missing translation" blanks).
// translate() is pure → unit-tested. Pure presentation; no money/game logic.
// ============================================================================

import { create } from 'zustand';

export type Lang = 'sq' | 'en';

interface Entry { sq: string; en: string }

const STRINGS: Record<string, Entry> = {
  // Common
  'common.backToLobby': { sq: '← Kthehu te lobi', en: '← Back to lobby' },
  'common.save': { sq: 'Ruaj', en: 'Save' },
  'common.cancel': { sq: 'Anulo', en: 'Cancel' },

  // App chrome (splashes, offline, email-verify toasts)
  'app.loading': { sq: 'Duke u ngarkuar…', en: 'Loading…' },
  'app.offlineTitle': { sq: 'S’u lidh dot me serverin', en: 'Couldn’t reach the server' },
  'app.offlineBody': { sq: 'Kontrollo internetin. Sesioni yt ruhet — provo sërish.', en: 'Check your connection. Your session is kept — try again.' },
  'app.retry': { sq: 'Provo sërish', en: 'Try again' },
  'app.emailVerified': { sq: 'Email-i u verifikua! 🎉', en: 'Email verified! 🎉' },
  'app.emailVerifyFailed': { sq: 'Lidhja e verifikimit s’është e vlefshme ose ka skaduar.', en: 'The verification link is invalid or has expired.' },

  // Auth
  'auth.tagline': { sq: 'Luaj online për të vërtetë', en: 'Play online for real' },
  'auth.login': { sq: 'HYR', en: 'LOG IN' },
  'auth.register': { sq: 'REGJISTROHU', en: 'SIGN UP' },
  'auth.username': { sq: 'Përdoruesi', en: 'Username' },
  'auth.email': { sq: 'Email', en: 'Email' },
  'auth.password': { sq: 'Fjalëkalimi', en: 'Password' },
  'auth.submitLogin': { sq: 'HYR', en: 'LOG IN' },
  'auth.submitRegister': { sq: 'KRIJO LLOGARI', en: 'CREATE ACCOUNT' },
  'auth.processing': { sq: 'Duke u procesuar…', en: 'Processing…' },
  'auth.forgot': { sq: 'Harrove fjalëkalimin?', en: 'Forgot your password?' },
  'auth.recoverTitle': { sq: 'Rikuperim', en: 'Recovery' },
  'auth.recoverBlurb': { sq: 'Të dërgojmë një lidhje për të rivendosur fjalëkalimin.', en: 'We’ll send a link to reset your password.' },
  'auth.recoverSent': { sq: 'Nëse ka një llogari me këtë email, lidhja u dërgua. Kontrollo email-in.', en: 'If an account exists for this email, the link was sent. Check your inbox.' },
  'auth.sendLink': { sq: 'Dërgo lidhjen', en: 'Send link' },
  'auth.sending': { sq: 'Po dërgohet…', en: 'Sending…' },
  'auth.backToLogin': { sq: '← Kthehu te hyrja', en: '← Back to sign in' },

  // Settings
  'settings.title': { sq: 'Cilësimet', en: 'Settings' },
  'settings.soundFx': { sq: 'Zëri (efektet)', en: 'Sound (effects)' },
  'settings.volume': { sq: 'Volumi', en: 'Volume' },
  'settings.music': { sq: 'Muzika e sfondit', en: 'Background music' },
  'settings.realityCheck': { sq: 'Kontroll realiteti (përkujtues)', en: 'Reality check (reminder)' },
  'settings.realityCheckHint': { sq: 'Të kujton sa kohë ke luajtur dhe rezultatin e sesionit. Luaj me përgjegjësi 🔞', en: 'Reminds you how long you’ve played and your session result. Play responsibly 🔞' },
  'settings.language': { sq: 'Gjuha', en: 'Language' },
  'settings.savedOnDevice': { sq: 'Cilësimet ruhen në këtë pajisje.', en: 'Settings are saved on this device.' },

  // Lobby nav rail
  'nav.leaderboard': { sq: 'KLASIFIKIMI', en: 'LEADERBOARD' },
  'nav.friends': { sq: 'MIQTË', en: 'FRIENDS' },
  'nav.clubs': { sq: 'KLUBET', en: 'CLUBS' },
  'nav.challenges': { sq: 'SFIDAT', en: 'CHALLENGES' },
  'nav.shop': { sq: 'DYQANI', en: 'SHOP' },
  'nav.vip': { sq: 'VIP', en: 'VIP' },
  'nav.support': { sq: 'NDIHMË', en: 'SUPPORT' },

  // Lobby hero / sections
  'lobby.quickName': { sq: 'Lojë e Shpejtë', en: 'Quick Match' },
  'lobby.quickDesc': { sq: '1v1 · 1v1v1 · 2v2 — gjej kundërshtar në sekonda', en: '1v1 · 1v1v1 · 2v2 — find an opponent in seconds' },
  'lobby.quickCta': { sq: 'LUAJ TANI', en: 'PLAY NOW' },
  'lobby.tournName': { sq: 'Turne · Dhomat', en: 'Tournaments · Rooms' },
  'lobby.tournDesc': { sq: 'Tavolina me bast · çmime më të mëdha', en: 'Staked tables · bigger prizes' },
  'lobby.tournCta': { sq: 'HYR', en: 'ENTER' },
  'lobby.rankedTitle': { sq: 'LUAJ RANKED', en: 'PLAY RANKED' },
  'lobby.rankedDesc': { sq: 'Çiftëzim sipas MMR · ngjit nga Bronz te Murlan Master', en: 'MMR matchmaking · climb from Bronze to Murlan Master' },
  'lobby.findMatch': { sq: 'GJEJ NDESHJE', en: 'FIND MATCH' },
  'lobby.openRooms': { sq: 'DHOMAT E HAPURA', en: 'OPEN ROOMS' },
  'lobby.refresh': { sq: 'Rifresko', en: 'Refresh' },
  'lobby.createRoom': { sq: '＋ Krijo dhomë', en: '＋ Create room' },
  'lobby.liveMatches': { sq: 'NDESHJE LIVE', en: 'LIVE MATCHES' },
};

/** Pure lookup: the string for `key` in `lang`, falling back to sq, then the key. */
export function translate(key: string, lang: Lang): string {
  const e = STRINGS[key];
  if (!e) return key;
  return e[lang] || e.sq || key;
}

const STORAGE_KEY = 'murlan.lang.v1';
function loadLang(): Lang {
  try { return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'sq'; } catch { return 'sq'; }
}
if (typeof document !== 'undefined') document.documentElement.lang = loadLang();

interface LangStore {
  lang: Lang;
  setLang: (l: Lang) => void;
}
export const useLangStore = create<LangStore>((set) => ({
  lang: loadLang(),
  setLang: (lang) => {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
    set({ lang });
  },
}));

/** Reactive translator bound to the current language. */
export function useT(): (key: string) => string {
  const lang = useLangStore((s) => s.lang);
  return (key: string) => translate(key, lang);
}
