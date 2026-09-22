# Step configuration files

Step creates the global `~/.stepcode/config.toml` when it first runs.
The project file `<cwd>/.stepcode/config.toml` is optional: a missing file
contributes no project settings and does not produce a startup warning.
Reading or reloading settings does not create the project file or directory.

Trusted projects can override global settings through the project file.
Explicitly saving project settings creates a valid TOML file if necessary.
Malformed TOML and filesystem errors other than a missing file are still
reported; malformed files are not overwritten by settings updates.

The retired `step-settings.json` and `settings.json` files are no longer read,
written, or covered by the project trust prompt. A project that still ships one
is ignored; move any settings it holds into the project `config.toml`.

There is no automatic import from the pre-pi `config.json` layout. `models.json`
and `auth.json` keep their own formats — they hold model definitions and
credentials, not settings — and a stale Step endpoint recorded in `models.json`
by an older release is still repaired in place at startup.

## Mandatory command approval

Permission presets and tool overrides cannot automatically approve commands
matched by the built-in command rules. In particular, `rm` with both recursive
and force options requires confirmation for every target, including `./build`
and `/tmp/cache`. Bypass, auto, and autopilot still ask for each call. Read-only
mode blocks it, and runs without an approval channel cannot execute it even
with `nonInteractiveApproval = "allow"`.

See [command permissions](command-permissions.md) for matching behavior and
how to extend the built-in rules.

## Environment and shell commands

`STEP_CODING_AGENT_DIR` selects the agent directory for CLI and SDK callers.
`STEP_CODING_AGENT_SESSION_DIR` selects session storage unless `--session-dir`
is supplied. These names are fixed; the application display name does not select
another environment namespace.

The shared runtime defaults to the `step` display name. `STEPCODE_APP_NAME`
can override the name when launched through the Step entrypoint; it does not
select commands, providers, or storage paths. Step keeps using `.stepcode`,
while shared runtime callers retain their existing storage defaults. Extension
manifest keys and package import aliases remain compatible with existing plugins.

The CLI sets `AI_AGENT=step`. Shell tools inherit the shell environment and any
explicit spawn-hook changes, without injecting session, model, or reasoning
metadata. Extensions can read that metadata from their context instead.

Terminal capabilities use automatic detection and the `terminal` settings;
`showHardwareCursor` and `terminal.clearOnShrink` default to false. There are no
environment overrides for these settings, experimental tool sampling, startup
timing, raw terminal write logs, or redraw logs. Provider cache retention defaults
to `short` and remains configurable per SDK request through `cacheRetention`.

The renderer accepts an explicit crash-log directory from its host. Standalone
Step screens pass the Step agent directory; generic TUI callers default to the
system temporary directory. Rendering equivalence tests select the uncached
renderer through a test-process argument.

## Custom model providers

Beyond the built-in Step provider you can register custom OpenAI-compatible
endpoints (Ollama, vLLM, LM Studio, SGLang, one-api, LiteLLM, and any proxy that
speaks the OpenAI Chat Completions or Responses API) directly in the global
`~/.stepcode/config.toml`. Add one `[providers.<id>]` table per provider. The
`<id>` is the provider name you use with `--provider` and that appears in
`/model`, `/login`, and `step auth`.

```toml
# Optional: make a custom provider the startup default.
# defaultProvider = "ollama"
# defaultModel   = "qwen2.5-coder:7b"

[providers.ollama]
name    = "Ollama (local)"
api     = "openai-completions"        # openai-completions | openai-responses | anthropic-messages
baseUrl = "http://localhost:11434/v1"
apiKey  = "ollama"                    # literal | $ENV | ${ENV} | !command; omit to use /login
# authHeader = true                   # send "Authorization: Bearer <apiKey>" automatically
# headers = { "X-Custom" = "value" }
compat = { supportsDeveloperRole = false, supportsReasoningEffort = false }

[[providers.ollama.models]]
id            = "qwen2.5-coder:7b"    # wire model id sent to the API
name          = "Qwen2.5 Coder 7B"
reasoning     = false
input         = ["text"]              # or ["text", "image"]
contextWindow = 131072
maxTokens     = 8192
# cost = { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }
```

`api` also accepts the aliases `openai-compatible`, `chat`, `completions`,
`responses`, `anthropic`, and `claude-messages`. Set it at the provider level
(default for every model) or per model. `apiKey`, `headers`, and model
`compat` follow the same value-resolution rules as `models.json`: a leading
`$ENV`/`${ENV}` interpolates the environment, a leading `!command` runs a
command and uses its stdout, `$$`/`$!` are literal escapes, and anything else
is a literal. Omit `apiKey` to authenticate through `/login` or `--api-key`
instead of storing a value.

`compat` tunes a partially OpenAI-compatible server. Provider-level `compat`
applies to every model; a model-level `compat` overrides it per key. The most
common flags:

| Field | Description |
|-------|-------------|
| `supportsDeveloperRole` | Send the system prompt as `system` instead of `developer` (many local servers reject `developer`). |
| `supportsReasoningEffort` | Send `reasoning_effort`. Disable on servers that reject it. |
| `supportsUsageInStreaming` | Send `stream_options.include_usage`. Default `true`. |
| `maxTokensField` | `max_completion_tokens` or `max_tokens`. |
| `supportsFinishReason` | Whether streams carry `finish_reason`. Default `true`. |
| `requiresToolResultName` | Include `name` on tool-result messages. |
| `thinkingFormat` | `openai`, `openrouter`, `deepseek`, `together`, `baseten`, `zai`, `qwen`, `chat-template`, `qwen-chat-template`, `string-thinking`, or `ant-ling`. |

These providers load at launch and appear alongside the Step provider. If no
custom provider matches the startup default, the built-in Step provider remains
the default. A malformed `[providers.<id>]` block is reported as a non-fatal
warning instead of blocking startup.

The same providers are available to `step auth` and `/login`, so an API key can
be entered interactively when it is not set inline.

## First-run theme prompt

The first interactive launch asks which theme reads best in the terminal, after
the startup login and the MCP import offer. Like that offer, it runs before the
main UI is built and owns the screen while it does, so the logo and the input
box are not painted and then replaced a frame later. Moving through the list
applies the highlighted theme immediately, and a small sample below the list
shows the syntax and diff colors. The chosen setting is written before the UI is
built, so the session opens in the theme just chosen.

Escape answers too: it takes the product default (`step-blue`, a single bright-blue
palette) and writes that. The picker lists it first as `step-blue (default)`.
The violet palettes remain available as `step-violet` and `step-violet-light`.
So the `theme` key
in the global `config.toml` is the whole record — there is no separate "we asked
you" flag, because every way out of the screen leaves a theme behind. A config
that already has a `theme`, written here or through `/settings` or by hand, skips
the prompt; deleting that line asks again. `/theme` changes the theme later, and
launches that already carry work (an initial prompt, a resumed session) skip the
prompt entirely.

## MCP startup in the terminal

Interactive Step sessions start MCP discovery and connections in the background.
The editor and `/mcp` do not wait for every server to finish initializing.
`/mcp` reports `connecting` until a server's tools are registered, then `connected`
with its tool count, or `failed` when initialization fails. Each server publishes
independently, so a slow server does not delay a ready server's tools.

When startup fails with HTTP 401 or an SDK authentication error, the warning
includes `step mcp login <name>`. Run that command to authenticate, then restart
Step to reconnect the server. The warning preserves the original error details.

Each server publishes its whole catalog in one registry refresh, after yielding to
terminal input, so publication cost does not grow with the number of tools. Tools
becoming available after a model request has started are available to subsequent
requests. Print and RPC sessions still wait for the initial tool catalog before
accepting work.
Closing or replacing a session cancels pending MCP connections and prevents their
late tools or warnings from reaching the new session.
