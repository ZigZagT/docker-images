#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <limits.h>
#include <sys/stat.h>

// Log levels: error=0, warn=1, info=2 (higher value = more verbose)
static int log_level = 2; // Default to info

static void init_log_level(void) {
    char *level = getenv("CONTAINER_SETUP_LOG");
    if (!level) return;
    if (strcmp(level, "error") == 0) log_level = 0;
    else if (strcmp(level, "warn") == 0) log_level = 1;
    else if (strcmp(level, "info") == 0) log_level = 2;
}

#define LOG_ERROR(...) fprintf(stderr, __VA_ARGS__)
#define LOG_WARN(...) do { if (log_level >= 1) fprintf(stderr, __VA_ARGS__); } while(0)
#define LOG_INFO(...) do { if (log_level >= 2) fprintf(stderr, __VA_ARGS__); } while(0)

int main() {
    init_log_level();
    umask(0022); // Ensure secure permissions for created files

    char *tz = getenv("TZ");
    if (!tz || strlen(tz) == 0) {
        LOG_INFO("setup-tz: No timezone configured, using system default\n");
        return 0;
    }

    LOG_INFO("setup-tz: Configuring timezone to %s\n", tz);

    // Build path to zoneinfo file
    char target[PATH_MAX];
    const char *allowed_dir = "/usr/share/zoneinfo/";
    size_t allowed_dir_len = strlen(allowed_dir);

    int len = snprintf(target, sizeof(target), "%s%s", allowed_dir, tz);
    if (len < 0 || len >= sizeof(target)) {
        LOG_ERROR("setup-tz: ERROR: TZ path too long: %s\n", tz);
        return 1;
    }

    // Resolve to canonical absolute path and verify file exists (prevents path traversal attacks)
    char resolved[PATH_MAX];
    if (realpath(target, resolved) == NULL) {
        LOG_ERROR("setup-tz: ERROR: Invalid or non-existent timezone %s: %s\n", tz, strerror(errno));
        return 1;
    }

    // Verify resolved path is within allowed directory (security check)
    if (strncmp(resolved, allowed_dir, allowed_dir_len) != 0) {
        LOG_ERROR("setup-tz: ERROR: Timezone path outside allowed directory: %s\n", resolved);
        return 1;
    }

    // Write /etc/timezone
    FILE *fp = fopen("/etc/timezone", "w");
    if (!fp) {
        LOG_ERROR("setup-tz: ERROR: Failed to write /etc/timezone: %s\n", strerror(errno));
        return 1;
    }
    fprintf(fp, "%s\n", tz);
    if (fclose(fp) != 0) {
        LOG_ERROR("setup-tz: ERROR: Failed to close /etc/timezone: %s\n", strerror(errno));
        return 1;
    }

    // Remove old /etc/localtime if it exists
    if (unlink("/etc/localtime") != 0 && errno != ENOENT) {
        LOG_WARN("setup-tz: WARNING: Failed to remove /etc/localtime: %s\n", strerror(errno));
    }

    // Create symlink using validated path
    if (symlink(resolved, "/etc/localtime") != 0) {
        LOG_ERROR("setup-tz: ERROR: Failed to create /etc/localtime symlink: %s\n", strerror(errno));
        return 1;
    }

    LOG_INFO("setup-tz: Symlinked /etc/localtime -> %s\n", resolved);

    // Reconfigure tzdata package (suppresses output but checks exit status)
    LOG_INFO("setup-tz: Running dpkg-reconfigure tzdata\n");
    int status = system("/usr/sbin/dpkg-reconfigure -f noninteractive tzdata 2>/dev/null");

    if (status == -1) {
        LOG_WARN("setup-tz: WARNING: Failed to execute dpkg-reconfigure\n");
    } else if (WIFEXITED(status) && WEXITSTATUS(status) != 0) {
        LOG_WARN("setup-tz: WARNING: dpkg-reconfigure exited with code %d\n", WEXITSTATUS(status));
    } else if (WIFSIGNALED(status)) {
        LOG_WARN("setup-tz: WARNING: dpkg-reconfigure killed by signal %d\n", WTERMSIG(status));
    } else {
        LOG_INFO("setup-tz: dpkg-reconfigure completed successfully\n");
    }

    LOG_INFO("setup-tz: Successfully configured timezone\n");
    return 0;
}
