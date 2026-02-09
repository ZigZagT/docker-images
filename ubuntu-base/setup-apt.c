#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define MAX_LINE 256

int main() {
    umask(0022); // Ensure secure permissions for created files

    char *apt_mirror = getenv("APT_MIRROR");
    if (!apt_mirror || strlen(apt_mirror) == 0) {
        fprintf(stderr, "setup-apt: No mirror configured, using system default\n");
        return 0;
    }

    fprintf(stderr, "setup-apt: Configuring APT mirror to %s\n", apt_mirror);

    FILE *fp = fopen("/etc/os-release", "r");
    if (!fp) {
        fprintf(stderr, "setup-apt: ERROR: Failed to open /etc/os-release: %s\n", strerror(errno));
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
        fprintf(stderr, "setup-apt: ERROR: VERSION_CODENAME not found in /etc/os-release\n");
        return 1;
    }

    fprintf(stderr, "setup-apt: Detected Ubuntu codename: %s\n", codename);

    // Write sources.list
    FILE *out = fopen("/etc/apt/sources.list", "w");
    if (!out) {
        fprintf(stderr, "setup-apt: ERROR: Failed to write /etc/apt/sources.list: %s\n", strerror(errno));
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
        fprintf(stderr, "setup-apt: ERROR: Failed to close /etc/apt/sources.list: %s\n", strerror(errno));
        return 1;
    }

    fprintf(stderr, "setup-apt: Successfully configured APT sources\n");
    return 0;
}
