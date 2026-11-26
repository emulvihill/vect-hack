// User settings: `?p_<name>=true|false` sets one and localStorage remembers it.
// The URL beats the stored value, which beats the default. A new setting is one
// row in SETTINGS.
const SETTINGS = {
  phosphorTrail: { param: "p_enable_persistence", fallback: true },
} as const;

export type UserSettings = { -readonly [K in keyof typeof SETTINGS]: boolean };

function parse(value: string | null): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

export function resolveUserSettings(search: string): UserSettings {
  const params = new URLSearchParams(search);
  const settings = {} as UserSettings;
  for (const name of Object.keys(SETTINGS) as (keyof typeof SETTINGS)[]) {
    const { param, fallback } = SETTINGS[name];
    const key = `vect-hack.${param}`;
    const fromUrl = parse(params.get(param));
    let stored: boolean | null = null;
    try {
      if (fromUrl === null) stored = parse(localStorage.getItem(key));
      else localStorage.setItem(key, String(fromUrl));
    } catch { /* no storage */ }
    settings[name] = fromUrl ?? stored ?? fallback;
  }
  return settings;
}
