// The New Session "Machine" choices: this machine, every ready sandbox
// provider, and a selected provider that is no longer ready (a project
// default), so the choice stays visible. `""` is this machine.

export interface MachineChoice {
  id: string;
  /** This machine, or a provider that can run now. */
  available: boolean;
  /** Where a new session in the project starts unless the person picks. */
  isDefault: boolean;
}

export function machineChoices({
  ready,
  selected,
  defaultId,
}: {
  ready: readonly string[];
  selected: string;
  /** `newSessionSandboxDefault`: the project's, else the global default. */
  defaultId: string;
}): MachineChoice[] {
  const ids = [
    "",
    ...ready,
    ...(selected && !ready.includes(selected) ? [selected] : []),
  ];
  return ids.map((id) => ({
    id,
    available: id === "" || ready.includes(id),
    isDefault: id === defaultId,
  }));
}
