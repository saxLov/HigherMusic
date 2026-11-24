# 第三方说明

本源码依赖清单以 package.json 为准。依赖通过安装取得，不将 node_modules 提交仓库。

- Electron / Chromium：桌面运行环境。Release 保留 LICENSE.electron.txt 与 LICENSES.chromium.html。
- MakcRe/KuGouMusicApi：https://github.com/MakcRe/KuGouMusicApi ，安装脚本固定提交 5d6c9f7b180279c9dd08bc6f7159de52a856d587。再分发须保留其上游许可与声明。
- @neteasecloudmusicapienhanced/api：同版本备用音源及歌词适配。
- music-metadata：历史本地文件模块使用，本版相关产品入口已关闭。
- Folia：https://github.com/chthollyphile/folia-major ，参考了其歌词流程与酷狗设备验证桥接思路；本项目相关代码为独立编写，未复制其源码。

上述说明不是对所有上游许可兼容性的法律结论。作者选择本项目许可证时，应核对各依赖、运行时及引用材料的实际许可。封面、歌词和音乐内容不属于本项目原创资产。
