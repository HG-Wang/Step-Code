import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI, ProviderModelConfig } from "../src/core/extensions/types.ts";
import { createStepSettingsManager } from "../src/step/settings-manager.ts";
import {
	applyStepCodeConfigDefaults,
	createProviderRegistrationsInlineExtension,
	createStepCodeProviderInlineExtension,
	decorateStepCodeSettingsManager,
	loadStepCodeConfig,
	providerHasInlineCredential,
	readStepConfigProviderRegistrations,
} from "../src/step/stepcode-config.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("StepCode config compatibility", () => {
	test("loads providers, active model, tokens, and injected endpoint values", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepcode-config-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				providers: {
					"stepcode-anthropic": {
						api: "anthropic-messages",
						baseUrl: "https://config.example/v1",
						models: [
							{
								id: "water18",
								model: "water18-wire",
								reasoning: true,
								tokens: { maxContext: 1_000_000, maxOutput: 64_000 },
							},
						],
					},
				},
				activeModel: "water18",
			}),
		);

		const config = await loadStepCodeConfig(
			{
				STEPCODE_CONFIG_PATH: configPath,
				STEP_BASE_URL: "https://env.example/v1",
				STEP_API_KEY: "test-key",
				STEP_MAX_CONTEXT_TOKENS: "900000",
				STEP_MAX_OUTPUT_TOKENS: "32000",
			},
			root,
		);
		const provider = config?.providers[0];
		const model = provider?.config.models?.[0];
		expect(config).toMatchObject({ defaultProvider: "stepcode-anthropic", defaultModel: "water18-wire" });
		expect(provider?.id).toBe("stepcode-anthropic");
		expect(provider?.config.api).toBe("anthropic-messages");
		expect(provider?.config.apiKey).toBe("$STEP_API_KEY");
		expect(provider?.config.baseUrl).toBe("https://env.example");
		expect(model).toMatchObject({
			id: "water18-wire",
			name: "water18",
			reasoning: true,
			contextWindow: 900_000,
			maxTokens: 32_000,
			baseUrl: "https://env.example",
		});
	});

	test("supports the STEPCODE_CONFIG_PATH alias and explicit launch overrides", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepcode-config-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				providers: {
					proxy: {
						api: "responses",
						baseUrl: "https://proxy.example/v1",
						models: [{ id: "fast" }, { id: "disabled", reasoning: false }],
					},
				},
				activeModel: "fast",
			}),
		);
		const config = await loadStepCodeConfig({ STEPCODE_CONFIG_PATH: configPath }, root);
		expect(config).toMatchObject({ defaultProvider: "proxy", defaultModel: "fast" });
		expect(config?.providers[0]?.config.api).toBe("openai-responses");
		expect(config?.providers[0]?.config.models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "fast", reasoning: true }),
				expect.objectContaining({ id: "disabled", reasoning: false }),
			]),
		);
		expect(applyStepCodeConfigDefaults(["--print", "hello"], config, {})).toEqual([
			"--print",
			"hello",
			"--provider",
			"proxy",
			"--model",
			"fast",
		]);
		expect(applyStepCodeConfigDefaults(["--model", "explicit"], config, {})).toEqual(["--model", "explicit"]);
	});

	test("registers normalized providers through a hidden inline extension", async () => {
		const config = {
			path: "/tmp/stepcode-config.json",
			providers: [
				{
					id: "proxy",
					config: {
						api: "openai-responses",
						baseUrl: "https://proxy.example/v1",
						apiKey: "$STEP_API_KEY",
						models: [],
					},
				},
			],
			defaultModel: "fast",
		};
		const registerProvider = vi.fn();
		const extension = createStepCodeProviderInlineExtension(config);
		const factory = typeof extension === "function" ? extension : extension.factory;
		factory({ registerProvider } as unknown as ExtensionAPI);
		expect(typeof extension === "function" ? undefined : extension.hidden).toBe(true);
		expect(registerProvider).toHaveBeenCalledWith("proxy", config.providers[0].config);
	});

	test("supports the legacy agentModels shape", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepcode-config-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				model: "legacy-model",
				modelSupportApis: [{ id: "chat" }],
				agentModels: { stepcode: { model: "stepcode-model", modelSupportApis: [{ id: "claude_native" }] } },
			}),
		);
		const config = await loadStepCodeConfig(
			{ STEPCODE_CONFIG_PATH: configPath, STEP_BASE_URL: "https://proxy.example/v1" },
			root,
		);
		expect(config).toMatchObject({ defaultProvider: "stepcode", defaultModel: "stepcode-model" });
		expect(config?.providers[0]?.config.api).toBe("anthropic-messages");
	});

	test("accepts defaultProvider/defaultModel aliases", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepcode-config-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				providers: {
					proxy: {
						api: "chat",
						baseUrl: "https://proxy.example/v1",
						models: [{ id: "first" }, { id: "selected" }],
					},
				},
				defaultProvider: "proxy",
				defaultModel: "selected",
			}),
		);
		const config = await loadStepCodeConfig({ STEPCODE_CONFIG_PATH: configPath }, root);
		expect(config).toMatchObject({ defaultProvider: "proxy", defaultModel: "selected" });
	});

	test("keeps StepCode model and permission reads and writes in the injected config", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepcode-config-authority-"));
		roots.push(root);
		const configPath = join(root, "stepcode", "config.json");
		const agentDir = join(root, "stepcode", "agent");
		const projectDir = join(root, "project");
		await mkdir(join(root, "stepcode"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "step", defaultModel: "step-3.7-flash" }),
		);
		await writeFile(
			configPath,
			JSON.stringify({
				providers: {
					"stepcode-anthropic": {
						api: "anthropic-messages",
						baseUrl: "https://proxy.example/v1",
						models: [{ id: "water18-new" }],
					},
					"stepcode-responses": {
						api: "openai-responses",
						baseUrl: "https://proxy.example/v1",
						models: [{ id: "step-responses-preview", model: "step-5-preview" }],
					},
				},
				activeModel: "water18-new",
				tools: { approval: { mode: "auto", nonInteractive: "allow", autoResume: false } },
			}),
		);

		const config = await loadStepCodeConfig({ STEPCODE_CONFIG_PATH: configPath }, root);
		const manager = decorateStepCodeSettingsManager(createStepSettingsManager(projectDir, agentDir), config!);
		expect(manager.getDefaultProvider()).toBe("stepcode-anthropic");
		expect(manager.getDefaultModel()).toBe("water18-new");
		expect(manager.getStepSettings()).toEqual({
			approvalMode: "auto",
			nonInteractiveApproval: "allow",
			autoResume: false,
		});

		manager.setDefaultModelAndProvider("stepcode-responses", "step-5-preview");
		manager.setEffectiveStepSettings({
			permissionPreset: "ask",
			approvalMode: "confirm",
			nonInteractiveApproval: "deny",
			autoResume: false,
		});

		const saved = JSON.parse(readFileSync(configPath, "utf8")) as {
			activeModel: string;
			tools: { approval: Record<string, unknown> };
		};
		expect(saved.activeModel).toBe("step-responses-preview");
		expect(saved.tools.approval).toMatchObject({
			preset: "ask",
			mode: "confirm",
			nonInteractive: "deny",
			autoResume: false,
		});
		expect(manager.getDefaultProvider()).toBe("stepcode-responses");
		expect(manager.getDefaultModel()).toBe("step-5-preview");
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({
			defaultProvider: "step",
			defaultModel: "step-3.7-flash",
		});
		expect(existsSync(join(agentDir, "step-settings.json"))).toBe(false);

		const restartedConfig = await loadStepCodeConfig({ STEPCODE_CONFIG_PATH: configPath }, root);
		const restartedManager = decorateStepCodeSettingsManager(
			createStepSettingsManager(projectDir, agentDir),
			restartedConfig!,
		);
		expect(restartedManager.getDefaultProvider()).toBe("stepcode-responses");
		expect(restartedManager.getDefaultModel()).toBe("step-5-preview");
		expect(restartedManager.getStepSettings()).toEqual({
			permissionPreset: "ask",
			approvalMode: "confirm",
			nonInteractiveApproval: "deny",
			autoResume: false,
		});
	});

	test("defaults omitted vision metadata to image input and honors an explicit opt-out", async () => {
		const root = await mkdtemp(join(tmpdir(), "stepcode-config-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				providers: {
					"stepcode-anthropic": {
						api: "anthropic-messages",
						baseUrl: "https://config.example",
						models: [
							{ id: "omitted" },
							{ id: "opted-out", supportsVision: false },
							{ id: "declared", supportsVision: true },
							{ id: "explicit", input: ["text"] },
						],
					},
				},
			}),
		);

		const config = await loadStepCodeConfig({ STEPCODE_CONFIG_PATH: configPath }, root);
		const models = config?.providers[0]?.config.models ?? [];
		const inputOf = (id: string) => models.find((model) => model.id === id)?.input;
		expect(inputOf("omitted")).toEqual(["text", "image"]);
		expect(inputOf("opted-out")).toEqual(["text"]);
		expect(inputOf("declared")).toEqual(["text", "image"]);
		expect(inputOf("explicit")).toEqual(["text"]);
	});
});

describe("StepCode config anthropic-messages thinking contract", () => {
	async function loadAnthropicModels(models: unknown[]): Promise<Record<string, ProviderModelConfig>> {
		const root = await mkdtemp(join(tmpdir(), "stepcode-builtin-"));
		roots.push(root);
		const configPath = join(root, "config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				baseUrl: "https://models-proxy.example/v1",
				providers: { "stepcode-anthropic": { api: "anthropic-messages", models } },
			}),
		);
		const config = await loadStepCodeConfig({ STEPCODE_CONFIG_PATH: configPath }, root);
		const byId = new Map<string, ProviderModelConfig>();
		for (const model of config?.providers[0]?.config.models ?? []) {
			byId.set(model.id, model);
		}
		return Object.fromEntries(byId);
	}

	// The Step-only build has no built-in catalog to inherit from; an
	// anthropic-messages entry that needs adaptive thinking must declare its own
	// `compat.forceAdaptiveThinking` and `thinkingLevelMap`.
	test("an entry without a declared contract inherits nothing", async () => {
		const models = await loadAnthropicModels([{ id: "step-5-preview" }]);
		expect(models["step-5-preview"]).not.toHaveProperty("compat");
		expect(models["step-5-preview"]).not.toHaveProperty("thinkingLevelMap");
	});

	test("preserves a declared forceAdaptiveThinking flag", async () => {
		const models = await loadAnthropicModels([{ id: "step-5-preview", compat: { forceAdaptiveThinking: true } }]);
		expect(models["step-5-preview"]).toMatchObject({ compat: { forceAdaptiveThinking: true } });
	});

	test("preserves a declared thinking level map", async () => {
		const models = await loadAnthropicModels([
			{ id: "step-5-preview", thinkingLevelMap: { off: "none", medium: "medium" } },
		]);
		expect(models["step-5-preview"]).toMatchObject({ thinkingLevelMap: { off: "none", medium: "medium" } });
	});

	test("ignores Anthropic-only compat flags on an OpenAI-completions dialect", async () => {
		const models = await loadAnthropicModels([
			{ id: "step-5-preview", api: "openai-completions", compat: { forceAdaptiveThinking: true } },
		]);
		expect(models["step-5-preview"]).not.toHaveProperty("compat");
	});

	test("keeps sibling compat keys", async () => {
		const models = await loadAnthropicModels([
			{
				id: "step-5-preview",
				compat: { forceAdaptiveThinking: true, allowEmptySignature: true, supportsTemperature: false },
			},
		]);
		expect(models["step-5-preview"]?.compat).toEqual({
			forceAdaptiveThinking: true,
			allowEmptySignature: true,
			supportsTemperature: false,
		});
	});

	test("ignores a non-boolean compat flag", async () => {
		const models = await loadAnthropicModels([{ id: "step-5-preview", compat: { forceAdaptiveThinking: "yes" } }]);
		expect(models["step-5-preview"]).not.toHaveProperty("compat");
	});

	test("drops non-flag compat keys such as `allowedFallbackModels`", async () => {
		const models = await loadAnthropicModels([
			{
				id: "step-5-preview",
				compat: {
					allowedFallbackModels: [{ provider: "step", model: "step-5-preview", cost: { input: 5, output: 25 } }],
				},
			},
		]);
		expect(models["step-5-preview"]).not.toHaveProperty("compat");
	});
});

describe("Step config.toml custom providers", () => {
	// Point the config root at a temp directory: resolveStepConfigRoot derives the
	// config.toml parent from STEP_CODING_AGENT_DIR, so `<temp>/agent` -> `<temp>`.
	function tomlEnv(root: string): Record<string, string | undefined> {
		return { STEP_CODING_AGENT_DIR: join(root, "agent"), HOME: root, USERPROFILE: root };
	}

	async function writeToml(root: string, body: string): Promise<void> {
		await writeFile(join(root, "config.toml"), body, "utf8");
	}

	test("reads an OpenAI-compatible [providers.<id>] block", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-toml-providers-"));
		roots.push(root);
		await writeToml(
			root,
			`[providers.ollama]
name = "Ollama (local)"
api = "openai-completions"
baseUrl = "http://localhost:11434/v1"
apiKey = "ollama"

[[providers.ollama.models]]
id = "qwen2.5-coder:7b"
name = "Qwen2.5 Coder 7B"
reasoning = false
contextWindow = 131072
maxTokens = 8192
`,
		);

		const result = readStepConfigProviderRegistrations(tomlEnv(root));
		expect(result.error).toBeUndefined();
		expect(result.providers).toHaveLength(1);
		const provider = result.providers[0]!;
		expect(provider.id).toBe("ollama");
		expect(provider.config).toMatchObject({
			name: "Ollama (local)",
			api: "openai-completions",
			baseUrl: "http://localhost:11434/v1",
			apiKey: "ollama",
		});
		expect(provider.config.models?.[0]).toMatchObject({
			id: "qwen2.5-coder:7b",
			api: "openai-completions",
			baseUrl: "http://localhost:11434/v1",
			reasoning: false,
			contextWindow: 131072,
			maxTokens: 8192,
		});
	});

	test("accepts the openai-compatible api alias and applies model defaults", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-toml-alias-"));
		roots.push(root);
		await writeToml(
			root,
			`[providers.gateway]
api = "openai-compatible"
baseUrl = "https://gw.example/v1"

[[providers.gateway.models]]
id = "m1"
`,
		);

		const result = readStepConfigProviderRegistrations(tomlEnv(root));
		expect(result.error).toBeUndefined();
		const model = result.providers[0]?.config.models?.[0];
		expect(result.providers[0]?.config.api).toBe("openai-completions");
		expect(model).toMatchObject({
			id: "m1",
			api: "openai-completions",
			baseUrl: "https://gw.example/v1",
			reasoning: true,
			contextWindow: 128000,
			maxTokens: 16384,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("does not fall back to STEP_API_KEY when apiKey is omitted", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-toml-nokey-"));
		roots.push(root);
		await writeToml(
			root,
			`[providers.local]
api = "openai-completions"
baseUrl = "http://localhost:9000/v1"

[[providers.local.models]]
id = "m1"
`,
		);

		const result = readStepConfigProviderRegistrations({ ...tomlEnv(root), STEP_API_KEY: "leaked-step-key" });
		expect(result.error).toBeUndefined();
		expect(result.providers[0]?.config.apiKey).toBeUndefined();
	});

	test("preserves env-interpolation and command apiKey values verbatim", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-toml-keyforms-"));
		roots.push(root);
		await writeToml(
			root,
			`[providers.envkey]
api = "openai-completions"
baseUrl = "http://localhost:9001/v1"
apiKey = "$MY_CUSTOM_KEY"

[[providers.envkey.models]]
id = "m1"

[providers.cmdkey]
api = "openai-completions"
baseUrl = "http://localhost:9002/v1"
apiKey = "!op read op://vault/item/key"

[[providers.cmdkey.models]]
id = "m2"
`,
		);

		const result = readStepConfigProviderRegistrations(tomlEnv(root));
		const byId = new Map(result.providers.map((provider) => [provider.id, provider.config.apiKey]));
		expect(byId.get("envkey")).toBe("$MY_CUSTOM_KEY");
		expect(byId.get("cmdkey")).toBe("!op read op://vault/item/key");
	});

	test("reads provider- and model-level compat with model overriding provider", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-toml-compat-"));
		roots.push(root);
		await writeToml(
			root,
			`[providers.vllm]
api = "openai-completions"
baseUrl = "http://localhost:8000/v1"
compat = { supportsDeveloperRole = false, supportsReasoningEffort = false }

[[providers.vllm.models]]
id = "m1"
compat = { supportsDeveloperRole = true, maxTokensField = "max_tokens" }
`,
		);

		const result = readStepConfigProviderRegistrations(tomlEnv(root));
		expect(result.providers[0]?.config.models?.[0]?.compat).toMatchObject({
			supportsDeveloperRole: true,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		});
	});

	test("skips unusable providers and reports an error", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-toml-skip-"));
		roots.push(root);
		await writeToml(
			root,
			`[providers.good]
api = "openai-completions"
baseUrl = "http://localhost:7000/v1"

[[providers.good.models]]
id = "ok"

[providers.bad]
api = "openai-completions"

[[providers.bad.models]]
id = "x"
`,
		);

		const result = readStepConfigProviderRegistrations(tomlEnv(root));
		expect(result.providers.map((provider) => provider.id)).toEqual(["good"]);
		expect(result.error).toContain("bad");
		expect(result.error).toContain("baseUrl");
	});

	test("returns nothing for a missing or provider-free config", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-toml-missing-"));
		roots.push(root);
		const missing = readStepConfigProviderRegistrations(tomlEnv(root));
		expect(missing).toEqual({ providers: [] });

		await writeToml(root, `# just a comment\ntheme = "step-blue"\n`);
		const noProviders = readStepConfigProviderRegistrations(tomlEnv(root));
		expect(noProviders).toEqual({ providers: [] });
	});

	test("createProviderRegistrationsInlineExtension registers every provider", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-toml-ext-"));
		roots.push(root);
		await writeToml(
			root,
			`[providers.a]
api = "openai-completions"
baseUrl = "http://localhost:7001/v1"

[[providers.a.models]]
id = "m1"

[providers.b]
api = "openai-completions"
baseUrl = "http://localhost:7002/v1"

[[providers.b.models]]
id = "m2"
`,
		);
		const { providers } = readStepConfigProviderRegistrations(tomlEnv(root));
		const registered: Array<{ id: string; api: unknown }> = [];
		const pi = {
			registerProvider: (id: string, config: { api?: unknown }) => registered.push({ id, api: config.api }),
		};
		const extension = createProviderRegistrationsInlineExtension(providers, "test");
		if (typeof extension === "function") throw new Error("expected an object-shaped inline extension");
		extension.factory(pi as unknown as ExtensionAPI);
		expect(registered).toEqual([
			{ id: "a", api: "openai-completions" },
			{ id: "b", api: "openai-completions" },
		]);
	});

	test("providerHasInlineCredential resolves env and command references", () => {
		expect(providerHasInlineCredential({ apiKey: "sk-literal" }, {})).toBe(true);
		expect(providerHasInlineCredential({ apiKey: "$MY_KEY" }, { MY_KEY: "resolved" })).toBe(true);
		expect(providerHasInlineCredential({ apiKey: "$MY_KEY" }, {})).toBe(false);
		expect(providerHasInlineCredential({ apiKey: "!op read x" }, {})).toBe(true);
		expect(providerHasInlineCredential({}, {})).toBe(false);
	});
});
