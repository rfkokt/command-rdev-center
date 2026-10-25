import { useEffect, useRef, useState } from "react";
import {
  prepareComposerImage,
  readStoredAttachment,
  type ComposerImage,
} from "./attachments";

type DraftFile = { name: string; path: string };
type Draft = { text: string; files: DraftFile[]; imagePaths: string[] };
const key = (chatId: string) => `kern:composer-draft:${chatId}`;

export function readDraft(chatId: string): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(key(chatId)) ?? "null");
    if (
      value &&
      typeof value.text === "string" &&
      Array.isArray(value.files) &&
      value.files.every(
        (file: DraftFile) =>
          file &&
          typeof file.name === "string" &&
          typeof file.path === "string",
      ) &&
      Array.isArray(value.imagePaths) &&
      value.imagePaths.every((path: unknown) => typeof path === "string")
    )
      return value;
  } catch {
    /* Unavailable/corrupt storage must not block typing. */
  }
  return { text: "", files: [], imagePaths: [] };
}

export function writeDraft(chatId: string, draft: Draft) {
  try {
    if (!draft.text && !draft.files.length && !draft.imagePaths.length)
      localStorage.removeItem(key(chatId));
    else localStorage.setItem(key(chatId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** ChatView is keyed by chatId; only attachment references are persisted. */
export function useChatDraft(chatId: string, onToast: (text: string) => void) {
  const initial = useRef(readDraft(chatId));
  const [input, setInput] = useState(initial.current.text);
  const [files, setFiles] = useState<DraftFile[]>(initial.current.files);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [restoring, setRestoring] = useState(
    initial.current.imagePaths.length > 0,
  );
  const warned = useRef(false);
  const toast = useRef(onToast);
  toast.current = onToast;
  useEffect(() => {
    let active = true;
    void Promise.all(
      initial.current.imagePaths.map(async (path) => {
        try {
          // The draft points at the store copy already; re-reading it (not
          // re-storing) keeps restarts from piling up duplicate uploads.
          return await prepareComposerImage(await readStoredAttachment(path));
        } catch (error) {
          if (active)
            toast.current(`Draft image unavailable: ${String(error)}`);
          return null;
        }
      }),
    ).then((restored) => {
      if (!active) return;
      setImages((current) => [
        ...restored.filter((image): image is ComposerImage => image !== null),
        ...current,
      ]);
      setRestoring(false);
    });
    return () => {
      active = false;
    };
  }, [chatId]);
  useEffect(() => {
    if (restoring) return;
    const saved = writeDraft(chatId, {
      text: input,
      files,
      imagePaths: images.flatMap((image) => (image.path ? [image.path] : [])),
    });
    if (!saved && !warned.current) {
      warned.current = true;
      toast.current(
        "Draft storage unavailable; keep this chat open to preserve your draft.",
      );
    }
  }, [chatId, input, files, images, restoring]);
  return { input, setInput, files, setFiles, images, setImages, restoring };
}
