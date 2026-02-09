#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define MAX_LINE 256

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

    char *apt_mirror = getenv("APT_MIRROR");
    if (!apt_mirror || strlen(apt_mirror) == 0) {
        LOG_INFO("setup-apt: No mirror configured, using system default\n");
        return 0;
    }

    LOG_INFO("setup-apt: Configuring APT mirror to %s\n", apt_mirror);

    FILE *fp = fopen("/etc/os-release", "r");
    if (!fp) {
        LOG_ERROR("setup-apt: ERROR: Failed to open /etc/os-release: %s\n", strerror(errno));
        return 1;
    }

    char codename[MAX_LINE] = {0};
    char line[MAX_LINE];
    int found = 0;
    const char *prefix = "VERSION_CODENAME=";
    size_t prefix_len = strlen(prefix);

    while (fgets(line, sizeof(line), fp)) {
        // Look for VERSION_CODENAME=value
        if (strncmp(line, prefix, prefix_len) == 0) {
            // Copy value after the '='
            strncpy(codename, line + prefix_len, sizeof(codename) - 1);
            codename[sizeof(codename) - 1] = '\0';
            // Remove trailing newline
            codename[strcspn(codename, "\n")] = 0;
            found = 1;
            break;
        }
    }

    fclose(fp);

    if (!found || strlen(codename) == 0) {
        LOG_ERROR("setup-apt: ERROR: VERSION_CODENAME not found in /etc/os-release\n");
        return 1;
    }

    LOG_INFO("setup-apt: Detected Ubuntu codename: %s\n", codename);

    // Write sources.list
    FILE *out = fopen("/etc/apt/sources.list", "w");
    if (!out) {
        LOG_ERROR("setup-apt: ERROR: Failed to write /etc/apt/sources.list: %s\n", strerror(errno));
        return 1;
    }

    // Write each repository line
    fprintf(out, "deb %s %s main restricted\n", apt_mirror, codename);
    fprintf(out, "deb %s %s-updates main restricted\n", apt_mirror, codename);
    fprintf(out, "deb %s %s universe\n", apt_mirror, codename);
    fprintf(out, "deb %s %s-updates universe\n", apt_mirror, codename);
    fprintf(out, "deb %s %s multiverse\n", apt_mirror, codename);
    fprintf(out, "deb %s %s-updates multiverse\n", apt_mirror, codename);
    fprintf(out, "deb %s %s-backports main restricted universe multiverse\n", apt_mirror, codename);
    fprintf(out, "deb %s %s-security main restricted\n", apt_mirror, codename);
    fprintf(out, "deb %s %s-security universe\n", apt_mirror, codename);
    fprintf(out, "deb %s %s-security multiverse\n", apt_mirror, codename);

    if (fclose(out) != 0) {
        LOG_ERROR("setup-apt: ERROR: Failed to close /etc/apt/sources.list: %s\n", strerror(errno));
        return 1;
    }

    LOG_INFO("setup-apt: Successfully configured APT sources\n");
    return 0;
}
