/* Compatibility <sys/cdefs.h> for the NetBSD Larn snapshot under Emscripten.
 *
 * Every NetBSD source file opens with `#include <sys/cdefs.h>` to get the
 * `__RCSID("$NetBSD: ...$")` macro that stamps the version banner into the
 * binary. musl/Emscripten does not ship <sys/cdefs.h>, so the bare include
 * fails the compile. This header defines the single macro the snapshot
 * references (__RCSID) as a no-op, plus the harmless __COPYRIGHT for symmetry.
 *
 * Reached via `-I` in larn-wasm.mk; the external/larn tree stays pristine.
 * All C compat lives in our tree, the same discipline as
 * src/modules/angband/native/main-wasm.c.
 */
#ifndef _VECT_LARN_COMPAT_SYS_CDEFS_H
#define _VECT_LARN_COMPAT_SYS_CDEFS_H

/* NetBSD stamps source with `__RCSID("$NetBSD: foo.c,v 1.x ...$");` at file
 * scope. NetBSD's own macro expands to a static const string; we mirror that
 * (static => per-TU, no link conflict; __attribute__((unused)) quiets the
 * unused-variable diagnostic). The source's trailing `;` then closes the
 * declaration. */
#define __RCSID(x)        static char vectlarn_rcsid[] __attribute__((unused)) = (x)
#define __RCSID_EXTERN(x) static char vectlarn_rcsid[] __attribute__((unused)) = (x)
#define __COPYRIGHT(x)    static char vectlarn_copyright[] __attribute__((unused)) = (x)

/* NetBSD uses these to bracket extern "C" in headers; harmless as empty. */
#define __BEGIN_DECLS
#define __END_DECLS

/* Marking macros the source may apply to declarations. Empty is fine. */
#define __dead
#define __unused
#define __printflike(a, b)
#define __warn_references(x, y)
#define __indrclibref(x)
#define __strong_alias(x, y)
#define __weak_alias(x, y)

/* NetBSD's __unreachable() (main.c:796 after the non-returning died(-257)
 * save path). Maps to the clang builtin. */
#define __unreachable() __builtin_unreachable()

#endif /* _VECT_LARN_COMPAT_SYS_CDEFS_H */