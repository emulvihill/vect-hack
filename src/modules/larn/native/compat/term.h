/* Compatibility <term.h> for the NetBSD Larn snapshot under Emscripten.
 *
 * external/larn/io.c includes <term.h> (terminfo) for the three functions it
 * uses to decode the semantic output buffer — setupterm() (init), tputs()
 * (emit a capability with padding), and tiparm() (parameterise a capability
 * string) — plus the eight terminfo capability globals the decoder switches
 * on (clear_screen, clr_eol, clr_eos, cursor_address, delete_line,
 * insert_line, enter_standout_mode, exit_standout_mode). musl/Emscripten
 * ships no terminfo library.
 *
 * This header declares exactly that surface so io.c compiles. The symbols
 * are NOT provided at link time: the shim (src/modules/larn/native/main-wasm.c,
 * Task 6) replaces io.c's lflush() decoder and these terminfo entry points
 * with direct grid writes, so the semantic bytes in lpbuf (ST_START /
 * ST_END / BOLD / END_BOLD / CLEAR / CL_LINE / CL_DOWN / CURSOR, defined in
 * external/larn/header.h:409-416) become CellGrid updates without
 * an ANSI parser. For the spike's compile-only probe, an unresolved link is
 * acceptable (we only build .o files here).
 *
 * Reached via `-I` in larn-wasm.mk; the external/larn tree stays pristine.
 */
#ifndef _VECT_LARN_COMPAT_TERM_H
#define _VECT_LARN_COMPAT_TERM_H

/* Terminfo capability strings. In a real terminfo build these are `char *`
 * globals populated by setupterm() from the termcap database; the shim owns
 * the decoder so they are left unresolved here (declarations only). */
extern char *clear_screen;
extern char *clr_eol;
extern char *clr_eos;
extern char *cursor_address;
extern char *delete_line;
extern char *insert_line;
extern char *enter_standout_mode;
extern char *exit_standout_mode;

/* The three terminfo entry points io.c calls. Signatures per terminfo(3). */
int   setupterm(const char *, int, int *);
int   tputs(const char *, int, int (*)(int));
char *tiparm(const char *, ...);

#endif /* _VECT_LARN_COMPAT_TERM_H */