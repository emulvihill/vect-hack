/* Force-included compat for the NetBSD Larn snapshot under Emscripten.
 *
 * Added to every compile via `-include` in larn-wasm.mk (after the -I dirs).
 * Covers two NetBSD-isms the snapshot assumes but musl/Emscripten lacks:
 *
 *   SIGEMT      - BSD signal (signal.c:109) not in musl's <signal.h>. The
 *                 shim stubs sigsetup() at runtime, so the value is inert;
 *                 define it so the call compiles.
 *   sys_signame - NetBSD's `const char *sys_signame[]` (signal.c:132), the
 *                 per-signal short name. Declared here; the symbol is
 *                 unresolved at link and the shim owns sigpanic (or stubs
 *                 sigsetup, so the array is never indexed at runtime).
 *
 * The external/larn tree stays pristine; this is our compat, living in
 * src/modules/larn/native/compat/.
 */
#ifndef _VECT_LARN_COMPAT_NETBSD_H
#define _VECT_LARN_COMPAT_NETBSD_H

#ifndef SIGEMT
#define SIGEMT 0
#endif

extern const char *sys_signame[];

/* Several engine TUs call time()/ctime() without including <time.h> (diag.c
 * is the example: it pulls in <sys/times.h> only), so under -std=gnu89 `time`
 * is implicitly declared returning int (i32). Emscripten's libc `time`
 * returns time_t (i64), and wasm-ld then warns about a function-signature
 * mismatch on every link. Force-including <time.h> here gives every TU the
 * real prototype so the call signature matches libc. */
#include <time.h>

#endif /* _VECT_LARN_COMPAT_NETBSD_H */