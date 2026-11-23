/* Mount the runtime's filesystem only while the launcher writes main.py. */
#include "esp_littlefs.h"

esp_err_t install_mount_program_fs(void)
{
    const esp_vfs_littlefs_conf_t fs = {.base_path = "/flash", .partition_label = "data"};
    return esp_vfs_littlefs_register(&fs);
}

void install_unmount_program_fs(void)
{
    esp_vfs_littlefs_unregister("data");
}
