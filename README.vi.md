[🇬🇧 English](README.md)

# claudekei

**Plugin điều phối agent cho Claude Code** · bản port của [oh-my-openkei](https://www.npmjs.com/package/oh-my-openkei) (OpenCode)

by **Kei**

---

## Plugin này làm gì

Plugin Claude Code (tên plugin: `claudekei`) biến luồng hội thoại chính thành **Orchestrator**:
chia việc cho một đội subagent chuyên trách, và ghi nhớ session của từng subagent dưới alias
ngắn (`exp-1`, `ora-1`, `fed-2`) để các câu hỏi tiếp theo được xử lý tiếp trong cùng context
thay vì bắt đầu lại từ đầu, giống cơ chế `task_id` bên OpenCode.

| Thành phần | Cách hoạt động trong Claude Code |
|---|---|
| Orchestrator là agent chính | `settings.json` → `"agent": "orchestrator"` |
| Các specialist | Subagent trong `agents/*.md`, gọi bằng `claudekei:<tên>` qua tool `Agent` |
| Tái sử dụng session | `SendMessage` (resume gốc của Claude Code) + hook ánh xạ alias → agent id |
| Skill riêng cho từng agent | Frontmatter `skills:` (tên có namespace `claudekei:<name>`, nạp sẵn; FE/BE/BA còn tự kiểm tra và nạp lại bằng `Skill` ở bước đầu) |
| Quyền MCP theo agent | Allowlist `tools:` (`mcp__plugin_claudekei_context7__*`, …) |
| Planner / Sprinter / Business Analyst | `claude --agent claudekei:<tên>` hoặc `/claudekei:plan`, `/claudekei:sprint`, `/claudekei:analyze` ngay trong hội thoại |
| Nhắc workflow | Hook `UserPromptSubmit` / `PostToolUse` |

## Có gì mới trong v0.5.0

- **`/claudekei:agent <tên>`** chọn agent chính cho **session mới** ngay trong ô chat, không
  cần CLI. Xem [Đổi agent chính](#đổi-agent-chính).
- **`claudekei.jsonc`** đặt model/effort cho specialist, giống `oh-my-openkei.jsonc`; repo có sẵn
  file mẫu để copy. Khóa
  `variant` của OpenCode đổi thành `effort` cho khớp Claude Code. Xem [Model và effort](#model-và-effort).
- **Bỏ** hai specialist `trigger-developer` và `observer`.
- Plugin không còn ghi model/effort cho agent chính: bạn chọn trong app.

## Cài đặt

Yêu cầu: Claude Code ≥ 2.1, Node.js ≥ 18 (hook chạy bằng `node`).

```bash
claude plugin marketplace add keibn29/claudekei-plugin
```

```bash
claude plugin install claudekei@claudekei
```

Hoặc trong Claude Code: `/plugin marketplace add keibn29/claudekei-plugin`, rồi
`/plugin install claudekei@claudekei`.

Cập nhật lên bản mới nhất:

```bash
claude plugin marketplace update claudekei
```

```bash
claude plugin update claudekei@claudekei
```

Muốn dùng bản clone ở máy thì thêm thư mục: `claude plugin marketplace add ~/Projects/claudekei-plugin`.

Chạy thử không cần cài:

```bash
claude --plugin-dir ~/Projects/claudekei-plugin
```

Kiểm tra: mở session và gõ `ping all agents`, orchestrator sẽ gọi lần lượt từng specialist.

> Plugin đặt **Orchestrator làm agent chính mặc định** ở mọi nơi nó được bật. Muốn dùng
> Claude bình thường trong một project, tắt plugin ở đó:
> `.claude/settings.json` → `{"enabledPlugins": {"claudekei@claudekei": false}}`.

## Đội agent

### Agent chính (agent bạn trò chuyện trực tiếp)

| Agent | Khởi động | Model (mặc định khi dùng CLI¹) | Vai trò |
|---|---|---|---|
| **orchestrator** (mặc định) | `claude` / `/claudekei:orchestrate` | opus | Điều phối, ưu tiên ủy quyền: chia việc, chạy song song, reuse session, tổng hợp và kiểm tra |
| **planner** | `claude --agent claudekei:planner` / `/claudekei:plan` | opus | Lập kế hoạch qua phỏng vấn; chỉ ủy quyền cho explorer/librarian/oracle/designer; trả về `<planner-plan>` |
| **sprinter** | `claude --agent claudekei:sprinter` / `/claudekei:sprint` | sonnet | Tự làm nhanh; hook chặn ủy quyền (Agent) và resume child (SendMessage) |
| **business-analyst** | `claude --agent claudekei:business-analyst` / `/claudekei:analyze` | opus | Nghiên cứu, viết yêu cầu, chiến lược; lưu phân tích vào `.business-analyst/*.md` |

¹ Dùng khi không có gì khác chọn model, ví dụ `claude --agent claudekei:sprinter`. App desktop
luôn mở session bằng model trong ô chọn model, và giá trị đó thắng.

### Đổi agent chính

Claude Code không có phím Shift+Tab để đổi agent như OpenCode. Dùng một trong các lệnh sau,
gõ ngay trong ô chat:

| Bạn muốn | Gõ | Có hiệu lực |
|---|---|---|
| Đổi vai **ngay trong hội thoại này**, giữ nguyên ngữ cảnh | `/claudekei:plan`, `/claudekei:sprint`, `/claudekei:analyze`, `/claudekei:orchestrate` | Ngay lập tức |
| Đổi agent mà **session mới** khởi động cùng (giới hạn tool thật, như `--agent`) | `/claudekei:agent planner` (hoặc `orchestrator`, `sprinter`, `business-analyst`) | **Chỉ ở session mới** |
| Quay về mặc định (orchestrator) | `/claudekei:agent reset` | **Chỉ ở session mới** |
| Xem agent mặc định hiện tại | `/claudekei:agent` | — |

> [!WARNING]
> `/claudekei:agent` **không** đổi hội thoại bạn đang gõ lệnh. Hội thoại đó vẫn giữ agent
> cũ. Chạy lệnh xong, hãy **mở session mới** (Cmd+N trong app desktop, hoặc chạy lại
> `claude`) để dùng agent mới.
>
> - App sẽ hiện **"A hook blocked your prompt"**. Đây là bình thường: plugin đã lưu lựa chọn
>   và chặn tin nhắn lại để không tốn lượt model. Không cần bấm Edit prompt hay gửi lại.
> - Lựa chọn giữ nguyên tới khi bạn đổi hoặc chạy `/claudekei:agent reset`. Không cần gõ lại
>   mỗi lần mở session. Mặc định nó được lưu **theo từng project** trong
>   `.claude/settings.local.json` (nhớ để file này ngoài git).

**Không muốn có thư mục `.claude/` trong project?** Thêm `"agentScope": "global"` vào
`~/.claude/claudekei.jsonc`. Khi đó `/claudekei:agent` lưu lựa chọn vào `~/.claude/settings.json`,
áp dụng cho **mọi project**, và không ghi gì vào project. Project nào vẫn tự đặt `agent` riêng
thì project đó thắng; lệnh sẽ báo cho bạn biết.

Ví dụ: `/claudekei:agent planner` → Cmd+N → lập kế hoạch → `/claudekei:agent reset` →
Cmd+N → triển khai bằng orchestrator.

Từ terminal, `claude --agent claudekei:<tên>` mở session với agent đó luôn.

### Specialist (`subagent_type: claudekei:<tên>`)

| Agent | Model mặc định | Quyền | Vai trò |
|---|---|---|---|
| explorer | haiku, effort low | chỉ đọc (+ Serena nếu cấu hình) | Tìm file, symbol, pattern |
| librarian | haiku, effort low | chỉ đọc + `ToolSearch` + context7, grep_app, websearch (+ Atlassian); WebFetch/WebSearch chỉ làm phương án dự phòng | Tra tài liệu thư viện, API, ví dụ GitHub |
| oracle | opus, effort high | chỉ đọc, skill `claudekei:simplify` | Kiến trúc, trade-off, review code, bug khó |
| debugger | sonnet, effort high | chỉ đọc | Tìm nguyên nhân gốc, không sửa |
| designer | sonnet, effort high | đọc + chỉ ghi spec (`*.md`/`*.mdx`, `.designer/`); không Bash, không gọi subagent; hook `PreToolUse` chặn sửa code | Định hướng, spec và review UI/UX; phần code giao cho frontend-developer |
| frontend-developer | sonnet, effort high | đầy đủ (không gọi subagent), skill `claudekei:vercel-react-best-practices`, `claudekei:karpathy-guidelines` | Code phía client + test |
| backend-developer | sonnet, effort high | đầy đủ (không gọi subagent), skill `claudekei:backend-developer`, `claudekei:karpathy-guidelines` | Code phía server + test |

### Model và effort

**Agent chính** (orchestrator, planner, sprinter, business-analyst) chạy theo model và effort
của session. Chọn trong menu model (Cmd+Shift+I) và menu effort (Cmd+Shift+E) của app, hoặc
bằng `/model` và `/effort`; app tự nhớ lựa chọn. Nên chọn theo cột "Model mặc định" ở bảng trên (Opus cho orchestrator, planner, business-analyst; Sonnet cho sprinter).
Plugin không đặt hai giá trị này vì app desktop luôn mở session kèm `--model`/`--effort`,
và hai cờ này thắng mọi giá trị trong settings.
`claudekei.jsonc` có khối `primaryAgents` đặt model/effort mặc định cho từng agent chính;
extension ClaudeKei cho VS Code áp dụng khi bạn chuyển agent chính (app và CLI bỏ qua),
và `/claudekei:agent <tên>` sẽ nhắc giá trị đã cấu hình.

**Specialist** dùng model mặc định trong bảng trên. Muốn đổi mà không sửa plugin, tạo
`~/.claude/claudekei.jsonc` (mọi project) hoặc `<project>/.claude/claudekei.jsonc` (riêng một
project, ưu tiên hơn). Định dạng giống `oh-my-openkei.jsonc` nhưng chỉ có một bảng `subAgents`
(tên agent → `{ "model", "effort" }`), không còn nhiều preset.

Bắt đầu từ file mẫu [`claudekei.jsonc`](claudekei.jsonc): file liệt kê đủ các specialist với
model/effort mặc định, nên copy về mà chưa sửa thì không thay đổi gì. Copy file (bỏ qua nếu
bạn đã có), rồi sửa các giá trị muốn đổi:

```bash
mkdir -p ~/.claude && [ -f ~/.claude/claudekei.jsonc ] || curl -fsSL https://raw.githubusercontent.com/keibn29/claudekei-plugin/main/claudekei.jsonc -o ~/.claude/claudekei.jsonc
```

Từ bản clone ở máy: `cp -n claudekei.jsonc ~/.claude/claudekei.jsonc`. Muốn áp dụng cho riêng
một project thì copy vào `<project>/.claude/claudekei.jsonc`.


- Có hiệu lực từ lần giao việc tiếp theo, kể cả trong session đang mở: không cần cập nhật
  plugin hay mở session mới.
- `model`: `opus`, `sonnet`, `haiku` hoặc `fable`. Các tên này luôn trỏ tới bản mới nhất
  (hiện là Opus 5.5, Sonnet 5.5, Haiku 5.5). Muốn cố định phiên bản, đặt ví dụ
  `"ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5"` trong mục `"env"` của `~/.claude/settings.json`.
- `effort`: `low`, `medium`, `high`, `xhigh`, `max`.
- Mục dành cho 4 agent chính trong `subAgents` bị bỏ qua; dùng `primaryAgents` cho các agent này:
  `{ "orchestrator": { "model": "opus", "effort": "high" }, ... }`, model = alias hoặc model id
  đầy đủ, effort tùy chọn (bỏ qua = mặc định của model). Gộp user/project như `subAgents`;
  chỉ extension ClaudeKei cho VS Code áp dụng.
- `presets` là tên cũ (đã deprecated) của `subAgents`: vẫn được đọc, kèm cảnh báo.

Chi tiết: [docs/configuration.md](docs/configuration.md#config-file-claudekeijsonc).

## Tái sử dụng session

```text
### Resumable Sessions
- explorer: exp-1 Find PHASE_REMINDER_TEXT usage
  Context read by exp-1: src/config/constants.ts (30 lines), src/hooks/phase-reminder/index.ts (95 lines)
- oracle: ora-1 Review auth architecture
```

- Mỗi lần luồng chính gọi `Agent`, subagent đó được gán một alias và model được báo ngay.
- Cùng chủ đề → `SendMessage` với `to: "exp-1"`; hook đổi alias thành agent id thật.
  Chủ đề mới → gọi `Agent` mới.
- Alias không tồn tại hoặc đã bị loại bị chặn trước khi chạy, kèm danh sách alias hợp lệ.

Chi tiết: **[docs/session-management.md](docs/session-management.md)**.

## Tài liệu

| Tài liệu | Nội dung |
|---|---|
| [Session Management](docs/session-management.md) | Alias, cơ chế loại bỏ, read context, giới hạn |
| [Configuration](docs/configuration.md) | Model, biến môi trường, MCP, skill, tùy chỉnh agent |
| [Chuyển từ oh-my-openkei](docs/migration-from-opencode.md) | Phần chuyển 1:1, phần thay đổi, phần bỏ đi |

## Phát triển

```bash
npm test                # test hook (node:test)
npm run sync:modes      # tạo lại skill /claudekei:* từ agents/*.md
npm run check           # kiểm tra sync + test + claude plugin validate
scripts/release.sh      # bump (patch), check, commit, tag, push, update local plugin
```

## License

MIT
