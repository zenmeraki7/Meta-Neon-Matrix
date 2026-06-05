import { commitBulkEditSessionUseCase } from "../../useCases/commitBulkEditSessionUseCase.js";
import {
  applyColumnSessionChanges,
  stageSessionChanges as stageSessionChangesUseCase,
} from "../../useCases/sessionChangeUseCases.js";

export async function stageSessionChanges(command) {
  return stageSessionChangesUseCase(command);
}

export async function applyColumnChanges(command) {
  return applyColumnSessionChanges(command);
}

export async function commitBulkEditSession(command) {
  return commitBulkEditSessionUseCase(command);
}
