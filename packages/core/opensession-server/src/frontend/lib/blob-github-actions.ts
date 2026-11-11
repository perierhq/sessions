// What the GitHub account section does when the owner acts: each handler
// sends its request and reports through the section's setters. Kept out of
// the component so the requests and their effects test without a DOM.

import type { ConfirmRequest } from "../ui/confirm";
import {
  plainError,
  removeBlobGithubToken,
  saveBlobGithub,
  togglePublicRepo,
  toggleRepo,
  type BlobGithub,
  type BlobGithubPatch,
} from "./blob-github";

export interface BlobGithubActionsInput {
  settings: BlobGithub;
  token: string;
  setSaved: (next: BlobGithub) => void;
  setToken: (value: string) => void;
  setTokenError: (message: string | null) => void;
  setError: (message: string | null) => void;
  setBusy: (busy: boolean) => void;
  confirm: (request: ConfirmRequest) => void;
}

export function blobGithubActions(input: BlobGithubActionsInput) {
  const { settings, setSaved, setTokenError, setError, setBusy } = input;

  const run = async (
    action: () => Promise<BlobGithub>,
    onError: (message: string) => void,
  ) => {
    setBusy(true);
    setError(null);
    setTokenError(null);
    const ok = await action().then(
      (next) => {
        setSaved(next);
        return true;
      },
      (caught: Error) => {
        onError(plainError(caught));
        return false;
      },
    );
    setBusy(false);
    return ok;
  };

  const save = (patch: BlobGithubPatch) =>
    run(() => saveBlobGithub(patch), setError);

  const removeToken = () => run(removeBlobGithubToken, setError);

  return {
    saveToken: async () => {
      const value = input.token.trim();
      if (!value) {
        setTokenError("Paste a token.");
        return;
      }
      if (await run(() => saveBlobGithub({ token: value }), setTokenError))
        input.setToken("");
    },
    setEnabled: (enabled: boolean) => save({ enabled }),
    setRepo: (name: string, on: boolean) =>
      save(toggleRepo(settings, name, on)),
    setPublicRepo: (name: string, on: boolean) =>
      save({ publicRepos: togglePublicRepo(settings, name, on) }),
    setLabels: (labels: string[]) => save({ labels }),
    removeToken: () =>
      input.confirm({
        title: "Remove Blob\u2019s token?",
        description:
          "Blob stops posting on GitHub until you paste a new token.",
        confirmLabel: "Remove",
        destructive: true,
        onConfirm: () => void removeToken(),
      }),
  };
}
