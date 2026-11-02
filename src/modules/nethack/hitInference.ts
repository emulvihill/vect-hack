// Hit inference (spec 2026-08-06): NetHack's shim hands the view message
// text and nothing else, so this Module has the documented limited
// abilities — two regex shapes, null for everything else (ranged, pets,
// off-screen fights). A wrong guess costs one cosmetic flash on a neighbor;
// a null costs nothing, so ambiguity always answers null.
import { STEP_OF } from "../../ui/gaze";
import { DIRECTIONS } from "./ui/keys";

export interface Dir { dx: number; dy: number }
export interface Point { x: number; y: number }

/** Key code -> direction: hjklyubn, HJKLYUBN (run), ctrl (rush). DIRECTIONS is
 *  in the same clockwise-from-north compass order as gaze's STEP_OF, so the
 *  letter's index is the delta's index; a fresh object per call, because
 *  STEP_OF is a shared table and a caller must not be able to corrupt it. Null
 *  for anything else — ctrl-D is kick, not a direction, so ctrl only counts
 *  for codes whose letter is a direction key. */
export function nethackKeyDir(code: number): Dir | null {
  const letter = code >= 1 && code <= 26 ? String.fromCharCode(code + 96)
    : String.fromCharCode(code).toLowerCase();
  const i = (DIRECTIONS as readonly string[]).indexOf(letter);
  if (i < 0) return null;
  const [dx, dy] = STEP_OF[i]!;
  return { dx, dy };
}

/** "You hit the newt!" — first person, a hit verb, a creature article.
 *  Amended 2026-08-06 (post Task-5 review, same ruling as Task 3: the
 *  no-guessed-pulse constraint governs): `kick` is out — dokick.c prints
 *  "You kick %s." identically for monsters and floor objects, so it is
 *  ambiguous (kicked monsters are an accepted false negative); `your ` is
 *  out — pets/steeds arrive via mon_nam() as "the little dog", so "your"
 *  in this position is only self-injury ("You hit your head on the
 *  ceiling."). The verb list is uhitm.c's common melee verbs; rarities
 *  just don't pulse. */
const YOU_HIT = /^You (hit|smite|strike|punch|bite|sting|butt|touch|pummel|thump|whack|bash) (the |a |an |it)/;
/** Non-creature objects a hit verb can reach — digging ("You hit the rock
 *  with all your might."), door frames, furniture. A match here is not a
 *  combat and must not pulse. */
const HIT_SCENERY = /^You \w+ (the|a|an) (rock|boulder|statue|tree|door frame|door|wall|stairs|throne|fountain|sink|altar|chest|box)\b/;

/** "The newt bites!" / "The bee stings you." — a monster's melee verb with
 *  no object (or "you"). An object after the verb is a pet fighting
 *  something else: no pulse. */
const HITS_YOU = /^(?:The|A|An|One of the|It|[A-Z][a-z]+(?:'s)?) .*?(hits|bites|stings|butts|touches|kicks|tramples|claws)( you)?[.!]$/;

export function inferNethackHit(
  text: string, hero: Point | null, lastDir: Dir | null,
): Point | null {
  if (!hero) return null;
  if (YOU_HIT.test(text) && !HIT_SCENERY.test(text))
    return lastDir ? { x: hero.x + lastDir.dx, y: hero.y + lastDir.dy } : null;
  if (HITS_YOU.test(text)) return hero;
  return null;
}
