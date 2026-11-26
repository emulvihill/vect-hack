// `?p_<name>=<value>` sets a user setting and localStorage remembers it.
// The URL beats the stored value, which beats the default; an invalid value is
// ignored. A new setting is one row in SETTINGS.
interface Setting<T> { param: `p_${string}`; parse(value: string | null): T | null; fallback: T }

const bool = (v: string | null) => (v === "true" ? true : v === "false" ? false : null);

const SETTINGS = {
  phosphorTrail: { param: "p_enable_persistence", parse: bool, fallback: true },
} satisfies Record<string, Setting<unknown>>;

export type UserSettings = { [K in keyof typeof SETTINGS]: (typeof SETTINGS)[K]["fallback"] };

function resolve<T>({ param, parse, fallback }: Setting<T>, params: URLSearchParams): T {
  const key = `vect-hack.${param}`;
  const fromUrl = parse(params.get(param));
  try {
    if (fromUrl === null) return parse(localStorage.getItem(key)) ?? fallback;
    localStorage.setItem(key, String(fromUrl));
  } catch { /* no storage */ }
  return fromUrl ?? fallback;
}

export function resolveUserSettings(search: string): UserSettings {
  const params = new URLSearchParams(search);
  return Object.fromEntries(
    Object.entries(SETTINGS).map(([name, s]) => [name, resolve(s, params)]),
  ) as UserSettings;
}
