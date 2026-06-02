import { startProductSync } from "./sync/SyncCommandService.js";

export async function startProductSyncCommand(command) {
  return startProductSync(command);
}
