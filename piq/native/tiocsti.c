/*
 * tiocsti — place one line of text into the controlling terminal's input
 * queue via the TIOCSTI ioctl, without echoing and without pressing Enter.
 *
 * Used by `pic` command mode to fill the shell prompt with a suggested
 * command. Replaces the previous python3 helper so piq has no python
 * runtime dependency.
 *
 * Note: TIOCSTI is a Linux/BSD/macOS facility. On recent Linux kernels it is
 * gated behind the dev.tty.legacy_tiocsti sysctl (off by default), in which
 * case the ioctl fails with EPERM/EIO and piq reports the error.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <termios.h>
#include <unistd.h>

static int fail(const char *what) {
  fprintf(stderr, "%s: %s (errno %d)\n", what, strerror(errno), errno);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: tiocsti <text>\n");
    return 2;
  }

  const char *text = argv[1];

  int fd = open("/dev/tty", O_RDWR);
  if (fd < 0) {
    return fail("open /dev/tty");
  }

  struct termios saved;
  if (tcgetattr(fd, &saved) != 0) {
    int rc = fail("tcgetattr");
    close(fd);
    return rc;
  }

  struct termios quiet = saved;
  quiet.c_lflag &= ~(tcflag_t)ECHO;

  int rc = 0;
  if (tcsetattr(fd, TCSADRAIN, &quiet) != 0) {
    rc = fail("tcsetattr");
  } else {
    for (const char *p = text; *p != '\0'; p++) {
      if (ioctl(fd, TIOCSTI, p) != 0) {
        rc = fail("ioctl TIOCSTI");
        break;
      }
    }
    /* Restore terminal settings regardless of injection outcome. */
    if (tcsetattr(fd, TCSADRAIN, &saved) != 0 && rc == 0) {
      rc = fail("tcsetattr restore");
    }
  }

  close(fd);
  return rc;
}
