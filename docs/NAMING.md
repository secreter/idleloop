# 产品命名探索记录

记录 IdleLoop 命名决策的完整过程，便于未来若需改名或扩展子品牌时回顾思路、可用域名池与方法论备忘。

## 最终决定

- **产品名**：IdleLoop（仓库 / 包名 `idleloop`；品牌呈现 `IdleLoop`）
- **主域名**：`idleloop.io`（已通过 Identity Digital 官方 RDAP 确认可用）
- **决定时间**：2026-05-12
- **决定人**：作者

### 选 IdleLoop 的理由

1. 与项目仓库名一致，避免代号 / 品牌名分裂带来的认知和工程成本。
2. `idleloop.io` 实际可用（之前误以为不可得，是查询方法不可靠造成的假阳性）。
3. 程序员血脉直接：`idle loop` 是操作系统术语（CPU 空闲循环），描述产品本质（在 idle 时段运行 loop 任务）极其精准。
4. 自我描述强：英文圈与中文圈技术人员看到名字基本能猜到产品做什么。
5. 多端延展不受限：loop 这个动作可以在 CLI、Desktop、Mobile、Cloud 任何端发生，名字不会绑死任何形态。
6. 即便未来做品牌升级，`idleloop.io` 仍可作为开发者社区入口（参考 Vercel 之于 ZEIT）。

### 已知局限

- `idleloop.com` 已被注册，长期商业化时需考虑收购或换主域名。
- `idle` 在消费者语境略偏被动（"闲置 / 懒散"），若未来做大众端 App，可考虑用备选池中的 Tildawn / WhileUntil 等作子品牌或重命名。
- 商标尚未查询，正式商业化前需到 USPTO / EUIPO / 中国商标局检索。
- App Store / Google Play 名称是否冲突未检查。

---

## 域名查询方法论（重要技术备忘）

这一轮探索踩过的最大坑：**`.io` 域名通过 `rdap.org` 中转查询会返回大量假阴性**——明明已被注册十几年的域名，rdap.org 也会返回 404，导致误以为可用。

### 可信端点

| TLD | RDAP 端点 |
|-----|---------|
| `.com` / `.net` | `https://rdap.verisign.com/com/v1/domain/<domain>` |
| `.io` | `https://rdap.identitydigital.services/rdap/domain/<domain>` |
| 其他 | 查 [IANA RDAP 目录](https://data.iana.org/rdap/dns.json) 找权威端点 |

### 不要信任

- `rdap.org` 通用中转：对 `.io` 不可靠，常返回假阴性。
- 单纯 `dig NS`：未配 DNS 的注册域名会被误判为可用。
- 注册商查询页面：偶有缓存延迟。

### 域名查询脚本（已验证）

```bash
# .io 权威查询
check_io() {
  local d=$1
  local response=$(curl -s -w "\n||HTTP_CODE:%{http_code}" --max-time 10 \
    "https://rdap.identitydigital.services/rdap/domain/$d")
  local code=$(echo "$response" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
  if [ "$code" = "404" ]; then
    echo "AVAILABLE: $d"
  elif [ "$code" = "200" ]; then
    local created=$(echo "$response" | python3 -c \
      "import json,sys; d=json.loads(sys.stdin.read().split('||')[0]); \
       e=d.get('events',[]); [print(x['eventDate']) for x in e if x.get('eventAction')=='registration']" \
      2>/dev/null)
    echo "TAKEN ($created): $d"
  else
    echo "HTTP $code: $d"
  fi
}

# .com 查询
check_com() {
  local d=$1
  local code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    "https://rdap.verisign.com/com/v1/domain/$d")
  case "$code" in
    404) echo "AVAILABLE: $d" ;;
    200) echo "TAKEN: $d" ;;
    *) echo "HTTP $code: $d" ;;
  esac
}
```

### 还需另查（脚本无法覆盖）

- 商标：USPTO（美）、EUIPO（欧）、CTMO（中国商标局）
- App Store / Google Play 应用名冲突
- GitHub organization / npm package 是否可得
- Twitter / X handle 是否可得

---

## 候选词盘点（按隐喻角度分组）

下面所有"可用 / 已占"状态截至 2026-05-12，未来核实需重跑查询脚本。

### 1. 夜晚 / 睡眠意象（"AI 在你睡觉时干活"）

| 名字 | 状态 | 备注 |
|------|------|------|
| Nocturne | 信息不全 | 「肖邦夜曲」感，国际工程师圈识别度高 |
| Vesper | `vesper.io` 已占（2014）| 晚星 / 邦德女郎 |
| Owlet | 未查 | 小猫头鹰，夜行 |
| Moonshine | 未查 | 月光 + 私酿酒双关 |
| Nightcap | 未查 | 睡前小酌 |
| Nox | `nox.io` 已占 | 拉丁语"夜" |
| Yume | `yume.io` 已占 | 日语"梦" |

### 2. 童话 / 家精意象（"夜里悄悄帮你干活的小精灵"）

| 名字 | 状态 | 备注 |
|------|------|------|
| Brownie | `brownie.com` 已占 | 苏格兰传说家精，主人睡觉时打理家务 |
| Cobbler | `cobbler.io` 已占 | 格林童话《小鞋匠和精灵》隐喻 |
| Hob / Hobgoblin | 未查 | brownie 同类家精 |
| Squire | `squire.io` 状态未权威核实 | 骑士侍从 |
| Butler | `butler.io` 状态未权威核实 | 管家 |
| Valet | 未查 | 贴身侍从 |
| Steward | 未查 | 总管 |

### 3. 拾穗 / 收割（"用掉将要作废的东西"）

| 名字 | 状态 | 备注 |
|------|------|------|
| Glean | `glean.com` / `.io` / `.ai` 全占 | 圣经典故，拾穗 |
| Reap | `reap.io` 状态未权威核实 | "you reap what you sow" |
| Harvest | `harvest.io` 状态未权威核实 | 收割 |
| Forage | 未查 | 觅食 |
| Salvage | `salvage.io` 状态未权威核实 | 灾难打捞 |
| Reclaim | `reclaim.io` 状态未权威核实 | 取回 |

### 4. 燃烧 / 熔炼（"烧光要过期的 token"）

| 名字 | 状态 | 备注 |
|------|------|------|
| Burndown | `burndown.com` 已占 | Agile 术语冲突 |
| BurnToken | `burntoken.com` 已占；`.io / .app / .ai / .co` 可用 | **否决**，详见下方 |
| Burnup | 未权威核实 | |
| BurnQuota | `burnquota.com` 可用（rdap.org 查询，需复核） | 描述性强 |
| Kiln | `kiln.io` 已占（2014） | 窑炉，烧燃料出陶器，叙事极强 |
| Smolder | `smolder.io` 已占（2021） | 闷烧 |
| Smelt | `smelt.io` 已占（2023） | 冶炼 |
| Cinder | `cinder.com` 已占 | 余烬 |
| Ember | 已占 | 余火 |
| Scorch | `scorch.io` 已占（2011） | 烧焦 |
| Char | `char.io` 已占（2016） | 烧焦 |
| Singe | 状态未权威核实 | 轻烧 |
| Pyre | 未查 | 火葬堆（太重） |
| Inferno | 未查 | 太戏剧化 |
| Tinder | `tinder.io` 状态未权威核实 | 引火物（但 Tinder 是约会 App） |
| Kindling | `kindling.com` 已占；`.io` 状态未权威核实 | 引火柴 |

### 5. 啃食 / 灌入（"把 token 吃光 / 灌下去"）

| 名字 | 状态 | 备注 |
|------|------|------|
| TokenChomp | `tokenchomp.com` 可用（需复核） | 啃 token |
| TokenChug | `tokenchug.com` 可用（需复核） | 灌 token |
| GobbleTokens | 可用（需复核） | 狼吞虎咽 |
| ChompTokens | 可用（需复核） | |

### 6. 转化 / 萃取（"把浪费发挥成价值"——最贴合 MVP 价值主张）

| 名字 | 状态 | 备注 |
|------|------|------|
| Distill | `distill.io` 已占（2011） | 蒸馏，匠人感强 |
| Refine | `refine.io` 状态未权威核实 | 精炼 |
| Compost | `compost.io` 状态未权威核实 | 堆肥（厨余 → 肥料） |
| Upcycle | `upcycle.com` / `.app` 已占；`.io` 状态未权威核实 | 升级再造 |
| Alchemy | 状态未权威核实 | 炼金术 |
| Recoup | 状态未权威核实 | 回收损失 |
| Crumbs | 状态未权威核实 | 不浪费一粒面包屑 |

### 7. 黄金矿工 / 淘金（"从大量泥沙里筛出金子"）

| 名字 | 状态 | 备注 |
|------|------|------|
| TokenMiner | `.com` 已占；`.io / .app / .ai` 可用（需复核） | **否决**，详见下方 |
| Pan | `pan.io` 已占（2014） | 淘金动作 |
| Sift | `sift.io` 已占 | 筛选 |
| Prospector | 状态未权威核实 | 勘探者 |
| Pickaxe | 状态未权威核实 | 鹤嘴锄 |
| Nugget | 状态未权威核实 | 金块 |
| Lode | 状态未权威核实 | 矿脉 |
| Hook | `hook.com` / `.app` 已占；`.io` 状态未权威核实 | 黄金矿工游戏的抓钩 |
| Pyrite | 状态未权威核实 | 愚人金（反差萌） |

### 8. 多端助手 / 收件箱（适用于未来扩到多端形态）

| 名字 | 状态 | 备注 |
|------|------|------|
| Hopper | `hopper.io` 已占；`.com` 是知名旅行 App | 料斗，多端投料 + 中央处理 |
| Stash | 状态未权威核实 | 藏起来 |
| Nook | 状态未权威核实 | 小角落 |
| Defer | 状态未权威核实 | 推迟 |
| Errand | 状态未权威核实 | 跑腿 |
| Relay | 状态未权威核实 | 接力 |
| Intern | 状态未权威核实 | 实习生（自嘲风） |
| Sidekick | 状态未权威核实 | 搭档 |

### 9. 循环关键字（程序员诗）—— **当前主选系**

通过 .io 官方 RDAP 权威验证，2026-05-12 状态：

| 域名 | 状态 | 备注 |
|------|------|------|
| **`idleloop.io`** | **可用 ✓**（最终选择） | 与项目名一致 |
| `whileuntil.io` | 可用 | 程序员循环关键字双拼 |
| `whileidle.io` | 可用 | "while you're idle"语义直接 |
| `tildawn.io` | 可用 | "till dawn"，干到天亮，叙事感强 |
| `tilreset.io` | 可用 | 直白：干到额度重置 |
| `tilmorning.io` | 可用 | 干到天亮 |
| `tildawn.io` | 可用 | （重复，仅强调一次）|
| `dountil.io` | 可用 | `do...until` |
| `dowhile.io` | 可用 | `do...while` |
| `loopuntil.io` | 可用 | |
| `looptilreset.io` | 可用 | |
| `untilreset.io` | 可用 | |
| `idlewhile.io` | 可用 | |
| `whileloop.io` | **已占**（2019） | |
| `idleloop.com` | 已占 | 长期商业化时考虑收购 |
| `whileuntil.com` | 已占 | |
| `whileidle.com` | 已占 | |
| `dountil.com` | 已占 | |

---

## 被否决的方向（及理由）

### BurnToken

- **域名**：`burntoken.com` 已占；`.io / .app / .ai / .co / .net` 可用
- **否决理由**：
  1. "Burn token" 在加密货币领域是销毁代币的标准操作术语，crypto 圈强占用。
  2. SEO 死局：搜索 "burn token" 返回的全是加密项目。
  3. 海外用户第一反应会误认为加密产品，需大量精力扭转认知。
  4. 名字像功能描述，缺乏品牌识别度，未来扩展功能时会被限制。
  5. 商标层面 crypto 圈存量项目多，风险高。

### TokenMiner

- **域名**：`tokenminer.com` 已占；`.io / .app / .ai` 可用
- **否决理由**：
  1. 比 BurnToken 更严重——"token mining"是整个加密货币行业的核心动词。
  2. SEO 比 BurnToken 还彻底地死掉（矿机 / 矿池 / 挖矿教程占据全部结果）。
  3. **语义方向是反的**：crypto 挖矿是"算力 → 得到 token"；本产品是"消耗 token → 得到产出"。懂行的人看到会觉得名字逻辑错。
  4. 商标和法律风险极高。

### Kiln（窑炉）

- **域名**：`kiln.io` 已占（2014 年），`.com` / `.dev` 同样被占
- **否决理由**：纯域名不可得。隐喻本身（烧燃料出陶器）和产品契合度其实很高，未来若做转化型重命名可重新评估其他烧 / 炼系名字（Smelter、Distillery、Refinery 等）。

### Distill / Salvage / Refine / Compost 等"萃取转化"系

- **状态**：核心 `.io` 和 `.com` 大多被占（`distill.io` 2011 起，`coda.io` 2012 起）。
- **否决理由**：域名不可得。语义最贴合"把浪费发挥成价值"这个 framing，未来若做品牌升级仍可作为重命名候选——前提是当时这些域名仍未被占用，或可负担收购成本。

### Pan / Sift / Hook 等"黄金矿工"系

- **状态**：核心 `.io` 几乎全部被占（`pan.io` 2014、`sift.io`、`hook.io` 等）。
- **否决理由**：同上，域名不可得。

---

## 命名探索的思路演进（仅作过程记录）

1. **起点**：项目代号 `idleloop`，作者自己觉得"idle = 闲置"略偏被动，启动重新命名。
2. **第一轮**：夜晚 / 童话精灵 / 烧 / 烹饪 等隐喻方向（Nocturne / Brownie / Kiln 等）。
3. **拐点 A**：作者提出多端产品规划（CLI → 桌面 → 手机 → 云端），转向品牌型角色名（Hopper / Squire / Butler）。
4. **拐点 B**：作者拉回核心 MVP——"烧光将过期的 token 省钱"，转向 Kiln / BurnToken。
5. **拐点 C**：作者细化为"把浪费的 token 发挥出价值"（不是破坏，是转化），转向 Distill / Compost / Salvage 萃取系。
6. **拐点 D**：作者提出 TokenMiner（黄金矿工意象），讨论 crypto 心智冲突，转向 Pan / Sift / Prospector。
7. **拐点 E**：作者自己提出 `whileuntil.io`，发现已被声称"可用"的众多 `.io` 域名其实早被注册，暴露 `rdap.org` 查询方法不可靠。
8. **终局**：用 Identity Digital 官方 RDAP 权威核实后发现 `idleloop.io` 实际可用，回到最初的名字。

---

## 未来若需改名 / 起子品牌的快速参考

按推荐度排序，假设当时这些 `.io` 仍可用（需重新核实）：

| 优先级 | 名字 | 适用场景 |
|--------|------|---------|
| 1 | `tildawn.io` | 故事感最强，"till dawn"——干到天亮。适合做大众端品牌升级 |
| 2 | `whileuntil.io` | 程序员诗，适合做开发者社区子品牌 |
| 3 | `whileidle.io` | 语义最直接 |
| 4 | `tilreset.io` | 直白，适合做核心功能子品牌 |
| 5 | （萃取系）若 `distill.io` / `refine.io` 哪天被释放，立即抢注 |

**改名触发条件**：
- 商标无法注册 / 收到法律函
- 产品形态扩到大众端，"idle" 字面意义在消费者语境造成持续误解
- `idleloop.com` 收购窗口期到来
