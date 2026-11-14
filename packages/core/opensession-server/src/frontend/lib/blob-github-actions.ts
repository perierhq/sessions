// What the GitHub account section does when the owner acts: each handler
// sends its request and reports through the section's setters. Kept out of
// the component so the requests and their effects test without a DOM.

import type { ConfirmRequest } from "../ui/confirm";
import {
  blobGithubAs,
  forgetBlobGithubAccount,
  plainError,
  removeBlobGithubToken,
  saveBlobGithub,
  togglePublicRepo,
  toggleRepo,
  type BlobGithub,
  type BlobGithubAs,
  type BlobGithubPatch,
} from "./blob-github";

export interface BlobGithubActionsInput {
  settings: BlobGithub;
  token: string;
  /** Whose account the token is for, as chosen in the section. */
  as?: BlobGithubAs;
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
  const forgetAccount = () => run(forgetBlobGithubAccount, setError);

  return {
    saveToken: async () => {
      const value = input.token.trim();
      if (!value) {
        setTokenError("Paste a token.");
        return;
      }
      // The choice goes up with the token it is for; a token alone keeps
      // the account Blob already posts as.
      const patch: BlobGithubPatch = { token: value };
      if (input.as && input.as !== blobGithubAs(settings)) patch.as = input.as;
      if (await run(() => saveBlobGithub(patch), setTokenError))
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
    forgetAccount: () =>
      input.confirm({
        title: "Forget Blob\u2019s account?",
        description: settings.login
          ? `Earlier posts by @${settings.login} stop counting as Blob\u2019s, so its comments can start replies again. Its repositories and labels are cleared too, and you can choose whose account Blob posts as.`
          : "Its repositories and labels are cleared, and you can choose whose account Blob posts as.",
        confirmLabel: "Forget",
        destructive: true,
        onConfirm: () => void forgetAccount(),
      }),
  };
}
