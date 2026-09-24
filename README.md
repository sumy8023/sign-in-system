# 签到打卡系统

一个基于 Node.js、Express、Redis、MySQL 和 uni-app 的二维码签到打卡系统，当前版本为 `3.0.2`。

项目包含后端服务、学生端提交页面、管理端源码和本地演示数据库脚本，适合用于学习二维码签到、签到记录管理、地点绑定和基础权限控制。

仓库地址：[https://github.com/sumy8023/sign-in-system](https://github.com/sumy8023/sign-in-system)

## 功能

- 生成定时刷新的签到二维码。
- 支持签到、签退和地点绑定。
- 查询、筛选、编辑、删除和导出签到记录。
- 统计签到时长并提供排行榜。
- 管理员维护签到地点和普通用户密钥。
- 使用 Redis 管理二维码 Token、刷新冷却和在线状态。
- 使用 MySQL 保存地点、密钥和签到记录。

## 项目结构

```text
QD-node/   Node.js 后端服务和学生端静态页面
QD-web/    uni-app 管理端源码
SQL/       本地演示数据库脚本
```

## 环境要求

- Node.js
- Redis
- MySQL 8 或兼容版本
- uni-app 开发工具（仅构建或运行管理端时需要）

## 本地运行

### 1. 初始化数据库

创建数据库 `qiandao_demo`，然后导入 `SQL` 目录中的脚本。

仓库中的数据均为演示数据：

- 管理员密钥：`demo-admin-key`、`demo-admin-key-2`
- 普通用户密钥：`demo-user-key-a` 至 `demo-user-key-e`
- 演示地点：`demo-a` 至 `demo-e`

### 2. 配置后端

复制 `QD-node/.env.example` 作为配置参考，并在启动进程前设置环境变量。项目直接读取进程环境变量，不会自动加载 `.env` 文件。

PowerShell 示例：

```powershell
$env:PORT = "4800"
$env:REDIS_URL = "redis://127.0.0.1:6379"
$env:DB_HOST = "127.0.0.1"
$env:DB_PORT = "3306"
$env:DB_USER = "root"
$env:DB_PASSWORD = ""
$env:DB_NAME = "qiandao_demo"
```

### 3. 启动后端

```powershell
cd QD-node
npm install
node server.js
```

学生端地址：<http://127.0.0.1:4800/student/>

管理端源码位于 `QD-web`，可使用 uni-app 工具链运行或构建。

## 发行版

当前发行版：[v3.0.2](https://github.com/sumy8023/sign-in-system/releases/tag/v3.0.2)

发行版压缩包包含可直接运行的后端单文件、学生端静态资源、管理端 H5 构建产物、演示 SQL 和配置模板。生产部署前请替换所有演示密钥和本地配置。

## 部署前检查

1. 替换 SQL 中的演示密钥。
2. 设置真实的 Redis 和 MySQL 环境变量。
3. 为生产环境配置 HTTPS、访问控制和数据库备份。
4. 不要提交 `.env`、日志、依赖目录、构建缓存或真实签到数据。
5. 如果旧凭据曾经出现在其他版本或历史提交中，请立即重置相关凭据。

## Git 提交建议

仓库默认忽略 `node_modules`、`dist`、`unpackage`、日志和本地环境文件。提交前请检查：

```powershell
git status
git diff --cached
```

## 许可证

本项目采用 [MIT License](LICENSE) 开源。

## 免责声明

使用者应自行确认已经获得部署系统、采集考勤信息、存储个人信息和处理签到记录所需的授权，并遵守适用的法律法规、学校制度和组织规定。请勿使用本项目进行未经授权的考勤、监控、数据采集或其他违法活动。

仓库中的演示密钥、默认配置和示例数据仅用于本地测试，部署前必须替换。

本项目代码均由 AI 辅助开发，未经完整的专业安全审计或在所有目标环境中充分验证。因使用本项目产生的漏洞、安全性问题、数据丢失、服务中断或其他损失，由使用者自行评估并承担责任。本项目仅供学习和交流使用。

该项目仅供学习，如果有 BUG 或者不满意的地方请自行修改。
