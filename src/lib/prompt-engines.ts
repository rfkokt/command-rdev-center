import { invoke } from "@tauri-apps/api/core";

export type ResearchMode = "auto" | "review";
export type PromptEngine = {
  version: number;
  id: string;
  name: string;
  icon: string;
  description: string;
  system_prompt: string;
  starter_message: string;
  model: string;
  thinking: string;
  research: { enabled: boolean; mode: ResearchMode; instructions: string };
  created_at: number;
  updated_at: number;
};
export type PromptEngineInput = Omit<PromptEngine, "version" | "id" | "created_at" | "updated_at"> & { id?: string };

export const listPromptEngines = () => invoke<PromptEngine[]>("list_prompt_engines");
export const savePromptEngine = (input: PromptEngineInput) => invoke<PromptEngine>("save_prompt_engine", { input });
export const deletePromptEngine = (id: string) => invoke<void>("delete_prompt_engine", { id });

export function runtimePrompt(engine: PromptEngine) {
  if (!engine.research.enabled) return engine.system_prompt;
  const gate = engine.research.mode === "review"
    ? "Before producing the requested output, research the user's topic with web tools, present the sources and key findings, then stop and ask the user to approve or remove sources. Continue only after approval."
    : "Before producing the requested output, research the user's topic with web tools, silently evaluate sources, then continue automatically.";
  return `${engine.system_prompt}\n\nENGINE RESEARCH POLICY:\n${gate}\n${engine.research.instructions}`;
}
