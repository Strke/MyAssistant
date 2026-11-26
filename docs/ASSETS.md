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
      "secretKind": "ssh_key"
    }
  ]
}
```

`kind`：`server`、`vm`、`nas`、`router`、`switch`、`laptop`、`desktop`、`phone`、`tablet`、`container`、`cloud`、`other`。

`method`：`ssh`、`rdp`、`vnc`、`http`、`https`、`smb`、`serial`、`other`。

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

这些工具**不会返回密钥值**。需要读取密钥时仍然由 agent 显式调用 `vault_get`，并会写审计日志。

当前版本只提供资产与连接信息，不会自动执行 SSH/RDP 等远程命令。后续如果要让 agent 直接连接，建议单独增加受控的 `asset_exec` 工具，在工具内部解析 vault 密钥并执行命令，避免把私钥明文放进模型上下文。

## Agent 如何使用

典型对话：

```text
用户：我有哪些机器？
Agent → asset_list()

用户：Mac mini 怎么连？
Agent → asset_connection("mac-mini")
       → 返回 ssh renzelin@100.88.41.16:22，密钥名 macmini_ssh

用户：帮我看下 Mac mini 的磁盘
Agent → 需要执行远程命令；当前版本会提示需要后续的受控执行工具
```

## 环境变量

```bash
ASSETS_ENABLED=true
ASSETS_PATH=./data/assets.json
```

资产文件权限为 `0600`，目录为 `0700`。不要把密钥值写进 `assets.json`。
