#include <crt_externs.h>
#include <dlfcn.h>
#include <spawn.h>
#include <stdlib.h>
#include <unistd.h>

extern char **environ;

/*
 * TCC judges speech and the microphone against the responsible process.
 * A desk Codex or ChatGPT launched keeps ChatGPT responsible, and ChatGPT's
 * Info.plist has no speech usage string, so the helper is aborted. Re-exec
 * once with responsibility disclaimed so this binary's own plist is the one
 * that is checked.
 */
__attribute__((constructor)) static void workhorse_disclaim_responsibility(void) {
  if (getenv("WORKHORSE_DICTATION_DISCLAIMED")) return;
  setenv("WORKHORSE_DICTATION_DISCLAIMED", "1", 1);

  int (*setdisclaim)(posix_spawnattr_t *, int) =
      (int (*)(posix_spawnattr_t *, int))dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (!setdisclaim) return;

  posix_spawnattr_t attr;
  if (posix_spawnattr_init(&attr) != 0) return;
  if (posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETEXEC) != 0) return;
  if (setdisclaim(&attr, 1) != 0) return;

  char **argv = *_NSGetArgv();
  if (!argv || !argv[0]) return;
  pid_t pid = 0;
  posix_spawn(&pid, argv[0], NULL, &attr, argv, environ);
}
