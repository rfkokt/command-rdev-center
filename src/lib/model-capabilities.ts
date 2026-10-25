/**
 * Whether the model behind a chat can read images, so attachments are sent
 * inline only where they will be seen (docs/tasks/orca-essentials O0-02).
 *
 * `true` reads images, `false` is text-only, `null` means nobody declared it.
 */
export type ImageSupport = boolean | null;

type RuntimeModel = { id: string; provider?: string; input?: unknown };

export function modelKey(model: { id: string; provider?: string }) {
  return `${model.provider ?? ""}/${model.id}`.replace(/^\//, "");
}

/** `provider/id` → input kinds, from pi's get_available_models/get_state. */
export function modelInputs(
  models: readonly RuntimeModel[],
): Record<string, string[]> {
  const inputs: Record<string, string[]> = {};
  for (const model of models) {
    if (!Array.isArray(model.input)) continue;
    inputs[modelKey(model)] = model.input.filter(
      (kind): kind is string => typeof kind === "string",
    );
  }
  return inputs;
}

export function imageSupport(options: {
  harness: string;
  model: string;
  /** pi's input kinds per model (pi fills undeclared ones in as text-only). */
  inputs: Readonly<Record<string, readonly string[]>>;
  /** Custom models whose models.json entry declares no input. */
  undeclared: ReadonlySet<string>;
  /** ACP agents answer for themselves (get_state `imageInput`). */
  harnessImage: boolean | null;
}): ImageSupport {
  if (options.harness !== "pi") return options.harnessImage;
  if (!options.model || options.undeclared.has(options.model)) return null;
  const input = options.inputs[options.model];
  return input ? input.includes("image") : null;
}
