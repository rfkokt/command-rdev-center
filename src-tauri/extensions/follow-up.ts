/**
 * Short replies to the agent ("lanjut", "iya push aja", "ok commit") continue
 * the current task. Extensions that do per-task work (graph orientation, Jev
 * routing) skip them instead of treating the reply's words as a new task.
 * Shared helper: installed next to the extensions, not loaded as one.
 */
const CONTINUE =
  /^(?:continue|lanjut(?:kan)?|retry|coba lagi|teruskan|go on|oke lanjut)[.!\s]*$/i;
const ACK =
  /^(?:iya|iyaa+|ya|yaa+|yap|yup|yes|yep|ok|oke|okay|okey|sip|siap|gas|boleh|mantap|setuju|sure|thanks|makasih|good|nice|lanjut|continue|go)\b/i;

export function isFollowUp(prompt: string) {
  return (
    CONTINUE.test(prompt) ||
    (ACK.test(prompt) && prompt.split(/\s+/).length <= 6)
  );
}
