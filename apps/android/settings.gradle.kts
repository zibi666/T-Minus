// 阿里云镜像只在境内可达：GitHub Actions 的 runner 在海外，三个仓库一律返回 502 Bad Gateway，
// 一旦排在仓库列表最前面就会把整个插件解析阶段拖死（KSP 的 marker POM 就是这么丢的）。
// 所以按 CI 环境变量分流：CI 只认官方源，本地开发仍走镜像，两边的解析路径都保持完整。
// 注意 onCi 必须在各块内部各自声明——pluginManagement 早于脚本主体求值，顶层 val 它看不见。
pluginManagement {
    val onCi = System.getenv("CI") != null
    repositories {
        if (onCi) {
            google {
                content {
                    includeGroupByRegex("com\\.android.*")
                    includeGroupByRegex("com\\.google.*")
                    includeGroupByRegex("androidx.*")
                }
            }
            mavenCentral()
            gradlePluginPortal()
        } else {
            maven("https://maven.aliyun.com/repository/gradle-plugin")
            maven("https://maven.aliyun.com/repository/google")
            maven("https://maven.aliyun.com/repository/public")
            google {
                content {
                    includeGroupByRegex("com\\.android.*")
                    includeGroupByRegex("com\\.google.*")
                    includeGroupByRegex("androidx.*")
                }
            }
            mavenCentral()
            gradlePluginPortal()
        }
    }
}
dependencyResolutionManagement {
    val onCi = System.getenv("CI") != null
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        if (onCi) {
            google()
            mavenCentral()
        } else {
            maven("https://maven.aliyun.com/repository/google")
            maven("https://maven.aliyun.com/repository/public")
            google()
            mavenCentral()
        }
    }
}
rootProject.name = "TimeMark"
include(":app")
