# @ams/music-bundle

AMS music profile 的 DSH 组合包：通过 cordis.patch.yml 插入 Host/Client 两行。

~~~yaml
- insert:
    - id: ams-plugin-core
      name: '@ams/plugin-core'
    - id: ams-plugin-ui
      name: '@ams/plugin-ui'
~~~

## 安装

由 dsh plugin 安装到目标 profile 后，会自动追加到 profile 的 dsh.profile.bundles（因为声明了 dsh.bundle.patch）。

依赖说明：本包刻意不声明运行时 dependencies —— 三个包由启动器/验证脚本用同一批 file: tarball 一次性安装，保证离线可装、版本可控。

## 后续（M1）

- 把 product.patch.yml（遥测/账号/危险行禁用）并入内核层，不放在本 bundle；
- 新增插件行时同步更新本 patch，并保持 engines.dsh 与内核版本一致。
