import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool, ToolExecutorContext } from './shared.js';

// ---------------------------------------------------------------------------
// Kickstand LoRA adapter tools (v0.67.1).
//
// Palette-level LoRA management shipped in v0.67.0 (commit 83b4418 +
// coverage closure 904d2f2): `SideCar: Kickstand: Load LoRA Adapter`,
// `... Unload LoRA Adapter`, `SideCar: Browse & Pull Models`. This
// module layers three agent tools on top so the agent itself can
// role-shape a model mid-task — attach a Python-style adapter before
// touching `src/python/**`, detach when moving to a different
// language, and list what's currently stacked.
//
// All three tools gate on `context.client?.getBackendCapabilities()?
// .loraAdapters` being present. When the active backend is Ollama /
// Anthropic / OpenAI / etc., the call returns a typed "not supported"
// string instead of throwing, so a failed tool call surfaces as a
// regular tool_result the model can reason about.
//
// Approval policy:
//   - list_loras: read-only, no approval required.
//   - attach_lora / detach_lora: mutate runtime model state,
//     require approval. Not `alwaysRequireApproval` (unlike
//     update_setting which mutates persistent config) — users in
//     autonomous mode can opt into auto-approve via toolPermissions
//     since the mutation is ephemeral + undoable via detach.
// ---------------------------------------------------------------------------

const NO_CAPABILITY =
  'kickstand LoRA tools require a Kickstand backend. The active backend does not expose the loraAdapters capability. Use `switch_backend` if the user wants to attach a LoRA adapter to a Kickstand-hosted model.';

function requireLoraCapability(
  context: ToolExecutorContext | undefined,
): NonNullable<
  NonNullable<ReturnType<NonNullable<ToolExecutorContext['client']>['getBackendCapabilities']>>['loraAdapters']
> | null {
  const caps = context?.client?.getBackendCapabilities();
  return caps?.loraAdapters ?? null;
}

// ---------------------------------------------------------------------------
// kickstand_list_loras
// ---------------------------------------------------------------------------

export const kickstandListLorasDef: ToolDefinition = {
  name: 'kickstand_list_loras',
  description:
    'List LoRA adapters currently attached to a Kickstand-hosted model. Returns each adapter with its `id`, `path`, and `scale`. Requires the active backend to be Kickstand with a loaded model — other backends return a clear "not supported" error. ' +
    'Example: `kickstand_list_loras(model_id="qwen2.5-coder:7b")` → `[ { id: "ad-xyz", path: "/Users/me/loras/python-style.gguf", scale: 1.0 } ]`.',
  input_schema: {
    type: 'object',
    properties: {
      model_id: {
        type: 'string',
        description: 'ID of the loaded Kickstand model to query.',
      },
    },
    required: ['model_id'],
  },
};

export async function kickstandListLoras(
  input: Record<string, unknown>,
  context?: ToolExecutorContext,
): Promise<string> {
  const caps = requireLoraCapability(context);
  if (!caps) return NO_CAPABILITY;
  const modelId = (input.model_id as string) || '';
  if (!modelId) return 'Error: model_id is required.';
  try {
    const adapters = await caps.listAdapters(modelId);
    if (adapters.length === 0) {
      return `No LoRA adapters currently attached to ${modelId}.`;
    }
    const rendered = adapters.map((a) => `- ${a.id} (scale ${a.scale}) → ${a.path}`).join('\n');
    return `${adapters.length} adapter(s) on ${modelId}:\n${rendered}`;
  } catch (err) {
    return `Failed to list adapters on ${modelId}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// kickstand_attach_lora
// ---------------------------------------------------------------------------

export const kickstandAttachLoraDef: ToolDefinition = {
  name: 'kickstand_attach_lora',
  description:
    'Attach a LoRA adapter to a loaded Kickstand model without reloading the base. Multiple adapters stack on one base with per-adapter scaling. Returns a human-readable summary including the adapter id Kickstand assigned. Requires user approval per call by default. ' +
    'Use when the user asks to enable a fine-tuned style / domain adapter, or when role-shaping a model for a specific task (e.g. "use my Python LoRA before touching src/python/**"). ' +
    'Scale controls how strongly the adapter blends with the base — `1.0` is the trained default, `0.5` blends half-strength, `2.0` emphasizes the adapter. Keep within 0.0–2.0. ' +
    'Adapters must be GGUF format at an absolute path the Kickstand server can read. Example: `kickstand_attach_lora(model_id="qwen2.5-coder:7b", path="/Users/me/loras/python-style.gguf", scale=1.0)`.',
  input_schema: {
    type: 'object',
    properties: {
      model_id: {
        type: 'string',
        description: 'ID of the loaded Kickstand model to attach the adapter to.',
      },
      path: {
        type: 'string',
        description: 'Absolute path to the GGUF adapter file on the Kickstand server.',
      },
      scale: {
        type: 'number',
        description:
          'Adapter scale (default 1.0). Clamp yourself to 0.0–2.0; Kickstand will reject values outside that range.',
      },
    },
    required: ['model_id', 'path'],
  },
};

export async function kickstandAttachLora(
  input: Record<string, unknown>,
  context?: ToolExecutorContext,
): Promise<string> {
  const caps = requireLoraCapability(context);
  if (!caps) return NO_CAPABILITY;
  const modelId = (input.model_id as string) || '';
  const path = (input.path as string) || '';
  if (!modelId) return 'Error: model_id is required.';
  if (!path) return 'Error: path is required.';
  const rawScale = input.scale;
  const scale = typeof rawScale === 'number' && !isNaN(rawScale) ? rawScale : undefined;
  try {
    return await caps.loadAdapter(modelId, path, scale);
  } catch (err) {
    return `Failed to attach adapter to ${modelId}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// kickstand_detach_lora
// ---------------------------------------------------------------------------

export const kickstandDetachLoraDef: ToolDefinition = {
  name: 'kickstand_detach_lora',
  description:
    'Detach a LoRA adapter from a loaded Kickstand model. The base model stays loaded — only the named adapter is unloaded. Requires user approval per call by default. ' +
    'Use when the user asks to remove a specific adapter, or when role-shaping away from an earlier attachment (e.g. moving from `src/python/**` back to `src/ui/**`). ' +
    'Pair with `kickstand_list_loras` to find the `adapter_id` to detach — adapter IDs are assigned by Kickstand at attach time. Example: `kickstand_detach_lora(model_id="qwen2.5-coder:7b", adapter_id="ad-xyz")`.',
  input_schema: {
    type: 'object',
    properties: {
      model_id: {
        type: 'string',
        description: 'ID of the loaded Kickstand model the adapter is attached to.',
      },
      adapter_id: {
        type: 'string',
        description: 'The adapter id returned by `kickstand_attach_lora` or visible in `kickstand_list_loras` output.',
      },
    },
    required: ['model_id', 'adapter_id'],
  },
};

export async function kickstandDetachLora(
  input: Record<string, unknown>,
  context?: ToolExecutorContext,
): Promise<string> {
  const caps = requireLoraCapability(context);
  if (!caps) return NO_CAPABILITY;
  const modelId = (input.model_id as string) || '';
  const adapterId = (input.adapter_id as string) || '';
  if (!modelId) return 'Error: model_id is required.';
  if (!adapterId) return 'Error: adapter_id is required.';
  try {
    return await caps.unloadAdapter(modelId, adapterId);
  } catch (err) {
    return `Failed to detach adapter ${adapterId} from ${modelId}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const kickstandTools: RegisteredTool[] = [
  { definition: kickstandListLorasDef, executor: kickstandListLoras, requiresApproval: false },
  { definition: kickstandAttachLoraDef, executor: kickstandAttachLora, requiresApproval: true },
  { definition: kickstandDetachLoraDef, executor: kickstandDetachLora, requiresApproval: true },
];
