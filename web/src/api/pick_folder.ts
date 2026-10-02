import { z } from 'zod';
import { PickFolderStrings } from './pick_folder.strings';
import { inMobileApp, shellInvoke } from './transport';

const FolderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsupported') }),
  z.object({ kind: z.literal('dismissed') }),
  z.object({ kind: z.literal('picked'), path: z.string().min(1) }),
]);

export function canPickFolder(): boolean {
  return shellInvoke() != null && !inMobileApp();
}

export async function pickFolder(): Promise<z.infer<typeof FolderSchema>> {
  const invoke = shellInvoke();
  if (invoke == null) return { kind: 'unsupported' };
  const answer = FolderSchema.safeParse(await invoke('pick_export_folder', {}));
  if (!answer.success) throw new Error(PickFolderStrings.couldNotChoose());
  return answer.data;
}
