# 资产库与密钥库

资产库记录“我有什么机器/设备、怎么连”，密钥库保存真正的密钥值。两者分开：

```text
data/assets.json   资产元数据，明文 JSON，权限 0600
data/vault.enc     密钥值，AES-256-GCM 加密，主密钥在 macOS Keychain
```

资产条目里只保存 vault 密钥名，例如 `macmini_ssh`，不保存私钥、密码或 token 本身。

## 资产模型

```json
{
  "id": "mac-mini",
  "name": "Mac mini",
  "kind": "server",
  "status": "active",
  "addresses": ["100.88.41.16"],
  "tags": ["mac", "tailscale", "assistant"],
  "os": "macOS",
  "location": "home",
  "notes": "A 机，assistant + RAG",
  "access": [
    {
      "id": "tailscale-ssh",
      "method": "ssh",
      "host": "100.88.41.16",
      "port": 22,
      "username": "renzelin",
      "secretName": "macmini_ssh",
      "secretKind": "ssh_key",
      "execEnabled": true
    }
  ]
}
```

`kind`：`server`、`vm`、`nas`、`router`、`switch`、`laptop`、`desktop`、`phone`、`tablet`、`container`、`cloud`、`other`。

`method`：`ssh`、`rdp`、`vnc`、`http`、`https`、`smb`、`serial`、`other`。

`execEnabled`：只有显式设为 `true` 的 SSH access 才允许 `asset_exec` 执行远程命令，默认 `false`。

`secretKind`：`ssh_key`、`password`、`token`、`certificate`、`other`。

## 创建资产

```bash
npm run assets -- add mac-mini \
  --name "Mac mini" \
  --kind server \
  --address 100.88.41.16 \
  --tag mac \
  --tag tailscale \
  --os macOS \
  --notes "A 机，assistant + RAG" \
  --access 'ssh:label=tailscale-ssh,host=100.88.41.16,port=22,user=renzelin,secret=macmini_ssh,secretKind=ssh_key'
```

`--access` 的格式：

```text
method:label=...,host=...,port=...,user=...,secret=...,secretKind=...,command=...,notes=...
```

复杂命令或带逗号的字段用 `--access-json`：

```bash
npm run assets -- add router \
  --name "Home router" \
  --kind router \
  --address 192.168.1.1 \
  --access-json '{"method":"https","port":443,"username":"admin","secretName":"router_admin","secretKind":"password","notes":"Web UI"}'
```

## 查看和管理

```bash
npm run assets -- list
npm run assets -- list --json
npm run assets -- show mac-mini
npm run assets -- show mac-mini --json
npm run assets -- update mac-mini --status retired
npm run assets -- rm mac-mini
```

`update` 只覆盖显式传入的字段；`--address`、`--tag`、`--access` 一旦传入会整体替换对应列表。

## 存密钥

密钥值仍然走 vault：

```bash
npm run vault -- set macmini_ssh --description "Mac mini SSH private key" --file ~/.ssh/id_ed25519
npm run vault -- set router_admin --description "Router admin password"
```

`vault set` 会提示输入值，不会把值写进 shell history；SSH 私钥等多行内容用 `--file` 从文件读取。

检查资产引用的密钥是否存在：

```bash
npm run assets -- doctor
```

输出只会显示缺失的密钥名，不会显示密钥值。

## Agent 工具

启用后 agent 可以调用：

- `asset_list(query?, kind?, tag?, status?)`：列出机器/设备，只返回元数据
- `asset_get(id)`：查看一个资产的完整信息，包括连接方式和 vault 密钥名
- `asset_connection(id, accessId?)`：返回 host、port、username、默认命令模板和密钥名

这些资产工具**不会返回密钥值**。需要读取密钥时仍然由 agent 显式调用 `vault_get`，并会写审计日志。远程执行使用单独的 `asset_exec`，见下一节。

## Agent 如何使用

典型对话：

```text
用户：我有哪些机器？
Agent → asset_list()

用户：Mac mini 怎么连？
Agent → asset_connection("mac-mini")
       → 返回 ssh renzelin@100.88.41.16:22，密钥名 macmini_ssh

用户：帮我看下 Mac mini 的磁盘
Agent → asset_exec("mac-mini", "df -h")
       → 返回磁盘信息；私钥不进入模型上下文
```

## 执行远程命令

资产条目需要显式打开执行权限：

```bash
--access 'ssh:label=tailscale-ssh,host=10.0.0.2,port=22,user=renze.lin,secret=macmini_ssh,secretKind=ssh_key,exec=true'
```

`exec=true` 只对 `ssh` 且 `secretKind=ssh_key` 的 access 生效。Agent 工具：

```text
asset_exec(id, command, accessId?)
```

执行流程：

1. 从资产库读取 host、port、username 和 vault 密钥名
2. 在工具内部调用 vault 读取私钥
3. 把私钥写入权限 `0600` 的临时文件
4. 用 `ssh -i <临时文件>` 执行远程命令
5. 删除临时文件
6. 返回 stdout、stderr、exitCode；私钥不会进入模型上下文

安全限制：

- 默认 `ASSET_EXEC_ENABLED=false`，需要显式打开
- 只支持 SSH，不支持密码/RDP/VNC
- 只允许 `execEnabled=true` 的 access
- 只允许 `secretKind=ssh_key`
- 私钥必须是未加密的 OpenSSH/PEM 私钥；带 passphrase 的 key 需要先交给 ssh-agent，当前工具不会交互输入 passphrase
- `asset_exec` 只在本地会话加载，钉钉会话不会加载，避免外部消息触发远程命令
- 资产里引用为 `ssh_key` 的密钥会被保护：agent 调用 `vault_get` 也拿不到，只能通过 `asset_exec` 使用
- 每次执行写 `data/asset-exec-audit.log`，只记录资产、access、命令 SHA-256、命令长度、退出码和耗时，不记录命令正文或密钥
- 远程命令以非交互模式执行，不支持需要 TTY 的交互式命令
- 远程命令在目标机器上通过 shell 执行，不会有本地 shell 注入
- 默认超时 60 秒，输出默认最多 12000 字符

配置：

```bash
ASSET_EXEC_ENABLED=true
ASSET_EXEC_TIMEOUT_SECONDS=60
ASSET_EXEC_MAX_OUTPUT_CHARS=12000
ASSET_EXEC_AUDIT_PATH=./data/asset-exec-audit.log
```

`asset_exec` 是高风险工具。当前只对显式标记 `exec=true` 的 SSH access 开放；如果只是让 agent 查看资产，使用 `asset_list` / `asset_get` / `asset_connection` 即可。

## 环境变量

```bash
ASSETS_ENABLED=true
ASSETS_PATH=./data/assets.json
```

资产文件权限为 `0600`，目录为 `0700`。不要把密钥值写进 `assets.json`。
