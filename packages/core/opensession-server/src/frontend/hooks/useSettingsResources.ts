// Instance-wide reads shared by the project settings page and Defaults:
// one cache entry each, so a write (connecting a sandbox) refreshes every
// surface at once instead of each keeping its own copy.
import useSWR, { mutate as revalidateApiResources, type SWRResponse } from "swr";
import {
  fetchModels,
  fetchSandboxStatus,
  type SandboxStatusInfo,
} from "../lib/api/automations";
import { fetchRepos } from "../lib/api/repos";
import { apiResourceSWRConfig, apiSWRKey } from "../lib/api-swr";

type ModelCatalog = Awaited<ReturnType<typeof fetchModels>>;
type RepoList = Awaited<ReturnType<typeof fetchRepos>>;

export function useSandboxStatus(): SWRResponse<SandboxStatusInfo> {
  return useSWR<SandboxStatusInfo>(
    apiSWRKey.sandboxStatus(),
    () => fetchSandboxStatus(),
    apiResourceSWRConfig<SandboxStatusInfo>(0),
  );
}

export function useModelCatalog(): SWRResponse<ModelCatalog> {
  return useSWR<ModelCatalog>(
    apiSWRKey.modelCatalog(),
    fetchModels,
    apiResourceSWRConfig<ModelCatalog>(0),
  );
}

export function useRepoList(): SWRResponse<RepoList> {
  return useSWR<RepoList>(
    apiSWRKey.repos(),
    fetchRepos,
    apiResourceSWRConfig<RepoList>(0),
  );
}

/** Read the sandbox connections again (after connecting a provider). */
export function revalidateSandboxStatus(): void {
  void revalidateApiResources(apiSWRKey.sandboxStatus());
}
